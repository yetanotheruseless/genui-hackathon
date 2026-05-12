/**
 * Planet imagery prototype — Babylon.js + PBR.
 *
 * Demonstrates the imagery-onto-planet pipeline:
 *
 *   1. `scripts/fetch-planet-textures.ts` downloads equirectangular maps
 *      (public-domain Solar System surface maps) into `data/textures/`
 *      and writes a manifest at `data/textures.json`.
 *   2. The Express server in `main.ts` exposes both under `/textures/*`
 *      and `/textures.json`.
 *   3. This page fetches the manifest, builds a sphere per body, and
 *      applies the matching color / cloud / ring textures via PBR.
 *
 * Renderer: WebGL2 (Babylon's stock `Engine`), matching what the
 * cockpit uses in `cockpit-main.ts:294`. The earlier WebGPU branch
 * was dropped because (a) the cockpit isn't on WebGPU, so visual
 * tuning here only transfers cleanly when both renderers agree,
 * and (b) WebGPU papercuts (StandardMaterial.emissiveTexture not
 * sampling, GL_POINTS ShaderMaterial composing badly with the bloom
 * highlights pass, glslang rejecting non-ASCII shader comments)
 * cost more than the gains at this fidelity.
 *
 * Matches the cockpit's planet PBR conventions
 * (`buildPlanetMeshes()` in cockpit-main.ts):
 *
 *   metallic = 0
 *   roughness = 0.85
 *   directIntensity = 1.0
 *   environmentIntensity = 0.5
 *
 * so any look/material tweaks landed here transfer 1:1 into the cockpit
 * planet rendering. Load at /planet-prototype.
 */
import {
  ArcRotateCamera,
  Color3,
  Color4,
  Constants,
  DefaultRenderingPipeline,
  DirectionalLight,
  Effect,
  Engine,
  GlowLayer,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Scene,
  ShaderMaterial,
  Texture,
  Vector3,
  VertexData,
} from "@babylonjs/core";

// ---------------------------------------------------------------------------
// Body catalog. `radiusKm` is for display only; the rendered sphere is
// always unit-radius (the camera is framed per-body). `kind` controls
// atmosphere / cloud / ring features.
// ---------------------------------------------------------------------------

type BodyKind = "star" | "rocky" | "ocean_world" | "gas_giant" | "ice_giant" | "moon";

type Body = {
  id: string;            // matches manifest key in textures.json
  name: string;
  kind: BodyKind;
  radiusKm: number;
  fallbackColor: Color3; // used when no texture is available
  hasClouds?: boolean;
  hasRings?: boolean;
  atmoColor?: Color3;    // omit to skip atmosphere
  description: string;
};

