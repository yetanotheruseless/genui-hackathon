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
// the system instead of zooming through it. The closest star also gets
// rendered as a real 3D sphere instead of a sprite.
const BRAKE_RANGE_AU = 100;
const BRAKE_RANGE_LY = BRAKE_RANGE_AU * LY_PER_AU;

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
const camera = new THREE.PerspectiveCamera(70, 1, 0.001, 5000);
camera.position.set(0, 0, 0);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });

// Two parallel star groups; only one is visible at a time.
//   `warpStars`    — current size-attenuated big sprites; visible when
//                    flying at warp speeds (target star grows naturally).
//   `impulseStars` — small fixed-pixel sprites; ~1-5 px on screen
//                    regardless of distance, so a system you're parked
//                    in doesn't wash out the viewport.
const warpStars = new THREE.Group();
const impulseStars = new THREE.Group();
const planetRings = new THREE.Group();   // shared between both modes
scene.add(warpStars);
scene.add(impulseStars);
scene.add(planetRings);
const orbitalGroup = new THREE.Group();
scene.add(orbitalGroup);
const otherShipsGroup = new THREE.Group();
scene.add(otherShipsGroup);

// One reusable sphere mesh for whichever star you're closest to. Hidden
// when no star is within BRAKE_RANGE; shown at proper physical scale
// (radius in light-years computed from R☉) when you're parked in a
// system. M dwarfs become tiny dots; supergiants fill the sky.
const closeStarMesh = new THREE.Mesh(
  new THREE.SphereGeometry(1, 48, 32),
  new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }),
);
closeStarMesh.visible = false;
closeStarMesh.renderOrder = 5;
scene.add(closeStarMesh);

// Planet mesh pool — sized for the largest catalog system (Sol, 8 planets;
// TRAPPIST-1 has 7). One geometry shared, one material per slot so we
// can recolor independently. Hidden when not in a system.
const PLANET_POOL_SIZE = 12;
const planetGeom = new THREE.SphereGeometry(1, 24, 16);
type PlanetSlot = { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial };
const planetPool: PlanetSlot[] = [];
for (let i = 0; i < PLANET_POOL_SIZE; i++) {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
  const mesh = new THREE.Mesh(planetGeom, mat);
  mesh.visible = false;
  mesh.renderOrder = 4;
  scene.add(mesh);
  planetPool.push({ mesh, mat });
}
function hidePlanetPool() {
  for (const slot of planetPool) if (slot.mesh.visible) slot.mesh.visible = false;
}
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

function buildStarMeshes() {
  warpStars.clear();
  impulseStars.clear();
  planetRings.clear();
  for (const s of stars) {
    const color = spectralColor(s.spectralClass, s.lumClass);
    const isSupergiant = s.lumClass === "Ia" || s.lumClass === "Iab" || s.lumClass === "Ib";

    // --- Warp-mode sprite: size in light-years, attenuates with distance.
    //     Same scale we shipped originally; gets big as you approach.
    const warpSize = isSupergiant ? 1.2
                   : s.spectralClass === "WD" ? 0.12
                   : s.spectralClass === "M"  ? 0.20
                   : s.spectralClass === "K"  ? 0.30
                   : s.spectralClass === "G"  ? 0.40
                   : s.spectralClass === "F"  ? 0.50
                   : s.spectralClass === "A"  ? 0.65
                   : s.spectralClass === "B"  ? 0.80
                   : 0.30;
    const warpSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      color, sizeAttenuation: true, transparent: true, opacity: 0.95,
    }));
    warpSprite.scale.set(warpSize, warpSize, 1);
    warpSprite.position.set(...s.position);
    warpSprite.userData = { star: s };
    warpStars.add(warpSprite);

    // --- Impulse-mode sprite: pixel-stable, sized by spectral class so
    //     supergiants stand out from M dwarfs in a starfield. Numbers
    //     are scale-units of `sizeAttenuation:false` sprites; with our
    //     ~70deg FOV and typical canvas size each unit ≈ 200-400 pixels,
    //     so values around 0.005-0.015 give 1-5 px stars.
    const impulseSize = isSupergiant ? 0.014
                      : s.spectralClass === "WD" ? 0.004
                      : s.spectralClass === "M"  ? 0.005
                      : s.spectralClass === "K"  ? 0.006
                      : s.spectralClass === "G"  ? 0.007
                      : s.spectralClass === "F"  ? 0.008
                      : s.spectralClass === "A"  ? 0.010
                      : s.spectralClass === "B"  ? 0.012
                      : 0.006;
    const impulseSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      color, sizeAttenuation: false, transparent: true, opacity: 1.0,
    }));
    impulseSprite.scale.set(impulseSize, impulseSize, 1);
    impulseSprite.position.set(...s.position);
    impulseSprite.userData = { star: s };
    impulseStars.add(impulseSprite);

    // --- Planet ring (visible in both modes; small enough to read as
    //     a halo at distance, not big enough to dominate up close).
    if (s.hasPlanets) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.5, 0.01, 4, 32),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, side: THREE.DoubleSide }),
      );
      ring.position.set(...s.position);
      ring.rotation.x = Math.PI / 2;
      planetRings.add(ring);
    }
  }
}

