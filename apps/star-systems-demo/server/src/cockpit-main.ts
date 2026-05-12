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
  Effect,
  Engine,
  HemisphericLight,
  Matrix,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  PointLight,
  Scalar,
  Scene,
  ShaderMaterial,
  StandardMaterial,
  TransformNode,
  UniversalCamera,
  Vector3,
  VertexBuffer,
  VertexData,
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
  WARP_MAX_LY_PER_S,
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
// The 200× visual-scale cheats from the Three port are gone.
// Stars and planets render at TRUE physical scale; the per-frame
// min-pixel inflation in scaleStarsAndPlanetsByPixelSize() handles
// distance visibility instead.
//
// const PLANET_VISUAL_SCALE = 200;
// const STAR_VISUAL_SCALE = 200;
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

/** Throttle slider remap — fixes the "too sensitive at the top" feel.
 *
 * Linear slider [0..1] used to map 1:1 to the cubic-speed throttle, so
 * warp 1 lived at throttle ~0.06 and the entire warp 1..9 band was
 * crammed into the top 94% of the slider. Fine impulse control got
 * the bottom 6%.
 *
 * New layout (slider value → throttle):
 *   [0.0, 0.5]  → linear impulse, throttle 0 → WARP_THROTTLE[1] (warp 1).
 *                 The cubic speed law inside this range gives natural
 *                 fine control near zero.
 *   [0.5, 1.0]  → snaps to the warp 1..9 detent grid (1/16-slider per
 *                 step), throttle pinned to the value that produces
 *                 exactly that warp factor.
 *
 * `<datalist id="throttle-marks">` in cockpit.html paints the warp
 * detents as visual tickmarks. The snap is enforced here in JS, not
 * via HTML step (which would block fine impulse below 0.5).
 *
 * Inverse map (throttle → slider) used to sync the slider position
 * back to the authoritative server throttle each frame (autopilot
 * ramps move the slider too). */
const WARP_THROTTLE: number[] = (() => {
  // Speed at warp k (matches formatSpeedShort's inverse):
  //   speed_k = 0.005 × 10^((k-1)/2.22)  ly/s
  //   throttle_k = cbrt(speed_k / WARP_MAX_LY_PER_S)
  // Index 0 = stopped. 1..9 = warp factors.
  const out: number[] = [0];
  for (let k = 1; k <= 9; k++) {
    const lyPerS = 0.005 * Math.pow(10, (k - 1) / 2.22);
    out.push(Math.min(1, Math.cbrt(lyPerS / WARP_MAX_LY_PER_S)));
  }
  return out;
})();

/** Slider zone split. Bottom IMPULSE_ZONE_END (= 2/3 of the slider)
 *  is impulse with a square curve for finer control near zero. Top
 *  third is the warp 1..9 detent grid. Adjust IMPULSE_ZONE_END if
 *  you want more or less headroom either side. */
const IMPULSE_ZONE_END = 2 / 3;

function sliderToThrottle(s: number): number {
  if (s <= IMPULSE_ZONE_END) {
    // Impulse: square curve so the lower 1/3 of the impulse zone gives
    // very fine control near zero. Maps [0, 2/3] → [0, WARP_THROTTLE[1]].
    const norm = s / IMPULSE_ZONE_END;
    return norm * norm * WARP_THROTTLE[1];
  }
  // Warp: snap to the nearest of 9 detents (W1..W9) across [2/3, 1.0].
  // User found the per-input snap "felt better" than fully-continuous
  // — gives a clear click at each warp factor while the impulse zone
  // stays smooth for fine sub-light control.
  const warpFloat = 1 + ((s - IMPULSE_ZONE_END) / (1 - IMPULSE_ZONE_END)) * 8;
  const warp = Math.max(1, Math.min(9, Math.round(warpFloat)));
  return WARP_THROTTLE[warp];
}

/** Inverse of sliderToThrottle — used to drive the slider thumb's
 *  visual position from the authoritative server throttle (e.g.
 *  during autopilot warp ramp). Continuous; no snap to detents. */
function throttleToSlider(t: number): number {
  if (t <= WARP_THROTTLE[1]) {
    return Math.sqrt(Math.max(0, t / WARP_THROTTLE[1])) * IMPULSE_ZONE_END;
  }
  const lyPerS = Math.pow(t, 3) * WARP_MAX_LY_PER_S;
  const warpFloat = 1 + 2.22 * Math.log10(lyPerS / 0.005);
  const clamped = Math.max(1, Math.min(9, warpFloat));
  return IMPULSE_ZONE_END + ((clamped - 1) / 8) * (1 - IMPULSE_ZONE_END);
}
const headingReadout = document.getElementById("heading-readout") as HTMLElement;
const warpBtn = document.getElementById("warp-btn") as HTMLButtonElement;
/** HUD-bottom stop button. Always visible (unlike target-info's STOP
 *  which is hidden when no target is locked). Calls stop_engines and
 *  mirrors disable state from current throttle/warpEngaged. */
const hudStopBtn = document.getElementById("hud-stop-btn") as HTMLButtonElement;

/** Maximum pitch magnitude. Was π/2 − 0.05 (~87°) which the user
 *  noticed as a hard stop short of straight up/down. Tightened to
 *  π/2 − 0.001 (~89.94°) — visually indistinguishable from exact
 *  90° but keeps the camera's up-vector and forward-direction
 *  non-colinear (avoids the gimbal-lock cross-product → 0 case in
 *  Babylon's view-matrix computation). */
const MAX_PITCH = Math.PI / 2 - 0.001;
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
/** Active "lerp the camera to look at this orientation" target. While
 *  non-null, tick() steps ship.yaw / ship.pitch toward these values
 *  at a fixed angular rate so the alignment is a smooth swing instead
 *  of an instant snap. Cleared once close enough. */
let faceLerpTarget: { yaw: number; pitch: number } | null = null;
/** Angular speed of the alignment swing (radians/sec). 2.5 ≈ a 180°
 *  turn in ~1.3 s with the exp-approach in tick(). Previously 4.0
 *  which the user found a hair too snappy. */
const FACE_LERP_RATE = 2.5;
/** Highest stopRequestTs we've acted on. Server bumps it on
 *  stop_engines; on each new value we zero throttle locally. */
let lastStopRequestTs = 0;

/** Floating-origin helpers. We render every star/planet/ship/light at
 *  camera-relative coords (camera sits at scene-origin (0,0,0)) so the
 *  GPU's float32 world-matrix never sees large absolute coords — that's
 *  what was collapsing AU-scale geometry into broken meshes near far
 *  stars. The CPU keeps positions in float64 via `ship.position` and
 *  the catalog/`pm.absPos`; only when handing a position to the GPU do
 *  we subtract ship.position.
 *
 *  - `toRenderSpace(p)`: returns a Vector3 = p − ship.position.
 *  - `setRenderSpace(mesh, p)`: writes camera-relative coord directly
 *    into mesh.position without allocating, for use in hot tick loops.
 *  Both consume a `[x, y, z]` tuple to avoid coupling to Vector3. */
