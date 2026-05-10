/**
 * Cockpit pane — Three.js starfield, throttle, warp/impulse drive.
 *
 * Multiplayer-aware: extracts `gameId` + `playerId` from the initial tool
 * result, threads both through every subsequent server call. Shows the
 * current Culture ship name + Mind in the top strip. Renders other
 * players' ships as small markers when they're inside the visible volume,
 * and renders Orbitals as ring sprites.
 */
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

import { callTool, poll, setupPaneApp } from "./shared.js";

type PlanetLite = {
  name: string;
  kind: string;            // PlanetKind: terrestrial / super_earth / neptune_like / ice_giant / gas_giant / hot_jupiter / super_jupiter
  orbitAU?: number;
  massEarths?: number;
};
type StarLite = {
  id: string; name: string; position: [number, number, number];
  spectralClass: string; spectralType: string; lumClass: string;
  distanceLy: number; hasPlanets: boolean;
  radiusSolar?: number;        // for proper-scale sphere rendering at close range
  absMag?: number;             // M_V; used to size sprite halo by observed magnitude
  planetCount?: number;        // shown in nearest list when > 0
  planets?: PlanetLite[];      // populated when the star has known planets
};

// Unit conversions used everywhere in the cockpit.
const LY_PER_AU = 1 / 63241.077;     // 1 ly = 63241 AU
const SOL_RADIUS_AU = 0.00465047;    // R☉ in AU
const SOL_RADIUS_LY = SOL_RADIUS_AU * LY_PER_AU;
const EARTH_RADIUS_AU = 4.26e-5;     // R⊕ in AU
const EARTH_RADIUS_LY = EARTH_RADIUS_AU * LY_PER_AU;

// Planet rendering uses a "demo cheat" multiplier so they're visible at
// AU distances. At true scale, Earth from 1 AU subtends 17 arcsec — way
// below human visual resolution, never visible. 200× makes Earth ~1° at
// 1 AU, big enough to see and recognize without dominating the system.
const PLANET_VISUAL_SCALE = 200;

const PLANET_RADIUS_R_EARTH: Record<string, number> = {
  terrestrial: 0.9,
  super_earth: 1.5,
  neptune_like: 3.5,
  ice_giant: 4.0,
  gas_giant: 11.0,
  hot_jupiter: 12.0,
  super_jupiter: 18.0,
};
const PLANET_COLOR: Record<string, number> = {
  terrestrial:   0x6ba2e0,  // blue (Earth-ish)
  super_earth:   0xa3743f,  // rust
  neptune_like:  0x4a7eb8,  // muted blue
  ice_giant:     0x88d4ee,  // pale cyan
  gas_giant:     0xd9a36b,  // tan (Jupiter-ish)
  hot_jupiter:   0xe07b3a,  // bright orange
  super_jupiter: 0x9c3e2e,  // deep red
};

// In-system gameplay range. Within this distance of any star, the
// cockpit auto-throttles to a sub-warp speed so you can actually see
// the system instead of zooming through it. The systemLight, planet
// visibility, and auto-observe trigger off this same threshold.
const BRAKE_RANGE_AU = 100;
const BRAKE_RANGE_LY = BRAKE_RANGE_AU * LY_PER_AU;

/** Top warp speed in light-years per second.
 *  speed = throttle³ × WARP_MAX_LY_PER_S, so the slider's lower 60% is
 *  sub-light / low-warp (precise approaches) and the top spans warps 4–9.
 *  Picked so an 800-ly trip (Rigel) lands in ~45 s at full throttle. */
const WARP_MAX_LY_PER_S = 20;
// Wider band where the closest star is rendered as a real sphere
// (closeStarMesh) with min-pixel clamp instead of the sprite. Closes
// the visible gap between "tiny far sprite" and "in-system planets+
// sphere" — the sphere shows as a small bright dot at this range and
// grows smoothly with proximity.
const CLOSE_MESH_RANGE_LY = 0.1;

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
const nearestList = document.getElementById("nearest-list") as HTMLOListElement;
const nearestPlanetList = document.getElementById("nearest-planet-list") as HTMLOListElement;
const localPlanetsList = document.getElementById("local-planets-list") as HTMLOListElement;
const localPlanetsHeader = document.getElementById("local-planets-header") as HTMLElement;
const targetTag = document.getElementById("target-tag") as HTMLElement;
const warpOverlayEl = document.getElementById("warp-overlay") as HTMLElement | null;
const debugLogEl = document.getElementById("debug-log") as HTMLElement | null;

// Visible-on-screen event log + server-side disk log via the debug_log
// MCP tool. The disk log is the more reliable channel — it bypasses
// Goose Desktop's nested DevTools entirely and can be tailed by anyone
// on the host machine (`tail -f /tmp/cockpit-debug.log`).
function dbg(msg: string, kind: "info" | "warn" = "info") {
  // 1) DevTools console (if it's even open and on the right context).
  // eslint-disable-next-line no-console
  (kind === "warn" ? console.warn : console.log)("[cockpit]", msg);
  // 2) On-screen overlay.
  if (debugLogEl) {
    const row = document.createElement("div");
    row.className = `row ${kind}`;
    const t = new Date();
    const ts = `${t.getMinutes().toString().padStart(2, "0")}:${t.getSeconds().toString().padStart(2, "0")}.${t.getMilliseconds().toString().padStart(3, "0")}`;
    row.textContent = `${ts}  ${msg}`;
    debugLogEl.appendChild(row);
    while (debugLogEl.children.length > 30) debugLogEl.removeChild(debugLogEl.firstChild!);
    debugLogEl.scrollTop = debugLogEl.scrollHeight;
  }
  // 3) Server-side append. Fire-and-forget; never blocks the UI.
  void pane.app
    .callServerTool({ name: "debug_log", arguments: { msg, kind, from: "cockpit" } })
    .catch(() => {});
}

// Press ` (backtick) to toggle the on-screen debug overlay.
window.addEventListener("keydown", (e) => {
  if (e.key === "`") debugLogEl?.classList.toggle("hidden");
});

const pane = setupPaneApp("Culture Cockpit");
let gameId = "";
let playerId = "";
let stars: StarLite[] = [];
const observed = new Set<string>();

// --- scene setup ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x040814);
scene.fog = new THREE.FogExp2(0x040814, 0.0005);
// Near plane is the smallest world distance we want to render. Planets
// at sub-AU distances need it tiny (1e-7 ly ≈ 6 light-minutes); the old
// 0.001 ly (= 63 AU) was clipping everything in-system. Spanning 1e-7
// → 5000 ly is a 5×10^10 ratio, way past 32-bit depth precision, so we
// pair it with a logarithmic depth buffer.
const camera = new THREE.PerspectiveCamera(70, 1, 1e-7, 5000);
camera.position.set(0, 0, 0);
// `logarithmicDepthBuffer` is required to render the 1e-7 near plane
// alongside the 5000 ly far plane (5×10^10 ratio, way past 32-bit
// depth precision). ACES tone mapping + sRGB output works with the
// bloom pass; OutputPass is intentionally absent because combining it
// with renderer.toneMapping double-applies the operator.
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  logarithmicDepthBuffer: true,
});
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

// Postprocessing: just the bloom pass on top of the rendered scene.
// Skipping OutputPass on purpose — combining it with renderer.toneMapping
// double-applies the operator and creates the saturated horizontal smear.
// Bloom math runs on tone-mapped pixels here (not strictly HDR) but for
// our content (a few bright sprites against black) it reads correctly.
const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(1, 1),  // resized in resize()
  0.30,   // strength (was 0.55 — cuts the smear that turned 1-10ly stars into white discs)
  0.20,   // radius   (was 0.35 — kernel can no longer reach 35% of viewport)
  0.85,   // threshold (was 0.7 — only the very brightest pixels contribute to bloom)
);
composer.addPass(bloomPass);

// Stars are rendered as three additive layers per body:
//   `coreLayer`  — small bright disc (procedural radial gradient texture).
//                  Sized by max(physical, minPx) so it stays visible far
//                  away and blooms physically when close. Picker still
//                  raycasts against this group (kept as `warpStars`).
//   `haloLayer`  — soft Gaussian halo, tinted by spectral colour, additive.
//                  Sized as a multiple of the core in world units, so it
//                  shrinks naturally with distance ⇒ free LOD: a halo at
//                  40 ly is sub-pixel and costs nothing in fillrate.
//   `spikeLayer` — 4-point diffraction cross, fixed pixel size (lens
//                  artifact, not a physical thing). Faded when the core
//                  has bloomed past a few pixels — so it pops on distant
//                  pinprick stars and politely steps out of the way up
//                  close where the halo carries the look.
const warpStars = new THREE.Group();        // core layer (also the picker target)
const haloLayer = new THREE.Group();
const spikeLayer = new THREE.Group();
scene.add(warpStars);
scene.add(haloLayer);
scene.add(spikeLayer);
// Orbital LOD layers — distant icon (sprite) and closeup habitat (real
// ring geometry). The icon's per-frame scale uses the same min-pixel
// floor as stars so a distant orbital reads as a glowing ring even
// from across the galaxy. The closeup geometry only swaps in within
// ORBITAL_CLOSEUP_RANGE_LY of the camera; outside that range the
// expensive geometry is hidden, the cheap sprite carries the look.
const orbitalIconLayer = new THREE.Group();    // distant LOD: additive sprites
const orbitalHabitatLayer = new THREE.Group(); // closeup LOD: real ring geometry
scene.add(orbitalIconLayer);
scene.add(orbitalHabitatLayer);
const ORBITAL_CLOSEUP_RANGE_LY = BRAKE_RANGE_LY * 2;
const ORBITAL_DOCK_RANGE_LY = 0.5 * LY_PER_AU;  // mirror of server DOCK_RANGE_LY
const otherShipsGroup = new THREE.Group();
scene.add(otherShipsGroup);