/** Set per-frame: which star sprite group is visible based on current speed. */
function applyRenderMode(inWarp: boolean) {
  warpStars.visible = inWarp;
  impulseStars.visible = !inWarp;
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

function syncOrbitals(orbitals: any[]) {
  // Cheap rebuild — orbitals don't churn fast.
  orbitalGroup.clear();
  for (const o of orbitals) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(Math.max(0.05, o.ringRadius * 100), 0.008, 4, 32),
      new THREE.MeshBasicMaterial({ color: 0x9c6cff, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    ring.position.set(o.position[0], o.position[1], o.position[2]);
    ring.rotation.x = Math.PI / 2.5;
    orbitalGroup.add(ring);
  }
}

function syncOtherShips(others: any[]) {
  otherShipsGroup.clear();
  for (const o of others) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      color: 0x88ffd9, sizeAttenuation: true, transparent: true, opacity: 0.9,
    }));
    sprite.scale.set(0.15, 0.15, 1);
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

/** Stepped throttle cap by distance to the nearest star, in AU.
 *  Outside 100 AU: full throttle. As we approach, cap tightens so the
 *  ship can't blast past planets in 1/60th of a second. */
function maxImpulseThrottle(distAu: number): number {
  if (distAu > 100) return 1.0;
  if (distAu > 50)  return 0.10;   // ~25 AU/s
  if (distAu > 20)  return 0.07;   // ~9 AU/s
  if (distAu > 5)   return 0.04;   // ~1.6 AU/s
  return 0.025;                    // ~0.4 AU/s near the photosphere
}

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
function makePool(parent: HTMLOListElement, count: number): HTMLLIElement[] {
  const pool: HTMLLIElement[] = [];
  for (let i = 0; i < count; i++) {
    const li = document.createElement("li");
    li.style.cursor = "pointer";
    li.style.display = "none";
    li.title = "click to face this star";
    parent.appendChild(li);
    pool.push(li);
  }
  return pool;
}
const nearestRowPool = makePool(nearestList, NEAREST_ROWS);
const nearestPlanetRowPool = makePool(nearestPlanetList, NEAREST_PLANET_ROWS);

const r = nearestList?.getBoundingClientRect?.();
dbg(`nearestList found: ${!!nearestList}  rect: ${r?.width.toFixed(0)}x${r?.height.toFixed(0)} @ (${r?.x.toFixed(0)},${r?.y.toFixed(0)})  rows=${nearestRowPool.length}`);