function toRenderSpace(p: [number, number, number] | { x: number; y: number; z: number }): Vector3 {
  const x = Array.isArray(p) ? p[0] : p.x;
  const y = Array.isArray(p) ? p[1] : p.y;
  const z = Array.isArray(p) ? p[2] : p.z;
  return new Vector3(x - ship.position.x, y - ship.position.y, z - ship.position.z);
}
function setRenderSpace(mesh: Mesh, absX: number, absY: number, absZ: number) {
  mesh.position.set(absX - ship.position.x, absY - ship.position.y, absZ - ship.position.z);
}

/** Normalize an angle to [-π, π]. Used so face-target swings always
 *  take the short way around (a delta of 350° becomes -10°). */
function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// --- Babylon engine + scene ---
// 4th arg `adaptToDeviceRatio = true` makes the GPU render at physical
// pixels (devicePixelRatio × CSS size) instead of CSS size. Without
// this on a retina display we render at 1× and the browser bilinear-
// upscales 2× to the screen → very visibly splotchy. Cost is ~4×
// fill rate on a 2× display, but for a scene this geometry-light
// it's well worth it.
const engine = new Engine(canvas, true, {
  stencil: true,
  preserveDrawingBuffer: false,
  antialias: true,
}, true);
const scene = new Scene(engine);
scene.clearColor = new Color4(0.016, 0.024, 0.039, 1); // match Three's --bg #04060a
// Three uses right-handed coords by convention; Babylon defaults to
// left-handed. Flip here so position vectors port 1:1 from the existing
// catalog and Colyseus state without sign flips.
scene.useRightHandedSystem = true;

// UniversalCamera with no built-in inputs — we drive yaw/pitch from the
// existing drag-to-look handlers below.
//
// Depth precision: we render bodies from 1e-7 ly (planet surfaces at
// sub-AU range) to hundreds of ly. A plain Z-buffer with minZ small
// enough not to clip in-system bodies (~1e-8 ly) and maxZ ~5000 ly
// would have ~5e11 precision ratio — far worse than float32 can
// resolve, so we'd lose depth ordering on distant stars.
//
// Fix: scene.useReverseDepthBuffer = true. This flips Z so the near
// plane gets the precise end of the float32 range, dramatically
// improving precision for objects close to the camera. Babylon also
// disables built-in early-Z when this is on, so emissive-only
// far-stars (no depth writes that matter) coexist cleanly with
// the in-system meshes that need fine depth ordering.
//
// Without reverse-Z, the previous minZ=0.0001 (6.3 AU near plane)
// was clipping the in-system view of Sol when the ship got close.
engine.useReverseDepthBuffer = true;
const camera = new UniversalCamera("cam", new Vector3(0, 0, 0), scene);
camera.fov = 70 * Math.PI / 180;
camera.minZ = 1e-9; // ~0.06 AU = ~10 km — comfortably below planet surfaces
camera.maxZ = 5000; // ~5000 ly — covers the HYG bright catalog backdrop
                    // (Betelgeuse ≈ 642 ly, brightest landmarks up to a few
                    // kly). Reverse-Z keeps near-plane precision regardless.
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

// Debug "unlit" mode (L key).
//
// Goal: let the user actually see the shape of a star or planet — not
// what we ended up with in v1 (the emissive-disc fill blooms into the
// edge overlay and you can't read geometry; the edge overlay itself
// is 4 px wide on a 6 px sphere, so even close-up stars look like a
// random cyan asterisk).
//
// New approach in this revision:
//   1. Planets: keep flipping `unlit` on the PBRMaterial (worked).
//   2. Stars: SWAP from emissive-only (`disableLighting=true`,
//      emissiveColor=spectral) to LIT (`disableLighting=false`,
//      diffuseColor=spectral, emissive=black). This kills bloom AND
//      reveals the sphere via the terminator from `debugFillLight`.
//   3. Turn on `debugFillLight` (HemisphericLight, intensity 1.0).
//   4. Boost the min-pixel floor used by
//      `scaleStarsAndPlanetsByPixelSize` so distant stars get inflated
//      large enough to actually see (4 → 40 px). Without this, a star
//      that's normally a 4-pixel emissive dot would become a 4-pixel
//      DIM dot in debug, which defeats the purpose.
let unlitMode = false;
const debugFillLight = new HemisphericLight("debugFill", new Vector3(0, 1, 0), scene);
debugFillLight.intensity = 0;
debugFillLight.diffuse = new Color3(1, 1, 1);
debugFillLight.groundColor = new Color3(0.35, 0.35, 0.35);
function setUnlitMode(on: boolean) {
  unlitMode = on;
  for (const pm of planetMeshes) {
    const mat = pm.mesh.material;
    if (mat instanceof PBRMaterial) mat.unlit = on;
  }
  for (const m of starMeshes.values()) {
    if (!(m.material instanceof StandardMaterial)) continue;
    const mat = m.material;
    const md = m.metadata as { spectralColor?: [number, number, number] } | undefined;
    const sc = md?.spectralColor;
    if (!sc) continue;
    if (on) {
      mat.disableLighting = false;
      mat.emissiveColor = new Color3(0, 0, 0);
      mat.diffuseColor = new Color3(sc[0], sc[1], sc[2]);
      mat.specularColor = new Color3(0.05, 0.05, 0.05);
    } else {
      mat.disableLighting = true;
      mat.emissiveColor = new Color3(sc[0], sc[1], sc[2]);
      mat.diffuseColor = new Color3(sc[0], sc[1], sc[2]);
    }
  }
  debugFillLight.intensity = on ? 1.0 : 0;
}

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
    get unlitMode() { return unlitMode; },
    set unlitMode(v: boolean) { setUnlitMode(v); },
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
// MSAA — pipeline supports 1/2/4/8. Engine caps usually max at 4 on
// the GPUs we target. Combined with HiDPI rendering this removes most
// of the sphere-edge stipple at long distances.
pipeline.samples = 4;
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

/** Emissive color keyed on Harvard spectral class. Previously every
 *  star rendered the same warm-yellow (Sol-ish) regardless of class,
 *  so Sirius B's white dwarf, Betelgeuse's red supergiant, and Rigel's
 *  blue supergiant all looked identical. Values are rough perceptual
 *  approximations of the standard O→M color gradient; not blackbody-
 *  accurate but distinguishable at a glance. WD / NS / brown dwarfs
 *  get hand-picked accents. */
function starEmissiveColor(spectralClass: string | undefined): [number, number, number] {
  switch (spectralClass) {
    case "O":  return [0.65, 0.78, 1.00]; // blue
    case "B":  return [0.78, 0.88, 1.00]; // blue-white
    case "A":  return [1.00, 1.00, 1.00]; // white
    case "F":  return [1.00, 0.97, 0.85]; // yellow-white
    case "G":  return [1.00, 0.92, 0.70]; // yellow (Sol)
    case "K":  return [1.00, 0.75, 0.45]; // orange
    case "M":  return [1.00, 0.50, 0.30]; // red
    case "WD": return [0.95, 0.95, 1.00]; // white dwarf
    case "NS": return [0.80, 0.95, 1.00]; // neutron star (faintly bluish)
    case "L":
    case "T":
    case "Y":  return [0.45, 0.20, 0.15]; // brown dwarfs — dim red
    default:   return [1.00, 0.92, 0.70];
  }
}

