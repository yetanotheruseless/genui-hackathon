/**
 * Solar System multi-body tour. Babylon + PBR, free-fly camera, HYG
 * starfield backdrop. /sol-system.
 *
 * =========================================================================
 * REALISM — what's true to the universe and what's not
 * =========================================================================
 *
 * REAL:
 *   - Planet POSITIONS along their orbits.
 *       Semi-major axes (AU) in BODIES[].distanceAu — Mercury 0.39 …
 *       Neptune 30.1. Orbital ANGLES in BODIES[].orbitAngle are real
 *       J2000 mean longitudes (the angle each planet was at on
 *       2000-01-01); we just don't animate the orbit.
 *   - Planet SURFACE TEXTURES.
 *       Equirectangular NASA-derived maps via Planet Pixel Emporium
 *       (scripts/fetch-planet-textures.ts). 1024×512 each.
 *   - Star FIELD: angles, colors, magnitudes.
 *       Real HYG catalog directions from Sol. Spectral class → RGB
 *       via spectralRgb(); apparent magnitude → brightness via
 *       intensityCurve below.
 *
 * EXAGGERATED:
 *   - Planet SIZES.
 *       BODIES[].visualRadius is hand-tuned for visibility. Real
 *       ratios vs Earth: Mars 0.53×, Earth 1×, Jupiter 11×, Saturn
 *       9.5×, Sun 109×. The values here squash Sun's dominance and
 *       lift terrestrials so the inner system is legible from a few
 *       AU out. At true scale, Earth would be 4.25e-5 AU radius —
 *       invisible at any typical viewing distance.
 *   - Star BRIGHTNESS.
 *       The intensity curve in buildStarfield() is
 *           intensity = max(0.18, min(1, linear^0.20))
 *       where `linear = 10^(-0.4 * mag)` is the physical relative
 *       brightness. The 0.20 exponent COMPRESSES the dynamic range
 *       (real is 1.0, full astronomy); the 0.18 floor LIFTS dim
 *       catalog stars to visible. So Sirius (mag -1.46) and a
 *       mag-6 star differ by ~3× here instead of the real ~100×.
 *   - Backdrop DISTANCE.
 *       STARFIELD_RADIUS = 200 AU. Real catalog stars are at
 *       light-years (~63000 AU and up). Consequences:
 *         * No real parallax as you move (correct for staying near Sol).
 *         * False parallax INTRODUCED if you fly far from origin.
 *           At Neptune's orbit (30 AU), near-side stars are 170 AU
 *           away, far-side 230 AU — a 35% radius asymmetry that
 *           visibly smears the constellations.
 *
 * =========================================================================
 * KNOBS — what to change to dial each axis up or down
 * =========================================================================
 *
 *   DISTANCES (real-AU → compressed)
 *     Multiply BODIES[].distanceAu by a factor. 0.3 puts Neptune at
 *     9u, fits-in-a-glance tour. 1.0 (current) is true AU.
 *
 *   PLANET SIZES (current → real)
 *     Divide BODIES[].visualRadius by 100 to approach real ratios;
 *     then the camera needs to be within ~0.01 AU to see anything
 *     non-Sun. Multiply by 2-5× for a children's-museum dollhouse feel.
 *
 *   STAR BRIGHTNESS (compressed → realistic)
 *     In buildStarfield(): the `Math.pow(linear, 0.20)` exponent.
 *     0.40 → much more separation (faint stars vanish, bright stars
 *     dominate). 0.10 → even more compression than now (everything
 *     about the same visible brightness). 1.0 → physically correct
 *     but ~99 % of the catalog disappears below a single pixel.
 *
 *   STAR FLOOR (sparse → dense)
 *     The 0.18 in `max(0.18, ...)` of buildStarfield's intensity. Drop
 *     to 0.05 for a sparser, more realistic-looking field with only
 *     the bright catalog visible. Raise to 0.30 for a denser but
 *     less differentiated "milky way" feel.
 *
 *   STARFIELD PARALLAX FAITHFULNESS (close backdrop → true distances)
 *     Increase STARFIELD_RADIUS. 200 AU (current) is good for staying
 *     near Sol; 1000 AU is good out to Pluto; 10000 AU is good for the
 *     Oort cloud. 63000 AU ≈ 1 light-year (Proxima's distance). At
 *     1e6+ AU you've matched the catalog's actual scale and parallax
 *     is genuinely negligible until you move ly distances.
 *
 *   PLANET SIZE COMPRESSION CURVE
 *     If you want the size hierarchy to look more "true" without going
 *     to invisible-scale, swap BODIES[].visualRadius for
 *         visualRadius = sqrt(realRadiusKm) * factor
 *     (compresses the 109× Sun-vs-Earth ratio to ~10×).
 *
 * =========================================================================
 *
 * Body picker (top-right): click to fly toward that body. No orbital
 * animation — bodies are static, simplest first pass.
 */