// One reusable sphere mesh for whichever star you're closest to. Hidden
// when no star is within BRAKE_RANGE; shown at proper physical scale
// (radius in light-years computed from R☉) when you're parked in a
// system. M dwarfs become tiny dots; supergiants fill the sky.
// MeshBasicMaterial = unlit / fully emissive — bloom turns it into a
// proper glowing photosphere.
const closeStarMesh = new THREE.Mesh(
  new THREE.SphereGeometry(1, 48, 32),
  new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }),
);
closeStarMesh.visible = false;
closeStarMesh.renderOrder = 5;
scene.add(closeStarMesh);

// One omni-light that follows whichever star you're parked next to.
// Cheaper than 21 PointLights affecting every fragment everywhere; the
// single light gets repositioned in tick(). decay=0 because our world is
// in light-years (1 AU = 1.58e-5 ly) and physical inverse-square would
// blow up at sub-AU distances.
const systemLight = new THREE.PointLight(0xffffff, 1.0, 0, 0);
systemLight.visible = false;
scene.add(systemLight);
// Faint ambient so the night side of planets isn't a void.
scene.add(new THREE.AmbientLight(0xffffff, 0.06));

// ---- Procedural sprite textures (no asset files shipped) ---------------
function makeRadialTexture(stops: [number, number][], size = 128): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const r = size / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  for (const [pos, alpha] of stops) g.addColorStop(pos, `rgba(255,255,255,${alpha})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const CORE_TEX = makeRadialTexture(
  [[0, 1], [0.4, 0.95], [0.8, 0.5], [1, 0]],
  64,
);
// Halo: smooth rolloff to fully transparent well before the texture
// edge, so the square texture quad never registers as a faint box
// against black sky under additive blending.
const HALO_TEX = makeRadialTexture(
  [[0, 0.35], [0.08, 0.18], [0.25, 0.05], [0.5, 0.005], [0.7, 0]],
  256,
);
function makeSpikeTexture(size = 256): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.translate(size / 2, size / 2);
  const drawSpike = (rotDeg: number, length: number, thickness: number, peak: number) => {
    ctx.save();
    ctx.rotate((rotDeg * Math.PI) / 180);
    const g = ctx.createLinearGradient(0, -length, 0, length);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.48, `rgba(255,255,255,${peak * 0.6})`);
    g.addColorStop(0.5, `rgba(255,255,255,${peak})`);
    g.addColorStop(0.52, `rgba(255,255,255,${peak * 0.6})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(-thickness / 2, -length, thickness, length * 2);
    ctx.restore();
  };
  // Long primaries (vertical + horizontal); short secondaries (diagonals).
  drawSpike(0,  size / 2, 1.6, 0.95);
  drawSpike(90, size / 2, 1.6, 0.95);
  drawSpike(45, size / 3, 1.0, 0.45);
  drawSpike(-45, size / 3, 1.0, 0.45);
  // Hot pinprick at the center so the core never washes out.
  const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, size / 16);
  cg.addColorStop(0, "rgba(255,255,255,1)");
  cg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = cg;
  ctx.fillRect(-size / 16, -size / 16, size / 8, size / 8);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const SPIKE_TEX = makeSpikeTexture(256);

// Distant orbital icon — a thin glowing ring drawn into a square canvas.
// Additive blending makes it read as a halo against black sky, identical
// in spirit to the star halo but with an annular shape so the marker
// reads "ring habitat" even at one-pixel-wide.
function makeOrbitalIconTexture(size = 256): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.translate(size / 2, size / 2);
  // Outer glow halo
  const halo = ctx.createRadialGradient(0, 0, size * 0.18, 0, 0, size * 0.5);
  halo.addColorStop(0, "rgba(255,255,255,0.25)");
  halo.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = halo;
  ctx.fillRect(-size / 2, -size / 2, size, size);
  // Hollow ring
  ctx.lineWidth = size * 0.04;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.36, 0, Math.PI * 2);
  ctx.stroke();
  // Inner soft glow on the ring
  ctx.lineWidth = size * 0.10;
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.36, 0, Math.PI * 2);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const ORBITAL_ICON_TEX = makeOrbitalIconTexture(256);