function buildStarMeshes() {
  for (const m of starMeshes.values()) m.dispose();
  starMeshes.clear();
  for (const s of stars) {
    // TRUE-scale mesh — Sol ≈ 0.0047 AU radius (real Sun size). The
    // per-frame scaleStarsAndPlanetsByPixelSize() bumps the rendered
    // size up when distant so the body stays visible/pickable; up
    // close (sub-AU from the body) the inflation factor is 1 and
    // you see real proportions. Previous 200× cheat made Sol's
    // surface extend almost to Earth's orbit, which broke the view
    // at sub-AU distances.
    const trueRadius = (s.radiusSolar ?? 1.0) * SOL_RADIUS_LY;
    // segments: 48. Per-frame inflation can scale a star mesh by
    // 1e+7 or more — Sirius B's 6e-10 ly true radius gets a 4×10^7
    // scale-up to hit the 4-pixel floor at 8.6 ly away. At that
    // scaling each polygon facet covers a huge angle in world space,
    // and a 16- or 32-segment sphere shows visible "pyramid" facets.
    // 48 segments (~2300 verts/star × 21 stars = trivial) keeps even
    // wildly-inflated meshes looking round, AND gives the edge-
    // rendering debug overlay enough wire segments to read as a
    // proper sphere cage.
    const mesh = MeshBuilder.CreateSphere(
      `star:${s.id}`,
      { diameter: trueRadius * 2, segments: 48 },
      scene,
    );
    // mesh.position is set per-frame in tick() to (star.position -
    // ship.position) so rendering is camera-relative — see the
    // floating-origin block in tick(). Leaving it at default (0,0,0)
    // until the first tick is harmless: a stale frame would put the
    // star at origin, but tick fires before render. We do NOT set
    // it to the absolute coord here (which would be wrong on the
    // first frame at large player positions due to float32 collapse).
    const mat = new StandardMaterial(`star:${s.id}:mat`, scene);
    const [r, g, b] = starEmissiveColor(s.spectralClass);
    mat.emissiveColor = new Color3(r, g, b);
    // Diffuse mirrors emissive so when L swaps us into LIT debug mode
    // the lit material still carries the spectral tint.
    mat.diffuseColor = new Color3(r, g, b);
    mat.disableLighting = true;
    mesh.material = mat;
    mesh.parent = starGroup;
    mesh.isPickable = true;
    // spectralColor stashed in metadata so setUnlitMode() can swap
    // the material between emissive-only and lit without re-deriving
    // it from spectralClass each toggle.
    mesh.metadata = { kind: "star", starId: s.id, trueRadius, spectralColor: [r, g, b] };
    starMeshes.set(s.id, mesh);
  }
}

/** Render-config knobs in one place. Used by the per-frame pixel-floor
 *  inflation and the L-key debug toggle.
 *
 *  - `STAR_MIN_PX` / `PLANET_MIN_PX` / `SHIP_MIN_PX`: minimum projected
 *    pixel diameter; below this, the mesh is auto-inflated. Approximates
 *    the Three sprite-stack until the magnitude-based sprite system
 *    lands.
 *  - `DEBUG_*`: when unlit-debug (L) is on, bump the floor so distant
 *    bodies inflate into a visible lit-sphere you can read the shape
 *    of — otherwise a 4-px dim dot defeats the purpose.
 *  - `SHIP_TRUE_RADIUS_LY`: other-ship sprite sphere is 0.0005 ly
 *    diameter at mesh creation; this is the radius for the pixel-floor
 *    calc.
 *  - `INFLATION_CAMERA_CLEARANCE`: the inflation cap. Inflated mesh
 *    radius never exceeds this fraction of the camera-to-center
 *    distance — keeps the camera outside the mesh so we don't see the
 *    "half-helmet" back-hemisphere artifact.
 *  - `PLANET_EPOCH_MS`: wall-clock epoch for orbital phase so both
 *    cockpit panes agree on planet position. */
const RENDER_CONFIG = {
  STAR_MIN_PX: 4,
  PLANET_MIN_PX: 2,
  SHIP_MIN_PX: 3,
  DEBUG_STAR_MIN_PX: 60,
  DEBUG_PLANET_MIN_PX: 30,
  SHIP_TRUE_RADIUS_LY: 2.5e-4,
  INFLATION_CAMERA_CLEARANCE: 0.6,
  PLANET_EPOCH_MS: 1746000000000,
} as const;
function scaleStarsAndPlanetsByPixelSize() {
  const canvasH = engine.getRenderHeight() || 600;
  const fov = camera.fov;
  // Pixels = (angularDiameter / fov) * canvasH = (2r / d / fov) * canvasH
  // We want: max(1, minPx / projectedPx), CAPPED so the inflated mesh
  // never extends past the camera. Without the cap, a tiny star or
  // planet at close range gets inflated until its scaled radius > the
  // camera's distance to the body's center — at that point the camera
  // is INSIDE the inflated mesh and you see the back hemisphere from
  // inside (back-face culling produces a "half-helmet" silhouette).
  // It also causes nearby bodies' inflated meshes to overlap and
  // depth-fight (Earth-blue-lens-inside-Mars-brown was an example).
  // maxScale = 0.6 × distance / trueR keeps the inflated mesh inside
  // roughly 60% of the camera-to-center distance, leaving headroom.
  const minScaleFor = (trueR: number, distance: number, minPx: number): number => {
    if (distance <= 0) return 1;
    const projectedPx = ((2 * trueR) / distance / fov) * canvasH;
    if (projectedPx >= minPx) return 1;
    const wantScale = minPx / projectedPx;
    const maxScale = trueR > 0 ? (distance * RENDER_CONFIG.INFLATION_CAMERA_CLEARANCE) / trueR : wantScale;
    return Math.min(wantScale, maxScale);
  };
  // Under floating-origin the camera is at scene-origin (0,0,0) and
  // mesh.position is camera-relative; Vector3.Distance from origin is
  // just hypot(mesh.position), so we can skip building a camPos Vec3.
  const starFloor = unlitMode ? RENDER_CONFIG.DEBUG_STAR_MIN_PX : RENDER_CONFIG.STAR_MIN_PX;
  const planetFloor = unlitMode ? RENDER_CONFIG.DEBUG_PLANET_MIN_PX : RENDER_CONFIG.PLANET_MIN_PX;
  const applyPixelFloor = (mesh: Mesh, trueR: number, minPx: number) => {
    const d = mesh.position.length();
    mesh.scaling.setAll(minScaleFor(trueR, d, minPx));
  };
  for (const mesh of starMeshes.values()) {
    const md = mesh.metadata as { trueRadius?: number } | undefined;
    applyPixelFloor(mesh, md?.trueRadius ?? 1e-7, starFloor);
  }
  // Near-field HYG spheres get the same pixel-floor treatment as the
  // curated 21 — same path, same minScale math.
  for (const mesh of nearbyStarMeshes.values()) {
    const md = mesh.metadata as { trueRadius?: number } | undefined;
    applyPixelFloor(mesh, md?.trueRadius ?? 1e-7, starFloor);
  }
  for (const pm of planetMeshes) {
    const md = pm.mesh.metadata as { trueRadius?: number } | undefined;
    applyPixelFloor(pm.mesh, md?.trueRadius ?? 1e-9, planetFloor);
  }
  // Other-ship sprites: same pixel-floor treatment so distant
  // friendlies don't pop out of existence.
  for (const entry of otherShipSprites.values()) {
    applyPixelFloor(entry.mesh, RENDER_CONFIG.SHIP_TRUE_RADIUS_LY, RENDER_CONFIG.SHIP_MIN_PX);
  }
}