import {
  Camera,
  Color3,
  Color4,
  Constants,
  DefaultRenderingPipeline,
  Effect,
  Engine,
  GlowLayer,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  PointLight,
  Scene,
  ShaderMaterial,
  Texture,
  UniversalCamera,
  Vector3,
  VertexData,
} from "@babylonjs/core";

// ---------------------------------------------------------------------------
// Body catalog. distanceAu = real semi-major axis; visualRadius is
// hand-tuned for visibility (real Sun is 0.0046 AU radius, real Earth
// is 4.3e-5 AU radius — invisible at any reasonable view distance).
// orbitAngle is set per-body so they don't all line up; J2000 mean
// longitudes used as a "for fun" detail, not animated.
// ---------------------------------------------------------------------------
type BodyKind = "star" | "rocky" | "ocean_world" | "gas_giant" | "ice_giant";
type Body = {
  id: string;
  name: string;
  kind: BodyKind;
  distanceAu: number;       // real semi-major axis (Sun: 0)
  orbitAngle: number;       // radians; J2000 mean longitude
  visualRadius: number;     // scene units
  hasClouds?: boolean;
  hasRings?: boolean;
  atmoColor?: Color3;
};

const c3 = (hex: number) => new Color3(((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255);

const BODIES: Body[] = [
  { id: "sun",     name: "Sun",     kind: "star",        distanceAu: 0.00, orbitAngle: 0,    visualRadius: 0.20 },
  { id: "mercury", name: "Mercury", kind: "rocky",       distanceAu: 0.39, orbitAngle: 4.40, visualRadius: 0.025 },
  { id: "venus",   name: "Venus",   kind: "rocky",       distanceAu: 0.72, orbitAngle: 3.16, visualRadius: 0.050, hasClouds: true, atmoColor: c3(0xffe9aa) },
  { id: "earth",   name: "Earth",   kind: "ocean_world", distanceAu: 1.00, orbitAngle: 1.74, visualRadius: 0.055, hasClouds: true, atmoColor: c3(0x88c8ff) },
  { id: "mars",    name: "Mars",    kind: "rocky",       distanceAu: 1.52, orbitAngle: 6.20, visualRadius: 0.040, atmoColor: c3(0xff8b5a) },
  { id: "jupiter", name: "Jupiter", kind: "gas_giant",   distanceAu: 5.20, orbitAngle: 0.59, visualRadius: 0.200, atmoColor: c3(0xfff0d0) },
  { id: "saturn",  name: "Saturn",  kind: "gas_giant",   distanceAu: 9.54, orbitAngle: 0.87, visualRadius: 0.170, hasRings: true, atmoColor: c3(0xfff2c8) },
  { id: "uranus",  name: "Uranus",  kind: "ice_giant",   distanceAu: 19.2, orbitAngle: 5.48, visualRadius: 0.110, atmoColor: c3(0xa6e2ee) },
  { id: "neptune", name: "Neptune", kind: "ice_giant",   distanceAu: 30.1, orbitAngle: 5.31, visualRadius: 0.110, atmoColor: c3(0x88aaff) },
];

function bodyPosition(body: Body): Vector3 {
  // Lay everything on the ecliptic plane (y=0) at its real distance,
  // angle from +X axis. Sun at origin.
  return new Vector3(
    body.distanceAu * Math.cos(body.orbitAngle),
    0,
    body.distanceAu * Math.sin(body.orbitAngle),
  );
}

// ---------------------------------------------------------------------------
// Texture manifest — same /textures.json + /textures/* layout the
// planet-prototype uses.
// ---------------------------------------------------------------------------
type Manifest = { bodies: Record<string, Partial<Record<"color" | "clouds" | "ring" | "bump" | "normal", string>>> };

async function loadManifest(): Promise<Manifest | null> {
  try {
    const r = await fetch("/textures.json");
    if (!r.ok) return null;
    return await r.json() as Manifest;
  } catch { return null; }
}

const texCache = new Map<string, Texture>();
function loadTexture(url: string, scene: Scene, isData = false): Promise<Texture> {
  const cached = texCache.get(url);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const tex = new Texture(
      url, scene, false, false, Texture.TRILINEAR_SAMPLINGMODE,
      () => { texCache.set(url, tex); resolve(tex); },
      (_m, err) => reject(err),
    );
    if (isData) tex.gammaSpace = false;
  });
}

