/**
 * StarRoom — Colyseus room running the authoritative 20 Hz simulation
 * tick for one galaxy. Pass 2 lifts the simulation off the iframe and
 * onto the server; the iframe still runs its own legacy tick in
 * parallel during this pass so we can measure position drift and
 * verify the math is identical before Pass 3 flips the switch.
 *
 * Scope (Pass 2 MV):
 *  - 20 Hz tick that runs stepWarpAlignment + position integration from
 *    @genui/star-sim. No autobrake yet (Pass 3, once we have a
 *    server-side WorldQuery for nearby stars).
 *  - Input intents over `room.send("input", {...})` — sampled latest
 *    before each tick.
 *  - Discrete actions (warp_to, set_target, ...) NOT yet routed here.
 *    MCP tool handlers still mutate the legacy galaxy/Player records
 *    directly. Pass 3 introduces matchMaker.getLocalRoomById() routing.
 *  - No reconnection token plumbing yet (Pass 3).
 */
import { Client, Room } from "colyseus";
import RAPIER from "@dimforge/rapier3d-deterministic-compat";
import {
  SOL_RADIUS_LY,
  speedFromThrottle,
  stepWarpAlignment,
} from "../../../../packages/star-sim/src/index.js";
import { Player } from "./state-player.js";
import { World } from "./state-world.js";
import { clearRoomAssignment, recordRoomAssignment } from "../persistence.js";
import { getGalaxies, resolveStar, STAR_INDEX } from "../server.js";

/** Capsule radius approximating a Culture vessel hull for the Rapier
 *  body. Tiny in ly so it doesn't interact with the existing arrival
 *  ranges. Pass 5 will dial these in once we add real collidables
 *  (asteroids, projectiles). */
const SHIP_BODY_RADIUS_LY = 1e-7;

// Pass 2 doesn't read the legacy galaxy record yet; it just holds its
// own state. Pass 3 will hydrate from getGalaxy(gameId) on onCreate.
type InputMsg = {
  /** Throttle slider absolute value in [0..1]. Latest wins. */
  throttle?: number;
  /** Yaw delta in radians applied during this tick. */
  yawDelta?: number;
  /** Pitch delta in radians applied during this tick. */
  pitchDelta?: number;
};

type WarpEngageMsg = {
  targetId: string;
  /** Target position in light-years — for Pass 2 the client supplies
   *  it (since the server doesn't yet own the star catalog index).
   *  Pass 3 looks it up server-side. */
  targetPos: [number, number, number];
  isOrbital?: boolean;
};

const TICK_HZ = 20;
const TICK_MS = 1000 / TICK_HZ;

/** Sync a stable subset of legacy Player fields into the Colyseus
 *  Player so the iframe can read them via the schema stream. Pass 3
 *  keeps the legacy MCP tool handlers (warp_to / set_target / etc.)
 *  mutating the in-memory galaxy record; this function bridges those
 *  mutations into Colyseus state. Conversely, motion fields computed
 *  in the tick get written back to legacy so get_state and the Mind
 *  agent see the authoritative ship position. */
type LegacyPlayer = {
  position: [number, number, number];
  heading: [number, number, number];
  throttle: number;
  targetId: string | null;
  warpEngaged: boolean;
  dockedOrbitalId: string | null;
  faceRequestTs?: number;
  stopRequestTs?: number;
};

function findLegacyPlayer(gameId: string, playerId: string): LegacyPlayer | undefined {
  const galaxy = getGalaxies().get(gameId);
  if (!galaxy) return undefined;
  return galaxy.players.get(playerId) as LegacyPlayer | undefined;
}

export class StarRoom extends Room<World> {
  /** Per-session latest-input buffer. Replaced on each `input` message
   *  so the tick samples only the most recent intent. */
  private inputs = new Map<string, InputMsg>();

  /** Per-session warp target — populated by `warp_engage` messages.
   *  Pass 3 will move this onto the Player schema or out into a side
   *  table once MCP tool handlers route through us. */
  private warpTargets = new Map<
    string,
    {
      targetId: string;
      targetPos: [number, number, number];
      isOrbital: boolean;
      /** Physical radius in light-years; added to the autopilot's
       *  arrival range so big stars are stopped 1 AU from the
       *  SURFACE rather than 1 AU from the center. */
      targetRadiusLy: number;
    }
  >();