// --- Planet rendering ---
// PBRMaterial for proper energy-conservative shading. Planets are
// non-metallic rocky/icy bodies → metallic=0, roughness=0.85 (matte).
// Atmosphere shaders / per-kind PBR textures are a later pass.
type PlanetMesh = {
  mesh: Mesh;
  starId: string;
  planetName: string;
  starPos: [number, number, number];
  orbitLy: number;
  phaseSeed: number;
  phaseSpeed: number;
  /** Absolute world position computed each tick from starPos +
   *  orbital phase. Kept on the CPU at float64 precision so the
   *  reticle/distance math has the true value; the GPU sees only
   *  the camera-relative `mesh.position` to avoid float32 precision
   *  collapse at large coords (floating-origin renderer). */
  absPos: [number, number, number];
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
      // TRUE-scale planet radius — Earth at 1 R⊕ ≈ 4.3e-5 AU radius.
      // Tiny compared to its 1 AU orbit, which is what we want now
      // that the 200× cheat is gone. Distance visibility is handled
      // by scaleStarsAndPlanetsByPixelSize() per frame.
      const r = radiusR * EARTH_RADIUS_LY;
      const mesh = MeshBuilder.CreateSphere(
        `planet:${s.id}::${p.name}`,
        { diameter: r * 2, segments: 12 },
        scene,
      );
      const mat = new PBRMaterial(`planet:${s.id}::${p.name}:mat`, scene);
      const [cr, cg, cb] = PLANET_COLOR[p.kind] ?? [0.5, 0.5, 0.5];
      mat.albedoColor = new Color3(cr, cg, cb);
      mat.metallic = 0;
      mat.roughness = 0.85;
      // Modest direct intensity — bloom + glow already lift bright
      // pixels, no need to over-drive the material energy.
      mat.directIntensity = 1.0;
      mat.environmentIntensity = 0.5;
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
        absPos: [s.position[0], s.position[1], s.position[2]],
      });
    }
  }
}

// --- Bright-catalog backdrop (HYG, ~109k stars) + near-field promotion ---
//
// Two-tier rendering:
//
//   1. POINT CLOUD: all 109k catalog stars as a single Mesh rendered as
//      GL_POINTS. Vertices store ABSOLUTE world coords (set once);
//      floating origin via the master mesh's transform — each tick we
//      set `brightCloud.position = -ship.position` so the GPU's world
//      matrix translates the whole cloud camera-relative without
//      rewriting 109k vertices. Per-point color from spectral class,
//      brightness modulated by apparent magnitude.
//
//   2. NEAR-FIELD SPHERES: when the player is within NEAR_FIELD_LY of
//      any HYG star, we dynamically spawn a real floating-origin sphere
//      for it (same path as the curated 21). As the player moves, stars
//      entering range get promoted; stars leaving range have their mesh
//      disposed. This is how you can FLY TO any star in the catalog —
//      the point becomes a body up close.
//
// Float32 precision note: cloud vertex local coords are float32 at
// magnitudes up to a few thousand ly (precision ~5e-4 ly = 32 AU). For
// a pixel-sized dot at distance, invisible. Promoted spheres use the
// existing floating-origin path with full float64 precision.
type BrightStar = [string, number, number, number, string, number, number];
// [id, x, y, z, spectralClass, magnitude, radiusSolar]
let brightCloud: Mesh | null = null;
/** Parallel array of the full catalog, kept in module scope so the
 *  per-tick near-field scan can do a tight for-loop without rebuilding
 *  iterators each call. */
let brightCatalog: BrightStar[] = [];
/** ID → catalog entry, for fast lookup when targeting / promoting. */
const hygStarById = new Map<string, BrightStar>();
/** Stars currently rendered as full near-field spheres, keyed by ID.
 *  Different map from `starMeshes` (the curated 21) so the two paths
 *  don't fight over ownership. */
const nearbyStarMeshes = new Map<string, Mesh>();
/** Promotion radius. Stars closer than this in light-years get a real
 *  sphere mesh; farther stars are just points in the cloud. Equals
 *  MESH_FADE_FAR_LY so the mesh exists exactly for the duration of
 *  its visual fade-in. */
const NEAR_FIELD_LY = 15;
/** Mesh emissive fade-in window. At dist < MESH_FADE_NEAR the mesh is
 *  at full intensity; at dist > MESH_FADE_FAR (= NEAR_FIELD_LY) it
 *  hasn't been promoted yet. Tight ~10 ly window so the sphere
 *  appearance feels deliberate, not the same range as the long
 *  cloud-fade. */
const MESH_FADE_NEAR_LY = 5;
const MESH_FADE_FAR_LY = 15;
/** Cloud-point fade-out window. Much wider than the mesh's so the
 *  cloud's brightness is already dimming long before the mesh
 *  appears — avoids the "stars fade in out of nothingness at warp 9"
 *  feel where the cloud was full-intensity and then suddenly the
 *  mesh popped. Cloud fully visible beyond CLOUD_FADE_FAR, fully
 *  invisible inside CLOUD_FADE_NEAR. The 5..50 ly range covers
 *  ~2.6 s of warp-9 cruise (17 ly/s). Shader's smoothstep uses
 *  these values verbatim. */
const CLOUD_FADE_NEAR_LY = 5;
const CLOUD_FADE_FAR_LY = 50;
/** Re-evaluate promotion set every N ticks. Cheap loop over 109k
 *  entries is ~1 ms, so 60 fps is fine — but we don't need it that
 *  often unless the player is at warp. Every 4 ticks (~67 ms) is
 *  plenty smooth for visuals, and at warp speeds the player still
 *  sees ample lead-in to a new star. */
const NEARBY_REEVAL_EVERY = 4;
let nearbyReevalCounter = 0;