// One planet mesh per known planet across the whole catalog. They're real
// world-space spheres at fixed physical radius (PLANET_VISUAL_SCALE × real),
// so apparent size scales with camera distance via perspective — no popping
// in at a brake threshold. Subpixel from light-years away, growing smoothly
// as you approach. Built lazily in buildStarMeshes().
const planetGeom = new THREE.SphereGeometry(1, 24, 16);
type PlanetMesh = {
  mesh: THREE.Mesh;
  starId: string;
  starName: string;
  planetName: string;
  planetKind: string;
  starPos: [number, number, number];
  orbitLy: number;
  phaseSeed: number;
  phaseSpeed: number;
  physicalR: number;     // real radius (with PLANET_VISUAL_SCALE) in ly
};
const planetMeshes: PlanetMesh[] = [];
function planetPhaseSeed(starId: string, planetName: string): number {
  let h = 0;
  const s = `${starId}::${planetName}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return ((Math.abs(h) % 10000) / 10000) * Math.PI * 2;
}

// Cosmetic name we keep so the picker code reads cleanly. The actual
// raycast happens against `warpStars` (bigger pickable area) regardless
// of which group is currently visible.
const starPoints = warpStars;

function spectralColor(cls: string, lum: string): number {
  if (cls === "WD") return 0xeaffff;
  if (cls === "NS") return 0x9999ff;
  if (lum === "Ia" || lum === "Iab" || lum === "Ib") {
    return cls === "M" || cls === "K" ? 0xff7f50 : 0x9bb8ff;
  }
  switch (cls) {
    case "O": return 0x9bb8ff;
    case "B": return 0xaecaff;
    case "A": return 0xffffff;
    case "F": return 0xfff4d6;
    case "G": return 0xfff099;
    case "K": return 0xffc06b;
    case "M": return 0xff8a4f;
    default: return 0xcccccc;
  }
}

// Map: starId → its three sprite layers, used in tick() to scale and
// fade them per-frame without a hash lookup per child. Cleared and
// rebuilt by buildStarMeshes().
type StarLayers = { core: THREE.Sprite; halo: THREE.Sprite; spike: THREE.Sprite };
const starLayers = new Map<string, StarLayers>();

function buildStarMeshes() {
  warpStars.clear();
  haloLayer.clear();
  spikeLayer.clear();
  starLayers.clear();
  for (const m of planetMeshes) scene.remove(m.mesh);
  planetMeshes.length = 0;

  for (const s of stars) {
    const color = spectralColor(s.spectralClass, s.lumClass);
    const isSupergiant = s.lumClass === "Ia" || s.lumClass === "Iab" || s.lumClass === "Ib";

    // Class-derived spike scale factor (lens-flare-ish artifact size,
    // independent of magnitude — varies because hot/blue stars look
    // pointier than cool/red ones in real photographs).
    const spikeScaleFactor = isSupergiant ? Math.sqrt(0.24 / 0.08)
                           : s.spectralClass === "B" ? Math.sqrt(0.16 / 0.08)
                           : s.spectralClass === "A" ? Math.sqrt(0.13 / 0.08)
                           : s.spectralClass === "F" ? Math.sqrt(0.10 / 0.08)
                           : 1.0;

    // Pre-fetch absMag (with class-fallback in case a server entry
    // somehow lacks it). Drives the per-frame pixel sizing so the
    // sprite halo is bounded by *observed magnitude*, not by scaling
    // a world-space radius — far-and-mid-range stars used to balloon
    // because the world-unit halo only shrank as 1/d while the close
    // mesh didn't take over until 0.1 ly.
    const fallbackAbsMag = isSupergiant ? -6
                         : s.spectralClass === "WD" ? 12
                         : s.spectralClass === "M"  ? 12
                         : s.spectralClass === "K"  ? 7
                         : s.spectralClass === "G"  ? 4.85
                         : s.spectralClass === "F"  ? 3.5
                         : s.spectralClass === "A"  ? 1.5
                         : s.spectralClass === "B"  ? -1
                         : 5;
    const absMag = s.absMag ?? fallbackAbsMag;

    // CORE — circular bright disc, additive. Pixel-stable
    // (sizeAttenuation:false) so a star never grows past its
    // magnitude-derived pixel size regardless of how close we get,
    // until closeStarMesh swaps in at 0.1 ly. White-tinted so bloom
    // reads "saturated highlight" regardless of spectral hue.
    const core = new THREE.Sprite(new THREE.SpriteMaterial({
      map: CORE_TEX,
      color: 0xffffff,
      sizeAttenuation: false,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    core.position.set(...s.position);
    core.userData = { star: s, absMag, spikeScaleFactor, isSupergiant };
    warpStars.add(core);

    // HALO — soft Gaussian, tinted by spectral colour. Pixel-stable
    // too; per-frame sizing reads observed magnitude and assigns
    // halo px = 3 × core px.
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: HALO_TEX,
      color,
      sizeAttenuation: false,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.7,
    }));
    halo.position.set(...s.position);
    halo.renderOrder = 2;
    haloLayer.add(halo);

    // SPIKE — diffraction cross. Fixed pixel size (sizeAttenuation:false)
    // so it reads as a lens artifact, not a physical body. Faded as the
    // core blooms past a few px; this is the visual that pops on far
    // pinprick stars. Slightly larger for hot/blue spectral classes.
    const spike = new THREE.Sprite(new THREE.SpriteMaterial({
      map: SPIKE_TEX,
      color: 0xffffff,
      sizeAttenuation: false,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.55,
    }));
    spike.position.set(...s.position);
    spike.renderOrder = 3;
    spikeLayer.add(spike);

    starLayers.set(s.id, { core, halo, spike });

    // One real sphere per known planet. MeshLambertMaterial so the
    // single roving systemLight gives a proper day/night terminator
    // when you're parked next to the parent star.
    for (const p of s.planets ?? []) {
      const r = (PLANET_RADIUS_R_EARTH[p.kind] ?? 1) * EARTH_RADIUS_LY * PLANET_VISUAL_SCALE;
      const mat = new THREE.MeshLambertMaterial({
        color: PLANET_COLOR[p.kind] ?? 0xaaaaaa,
        fog: false,
      });
      const mesh = new THREE.Mesh(planetGeom, mat);
      mesh.scale.setScalar(r);
      mesh.renderOrder = 4;
      mesh.visible = false;
      scene.add(mesh);
      const orbitAU = Math.max(0.005, p.orbitAU ?? 1);
      planetMeshes.push({
        mesh,
        starId: s.id,
        starName: s.name,
        planetName: p.name,
        planetKind: p.kind,
        starPos: s.position,
        orbitLy: orbitAU * LY_PER_AU,
        phaseSeed: planetPhaseSeed(s.id, p.name),
        // 0.05 / orbitAU rad/s ⇒ Earth ~2 minutes; capped so TRAPPIST-1's
        // hot rocks don't blur into rings.
        phaseSpeed: Math.min(0.5, 0.05 / orbitAU),
        physicalR: r,
      });
    }
  }
}

/** Format an interstellar distance with units that read sensibly across
 *  the ~10⁻⁶..10² ly range we'll encounter (parked-at-a-star → cross-galaxy). */
function formatDistance(ly: number): string {
  if (ly >= 0.1) return `${ly.toFixed(2)} ly`;
  if (ly >= 0.01) return `${ly.toFixed(3)} ly`;
  const au = ly / LY_PER_AU;
  if (au >= 100) return `${au.toFixed(0)} AU`;
  if (au >= 10) return `${au.toFixed(1)} AU`;
  if (au >= 0.1) return `${au.toFixed(2)} AU`;
  // Sub-AU: light-minutes (Sol's surface from Earth: 8.3 light-minutes).
  const lm = ly * 525949.2;
  return `${lm.toFixed(1)} l-min`;
}

/** Yaw/pitch deltas (radians) from the ship's current heading to a target. */
function headingTo(targetPos: [number, number, number], shipPos: THREE.Vector3): { yawDelta: number; pitchDelta: number; angle: number; targetYaw: number; targetPitch: number } {
  const dir = new THREE.Vector3(targetPos[0] - shipPos.x, targetPos[1] - shipPos.y, targetPos[2] - shipPos.z);
  const len = dir.length();
  if (len < 1e-6) return { yawDelta: 0, pitchDelta: 0, angle: 0, targetYaw: 0, targetPitch: 0 };
  dir.divideScalar(len);
  const targetYaw = Math.atan2(dir.x, -dir.z);
  const targetPitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
  return { yawDelta: 0, pitchDelta: 0, angle: 0, targetYaw, targetPitch };
}

/** Render an 8-way arrow + angle indicator from yaw/pitch deltas. */
function headingGlyph(yawDelta: number, pitchDelta: number, angleRad: number): string {
  const t = 0.087;  // ~5 degrees
  const lr = yawDelta > t ? "→" : yawDelta < -t ? "←" : "";
  const ud = pitchDelta > t ? "↑" : pitchDelta < -t ? "↓" : "";
  let arrow = "•";
  if (lr === "→" && ud === "↑") arrow = "↗";
  else if (lr === "→" && ud === "↓") arrow = "↘";
  else if (lr === "←" && ud === "↑") arrow = "↖";
  else if (lr === "←" && ud === "↓") arrow = "↙";
  else arrow = lr || ud || "•";
  const deg = (angleRad * 180) / Math.PI;
  return `${arrow} ${deg.toFixed(0)}°`;
}

function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// Orbital state mirrored from the server. Two parallel groupings:
//   - `orbitalLayers` is keyed by id and owns the THREE.Object3D handles
//     so per-frame updates don't hash-walk the scene graph.
//   - `currentOrbitals` is the flat array used by HUD / target lookup
//     code, mirroring the get_state shape.
type OrbitalLite = {
  id: string;
  name: string;
  builderShipName: string;
  position: [number, number, number];
  ringRadius: number;
  description?: string;
  dockedPlayerIds?: string[];
};
type OrbitalLayers = {
  icon: THREE.Sprite;          // distant LOD: additive ring sprite
  habitat: THREE.Group;        // closeup LOD: outer ring + spinning inner strip
  habitatInner: THREE.Mesh;    // the spinning emissive ring inside `habitat`
  data: OrbitalLite;
};
const orbitalLayers = new Map<string, OrbitalLayers>();
let currentOrbitals: OrbitalLite[] = [];

// Reused geometry for the closeup habitat ring. ringRadius is normalized
// to 1 here; the per-orbital scale on the Group sets the actual size in
// light-years from orbital.ringRadius.
const ORBITAL_OUTER_GEOM = new THREE.TorusGeometry(1.0, 0.02, 8, 96);
const ORBITAL_INNER_GEOM = new THREE.TorusGeometry(0.985, 0.012, 6, 96);

function syncOrbitals(orbitals: OrbitalLite[]) {
  currentOrbitals = orbitals;
  // Diff: build/keep/remove. Orbitals are immutable once built (the only
  // server-side mutation is dockedPlayerIds), so we just need to ensure
  // every server-known id has a matching layer set.
  const seen = new Set<string>();
  for (const o of orbitals) {
    seen.add(o.id);
    let layers = orbitalLayers.get(o.id);
    if (!layers) layers = createOrbitalLayers(o);
    layers.data = o;
    layers.icon.position.set(o.position[0], o.position[1], o.position[2]);
    layers.habitat.position.set(o.position[0], o.position[1], o.position[2]);
  }
  for (const [id, layers] of [...orbitalLayers]) {
    if (seen.has(id)) continue;
    orbitalIconLayer.remove(layers.icon);
    orbitalHabitatLayer.remove(layers.habitat);
    orbitalLayers.delete(id);
  }
}

function createOrbitalLayers(o: OrbitalLite): OrbitalLayers {
  // Distant icon — additive ring sprite tinted with a stable
  // builder-derived hue so different orbitals are visually distinct
  // without us needing per-orbital metadata.
  const tint = orbitalTint(o);
  const icon = new THREE.Sprite(new THREE.SpriteMaterial({
    map: ORBITAL_ICON_TEX,
    color: tint,
    sizeAttenuation: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0.9,
  }));
  icon.userData = { orbitalId: o.id };
  orbitalIconLayer.add(icon);

  // Closeup habitat — a Group so we can tilt the ring once and spin the
  // inner strip independently per-frame. Outer torus is structural
  // (white, low opacity); inner torus is emissive (tinted, additive)
  // and rotates around the ring's axis to show the orbital is rotating.
  const habitat = new THREE.Group();
  habitat.userData = { orbitalId: o.id };
  habitat.rotation.x = Math.PI / 2;        // ring lies in the XZ plane
  habitat.visible = false;                  // hidden until close enough

  const outer = new THREE.Mesh(
    ORBITAL_OUTER_GEOM,
    new THREE.MeshBasicMaterial({
      color: 0xc6d6e8,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      fog: false,
      depthWrite: false,
    }),
  );
  habitat.add(outer);

  const inner = new THREE.Mesh(
    ORBITAL_INNER_GEOM,
    new THREE.MeshBasicMaterial({
      color: tint,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      fog: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  habitat.add(inner);

  orbitalHabitatLayer.add(habitat);
  return { icon, habitat, habitatInner: inner, data: o };
}

/** Stable hue in (180°..300°) keyed off the orbital id, so multiple
 *  orbitals are visually distinguishable without per-orbital styling. */
function orbitalTint(o: OrbitalLite): number {
  let h = 0;
  for (let i = 0; i < o.id.length; i++) h = ((h << 5) - h + o.id.charCodeAt(i)) | 0;
  const hue = 180 + (Math.abs(h) % 120);    // teal → blue → violet range
  const c = new THREE.Color().setHSL(hue / 360, 0.55, 0.7);
  return c.getHex();
}

function syncOtherShips(others: any[]) {
  // Pixel-stable sprites: ~5 px on screen regardless of distance. The
  // earlier sizeAttenuation:true + 0.15 ly scale meant a swarm of dead
  // demo players (which accumulate per Liam's CLAUDE.md issue #4) would
  // fill the viewport with green when you flew anywhere near the spawn
  // point.
  otherShipsGroup.clear();
  for (const o of others) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      color: 0x88ffd9, sizeAttenuation: false, transparent: true, opacity: 0.9,
    }));
    sprite.scale.set(0.008, 0.008, 1);
    sprite.position.set(o.position[0], o.position[1], o.position[2]);
    otherShipsGroup.add(sprite);
  }
}

// --- state ---
const ship = {
  position: new THREE.Vector3(0, 0, 0),
  yaw: 0, pitch: 0,
  throttle: 0,
  hoveredId: null as string | null,
  targetId: null as string | null,
  warpEngaged: false,
};
let lastSyncedTargetId: string | null = null;
// Observe + autopilot-disengage fires when entering the brake range.
// Tightened from a wide 0.15 ly cordon to BRAKE_RANGE_AU (100 AU), so
// "arriving in a system" actually means you've reached planetary distances.
const OBSERVE_RANGE_LY = BRAKE_RANGE_LY;

/** Unified deceleration ladder used by BOTH autopilot's target throttle
 *  and the autobrake's cap, so a warp-into-system run is smooth whether
 *  the trip is autopilot-driven or you're aiming a star manually.
 *
 *  Budget: starting at 1 ly out, the throttles below land you at 1 AU
 *  in ~20 s under the cubic speed law (speed = throttle³ · 20 ly/s):
 *    1 ly → 100 AU :  5 s  @ 0.2 ly/s
 *    100 → 10 AU   :  5 s  through stepped cap (30 / 18 / 6 AU/s)
 *    10 → 1 AU     : 10 s  through stepped cap (2 / 0.6 AU/s)
 *
 *  Caps were derived as cbrt(au_per_sec / 63241 / WARP_MAX_LY_PER_S);
 *  re-derive if WARP_MAX_LY_PER_S ever changes. */
function speedCapThrottleByLy(distLy: number): number {
  if (distLy > 1.0) return 1.0;
  const distAu = distLy / LY_PER_AU;
  if (distAu > 100) return 0.215;   // 0.2 ly/s   (cruise→approach)
  if (distAu > 50)  return 0.0286;  // 30 AU/s
  if (distAu > 20)  return 0.0242;  // 18 AU/s
  if (distAu > 10)  return 0.0168;  // 6 AU/s
  if (distAu > 5)   return 0.0117;  // 2 AU/s
  if (distAu > 1)   return 0.00782; // 0.6 AU/s
  return 0.00684;                   // 0.4 AU/s near the photosphere
}

/** Autobrake cap by distance to the closest star, in AU. Outside the
 *  brake range (100 AU) full throttle is allowed; inside, the same
 *  ladder as autopilot so a cruise→approach is smooth and consistent. */
function maxImpulseThrottle(distAu: number): number {
  if (distAu > 100) return 1.0;
  return speedCapThrottleByLy(distAu * LY_PER_AU);
}

/** Autopilot's target throttle from distance-to-target. At cruise
 *  range (> 1 ly) we want full warp; closer in we share the brake's
 *  deceleration ladder so the smoothing converges to the right cap
 *  band without fighting the brake. */
function autopilotTargetThrottle(distLy: number): number {
  if (distLy > 1.0) return 0.95;
  return speedCapThrottleByLy(distLy);
}

/** Where the autopilot disengages and parks the ship. Was 100 AU which
 *  meant warp-to-system stopped at the edge of the cordon; the player
 *  then had to manually creep in for minutes to actually see anything.
 *  1 AU drops you at planetary range so the system is right there. */
const AUTOPILOT_ARRIVAL_LY = 1 * LY_PER_AU;

// User-driven "look at" target. When set, tick() slerps yaw/pitch toward it
// without changing position or throttle. Cleared by drag, by reaching it,
// or by engaging warp (which has its own auto-steer).
let aimTarget: { yaw: number; pitch: number } | null = null;
const AIM_SPEED = 4.5;       // rad/sec
const AIM_DONE_EPS = 0.01;   // ~0.6°

// --- input ---
let dragging = false;
let dragStart = { x: 0, y: 0 };
let dragMoved = false;
canvas.addEventListener("pointerdown", (e) => {
  dragging = true; dragStart = { x: e.clientX, y: e.clientY }; dragMoved = false;
  overlay.classList.add("hidden"); canvas.setPointerCapture(e.pointerId);
  aimTarget = null;  // user is taking manual control of the view
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const dx = e.clientX - dragStart.x;
  const dy = e.clientY - dragStart.y;
  if (Math.hypot(dx, dy) > 4) dragMoved = true;
  dragStart = { x: e.clientX, y: e.clientY };
  // "Drag the sky" / trackball-around-the-crosshair semantics: the bit of
  // sky under your cursor stays under your cursor while you drag. Both
  // axes consistent — drag right pulls the world right (camera turns
  // left); drag down pulls the world down (camera tilts up).
  ship.yaw   -= dx * 0.004;
  ship.pitch += dy * 0.004;
  ship.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, ship.pitch));
});
canvas.addEventListener("pointerup", (e) => {
  dragging = false;
  canvas.releasePointerCapture(e.pointerId);
  if (!dragMoved) pickStarUnderClick(e.clientX, e.clientY);
});

throttleEl.addEventListener("input", () => {
  ship.throttle = parseFloat(throttleEl.value);
  // User-driven throttle change cancels autopilot. Target stays selected
  // (HUD continues to show it); click the same star again to re-engage.
  if (ship.warpEngaged) ship.warpEngaged = false;
});
warpBtn.addEventListener("click", () => { if (ship.hoveredId) engageWarp(ship.hoveredId); });

// Pre-allocate the nearest-list rows ONCE. updateHud mutates these in
// place each frame instead of recreating the DOM — see the long story
// in the commit log; short version, stable rows = pointer events fire
// reliably + zero DOM churn at 60Hz.
const NEAREST_ROWS = 5;
const NEAREST_PLANET_ROWS = 5;
const LOCAL_PLANET_ROWS = 8;            // max for our biggest system (Sol/TRAPPIST-1)
function makePool(parent: HTMLOListElement, count: number, title: string): HTMLLIElement[] {
  const pool: HTMLLIElement[] = [];
  for (let i = 0; i < count; i++) {
    const li = document.createElement("li");
    li.style.cursor = "pointer";
    li.style.display = "none";
    li.title = title;
    parent.appendChild(li);
    pool.push(li);
  }
  return pool;
}
const nearestRowPool = makePool(nearestList, NEAREST_ROWS, "click to face this star");
const nearestPlanetRowPool = makePool(nearestPlanetList, NEAREST_PLANET_ROWS, "click to face this star");
const localPlanetRowPool = makePool(localPlanetsList, LOCAL_PLANET_ROWS, "click to face this planet");

// Live planet snapshot, rebuilt each tick when the ship is in-system.
// updateHud reads from this to populate the "Nearest planets" rows;
// the rendering loop in tick() also writes here so we don't recompute
// orbit positions twice per frame.
type LivePlanet = {
  id: string;                            // "starId::planetName"
  name: string;
  kind: string;
  starName: string;
  position: [number, number, number];    // world coords (ly)
  distFromShip: number;                  // ly
};
let currentPlanets: LivePlanet[] = [];

const r = nearestList?.getBoundingClientRect?.();
dbg(`nearestList found: ${!!nearestList}  rect: ${r?.width.toFixed(0)}x${r?.height.toFixed(0)} @ (${r?.x.toFixed(0)},${r?.y.toFixed(0)})  rows=${nearestRowPool.length}`);

// Delegated handler. Now that rows are stable, plain `click` works fine
// and is the right primitive for accessibility (Enter/Space on focus
// also fires click). pointerdown bubbles too if you prefer instant
// response — both are wired here.
/** Resolve a row's `data-aim-target` attribute to a world position and
 *  set aimTarget. Format: "star:<id>" or "planet:<starId>::<planetName>". */
function aimAtRowTarget(t: HTMLElement, kind: "click" | "pointerdown"): boolean {
  const li = t.closest("li[data-aim-target]") as HTMLElement | null;
  if (!li) return false;
  const tag = li.dataset.aimTarget;
  if (!tag) return false;
  let position: [number, number, number] | null = null;
  let label = tag;
  if (tag.startsWith("star:")) {
    const star = stars.find((s) => s.id === tag.slice(5));
    if (star) { position = star.position; label = star.name; }
  } else if (tag.startsWith("planet:")) {
    const p = currentPlanets.find((p) => p.id === tag.slice(7));
    if (p) { position = p.position; label = `${p.name} (${p.starName})`; }
  }
  if (!position) { dbg(`→ aim target ${tag} not resolvable`, "warn"); return false; }
  ship.warpEngaged = false;
  const { targetYaw, targetPitch } = headingTo(position, ship.position);
  aimTarget = { yaw: targetYaw, pitch: targetPitch };
  dbg(`(${kind}) aim → ${label}: yaw=${(targetYaw*180/Math.PI).toFixed(1)}° pitch=${(targetPitch*180/Math.PI).toFixed(1)}°`);
  return true;
}
// Delegate on the parent `.nearest` div so clicks on either <ol> work.
const nearestPanel = nearestList.parentElement!;
nearestPanel.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (aimAtRowTarget(t, "click")) e.stopPropagation();
});
nearestPanel.addEventListener("pointerdown", (e) => {
  const t = e.target as HTMLElement;
  if (aimAtRowTarget(t, "pointerdown")) {
    e.stopPropagation();
    e.preventDefault();
  }
});

// Capture-phase listener on document to detect clicks that never reached
// our delegated handler — e.g. blocked by another element or a parent
// that called stopPropagation.
document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t?.closest?.("#nearest-list")) {
    dbg(`document.click in #nearest-list (capture): <${t.tagName.toLowerCase()}>`);
  }
}, true);