// Delegated handler. Now that rows are stable, plain `click` works fine
// and is the right primitive for accessibility (Enter/Space on focus
// also fires click). pointerdown bubbles too if you prefer instant
// response — both are wired here.
function aimAtStarFromRow(t: HTMLElement, kind: "click" | "pointerdown"): boolean {
  const li = t.closest("li[data-star-id]") as HTMLElement | null;
  if (!li) return false;
  const starId = li.dataset.starId;
  if (!starId) return false;
  const star = stars.find((s) => s.id === starId);
  if (!star) { dbg(`→ star ${starId} not found in stars[]`, "warn"); return false; }
  ship.warpEngaged = false;
  const { targetYaw, targetPitch } = headingTo(star.position, ship.position);
  aimTarget = { yaw: targetYaw, pitch: targetPitch };
  dbg(`(${kind}) aim → ${star.name}: yaw=${(targetYaw*180/Math.PI).toFixed(1)}° pitch=${(targetPitch*180/Math.PI).toFixed(1)}°`);
  return true;
}
// Delegate on the parent `.nearest` div so clicks on either <ol> work.
const nearestPanel = nearestList.parentElement!;
nearestPanel.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (aimAtStarFromRow(t, "click")) e.stopPropagation();
});
nearestPanel.addEventListener("pointerdown", (e) => {
  const t = e.target as HTMLElement;
  if (aimAtStarFromRow(t, "pointerdown")) {
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
  if (bestId) engageWarp(bestId);
}

async function engageWarp(objectId: string) {
  if (!gameId || !playerId) return;
  ship.targetId = objectId;
  ship.warpEngaged = true;
  lastSyncedTargetId = objectId;
  await callTool(pane.app, "warp_to", { gameId, playerId, objectId });
}

// --- init ---
pane.initial.then((init) => {
  gameId = init.gameId;
  playerId = init.playerId;
  stars = init.stars || [];
  buildStarMeshes();
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
    const target = stars.find((s) => s.id === ship.targetId);
    if (target) {
      const targetPos = new THREE.Vector3(...target.position);
      const dir = targetPos.clone().sub(ship.position);
      const dist = dir.length();
      dir.normalize();
      const blend = Math.min(1, dt * 3);
      const newFwd = fwd.lerp(dir, blend).normalize();
      ship.yaw   = Math.atan2(newFwd.x, -newFwd.z);
      ship.pitch = Math.asin(Math.max(-1, Math.min(1, newFwd.y)));
      const targetThrottle = dist > 1 ? 0.95 : Math.max(0.1, Math.min(0.4, dist * 0.8));
      ship.throttle = ship.throttle * 0.85 + targetThrottle * 0.15;
      throttleEl.value = ship.throttle.toString();
      if (dist <= OBSERVE_RANGE_LY) {
        ship.warpEngaged = false;
        ship.throttle = 0;
        throttleEl.value = "0";
        if (!observed.has(target.id)) {
          observed.add(target.id);
          if (gameId && playerId) {
            void callTool(pane.app, "observe", { gameId, playerId, objectId: target.id });
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
  // Find the nearest star (excluding stars at exactly the camera's
  // position which would be a degenerate self-distance of 0).
  let closest: { star: StarLite; dist: number } | null = null;
  for (const s of stars) {
    const dx = s.position[0] - ship.position.x;
    const dy = s.position[1] - ship.position.y;
    const dz = s.position[2] - ship.position.z;
    const d = Math.hypot(dx, dy, dz);
    if (closest === null || d < closest.dist) closest = { star: s, dist: d };
  }

  if (closest && closest.dist < BRAKE_RANGE_LY) {
    const distAu = closest.dist / LY_PER_AU;
    // Real radius for proper-scale rendering, BUT also clamp to a
    // minimum apparent size in pixels so M dwarfs / white dwarfs don't
    // become subpixel ghosts. Stellar/atlas apps do this to keep tiny
    // stars findable. Big stars (Betelgeuse) render at true scale
    // because true scale already exceeds the floor.
    const trueRadiusLy = (closest.star.radiusSolar ?? 1.0) * SOL_RADIUS_LY;
    // Min radius = N pixels at this camera distance, given our FOV.
    // tan(35°) ≈ 0.7, height in pixels from canvas; gives radius such
    // that the sphere subtends MIN_PX pixels.
    const MIN_PX = 4;
    const canvasH = canvas.clientHeight || 600;
    const minRadiusLy = (MIN_PX * closest.dist * 1.4) / canvasH;
    const radiusLy = Math.max(trueRadiusLy, minRadiusLy);
    closeStarMesh.position.set(...closest.star.position);
    closeStarMesh.scale.setScalar(radiusLy);
    (closeStarMesh.material as THREE.MeshBasicMaterial).color.setHex(
      spectralColor(closest.star.spectralClass, closest.star.lumClass),
    );
    closeStarMesh.visible = closest.dist > trueRadiusLy;  // hide if camera is inside the star's actual photosphere

    // Planets — render each at its real orbital distance (in AU), with a
    // "demo cheat" radius scale so they're visible. Slow Kepler-ish phase
    // animation: inner planets sweep visibly; outer planets crawl. Phase
    // seeded by (starId, planetName) so each planet sits at a stable
    // orbital position across reloads.
    const planets = closest.star.planets ?? [];
    const tNow = performance.now() / 1000;
    for (let i = 0; i < PLANET_POOL_SIZE; i++) {
      const slot = planetPool[i];
      if (i >= planets.length) {
        if (slot.mesh.visible) slot.mesh.visible = false;
        continue;
      }
      const p = planets[i];
      const orbitAU = Math.max(0.005, p.orbitAU ?? 1);
      const orbitLy = orbitAU * LY_PER_AU;
      const phaseSeed = planetPhaseSeed(closest.star.id, p.name);
      // 0.05 / orbitAU rad/s ⇒ Earth orbits in ~2 minutes; clamped to
      // keep TRAPPIST-1 (orbits at 0.01 AU) from being a blur.
      const phaseSpeed = Math.min(0.5, 0.05 / orbitAU);
      const phase = phaseSeed + tNow * phaseSpeed;
      const sx = closest.star.position[0] + Math.cos(phase) * orbitLy;
      const sy = closest.star.position[1];                              // all planets on the star's local XZ plane
      const sz = closest.star.position[2] + Math.sin(phase) * orbitLy;
      const r = (PLANET_RADIUS_R_EARTH[p.kind] ?? 1) * EARTH_RADIUS_LY * PLANET_VISUAL_SCALE;
      slot.mesh.position.set(sx, sy, sz);
      slot.mesh.scale.setScalar(r);
      slot.mat.color.setHex(PLANET_COLOR[p.kind] ?? 0xaaaaaa);
      slot.mesh.visible = true;
    }

    // Autobrake — clamp throttle to a sub-warp value, and disengage
    // autopilot if it was steering us here.
    const cap = maxImpulseThrottle(distAu);
    if (ship.throttle > cap) {
      ship.throttle = ship.throttle * 0.88 + cap * 0.12;  // smooth deceleration
      throttleEl.value = ship.throttle.toString();
    }
    if (ship.warpEngaged) ship.warpEngaged = false;
    // Auto-observe on first entry into a system (LLM Mind narrates).
    if (!observed.has(closest.star.id) && gameId && playerId) {
      observed.add(closest.star.id);
      void callTool(pane.app, "observe", { gameId, playerId, objectId: closest.star.id });
    }
  } else {
    closeStarMesh.visible = false;
    hidePlanetPool();
  }

  const speed = Math.pow(ship.throttle, 3) * 0.4;
  if (speed > 0) ship.position.addScaledVector(fwd, speed * dt);

  camera.position.copy(ship.position);
  camera.lookAt(ship.position.clone().add(fwd));

  // Mode flip — warp visuals (big sprites + shimmer) above ~0.5 throttle
  // OR whenever autopilot is steering us somewhere. Below that we're in
  // sublight "impulse," and the starfield should look like a real night sky.
  const inWarp = ship.warpEngaged || ship.throttle > 0.45;
  applyRenderMode(inWarp);
  if (warpOverlayEl) warpOverlayEl.classList.toggle("active", inWarp);

  updateHud(fwd);
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

function updateHud(fwd: THREE.Vector3) {
  const speed = Math.pow(ship.throttle, 3) * 0.4;
  const fmt = (s: number) => {
    if (s < 0.005) return `impulse ${(s * 200).toFixed(2)}c`;
    if (s < 0.1)   return `warp ${Math.max(1, Math.round(s * 20))}`;
    return `warp ${Math.min(9, Math.round(2 + Math.log2(Math.max(1, s * 10))))}`;
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

  let hoveredId: string | null = null;
  let bestAngle = 0.06;
  for (const { star } of ranked.slice(0, 8)) {
    const v = new THREE.Vector3(...star.position).sub(ship.position).normalize();
    const angle = v.angleTo(fwd);
    if (angle < bestAngle) { bestAngle = angle; hoveredId = star.id; }
  }
  ship.hoveredId = hoveredId;

  if (hoveredId) {
    const s = stars.find((s) => s.id === hoveredId)!;
    const d = new THREE.Vector3(...s.position).distanceTo(ship.position);
    targetTag.style.display = "";
    targetTag.textContent = `${s.name} · ${s.spectralType} · ${formatDistance(d)}`;
  } else {
    targetTag.style.display = "none";
  }
  hudTarget.textContent = ship.targetId
    ? `target: ${stars.find((s) => s.id === ship.targetId)?.name ?? "?"} ${ship.warpEngaged ? "(warping)" : ""}`
    : "no target";
  if (ship.targetId) {
    const tStar = stars.find((s) => s.id === ship.targetId);
    if (tStar) {
      const d = new THREE.Vector3(...tStar.position).distanceTo(ship.position);
      hudDistance.textContent = `${formatDistance(d)} to target`;
    } else {
      hudDistance.textContent = "—";
    }
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
    if (li.dataset.starId !== star.id) li.dataset.starId = star.id;
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
    renderRow(li, top[i].star, top[i].dist, true);  // show planet count when present
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
}

function resize() {
  const r = canvas.parentElement!.getBoundingClientRect();
  const w = Math.max(1, Math.floor(r.width));
  const h = Math.max(1, Math.floor(r.height));
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();
requestAnimationFrame(tick);

// --- server polling ---
poll(200, async () => {
  if (!gameId || !playerId) return;
  await callTool(pane.app, "sync_state", {
    gameId, playerId,
    state: {
      position: [ship.position.x, ship.position.y, ship.position.z],
      heading: [Math.sin(ship.yaw), Math.sin(ship.pitch), -Math.cos(ship.yaw)],
      throttle: ship.throttle,
      hoveredId: ship.hoveredId,
      targetId: ship.targetId,
      warpEngaged: ship.warpEngaged,
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