function buildBrightCloud(stars: BrightStar[]) {
  if (brightCloud) { brightCloud.dispose(); brightCloud = null; }
  hygStarById.clear();
  brightCatalog = stars;
  if (stars.length === 0) return;
  const positions = new Float32Array(stars.length * 3);
  const colors = new Float32Array(stars.length * 4);
  for (let i = 0; i < stars.length; i++) {
    const entry = stars[i];
    const [id, x, y, z, sc, mag] = entry;
    hygStarById.set(id, entry);
    positions[i * 3 + 0] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    const [r, g, b] = starEmissiveColor(sc);
    // Astronomical magnitude → relative brightness is logarithmic
    // (5 magnitudes = 100× brightness). We compress the curve to keep
    // dim stars visible (1-px points on a black sky disappear below
    // ~15 % linear intensity due to gamma + anti-alias).
    //
    //   exp 0.20: mag 0 → 1.0; mag 6 → 0.43; mag 12 → 0.18; mag 18 → 0.077
    //   floor 0.18 lifts the bottom so even mag 18 catalog stars
    //   register as visible specks.
    //
    // Combined with the per-vertex size hint (1 px floor → 6 px
    // ceiling) the brightest stars are unmistakably bigger while the
    // faint majority still register.
    const linear = Math.pow(10, -0.4 * mag);
    const intensity = Math.max(0.18, Math.min(1, Math.pow(linear, 0.20)));
    // Alpha = sizeHint / 8 (shader multiplies by 8). 1..4 px range
    // — was 1..6 which the user found too big. The shader also grows
    // small dots toward 4 px as the player approaches, so dim stars
    // stay visible during the cloud-to-mesh handoff.
    const sizeHint = Math.max(1, Math.min(4, 4 - mag * 0.4));
    colors[i * 4 + 0] = r * intensity;
    colors[i * 4 + 1] = g * intensity;
    colors[i * 4 + 2] = b * intensity;
    colors[i * 4 + 3] = sizeHint / 8;
  }
  const mesh = new Mesh("brightCloud", scene);
  const vd = new VertexData();
  vd.positions = positions;
  vd.colors = colors;
  vd.applyToMesh(mesh, false);
  mesh.setVerticesData(VertexBuffer.ColorKind, colors, false, 4);
  // Use a tiny custom ShaderMaterial — StandardMaterial's vertex-
  // color path is gated on the lighting pipeline (it gets used as
  // the diffuse albedo). With `disableLighting = true` it's bypassed
  // entirely, so per-vertex colors are dropped and 109k points all
  // render at the constant emissiveColor. linkEmissiveWithDiffuse
  // also fails on the points-cloud render path (Babylon switches to
  // a simpler shader). The shader below just outputs vertex.color
  // directly — no lighting, no emissive constant, no Babylon shader
  // quirks. Two-line vert + frag.
  // Vert shader: pass color.rgb through, sized by alpha hint, AND
  // fade brightness as the camera approaches. Without the fade, a
  // star at e.g. 2 ly stays full-intensity as a 1-px point in the
  // cloud, then abruptly snaps to a multi-pixel sphere mesh once
  // it's within NEAR_FIELD_LY — the user described that as
  // "very abrupt and bright." The fade zone is [FADE_NEAR..FADE_FAR]
  // light-years: fully visible beyond FADE_FAR, fully invisible
  // within FADE_NEAR (which matches NEAR_FIELD_LY so the cloud
  // disappears exactly where the mesh takes over).
  //
  // We need the world matrix to compute the camera-relative position
  // (under floating-origin, camera is at scene origin, so the
  // post-`world` vertex position IS the camera-relative coord).
  // Shader does three things per vertex:
  //   1. fade brightness as the camera approaches (smoothstep across
  //      FADE_NEAR..NEAR_FIELD; outside this range full or zero)
  //   2. grow the point's screen size toward 4 px on approach — so a
  //      1-px dim dot becomes a 4-px dot before the mesh takes over,
  //      avoiding a "tiny point disappears, big mesh appears" pop
  //   3. project the vertex
  // The smoothstep edges MUST match FADE_NEAR_LY/NEAR_FIELD_LY in
  // the TS constants above.
  // Shader effects, in order:
  //   1. Brightness-aware close-range fade. Only the very brightest
  //      cloud points (Sirius-class, where the color's max channel
  //      is near 1.0) get a "super light" dimming as the player
  //      approaches; dim stars don't fade since their meshes are
  //      already dim and there's no abrupt transition to soften.
  //   2. Distant-cluster fade-out (1000..5000 ly). Viewed from
  //      thousands of ly out, the cluster of nearby stars all sit
  //      in a small angular area — without this they pile up as a
  //      splotchy bright clump in the void.
  //   3. Size growth toward 4 px on approach so a dim 1-px dot
  //      matches the mesh's min-pixel-floor at the handoff range.
  // Far fade uses a 1/dist falloff with a 550 ly reference distance —
  // approximates the inverse-square law that would dim a real star
  // viewed from far away. Previous 300 ly reference faded everything
  // too aggressively; this lifts the curve so 1000 ly out reads at
  // the same brightness 550 ly out used to.
  //
  // At dist 550 ly: full. At 1000 ly: 55 %. At 2000 ly: 28 %.
  // At 5000+ ly: ~11 %.
  //
  // Also shrinks point size at long range via mix(1, baseSize,
  // farFade) so the cluster reads as small dim points instead of a
  // pile of fat bright dots when viewed from thousands of ly out.
  Effect.ShadersStore["brightCloudVertexShader"] =
    "precision highp float;" +
    "attribute vec3 position;" +
    "attribute vec4 color;" +
    "uniform mat4 worldViewProjection;" +
    "uniform mat4 world;" +
    "varying vec3 vRgb;" +
    "void main(){" +
    "  vec4 wp = world * vec4(position,1.0);" +
    "  float dist = length(wp.xyz);" +
    "  float brightness = max(color.r, max(color.g, color.b));" +
    "  float brightT = smoothstep(0.5, 1.0, brightness);" +
    "  float minFade = mix(1.0, 0.5, brightT);" +
    "  float closeFade = mix(minFade, 1.0, smoothstep(5.0, 15.0, dist));" +
    "  float farFade = clamp(550.0 / max(dist, 50.0), 0.0, 1.0);" +
    "  vRgb = color.rgb * closeFade * farFade;" +
    "  gl_Position = worldViewProjection * vec4(position,1.0);" +
    "  float baseSize = color.a * 8.0;" +
    "  float closeness = 1.0 - smoothstep(5.0, 15.0, dist);" +
    "  float grown = max(baseSize, mix(baseSize, 4.0, closeness));" +
    "  gl_PointSize = mix(1.0, grown, farFade);" +
    "}";
  Effect.ShadersStore["brightCloudFragmentShader"] =
    "precision highp float;" +
    "varying vec3 vRgb;" +
    "void main(){ gl_FragColor = vec4(vRgb, 1.0); }";
  const mat = new ShaderMaterial(
    "brightCloudMat",
    scene,
    { vertex: "brightCloud", fragment: "brightCloud" },
    { attributes: ["position", "color"], uniforms: ["worldViewProjection", "world"] },
  );
  mat.pointsCloud = true;
  mat.disableDepthWrite = true;
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  brightCloud = mesh;
}

/** Build a real sphere mesh for a HYG star (analogue of buildStarMeshes()
 *  but for a single catalog entry). Returns the mesh; caller stores it
 *  in `nearbyStarMeshes`. Floating-origin position is applied in tick;
 *  here we just create at scene-origin and let the per-frame loop set
 *  the camera-relative coord. */
function buildHygStarMesh(entry: BrightStar): Mesh {
  const [id, , , , sc, mag, radiusSolar] = entry;
  const trueRadius = (radiusSolar || 1) * SOL_RADIUS_LY;
  const mesh = MeshBuilder.CreateSphere(`hyg:${id}`, { diameter: trueRadius * 2, segments: 48 }, scene);
  const mat = new StandardMaterial(`hyg:${id}:mat`, scene);
  const [r, g, b] = starEmissiveColor(sc);
  // Magnitude-derived brightness, same formula as cloud points so the
  // mesh's full emissive matches what the cloud point was showing —
  // otherwise a dim star's cloud point at ~0.18 intensity hands off
  // to a mesh at 1.0 emissive, a 5× brightness jump that reads as
  // "appears out of nothing." Floor 0.18, exp 0.20.
  const linear = Math.pow(10, -0.4 * mag);
  const magIntensity = Math.max(0.18, Math.min(1, Math.pow(linear, 0.20)));
  mat.emissiveColor = new Color3(r * magIntensity, g * magIntensity, b * magIntensity);
  mat.diffuseColor = new Color3(r, g, b);
  mat.disableLighting = true;
  mesh.material = mat;
  mesh.parent = starGroup;
  mesh.isPickable = true;
  mesh.metadata = { kind: "star", starId: id, trueRadius, spectralColor: [r, g, b], magIntensity };
  return mesh;
}

