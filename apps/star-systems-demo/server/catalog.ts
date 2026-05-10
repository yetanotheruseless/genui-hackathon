/**
 * Full-catalog loader: HYG v4.1 (~120k stars) joined with the NASA
 * Exoplanet Archive (~6.3k planets across ~4.7k systems), unified with
 * the curated 21-star set from astrodata.ts.
 *
 * What lives here vs astrodata.ts:
 *   astrodata.ts   – 21 hand-tuned named stars (Sol, Vega, Betelgeuse…)
 *                    with Banks-friendly ids ("alpha_centauri_a") and
 *                    full curated planet lists. Always pushed to the
 *                    cockpit on spawn.
 *   catalog.ts     – the everything-else 120k. Server-only. Queryable
 *                    by the Mind via find_systems / pin_star. Mostly
 *                    serves the chunk-paging + pinned-star surfaces.
 *
 * Curated entries take precedence at merge time: when a HYG star's
 * proper name matches a curated star (case-insensitive, also against
 * alts), the curated record wins and the HYG entry is dropped.
 *
 * Exoplanet records join to HYG via host HIP first, then host HD as
 * fallback. About 90% of NASA hosts carry a HIP; the rest are mostly
 * Kepler / TESS / 2MASS designations that HYG doesn't cover at all,
 * and we drop those quietly.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { LumClass, Planet, PlanetKind, SpectralClass, Star } from "./astrodata.js";
import { approxRadiusSolar } from "./astrodata.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CatalogStar = {
  id: string;
  name: string;
  alt?: string[];
  position: [number, number, number];
  spectralClass: SpectralClass;
  lumClass: LumClass;
  spectralType: string;
  distanceLy: number | null;
  apparentMag?: number;
  absMag?: number;
  luminosity?: number;
  radiusSolar?: number;
  constellation?: string | null;
  description?: string;
  planets?: Planet[];
  /** True iff the entry comes from the hand-curated astrodata.ts set. */
  curated: boolean;
};

