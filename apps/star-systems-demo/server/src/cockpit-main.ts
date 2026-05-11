/**
 * Cockpit pane — Babylon.js renderer + Colyseus state sync.
 *
 * Migrated from Three.js as part of feat/babylon-migration. This is the
 * **minimum-viable** Babylon port: scene boots, ship navigates, mouse
 * picking works, multiplayer state syncs. Visual fidelity is intentionally
 * lower than the Three version while we lay foundations; the following
 * features are deferred to subsequent migration sessions and the FILE
 * COMMENTS in this code call out each one with TODO(babylon):
 *
 *   - 3-layer sprite stack for stars (core / halo / spike)
 *   - 109k bright-catalog HYG point cloud backdrop
 *   - Logarithmic depth buffer + the 200× planet/star scale-cheat
 *     system with screen-fraction cap (porting from THREE.logarithmicDepthBuffer)
 *   - Close-mesh sphere handoff at CLOSE_MESH_RANGE_LY
 *   - Magnitude-based star sizing
 *   - Orbital ring geometry (icons only for now)
 *   - Procedural CanvasTexture star glow
 *   - Debug log overlay + debug fill light
 *
 * Server-side physics stays Rapier in StarRoom; Havok via Babylon's
 * plugin is client-only and we don't run client physics (per the
 * smoothing/determinism discussion in ENGINE_ARCHITECTURE.md).
 */
import {
  Color3,
  Color4,
  DefaultRenderingPipeline,
  Engine,
  HemisphericLight,
  Matrix,
  Mesh,
  MeshBuilder,
  PointLight,
  Scalar,
  Scene,
  StandardMaterial,
  TransformNode,
  UniversalCamera,
  Vector3,
  Viewport,
} from "@babylonjs/core";

import { Client as ColyseusClient, getStateCallbacks, type Room as ColyseusRoom } from "colyseus.js";
import { callTool, poll, setupPaneApp } from "./shared.js";
import type { Player as ServerPlayer } from "./state-player.js";
import type { World as ServerWorld } from "./state-world.js";
import {
  BRAKE_RANGE_LY,
  EARTH_RADIUS_LY,
  formatDistanceShort,
  formatSpeedShort,
  LY_PER_AU,
  SOL_RADIUS_LY,
  speedFromThrottle,
} from "../../../../packages/star-sim/src/index.js";

// --- types (unchanged from Three version) ---
type PlanetLite = {
  name: string;
  kind: string;
  orbitAU?: number;
  massEarths?: number;
  radiusEarths?: number;
};
type StarLite = {
  id: string;
  name: string;
  position: [number, number, number];
  spectralClass: string;
  spectralType: string;
  lumClass: string;
  distanceLy: number;
  hasPlanets: boolean;
  radiusSolar?: number;
  absMag?: number;
  planetCount?: number;
  planets?: PlanetLite[];
};

// --- visual constants (subset of Three version) ---
// TODO(babylon): port the full magnitude-based + log-depth scaling
// system. These constants approximate the Three behavior at typical
// viewing distances.
const PLANET_VISUAL_SCALE = 200;
const STAR_VISUAL_SCALE = 200;
const PLANET_RADIUS_R_EARTH: Record<string, number> = {
  terrestrial: 0.9, super_earth: 1.5, neptune_like: 3.5, ice_giant: 4.0,
  gas_giant: 11.0, hot_jupiter: 12.0, super_jupiter: 18.0,
};
const PLANET_COLOR: Record<string, [number, number, number]> = {
  terrestrial:   [0x6b / 255, 0xa2 / 255, 0xe0 / 255],
  super_earth:   [0xa3 / 255, 0x74 / 255, 0x3f / 255],
  neptune_like:  [0x4a / 255, 0x7e / 255, 0xb8 / 255],
  ice_giant:     [0x88 / 255, 0xd4 / 255, 0xee / 255],
  gas_giant:     [0xd9 / 255, 0xa3 / 255, 0x6b / 255],
  hot_jupiter:   [0xe0 / 255, 0x7b / 255, 0x3a / 255],
  super_jupiter: [0x9c / 255, 0x3e / 255, 0x2e / 255],
};

// --- DOM refs (unchanged) ---
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const overlay = document.getElementById("overlay") as HTMLDivElement;
const speedReadout = document.getElementById("speed-readout") as HTMLElement;
const throttleEl = document.getElementById("throttle") as HTMLInputElement;
const headingReadout = document.getElementById("heading-readout") as HTMLElement;
const warpBtn = document.getElementById("warp-btn") as HTMLButtonElement;
const hudPos = document.getElementById("hud-pos") as HTMLElement;
const hudDistance = document.getElementById("hud-distance") as HTMLElement;
const hudTarget = document.getElementById("hud-target") as HTMLElement;
const hudLlm = document.getElementById("hud-llm") as HTMLElement;
const hudShip = document.getElementById("hud-ship") as HTMLElement | null;
const hudMind = document.getElementById("hud-mind") as HTMLElement | null;

const targetReticle = document.getElementById("target-reticle") as HTMLDivElement;
const reticleBox = document.getElementById("reticle-box") as HTMLDivElement;
const reticleLineTop = document.getElementById("reticle-line-top") as HTMLDivElement;
const reticleLineBottom = document.getElementById("reticle-line-bottom") as HTMLDivElement;
const reticleLineLeft = document.getElementById("reticle-line-left") as HTMLDivElement;
const reticleLineRight = document.getElementById("reticle-line-right") as HTMLDivElement;
const reticleStatus = document.getElementById("reticle-status") as HTMLDivElement;
const reticleReadout = document.getElementById("reticle-readout") as HTMLDivElement;

const warpOverlayEl = document.getElementById("warp-overlay") as HTMLElement | null;

// --- pane + state ---
const pane = setupPaneApp("Culture Cockpit");
let gameId = "";
let playerId = "";
let stars: StarLite[] = [];
const observed = new Set<string>();

