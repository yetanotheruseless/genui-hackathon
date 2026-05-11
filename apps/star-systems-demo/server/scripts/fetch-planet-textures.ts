/**
 * Fetch a curated set of equirectangular planet surface textures into
 * `data/textures/` and write a manifest to `data/textures.json`.
 *
 * Sources:
 *   - JHT's Planetary Pixel Emporium (planetpixelemporium.com) — NASA-derived
 *     Solar System surface maps; released to the public domain by the author.
 *     Equirectangular 1024×512 (the "1k" variants), nicely tiled at the poles.
 *   - three.js examples (mrdoob/three.js, MIT) — Earth normal + specular,
 *     handy ancillary maps the PPE set doesn't include.
 *
 * The textures map directly onto a Three.js SphereGeometry with no
 * projection fixup. ~150-350 KB per file, enough detail for a sphere
 * taking up half the viewport.
 *
 * Idempotent: existing files are skipped on rerun. To force a refresh,
 * `rm -rf data/textures data/textures.json && npx tsx scripts/fetch-planet-textures.ts`.
 *
 * Run from server/:  `npx tsx scripts/fetch-planet-textures.ts`
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const TEX_DIR = path.join(ROOT, "data", "textures");
const MANIFEST_PATH = path.join(ROOT, "data", "textures.json");

// PPE's download URL is a PHP wrapper that serves `application/octet-stream`,
// not `image/jpeg`, so we validate by magic bytes instead of content-type.
const PPE = "https://planetpixelemporium.com/download/download.php";
const THREE_GH = "https://raw.githubusercontent.com/mrdoob/three.js/r170/examples/textures/planets";

/**
 * Catalog of textures to fetch. `kind` is the shading slot the file
 * fills; `body` is the catalog key used by the prototype renderer.
 */
type TextureKind = "color" | "clouds" | "ring" | "bump" | "normal";
type TextureEntry = {
  body: string;
  kind: TextureKind;
  file: string;     // local filename
  url: string;      // remote URL
};

const ENTRIES: TextureEntry[] = [
  { body: "sun",     kind: "color", file: "sun.jpg",          url: `${PPE}?sunmap.jpg` },
  { body: "mercury", kind: "color", file: "mercury.jpg",      url: `${PPE}?mercurymap.jpg` },
  { body: "mercury", kind: "bump",  file: "mercury_bump.jpg",  url: `${PPE}?mercurybump.jpg` },
  { body: "venus",   kind: "color", file: "venus_surface.jpg",url: `${PPE}?venusmap.jpg` },
  { body: "venus",   kind: "clouds",file: "venus_clouds.jpg", url: `${PPE}?venusbump.jpg` },
  { body: "earth",   kind: "color", file: "earth_day.jpg",    url: `${PPE}?earthmap1k.jpg` },
  { body: "earth",   kind: "clouds",file: "earth_clouds.jpg", url: `${PPE}?earthcloudmap.jpg` },
  { body: "earth",   kind: "bump",  file: "earth_bump.jpg",   url: `${PPE}?earthbump1k.jpg` },
  { body: "earth",   kind: "normal",file: "earth_normal.jpg", url: `${THREE_GH}/earth_normal_2048.jpg` },
  { body: "moon",    kind: "color", file: "moon.jpg",         url: `${PPE}?moonmap1k.jpg` },
  { body: "moon",    kind: "bump",  file: "moon_bump.jpg",    url: `${PPE}?moonbump1k.jpg` },
  { body: "mars",    kind: "color", file: "mars.jpg",         url: `${PPE}?marsmap1k.jpg` },
  { body: "mars",    kind: "bump",  file: "mars_bump.jpg",    url: `${PPE}?marsbump1k.jpg` },
  { body: "jupiter", kind: "color", file: "jupiter.jpg",      url: `${PPE}?jupitermap.jpg` },
  { body: "saturn",  kind: "color", file: "saturn.jpg",       url: `${PPE}?saturnmap.jpg` },
  { body: "saturn",  kind: "ring",  file: "saturn_ring.png",  url: `${PPE}?saturnringpattern.gif` },
  { body: "uranus",  kind: "color", file: "uranus.jpg",       url: `${PPE}?uranusmap.jpg` },
  { body: "neptune", kind: "color", file: "neptune.jpg",      url: `${PPE}?neptunemap.jpg` },
];

/**
 * Returns the detected mime type from magic bytes, or null if unknown.
 * This is how we tell whether the server actually served an image (vs.
 * an HTML error page or empty body that happens to come back with HTTP
 * 200 due to bot protection).
 */
function detectImageType(buf: Buffer): "jpeg" | "png" | "gif" | null {
  if (buf.length < 8) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "gif";
  return null;
}

async function downloadOne(e: TextureEntry): Promise<{ skipped: boolean; bytes: number }> {
  const dest = path.join(TEX_DIR, e.file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 4096) {
    // Existing file is plausibly real; skip. (Tiny placeholders from a
    // failed earlier run get re-downloaded.)
    return { skipped: true, bytes: fs.statSync(dest).size };
  }
  const res = await fetch(e.url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${e.url} → ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const imageType = detectImageType(buf);
  if (!imageType) {
    throw new Error(
      `${e.url} → server returned ${buf.length} bytes that isn't an image ` +
      `(first bytes: ${buf.slice(0, 16).toString("hex")}). ` +
      `If you've been hitting this repeatedly the source may have added bot protection.`,
    );
  }
  fs.writeFileSync(dest, buf);
  return { skipped: false, bytes: buf.length };
}

type Manifest = {
  source: string;
  license: string;
  fetchedAt: string;
  attribution: string;
  bodies: Record<string, Partial<Record<TextureKind, string>>>;
};

async function main() {
  fs.mkdirSync(TEX_DIR, { recursive: true });
  process.stderr.write(`fetching ${ENTRIES.length} textures → ${TEX_DIR}\n`);

  let failed = 0;
  for (const e of ENTRIES) {
    try {
      const { skipped, bytes } = await downloadOne(e);
      const tag = skipped ? "skip" : "ok  ";
      process.stderr.write(`  [${tag}] ${e.file.padEnd(24)} ${(bytes / 1024).toFixed(0).padStart(5)} KB   ${e.body}/${e.kind}\n`);
    } catch (err) {
      failed++;
      process.stderr.write(`  [FAIL] ${e.file.padEnd(24)}              ${e.body}/${e.kind}\n`);
      process.stderr.write(`         ${(err as Error).message}\n`);
    }
  }

  const bodies: Manifest["bodies"] = {};
  for (const e of ENTRIES) {
    // Only list textures we actually fetched.
    const fp = path.join(TEX_DIR, e.file);
    if (!fs.existsSync(fp) || fs.statSync(fp).size <= 4096) continue;
    (bodies[e.body] ??= {})[e.kind] = `/textures/${e.file}`;
  }
  const manifest: Manifest = {
    source: "Planetary Pixel Emporium (planetpixelemporium.com) + three.js examples",
    license: "Public domain (PPE) / MIT (three.js)",
    attribution: "Solar System maps © James Hastings-Trew (public domain). Earth normal map from three.js examples (MIT).",
    fetchedAt: new Date().toISOString(),
    bodies,
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  process.stderr.write(`wrote manifest → ${MANIFEST_PATH} (${Object.keys(bodies).length} bodies)\n`);
  if (failed > 0) {
    process.stderr.write(`note: ${failed} downloads failed; rerun to retry\n`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
