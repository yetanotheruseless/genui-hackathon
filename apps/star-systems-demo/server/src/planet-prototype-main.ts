/**
 * Planet imagery prototype — Three.js + WebGPU (with WebGL fallback).
 *
 * Demonstrates the imagery-onto-planet pipeline:
 *
 *   1. `scripts/fetch-planet-textures.ts` downloads equirectangular maps
 *      (CC BY 4.0, Solar System Scope) into `data/textures/` and writes
 *      a manifest at `data/textures.json`.
 *   2. The Express server in `main.ts` exposes both under `/textures/*`
 *      and `/textures.json`.
 *   3. This page fetches the manifest, builds a SphereGeometry per body,
 *      and applies the matching color / cloud / ring textures.
 *
 * Renderer selection — Three.js WebGPURenderer when `navigator.gpu` is
 * available, otherwise the classic WebGLRenderer. The scene graph is
 * identical for both: standard MeshStandardMaterial / MeshBasicMaterial.
 * These compile to WGSL automatically under WebGPU via three.js's
 * NodeMaterial bridge, so no shader code changes are needed.
 *
 * Note: this is a standalone prototype page, not yet wired into the
 * cockpit / compendium MCP App flow. Load it at /planet-prototype.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// ---------------------------------------------------------------------------
// Body catalog. `radiusKm` is for display only; the rendered sphere is
// always unit-radius (we frame the camera per-body). `description` is a
// one-liner; `kind` controls atmosphere / cloud / ring features.
// ---------------------------------------------------------------------------

type BodyKind = "star" | "rocky" | "ocean_world" | "gas_giant" | "ice_giant" | "moon";

type Body = {
  id: string;            // matches manifest key in textures.json
  name: string;
  kind: BodyKind;
  radiusKm: number;
  fallbackColor: number; // used when no texture is available
  hasClouds?: boolean;
  hasRings?: boolean;
  atmoColor?: number;    // hex — rim glow tint; omit to skip atmosphere
  description: string;
};

const BODIES: Body[] = [
  { id: "sun",     name: "Sun",     kind: "star",        radiusKm: 696340,  fallbackColor: 0xffe8a8,
    description: "G2V main-sequence yellow dwarf. Surface ~5,778 K." },
  { id: "mercury", name: "Mercury", kind: "rocky",       radiusKm: 2440,    fallbackColor: 0xa39181,
    description: "Smallest planet; no atmosphere; cratered like the Moon." },
  { id: "venus",   name: "Venus",   kind: "rocky",       radiusKm: 6052,    fallbackColor: 0xddc18a,
    hasClouds: true, atmoColor: 0xffe9aa,
    description: "Thick CO₂ atmosphere; surface 462 °C, hidden under sulfuric acid clouds." },
  { id: "earth",   name: "Earth",   kind: "ocean_world", radiusKm: 6371,    fallbackColor: 0x4a78ff,
    hasClouds: true, atmoColor: 0x88c8ff,
    description: "Our home. Water-rich, biological, magnetically protected." },
  { id: "moon",    name: "Moon",    kind: "moon",        radiusKm: 1737,    fallbackColor: 0xb4b4b4,
    description: "Earth's natural satellite. Tidally locked; cratered highlands and dark maria." },
  { id: "mars",    name: "Mars",    kind: "rocky",       radiusKm: 3389,    fallbackColor: 0xc9663a,
    atmoColor: 0xff8b5a,
    description: "Cold, thin-atmosphere desert world. Polar ice caps and seasonal dust storms." },
  { id: "jupiter", name: "Jupiter", kind: "gas_giant",   radiusKm: 69911,   fallbackColor: 0xd6b78a,
    atmoColor: 0xfff0d0,
    description: "Largest planet. Banded H/He atmosphere; the Great Red Spot is a 300-year-old anticyclone." },
  { id: "saturn",  name: "Saturn",  kind: "gas_giant",   radiusKm: 58232,   fallbackColor: 0xe6cfa1,
    hasRings: true, atmoColor: 0xfff2c8,
    description: "Famous icy ring system; second-largest planet; lowest mean density of any planet." },
  { id: "uranus",  name: "Uranus",  kind: "ice_giant",   radiusKm: 25362,   fallbackColor: 0x9ed8e1,
    atmoColor: 0xa6e2ee,
    description: "Tilted 98° on its axis. Methane absorption gives the atmosphere its cyan hue." },
  { id: "neptune", name: "Neptune", kind: "ice_giant",   radiusKm: 24622,   fallbackColor: 0x4978d6,
    atmoColor: 0x88aaff,
    description: "Outermost giant. Supersonic winds and the brilliant blue of methane absorption." },
];

// ---------------------------------------------------------------------------
// Renderer setup — prefer WebGPU, fall back to WebGL. The scene graph
// itself is identical; only the renderer changes.
// ---------------------------------------------------------------------------

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const missingBanner = document.getElementById("missing-banner") as HTMLDivElement;

type AnyRenderer = THREE.WebGLRenderer & { setAnimationLoop(fn: () => void): void };

async function makeRenderer(): Promise<{ renderer: AnyRenderer; backend: "webgpu" | "webgl" }> {
  if (typeof navigator !== "undefined" && (navigator as unknown as { gpu?: unknown }).gpu) {
    try {
      // Dynamic import keeps the WebGL-only path working in environments
      // that don't ship the three/webgpu entry (older builds).
      const mod = await import("three/webgpu");
      const WebGPURenderer = (mod as { WebGPURenderer: new (opts: object) => unknown }).WebGPURenderer;
      const r = new WebGPURenderer({ canvas, antialias: true }) as unknown as AnyRenderer & { init(): Promise<void> };
      await r.init();
      return { renderer: r, backend: "webgpu" };
    } catch (e) {
      console.warn("[planet-prototype] WebGPU init failed, falling back to WebGL:", e);
    }
  }
  const r = new THREE.WebGLRenderer({ canvas, antialias: true }) as AnyRenderer;
  return { renderer: r, backend: "webgl" };
}

// ---------------------------------------------------------------------------
// Scene — one persistent scene; we swap meshes when the body changes.
// ---------------------------------------------------------------------------

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
camera.position.set(0, 0.3, 3.2);

const sunLight = new THREE.DirectionalLight(0xffffff, 3.0);
const ambient = new THREE.AmbientLight(0xffffff, 0.05);
scene.add(sunLight, ambient);

// The planet group holds whatever body is currently selected: a base
// sphere, optionally a cloud shell, optionally a ring, optionally an
// atmosphere rim. Cleared on each switch.
const bodyGroup = new THREE.Group();
scene.add(bodyGroup);

// ---------------------------------------------------------------------------
// Texture loading — async with a tiny in-memory cache so repeat switches
// are instant. Failed loads fall through to the fallback solid color.
// ---------------------------------------------------------------------------

type TextureKind = "color" | "clouds" | "ring" | "bump" | "normal";

type Manifest = {
  source: string;
  license: string;
  attribution: string;
  bodies: Record<string, Partial<Record<TextureKind, string>>>;
};

const loader = new THREE.TextureLoader();
const texCache = new Map<string, Promise<THREE.Texture | null>>();

function loadTexture(url: string): Promise<THREE.Texture | null> {
  if (texCache.has(url)) return texCache.get(url)!;
  const p = new Promise<THREE.Texture | null>((resolve) => {
    loader.load(
      url,
      (tex) => {
        // Equirectangular maps need linear filtering + sRGB so the colours
        // look right when sampled across the sphere.
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        resolve(tex);
      },
      undefined,
      (err) => {
        console.warn("[planet-prototype] failed to load", url, err);
        resolve(null);
      },
    );
  });
  texCache.set(url, p);
  return p;
}

/** Like `loadTexture` but for bump / normal maps. They're data, not
 *  colour, so they must stay in linear space — sRGB decoding would
 *  squash the height/normal values toward the dark end. */
