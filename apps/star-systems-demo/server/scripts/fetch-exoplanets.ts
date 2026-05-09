/**
 * Fetch all confirmed planets from the NASA Exoplanet Archive TAP service
 * (`pscomppars` — Planetary Systems Composite Parameters; one row per
 * planet, with the most reliable composite values from across the
 * literature). Transformed into a Planet shape compatible with
 * astrodata.ts, indexed by host star, written to
 * server/data/exoplanets.json.
 *
 * Endpoint: https://exoplanetarchive.ipac.caltech.edu/TAP/sync
 * Docs:     https://exoplanetarchive.ipac.caltech.edu/docs/TAP/usingTAP.html
 *
 * Output shape
 * ------------
 * {
 *   fetchedAt: ISO-8601,
 *   count: number,
 *   systems: [{
 *     hostname: "Proxima Cen",
 *     ra: deg, dec: deg,
 *     distanceLy: number | null,
 *     hostHip: number | null,    // for joining with HYG
 *     hostHd:  number | null,
 *     starSpectralType: string | null,
 *     starTeffK: number | null,
 *     starMassSun: number | null,
 *     starRadiusSun: number | null,
 *     planets: [{
 *       name, kind, massEarths, orbitAU, radiusEarths,
 *       periodDays, equilibTempK, insolationEarths,
 *       discoveryMethod, discoveryYear, notes
 *     }]
 *   }]
 * }
 *
 * Run: `npx tsx scripts/fetch-exoplanets.ts` from server/.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const TAP_URL = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync";

const QUERY = `
SELECT
  pl_name, hostname, ra, dec,
  sy_dist, sy_snum, sy_pnum,
  discoverymethod, disc_year,
  pl_orbper, pl_orbsmax, pl_rade, pl_radj,
  pl_bmasse, pl_bmassj,
  pl_eqt, pl_insol,
  st_spectype, st_teff, st_mass, st_rad,
  hip_name, hd_name
FROM pscomppars
`.trim();

const PC_TO_LY = 3.2615637967;

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT_JSON = path.join(ROOT, "data", "exoplanets.json");

type Row = {
  pl_name: string;
  hostname: string;
  ra: number | null;
  dec: number | null;
  sy_dist: number | null;
  sy_snum: number | null;
  sy_pnum: number | null;
  discoverymethod: string | null;
  disc_year: number | null;
  pl_orbper: number | null;
  pl_orbsmax: number | null;
  pl_rade: number | null;
  pl_radj: number | null;
  pl_bmasse: number | null;
  pl_bmassj: number | null;
  pl_eqt: number | null;
  pl_insol: number | null;
  st_spectype: string | null;
  st_teff: number | null;
  st_mass: number | null;
  st_rad: number | null;
  hip_name: string | null;
  hd_name: string | null;
};

type PlanetKind =
  | "terrestrial" | "super_earth" | "neptune_like" | "ice_giant"
  | "gas_giant" | "hot_jupiter" | "super_jupiter";

/**
 * Classify a planet from radius (Earth radii) and mass (Earth masses).
 * Heuristic — same buckets the curated catalog uses.
 */
function classify(rEarth: number | null, mEarth: number | null, periodDays: number | null): PlanetKind {
  const m = mEarth ?? null;
  const r = rEarth ?? null;
  // Hot/super Jupiter from period + mass
  const isHot = periodDays != null && periodDays < 10;
  if (m != null) {
    if (m > 1500) return "super_jupiter";
    if (m > 95) return isHot ? "hot_jupiter" : "gas_giant";
    if (m > 10) return "neptune_like";
    if (m > 2) return "super_earth";
    return "terrestrial";
  }
  if (r != null) {
    if (r > 8) return "gas_giant";
    if (r > 4) return "neptune_like";
    if (r > 1.6) return "super_earth";
    return "terrestrial";
  }
  return "terrestrial";
}

function parseHipHd(s: string | null): number | null {
  if (!s) return null;
  // e.g. "HIP 71683" → 71683, "HD 128620" → 128620
  const m = s.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

function planetNotes(r: Row): string {
  const bits: string[] = [];
  if (r.discoverymethod) bits.push(r.discoverymethod);
  if (r.disc_year) bits.push(String(r.disc_year));
  if (r.pl_eqt != null) bits.push(`Teq ${Math.round(r.pl_eqt)} K`);
  if (r.pl_insol != null) {
    const s = r.pl_insol >= 10 ? r.pl_insol.toFixed(0) : r.pl_insol.toFixed(2);
    bits.push(`${s}× Earth flux`);
  }
  return bits.join("; ");
}

async function main() {
  process.stderr.write(`querying NASA TAP: ${TAP_URL}\n`);
  const body = new URLSearchParams({ query: QUERY, format: "json" });
  const res = await fetch(TAP_URL, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`TAP failed: ${res.status} ${res.statusText}\n${txt.slice(0, 1000)}`);
  }
  const rows = (await res.json()) as Row[];
  process.stderr.write(`  got ${rows.length} planet rows\n`);

  // Group by hostname.
  const byHost = new Map<string, Row[]>();
  for (const r of rows) {
    const arr = byHost.get(r.hostname) ?? [];
    arr.push(r);
    byHost.set(r.hostname, arr);
  }

  const systems = [...byHost.entries()].map(([hostname, planets]) => {
    const head = planets[0];
    return {
      hostname,
      ra: head.ra,
      dec: head.dec,
      distanceLy: head.sy_dist != null ? +(head.sy_dist * PC_TO_LY).toFixed(3) : null,
      starCount: head.sy_snum,
      planetCount: head.sy_pnum,
      hostHip: parseHipHd(head.hip_name),
      hostHd: parseHipHd(head.hd_name),
      starSpectralType: head.st_spectype,
      starTeffK: head.st_teff,
      starMassSun: head.st_mass,
      starRadiusSun: head.st_rad,
      planets: planets
        .map(p => ({
          name: p.pl_name,
          kind: classify(p.pl_rade, p.pl_bmasse, p.pl_orbper),
          massEarths: p.pl_bmasse,
          radiusEarths: p.pl_rade,
          orbitAU: p.pl_orbsmax,
          periodDays: p.pl_orbper,
          equilibTempK: p.pl_eqt,
          insolationEarths: p.pl_insol,
          discoveryMethod: p.discoverymethod,
          discoveryYear: p.disc_year,
          notes: planetNotes(p),
        }))
        // sort each system's planets by orbit (innermost first)
        .sort((a, b) => {
          const aa = a.orbitAU ?? Infinity;
          const bb = b.orbitAU ?? Infinity;
          return aa - bb;
        }),
    };
  });

  // Sort systems by distance ascending (unknowns last).
  systems.sort((a, b) => {
    const aa = a.distanceLy ?? Infinity;
    const bb = b.distanceLy ?? Infinity;
    return aa - bb;
  });

  const out = {
    source: "NASA Exoplanet Archive — pscomppars",
    fetchedAt: new Date().toISOString(),
    count: rows.length,
    systemCount: systems.length,
    systems,
  };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(out));
  const sz = fs.statSync(OUT_JSON).size;
  process.stderr.write(`wrote ${OUT_JSON} — ${rows.length} planets across ${systems.length} systems, ${(sz / 1e6).toFixed(2)} MB\n`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