// Local mirror of the authoritative server ship state. Position/yaw/
// pitch/throttle are lerped/copied from Colyseus state each frame when
// connected; when offline this is integrated locally (legacy path).
const ship = {
  position: new Vector3(0, 0, 0),
  yaw: 0,
  pitch: 0,
  throttle: 0,
  hoveredId: null as string | null,
  targetId: null as string | null,
  warpEngaged: false,
};
let lastSyncedTargetId: string | null = null;
let lastArrivedTargetId: string | null = null;
/** Highest faceRequestTs we've acted on. Server bumps it whenever the
 *  face_target tool fires; on each new value we lerp the camera to
 *  face ship.targetId. */
let lastFaceRequestTs = 0;
/** Highest stopRequestTs we've acted on. Server bumps it on
 *  stop_engines; on each new value we zero throttle locally. */
let lastStopRequestTs = 0;

// --- Babylon engine + scene ---
const engine = new Engine(canvas, true, {
  stencil: true,
  preserveDrawingBuffer: false,
  antialias: true,
});
const scene = new Scene(engine);
scene.clearColor = new Color4(0.016, 0.024, 0.039, 1); // match Three's --bg #04060a
// Three uses right-handed coords by convention; Babylon defaults to
// left-handed. Flip here so position vectors port 1:1 from the existing
// catalog and Colyseus state without sign flips.
scene.useRightHandedSystem = true;

// UniversalCamera with no built-in inputs — we drive yaw/pitch from the
// existing drag-to-look handlers below. minZ small enough to not clip
// nearby in-system bodies; maxZ large enough to render stars at hundreds
// of ly. Full log-depth tuning is TODO(babylon).
const camera = new UniversalCamera("cam", new Vector3(0, 0, 0), scene);
camera.fov = 70 * Math.PI / 180;
camera.minZ = 0.0001;
camera.maxZ = 5000;
camera.inputs.clear();
scene.activeCamera = camera;

// Faint hemispheric ambient so a planet's dark side isn't pure black
// — closer in feel to the Three hemisphere light. The per-system
// point light below provides directional illumination.
const hemiLight = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
hemiLight.intensity = 0.05;
hemiLight.diffuse = new Color3(0.5, 0.6, 0.7);
hemiLight.groundColor = new Color3(0.05, 0.07, 0.1);

// Per-frame: positioned at the closest star and intensity scaled by
// distance, so in-system planets get sun-direction lighting.
const systemLight = new PointLight("sun", new Vector3(0, 0, 0), scene);
systemLight.intensity = 0;
systemLight.range = BRAKE_RANGE_LY * 4;

// Debug fill light — bright full-scene ambient, off by default. Toggle
// with L. Useful when you can't see anything because you're far from
// a star light and want to verify scene contents exist. Mirrors the
// debug fill from the Three port.
const debugFillLight = new HemisphericLight("debug", new Vector3(0, 1, 0), scene);
debugFillLight.intensity = 0;
debugFillLight.diffuse = new Color3(1, 1, 1);
debugFillLight.groundColor = new Color3(0.4, 0.4, 0.4);
let debugFillLightOn = false;

// Debug hook: expose engine/scene state to window so we can poke at
// it from DevTools or via the claude-in-chrome MCP toolkit. Tagged
// __cockpit so it's discoverable but doesn't pollute the global
// namespace too aggressively.
//
// (window as unknown as { __cockpit?: unknown }).__cockpit = { ... }
//   is the indirect-cast form to avoid a `@typescript-eslint/no-explicit-any`
//   lint warning here; runtime-equivalent to `(window as any).__cockpit`.
function exposeDebugState() {
  const w = window as unknown as Record<string, unknown>;
  w.__cockpit = {
    engine,
    scene,
    camera,
    debugFillLight,
    get debugFillLightOn() { return debugFillLightOn; },
    set debugFillLightOn(v: boolean) {
      debugFillLightOn = v;
      debugFillLight.intensity = v ? 1.5 : 0;
    },
    starMeshes,
    planetMeshes,
    otherShipSprites,
    get ship() { return ship; },
    get serverSelf() { return serverSelf; },
    get colyseusRoom() { return colyseusRoom; },
    get colyseusDebug() { return colyseusDebug.slice(); },
    COLYSEUS_URL,
  };
}

// Post-process pipeline. Replaces Three's EffectComposer +
// UnrealBloomPass. Bloom threshold + weight tuned to roughly match
// the prior Three look; will need re-tuning once sprite stacks land.
//
// IMPORTANT: disable imageProcessing.toneMappingEnabled — Babylon's
// pipeline has tone mapping ON by default, which brightens "dark"
// scenes (our near-black space background) into mid-gray. Three.js
// never applied this. Off entirely keeps the clearColor honest.
const pipeline = new DefaultRenderingPipeline("default", true, scene, [camera]);
pipeline.imageProcessingEnabled = false;
pipeline.fxaaEnabled = true;
pipeline.bloomEnabled = true;
pipeline.bloomThreshold = 0.78;
pipeline.bloomWeight = 0.5;
pipeline.bloomKernel = 96;
pipeline.bloomScale = 0.5;
pipeline.glowLayerEnabled = true;
if (pipeline.glowLayer) pipeline.glowLayer.intensity = 0.6;

// Babylon equivalent of THREE.Group — organizational nodes that don't
// render themselves but parent child meshes.
const starGroup = new TransformNode("starGroup", scene);
const planetGroup = new TransformNode("planetGroup", scene);
const orbitalGroup = new TransformNode("orbitalGroup", scene);
const otherShipsGroup = new TransformNode("otherShipsGroup", scene);

// --- Star rendering ---
// TODO(babylon): port the 3-layer sprite stack (core/halo/spike) +
// procedural CanvasTexture glow + magnitude-based sizing. For v1 each
// star is a single emissive sphere — visible and pickable but visually
// flat compared to Three.
const starMeshes = new Map<string, Mesh>();