// Pointerdown anywhere — helps reveal whether clicks on the list are
// being routed to the canvas instead of the list.
document.addEventListener("pointerdown", (e) => {
  const t = e.target as HTMLElement;
  if (t?.closest?.("#nearest-list")) {
    dbg(`document.pointerdown in #nearest-list: <${t.tagName.toLowerCase()}>`);
  } else if (t?.tagName === "CANVAS") {
    // suppress noisy canvas pointerdowns — we only care about routing weirdness
  }
}, true);

function pickStarUnderClick(clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);
  let bestId: string | null = null;
  let bestAngle = 0.04;
  for (const obj of starPoints.children) {
    if (!(obj instanceof THREE.Sprite)) continue;
    const v = obj.position.clone().sub(camera.position).normalize();
    const angle = v.angleTo(raycaster.ray.direction);
    if (angle < bestAngle) {
      bestAngle = angle;
      bestId = (obj.userData?.star as StarLite | undefined)?.id ?? null;
    }
  }
  // Orbital icons share the same pick test against the same angular
  // tolerance — pick whichever sprite is closest to the cursor ray, with
  // an `orbital:` prefix so engageWarp routes to warp_to_orbital.
  for (const sprite of orbitalIconLayer.children) {
    if (!(sprite instanceof THREE.Sprite)) continue;
    const v = sprite.position.clone().sub(camera.position).normalize();
    const angle = v.angleTo(raycaster.ray.direction);
    if (angle < bestAngle) {
      bestAngle = angle;
      const oid = (sprite.userData as { orbitalId?: string } | undefined)?.orbitalId;
      bestId = oid ? `orbital:${oid}` : null;
    }
  }
  if (bestId) engageWarp(bestId);
}

