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
import {
  AUTOPILOT_ARRIVAL_LY,
  ORBITAL_DOCK_RANGE_LY,
  speedFromThrottle,
  stepWarpAlignment,
} from "../../../../packages/star-sim/src/index.js";
import { Player, World } from "../../../../packages/shared-state/src/index.js";
import { clearRoomAssignment, recordRoomAssignment } from "../persistence.js";

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

/** Used by autobrake skip-check; mirrors AUTOPILOT_ARRIVAL_LY/ORBITAL_DOCK_RANGE_LY. */
void AUTOPILOT_ARRIVAL_LY;
void ORBITAL_DOCK_RANGE_LY;

export class StarRoom extends Room<{ state: World }> {
  /** Per-session latest-input buffer. Replaced on each `input` message
   *  so the tick samples only the most recent intent. */
  private inputs = new Map<string, InputMsg>();

  /** Per-session warp target — populated by `warp_engage` messages.
   *  Pass 3 will move this onto the Player schema or out into a side
   *  table once MCP tool handlers route through us. */
  private warpTargets = new Map<
    string,
    { targetId: string; targetPos: [number, number, number]; isOrbital: boolean }
  >();

  override onCreate(options: { gameId?: string }) {
    const gameId = options.gameId ?? "demo";
    this.state = new World();
    this.state.gameId = gameId;
    this.setPatchRate(TICK_MS);
    this.setSimulationInterval((dtMs) => this.tick(dtMs / 1000), TICK_MS);

    // Latest-wins input intent stream. 60 Hz from the client is fine —
    // we only sample the latest before each 20 Hz tick.
    this.onMessage("input", (client, msg: InputMsg) => {
      this.inputs.set(client.sessionId, msg);
    });

    // Discrete one-shot: engage warp toward a target. Pass 2 takes the
    // target position from the client; Pass 3 will resolve it server-
    // side from the star/orbital catalog so the client can't lie.
    this.onMessage("warp_engage", (client, msg: WarpEngageMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.warpEngaged = true;
      this.warpTargets.set(client.sessionId, {
        targetId: msg.targetId,
        targetPos: msg.targetPos,
        isOrbital: !!msg.isOrbital,
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
    this.state.players.set(client.sessionId, p);
    console.log(`[StarRoom ${this.roomId}] join ${client.sessionId} (playerId=${p.playerId})`);
  }

  override onLeave(client: Client, _code?: number) {
    this.state.players.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    this.warpTargets.delete(client.sessionId);
    console.log(`[StarRoom ${this.roomId}] leave ${client.sessionId}`);
  }

  override onDispose() {
    clearRoomAssignment(this.state.gameId);
    console.log(`[StarRoom ${this.roomId}] dispose`);
  }

  /** One simulation tick. dt is in seconds. Pure-math via
   *  @genui/star-sim's stepWarpAlignment + a tiny position integrator. */
  private tick(dt: number) {
    this.state.tick += 1;

    this.state.players.forEach((p: Player, sessionId: string) => {
      // Apply latest input.
      const intent = this.inputs.get(sessionId);
      if (intent) {
        if (intent.throttle != null) p.throttle = clamp01(intent.throttle);
        if (intent.yawDelta) p.yaw = normalizeAngle(p.yaw + intent.yawDelta);
        if (intent.pitchDelta) {
          p.pitch = clamp(p.pitch + intent.pitchDelta, -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05);
        }
      }

      // Warp autopilot — Phase 1/2 alignment via the shared physics module.
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
            dt,
          });
          p.yaw = result.yaw;
          p.pitch = result.pitch;
          p.throttle = result.throttle;
          if (result.arrived) {
            p.warpEngaged = false;
            this.warpTargets.delete(sessionId);
          }
        }
      }

      // Integrate position from throttle + current heading.
      const speed = speedFromThrottle(p.throttle);
      if (speed > 0) {
        const fwd = forwardFromYawPitch(p.yaw, p.pitch);
        p.posX += fwd.x * speed * dt;
        p.posY += fwd.y * speed * dt;
        p.posZ += fwd.z * speed * dt;
      }
    });
  }
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