function buildStarMeshes() {
  for (const m of starMeshes.values()) m.dispose();
  starMeshes.clear();
  for (const s of stars) {
    // True-scale (200× cheat from Three). Sol ≈ 0.93 AU radius.
    // Per-frame scaleStarsAndPlanetsByPixelSize() inflates this each
    // tick so distant stars stay above a minimum pixel size — without
    // that, anything beyond a few AU is sub-pixel.
    const trueRadius = (s.radiusSolar ?? 1.0) * SOL_RADIUS_LY * STAR_VISUAL_SCALE;
    const mesh = MeshBuilder.CreateSphere(
      `star:${s.id}`,
      { diameter: trueRadius * 2, segments: 16 },
      scene,
    );
    mesh.position.set(s.position[0], s.position[1], s.position[2]);
    const mat = new StandardMaterial(`star:${s.id}:mat`, scene);
    mat.emissiveColor = new Color3(1, 0.92, 0.7); // warm sol-ish
    mat.disableLighting = true;
    mesh.material = mat;
    mesh.parent = starGroup;
    mesh.isPickable = true;
    mesh.metadata = { kind: "star", starId: s.id, trueRadius };
    starMeshes.set(s.id, mesh);
  }
}

/** Per-frame scale-up so distant bodies don't disappear below a few
 *  pixels. Approximates the Three pixel-stable sprite behavior using
 *  per-frame mesh.scaling. Capped so close-up bodies render at true
 *  scale, not the inflated debug scale. Used until we port the
 *  proper magnitude-based sprite-stack system. */
const STAR_MIN_PX = 4;
const PLANET_MIN_PX = 2;
function scaleStarsAndPlanetsByPixelSize() {
  const canvasH = engine.getRenderHeight() || 600;
  const fov = camera.fov;
  // Pixels = (angularDiameter / fov) * canvasH = (2r / d / fov) * canvasH
  // We want: max(1, minPx / projectedPx)
  const minScaleFor = (trueR: number, distance: number, minPx: number): number => {
    if (distance <= 0) return 1;
    const projectedPx = ((2 * trueR) / distance / fov) * canvasH;
    if (projectedPx >= minPx) return 1;
    return minPx / projectedPx;
  };
  // Scratch vector to avoid allocations in the loop.
  const camPos = camera.position;
  for (const mesh of starMeshes.values()) {
    const md = mesh.metadata as { trueRadius?: number } | undefined;
    const r = md?.trueRadius ?? 1e-7;
    const d = Vector3.Distance(mesh.position, camPos);
    const s = minScaleFor(r, d, STAR_MIN_PX);
    mesh.scaling.setAll(s);
  }
  for (const pm of planetMeshes) {
    const md = pm.mesh.metadata as { trueRadius?: number } | undefined;
    const r = md?.trueRadius ?? 1e-9;
    const d = Vector3.Distance(pm.mesh.position, camPos);
    const s = minScaleFor(r, d, PLANET_MIN_PX);
    pm.mesh.scaling.setAll(s);
  }
}

// --- Planet rendering ---
// TODO(babylon): swap StandardMaterial → PBRMaterial for proper
// roughness/metallic + atmosphere shaders. Current MV is StandardMaterial
// with a diffuse color from the existing palette.
type PlanetMesh = {
  mesh: Mesh;
  starId: string;
  planetName: string;
  starPos: [number, number, number];
  orbitLy: number;
  phaseSeed: number;
  phaseSpeed: number;
};
const planetMeshes: PlanetMesh[] = [];