/** Per-tick: scan the catalog (via the parallel BrightStar array
 *  cached on init) for stars within NEAR_FIELD_LY of the ship.
 *  Promote new ones to real sphere meshes; demote ones that left
 *  range by disposing their mesh.
 *
 *  Iterating 109k entries each tick is ~1 ms; we throttle further via
 *  NEARBY_REEVAL_EVERY to keep frame budget healthy. */
function updateNearbyStars(brightStars: BrightStar[]) {
  if (++nearbyReevalCounter < NEARBY_REEVAL_EVERY) return;
  nearbyReevalCounter = 0;
  const sx = ship.position.x, sy = ship.position.y, sz = ship.position.z;
  const r2 = NEAR_FIELD_LY * NEAR_FIELD_LY;
  const stillNear = new Set<string>();
  for (let i = 0; i < brightStars.length; i++) {
    const e = brightStars[i];
    // Skip curated stars — they already have an always-on sphere
    // (buildStarMeshes → starMeshes). The cloud still includes them
    // as dots for the long-distance view, but here we'd double-render.
    if (starMeshes.has(e[0])) continue;
    const dx = e[1] - sx, dy = e[2] - sy, dz = e[3] - sz;
    if (dx * dx + dy * dy + dz * dz <= r2) {
      stillNear.add(e[0]);
      if (!nearbyStarMeshes.has(e[0])) {
        nearbyStarMeshes.set(e[0], buildHygStarMesh(e));
      }
    }
  }
  // Dispose meshes for stars that have left the near field.
  for (const [id, mesh] of nearbyStarMeshes) {
    if (!stillNear.has(id)) {
      mesh.dispose();
      nearbyStarMeshes.delete(id);
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
  // Floating origin: snapshots are stored as absolute world coords
  // from the server (so interpolation math is exact regardless of
  // the local ship's position). setRenderSpace() does the
  // camera-relative subtraction at the GPU boundary.
  for (const entry of otherShipSprites.values()) {
    const snaps = entry.snapshots;
    if (snaps.length === 0) continue;
    if (snaps.length === 1) {
      setRenderSpace(entry.mesh, snaps[0].x, snaps[0].y, snaps[0].z);
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
      setRenderSpace(
        entry.mesh,
        a.x + (b.x - a.x) * alpha,
        a.y + (b.y - a.y) * alpha,
        a.z + (b.z - a.z) * alpha,
      );
    } else if (renderTime < snaps[0].t) {
      setRenderSpace(entry.mesh, snaps[0].x, snaps[0].y, snaps[0].z);
    } else {
      const newest = snaps[snaps.length - 1];
      setRenderSpace(entry.mesh, newest.x, newest.y, newest.z);
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
      // Return ABSOLUTE world coord (pm.absPos) — callers use this for
      // distance and reticle projection in the true world frame. The
      // GPU's camera-relative mesh.position only lives inside render().
      pos: [pm.absPos[0], pm.absPos[1], pm.absPos[2]],
      isOrbital: false,
      name: planetName,
    };
  }
  // TODO(babylon): handle orbital: targets once orbital rendering is
  // ported. For now they resolve to null and the reticle hides.
  const s = stars.find((s) => s.id === id);
  if (s) return { pos: s.position, isOrbital: false, name: s.name };
  // HYG catalog fallback — a non-curated star id (e.g. "hd-12345").
  // Lets the reticle/warp/observe paths work for any of the 109k.
  const hyg = hygStarById.get(id);
  if (hyg) return { pos: [hyg[1], hyg[2], hyg[3]], isOrbital: false, name: id };
  return null;
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
  let res: { kind?: string; name?: string; error?: string } | null;
  if (objectId.startsWith("orbital:")) {
    res = await callTool(pane.app, "warp_to_orbital", {
      gameId, playerId, orbitalId: objectId.slice("orbital:".length),
    });
  } else {
    res = await callTool(pane.app, "warp_to", { gameId, playerId, objectId });
  }
  // The MCP warp_to handler refuses to engage when the target is
  // already within OBSERVE_RANGE_LY (0.15 ly) and returns
  // kind: "already_at" without setting player.warpEngaged. Without
  // this hand-back the cockpit would briefly flash the warp overlay
  // (ship.warpEngaged=true above) then have it silently snap back
  // to false on the next Colyseus state sync — making it look like
  // warp is broken. Reset locally and tell the user why instead.
  if (res?.kind === "already_at") {
    ship.warpEngaged = false;
    hudPos.textContent = `already at ${res.name ?? objectId}`;
    setTimeout(() => { hudPos.textContent = "—"; }, 2500);
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
  ship.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, ship.pitch + pitchDelta));
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
  const sliderVal = parseFloat(throttleEl.value);
  const actualThrottle = sliderToThrottle(sliderVal);
  // Warp zone snaps visually on every input event so the user sees
  // the thumb click into the nearest detent as they drag. Impulse
  // zone stays continuous.
  if (sliderVal > IMPULSE_ZONE_END) {
    throttleEl.value = throttleToSlider(actualThrottle).toString();
  }
  ship.throttle = actualThrottle;
  if (ship.warpEngaged) ship.warpEngaged = false;
  sendIntent({ throttle: actualThrottle });
});
warpBtn.addEventListener("click", () => {
  if (ship.targetId && !ship.targetId.startsWith("orbital:")) {
    void engageWarp(ship.targetId);
  }
});
hudStopBtn.addEventListener("click", () => {
  if (!gameId || !playerId) return;
  // Same MCP path the target-info STOP uses. Cockpit's poll handler
  // already mirrors the stopRequestTs back to the local ship.throttle.
  void callTool(pane.app, "stop_engines", { gameId, playerId });
});

/** Position the throttle-detent markers in absolute pixels so they
 *  line up with where the slider thumb actually sits for each value.
 *  Chrome/Safari/Firefox default range inputs travel the thumb
 *  CENTER from x=0 to x=width of the input element (the thumb
 *  visually extends past the ends; it isn't inset by half-thumb).
 *  So no THUMB_HALF correction is needed — just translate
 *  data-slider-value (0..1) onto the slider's bounding box. The
 *  slider's own offset from the container (a 2 px padding in
 *  practice) is preserved via `sliderRect.left - containerRect.left`. */