  /** Pass 4: Rapier physics world. Zero-gravity (we're in space). Holds
   *  kinematic bodies for each ship — their positions are SET each
   *  tick from our integrated state so Rapier knows where every ship
   *  is. Pass 5 will add real collidables (asteroids, projectiles)
   *  and start using the world's collision events / shape queries. */
  private rapier!: RAPIER.World;

  /** Per-session ship body in the Rapier world. Created in onJoin,
   *  removed in onLeave. Position is kept in sync with the Schema's
   *  posX/Y/Z each tick. */
  private rapierBodies = new Map<string, RAPIER.RigidBody>();

  override onCreate(options: { gameId?: string }) {
    const gameId = options.gameId ?? "demo";
    this.state = new World();
    this.state.gameId = gameId;
    this.setPatchRate(TICK_MS);
    this.setSimulationInterval((dtMs) => this.tick(dtMs / 1000), TICK_MS);

    // Zero-gravity world. RAPIER.init() must have completed by now
    // (main.ts awaits it before defining/listening). Timestep is set
    // to match our tick so Rapier's substep budget aligns with the
    // game tick.
    this.rapier = new RAPIER.World({ x: 0, y: 0, z: 0 });
    this.rapier.timestep = TICK_MS / 1000;

    // Input intent stream. Absolute fields (throttle) are latest-wins;
    // delta fields (yawDelta / pitchDelta) accumulate between ticks so
    // a rapid drag at >20 Hz doesn't lose any frames worth of motion.
    this.onMessage("input", (client, msg: InputMsg) => {
      const cur = this.inputs.get(client.sessionId);
      if (!cur) {
        this.inputs.set(client.sessionId, { ...msg });
        return;
      }
      if (msg.throttle != null) cur.throttle = msg.throttle;
      if (msg.yawDelta != null) cur.yawDelta = (cur.yawDelta ?? 0) + msg.yawDelta;
      if (msg.pitchDelta != null) cur.pitchDelta = (cur.pitchDelta ?? 0) + msg.pitchDelta;
    });

    // Discrete one-shot: engage warp toward a target. Pass 2 takes the
    // target position from the client; Pass 3 will resolve it server-
    // side from the star/orbital catalog so the client can't lie.
    this.onMessage("warp_engage", (client, msg: WarpEngageMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.warpEngaged = true;
      // Look up the radius server-side from the catalog so a
      // client-supplied targetId still gets surface-aware arrival.
      // Client-supplied targetPos is preserved (Pass 2 trust model).
      const resolved = resolveTargetPosition(msg.targetId, getGalaxies().get(this.state.gameId));
      this.warpTargets.set(client.sessionId, {
        targetId: msg.targetId,
        targetPos: msg.targetPos,
        isOrbital: !!msg.isOrbital,
        targetRadiusLy: resolved?.radiusLy ?? 0,
      });
    });

    this.onMessage("warp_stop", (client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.warpEngaged = false;
      p.throttle = 0;
      this.warpTargets.delete(client.sessionId);
    });

    // Record the gameId → roomId mapping so Pass 3's MCP tool handlers
    // can locate the live Room via matchMaker.getLocalRoomById.
    recordRoomAssignment(gameId, this.roomId);
    console.log(`[StarRoom ${this.roomId}] created for gameId=${gameId}`);
  }

  /** Trust the client-supplied playerId (Pass 2 anon-trust per the ADR). */
  static override async onAuth(_token: string, _req: unknown) {
    return true;
  }