function loadDataTexture(url: string): Promise<THREE.Texture | null> {
  const key = `data:${url}`;
  if (texCache.has(key)) return texCache.get(key)!;
  const p = new Promise<THREE.Texture | null>((resolve) => {
    loader.load(
      url,
      (tex) => {
        tex.colorSpace = THREE.NoColorSpace;
        tex.anisotropy = 8;
        resolve(tex);
      },
      undefined,
      (err) => {
        console.warn("[planet-prototype] failed to load", url, err);
        resolve(null);
      },
    );
  });
  texCache.set(key, p);
  return p;
}

async function loadManifest(): Promise<Manifest | null> {
  try {
    const res = await fetch("/textures.json");
    if (!res.ok) return null;
    return (await res.json()) as Manifest;
  } catch (e) {
    console.warn("[planet-prototype] manifest fetch failed:", e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Atmosphere — a slightly larger inside-out sphere with an additive tint.
// Cross-renderer compatible (no custom shader); a proper Fresnel falloff
// would want TSL nodes when polishing.
// ---------------------------------------------------------------------------

function makeAtmosphere(tint: THREE.Color): THREE.Mesh {
  // True Fresnel needs a shader. For cross-renderer simplicity we use a
  // backside sphere with an additive transparent material — the result
  // is a soft halo that grows toward the silhouette. Close enough for a
  // prototype; swap in a TSL Fresnel node when polishing.
  const geo = new THREE.SphereGeometry(1.05, 64, 32);
  const mat = new THREE.MeshBasicMaterial({
    color: tint,
    transparent: true,
    opacity: 0.18,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.kind = "atmosphere";
  return mesh;
}

// ---------------------------------------------------------------------------
// Body construction — paint the manifest's textures onto a unit sphere,
// stacking layers (color, clouds, atmosphere, ring) as the body needs.
// ---------------------------------------------------------------------------

type CurrentBody = {
  base: THREE.Mesh;
  clouds?: THREE.Mesh;
  atmosphere?: THREE.Mesh;
  rings?: THREE.Mesh;
};

async function buildBody(body: Body, manifest: Manifest | null): Promise<CurrentBody> {
  const slots = manifest?.bodies[body.id] ?? {};
  // Bump/normal maps are non-colour data, so they must NOT be tagged
  // sRGB. We load color/clouds via loadTexture (sets sRGB) and load
  // height-style maps via a second helper that keeps them linear.
  const colorTex  = slots.color  ? await loadTexture(slots.color)  : null;
  const cloudTex  = body.hasClouds && slots.clouds ? await loadTexture(slots.clouds) : null;
  const ringTex   = body.hasRings  && slots.ring   ? await loadTexture(slots.ring)   : null;
  const bumpTex   = slots.bump   ? await loadDataTexture(slots.bump)   : null;
  const normalTex = slots.normal ? await loadDataTexture(slots.normal) : null;

  // Base sphere. Stars use MeshBasicMaterial (self-emitting); planets use
  // MeshStandardMaterial so the directional sunlight produces a proper
  // terminator and the bump/normal maps give grazing-angle relief.
  const geo = new THREE.SphereGeometry(1, 96, 64);
  let baseMat: THREE.Material;
  if (body.kind === "star") {
    baseMat = new THREE.MeshBasicMaterial({
      map: colorTex ?? undefined,
      color: colorTex ? 0xffffff : body.fallbackColor,
    });
  } else {
    const std = new THREE.MeshStandardMaterial({
      map: colorTex ?? undefined,
      color: colorTex ? 0xffffff : body.fallbackColor,
      roughness: body.kind === "gas_giant" || body.kind === "ice_giant" ? 0.9 : 0.95,
      metalness: 0.0,
    });
    if (normalTex) {
      std.normalMap = normalTex;
      std.normalScale = new THREE.Vector2(0.8, 0.8);
    } else if (bumpTex) {
      std.bumpMap = bumpTex;
      std.bumpScale = 0.05;
    }
    baseMat = std;
  }
  const base = new THREE.Mesh(geo, baseMat);
  base.userData.kind = "base";

  const out: CurrentBody = { base };

  // Cloud shell — slightly larger sphere, transparent, slow drift offset.
  // Same texture file is used for both color and alpha (the clouds JPGs
  // are bright-on-dark, so luminance reads cleanly as alpha when we set
  // alphaMap + transparent).
  if (cloudTex) {
    const cgeo = new THREE.SphereGeometry(1.01, 96, 64);
    const cmat = new THREE.MeshStandardMaterial({
      map: cloudTex,
      alphaMap: cloudTex,
      transparent: true,
      depthWrite: false,
      color: 0xffffff,
      roughness: 1.0,
    });
    out.clouds = new THREE.Mesh(cgeo, cmat);
    out.clouds.userData.kind = "clouds";
  }

  // Atmosphere rim — Fresnel-ish halo via a BackSide tinted sphere.
  if (body.atmoColor != null) {
    out.atmosphere = makeAtmosphere(new THREE.Color(body.atmoColor));
  }

  // Saturn rings — a flat ring mesh using RingGeometry. The provided ring
  // texture is a 1-D alpha map from inner to outer radius; we stretch it
  // across the radial direction by rewriting the geometry's UVs.
  if (ringTex) {
    const inner = 1.3;
    const outer = 2.3;
    const rgeo = new THREE.RingGeometry(inner, outer, 128, 8);
    const pos = rgeo.attributes.position as THREE.BufferAttribute;
    const uvs = rgeo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const r = Math.hypot(x, y);
      const t = (r - inner) / (outer - inner);
      uvs.setXY(i, t, 0.5);
    }
    uvs.needsUpdate = true;
    const rmat = new THREE.MeshBasicMaterial({
      map: ringTex, alphaMap: ringTex, transparent: true,
      side: THREE.DoubleSide, depthWrite: false, color: 0xffffff,
    });
    out.rings = new THREE.Mesh(rgeo, rmat);
    out.rings.rotation.x = Math.PI / 2 - 0.45;   // slight tilt for theatre
    out.rings.userData.kind = "rings";
  }

  return out;
}

function disposeBody(b: CurrentBody) {
  for (const m of [b.base, b.clouds, b.atmosphere, b.rings]) {
    if (!m) continue;
    bodyGroup.remove(m);
    m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[];
    if (Array.isArray(mat)) mat.forEach(mm => mm.dispose());
    else mat.dispose();
  }
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

const bodyListEl = document.getElementById("body-list") as HTMLDivElement;
const infoNameEl = document.getElementById("info-name") as HTMLElement;
const infoTypeEl = document.getElementById("info-type") as HTMLElement;
const infoRadiusEl = document.getElementById("info-radius") as HTMLElement;
const infoLayersEl = document.getElementById("info-layers") as HTMLElement;
const infoDescEl = document.getElementById("info-desc") as HTMLElement;
const infoCreditEl = document.getElementById("info-credit") as HTMLElement;

const spinEl = document.getElementById("spin") as HTMLInputElement;
const sunAzEl = document.getElementById("sun-az") as HTMLInputElement;
const sunElEl = document.getElementById("sun-el") as HTMLInputElement;
const atmoEl = document.getElementById("atmo") as HTMLInputElement;

let active: { body: Body; current: CurrentBody } | null = null;
let manifest: Manifest | null = null;

function buildBodyButtons() {
  for (const b of BODIES) {
    const btn = document.createElement("button");
    btn.textContent = b.name;
    btn.dataset.bodyId = b.id;
    btn.addEventListener("click", () => void selectBody(b));
    bodyListEl.appendChild(btn);
  }
}

function updateActiveButton(bodyId: string) {
  for (const btn of bodyListEl.querySelectorAll("button")) {
    btn.classList.toggle("active", btn.getAttribute("data-body-id") === bodyId);
  }
}

async function selectBody(body: Body) {
  updateActiveButton(body.id);
  // Tear down old, build new.
  if (active) disposeBody(active.current);
  const current = await buildBody(body, manifest);
  bodyGroup.add(current.base);
  if (current.clouds) bodyGroup.add(current.clouds);
  if (current.atmosphere) bodyGroup.add(current.atmosphere);
  if (current.rings) bodyGroup.add(current.rings);
  active = { body, current };

  // Info panel.
  infoNameEl.textContent = body.name;
  infoTypeEl.textContent = body.kind.replace(/_/g, " ");
  infoRadiusEl.textContent = `${body.radiusKm.toLocaleString()} km`;
  const layers: string[] = ["color"];
  if (current.clouds) layers.push("clouds");
  if (current.atmosphere) layers.push("atmosphere");
  if (current.rings) layers.push("rings");
  infoLayersEl.textContent = layers.join(" + ");
  infoDescEl.textContent = body.description;
  infoCreditEl.innerHTML = manifest
    ? `${manifest.attribution} · <a href="${manifest.source.split(" · ")[1] ?? "#"}" target="_blank" rel="noopener">source</a>`
    : `No textures fetched — showing fallback colour`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { renderer, backend } = await makeRenderer();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  statusEl.textContent = backend === "webgpu" ? "WebGPU ✓" : "WebGL (WebGPU unavailable)";

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 1.3;
  controls.maxDistance = 8;

  manifest = await loadManifest();
  if (!manifest) {
    missingBanner.classList.add("show");
    setTimeout(() => missingBanner.classList.remove("show"), 6000);
  }

  buildBodyButtons();
  await selectBody(BODIES[3]);   // Earth as the opening shot

  // Skybox — the Milky Way panorama if we have it. SphereGeometry on
  // BackSide is the simplest cross-renderer skybox; no CubeTexture
  // conversion needed. Tinted dim so it doesn't fight the foreground.
  const skyTex = manifest?.bodies.stars?.color ? await loadTexture(manifest.bodies.stars.color) : null;
  if (skyTex) {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(50, 64, 32),
      new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, color: 0x666677 }),
    );
    scene.add(sky);
  } else {
    scene.background = new THREE.Color(0x04060a);
  }

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  resize();

  let last = performance.now();
  function tick() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // Sun direction from the two sliders. Az is yaw, el is pitch. The
    // light's position vector points TOWARD the sun, so we cast a unit
    // vector in that direction.
    const azRad = (parseFloat(sunAzEl.value) * Math.PI) / 180;
    const elRad = (parseFloat(sunElEl.value) * Math.PI) / 180;
    sunLight.position.set(
      Math.cos(elRad) * Math.sin(azRad) * 5,
      Math.sin(elRad) * 5,
      Math.cos(elRad) * Math.cos(azRad) * 5,
    );

    // Spin the planet + (slightly faster) clouds.
    const spin = parseFloat(spinEl.value);
    if (active) {
      active.current.base.rotation.y += dt * spin * 0.25;
      if (active.current.clouds) active.current.clouds.rotation.y += dt * spin * 0.31;
      if (active.current.rings) active.current.rings.rotation.z += dt * spin * 0.04;

      // Atmosphere strength — opacity scales with the slider.
      if (active.current.atmosphere) {
        const m = active.current.atmosphere.material as THREE.MeshBasicMaterial;
        m.opacity = 0.18 * parseFloat(atmoEl.value);
      }
    }

    controls.update();
    renderer.render(scene, camera);
  }
  renderer.setAnimationLoop(tick);
}

main().catch((e) => {
  console.error(e);
  statusEl.innerHTML = `<span class="warn">init failed: ${(e as Error).message}</span>`;
});