function positionThrottleMarks() {
  const marks = document.querySelectorAll<HTMLElement>(".throttle-marks .mark");
  if (marks.length === 0) return;
  const container = marks[0].parentElement;
  if (!container) return;
  const sliderRect = throttleEl.getBoundingClientRect();
  if (sliderRect.width <= 0) return; // not laid out yet
  const containerRect = container.getBoundingClientRect();
  const travelStart = sliderRect.left - containerRect.left;
  const travelWidth = sliderRect.width;
  for (const mark of marks) {
    const v = parseFloat(mark.dataset.sliderValue ?? "0");
    mark.style.left = `${travelStart + v * travelWidth}px`;
  }
}
// ResizeObserver fires whenever the slider's size changes — covers
// window resize, iframe-parent layout shifts, dev-tools toggling
// view sizes, etc. `window.resize` alone misses iframe-internal
// resizes which left the marker positions stale and visibly off.
const _throttleResizeObs = new ResizeObserver(() => positionThrottleMarks());
_throttleResizeObs.observe(throttleEl);
// Initial pass after layout settles.
requestAnimationFrame(() => positionThrottleMarks());

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
  // L toggles unlit mode — planets render as flat albedo with no
  // shading, so they're visible regardless of star proximity. See
  // setUnlitMode for the rationale (replaces a HemisphericLight fill
  // that was double-lighting near a star and useless in deep space).
  if (e.key === "l" || e.key === "L") {
    setUnlitMode(!unlitMode);
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
  ship.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, ship.pitch + pitchDelta));
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

/** Wall-clock ms of the last yaw or pitch delta we sent to the server.
 *  Used by the state-sync block to suppress yaw/pitch convergence
 *  while the server is still processing queued input — otherwise the
 *  client snaps back to a stale server value, then forward again when
 *  the next schema patch arrives (visible as reticle bounce). */
let lastInputSentMs = 0;
function sendIntent(intent: { throttle?: number; yawDelta?: number; pitchDelta?: number }) {
  if (!colyseusRoom) return;
  if (intent.yawDelta != null || intent.pitchDelta != null) {
    lastInputSentMs = performance.now();
  }
  try { colyseusRoom.send("input", intent); } catch {}
}