async function engageWarp(objectId: string) {
  if (!gameId || !playerId) return;
  ship.targetId = objectId;
  ship.warpEngaged = true;
  lastSyncedTargetId = objectId;
  if (objectId.startsWith("orbital:")) {
    const orbitalId = objectId.slice("orbital:".length);
    await callTool(pane.app, "warp_to_orbital", { gameId, playerId, orbitalId });
  } else {
    await callTool(pane.app, "warp_to", { gameId, playerId, objectId });
  }
}

/** Resolve a target id to a world position. Handles both star ids and
 *  the `orbital:<id>` namespace produced by warp_to_orbital. Returns
 *  null when the target is unknown locally (e.g. orbital still hasn't
 *  arrived in the get_state poll yet — callers should treat this as
 *  "wait for next tick"). */
function resolveTargetPosition(id: string | null): { pos: [number, number, number]; isOrbital: boolean; name: string } | null {
  if (!id) return null;
  if (id.startsWith("orbital:")) {
    const oid = id.slice("orbital:".length);
    const o = orbitalLayers.get(oid)?.data;
    if (!o) return null;
    return { pos: o.position, isOrbital: true, name: o.name };
  }
  const s = stars.find((s) => s.id === id);
  return s ? { pos: s.position, isOrbital: false, name: s.name } : null;
}

// Bright catalog backdrop. The server sends a packed array of
// [x, y, z, spectralClass, apparentMag] per star. We build ONE
// THREE.Points cloud for ~17k bright stars — single draw call, all
// per-frame work is on the GPU. The curated 21 stars (which get the
// rich layered-sprite + halo + spike treatment) are filtered out
// server-side so we don't double-render.
type BrightTuple = [number, number, number, string, number];
const brightStarsGroup = new THREE.Group();
scene.add(brightStarsGroup);

function buildBrightStars(bright: BrightTuple[]) {
  // Tear down any previous cloud (e.g. on a re-init).
  while (brightStarsGroup.children.length) {
    const c = brightStarsGroup.children[0];
    brightStarsGroup.remove(c);
    if ((c as THREE.Points).geometry) (c as THREE.Points).geometry.dispose();
  }
  if (!bright.length) return;

  const N = bright.length;
  const positions = new Float32Array(N * 3);
  const colors = new Float32Array(N * 3);
  const sizes = new Float32Array(N);
  const tmpColor = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const t = bright[i];
    positions[i * 3 + 0] = t[0];
    positions[i * 3 + 1] = t[1];
    positions[i * 3 + 2] = t[2];
    tmpColor.setHex(spectralColor(t[3], "V"));
    colors[i * 3 + 0] = tmpColor.r;
    colors[i * 3 + 1] = tmpColor.g;
    colors[i * 3 + 2] = tmpColor.b;
    // Pixel size by magnitude. Brighter = bigger; clamp so the brightest
    // landmarks (Sirius mag −1.5, Canopus −0.7) are still readable points
    // and the dimmest brights (mag ≤ 2.5) don't disappear.
    const mag = t[4];
    sizes[i] = Math.max(1.5, Math.min(5.5, 4.0 - mag * 0.8));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color",    new THREE.BufferAttribute(colors,    3));
  geometry.setAttribute("size",     new THREE.BufferAttribute(sizes,     1));

  // Custom shader: per-vertex point size, circular alpha falloff so the
  // GL_POINT square is invisible.
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    vertexShader: `
      attribute float size;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = size;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        vec2 uv = gl_PointCoord - vec2(0.5);
        float r = length(uv);
        if (r > 0.5) discard;
        float a = smoothstep(0.5, 0.0, r);
        gl_FragColor = vec4(vColor, a);
      }
    `,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;     // bounding sphere is meaningless across 1000s of ly
  brightStarsGroup.add(points);
}

// --- init ---
pane.initial.then((init) => {
  gameId = init.gameId;
  playerId = init.playerId;
  stars = init.stars || [];
  buildStarMeshes();
  if (init.bright && Array.isArray(init.bright)) buildBrightStars(init.bright as BrightTuple[]);
  if (init.llm) hudLlm.textContent = `${init.llm.online ? "" : "offline · "}${init.llm.provider}/${init.llm.model}`;
  if (init.ship && hudShip) hudShip.textContent = init.ship.name;
  if (init.ship && hudMind) hudMind.textContent = init.ship.class;
});