export type FullCatalog = {
  /** All stars, curated + HYG-minus-collisions. */
  stars: CatalogStar[];
  byId: Map<string, CatalogStar>;
  /** Stars with at least one known planet. */
  withPlanets: CatalogStar[];
  /** Pre-bucketed: chunkKey → stars in that 50ly cube. */
  byChunk: Map<string, CatalogStar[]>;
  /** Bright landmarks visible from anywhere (apparentMag ≤ 2.5 OR absMag ≤ 0). */
  bright: CatalogStar[];
  /** Indexed by planet kind: stars hosting at least one planet of that kind. */
  byPlanetKind: Map<PlanetKind, CatalogStar[]>;
  /** Stats for logging at boot. */
  stats: { hyg: number; exo: number; curated: number; merged: number; brights: number };
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Spatial-chunk edge length in light-years. Picked so that:
 *   - near-Sol stellar neighborhood (~stars/ly³ * volume) ≈ 12 stars/chunk.
 *   - a 3×3×3 prefetch around the player loads ~324 stars on average.
 * Both numbers fit comfortably under typical "render this many sprites"
 * budgets on the cockpit side.
 */
export const CHUNK_SIZE_LY = 50;

const APPARENT_MAG_BRIGHT = 2.5;
const ABS_MAG_BRIGHT = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function chunkCoords(pos: [number, number, number]): [number, number, number] {
  return [
    Math.floor(pos[0] / CHUNK_SIZE_LY),
    Math.floor(pos[1] / CHUNK_SIZE_LY),
    Math.floor(pos[2] / CHUNK_SIZE_LY),
  ];
}

export function chunkKey(c: [number, number, number]): string {
  return `${c[0]},${c[1]},${c[2]}`;
}

function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

type HygRaw = {
  id: string;
  name: string;
  alt?: string[];
  position: [number, number, number];
  spectralClass: string;
  lumClass: string;
  spectralType: string;
  distanceLy: number | null;
  apparentMag?: number;
  absMag?: number;
  colorIndex?: number;
  luminosity?: number;
  constellation?: string | null;
  hyg: { id: number; hip: number | null; hd: number | null };
  description?: string;
};

type ExoSystem = {
  hostname: string;
  ra: number;
  dec: number;
  distanceLy: number | null;
  starCount: number;
  planetCount: number;
  hostHip: number | null;
  hostHd: number | null;
  starSpectralType?: string | null;
  starTeffK?: number | null;
  starMassSun?: number | null;
  starRadiusSun?: number | null;
  planets: Array<{
    name: string;
    kind: PlanetKind;
    massEarths: number | null;
    radiusEarths: number | null;
    orbitAU: number | null;
    periodDays: number | null;
    equilibTempK: number | null;
    insolationEarths: number | null;
    discoveryMethod?: string;
    discoveryYear?: number;
    notes?: string;
  }>;
};

function isBright(s: CatalogStar): boolean {
  if (s.apparentMag !== undefined && s.apparentMag <= APPARENT_MAG_BRIGHT) return true;
  if (s.absMag !== undefined && s.absMag <= ABS_MAG_BRIGHT) return true;
  return false;
}

function fromHyg(h: HygRaw, planets: Planet[] | undefined): CatalogStar {
  const sc = (h.spectralClass || "?") as SpectralClass;
  const lc = (h.lumClass || "V") as LumClass;
  return {
    id: h.id,
    name: h.name,
    alt: h.alt,
    position: h.position,
    spectralClass: sc,
    lumClass: lc,
    spectralType: h.spectralType,
    distanceLy: h.distanceLy,
    apparentMag: h.apparentMag,
    absMag: h.absMag,
    luminosity: h.luminosity,
    radiusSolar: approxRadiusSolar(sc, lc),
    constellation: h.constellation,
    description: h.description,
    planets,
    curated: false,
  };
}

function fromCurated(s: Star): CatalogStar {
  return {
    id: s.id,
    name: s.name,
    alt: s.alt,
    position: s.position,
    spectralClass: s.spectralClass,
    lumClass: s.lumClass,
    spectralType: s.spectralType,
    distanceLy: s.distanceLy,
    apparentMag: s.apparentMag,
    radiusSolar: s.radiusSolar ?? approxRadiusSolar(s.spectralClass, s.lumClass),
    description: s.description,
    planets: s.planets,
    curated: true,
  };
}

export function loadFullCatalog(dataDir: string, curated: Star[]): FullCatalog {
  const t0 = Date.now();
  const hygPath = path.join(dataDir, "hyg.json");
  const exoPath = path.join(dataDir, "exoplanets.json");

  const hygRaw: HygRaw[] = JSON.parse(fs.readFileSync(hygPath, "utf-8"));
  const exoRaw = JSON.parse(fs.readFileSync(exoPath, "utf-8")) as { systems: ExoSystem[] };

  // Index exoplanet hosts by HIP and HD for join.
  const exoByHip = new Map<number, ExoSystem>();
  const exoByHd = new Map<number, ExoSystem>();
  let exoMatched = 0;
  for (const sys of exoRaw.systems) {
    if (sys.hostHip != null) exoByHip.set(sys.hostHip, sys);
    if (sys.hostHd != null) exoByHd.set(sys.hostHd, sys);
  }

  // Curated names (lowercased, including alts) — used to drop colliding
  // HYG entries so we don't end up with two Vegas.
  const curatedNames = new Set<string>();
  for (const c of curated) {
    curatedNames.add(normalizeName(c.name));
    for (const a of c.alt ?? []) curatedNames.add(normalizeName(a));
  }

  const stars: CatalogStar[] = [];

  // Curated first so they own their ids.
  for (const c of curated) stars.push(fromCurated(c));

  // HYG, dropping name collisions with curated (and dropping HYG's own
  // "Sol" since astrodata also has it). Also skip HYG entries with a
  // null position or unknown distance — they can't be placed.
  for (const h of hygRaw) {
    if (curatedNames.has(normalizeName(h.name))) continue;
    if (h.id === "sol") continue;
    if (h.distanceLy == null) continue;
    let planets: Planet[] | undefined;
    let exo: ExoSystem | undefined;
    if (h.hyg.hip != null) exo = exoByHip.get(h.hyg.hip);
    if (!exo && h.hyg.hd != null) exo = exoByHd.get(h.hyg.hd);
    if (exo) {
      exoMatched++;
      planets = exo.planets.map((p) => ({
        name: p.name,
        kind: p.kind,
        massEarths: p.massEarths ?? undefined,
        orbitAU: p.orbitAU ?? undefined,
        notes: p.notes,
      }));
    }
    stars.push(fromHyg(h, planets));
  }

  // Indexes.
  const byId = new Map<string, CatalogStar>();
  const byChunk = new Map<string, CatalogStar[]>();
  const byPlanetKind = new Map<PlanetKind, CatalogStar[]>();
  const withPlanets: CatalogStar[] = [];
  const bright: CatalogStar[] = [];

  for (const s of stars) {
    byId.set(s.id, s);
    const ck = chunkKey(chunkCoords(s.position));
    let bucket = byChunk.get(ck);
    if (!bucket) { bucket = []; byChunk.set(ck, bucket); }
    bucket.push(s);
    if (s.planets && s.planets.length) {
      withPlanets.push(s);
      const seenKinds = new Set<PlanetKind>();
      for (const p of s.planets) {
        if (seenKinds.has(p.kind)) continue;
        seenKinds.add(p.kind);
        let kindBucket = byPlanetKind.get(p.kind);
        if (!kindBucket) { kindBucket = []; byPlanetKind.set(p.kind, kindBucket); }
        kindBucket.push(s);
      }
    }
    if (isBright(s)) bright.push(s);
  }

  const ms = Date.now() - t0;
  const stats = {
    hyg: hygRaw.length,
    exo: exoRaw.systems.length,
    curated: curated.length,
    merged: stars.length,
    brights: bright.length,
  };
  console.log(
    `[catalog] loaded ${stats.merged} stars (${stats.curated} curated + ${stats.merged - stats.curated} HYG; ${exoMatched} exo-joins) in ${ms}ms; chunks=${byChunk.size}, withPlanets=${withPlanets.length}, bright=${stats.brights}`,
  );
  // First-load bucket sanity: name a couple of high-magnitude landmarks
  // we expect to be in the bright list, just so we notice if a future
  // catalog refresh changes column semantics.
  if (process.env.CATALOG_DEBUG === "1") {
    for (const probe of ["Sirius", "Vega", "Betelgeuse", "Rigel", "Antares"]) {
      const hit = bright.find((s) => normalizeName(s.name) === normalizeName(probe));
      console.log(`  bright probe ${probe}: ${hit ? "yes (id=" + hit.id + ")" : "MISSING"}`);
    }
  }
  return { stars, byId, withPlanets, byChunk, bright, byPlanetKind, stats };
}

// ---------------------------------------------------------------------------
// Query — used by `find_systems` and similar tools.
// ---------------------------------------------------------------------------

export type FindSystemsArgs = {
  hasPlanetKinds?: PlanetKind[];
  excludeIds?: string[];
  spectralClasses?: SpectralClass[];
  /** ly position to measure from. Defaults to Sol [0,0,0]. */
  nearPosition?: [number, number, number];
  maxDistanceLy?: number;
  sort?: "distance_to_origin" | "distance_to_position" | "luminosity";
  limit?: number;
  /** If true, only return stars that are in the catalog's `withPlanets` set. */
  requirePlanets?: boolean;
};

export type FindSystemsResult = {
  id: string;
  name: string;
  spectralType: string;
  distanceLyFromOrigin: number | null;
  distanceLyFromQuery?: number;
  planetCount: number;
  planetKinds: PlanetKind[];
  position: [number, number, number];
};

export function findSystems(cat: FullCatalog, args: FindSystemsArgs): FindSystemsResult[] {
  const exclude = new Set(args.excludeIds ?? []);
  const requireKinds = args.hasPlanetKinds && args.hasPlanetKinds.length > 0;
  const requirePlanets = args.requirePlanets || requireKinds;
  const classes = args.spectralClasses && args.spectralClasses.length > 0
    ? new Set(args.spectralClasses)
    : null;
  const near = args.nearPosition;
  const limit = Math.min(args.limit ?? 20, 200);

  // Pre-filter the candidate pool.
  const pool = requirePlanets ? cat.withPlanets : cat.stars;

  type Scored = FindSystemsResult & { _sort: number };
  const out: Scored[] = [];
  for (const s of pool) {
    if (exclude.has(s.id)) continue;
    if (classes && !classes.has(s.spectralClass)) continue;
    if (requireKinds) {
      const kinds = new Set((s.planets ?? []).map((p) => p.kind));
      let ok = true;
      for (const k of args.hasPlanetKinds!) if (!kinds.has(k)) { ok = false; break; }
      if (!ok) continue;
    }
    let dQuery: number | undefined;
    if (near) {
      dQuery = Math.hypot(
        s.position[0] - near[0],
        s.position[1] - near[1],
        s.position[2] - near[2],
      );
      if (args.maxDistanceLy != null && dQuery > args.maxDistanceLy) continue;
    } else if (args.maxDistanceLy != null && s.distanceLy != null && s.distanceLy > args.maxDistanceLy) {
      continue;
    }
    let sortKey: number;
    switch (args.sort ?? "distance_to_origin") {
      case "distance_to_position":
        sortKey = dQuery ?? Number.POSITIVE_INFINITY;
        break;
      case "luminosity":
        sortKey = -(s.luminosity ?? 0);
        break;
      case "distance_to_origin":
      default:
        sortKey = s.distanceLy ?? Number.POSITIVE_INFINITY;
        break;
    }
    const planetKinds = Array.from(new Set((s.planets ?? []).map((p) => p.kind)));
    out.push({
      id: s.id,
      name: s.name,
      spectralType: s.spectralType,
      distanceLyFromOrigin: s.distanceLy,
      distanceLyFromQuery: dQuery,
      planetCount: s.planets?.length ?? 0,
      planetKinds,
      position: s.position,
      _sort: sortKey,
    });
  }
  out.sort((a, b) => a._sort - b._sort);
  return out.slice(0, limit).map(({ _sort, ...r }) => { void _sort; return r; });
}

/** Stars in a single chunk — for cockpit chunk paging. */
export function getChunk(cat: FullCatalog, c: [number, number, number]): CatalogStar[] {
  return cat.byChunk.get(chunkKey(c)) ?? [];
}

/** Stars in a 3×3×3 region around the given chunk (or any radius). */
export function getChunkRegion(
  cat: FullCatalog,
  center: [number, number, number],
  radius: number = 1,
): CatalogStar[] {
  const out: CatalogStar[] = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const k = chunkKey([center[0] + dx, center[1] + dy, center[2] + dz]);
        const bucket = cat.byChunk.get(k);
        if (bucket) out.push(...bucket);
      }
    }
  }
  return out;
}