// --- init ---
pane.initial.then((init) => {
  gameId = init.gameId;
  playerId = init.playerId;
  stars = init.stars || [];
  buildStarMeshes();
  buildPlanetMeshes();
  buildBrightCloud((init.bright || []) as BrightStar[]);
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

  // Smooth face-target alignment. When the Align button fires, we
  // stash the desired yaw/pitch in `faceLerpTarget` and swing toward
  // it here with an exponential approach (rate = FACE_LERP_RATE rad/s).
  // The yaw delta is normalized so we always take the SHORT path
  // around the unit circle (avoids unwinding 350° instead of -10°).
  // We also forward the per-frame delta as an intent so the server's
  // authoritative yaw/pitch follows, and any other clients watching
  // see the rotation. Stopping condition: angular gap < 0.5° on both
  // axes.
  if (faceLerpTarget && !dragging) {
    const dyaw = normalizeAngle(faceLerpTarget.yaw - ship.yaw);
    const dpitch = faceLerpTarget.pitch - ship.pitch;
    const k = Math.min(1, dt * FACE_LERP_RATE);
    const stepYaw = dyaw * k;
    const stepPitch = dpitch * k;
    ship.yaw = normalizeAngle(ship.yaw + stepYaw);
    ship.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, ship.pitch + stepPitch));
    sendIntent({ yawDelta: stepYaw, pitchDelta: stepPitch });
    if (Math.abs(dyaw) < 0.009 && Math.abs(dpitch) < 0.009) faceLerpTarget = null;
  } else if (faceLerpTarget && dragging) {
    // User took the camera back manually — abort the alignment.
    faceLerpTarget = null;
  }

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
    // Yaw/pitch sync only when (a) the user isn't actively dragging
    // and (b) the server has had a couple ticks since we last sent
    // input — otherwise our local yaw is genuinely ahead of the
    // last-confirmed serverSelf.yaw and pulling toward it causes
    // visible drift-then-bounce as queued deltas catch up. The
    // 100 ms window covers 2 × 50 ms server ticks plus a small
    // safety margin.
    if (!dragging && performance.now() - lastInputSentMs > 100) {
      // Soft converge to authoritative once the server is caught up.
      // normalizeAngle handles wrap so client yaw outside [-π, π]
      // (we don't normalize locally on drag) still picks the short
      // angular path.
      const k = Math.min(1, dt * 12);
      ship.yaw += normalizeAngle(serverSelf.yaw - ship.yaw) * k;
      ship.pitch += (serverSelf.pitch - ship.pitch) * k;
    }
    if (Math.abs(serverSelf.throttle - ship.throttle) > 0.005) {
      ship.throttle = serverSelf.throttle;
      // Map the authoritative throttle back into slider space — the
      // autopilot can produce arbitrary values; we snap the visible
      // thumb to the nearest warp detent or the linear impulse
      // position. See throttleToSlider().
      throttleEl.value = throttleToSlider(ship.throttle).toString();
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
  //
  // Floating origin: absPos holds the true world coord (used by the
  // reticle / picking / distance math on the CPU); mesh.position
  // carries only the camera-relative coord (= absPos - ship.position)
  // so the GPU's float32 world-matrix doesn't collapse AU-scale
  // geometry at large absolute coords.
  const tNow = (Date.now() - RENDER_CONFIG.PLANET_EPOCH_MS) / 1000;
  for (const pm of planetMeshes) {
    const phase = pm.phaseSeed + tNow * pm.phaseSpeed;
    pm.absPos[0] = pm.starPos[0] + Math.cos(phase) * pm.orbitLy;
    pm.absPos[1] = pm.starPos[1];
    pm.absPos[2] = pm.starPos[2] + Math.sin(phase) * pm.orbitLy;
    setRenderSpace(pm.mesh, pm.absPos[0], pm.absPos[1], pm.absPos[2]);
  }

  // Star mesh positions (floating origin): every star's world coord
  // is constant on the CPU (s.position) but the rendered mesh sits at
  // (s.position - ship.position) so we never feed magnitude-N world
  // coords into the GPU's float32 vertex transform.
  //
  // Lazy curated rendering: each curated star sphere is only rendered
  // when the player is within NEAR_FIELD_LY. Farther than that, the
  // point-cloud dot represents it (added by the server's brightStars
  // payload now that curated are included). Toggling isVisible (not
  // disposing) is cheap and keeps the meshes warm for the next time
  // we approach.
  const nearR2 = NEAR_FIELD_LY * NEAR_FIELD_LY;
  for (const s of stars) {
    const m = starMeshes.get(s.id);
    if (!m) continue;
    const dx = s.position[0] - ship.position.x;
    const dy = s.position[1] - ship.position.y;
    const dz = s.position[2] - ship.position.z;
    const near = dx * dx + dy * dy + dz * dz <= nearR2;
    m.isVisible = near;
    if (near) setRenderSpace(m, s.position[0], s.position[1], s.position[2]);
  }
  // Planet meshes follow their parent star's visibility — no point
  // simulating Earth around Sol if you're 800 ly out at Rigel.
  for (const pm of planetMeshes) {
    const parent = starMeshes.get(pm.starId);
    pm.mesh.isVisible = parent ? parent.isVisible : false;
  }
  // Bright-catalog cloud (floating origin via single mesh transform).
  // 109k vertices stored at absolute world coords; we shift the whole
  // mesh by -ship.position so the GPU sees camera-relative coords in
  // the vertex shader without per-vertex writes.
  if (brightCloud) {
    brightCloud.position.set(-ship.position.x, -ship.position.y, -ship.position.z);
  }

  // Near-field promotion: any HYG catalog star within NEAR_FIELD_LY of
  // the ship gets a full sphere mesh dynamically created/disposed by
  // updateNearbyStars(). Each frame we also set the camera-relative
  // position AND ramp the mesh's emissive opacity based on distance
  // — this is the inverse of the cloud point's smoothstep fade, so
  // the two crossfade smoothly through the FADE_NEAR..NEAR_FIELD_LY
  // window (cloud 1→0, mesh 0→1). Without the ramp the mesh "pops in"
  // at the inner edge at its 4-px-floor projected size.
  updateNearbyStars(brightCatalog);
  for (const [id, mesh] of nearbyStarMeshes) {
    const e = hygStarById.get(id);
    if (!e) continue;
    setRenderSpace(mesh, e[1], e[2], e[3]);
    const dx = e[1] - ship.position.x;
    const dy = e[2] - ship.position.y;
    const dz = e[3] - ship.position.z;
    const dist = Math.hypot(dx, dy, dz);
    // Mesh fade-in window MESH_FADE_NEAR..MESH_FADE_FAR. Tight on
    // purpose — the cloud is doing its long fade-out separately.
    let t = (dist - MESH_FADE_NEAR_LY) / (MESH_FADE_FAR_LY - MESH_FADE_NEAR_LY);
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const distOpacity = 1 - (t * t * (3 - 2 * t));
    const md = mesh.metadata as { spectralColor?: [number, number, number]; magIntensity?: number } | undefined;
    const sc = md?.spectralColor;
    const magI = md?.magIntensity ?? 1;
    if (sc && mesh.material instanceof StandardMaterial) {
      // Final emissive = spectral × magnitude × distance-fade. The
      // magnitude factor matches the cloud point's brightness curve
      // so the handoff at MESH_FADE_NEAR has no brightness jump.
      const k = distOpacity * magI;
      mesh.material.emissiveColor.set(sc[0] * k, sc[1] * k, sc[2] * k);
    }
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
    // Light position is also camera-relative (the lighting shader
    // reads positions in scene/world space, which under floating
    // origin = camera-relative space).
    const lp = toRenderSpace(closestStar.position);
    systemLight.position.copyFrom(lp);
    const intensity = Math.min(
      8.0,
      (BRAKE_RANGE_LY / Math.max(closestDist, SOL_RADIUS_LY * 200)) * 4,
    );
    systemLight.intensity = intensity;
  } else {
    systemLight.intensity = 0;
  }

  // Auto-observe: first time we cross into the 100 AU brake range
  // around any star, fire the Mind's narration. The `observed` set
  // dedups so wandering around the same system doesn't re-trigger
  // the same dossier. This is the bridge between "ship moved here"
  // and "Mind reacts to where the ship is" — without it the Mind is
  // mute unless the player manually calls the observe MCP tool.
  //
  // Was dropped during the Babylon migration (the `observed` set
  // was kept as a stub but never populated/checked). Restoring
  // parity with the Three-port behavior.
  if (
    closestStar &&
    closestDist < BRAKE_RANGE_LY &&
    !observed.has(closestStar.id) &&
    gameId &&
    playerId
  ) {
    observed.add(closestStar.id);
    void callTool(pane.app, "observe", { gameId, playerId, objectId: closestStar.id });
  }

  // Camera: floating-origin. The camera always sits at scene-origin
  // (0,0,0); everything else is positioned camera-relative this tick
  // (see star/planet/ship-sprite/light updates above). ship.position
  // remains the absolute world coord on the CPU for game logic. The
  // camera target is the forward unit-direction — since camera is at
  // (0,0,0) that's equivalent to "look along fwd".
  camera.position.set(0, 0, 0);
  camera.setTarget(fwd);

  // Warp shimmer overlay
  // Warp overlay opacity fades in linearly from warp 1 to warp 9 so
  // there's a visible transition the whole time you're in warp,
  // not a sudden on at warp 7. Below warp 1 (impulse) the overlay
  // is invisible. Computed from current speed via the warp-factor
  // formula in star-sim/format.ts.
  if (warpOverlayEl) {
    const lyPerS = Math.pow(ship.throttle, 3) * WARP_MAX_LY_PER_S;
    const warpFactor = lyPerS >= 0.005 ? 1 + 2.22 * Math.log10(lyPerS / 0.005) : 0;
    // Map warp [1..9] → opacity [0..1]; cap at 9.
    const opacity = Math.max(0, Math.min(1, (warpFactor - 1) / 8));
    warpOverlayEl.style.opacity = opacity.toFixed(3);
  }

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
  // Pad bearing (0–359) and elev (−90..+90) to three glyphs each so
  // the readout has a stable width. Without this, the throttle slider
  // (flex:1) would resize as numbers grow/shrink. Using NBSP ( )
  // so the spaces aren't collapsed by HTML whitespace rules.
  const bearingStr = String(Math.round(bearingDeg)).padStart(3, " ");
  const elevStr = String(Math.round(elevDeg)).padStart(3, " ");
  headingReadout.textContent = `${bearingStr}° / ${elevStr}°`;
  // Distance "from Sol" — Sol is at origin in our coord system.
  const distFromSol = Math.hypot(ship.position.x, ship.position.y, ship.position.z);
  hudDistance.textContent = formatDistanceShort(distFromSol);
  // "at <closest star>" if within brake range, else "in transit".
  hudPos.textContent = "—";
  hudTarget.textContent = ship.targetId ? `target: ${ship.targetId}` : "no target";
  // STOP button enable: any forward motion (warp or impulse > 0.001).
  // Grayed at a standstill — see target-info-main.ts for the same rule.
  hudStopBtn.disabled = !ship.warpEngaged && ship.throttle <= 0.001;
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
  // Floating-origin: every render-space coord is camera-relative
  // (camera sits at scene-origin). tgt.pos is the target's TRUE
  // world coord; convert to camera-relative for the projection.
  const tgtRel = toRenderSpace(tgt.pos);
  const camFwd = camera.getDirection(new Vector3(0, 0, -1)); // right-handed forward = -Z
  if (Vector3.Dot(tgtRel, camFwd) <= 0) {
    if (targetReticle.classList.contains("visible")) {
      targetReticle.classList.remove("visible");
    }
    return;
  }
  // Project world → NDC → pixels via Babylon's projection.
  // Vector3.Project(point, worldMatrix, transformMatrix, viewport):
  //   worldMatrix = identity (the point is already in world coords)
  //   transformMatrix = scene's view × projection
  // We pass the camera-relative target so the projection matches the
  // rest of the scene (everything else also at camera-relative coords).
  const w = engine.getRenderWidth();
  const h = engine.getRenderHeight();
  const projected = Vector3.Project(
    tgtRel,
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
    const distHtml = formatDistanceShort(tgtRel.length());
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
      // Don't snap — set a face-lerp target and let tick() swing the
      // camera there smoothly. The previous instant rotation was
      // jarring at any non-trivial angular delta.
      faceLerpTarget = {
        yaw: wantYaw,
        pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, wantPitch)),
      };
      userHasInteracted = true;
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
