/**
 * Fetch HYG v4.1 catalog (≈120k stars) and transform into the same Star
 * shape used by astrodata.ts, written to server/data/hyg.json.
 *
 * Source: https://github.com/astronexus/HYG-Database
 *   raw CSV: hyg/CURRENT/hygdata_v41.csv  (~33 MB, ~119k rows)
 *
 * Field mapping
 * -------------
 * HYG x,y,z are equatorial Cartesian parsecs with Sol at the origin —
 * exactly the frame astrodata.ts uses, just in pc instead of ly.
 * (1 pc = 3.2615637967 ly)
 *
 *   astrodata.Star          ← HYG
 *   id (string)             ← preferred catalog id (gl > hd > hip > hr > hyg-N), "sol" for id=0
 *   name                    ← proper, else bayer+con (e.g. "Alp Cen"), else catalog id
 *   alt[]                   ← every other catalog cross-reference present
 *   position [ly]           ← [x, y, z] * 3.2615637967
 *   distanceLy              ← dist * 3.2615637967  (HYG dist is parsecs; 100000 = unknown)
 *   spectralType            ← spect (raw)
 *   spectralClass           ← parsed first letter (O/B/A/F/G/K/M/L/T or "WD" for "D…", "?" if blank)
 *   lumClass                ← parsed roman numeral (Iab/Ia/Ib/II/III/IV/V/VI), "VII" for WD, "?" if absent
 *   apparentMag             ← mag
 *   description             ← "" (HYG has no prose; the LLM Mind narrates on observe)
 *
 * Stars with HYG dist=100000 (the "unknown distance" sentinel) are kept
 * but flagged with distanceLy=null. Their position vector is still a
 * usable direction; we just don't claim a real distance.
 *
 * Run: `npx tsx scripts/fetch-hyg.ts` from server/.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const HYG_URL =
  "https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv";

const PC_TO_LY = 3.2615637967;
const UNKNOWN_DIST_PC = 100000;

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CACHE_CSV = path.join(ROOT, "data", ".hygdata_v41.csv");
const OUT_JSON = path.join(ROOT, "data", "hyg.json");

type Row = Record<string, string>;

async function ensureCsv(): Promise<string> {
  if (fs.existsSync(CACHE_CSV) && fs.statSync(CACHE_CSV).size > 30_000_000) {
    return CACHE_CSV;
  }
  process.stderr.write(`fetching ${HYG_URL} ...\n`);
  const res = await fetch(HYG_URL);
  if (!res.ok) throw new Error(`HYG fetch failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(CACHE_CSV, buf);
  process.stderr.write(`  wrote ${CACHE_CSV} (${(buf.length / 1e6).toFixed(1)} MB)\n`);
  return CACHE_CSV;
}

/** Minimal RFC-4180 CSV parser (handles quoted fields with embedded commas). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else {
      if (c === ",") { out.push(cur); cur = ""; }
      else if (c === '"' && cur === "") inQ = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function num(s: string | undefined): number | null {
  if (s == null || s === "") return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

const LUM_CLASSES = ["Iab", "Ia", "Ib", "III", "II", "IV", "VII", "VI", "V"] as const;
type SpectralClass = "O" | "B" | "A" | "F" | "G" | "K" | "M" | "L" | "T" | "WD" | "NS" | "?";
type LumClass = "Ia" | "Iab" | "Ib" | "II" | "III" | "IV" | "V" | "VI" | "VII" | "?";

function parseSpect(spect: string): { spectralClass: SpectralClass; lumClass: LumClass } {
  const s = (spect ?? "").trim();
  if (!s) return { spectralClass: "?", lumClass: "?" };
  const head = s[0].toUpperCase();
  if (head === "D") return { spectralClass: "WD", lumClass: "VII" };
  if (head === "N" && s[1]?.toLowerCase() === "s") return { spectralClass: "NS", lumClass: "VII" };
  const cls: SpectralClass =
    head === "O" || head === "B" || head === "A" || head === "F" ||
    head === "G" || head === "K" || head === "M" || head === "L" || head === "T"
      ? head
      : "?";
  let lum: LumClass = "?";
  for (const r of LUM_CLASSES) {
    const re = new RegExp(`(?:^|[^A-Za-z])${r}(?![A-Za-z])`);
    if (re.test(s)) { lum = r as LumClass; break; }
  }
  if (lum === "?" && cls !== "?") lum = "V";
  return { spectralClass: cls, lumClass: lum };
}

function pickIdAndAlts(r: Row): { id: string; alt: string[] } {
  const hyg = r.id;
  const cands: Array<[string, string]> = [];
  if (r.proper) cands.push(["proper", r.proper]);
  if (r.gl) cands.push(["Gl", `Gl ${r.gl}`]);
  if (r.hd) cands.push(["HD", `HD ${r.hd}`]);
  if (r.hip) cands.push(["HIP", `HIP ${r.hip}`]);
  if (r.hr) cands.push(["HR", `HR ${r.hr}`]);
  if (r.bf) cands.push(["BF", r.bf]);
  if (r.bayer && r.con) cands.push(["bayer", `${r.bayer} ${r.con}`]);
  if (r.flam && r.con) cands.push(["flamsteed", `${r.flam} ${r.con}`]);
  cands.push(["hyg", `HYG ${hyg}`]);

  let id: string;
  if (hyg === "0") id = "sol";
  else if (r.gl) id = `gl-${r.gl.toLowerCase().replace(/\s+/g, "-")}`;
  else if (r.hd) id = `hd-${r.hd}`;
  else if (r.hip) id = `hip-${r.hip}`;
  else if (r.hr) id = `hr-${r.hr}`;
  else id = `hyg-${hyg}`;

  const seen = new Set<string>();
  const alt: string[] = [];
  for (const [, v] of cands) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    alt.push(v);
  }
  return { id, alt };
}

async function main() {
  const csvPath = await ensureCsv();
  const text = fs.readFileSync(csvPath, "utf8");
  const lines = text.split(/\r?\n/);
  const header = parseCsvLine(lines[0]).map(h => h.replace(/^"|"$/g, ""));
  const idx = (k: string) => header.indexOf(k);

  const stars: any[] = [];
  let kept = 0;
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = parseCsvLine(line);
    if (cols.length < header.length) { skipped++; continue; }
    const r: Row = {};
    for (let j = 0; j < header.length; j++) r[header[j]] = cols[j];

    const xPc = num(r.x), yPc = num(r.y), zPc = num(r.z);
    if (xPc == null || yPc == null || zPc == null) { skipped++; continue; }
    const distPc = num(r.dist);
    const isUnknownDist = distPc == null || distPc >= UNKNOWN_DIST_PC;

    const { id, alt } = pickIdAndAlts(r);
    const name =
      r.proper ||
      (r.bayer && r.con ? `${r.bayer} ${r.con}` : "") ||
      (r.flam && r.con ? `${r.flam} ${r.con}` : "") ||
      (r.gl ? `Gl ${r.gl}` : "") ||
      (r.hd ? `HD ${r.hd}` : "") ||
      (r.hip ? `HIP ${r.hip}` : "") ||
      (r.hr ? `HR ${r.hr}` : "") ||
      `HYG ${r.id}`;

    const { spectralClass, lumClass } = parseSpect(r.spect ?? "");

    const star: any = {
      id,
      name,
      alt: alt.filter(a => a !== name),
      position: [
        +(xPc * PC_TO_LY).toFixed(3),
        +(yPc * PC_TO_LY).toFixed(3),
        +(zPc * PC_TO_LY).toFixed(3),
      ],
      spectralClass,
      lumClass,
      spectralType: r.spect ?? "",
      distanceLy: isUnknownDist ? null : +((distPc as number) * PC_TO_LY).toFixed(3),
      apparentMag: num(r.mag),
      absMag: num(r.absmag),
      colorIndex: num(r.ci),
      luminosity: num(r.lum),
      constellation: r.con || null,
      hyg: {
        id: Number(r.id),
        hip: r.hip ? Number(r.hip) : null,
        hd: r.hd ? Number(r.hd) : null,
        hr: r.hr ? Number(r.hr) : null,
        gl: r.gl || null,
        bayer: r.bayer || null,
        flamsteed: r.flam || null,
        ra: num(r.ra),
        dec: num(r.dec),
      },
      description: "",
    };
    stars.push(star);
    kept++;
  }

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(stars));
  const sz = fs.statSync(OUT_JSON).size;
  process.stderr.write(`wrote ${OUT_JSON} — ${kept} stars (${skipped} skipped), ${(sz / 1e6).toFixed(1)} MB\n`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