// ---------------------------------------------------------------------------
// Starfield — HYG catalog projected onto a sphere at backdrop radius.
// Same shader as the planet-prototype version; see /api/bright route.
// ---------------------------------------------------------------------------
Effect.ShadersStore["sf2VertexShader"] =
  "precision highp float;" +
  "attribute vec3 position;" +
  "attribute vec4 color;" +
  "uniform mat4 worldViewProjection;" +
  "varying vec3 vRgb;" +
  "void main(){" +
  "  vRgb = color.rgb;" +
  "  gl_Position = worldViewProjection * vec4(position, 1.0);" +
  "  gl_PointSize = max(1.0, color.a * 8.0);" +
  "}";
Effect.ShadersStore["sf2FragmentShader"] =
  "precision highp float;" +
  "varying vec3 vRgb;" +
  "void main(){" +
  "  vec2 uv = gl_PointCoord - 0.5;" +
  "  float a = smoothstep(0.5, 0.0, length(uv));" +
  "  gl_FragColor = vec4(vRgb, a);" +
  "}";

function spectralRgb(sc: string | undefined): [number, number, number] {
  switch (sc) {
    case "O":  return [0.65, 0.78, 1.00];
    case "B":  return [0.78, 0.88, 1.00];
    case "A":  return [1.00, 1.00, 1.00];
    case "F":  return [1.00, 0.97, 0.85];
    case "G":  return [1.00, 0.92, 0.70];
    case "K":  return [1.00, 0.75, 0.45];
    case "M":  return [1.00, 0.50, 0.30];
    case "WD": return [0.95, 0.95, 1.00];
    case "NS": return [0.80, 0.95, 1.00];
    case "L": case "T": case "Y": return [0.45, 0.20, 0.15];
    default:   return [1.00, 0.92, 0.70];
  }
}

type BrightStar = [string, number, number, number, string, number, number];
const STARFIELD_RADIUS = 200;    // larger than Neptune at 30 — backdrop always behind every body