  override onJoin(client: Client, options: { playerId?: string; shipName?: string; shipClass?: string }) {
    const p = new Player();
    p.playerId = options.playerId ?? client.sessionId;
    p.shipName = options.shipName ?? "(unnamed)";
    p.shipClass = options.shipClass ?? "GCU";
    p.systemId = this.state.gameId; // Placeholder until per-system sharding lands.

    // Hydrate motion + intent from the legacy galaxy record so the iframe
    // resumes from the same spot it left off (e.g. across a reload that
    // happened mid-warp). If no legacy player exists yet (fresh spawn),
    // server.ts's start_starship will populate it; we'll sync on the
    // next tick.
    const legacy = findLegacyPlayer(this.state.gameId, p.playerId);
    if (legacy) {
      // Some old persisted player records have position == [0,0,0]
      // because older builds pushed the iframe's default ship position
      // via sync_state and clobbered the spawn. (0,0,0) is Sol —
      // camera would be inside the star. If we detect that, fall back
      // to the standard spawn offset 10 AU above Sol.
      const SPAWN_DEFAULT: [number, number, number] = [0, 1.58e-4, 0];
      const atOrigin =
        legacy.position[0] === 0 && legacy.position[1] === 0 && legacy.position[2] === 0;
      const pos = atOrigin ? SPAWN_DEFAULT : legacy.position;
      p.posX = pos[0];
      p.posY = pos[1];
      p.posZ = pos[2];
      if (atOrigin) {
        // Heal the legacy record so subsequent reads see the right spawn.
        legacy.position = [...SPAWN_DEFAULT];
      }
      // Legacy stores heading as a forward unit vector — convert back to
      // yaw/pitch (inverse of forwardFromYawPitch).
      const [hx, hy, hz] = legacy.heading;
      p.yaw = Math.atan2(hx, -hz);
      p.pitch = Math.asin(Math.max(-1, Math.min(1, hy)));
      p.throttle = legacy.throttle ?? 0;
      p.targetId = legacy.targetId ?? "";
      p.warpEngaged = !!legacy.warpEngaged;
      p.dockedOrbitalId = legacy.dockedOrbitalId ?? "";
    }
    this.state.players.set(client.sessionId, p);

    // Pass 4: create the Rapier body for this ship. Kinematic
    // position-based body — we set its translation each tick from our
    // integrated position rather than letting Rapier sim it. This
    // makes Rapier a passive observer for now; Pass 5 will add real
    // collidables it can interact with.
    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(p.posX, p.posY, p.posZ);
    const body = this.rapier.createRigidBody(bodyDesc);
    const colliderDesc = RAPIER.ColliderDesc.ball(SHIP_BODY_RADIUS_LY)
      .setSensor(true); // no contact response yet — just presence
    this.rapier.createCollider(colliderDesc, body);
    this.rapierBodies.set(client.sessionId, body);

    console.log(`[StarRoom ${this.roomId}] join ${client.sessionId} (playerId=${p.playerId})`);
  }

  override onLeave(client: Client, _consented?: boolean) {
    this.state.players.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    this.warpTargets.delete(client.sessionId);
    const body = this.rapierBodies.get(client.sessionId);
    if (body) {
      this.rapier.removeRigidBody(body);
      this.rapierBodies.delete(client.sessionId);
    }
    console.log(`[StarRoom ${this.roomId}] leave ${client.sessionId}`);
  }

  override onDispose() {
    clearRoomAssignment(this.state.gameId);
    // Free the Rapier world's WASM-backed storage. Without this, every
    // disposed room leaks the WASM-side state.
    this.rapier.free();
    console.log(`[StarRoom ${this.roomId}] dispose`);
  }