const c3 = (hex: number) =>
  new Color3(((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255);

const BODIES: Body[] = [
  { id: "sun",     name: "Sun",     kind: "star",        radiusKm: 696340, fallbackColor: c3(0xffe8a8),
    description: "G2V main-sequence yellow dwarf. Surface ~5,778 K." },
  { id: "mercury", name: "Mercury", kind: "rocky",       radiusKm: 2440,   fallbackColor: c3(0xa39181),
    description: "Smallest planet; no atmosphere; cratered like the Moon." },
  { id: "venus",   name: "Venus",   kind: "rocky",       radiusKm: 6052,   fallbackColor: c3(0xddc18a),
    hasClouds: true, atmoColor: c3(0xffe9aa),
    description: "Thick CO₂ atmosphere; surface 462 °C, hidden under sulfuric acid clouds." },
  { id: "earth",   name: "Earth",   kind: "ocean_world", radiusKm: 6371,   fallbackColor: c3(0x4a78ff),
    hasClouds: true, atmoColor: c3(0x88c8ff),
    description: "Our home. Water-rich, biological, magnetically protected." },
  { id: "moon",    name: "Moon",    kind: "moon",        radiusKm: 1737,   fallbackColor: c3(0xb4b4b4),
    description: "Earth's natural satellite. Tidally locked; cratered highlands and dark maria." },
  { id: "mars",    name: "Mars",    kind: "rocky",       radiusKm: 3389,   fallbackColor: c3(0xc9663a),
    atmoColor: c3(0xff8b5a),
    description: "Cold, thin-atmosphere desert world. Polar ice caps and seasonal dust storms." },
  { id: "jupiter", name: "Jupiter", kind: "gas_giant",   radiusKm: 69911,  fallbackColor: c3(0xd6b78a),
    atmoColor: c3(0xfff0d0),
    description: "Largest planet. Banded H/He atmosphere; the Great Red Spot is a 300-year-old anticyclone." },
  { id: "saturn",  name: "Saturn",  kind: "gas_giant",   radiusKm: 58232,  fallbackColor: c3(0xe6cfa1),
    hasRings: true, atmoColor: c3(0xfff2c8),
    description: "Famous icy ring system; second-largest planet; lowest mean density of any planet." },
  { id: "uranus",  name: "Uranus",  kind: "ice_giant",   radiusKm: 25362,  fallbackColor: c3(0x9ed8e1),
    atmoColor: c3(0xa6e2ee),
    description: "Tilted 98° on its axis. Methane absorption gives the atmosphere its cyan hue." },
  { id: "neptune", name: "Neptune", kind: "ice_giant",   radiusKm: 24622,  fallbackColor: c3(0x4978d6),
    atmoColor: c3(0x88aaff),
    description: "Outermost giant. Supersonic winds and the brilliant blue of methane absorption." },
];

// ---------------------------------------------------------------------------
// Renderer. WebGL2 only, matching the cockpit (see file header for why).
// ---------------------------------------------------------------------------

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const missingBanner = document.getElementById("missing-banner") as HTMLDivElement;

function makeEngine(): Engine {
  // 4th arg adaptToDeviceRatio=true renders at devicePixelRatio so the
  // disc looks crisp on retina displays. Matches cockpit-main.ts:294.
  return new Engine(canvas, true, { stencil: true, preserveDrawingBuffer: false, antialias: true }, true);
}

// ---------------------------------------------------------------------------
// Texture loading. Babylon's `Texture` constructor returns immediately and
// loads in the background; the helper wraps it in a promise so the build
// flow stays linear. Failed loads resolve to null.
// ---------------------------------------------------------------------------

type TextureKind = "color" | "clouds" | "ring" | "bump" | "normal";

type Manifest = {
  source: string;
  license: string;
  attribution: string;
  bodies: Record<string, Partial<Record<TextureKind, string>>>;
};

const texCache = new Map<string, Promise<Texture | null>>();

function loadTexture(url: string, scene: Scene, opts: { isData?: boolean } = {}): Promise<Texture | null> {
  const key = `${opts.isData ? "data:" : "color:"}${url}`;
  const cached = texCache.get(key);
  if (cached) return cached;
  const p = new Promise<Texture | null>((resolve) => {
    // 3rd arg `noMipmap=false`; 4th `invertY` — equirectangular surface
    // maps render upright when invertY = false. Bump / normal maps are
    // data, not colour, so they must NOT be tagged sRGB (Babylon's
    // Texture defaults to linear; PBRMaterial knows albedoTexture is
    // gamma and bumpTexture is linear, so no extra flag needed).
    const tex = new Texture(
      url,
      scene,
      false,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
      () => resolve(tex),
      (_msg, err) => {
        console.warn("[planet-prototype] failed to load", url, err);
        resolve(null);
      },
    );
    tex.anisotropicFilteringLevel = 8;
  });
  texCache.set(key, p);
  return p;
}

async function loadManifest(): Promise<Manifest | null> {
  try {
    const res = await fetch("/textures.json");
    if (!res.ok) return null;
    return (await res.json()) as Manifest;
  } catch (err) {
    console.warn("[planet-prototype] manifest fetch failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tunable schema. Every section here becomes a collapsible block in
// the controls panel; every entry becomes a slider/dropdown. The
// runtime reads values via `T(id)` / `TS(id)` helpers and applies
// them either per-frame (atmosphere uniforms, sun position) or via
// onInput hooks (pipeline, material properties).
//
// Add a knob: append to the matching section here and `applyTuning()`
// or the body-builder will read it. No HTML edits needed.
// ---------------------------------------------------------------------------
type RangeT = { id: string; label: string; type: "range"; min: number; max: number; step: number; value: number };
type SelectT = { id: string; label: string; type: "select"; value: string; options: { value: string; label: string }[] };
type Tunable = RangeT | SelectT;
type Section = { title: string; collapsed?: boolean; controls: Tunable[] };

const TUNABLES: Section[] = [
  {
    title: "World",
    controls: [
      { id: "spin",   label: "Spin",   type: "range", min: 0,    max: 2,   step: 0.01, value: 0.4 },
      { id: "sun-az", label: "Sun az", type: "range", min: -180, max: 180, step: 1,    value: 40 },
      { id: "sun-el", label: "Sun el", type: "range", min: -89,  max: 89,  step: 1,    value: 15 },
      { id: "atmo",   label: "Atmo",   type: "range", min: 0,    max: 2,   step: 0.01, value: 1 },
    ],
  },
  {
    title: "Lighting",
    controls: [
      { id: "sun-intensity",     label: "Sun direct",  type: "range", min: 0, max: 8, step: 0.05, value: 3.0 },
      { id: "ambient-intensity", label: "Hemispheric", type: "range", min: 0, max: 1, step: 0.01, value: 0.05 },
    ],
  },
  {
    title: "Planet PBR",
    collapsed: true,
    controls: [
      { id: "pbr-direct",    label: "directInt",   type: "range", min: 0, max: 4, step: 0.05, value: 1.6 },
      { id: "pbr-env",       label: "envInt",      type: "range", min: 0, max: 2, step: 0.05, value: 0.5 },
      { id: "pbr-roughness", label: "Roughness",   type: "range", min: 0, max: 1, step: 0.01, value: 0.85 },
      { id: "pbr-rough-gas", label: "Rough (gas)", type: "range", min: 0, max: 1, step: 0.01, value: 0.90 },
      { id: "pbr-bump",      label: "Bump scale",  type: "range", min: 0, max: 3, step: 0.05, value: 1.0 },
    ],
  },
  {
    title: "Atmosphere",
    collapsed: true,
    controls: [
      { id: "atmo-shell",        label: "Shell ×",        type: "range", min: 1.02, max: 1.5,  step: 0.005, value: 1.11 },
      { id: "atmo-falloff-rock", label: "Rocky falloff",  type: "range", min: 0.5,  max: 5,    step: 0.1,   value: 2.4 },
      { id: "atmo-falloff-gas",  label: "Gas falloff",    type: "range", min: 0.5,  max: 5,    step: 0.1,   value: 1.4 },
      { id: "atmo-outer-fade",   label: "Outer fade",     type: "range", min: 0.5,  max: 1,    step: 0.01,  value: 0.85 },
      { id: "atmo-twilight",     label: "Twilight floor", type: "range", min: 0,    max: 1,    step: 0.01,  value: 0.18 },
      { id: "atmo-night-alpha",  label: "Night alpha",    type: "range", min: 0,    max: 1,    step: 0.01,  value: 0.40 },
    ],
  },
  {
    title: "Sun / corona",
    collapsed: true,
    controls: [
      { id: "sun-emis-r",       label: "Emis R",   type: "range", min: 0,    max: 3,    step: 0.02, value: 0.70 },
      { id: "sun-emis-g",       label: "Emis G",   type: "range", min: 0,    max: 3,    step: 0.02, value: 0.60 },
      { id: "sun-emis-b",       label: "Emis B",   type: "range", min: 0,    max: 3,    step: 0.02, value: 0.42 },
      { id: "corona-shell",     label: "Corona ×", type: "range", min: 1.05, max: 2.5,  step: 0.01, value: 1.40 },
      { id: "corona-falloff",   label: "Falloff",  type: "range", min: 0.5,  max: 5,    step: 0.05, value: 1.3 },
      { id: "corona-r",         label: "Halo R",   type: "range", min: 0,    max: 3,    step: 0.02, value: 1.6 },
      { id: "corona-g",         label: "Halo G",   type: "range", min: 0,    max: 3,    step: 0.02, value: 1.15 },
      { id: "corona-b",         label: "Halo B",   type: "range", min: 0,    max: 3,    step: 0.02, value: 0.55 },
    ],
  },
  {
    title: "Clouds",
    collapsed: true,
    controls: [
      { id: "cloud-alpha",      label: "Opacity",    type: "range", min: 0,    max: 1,    step: 0.01, value: 1.0 },
      { id: "cloud-altitude",   label: "Altitude",   type: "range", min: 1.0,  max: 1.1,  step: 0.002, value: 1.01 },
      { id: "cloud-spin-mult",  label: "Spin mult",  type: "range", min: 0.5,  max: 4,    step: 0.02, value: 1.24 },
    ],
  },
  {
    title: "Rings",
    collapsed: true,
    controls: [
      { id: "ring-tilt", label: "Tilt", type: "range", min: -1.5, max: 1.5, step: 0.01, value: -0.45 },
    ],
  },
  {
    title: "Pipeline",
    collapsed: true,
    controls: [
      { id: "tonemap",        label: "Tone map",     type: "select", value: "1", options: [
        { value: "0", label: "None" }, { value: "1", label: "ACES" }, { value: "2", label: "Standard" }] },
      { id: "exposure",       label: "Exposure",     type: "range", min: 0.1,  max: 4,    step: 0.05, value: 1.6 },
      { id: "contrast",       label: "Contrast",     type: "range", min: 0.5,  max: 2.5,  step: 0.05, value: 1.1 },
      { id: "bloom-thresh",   label: "Bloom thresh", type: "range", min: 0,    max: 2.5,  step: 0.01, value: 1.05 },
      { id: "bloom-weight",   label: "Bloom weight", type: "range", min: 0,    max: 2,    step: 0.01, value: 0.4 },
      { id: "bloom-kernel",   label: "Bloom kernel", type: "range", min: 16,   max: 256,  step: 8,    value: 64 },
      { id: "bloom-scale",    label: "Bloom scale",  type: "range", min: 0.25, max: 1,    step: 0.05, value: 0.5 },
      { id: "glow",           label: "Glow",         type: "range", min: 0,    max: 2,    step: 0.05, value: 0.6 },
    ],
  },
];

function buildTuningPanel(): void {
  const container = document.getElementById("tuning");
  if (!container) return;
  for (const section of TUNABLES) {
    const sec = document.createElement("div");
    sec.className = "section" + (section.collapsed ? " collapsed" : "");
    const h3 = document.createElement("h3");
    h3.textContent = section.title;
    h3.addEventListener("click", () => sec.classList.toggle("collapsed"));
    const body = document.createElement("div");
    body.className = "section-body";
    sec.appendChild(h3);
    sec.appendChild(body);
    for (const ctl of section.controls) {
      const row = document.createElement("div");
      row.className = "row";
      const label = document.createElement("label");
      label.htmlFor = ctl.id;
      label.textContent = ctl.label;
      row.appendChild(label);
      if (ctl.type === "range") {
        const inp = document.createElement("input");
        inp.type = "range";
        inp.id = ctl.id;
        inp.min = String(ctl.min); inp.max = String(ctl.max); inp.step = String(ctl.step);
        inp.value = String(ctl.value);
        const val = document.createElement("span");
        val.className = "val";
        val.textContent = inp.value;
        inp.addEventListener("input", () => { val.textContent = inp.value; });
        row.appendChild(inp);
        row.appendChild(val);
      } else {
        const sel = document.createElement("select");
        sel.id = ctl.id;
        for (const opt of ctl.options) {
          const o = document.createElement("option");
          o.value = opt.value; o.textContent = opt.label;
          sel.appendChild(o);
        }
        sel.value = ctl.value;
        row.appendChild(sel);
      }
      body.appendChild(row);
    }
    container.appendChild(sec);
  }
}

// Type-narrowed lookups by id. Cached after first access since
// document.getElementById is called many times per frame.
const _elCache = new Map<string, HTMLInputElement | HTMLSelectElement>();
function el(id: string): HTMLInputElement | HTMLSelectElement {
  let e = _elCache.get(id);
  if (!e) {
    e = document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
    _elCache.set(id, e);
  }
  return e;
}
function T(id: string): number { return parseFloat(el(id).value); }
function TS(id: string): string { return el(id).value; }

// ---------------------------------------------------------------------------
// Starfield backdrop. Same point-cloud pattern as the cockpit's
// `buildBrightCloud()` — a single Mesh with GL_POINTS rendering, a
// custom ShaderMaterial pulling per-vertex colour + size hint from
// the vertex `color` attribute. The cockpit feeds real HYG-catalog
// positions in; here we generate ~6k procedural unit-vector positions
// at large radius (the backdrop doesn't need parallax at prototype
// scope). Spectral tint is drawn from a Planckian-ish swatch table
// matching how `starEmissiveColor` in cockpit-main.ts colours O→M.
// ---------------------------------------------------------------------------
Effect.ShadersStore["starfieldVertexShader"] = `
precision highp float;
attribute vec3 position;
attribute vec4 color;
uniform mat4 worldViewProjection;
uniform float pixelScale;
varying vec3 vRgb;
void main() {
  vRgb = color.rgb;
  gl_Position = worldViewProjection * vec4(position, 1.0);
  // color.a doubles as a size hint (per the cockpit's encoding) so
  // visually-brighter stars get a fatter point.
  gl_PointSize = max(1.0, color.a * pixelScale);
}
`;
Effect.ShadersStore["starfieldFragmentShader"] = `
precision highp float;
varying vec3 vRgb;
void main() {
  // Soft round point: alpha falloff from center to edge.
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  float a = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(vRgb, a);
}
`;

// Hot→cold spectral palette. Roughly matches cockpit's
// `starEmissiveColor` for the common types we'll see in a 6k sample.
const SPECTRAL_SWATCHES: [number, number, number][] = [
  [0.62, 0.74, 1.00],   // O — blue-white
  [0.78, 0.85, 1.00],   // B
  [0.92, 0.93, 1.00],   // A — white
  [1.00, 0.98, 0.84],   // F — pale yellow
  [1.00, 0.94, 0.70],   // G — sun-like
  [1.00, 0.82, 0.55],   // K — orange
  [1.00, 0.65, 0.45],   // M — red dwarf
];

function buildStarfield(scene: Scene): Mesh {
  const N = 6000;
  const R = 80;          // backdrop radius
  const positions: number[] = [];
  const colors: number[] = [];
  for (let i = 0; i < N; i++) {
    // Uniform sphere via 2-axis rejection ish: z uniform in [-1,1], θ uniform.
    const z = Math.random() * 2 - 1;
    const phi = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - z * z);
    positions.push(R * s * Math.cos(phi), R * z, R * s * Math.sin(phi));
    // Magnitude-like log distribution: most stars dim, a few bright.
    const u = Math.random();
    // 4th-root compresses brightness toward perceptual scale.
    const brightness = Math.pow(u, 4);
    const [sr, sg, sb] = SPECTRAL_SWATCHES[(Math.random() * SPECTRAL_SWATCHES.length) | 0];
    const intensity = 0.35 + 0.65 * brightness;
    // alpha doubles as point-size hint: 1 px floor, brightest get ~4 px.
    const sizeHint = 1.0 + 3.0 * brightness;
    colors.push(sr * intensity, sg * intensity, sb * intensity, sizeHint);
  }
  const mesh = new Mesh("starfield", scene);
  const data = new VertexData();
  data.positions = positions;
  data.colors = colors;
  data.applyToMesh(mesh);

  const mat = new ShaderMaterial(
    "starfieldMat", scene,
    { vertex: "starfield", fragment: "starfield" },
    {
      attributes: ["position", "color"],
      uniforms: ["worldViewProjection", "pixelScale"],
      needAlphaBlending: true,
    },
  );
  mat.setFloat("pixelScale", 1.0);
  mat.pointsCloud = true;
  mat.backFaceCulling = false;
  mat.disableDepthWrite = true;
  // Additive blending — multiple overlapping points add brightness
  // the same way real overlapping stars would.
  mat.alphaMode = Constants.ALPHA_ADD;
  mesh.material = mat;
  // Render before the planet so the planet's depth write occludes
  // any backdrop points that happen to fall behind it.
  mesh.renderingGroupId = 0;
  // Don't pick up bloom — the starfield already self-glows via
  // additive points; bloom on it just smears the whole sky.
  mesh.isPickable = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// Atmosphere / corona shader. A thin shell sphere where the fragment
// brightness is driven by Fresnel rim falloff (max at silhouette) and
// modulated by the sun angle so the lit limb glows brighter than the
// night-side limb. Not physically-accurate Rayleigh scattering, but
// captures the day-side-bright + soft-twilight + dark-night look that
// reads as "atmosphere" at this scale.
//
// `falloffPower` controls how tightly the glow hugs the silhouette:
//   ~2.0 for Earth-like (sharp rim)
//   ~1.4 for gas giants (broader, softer halo)
// `intensity` is per-frame from the Atmo slider.
// `useSunBias` is 0 for omnidirectional corona on stars, 1 for planets.
// ---------------------------------------------------------------------------
Effect.ShadersStore["atmoVertexShader"] = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
uniform mat4 worldViewProjection;
uniform mat4 world;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
void main() {
  vec4 wp = world * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vWorldNormal = normalize((world * vec4(normal, 0.0)).xyz);
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;
// Inline GLSL — keep plain ASCII (no em-dashes etc) so the shader
// stays portable if we ever swap engines.
Effect.ShadersStore["atmoFragmentShader"] = `
precision highp float;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
uniform vec3 cameraPosition;
uniform vec3 lightDirection;
uniform vec3 atmoColor;
uniform float falloffPower;
uniform float intensity;
uniform float useSunBias;
uniform float outerFade;
uniform float twilightFloor;
uniform float nightAlpha;
void main() {
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  vec3 N = normalize(vWorldNormal);
  float NdotV = max(0.0, dot(viewDir, N));
  // t = 0 at the center of the visible disc, 1 at the silhouette.
  float t = 1.0 - NdotV;
  // pow(t, k) peaks at the silhouette; the outer-fade smoothstep
  // pushes the peak inward and fades alpha to 0 at the outermost
  // visible edge, killing the hard ring against space.
  float rim = pow(t, falloffPower) * smoothstep(1.0, outerFade, t);
  // Sun bias: Babylon DirectionalLight.direction points FROM sun TO
  // surface, so the sun direction is the negation. Smoothstep over
  // the terminator softens the day/night transition.
  vec3 sunDir = -normalize(lightDirection);
  float NdotL = dot(N, sunDir);
  float litness = smoothstep(-0.4, 0.4, NdotL);
  // Planets get a twilight floor so the night-side limb still glows
  // faintly. useSunBias=0 disables it for an omnidirectional corona.
  float dayBias = mix(1.0, mix(twilightFloor, 1.0, litness), useSunBias);
  vec3 col = atmoColor * rim * dayBias * intensity;
  float alphaBias = mix(1.0, mix(nightAlpha, 1.0, litness), useSunBias);
  float a = rim * alphaBias * intensity;
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}
`;

function makeAtmoMaterial(
  scene: Scene,
  args: { color: Color3; useSunBias: boolean; name: string },
): ShaderMaterial {
  const mat = new ShaderMaterial(
    args.name,
    scene,
    { vertex: "atmo", fragment: "atmo" },
    {
      attributes: ["position", "normal"],
      uniforms: [
        "world", "worldViewProjection", "cameraPosition", "lightDirection",
        "atmoColor", "falloffPower", "intensity", "useSunBias",
        "outerFade", "twilightFloor", "nightAlpha",
      ],
      needAlphaBlending: true,
    },
  );
  mat.setColor3("atmoColor", args.color);
  // Numeric uniforms are pushed every frame from `applyTuning()`
  // (intensity, falloffPower, outerFade, twilightFloor, nightAlpha)
  // — initial values here just keep the first frame sane.
  mat.setFloat("intensity", 1.0);
  mat.setFloat("falloffPower", 2.0);
  mat.setFloat("outerFade", 0.85);
  mat.setFloat("twilightFloor", 0.18);
  mat.setFloat("nightAlpha", 0.40);
  mat.setFloat("useSunBias", args.useSunBias ? 1 : 0);
  mat.backFaceCulling = true;
  mat.disableDepthWrite = true;
  // Additive composite — the rim glow adds light on top of whatever's
  // behind it, which is right for the "atmosphere lit by sun" look.
  mat.alphaMode = Constants.ALPHA_ADD;
  return mat;
}

// ---------------------------------------------------------------------------
// Saturn-style annulus. Babylon doesn't ship a ring primitive, so we
// hand-build VertexData with radial UVs (uv.x = normalized radial
// position; uv.y = 0.5). That lets a 1-D inner-to-outer alpha ramp
// texture map across the ring radius the way the source PNGs expect.
// ---------------------------------------------------------------------------
function buildRingMesh(scene: Scene, inner: number, outer: number, segments = 128): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const cos = Math.cos(a), sin = Math.sin(a);
    positions.push(cos * inner, 0, sin * inner);
    positions.push(cos * outer, 0, sin * outer);
    uvs.push(0, 0.5, 1, 0.5);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
    indices.push(a, b, c);
    indices.push(b, d, c);
  }
  const mesh = new Mesh("ring", scene);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.uvs = uvs;
  data.applyToMesh(mesh);
  return mesh;
}

// ---------------------------------------------------------------------------
// Body construction. Paint the manifest's textures onto a unit sphere,
// stacking layers (color, clouds, atmosphere, rings) as each body needs.
//
// PBR parameters mirror the cockpit's `buildPlanetMeshes()`:
//   metallic = 0
//   roughness = 0.85 (matte rocky/icy bodies)
//   directIntensity = 1.0
//   environmentIntensity = 0.5
// Gas giants get a slightly higher roughness so the banded cloud tops
// don't sharply catch the terminator. Stars bypass the lighting path
// entirely via StandardMaterial with disableLighting (matches how
// cockpit-main.ts treats close-mesh star spheres).
// ---------------------------------------------------------------------------

type CurrentBody = {
  base: Mesh;
  clouds?: Mesh;
  atmosphere?: Mesh;
  rings?: Mesh;
};

async function buildBody(scene: Scene, body: Body, manifest: Manifest | null): Promise<CurrentBody> {
  const slots = manifest?.bodies[body.id] ?? {};
  const [colorTex, cloudTex, ringTex, normalTex] = await Promise.all([
    slots.color  ? loadTexture(slots.color,  scene)                     : Promise.resolve(null),
    body.hasClouds && slots.clouds ? loadTexture(slots.clouds, scene)   : Promise.resolve(null),
    body.hasRings  && slots.ring   ? loadTexture(slots.ring,   scene)   : Promise.resolve(null),
    slots.normal ? loadTexture(slots.normal, scene, { isData: true })   : Promise.resolve(null),
  ]);

  // Base sphere. Stars are self-lit via an unlit StandardMaterial
  // (matches close-mesh star rendering in the cockpit); planets are
  // PBR-shaded with the directional sun.
  const base = MeshBuilder.CreateSphere(`base:${body.id}`, { diameter: 2, segments: 64 }, scene);
  if (body.kind === "star") {
    // Self-emissive PBR — same recipe the cockpit uses for close-mesh
    // stars. Zero albedo + zero direct/environment intensity means
    // the directional sun contributes nothing; all visible colour
    // comes from emissiveTexture × emissiveColor. The high emissive
    // multiplier (Color3 with components > 1) blows past the bloom
    // pipeline's threshold so the star self-glows in the post pass.
    const pbr = new PBRMaterial(`mat:${body.id}`, scene);
    pbr.albedoColor = Color3.Black();
    pbr.metallic = 0;
    pbr.roughness = 1;
    pbr.directIntensity = 0;
    pbr.environmentIntensity = 0;
    // The exposed value (emissive × pipeline.exposure) needs to land
    // a touch above the bloom threshold (1.05) so the disc glows but
    // doesn't fully clip to white. At exposure 1.6 these numbers
    // multiply out to ~(1.12, 0.96, 0.66) — slightly above threshold
    // on red, below on the rest, which lets the spectral warm tint
    // come through while preserving sunspot / granulation detail.
    pbr.emissiveColor = new Color3(0.70, 0.60, 0.42);
    if (colorTex) pbr.emissiveTexture = colorTex;
    base.material = pbr;
  } else {
    const pbr = new PBRMaterial(`mat:${body.id}`, scene);
    if (colorTex) pbr.albedoTexture = colorTex;
    else pbr.albedoColor = body.fallbackColor;
    if (normalTex) {
      pbr.bumpTexture = normalTex;
      // three.js examples ship OpenGL-convention normal maps (+Y up).
      // Babylon's PBR defaults to DirectX (+Y down) so flip Y to keep
      // the lighting on Earth from inverting at the terminator.
      pbr.invertNormalMapY = true;
    }
    pbr.metallic = 0;
    pbr.roughness = (body.kind === "gas_giant" || body.kind === "ice_giant") ? 0.9 : 0.85;
    // directIntensity bumped from the cockpit's 1.0 to 1.6 because in
    // the prototype the body fills most of the frame — ACES tone
    // mapping plus a single directional sun otherwise renders rocky
    // worlds quite dim. The cockpit's 1.0 reads brighter because the
    // body is a small disc against a black backdrop. Anything between
    // 1.2 and 2.0 is reasonable; we keep it on the lower end so the
    // night side stays dark.
    pbr.directIntensity = 1.6;
    pbr.environmentIntensity = 0.5;
    base.material = pbr;
  }

  const out: CurrentBody = { base };

  // Stellar corona — same shader as the atmosphere but with no sun
  // bias (omnidirectional) and a wider falloff, so the glow surrounds
  // the star uniformly. We piggy-back on the `atmosphere` slot since
  // each body has at most one of {atmosphere, corona}.
  if (body.kind === "star") {
    // Corona shell — diameter 2.0 baseline, then per-frame scaled by
    // the `corona-shell` slider. Colour, falloff, and intensity are
    // also live-tunable; see applyTuning().
    const corona = MeshBuilder.CreateSphere(`corona:${body.id}`, { diameter: 2.0, segments: 48 }, scene);
    corona.material = makeAtmoMaterial(scene, {
      name: `coronamat:${body.id}`,
      color: new Color3(1.6, 1.15, 0.55),
      useSunBias: false,
    });
    out.atmosphere = corona;
  }

  // Cloud shell — slightly larger sphere with the cloud map as both
  // albedo and opacity. The cloud JPGs are bright-on-dark, so reading
  // alpha from the RGB luminance gives a clean cutout without needing
  // a separate alpha channel.
  if (cloudTex) {
    const clouds = MeshBuilder.CreateSphere(`clouds:${body.id}`, { diameter: 2.02, segments: 64 }, scene);
    const cmat = new PBRMaterial(`cmat:${body.id}`, scene);
    cmat.albedoTexture = cloudTex;
    cmat.opacityTexture = cloudTex;
    cmat.opacityTexture.getAlphaFromRGB = true;
    cmat.metallic = 0;
    cmat.roughness = 1;
    cmat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    cmat.disableDepthWrite = true;
    cmat.directIntensity = 1.0;
    cmat.environmentIntensity = 0.5;
    clouds.material = cmat;
    out.clouds = clouds;
  }

  // Atmosphere — see `makeAtmoMaterial` / shader source above. Gas
  // giants get a wider/softer halo; rocky worlds get a tight rim.
  if (body.atmoColor) {
    // Atmosphere shell — baseline diameter 2.0 (planet radius); the
    // `atmo-shell` slider scales mesh.scaling every frame so the
    // outer-fade annulus is tunable. All shader uniforms are pushed
    // per-frame in applyTuning(), including the per-body kind-aware
    // falloffPower (rocky vs gas giant).
    const atmo = MeshBuilder.CreateSphere(`atmo:${body.id}`, { diameter: 2.0, segments: 64 }, scene);
    atmo.material = makeAtmoMaterial(scene, {
      name: `amat:${body.id}`,
      color: body.atmoColor,
      useSunBias: true,
    });
    out.atmosphere = atmo;
  }

  // Saturn rings — flat annulus with the alpha-ramp PNG. Disable depth
  // writes so the back of the planet doesn't z-cut through the disc.
  if (ringTex) {
    const rings = buildRingMesh(scene, 1.3, 2.3);
    // Rings reflect the sun rather than self-emit — albedoTexture
    // gives them the sun-following bright/dark halves they should
    // have. We still drive opacity from the same texture (its bright
    // bands are also the dense bands). Roughness=1, metallic=0 makes
    // them matte; a touch of emissive lifts the dark side so the
    // ring doesn't completely disappear in shadow.
    const rmat = new PBRMaterial(`rmat:${body.id}`, scene);
    rmat.albedoTexture = ringTex;
    rmat.opacityTexture = ringTex;
    rmat.opacityTexture.getAlphaFromRGB = true;
    rmat.metallic = 0;
    rmat.roughness = 1;
    rmat.directIntensity = 1.6;
    rmat.environmentIntensity = 0.3;
    rmat.emissiveColor = new Color3(0.05, 0.05, 0.06);
    rmat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    rmat.backFaceCulling = false;
    rmat.disableDepthWrite = true;
    rings.material = rmat;
    rings.rotation.x = -0.45;
    out.rings = rings;
  }

  return out;
}

function disposeBody(b: CurrentBody): void {
  for (const m of [b.base, b.clouds, b.atmosphere, b.rings]) {
    if (!m) continue;
    // dispose(forceDisposeEffect, forceDisposeTextures): keep textures
    // alive — they're held by `texCache` for reuse when the user
    // switches back to a body. Disposing them here invalidates the
    // cached Texture objects and the next switch-back renders blank.
    if (m.material) m.material.dispose(true, false);
    m.dispose();
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

let active: { body: Body; current: CurrentBody } | null = null;
let manifest: Manifest | null = null;
let scene: Scene;

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
  // Clear `active` BEFORE the async build so the render loop's
  // per-frame writes (mesh.rotation, material.alpha) don't touch
  // freshly-disposed meshes during the await on Sun's texture load.
  if (active) {
    disposeBody(active.current);
    active = null;
  }
  const current = await buildBody(scene, body, manifest);
  active = { body, current };

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
    ? `${manifest.attribution} · <a href="#" target="_blank" rel="noopener">source</a>`
    : `No textures fetched — showing fallback colour`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Build the tuning panel FIRST so T()/TS() lookups during scene
  // setup find their inputs. Each control's initial value matches
  // the previous hard-coded baselines.
  buildTuningPanel();

  const engine = makeEngine();
  statusEl.textContent = "WebGL2";

  scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 1);
  scene.useRightHandedSystem = true;

  // ArcRotateCamera — Babylon's drop-in for three.js OrbitControls.
  // Initial framing matches the three.js version's (0, 0.3, 3.2)
  // perspective: ~3 unit radius, slight elevation.
  const camera = new ArcRotateCamera(
    "cam",
    -Math.PI / 2,
    1.27,           // β = ~73° (slight tilt down)
    3.2,
    Vector3.Zero(),
    scene,
  );
  camera.attachControl(canvas, true);
  camera.lowerRadiusLimit = 1.3;
  camera.upperRadiusLimit = 8;
  camera.wheelDeltaPercentage = 0.02;
  camera.minZ = 0.01;
  camera.maxZ = 100;

  // Single directional sun + a faint hemispheric to keep the night
  // side from going pure-black. Intensities mirror three.js prototype.
  const sun = new DirectionalLight("sun", new Vector3(-1, -0.3, -1).normalize(), scene);
  sun.intensity = 3.0;
  const ambient = new HemisphericLight("amb", Vector3.Up(), scene);
  ambient.intensity = 0.05;

  // Bloom + glow — mirrors the cockpit's `DefaultRenderingPipeline`
  // setup (`cockpit-main.ts:1378`-ish). Initial values come from the
  // Pipeline section sliders; live updates are wired below via
  // `wirePipelineHooks(pipeline, glow)` so every knob flows through
  // to the renderer on `input`.
  const pipeline = new DefaultRenderingPipeline("pipeline", true, scene, [camera]);
  pipeline.bloomEnabled = true;
  pipeline.imageProcessingEnabled = true;
  pipeline.imageProcessing.toneMappingEnabled = true;
  const glow = new GlowLayer("glow", scene, { mainTextureRatio: 0.5 });
  wirePipelineHooks(pipeline, glow);

  manifest = await loadManifest();
  if (!manifest) {
    missingBanner.classList.add("show");
    setTimeout(() => missingBanner.classList.remove("show"), 6000);
  }

  buildStarfield(scene);

  buildBodyButtons();
  await selectBody(BODIES[3]);   // Earth as the opening shot

  // Per-frame render: pull every tunable from its slider, push to
  // lights + materials + shader uniforms, then render.
  let last = performance.now();
  engine.runRenderLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // Sun direction from az/el. DirectionalLight.direction points
    // FROM sun TOWARD the surface, so negate the unit position vector.
    const azRad = (T("sun-az") * Math.PI) / 180;
    const elRad = (T("sun-el") * Math.PI) / 180;
    sun.direction.set(
      -Math.cos(elRad) * Math.sin(azRad),
      -Math.sin(elRad),
      -Math.cos(elRad) * Math.cos(azRad),
    );
    sun.intensity = T("sun-intensity");
    ambient.intensity = T("ambient-intensity");

    applyTuning(camera, sun, dt);
    scene.render();
  });

  window.addEventListener("resize", () => engine.resize());
}

// ---------------------------------------------------------------------------
// applyTuning — runs every frame; pushes the current slider values to
// the active body's materials and shader uniforms. Keeping it brute-
// force (re-assigning every property every frame) is simpler than
// dirty-tracking and Babylon is happy with it; setters cache values
// internally and only flag dirty when something actually changed.
// ---------------------------------------------------------------------------
function applyTuning(camera: ArcRotateCamera, sun: DirectionalLight, dt: number): void {
  if (!active) return;
  const spin = T("spin");
  active.current.base.rotation.y += dt * spin * 0.25;

  // Star body — emissive colour live from the Sun/corona sliders.
  // Other PBR fields (metallic/roughness/intensities) are forced to
  // the star "self-emit only" recipe regardless of the planet sliders.
  if (active.body.kind === "star") {
    const m = active.current.base.material as PBRMaterial;
    m.emissiveColor.set(T("sun-emis-r"), T("sun-emis-g"), T("sun-emis-b"));
  } else {
    const m = active.current.base.material as PBRMaterial;
    m.directIntensity = T("pbr-direct");
    m.environmentIntensity = T("pbr-env");
    const isGas = active.body.kind === "gas_giant" || active.body.kind === "ice_giant";
    m.roughness = isGas ? T("pbr-rough-gas") : T("pbr-roughness");
    if (m.bumpTexture) m.bumpTexture.level = T("pbr-bump");
  }

  if (active.current.clouds) {
    active.current.clouds.rotation.y += dt * spin * 0.25 * T("cloud-spin-mult");
    active.current.clouds.scaling.setAll(T("cloud-altitude"));
    const cm = active.current.clouds.material as PBRMaterial;
    cm.alpha = T("cloud-alpha");
  }

  if (active.current.rings) {
    active.current.rings.rotation.x = T("ring-tilt");
    active.current.rings.rotation.y += dt * spin * 0.04;
  }

  if (active.current.atmosphere) {
    // Atmosphere/corona shell scaling + all shader uniforms.
    const isCorona = active.body.kind === "star";
    active.current.atmosphere.scaling.setAll(isCorona ? T("corona-shell") : T("atmo-shell"));
    const m = active.current.atmosphere.material as ShaderMaterial;
    m.setVector3("cameraPosition", camera.globalPosition);
    m.setVector3("lightDirection", sun.direction);
    m.setFloat("intensity", T("atmo"));
    m.setFloat("outerFade", T("atmo-outer-fade"));
    m.setFloat("twilightFloor", T("atmo-twilight"));
    m.setFloat("nightAlpha", T("atmo-night-alpha"));
    if (isCorona) {
      m.setFloat("falloffPower", T("corona-falloff"));
      m.setColor3("atmoColor", new Color3(T("corona-r"), T("corona-g"), T("corona-b")));
    } else {
      const isGas = active.body.kind === "gas_giant" || active.body.kind === "ice_giant";
      m.setFloat("falloffPower", isGas ? T("atmo-falloff-gas") : T("atmo-falloff-rock"));
      // Atmosphere RGB is kept per-body (from body.atmoColor); the
      // sliders cover only the corona to keep the panel scope small.
    }
  }
}

// ---------------------------------------------------------------------------
// wirePipelineHooks — bind `input` events on every Pipeline-section
// control so changes flow into DefaultRenderingPipeline + GlowLayer
// without a render-loop apply (pipeline state isn't per-frame).
// ---------------------------------------------------------------------------
function wirePipelineHooks(pipeline: DefaultRenderingPipeline, glow: GlowLayer): void {
  const apply = () => {
    pipeline.bloomThreshold = T("bloom-thresh");
    pipeline.bloomWeight = T("bloom-weight");
    pipeline.bloomKernel = T("bloom-kernel");
    pipeline.bloomScale = T("bloom-scale");
    const tone = parseInt(TS("tonemap"), 10);
    pipeline.imageProcessing.toneMappingEnabled = tone > 0;
    pipeline.imageProcessing.toneMappingType = tone === 0 ? 0 : tone;
    pipeline.imageProcessing.exposure = T("exposure");
    pipeline.imageProcessing.contrast = T("contrast");
    glow.intensity = T("glow");
  };
  for (const id of ["bloom-thresh","bloom-weight","bloom-kernel","bloom-scale","tonemap","exposure","contrast","glow"]) {
    el(id).addEventListener("input", apply);
  }
  apply();   // seed initial values from the slider defaults
}

main().catch((err) => {
  console.error(err);
  statusEl.innerHTML = `<span class="warn">init failed: ${(err as Error).message}</span>`;
});