async function buildStarfield(scene: Scene): Promise<void> {
  let stars: BrightStar[] = [];
  try {
    const r = await fetch("/api/bright");
    if (r.ok) {
      const data = await r.json() as { stars?: BrightStar[] };
      stars = data.stars ?? [];
    }
  } catch (e) { console.warn("[sol-system] /api/bright failed:", e); }
  if (stars.length === 0) {
    console.warn("[sol-system] empty catalog — run scripts/fetch-hyg.ts");
    return;
  }
  const positions: number[] = [];
  const colors: number[] = [];
  for (const s of stars) {
    const [, x, y, z, sc, mag] = s;
    const len = Math.hypot(x, y, z);
    if (len < 1e-6) continue;  // skip Sol (catalog origin = our scene origin)
    const k = STARFIELD_RADIUS / len;
    positions.push(x * k, y * k, z * k);
    const [r, g, b] = spectralRgb(sc);
    const linear = Math.pow(10, -0.4 * (mag ?? 6));
    const intensity = Math.max(0.18, Math.min(1, Math.pow(linear, 0.20)));
    const sizeHint = Math.max(1, Math.min(4, 4 - (mag ?? 6) * 0.4));
    colors.push(r * intensity, g * intensity, b * intensity, sizeHint / 8);
  }
  const mesh = new Mesh("starfield", scene);
  const vd = new VertexData();
  vd.positions = positions;
  vd.colors = colors;
  vd.applyToMesh(mesh);
  mesh.setVerticesData("color", colors, false, 4);
  const mat = new ShaderMaterial("sf2Mat", scene,
    { vertex: "sf2", fragment: "sf2" },
    { attributes: ["position", "color"], uniforms: ["worldViewProjection"], needAlphaBlending: true },
  );
  mat.pointsCloud = true;
  mat.backFaceCulling = false;
  mat.disableDepthWrite = true;
  mat.alphaMode = Constants.ALPHA_ADD;
  mesh.material = mat;
  mesh.renderingGroupId = 0;
  mesh.isPickable = false;
}

// ---------------------------------------------------------------------------
// Sun + planet construction. Sun is self-emissive (matches the cockpit's
// close-mesh star recipe); planets are PBR-shaded with metallic=0,
// roughness=0.85 (rocky) or 0.9 (gas), the same conventions as
// cockpit-main.ts and planet-prototype-main.ts.
// ---------------------------------------------------------------------------
async function buildBody(scene: Scene, body: Body, manifest: Manifest | null): Promise<Mesh> {
  const slots = manifest?.bodies[body.id] ?? {};
  const mesh = MeshBuilder.CreateSphere(body.id, { diameter: body.visualRadius * 2, segments: 48 }, scene);
  mesh.position = bodyPosition(body);

  const colorTex = slots.color ? await loadTexture(slots.color, scene).catch(() => null) : null;
  const bumpTex  = slots.normal ? await loadTexture(slots.normal, scene, true).catch(() => null)
                  : slots.bump ? await loadTexture(slots.bump, scene, true).catch(() => null)
                  : null;

  if (body.kind === "star") {
    const pbr = new PBRMaterial(`mat:${body.id}`, scene);
    pbr.albedoColor = Color3.Black();
    pbr.metallic = 0;
    pbr.roughness = 1;
    pbr.directIntensity = 0;
    pbr.environmentIntensity = 0;
    pbr.emissiveColor = new Color3(1.4, 1.1, 0.7);
    if (colorTex) pbr.emissiveTexture = colorTex;
    mesh.material = pbr;
    return mesh;
  }
  const pbr = new PBRMaterial(`mat:${body.id}`, scene);
  if (colorTex) pbr.albedoTexture = colorTex;
  else pbr.albedoColor = c3(0x666666);
  if (bumpTex) { pbr.bumpTexture = bumpTex; pbr.invertNormalMapY = true; }
  pbr.metallic = 0;
  pbr.roughness = (body.kind === "gas_giant" || body.kind === "ice_giant") ? 0.9 : 0.85;
  pbr.directIntensity = 1.6;
  pbr.environmentIntensity = 0.15;
  mesh.material = pbr;
  return mesh;
}