function planetPhaseSeed(starId: string, planetName: string): number {
  let h = 5381;
  const s = `${starId}::${planetName}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return ((h & 0xffffffff) / 0xffffffff) * Math.PI * 2;
}

function buildPlanetMeshes() {
  for (const pm of planetMeshes) pm.mesh.dispose();
  planetMeshes.length = 0;
  for (const s of stars) {
    if (!s.planets) continue;
    for (const p of s.planets) {
      const orbitAU = p.orbitAU ?? 1;
      const radiusR = p.radiusEarths ?? PLANET_RADIUS_R_EARTH[p.kind] ?? 1;
      // True scale (200× cheat) — Earth at 1 R⊕ × 200 ≈ 0.0086 AU
      // radius. Visible from within ~1 AU; invisible at warp range.
      // TODO(babylon): per-frame min-pixel sizing so distant planets
      // remain visible as pickable specks.
      const r = radiusR * EARTH_RADIUS_LY * PLANET_VISUAL_SCALE;
      const mesh = MeshBuilder.CreateSphere(
        `planet:${s.id}::${p.name}`,
        { diameter: r * 2, segments: 12 },
        scene,
      );
      const mat = new StandardMaterial(`planet:${s.id}::${p.name}:mat`, scene);
      const [cr, cg, cb] = PLANET_COLOR[p.kind] ?? [0.5, 0.5, 0.5];
      mat.diffuseColor = new Color3(cr, cg, cb);
      mat.specularColor = new Color3(0.1, 0.1, 0.1);
      mesh.material = mat;
      mesh.parent = planetGroup;
      mesh.isPickable = true;
      mesh.metadata = { kind: "planet", starId: s.id, planetName: p.name, trueRadius: r };
      planetMeshes.push({
        mesh,
        starId: s.id,
        planetName: p.name,
        starPos: s.position,
        orbitLy: orbitAU * LY_PER_AU,
        phaseSeed: planetPhaseSeed(s.id, p.name),
        phaseSpeed: Math.min(0.5, 0.05 / orbitAU),
      });
    }
  }
}

// --- Other-ship rendering with snapshot interpolation (from Pass 4) ---
type ShipSnapshot = { t: number; x: number; y: number; z: number };
const RENDER_DELAY_MS = 100;
const SNAPSHOT_BUFFER_SIZE = 8;

const otherShipSprites = new Map<string, {
  mesh: Mesh;
  snapshots: ShipSnapshot[];
}>();
/** Live { playerId → {pos, shipName} } map populated from the Colyseus
 *  state stream. Used by resolveTargetPosition for ship: targets. */
const otherShipsByPlayerId = new Map<string, { pos: [number, number, number]; shipName: string }>();

function ensureOtherShipSprite(sessionId: string) {
  if (otherShipSprites.has(sessionId)) return;
  // TODO(babylon): use a billboarded plane or SpriteManager for proper
  // pixel-stable rendering. Current MV is a tiny emissive sphere.
  const mesh = MeshBuilder.CreateSphere(`ship:${sessionId}`, { diameter: 0.0005, segments: 8 }, scene);
  const mat = new StandardMaterial(`ship:${sessionId}:mat`, scene);
  mat.emissiveColor = new Color3(0.53, 1.0, 0.85); // --ship cyan-green
  mat.disableLighting = true;
  mesh.material = mat;
  mesh.parent = otherShipsGroup;
  mesh.isPickable = true;
  otherShipSprites.set(sessionId, { mesh, snapshots: [] });
}

function applyOtherShipUpdate(sessionId: string, p: ServerPlayer) {
  const entry = otherShipSprites.get(sessionId);
  if (!entry) return;
  const last = entry.snapshots[entry.snapshots.length - 1];
  if (last && last.x === p.posX && last.y === p.posY && last.z === p.posZ) return;
  entry.snapshots.push({ t: performance.now(), x: p.posX, y: p.posY, z: p.posZ });
  if (entry.snapshots.length > SNAPSHOT_BUFFER_SIZE) entry.snapshots.shift();
  if (p.playerId) {
    otherShipsByPlayerId.set(p.playerId, { pos: [p.posX, p.posY, p.posZ], shipName: p.shipName });
    entry.mesh.metadata = { kind: "ship", playerId: p.playerId, shipName: p.shipName };
  }
}

function removeOtherShipSprite(sessionId: string) {
  const entry = otherShipSprites.get(sessionId);
  if (!entry) return;
  entry.mesh.dispose();
  otherShipSprites.delete(sessionId);
}

function tickOtherShipsFromColyseus() {
  if (otherShipSprites.size === 0) return;
  const renderTime = performance.now() - RENDER_DELAY_MS;
  for (const entry of otherShipSprites.values()) {
    const snaps = entry.snapshots;
    if (snaps.length === 0) continue;
    if (snaps.length === 1) {
      entry.mesh.position.set(snaps[0].x, snaps[0].y, snaps[0].z);
      continue;
    }
    let a: ShipSnapshot | null = null;
    let b: ShipSnapshot | null = null;
    for (let i = snaps.length - 1; i >= 1; i--) {
      if (snaps[i - 1].t <= renderTime && snaps[i].t >= renderTime) {
        a = snaps[i - 1];
        b = snaps[i];
        break;
      }
    }
    if (a && b) {
      const span = b.t - a.t;
      const alpha = span > 0 ? (renderTime - a.t) / span : 0;
      entry.mesh.position.x = a.x + (b.x - a.x) * alpha;
      entry.mesh.position.y = a.y + (b.y - a.y) * alpha;
      entry.mesh.position.z = a.z + (b.z - a.z) * alpha;
    } else if (renderTime < snaps[0].t) {
      entry.mesh.position.set(snaps[0].x, snaps[0].y, snaps[0].z);
    } else {
      const newest = snaps[snaps.length - 1];
      entry.mesh.position.set(newest.x, newest.y, newest.z);
    }
  }
}

// --- Target resolution ---
function resolveTargetPosition(
  id: string | null,
): { pos: [number, number, number]; isOrbital: boolean; name: string } | null {
  if (!id) return null;
  if (id.startsWith("ship:")) {
    const pid = id.slice("ship:".length);
    const entry = otherShipsByPlayerId.get(pid);
    if (!entry) return null;
    return { pos: entry.pos, isOrbital: false, name: entry.shipName };
  }
  if (id.startsWith("planet:")) {
    const rest = id.slice("planet:".length);
    const sep = rest.indexOf("::");
    if (sep < 0) return null;
    const starId = rest.slice(0, sep);
    const planetName = rest.slice(sep + 2);
    const pm = planetMeshes.find((p) => p.starId === starId && p.planetName === planetName);
    if (!pm) return null;
    return {
      pos: [pm.mesh.position.x, pm.mesh.position.y, pm.mesh.position.z],
      isOrbital: false,
      name: planetName,
    };
  }
  // TODO(babylon): handle orbital: targets once orbital rendering is
  // ported. For now they resolve to null and the reticle hides.
  const s = stars.find((s) => s.id === id);
  return s ? { pos: s.position, isOrbital: false, name: s.name } : null;
}

// --- Picking ---
function pickBodyUnderClick(clientX: number, clientY: number): string | null {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const pi = scene.pick(x, y, (m) => m.isPickable);
  if (!pi?.hit || !pi.pickedMesh) return null;
  const md = pi.pickedMesh.metadata as
    | { kind?: string; starId?: string; planetName?: string; playerId?: string }
    | undefined;
  if (!md) return null;
  if (md.kind === "star" && md.starId) return md.starId;
  if (md.kind === "planet" && md.starId && md.planetName) return `planet:${md.starId}::${md.planetName}`;
  if (md.kind === "ship" && md.playerId) return `ship:${md.playerId}`;
  return null;
}

async function pickAndAct(clientX: number, clientY: number, action: "target" | "align") {
  const id = pickBodyUnderClick(clientX, clientY);
  if (!id || !gameId || !playerId) return;
  try {
    await callTool(pane.app, "set_target", { gameId, playerId, targetId: id });
    if (action === "align") await callTool(pane.app, "face_target", { gameId, playerId });
  } catch (e) {
    console.warn(`[cockpit] pickAndAct(${action}) failed:`, e);
  }
}

async function engageWarp(objectId: string) {
  if (!gameId || !playerId) return;
  ship.targetId = objectId;
  ship.warpEngaged = true;
  lastSyncedTargetId = objectId;
  if (objectId.startsWith("orbital:")) {
    await callTool(pane.app, "warp_to_orbital", {
      gameId, playerId, orbitalId: objectId.slice("orbital:".length),
    });
  } else {
    await callTool(pane.app, "warp_to", { gameId, playerId, objectId });
  }
}

// --- Input handlers (verbatim from Three version) ---
let dragging = false;
let dragStart = { x: 0, y: 0 };
let dragMoved = false;
canvas.addEventListener("pointerdown", (e) => {
  dragging = true;
  userHasInteracted = true;
  dragStart = { x: e.clientX, y: e.clientY };
  dragMoved = false;
  overlay.classList.add("hidden");
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const dx = e.clientX - dragStart.x;
  const dy = e.clientY - dragStart.y;
  if (Math.hypot(dx, dy) > 4) dragMoved = true;
  dragStart = { x: e.clientX, y: e.clientY };
  const yawDelta = -dx * 0.004;
  const pitchDelta = dy * 0.004;
  ship.yaw += yawDelta;
  ship.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, ship.pitch + pitchDelta));
  sendIntent({ yawDelta, pitchDelta });
});
const CANVAS_DBLCLICK_GUARD_MS = 250;
let canvasClickTimer: number | null = null;
canvas.addEventListener("pointerup", (e) => {
  dragging = false;
  canvas.releasePointerCapture(e.pointerId);
  if (dragMoved) return;
  const x = e.clientX, y = e.clientY;
  if (canvasClickTimer != null) {
    window.clearTimeout(canvasClickTimer);
    canvasClickTimer = null;
  }
  canvasClickTimer = window.setTimeout(() => {
    canvasClickTimer = null;
    pickAndAct(x, y, "target");
  }, CANVAS_DBLCLICK_GUARD_MS);
});
canvas.addEventListener("dblclick", (e) => {
  if (canvasClickTimer != null) {
    window.clearTimeout(canvasClickTimer);
    canvasClickTimer = null;
  }
  pickAndAct(e.clientX, e.clientY, "align");
});

throttleEl.addEventListener("input", () => {
  userHasInteracted = true;
  const v = parseFloat(throttleEl.value);
  ship.throttle = v;
  if (ship.warpEngaged) ship.warpEngaged = false;
  sendIntent({ throttle: v });
});
warpBtn.addEventListener("click", () => {
  if (ship.targetId && !ship.targetId.startsWith("orbital:")) {
    void engageWarp(ship.targetId);
  }
});

// Arrow keys for camera look-around. Both keydown/keyup flag-based
// (smooth continuous rotation while held) AND key-repeat-friendly
// (each browser-emitted repeat keydown also nudges, so a quick tap
// works too). Designed to be friendly to keyboard-automation tools.
const arrowKeys = { up: false, down: false, left: false, right: false };

window.addEventListener("keydown", (e) => {
  const tag = (e.target as HTMLElement | null)?.tagName;
  // Don't steal arrows from form inputs (the throttle slider would
  // otherwise have its built-in arrow nudge fight us).
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.key === "ArrowUp")    { arrowKeys.up = true;    userHasInteracted = true; e.preventDefault(); }
  if (e.key === "ArrowDown")  { arrowKeys.down = true;  userHasInteracted = true; e.preventDefault(); }
  if (e.key === "ArrowLeft")  { arrowKeys.left = true;  userHasInteracted = true; e.preventDefault(); }
  if (e.key === "ArrowRight") { arrowKeys.right = true; userHasInteracted = true; e.preventDefault(); }
  // L toggles a bright fill light so you can see what you're flying
  // through (ported from the Three-side debug toggle).
  if (e.key === "l" || e.key === "L") {
    debugFillLightOn = !debugFillLightOn;
    debugFillLight.intensity = debugFillLightOn ? 1.5 : 0;
  }
});
window.addEventListener("keyup", (e) => {
  if (e.key === "ArrowUp")    arrowKeys.up = false;
  if (e.key === "ArrowDown")  arrowKeys.down = false;
  if (e.key === "ArrowLeft")  arrowKeys.left = false;
  if (e.key === "ArrowRight") arrowKeys.right = false;
});

/** Per-tick: integrate arrow-key rotation rates and ship them as
 *  input intents alongside the mouse-drag path. */
function applyArrowKeyLook(dt: number) {
  const RATE = 1.5; // rad/sec — comparable to a brisk mouse drag
  let yawDelta = 0;
  let pitchDelta = 0;
  if (arrowKeys.left)  yawDelta   -= RATE * dt;
  if (arrowKeys.right) yawDelta   += RATE * dt;
  if (arrowKeys.up)    pitchDelta += RATE * dt;
  if (arrowKeys.down)  pitchDelta -= RATE * dt;
  if (yawDelta === 0 && pitchDelta === 0) return;
  ship.yaw += yawDelta;
  ship.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, ship.pitch + pitchDelta));
  sendIntent({ yawDelta, pitchDelta });
}

// --- Colyseus connection (verbatim from Three version) ---
let serverSelf: ServerPlayer | null = null;
let colyseusRoom: ColyseusRoom<ServerWorld> | null = null;
let colyseusSessionId = "";

// Iframes mounted via srcdoc (the MCP-Apps host's default) have origin
// "null" and empty location.hostname, so reading window.location.hostname
// gives "" and produces a malformed "ws://:2567". Pull the hostname from
// document.referrer (the parent page's URL) if location.hostname is
// empty; if that's also empty (no referrer) fall back to localhost,
// which is the right default for local dev. For non-localhost deployments
// add ?colyseusHost=… to the iframe URL or wire the host through the
// init payload.
const colyseusHost = (() => {
  const fromQuery = new URLSearchParams(window.location.search).get("colyseusHost");
  if (fromQuery) return fromQuery;
  if (window.location.hostname) return window.location.hostname;
  try {
    const ref = document.referrer;
    if (ref) return new URL(ref).hostname || "localhost";
  } catch {}
  return "localhost";
})();
const COLYSEUS_URL = `ws://${colyseusHost}:${
  new URLSearchParams(window.location.search).get("colyseusPort") ?? "2567"
}`;
const RECON_TOKEN_KEY = (gid: string, rid: string) => `cockpit-recon-token:${gid}:${rid}`;

async function joinStarRoom(
  client: ColyseusClient,
  shipName: string,
  shipClass: string,
): Promise<ColyseusRoom<ServerWorld>> {
  const lastRoomId = localStorage.getItem(`cockpit-last-room:${gameId}`);
  if (lastRoomId) {
    const tok = localStorage.getItem(RECON_TOKEN_KEY(gameId, lastRoomId));
    if (tok) {
      try {
        return (await client.reconnect(tok)) as ColyseusRoom<ServerWorld>;
      } catch {
        localStorage.removeItem(RECON_TOKEN_KEY(gameId, lastRoomId));
      }
    }
  }
  return await client.joinOrCreate<ServerWorld>("star", {
    gameId, playerId, shipName, shipClass,
  });
}

/** Debug breadcrumbs from connectColyseus + reconnect attempts. Read via
 *  window.__cockpit.colyseusDebug in DevTools or the claude-in-chrome MCP. */
const colyseusDebug: string[] = [];
function cdb(msg: string) {
  colyseusDebug.push(`${new Date().toISOString().slice(11, 23)}  ${msg}`);
  console.log("[cockpit/colyseus]", msg);
}

async function connectColyseus(shipName: string, shipClass: string) {
  cdb(`start — url=${COLYSEUS_URL}, gameId=${gameId}, playerId=${playerId}, ship=${shipName}/${shipClass}`);
  try {
    const client = new ColyseusClient(COLYSEUS_URL);
    cdb(`Client constructed, calling joinStarRoom`);
    const room = await joinStarRoom(client, shipName, shipClass);
    cdb(`joined room ${room.roomId} as ${room.sessionId}`);
    colyseusRoom = room;
    colyseusSessionId = room.sessionId;
    localStorage.setItem(`cockpit-last-room:${gameId}`, room.roomId);
    localStorage.setItem(RECON_TOKEN_KEY(gameId, room.roomId), room.reconnectionToken);

    const $ = getStateCallbacks(room);
    $(room.state).players.onAdd((player: ServerPlayer, sessionId: string) => {
      if (sessionId === colyseusSessionId) {
        serverSelf = player;
        // One-shot orientation nudge: if the server-side pitch is the
        // default (~0, looking -Z into empty space from a spawn
        // position 10 AU above Sol), bias the view down toward Sol.
        // Skipped if the user has already interacted, so we don't
        // yank a camera the player is actively driving.
        if (!userHasInteracted && Math.abs(player.pitch) < 0.01) {
          sendIntent({ pitchDelta: -Math.PI / 3 });
        }
        return;
      }
      ensureOtherShipSprite(sessionId);
      applyOtherShipUpdate(sessionId, player);
      $(player).onChange(() => applyOtherShipUpdate(sessionId, player));
      $(player).listen("posX", () => applyOtherShipUpdate(sessionId, player));
      $(player).listen("posY", () => applyOtherShipUpdate(sessionId, player));
      $(player).listen("posZ", () => applyOtherShipUpdate(sessionId, player));
    });
    $(room.state).players.onRemove((_p: ServerPlayer, sessionId: string) => {
      if (sessionId === colyseusSessionId) {
        serverSelf = null;
        return;
      }
      removeOtherShipSprite(sessionId);
    });

    room.onLeave(() => {
      colyseusRoom = null;
      serverSelf = null;
    });
    room.onError((code, msg) => console.warn(`[colyseus] error ${code}: ${msg}`));
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    cdb(`FAILED: ${msg}`);
    console.warn("[cockpit] Colyseus connection failed (legacy path will engage):", e);
  }
}

function sendIntent(intent: { throttle?: number; yawDelta?: number; pitchDelta?: number }) {
  if (!colyseusRoom) return;
  try { colyseusRoom.send("input", intent); } catch {}
}

// --- init ---
pane.initial.then((init) => {
  gameId = init.gameId;
  playerId = init.playerId;
  stars = init.stars || [];
  buildStarMeshes();
  buildPlanetMeshes();
  if (init.llm) hudLlm.textContent = `${init.llm.online ? "" : "offline · "}${init.llm.provider}/${init.llm.model}`;
  if (init.ship && hudShip) hudShip.textContent = init.ship.name;
  if (init.ship && hudMind) hudMind.textContent = init.ship.class;
  // Spawn is ~10 AU "above" Sol (server.ts newPlayer puts you at
  // [0, 1.58e-4, 0]). The default yaw=pitch=0 looks down -Z so you'd
  // be staring at empty space with Sol below you. The actual pitch
  // adjustment lives in the onAdd-for-self callback below, where we
  // send a one-shot pitchDelta intent if the player hasn't yet
  // interacted (so server + client end up agreeing on the view).
  ship.pitch = -Math.PI / 3;
  void connectColyseus(init.ship?.name ?? "(unnamed)", init.ship?.class ?? "GCU");
});

/** Set true on first user pointer-down or throttle-input. Until then,
 *  connectColyseus is free to nudge the camera (one-shot pitch toward
 *  Sol on spawn). After interaction, the player owns their view and
 *  we don't override it. */
let userHasInteracted = false;

// --- Render loop ---
let last = performance.now();
function tick() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  // Arrow-key look-around — applied BEFORE we compute the forward
  // vector so this tick's render reflects the new orientation.
  applyArrowKeyLook(dt);

  // Forward vector from yaw/pitch in right-handed coords (matches the
  // Three convention since scene.useRightHandedSystem = true).
  const fwd = new Vector3(
    Math.cos(ship.pitch) * Math.sin(ship.yaw),
    Math.sin(ship.pitch),
    -Math.cos(ship.pitch) * Math.cos(ship.yaw),
  );

  // Authoritative state sync from Colyseus (Pass 3b/3c logic, unchanged).
  if (colyseusRoom && serverSelf) {
    const k = 0.55;
    ship.position.x = Scalar.Lerp(ship.position.x, serverSelf.posX, k);
    ship.position.y = Scalar.Lerp(ship.position.y, serverSelf.posY, k);
    ship.position.z = Scalar.Lerp(ship.position.z, serverSelf.posZ, k);
    if (!dragging) {
      ship.yaw = serverSelf.yaw;
      ship.pitch = serverSelf.pitch;
    }
    if (Math.abs(serverSelf.throttle - ship.throttle) > 0.005) {
      ship.throttle = serverSelf.throttle;
      throttleEl.value = ship.throttle.toString();
    }
    if (serverSelf.warpEngaged !== ship.warpEngaged) {
      ship.warpEngaged = serverSelf.warpEngaged;
    }
  } else {
    // Legacy fallback path: integrate locally.
    const speed = speedFromThrottle(ship.throttle);
    if (speed > 0) {
      ship.position.x += fwd.x * speed * dt;
      ship.position.y += fwd.y * speed * dt;
      ship.position.z += fwd.z * speed * dt;
    }
  }

  // Planet orbital position update. Wall-clock-synced (Date.now) so
  // both clients agree on phase (fixed in the planet-clock commit pre-migration).
  const PLANET_EPOCH_MS = 1746000000000;
  const tNow = (Date.now() - PLANET_EPOCH_MS) / 1000;
  for (const pm of planetMeshes) {
    const phase = pm.phaseSeed + tNow * pm.phaseSpeed;
    pm.mesh.position.x = pm.starPos[0] + Math.cos(phase) * pm.orbitLy;
    pm.mesh.position.y = pm.starPos[1];
    pm.mesh.position.z = pm.starPos[2] + Math.sin(phase) * pm.orbitLy;
  }

  // System light: position at the closest star, scale intensity by
  // proximity. Provides directional illumination for in-system planets.
  let closestStar: StarLite | null = null;
  let closestDist = Infinity;
  for (const s of stars) {
    const dx = s.position[0] - ship.position.x;
    const dy = s.position[1] - ship.position.y;
    const dz = s.position[2] - ship.position.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < closestDist) {
      closestDist = d;
      closestStar = s;
    }
  }
  if (closestStar && closestDist < BRAKE_RANGE_LY * 4) {
    systemLight.position.set(
      closestStar.position[0],
      closestStar.position[1],
      closestStar.position[2],
    );
    const intensity = Math.min(
      8.0,
      (BRAKE_RANGE_LY / Math.max(closestDist, SOL_RADIUS_LY * 200)) * 4,
    );
    systemLight.intensity = intensity;
  } else {
    systemLight.intensity = 0;
  }

  // Camera: tracks ship position + looks along fwd.
  camera.position.copyFrom(ship.position);
  camera.setTarget(ship.position.add(fwd));

  // Warp shimmer overlay
  const inWarp = ship.warpEngaged || ship.throttle > 0.45;
  if (warpOverlayEl) warpOverlayEl.classList.toggle("active", inWarp);

  // Per-frame pixel-stable sizing so stars/planets remain visible
  // from any distance (replacement for Three's sprite stack until
  // we port that properly).
  scaleStarsAndPlanetsByPixelSize();

  // HUD + reticle + other-ship interpolation
  updateHud();
  updateReticle();
  tickOtherShipsFromColyseus();
}

function updateHud() {
  speedReadout.textContent = formatSpeedShort(ship.throttle);
  const bearingDeg = (((ship.yaw * 180) / Math.PI) % 360 + 360) % 360;
  const elevDeg = (ship.pitch * 180) / Math.PI;
  headingReadout.textContent = `${bearingDeg.toFixed(0)}° / ${elevDeg.toFixed(0)}°`;
  // Distance "from Sol" — Sol is at origin in our coord system.
  const distFromSol = Math.hypot(ship.position.x, ship.position.y, ship.position.z);
  hudDistance.textContent = formatDistanceShort(distFromSol);
  // "at <closest star>" if within brake range, else "in transit".
  hudPos.textContent = "—";
  hudTarget.textContent = ship.targetId ? `target: ${ship.targetId}` : "no target";
}

// --- Reticle (port from Three) ---
// Project the target's world position to screen via Babylon's camera
// matrices; clamp to viewport with padding so off-screen targets show
// as edge markers. Per-frame in tick().
function updateReticle() {
  const tgt = resolveTargetPosition(ship.targetId);
  if (!tgt) {
    if (targetReticle.classList.contains("visible")) {
      targetReticle.classList.remove("visible");
    }
    return;
  }
  const tgtVec = new Vector3(tgt.pos[0], tgt.pos[1], tgt.pos[2]);
  const camFwd = camera.getDirection(new Vector3(0, 0, -1)); // right-handed forward = -Z
  const toTarget = tgtVec.subtract(ship.position);
  if (Vector3.Dot(toTarget, camFwd) <= 0) {
    if (targetReticle.classList.contains("visible")) {
      targetReticle.classList.remove("visible");
    }
    return;
  }
  // Project world → NDC → pixels via Babylon's projection.
  // Vector3.Project(point, worldMatrix, transformMatrix, viewport):
  //   worldMatrix = identity (the point is already in world coords)
  //   transformMatrix = scene's view × projection
  const w = engine.getRenderWidth();
  const h = engine.getRenderHeight();
  const projected = Vector3.Project(
    tgtVec,
    Matrix.Identity(),
    scene.getTransformMatrix(),
    new Viewport(0, 0, w, h),
  );
  // projected.x / projected.y are in screen-pixel space but at the
  // canvas's render resolution; map to CSS pixels via the canvas
  // bounding rect.
  const rect = canvas.getBoundingClientRect();
  const sx = rect.width;
  const sy = rect.height;
  const PAD = 36;
  const rawX = (projected.x / w) * sx;
  const rawY = (projected.y / h) * sy;
  const cx = Math.max(PAD, Math.min(sx - PAD, rawX));
  const cy = Math.max(PAD, Math.min(sy - PAD, rawY));
  const offEdge = rawX !== cx || rawY !== cy;
  reticleBox.classList.toggle("edge", offEdge);
  for (const ln of [reticleLineTop, reticleLineBottom, reticleLineLeft, reticleLineRight]) {
    ln.style.display = offEdge ? "none" : "";
  }

  const BOX = 56;
  const GAP = 6;
  const half = BOX / 2;
  reticleBox.style.left = `${cx}px`;
  reticleBox.style.top = `${cy}px`;
  reticleBox.style.width = `${BOX}px`;
  reticleBox.style.height = `${BOX}px`;

  const topLineH = Math.max(0, cy - half - GAP);
  reticleLineTop.style.left = `${cx}px`;
  reticleLineTop.style.top = "0";
  reticleLineTop.style.height = `${topLineH}px`;

  const bottomLineTop = cy + half + GAP;
  const bottomLineH = Math.max(0, sy - bottomLineTop);
  reticleLineBottom.style.left = `${cx}px`;
  reticleLineBottom.style.top = `${bottomLineTop}px`;
  reticleLineBottom.style.height = `${bottomLineH}px`;

  const leftLineW = Math.max(0, cx - half - GAP);
  reticleLineLeft.style.left = "0";
  reticleLineLeft.style.top = `${cy}px`;
  reticleLineLeft.style.width = `${leftLineW}px`;

  const rightLineLeft = cx + half + GAP;
  const rightLineW = Math.max(0, sx - rightLineLeft);
  reticleLineRight.style.left = `${rightLineLeft}px`;
  reticleLineRight.style.top = `${cy}px`;
  reticleLineRight.style.width = `${rightLineW}px`;

  // Status + readout rows.
  const rowTop1 = cy + half + GAP + 4;
  const rowTop2 = rowTop1 + 14;
  if (offEdge) {
    reticleStatus.style.display = "none";
    reticleReadout.style.display = "none";
  } else {
    if (ship.warpEngaged) {
      reticleStatus.style.display = "";
      reticleStatus.style.left = `${cx}px`;
      reticleStatus.style.top = `${rowTop1}px`;
      reticleStatus.classList.add("warp");
      reticleStatus.textContent = "▸ warp engaged";
    } else {
      reticleStatus.style.display = "none";
      reticleStatus.classList.remove("warp");
    }
    reticleReadout.style.display = "";
    reticleReadout.style.left = `${cx}px`;
    reticleReadout.style.top = `${ship.warpEngaged ? rowTop2 : rowTop1}px`;
    const distHtml = formatDistanceShort(toTarget.length());
    const speedHtml = formatSpeedShort(ship.throttle);
    reticleReadout.innerHTML = `<span class="v">${speedHtml}</span><span class="sep">·</span><span class="v">${distHtml}</span>`;
  }

  if (!targetReticle.classList.contains("visible")) {
    targetReticle.classList.add("visible");
  }
}

// --- Boot the render loop ---
engine.runRenderLoop(() => {
  tick();
  scene.render();
});
window.addEventListener("resize", () => engine.resize());
exposeDebugState();

// --- Server polling (unchanged from Three version) ---
poll(200, async () => {
  if (!gameId || !playerId) return;
  if (!colyseusRoom) {
    // Legacy fallback push when Colyseus is offline.
    await callTool(pane.app, "sync_state", {
      gameId, playerId,
      state: {
        position: [ship.position.x, ship.position.y, ship.position.z],
        heading: [Math.sin(ship.yaw), Math.sin(ship.pitch), -Math.cos(ship.yaw)],
        throttle: ship.throttle,
        hoveredId: ship.hoveredId,
      },
    });
  }
  const state = await callTool<{
    position?: [number, number, number];
    targetId?: string | null;
    warpEngaged?: boolean;
    faceRequestTs?: number;
    stopRequestTs?: number;
    galaxy?: {
      orbitals?: Array<{ id: string; position: [number, number, number] }>;
      nearbyPlayers?: Array<{
        playerId: string;
        shipName: string;
        position: [number, number, number];
      }>;
    };
  }>(pane.app, "get_state", { gameId, playerId });
  if (!state) return;
  if (state.targetId && state.targetId !== lastSyncedTargetId) {
    lastSyncedTargetId = state.targetId;
    ship.targetId = state.targetId;
    lastArrivedTargetId = null;
  }
  if (state.targetId === null && lastSyncedTargetId !== null) {
    lastSyncedTargetId = null;
    ship.targetId = null;
  }
  if (state && typeof state.warpEngaged === "boolean") {
    if (state.warpEngaged !== ship.warpEngaged && !colyseusRoom) {
      ship.warpEngaged = state.warpEngaged;
    }
  }
  // face_target one-shot. Server sets faceRequestTs = Date.now() when
  // the MCP face_target tool fires; whenever we see a fresh ts we
  // compute the yaw/pitch needed to look at the locked target and
  // send that as a delta via the input intent stream so the server
  // (and other clients) see the rotation, AND apply it locally for
  // instant feedback. Without this, the Align button is silent.
  if (state?.faceRequestTs && state.faceRequestTs > lastFaceRequestTs) {
    lastFaceRequestTs = state.faceRequestTs;
    const tgt = resolveTargetPosition(ship.targetId);
    if (tgt) {
      const dx = tgt.pos[0] - ship.position.x;
      const dy = tgt.pos[1] - ship.position.y;
      const dz = tgt.pos[2] - ship.position.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      const nx = dx / len, ny = dy / len, nz = dz / len;
      const wantYaw = Math.atan2(nx, -nz);
      const wantPitch = Math.asin(Math.max(-1, Math.min(1, ny)));
      const yawDelta = wantYaw - ship.yaw;
      const pitchDelta = wantPitch - ship.pitch;
      ship.yaw = wantYaw;
      ship.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, wantPitch));
      userHasInteracted = true;
      sendIntent({ yawDelta, pitchDelta });
    }
  }
  // stop_engines one-shot — server clears warpEngaged + sets
  // stopRequestTs; we mirror locally so warp-overlay/reticle status
  // clears immediately without waiting for the next Colyseus patch.
  if (state?.stopRequestTs && state.stopRequestTs > lastStopRequestTs) {
    lastStopRequestTs = state.stopRequestTs;
    ship.warpEngaged = false;
    ship.throttle = 0;
    throttleEl.value = "0";
  }
  // Legacy nearbyPlayers path: only fires when Colyseus is offline so
  // the per-sessionId Colyseus sprites and the legacy ones don't double up.
  // TODO(babylon): currently we don't render anything from this path
  // in v1 of the Babylon migration; just track via otherShipsByPlayerId
  // so ship: target resolution still works on the fallback.
  if (!colyseusRoom && state?.galaxy?.nearbyPlayers) {
    otherShipsByPlayerId.clear();
    for (const np of state.galaxy.nearbyPlayers) {
      otherShipsByPlayerId.set(np.playerId, { pos: np.position, shipName: np.shipName });
    }
  }
});

// Reference parking — orbitalGroup is built infrastructure for Pass-N
// orbital rendering; planetGroup / starGroup are populated by their
// respective build* fns above. Keep visible to TS so a future port
// doesn't have to re-introduce them.
void orbitalGroup;
void hemiLight;
void pipeline;