// --- main loop ---
let last = performance.now();
function tick() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const fwd = new THREE.Vector3(
    Math.cos(ship.pitch) * Math.sin(ship.yaw),
    Math.sin(ship.pitch),
    -Math.cos(ship.pitch) * Math.cos(ship.yaw),
  );

  if (ship.warpEngaged && ship.targetId) {
    const target = resolveTargetPosition(ship.targetId);
    if (target) {
      const targetPos = new THREE.Vector3(...target.pos);
      const dir = targetPos.clone().sub(ship.position);
      const dist = dir.length();
      dir.normalize();
      const blend = Math.min(1, dt * 3);
      const newFwd = fwd.lerp(dir, blend).normalize();
      ship.yaw   = Math.atan2(newFwd.x, -newFwd.z);
      ship.pitch = Math.asin(Math.max(-1, Math.min(1, newFwd.y)));
      // Orbitals get a much tighter arrival distance than star systems —
      // the dock_orbital tool requires being within ~0.5 AU. For stars
      // we use AUTOPILOT_ARRIVAL_LY (1 AU) so the trip ends at planetary
      // range, not at the 100-AU edge of the brake cordon (which used
      // to leave the player a tedious manual creep-in away from
      // anything visible).
      const arrivalRange = target.isOrbital ? ORBITAL_DOCK_RANGE_LY : AUTOPILOT_ARRIVAL_LY;
      const targetThrottle = autopilotTargetThrottle(dist);
      ship.throttle = ship.throttle * 0.85 + targetThrottle * 0.15;
      throttleEl.value = ship.throttle.toString();
      if (dist <= arrivalRange) {
        ship.warpEngaged = false;
        ship.throttle = 0;
        throttleEl.value = "0";
        if (target.isOrbital) {
          // Auto-dock on arrival. Server is the source of truth — it
          // re-checks the range and sets player.dockedOrbitalId, which
          // the bridge pane reads to render the description card.
          if (gameId && playerId && ship.targetId) {
            const oid = ship.targetId.slice("orbital:".length);
            void callTool(pane.app, "dock_orbital", { gameId, playerId, orbitalId: oid });
          }
        } else if (!observed.has(ship.targetId)) {
          observed.add(ship.targetId);
          if (gameId && playerId) {
            void callTool(pane.app, "observe", { gameId, playerId, objectId: ship.targetId });
          }
        }
      }
    }
  }

  // User clicked a star in the nearest list — smoothly rotate to face it.
  // (Skipped while warp autopilot is steering; warp wins.)
  if (aimTarget && !ship.warpEngaged) {
    const yawDelta = normalizeAngle(aimTarget.yaw - ship.yaw);
    const pitchDelta = aimTarget.pitch - ship.pitch;
    if (Math.abs(yawDelta) < AIM_DONE_EPS && Math.abs(pitchDelta) < AIM_DONE_EPS) {
      ship.yaw = aimTarget.yaw;
      ship.pitch = aimTarget.pitch;
      aimTarget = null;
    } else {
      const step = AIM_SPEED * dt;
      ship.yaw += Math.sign(yawDelta) * Math.min(Math.abs(yawDelta), step);
      ship.pitch += Math.sign(pitchDelta) * Math.min(Math.abs(pitchDelta), step);
      ship.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, ship.pitch));
    }
  }

  // ---- In-system effects ----
  // Find the closest-point-of-approach (CPA) distance to each star
  // along the upcoming frame's straight-line segment. At max warp
  // (20 ly/s) we cover ~20 000 AU per frame, so endpoint sampling
  // (dNow / dNext) misses stars whose closest approach lies in the
  // segment interior. CPA is exact for linear motion within a frame.
  //
  // Bonus: when we DO trip the brake at high warp we know where on the
  // segment the star sits, so we can snap ship.position to the
  // brake-range entry point instead of stopping 12 000 AU short of
  // the system the player was trying to reach.
  const speedNow = Math.pow(ship.throttle, 3) * WARP_MAX_LY_PER_S;
  const segLen = speedNow * dt;
  const vSeg = fwd.clone().multiplyScalar(segLen);  // p_next = p_now + vSeg
  const vSegLenSq = vSeg.lengthSq();
  let closest: { star: StarLite; dist: number; tCpa: number } | null = null;
  for (const s of stars) {
    const sx = s.position[0] - ship.position.x;
    const sy = s.position[1] - ship.position.y;
    const sz = s.position[2] - ship.position.z;
    const dNow = Math.hypot(sx, sy, sz);
    let dCpa = dNow;
    let tCpa = 0;
    if (vSegLenSq > 1e-30) {
      // Project (star − p_now) onto vSeg, clamped to [0,1] to stay in segment.
      const tRaw = (sx * vSeg.x + sy * vSeg.y + sz * vSeg.z) / vSegLenSq;
      tCpa = Math.max(0, Math.min(1, tRaw));
      const cx = sx - tCpa * vSeg.x;
      const cy = sy - tCpa * vSeg.y;
      const cz = sz - tCpa * vSeg.z;
      dCpa = Math.hypot(cx, cy, cz);
    }
    if (closest === null || dCpa < closest.dist) closest = { star: s, dist: dCpa, tCpa };
  }

  // Update every planet's world position from its orbital phase. Hide
  // planets whose star is far enough that the planet would subtend less
  // than ~0.3 px — saves draw calls for the ~25 planets in the catalog.
  const tNow = performance.now() / 1000;
  const canvasH = canvas.clientHeight || 600;
  // Geometry helpers — minimum world-space radius that subtends N px at
  // a given distance, given the 70° vertical FOV (tan(35°) ≈ 0.7). Used
  // by planet visibility culling and the close-mesh sphere min-radius.
  const minRadiusForPx = (px: number, d: number) => (px * d * 0.7 * 2) / canvasH;
  const minVisibleRadiusAt = (d: number) => minRadiusForPx(0.3, d);

  // Magnitude-driven pixel-stable star sizing.
  //
  // For each star we compute observed apparent magnitude given current
  // distance: m = M + 5·log10(d_pc / 10), where M is the star's
  // absolute magnitude (real values from astrodata for the curated 21).
  //
  // Pixel mapping calibration:
  //   m =  0   (Vega from Earth)             →  corePx ≈ 8,  haloPx ≈ 24
  //   m = -5   (Venus-bright)                →  corePx ≈ 13, haloPx ≈ 39
  //   m = -10  (closer than 0.5 ly to Sol)   →  corePx ≈ 18, haloPx ≈ 54
  //   m = -16+ (saturating; close-mesh time) →  corePx capped at 20
  //   m = +5   (dim naked-eye)               →  corePx ≈ 3,  haloPx ≈ 9
  //   m > +12  (below detection)             →  hidden entirely
  //
  // This bounds the apparent size of every star at every distance until
  // closeStarMesh takes over at CLOSE_MESH_RANGE_LY (0.1 ly). Replaces
  // the old world-unit halo (which scaled as 1/d and had to be capped
  // by hand at every range — caps were the source of "Sol fills the
  // viewport at 3.54 ly").
  const PC_PER_LY = 1 / 3.2615637967;
  const CORE_PX_MIN = 0.6;
  const CORE_PX_MAX = 20;
  const HALO_PX_RATIO = 3.0;
  const HIDE_MAG = 12;
  const SPIKE_BASE_PX = 28;
  // Manual behind-camera cull. With sizeAttenuation:false sprites,
  // Three.js doesn't reliably cull sprites whose world position is
  // behind the camera — the projected `w` goes negative and the sprite
  // can render at a screen-space-flipped location, producing a giant
  // mirrored ghost of e.g. the star you're parked next to. We need to
  // explicitly hide any sprite whose star is outside the front
  // hemisphere. The 0.05 dot threshold (~87°) keeps stars visible
  // right up to the frustum's right/left edges (~60° at typical
  // aspect ratios) while culling everything farther back.
  const FRONT_HEMISPHERE_DOT = 0.05;
  for (const layers of starLayers.values()) {
    const ud = layers.core.userData as { absMag: number; spikeScaleFactor: number };
    const sx = layers.core.position.x - ship.position.x;
    const sy = layers.core.position.y - ship.position.y;
    const sz = layers.core.position.z - ship.position.z;
    const d = Math.max(1e-6, Math.hypot(sx, sy, sz));
    const dotFwd = (sx * fwd.x + sy * fwd.y + sz * fwd.z) / d;
    if (dotFwd < FRONT_HEMISPHERE_DOT) {
      if (layers.core.visible)  layers.core.visible  = false;
      if (layers.halo.visible)  layers.halo.visible  = false;
      if (layers.spike.visible) layers.spike.visible = false;
      continue;
    }
    const mObs = ud.absMag + 5 * Math.log10(d * PC_PER_LY / 10);

    if (mObs > HIDE_MAG) {
      if (layers.core.visible)  layers.core.visible  = false;
      if (layers.halo.visible)  layers.halo.visible  = false;
      if (layers.spike.visible) layers.spike.visible = false;
      continue;
    }
    if (!layers.core.visible)  layers.core.visible  = true;
    if (!layers.halo.visible)  layers.halo.visible  = true;
    if (!layers.spike.visible) layers.spike.visible = true;

    const corePx = Math.min(CORE_PX_MAX, Math.max(CORE_PX_MIN, 8 - mObs));
    const haloPx = corePx * HALO_PX_RATIO;
    const coreS = (corePx * 2) / canvasH;
    const haloS = (haloPx * 2) / canvasH;
    layers.core.scale.set(coreS, coreS, 1);
    layers.halo.scale.set(haloS, haloS, 1);

    const spikePx = SPIKE_BASE_PX * ud.spikeScaleFactor;
    const spikeS = (spikePx * 2) / canvasH;
    layers.spike.scale.set(spikeS, spikeS, 1);

    // Halo fades to zero past the core-cap so there's no "stuck giant
    // halo" once we cross into close-mesh territory; the closeStarMesh
    // sphere takes the visual lead. Below the cap the halo is at full
    // strength.
    const haloFade = Math.max(0, 1 - Math.max(0, corePx - 16) / 4);
    (layers.halo.material as THREE.SpriteMaterial).opacity = 0.7 * haloFade;
    // Spike (lens-cross artifact) fades the brighter the core gets —
    // point sources twinkle, resolved discs don't. At m ≈ 0 we're at
    // ~50% spike, at m ≈ -5 ~10%.
    const spikeFade = Math.max(0, 1 - Math.max(0, corePx - 4) / 8);
    (layers.spike.material as THREE.SpriteMaterial).opacity = 0.55 * spikeFade;
  }
  // Planet update + currentPlanets[] build for the nearest-planets list.
  // currentPlanets is populated only for planets orbiting the in-system
  // star (we don't want stars-down-the-galaxy planets cluttering the
  // panel). Min-pixel clamp on planet radius mirrors the close-star
  // logic — even Earth at 10 AU is sub-pixel without it.
  const inSystemStarId = closest && closest.dist < BRAKE_RANGE_LY ? closest.star.id : null;
  const MIN_PLANET_PX = 3;
  const live: LivePlanet[] = [];
  for (const pm of planetMeshes) {
    const phase = pm.phaseSeed + tNow * pm.phaseSpeed;
    const px = pm.starPos[0] + Math.cos(phase) * pm.orbitLy;
    const py = pm.starPos[1];
    const pz = pm.starPos[2] + Math.sin(phase) * pm.orbitLy;
    pm.mesh.position.set(px, py, pz);
    const dx = px - ship.position.x;
    const dy = py - ship.position.y;
    const dz = pz - ship.position.z;
    const dist = Math.hypot(dx, dy, dz);
    const minR = (MIN_PLANET_PX * dist * 1.4) / canvasH;
    const r = Math.max(pm.physicalR, minR);
    pm.mesh.scale.setScalar(r);
    pm.mesh.visible = r > minVisibleRadiusAt(dist);
    if (pm.starId === inSystemStarId) {
      live.push({
        id: `${pm.starId}::${pm.planetName}`,
        name: pm.planetName,
        kind: pm.planetKind,
        starName: pm.starName,
        position: [px, py, pz],
        distFromShip: dist,
      });
    }
  }
  currentPlanets = live;

  // closeStarMesh activates whenever the closest star is within
  // CLOSE_MESH_RANGE_LY (≈ 0.1 ly, much wider than BRAKE_RANGE_LY).
  // The min-pixel clamp keeps it visible as a tiny bright dot from far
  // and lets it grow smoothly as you approach — closes the visible gap
  // between the sprite and the in-system view.
  if (closest && closest.dist < CLOSE_MESH_RANGE_LY) {
    // Real radius for proper-scale rendering, BUT also clamp to a
    // minimum apparent size in pixels so M dwarfs / white dwarfs don't
    // become subpixel ghosts. Stellar/atlas apps do this to keep tiny
    // stars findable. Big stars (Betelgeuse) render at true scale
    // because true scale already exceeds the floor.
    const trueRadiusLy = (closest.star.radiusSolar ?? 1.0) * SOL_RADIUS_LY;
    const MIN_PX = 4;
    const minRadiusLy = minRadiusForPx(MIN_PX, closest.dist);
    const radiusLy = Math.max(trueRadiusLy, minRadiusLy);
    closeStarMesh.position.set(...closest.star.position);
    closeStarMesh.scale.setScalar(radiusLy);
    (closeStarMesh.material as THREE.MeshBasicMaterial).color.setHex(
      spectralColor(closest.star.spectralClass, closest.star.lumClass),
    );
    closeStarMesh.visible = closest.dist > trueRadiusLy;  // hide if camera is inside the star's actual photosphere
  } else {
    closeStarMesh.visible = false;
  }

  // Autobrake / observe-on-entry / planet visibility / systemLight stay
  // gated on the tighter BRAKE_RANGE_LY (≈ 100 AU) — those are gameplay
  // states, not visual ones (closeStarMesh is on its own wider range).
  //
  // Departure pass-through: if we're outside the inner ~10 AU AND clearly
  // heading away from the star (negative radial velocity, i.e. fwd dotted
  // with the unit vector toward the star is negative), don't brake. This
  // lets you ramp back to full warp the moment you've cleared the
  // planetary system, instead of crawling out to 100 AU at 0.1 c.
  // Inside the inner core we always brake regardless of direction —
  // planets live there and a misaimed yaw could drop you onto Earth.
  const INNER_AU = 10;
  const DEPARTING_DOT_THRESHOLD = -0.2;   // ~cos(101°): clearly off-axis from star
  if (closest && closest.dist < BRAKE_RANGE_LY) {
    const distAu = closest.dist / LY_PER_AU;
    const toStar = new THREE.Vector3(
      closest.star.position[0] - ship.position.x,
      closest.star.position[1] - ship.position.y,
      closest.star.position[2] - ship.position.z,
    );
    const toStarLen = toStar.length() || 1;
    const radialDot = (toStar.x * fwd.x + toStar.y * fwd.y + toStar.z * fwd.z) / toStarLen;
    const departing = radialDot < DEPARTING_DOT_THRESHOLD;
    const insideInner = distAu < INNER_AU;
    const shouldBrake = insideInner || !departing;
    if (shouldBrake) {
      // Autobrake — clamp throttle to a sub-warp value. SNAP rather
      // than smooth: the cubic speed law means a smoothed ramp takes
      // ~10 frames, during which we'd fly clean through the system at
      // high warp.
      //
      // Note: we deliberately DO NOT disengage warp here. Autopilot
      // shares this same speed-cap ladder via autopilotTargetThrottle,
      // so when the brake fires for the autopilot's target star they
      // agree on throttle and the autopilot rides smoothly all the way
      // down to AUTOPILOT_ARRIVAL_LY (1 AU). Autopilot is the thing
      // that finally clears warpEngaged; brake just bounds speed.
      const cap = maxImpulseThrottle(distAu);
      if (ship.throttle > cap) {
        const prev = ship.throttle;
        ship.throttle = cap;
        throttleEl.value = ship.throttle.toString();
        dbg(`[brake] ${closest.star.name}: dist=${distAu.toFixed(1)}AU throttle ${prev.toFixed(2)}→${cap.toFixed(3)}`);
      }
      // Snap-to-entry: if we entered brake range from outside DURING this
      // frame's segment (i.e. CPA happens at t > 0), warp the ship to
      // the brake-range entry point along its trajectory. Without this,
      // a Sol→Rigel run that grazes another star's brake range stops
      // 12 000+ AU short of where the brake would normally place us.
      const dxNow = closest.star.position[0] - ship.position.x;
      const dyNow = closest.star.position[1] - ship.position.y;
      const dzNow = closest.star.position[2] - ship.position.z;
      const dNow  = Math.hypot(dxNow, dyNow, dzNow);
      if (closest.tCpa > 0 && dNow > BRAKE_RANGE_LY && segLen > 0) {
        // Solve |s − t·vSeg|² = R² for the entry t (smaller root).
        const sDotV = dxNow * vSeg.x + dyNow * vSeg.y + dzNow * vSeg.z;
        const sLenSq = dxNow * dxNow + dyNow * dyNow + dzNow * dzNow;
        const a = vSegLenSq;
        const b = -2 * sDotV;
        const c = sLenSq - BRAKE_RANGE_LY * BRAKE_RANGE_LY;
        const disc = b * b - 4 * a * c;
        if (disc >= 0) {
          const tEntry = Math.max(0, Math.min(1, (-b - Math.sqrt(disc)) / (2 * a)));
          ship.position.addScaledVector(vSeg, tEntry);
          dbg(`[brake] snap to entry of ${closest.star.name} (t=${tEntry.toFixed(3)} of segment, ${(segLen * tEntry).toFixed(3)}ly)`);
        }
      }
    }
    // Auto-observe on first entry into a system (LLM Mind narrates).
    // Fires regardless of whether we braked — flying through a system
    // still counts as observing it.
    if (!observed.has(closest.star.id) && gameId && playerId) {
      observed.add(closest.star.id);
      void callTool(pane.app, "observe", { gameId, playerId, objectId: closest.star.id });
    }
  }

  // Hide the sprite of whichever star is being drawn as a sphere —
  // otherwise the sprite layers double-render on top of closeStarMesh.
  // Only sets hide=true for the close-mesh star; leaves everything else
  // alone so the per-frame sizing loop's visibility decisions
  // (behind-camera cull, magnitude HIDE_MAG threshold) survive.
  const inSphereHideId = closest && closest.dist < CLOSE_MESH_RANGE_LY ? closest.star.id : null;
  if (inSphereHideId) {
    const layers = starLayers.get(inSphereHideId);
    if (layers) {
      layers.core.visible = false;
      layers.halo.visible = false;
      layers.spike.visible = false;
    }
  }

  // System light follows the closest star (only when within BRAKE_RANGE).
  // Single roving PointLight is much cheaper than 21 statics, and it's
  // the only one that ever has anything to illuminate (planets are
  // hidden outside the system anyway). decay=0 because our world units
  // are light-years; a physical inverse-square would either explode at
  // sub-AU range or vanish at AU range.
  if (closest && closest.dist < BRAKE_RANGE_LY) {
    systemLight.position.set(...closest.star.position);
    systemLight.color.setHex(spectralColor(closest.star.spectralClass, closest.star.lumClass));
    // Scale intensity with R☉ so big stars actually feel hotter on planet
    // surfaces; cap so a Betelgeuse cameo doesn't oversaturate.
    const lum = Math.min(4, closest.star.radiusSolar ?? 1);
    systemLight.intensity = 1.4 * lum;
    systemLight.distance = BRAKE_RANGE_LY * 4;  // covers the full planet pool
    systemLight.visible = true;
  } else {
    systemLight.visible = false;
  }

  // Per-frame orbital LOD update — distant icon size + closeup habitat
  // visibility. Icon uses the same min-pixel floor + max-pixel cap as
  // star cores so it stays a readable point at any distance and never
  // balloons to a screen-spanning blob when you're parked AT the
  // orbital. The closeup ring geometry only swaps in within
  // ORBITAL_CLOSEUP_RANGE_LY of the camera, AND only when the camera
  // is OUTSIDE the ring — looking at a torus from inside its center
  // wraps the additive inner strip around the viewport and washes out.
  const ORBITAL_ICON_BASE = 0.0006;            // world units (ly)
  const ORBITAL_ICON_MIN_PX = 6;
  const ORBITAL_ICON_MAX_PX = 40;
  const spinRate = 0.4;                         // rad/sec on inner ring
  for (const layers of orbitalLayers.values()) {
    const o = layers.data;
    const dx = o.position[0] - ship.position.x;
    const dy = o.position[1] - ship.position.y;
    const dz = o.position[2] - ship.position.z;
    const d = Math.hypot(dx, dy, dz);
    const insideRing = d < o.ringRadius * 0.95;
    const showHabitat = d < ORBITAL_CLOSEUP_RANGE_LY && !insideRing;
    layers.habitat.visible = showHabitat;
    if (showHabitat) {
      // Scale the habitat group to the orbital's stored ringRadius (ly),
      // and cross-fade the icon out inside the closeup band so we don't
      // double-render. Spin the inner emissive strip on its axis.
      layers.habitat.scale.setScalar(o.ringRadius);
      layers.habitatInner.rotation.z += spinRate * dt;
      // Icon fades to 0 across the inner half of the closeup band — the
      // habitat geometry is now the dominant cue.
      const fadeIn = Math.min(1, (ORBITAL_CLOSEUP_RANGE_LY - d) / (ORBITAL_CLOSEUP_RANGE_LY * 0.5));
      (layers.icon.material as THREE.SpriteMaterial).opacity = 0.9 * (1 - fadeIn);
    } else {
      // Icon stays on. When the camera is inside the ring the habitat
      // is hidden, so the icon is the only "you are here" marker —
      // keep it visible at full opacity.
      (layers.icon.material as THREE.SpriteMaterial).opacity = 0.9;
    }
    // Icon scale: max(physical, min-pixel-floor) but capped to a hard
    // pixel ceiling. Without the cap, ORBITAL_ICON_BASE = 0.0006 ly at
    // 0.00001 ly distance is 60× viewport — bloom turns the frame to
    // flat white. Same pattern as the star CORE_MAX_PX.
    const minR = (ORBITAL_ICON_MIN_PX * d * 1.4) / canvasH;
    const maxR = (ORBITAL_ICON_MAX_PX * d * 1.4) / canvasH;
    const r = Math.min(maxR, Math.max(ORBITAL_ICON_BASE, minR));
    layers.icon.scale.set(r, r, 1);
  }

  const speed = Math.pow(ship.throttle, 3) * WARP_MAX_LY_PER_S;
  if (speed > 0) ship.position.addScaledVector(fwd, speed * dt);

  camera.position.copy(ship.position);
  camera.lookAt(ship.position.clone().add(fwd));

  // Warp overlay shimmer is purely cosmetic — no visual switch underneath.
  const inWarp = ship.warpEngaged || ship.throttle > 0.45;
  if (warpOverlayEl) warpOverlayEl.classList.toggle("active", inWarp);

  updateHud(fwd);
  composer.render();
  requestAnimationFrame(tick);
}