// ---------------------------------------------------------------------------
// Camera fly-to. When the user clicks a body, slerp position to a
// pleasing viewpoint near it over ~700ms. Doesn't lock orientation
// (free-fly stays free) — just translates.
// ---------------------------------------------------------------------------
function flyToBody(camera: UniversalCamera, scene: Scene, body: Body): void {
  const target = bodyPosition(body);
  // Stand-off distance: 4× the body's visual radius, capped to 0.8u
  // so the gas giants don't push you too far away.
  const standoff = Math.max(body.visualRadius * 4, 0.3);
  const finalPos = target.add(new Vector3(0, body.visualRadius * 0.6, standoff));
  const startPos = camera.position.clone();
  const t0 = performance.now();
  const dur = 700;
  const observer = scene.onBeforeRenderObservable.add(() => {
    const t = Math.min(1, (performance.now() - t0) / dur);
    // Cubic ease-in-out.
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    camera.position = Vector3.Lerp(startPos, finalPos, e);
    camera.setTarget(target);
    if (t >= 1) scene.onBeforeRenderObservable.remove(observer);
  });
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const canvas = document.getElementById("canvas") as HTMLCanvasElement;
  const statusEl = document.getElementById("status") as HTMLElement;
  const bodyListEl = document.getElementById("body-list") as HTMLElement;
  const missingBanner = document.getElementById("missing-banner") as HTMLElement;

  const engine = new Engine(canvas, true, { stencil: true, antialias: true }, true);
  statusEl.textContent = "WebGL2";
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 1);
  scene.useRightHandedSystem = true;

  // Free-fly camera: spawn 5 units back + a touch above the ecliptic
  // plane so the inner planets and Sun are visible without scrolling.
  const camera = new UniversalCamera("cam", new Vector3(2.5, 1.5, 4.5), scene);
  camera.setTarget(Vector3.Zero());
  camera.attachControl(canvas, true);
  camera.speed = 0.08;
  camera.angularSensibility = 4000;
  camera.inertia = 0.85;
  camera.keysUp.push(87); camera.keysDown.push(83);
  camera.keysLeft.push(65); camera.keysRight.push(68);
  camera.keysUpward.push(32);   // Space = up
  camera.keysDownward.push(67); // C = down
  camera.minZ = 0.01;
  camera.maxZ = STARFIELD_RADIUS * 1.5;

  // Shift = boost. Babylon doesn't have built-in modifier-key speed
  // scaling; do it manually.
  const baseSpeed = camera.speed;
  window.addEventListener("keydown", (e) => { if (e.key === "Shift") camera.speed = baseSpeed * 4; });
  window.addEventListener("keyup",   (e) => { if (e.key === "Shift") camera.speed = baseSpeed; });

  // Sun as a point light at origin — illuminates every planet from
  // its real direction. Range is huge so Neptune still gets some
  // light. Intensity high since the planets are tiny.
  const sun = new PointLight("sunlight", Vector3.Zero(), scene);
  sun.intensity = 8;
  sun.range = 100;
  // Faint hemispheric so the night side isn't pure black (matches
  // planet-prototype convention).
  const amb = new HemisphericLight("amb", Vector3.Up(), scene);
  amb.intensity = 0.05;

  // Bloom + glow — same DefaultRenderingPipeline recipe as the
  // prototype, so the Sun and bright stars glare correctly.
  const pipeline = new DefaultRenderingPipeline("pipeline", true, scene, [camera]);
  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = 0.9;
  pipeline.bloomWeight = 0.4;
  pipeline.bloomKernel = 64;
  pipeline.imageProcessingEnabled = true;
  pipeline.imageProcessing.toneMappingEnabled = true;
  pipeline.imageProcessing.exposure = 1.3;
  new GlowLayer("glow", scene, { mainTextureRatio: 0.5 });

  const manifest = await loadManifest();
  if (!manifest) {
    missingBanner.classList.add("show");
  }

  // Build everything.
  await buildStarfield(scene);
  for (const body of BODIES) {
    await buildBody(scene, body, manifest);
  }

  // Body picker UI.
  for (const body of BODIES) {
    const btn = document.createElement("button");
    btn.textContent = body.name;
    btn.addEventListener("click", () => {
      for (const b of bodyListEl.querySelectorAll("button")) b.classList.remove("active");
      btn.classList.add("active");
      flyToBody(camera, scene, body);
    });
    bodyListEl.appendChild(btn);
  }

  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());

  statusEl.textContent = `WebGL2 · ${BODIES.length} bodies · starfield ${manifest ? "+ textures" : "(no textures)"}`;
}

void main();