  /** One simulation tick. dt is in seconds. Pure-math via
   *  @genui/star-sim's stepWarpAlignment + a tiny position integrator.
   *
   *  Pass 3b bridge: at the START of each tick, sync READ-side fields
   *  from the legacy galaxy record (targetId / warpEngaged /
   *  dockedOrbitalId — these are mutated by MCP tools like warp_to and
   *  set_target). At the END, write the computed motion fields back so
   *  legacy readers (get_state, ask_mind, persistence) see authoritative
   *  positions. */
  private tick(dt: number) {
    this.state.tick += 1;
    const galaxy = getGalaxies().get(this.state.gameId);

    this.state.players.forEach((p: Player, sessionId: string) => {
      const legacy = galaxy?.players.get(p.playerId) as LegacyPlayer | undefined;

      // --- READ from legacy (intent fields mutated by MCP tools) ---
      if (legacy) {
        const lt = legacy.targetId ?? "";
        if (lt !== p.targetId) {
          p.targetId = lt;
          // New target → clear any stale warp target cache so the next
          // warp_engage resolves fresh.
          this.warpTargets.delete(sessionId);
        }
        if (legacy.warpEngaged !== p.warpEngaged) {
          p.warpEngaged = legacy.warpEngaged;
          if (legacy.warpEngaged && p.targetId && !this.warpTargets.has(sessionId)) {
            // Server-side warp engage — resolve the target position now.
            const pos = resolveTargetPosition(p.targetId, galaxy);
            if (pos) {
              this.warpTargets.set(sessionId, {
                targetId: p.targetId,
                targetPos: pos.pos,
                isOrbital: pos.isOrbital,
                targetRadiusLy: pos.radiusLy,
              });
            }
          }
        }
        p.dockedOrbitalId = legacy.dockedOrbitalId ?? "";
      }

      // --- Apply input intent ---
      // Throttle is absolute (slider position); yawDelta / pitchDelta
      // are accumulated rotation amounts since the previous tick. After
      // applying deltas we zero them so they don't keep firing each
      // tick. Throttle was previously sticky-between-ticks, but that
      // let a stale {throttle:0} from before warp engaged clobber the
      // autopilot's ramp every tick — pinning warp at exactly 0.1425
      // (= 0 × 0.85 + 0.95 × 0.15, the lerp's first step). Now we
      // consume throttle one-shot just like the deltas: a slider
      // motion sets it once, and the autopilot owns the field on every
      // tick where the user didn't actively move the slider.
      const intent = this.inputs.get(sessionId);
      if (intent) {
        if (intent.throttle != null) {
          // Manual throttle input cancels the autopilot — the user is
          // taking the wheel. (The cockpit's slider handler also
          // disengages warp locally; mirror that authoritatively.)
          if (p.warpEngaged) {
            p.warpEngaged = false;
            this.warpTargets.delete(sessionId);
            if (legacy) legacy.warpEngaged = false;
          }
          p.throttle = clamp01(intent.throttle);
          intent.throttle = undefined;
        }
        if (intent.yawDelta) {
          p.yaw = normalizeAngle(p.yaw + intent.yawDelta);
          intent.yawDelta = 0;
        }
        if (intent.pitchDelta) {
          // Authoritative pitch clamp must match the cockpit's
          // MAX_PITCH (π/2 − 0.001 ≈ 89.94°); a tighter server clamp
          // would snap the camera back to the smaller range on the
          // next state sync, which the user sees as "looks 90° while
          // dragging, jumps to 87° on release."
          p.pitch = clamp(p.pitch + intent.pitchDelta, -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001);
          intent.pitchDelta = 0;
        }
      }

// --- Warp autopilot — Phase 1/2 from @genui/star-sim ---
      if (p.warpEngaged) {
        const wt = this.warpTargets.get(sessionId);
        if (wt) {
          const fwd = forwardFromYawPitch(p.yaw, p.pitch);
          const result = stepWarpAlignment({
            shipPos: { x: p.posX, y: p.posY, z: p.posZ },
            shipFwd: fwd,
            shipThrottle: p.throttle,
            targetPos: { x: wt.targetPos[0], y: wt.targetPos[1], z: wt.targetPos[2] },
            isOrbital: wt.isOrbital,
            targetRadiusLy: wt.targetRadiusLy,
            dt,
          });
          p.yaw = result.yaw;
          p.pitch = result.pitch;
          p.throttle = result.throttle;
          if (result.arrived) {
            p.warpEngaged = false;
            this.warpTargets.delete(sessionId);
            // Reflect arrival into legacy so the iframe's poll observes
            // warpEngaged=false too (target-info pane clears WARPING).
            if (legacy) {
              legacy.warpEngaged = false;
              legacy.throttle = 0;
            }
          }
        }
      }

      // --- Integrate position from throttle + heading ---
      const speed = speedFromThrottle(p.throttle);
      if (speed > 0) {
        const fwd = forwardFromYawPitch(p.yaw, p.pitch);
        p.posX += fwd.x * speed * dt;
        p.posY += fwd.y * speed * dt;
        p.posZ += fwd.z * speed * dt;
      }

      // --- WRITE motion back to legacy so get_state / ask_mind / etc.
      //     see authoritative state without rewriting every reader. ---
      if (legacy) {
        legacy.position = [p.posX, p.posY, p.posZ];
        const fwd = forwardFromYawPitch(p.yaw, p.pitch);
        legacy.heading = [fwd.x, fwd.y, fwd.z];
        legacy.throttle = p.throttle;
        // Don't overwrite legacy.targetId / .warpEngaged here — they're
        // the READ-side. Their write-path is the MCP tools themselves.
        // (Exception: arrival above clears legacy.warpEngaged so the
        // iframe's poll sees the new state on its next 200 ms cycle.)
      }

      // --- Pass 4: sync the Rapier body to the schema's position. ---
      const body = this.rapierBodies.get(sessionId);
      if (body) body.setNextKinematicTranslation({ x: p.posX, y: p.posY, z: p.posZ });
    });

    // --- Pass 4: advance Rapier. Cheap with only kinematic bodies and
    //     no collidable interactions yet; the cost grows with Pass 5's
    //     asteroid/projectile additions. Run AFTER the per-player loop
    //     so all kinematic targets are set for this tick. ---
    this.rapier.step();
  }
}