function updateHud(fwd: THREE.Vector3) {
  const speed = Math.pow(ship.throttle, 3) * WARP_MAX_LY_PER_S;
  // Display: log scale across the new ~0.005…20 ly/s range. Calibrated
  // so the impulse/warp boundary is at 0.005 ly/s (warp 1) and full
  // throttle reads warp 9. 2.22 ≈ 8 / log10(20/0.005).
  const fmt = (s: number) => {
    if (s < 0.005) return `impulse ${(s * 200).toFixed(2)}c`;
    const warp = Math.min(9, Math.max(1, 1 + 2.22 * Math.log10(s / 0.005)));
    return `warp ${Math.round(warp)}`;
  };
  speedReadout.textContent = fmt(speed);
  // Compass bearing (0–360°) + elevation (−90..+90°). Bearing is yaw
  // around our local "up" (+Y); 0° is the camera's initial direction
  // (looking down −Z), and increases as you yaw toward +X. Elevation
  // is pitch above/below the horizontal plane.
  const yawDeg = ((((ship.yaw * 180) / Math.PI) % 360) + 360) % 360;
  const pitchDeg = (ship.pitch * 180) / Math.PI;
  const elevSign = pitchDeg >= 0 ? "+" : "";
  headingReadout.textContent = `${yawDeg.toFixed(0).padStart(3, "0")}° / ${elevSign}${pitchDeg.toFixed(0)}° elev`;
  const dSol = ship.position.length();
  hudPos.textContent = dSol < 0.05 ? "at Sol" : `${dSol.toFixed(2)} ly from Sol`;

  const ranked = stars
    .map((s) => ({ star: s, dist: new THREE.Vector3(...s.position).distanceTo(ship.position) }))
    .filter((e) => e.dist > 1e-10)  // exclude only the degenerate self-distance case
    .sort((a, b) => a.dist - b.dist);

  // Reticle-based hover: pick whichever star is closest in angle, AND
  // separately whichever planet is closest in angle. The tooltip shows
  // the closer of the two. ship.hoveredId stays star-only — that's
  // what flows into engageWarp / sync_state and the server's warp_to
  // tool, which doesn't understand planet ids; warping is still on the
  // parent star.
  let hoveredStarId: string | null = null;
  let hoveredStarAngle = 0.06;
  for (const { star } of ranked.slice(0, 8)) {
    const v = new THREE.Vector3(...star.position).sub(ship.position).normalize();
    const angle = v.angleTo(fwd);
    if (angle < hoveredStarAngle) { hoveredStarAngle = angle; hoveredStarId = star.id; }
  }
  let hoveredPlanet: LivePlanet | null = null;
  let hoveredPlanetAngle = 0.06;
  for (const p of currentPlanets) {
    const v = new THREE.Vector3(...p.position).sub(ship.position).normalize();
    const angle = v.angleTo(fwd);
    if (angle < hoveredPlanetAngle) { hoveredPlanetAngle = angle; hoveredPlanet = p; }
  }
  ship.hoveredId = hoveredStarId;

  if (hoveredPlanet && hoveredPlanetAngle <= hoveredStarAngle) {
    const kindLabel = hoveredPlanet.kind.replace(/_/g, " ");
    targetTag.style.display = "";
    targetTag.textContent = `${hoveredPlanet.name} · ${kindLabel} · ${formatDistance(hoveredPlanet.distFromShip)} (orbits ${hoveredPlanet.starName})`;
  } else if (hoveredStarId) {
    const s = stars.find((s) => s.id === hoveredStarId)!;
    const d = new THREE.Vector3(...s.position).distanceTo(ship.position);
    targetTag.style.display = "";
    targetTag.textContent = `${s.name} · ${s.spectralType} · ${formatDistance(d)}`;
  } else {
    targetTag.style.display = "none";
  }
  const tgt = resolveTargetPosition(ship.targetId);
  hudTarget.textContent = ship.targetId
    ? `target: ${tgt?.name ?? "?"}${tgt?.isOrbital ? " ⟜" : ""} ${ship.warpEngaged ? "(warping)" : ""}`
    : "no target";
  if (tgt) {
    const d = new THREE.Vector3(...tgt.pos).distanceTo(ship.position);
    hudDistance.textContent = `${formatDistance(d)} to target`;
  } else {
    hudDistance.textContent = "—";
  }

  // Two stable row pools: top N nearest stars (any), and top N nearest
  // stars-with-planets. The two lists may overlap and that's fine — a
  // planet-bearing system shows up in both. Per-row mutation only.
  const renderRow = (
    li: HTMLLIElement,
    star: StarLite,
    dist: number,
    showPlanetCount: boolean,
  ) => {
    const { targetYaw, targetPitch } = headingTo(star.position, ship.position);
    const yawDelta = normalizeAngle(targetYaw - ship.yaw);
    const pitchDelta = targetPitch - ship.pitch;
    const dir = new THREE.Vector3(...star.position).sub(ship.position).normalize();
    const angleRad = Math.acos(Math.max(-1, Math.min(1, dir.dot(fwd))));
    const planetSuffix = showPlanetCount && star.planetCount
      ? `<span class="planets">🪐 ${star.planetCount}</span>`
      : "";
    const head = `${star.name} · ${formatDistance(dist)} · ${headingGlyph(yawDelta, pitchDelta, angleRad)}`;
    const html = planetSuffix ? `${head}${planetSuffix}` : head;
    if (li.innerHTML !== html) li.innerHTML = html;
    const aimTag = `star:${star.id}`;
    if (li.dataset.aimTarget !== aimTag) li.dataset.aimTarget = aimTag;
    const isTarget = star.id === ship.hoveredId;
    if (li.classList.contains("target") !== isTarget) li.classList.toggle("target", isTarget);
    if (li.style.display === "none") li.style.display = "";
  };

  const top = ranked.slice(0, NEAREST_ROWS);
  for (let i = 0; i < NEAREST_ROWS; i++) {
    const li = nearestRowPool[i];
    if (i >= top.length) {
      if (li.style.display !== "none") li.style.display = "none";
      continue;
    }
    renderRow(li, top[i].star, top[i].dist, true);
  }

  const planetRanked = ranked.filter((e) => (e.star.planetCount ?? 0) > 0).slice(0, NEAREST_PLANET_ROWS);
  for (let i = 0; i < NEAREST_PLANET_ROWS; i++) {
    const li = nearestPlanetRowPool[i];
    if (i >= planetRanked.length) {
      if (li.style.display !== "none") li.style.display = "none";
      continue;
    }
    renderRow(li, planetRanked[i].star, planetRanked[i].dist, true);
  }

  // ---- Nearest planets (in-system) ----------------------------------
  // Only visible when we're parked in a system that has known planets.
  // Each row carries data-aim-target="planet:starId::name" for click-to-face.
  const showLocal = currentPlanets.length > 0;
  if (showLocal !== (localPlanetsHeader.style.display !== "none")) {
    localPlanetsHeader.style.display = showLocal ? "" : "none";
    localPlanetsList.style.display = showLocal ? "" : "none";
  }
  if (showLocal) {
    const sorted = [...currentPlanets].sort((a, b) => a.distFromShip - b.distFromShip);
    for (let i = 0; i < LOCAL_PLANET_ROWS; i++) {
      const li = localPlanetRowPool[i];
      if (i >= sorted.length) {
        if (li.style.display !== "none") li.style.display = "none";
        continue;
      }
      const lp = sorted[i];
      const { targetYaw, targetPitch } = headingTo(lp.position, ship.position);
      const yawDelta = normalizeAngle(targetYaw - ship.yaw);
      const pitchDelta = targetPitch - ship.pitch;
      const dir = new THREE.Vector3(...lp.position).sub(ship.position).normalize();
      const angleRad = Math.acos(Math.max(-1, Math.min(1, dir.dot(fwd))));
      const kindShort = lp.kind.replace(/_/g, " ");
      const html = `${lp.name} · <span class="planets">${kindShort}</span> · ${formatDistance(lp.distFromShip)} · ${headingGlyph(yawDelta, pitchDelta, angleRad)}`;
      if (li.innerHTML !== html) li.innerHTML = html;
      const aimTag = `planet:${lp.id}`;
      if (li.dataset.aimTarget !== aimTag) li.dataset.aimTarget = aimTag;
      if (li.style.display === "none") li.style.display = "";
    }
  } else {
    for (const li of localPlanetRowPool) {
      if (li.style.display !== "none") li.style.display = "none";
    }
  }
}

function resize() {
  const r = canvas.parentElement!.getBoundingClientRect();
  const w = Math.max(1, Math.floor(r.width));
  const h = Math.max(1, Math.floor(r.height));
  const dpr = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  composer.setPixelRatio(dpr);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();
requestAnimationFrame(tick);

// --- server polling ---
poll(200, async () => {
  if (!gameId || !playerId) return;
  // targetId / warpEngaged are server-owned (only `warp_to` sets them).
  // Pushing them from here would clobber a captain's warp_to between the
  // server write and our next get_state read.
  await callTool(pane.app, "sync_state", {
    gameId, playerId,
    state: {
      position: [ship.position.x, ship.position.y, ship.position.z],
      heading: [Math.sin(ship.yaw), Math.sin(ship.pitch), -Math.cos(ship.yaw)],
      throttle: ship.throttle,
      hoveredId: ship.hoveredId,
    },
  });
  const state = await callTool<any>(pane.app, "get_state", { gameId, playerId });
  if (state?.targetId && state.targetId !== lastSyncedTargetId) {
    lastSyncedTargetId = state.targetId;
    ship.targetId = state.targetId;
    ship.warpEngaged = true;
  }
  if (state?.galaxy?.orbitals) syncOrbitals(state.galaxy.orbitals);
  if (state?.galaxy?.nearbyPlayers) syncOtherShips(state.galaxy.nearbyPlayers);
});