/** Resolve a target id to a 3D position (light-years) + physical
 *  radius (light-years). Returns null if unknown. For Pass 3b: stars
 *  resolve via STAR_INDEX; orbitals via the galaxy's orbitals list;
 *  planets fall back to their PARENT star's position (close enough —
 *  planets are sub-AU from their star and the autopilot arrival
 *  range is 1 AU). Pass 4 will compute live orbital phase server-side
 *  via @genui/star-sim.
 *
 *  radiusLy: physical radius of the target body, used by the warp
 *  autopilot's arrival check so the ship stops 1 AU from the SURFACE
 *  rather than 1 AU from the center. Ships and orbitals report 0
 *  (they're points at this scale). */
function resolveTargetPosition(
  targetId: string,
  galaxy:
    | {
        orbitals: Array<{ id: string; position: [number, number, number] }>;
        players: Map<string, { playerId: string; position: [number, number, number] }>;
      }
    | undefined,
): { pos: [number, number, number]; isOrbital: boolean; radiusLy: number } | null {
  if (!targetId) return null;
  if (targetId.startsWith("orbital:") && galaxy) {
    const oid = targetId.slice("orbital:".length);
    const o = galaxy.orbitals.find((x) => x.id === oid);
    return o ? { pos: o.position, isOrbital: true, radiusLy: 0 } : null;
  }
  if (targetId.startsWith("ship:") && galaxy) {
    // ship:<playerId> — find the target player in this galaxy and use
    // their live position. The autopilot arrival range is 1 AU which
    // is plenty for "rendezvous near them" semantics.
    const pid = targetId.slice("ship:".length);
    for (const p of galaxy.players.values()) {
      if (p.playerId === pid) return { pos: p.position, isOrbital: false, radiusLy: 0 };
    }
    return null;
  }
  if (targetId.startsWith("planet:")) {
    const rest = targetId.slice("planet:".length);
    const sep = rest.indexOf("::");
    const starId = sep >= 0 ? rest.slice(0, sep) : rest;
    const s = resolveStar(starId);
    // Planet positions still fall back to the parent star — orbital
    // resolution comes in Pass 4. Use the star's radius for now so the
    // ship doesn't park inside a supergiant.
    if (s) return { pos: s.position, isOrbital: false, radiusLy: (s.radiusSolar ?? 1) * SOL_RADIUS_LY };
    return null;
  }
  // Bare star id: curated first, HYG catalog fallback via resolveStar.
  // Previously this was STAR_INDEX-only, so warps to any of the 109k
  // HYG ids would phase-1 align but never enter phase 2 — the autopilot
  // couldn't find a target position to compute throttle against.
  const s = resolveStar(targetId);
  return s ? { pos: s.position, isOrbital: false, radiusLy: (s.radiusSolar ?? 1) * SOL_RADIUS_LY } : null;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function normalizeAngle(a: number): number {
  // [-π, π]
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Three's camera convention: yaw=0 looks down -Z; positive yaw rotates
 *  view toward +X; positive pitch looks up. Pure numerical fn. */
function forwardFromYawPitch(yaw: number, pitch: number): { x: number; y: number; z: number } {
  const cp = Math.cos(pitch);
  return {
    x: Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cp,
  };
}
