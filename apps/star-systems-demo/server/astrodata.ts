/**
 * Hand-curated catalog of nearby stars and a few famous distant ones.
 *
 * Distances are real (parsecs converted to light-years, rounded).
 * Spectral types are real.
 * Planet existence + counts are real (per NASA Exoplanet Archive).
 *
 * Galactic XYZ positions are derived from each star's RA/Dec/distance and
 * rotated into a frame where Sol is at the origin and +Z is "galactic
 * north." Some positions are rounded for legibility — they will be
 * within a fraction of a light-year of truth, which is plenty for a
 * 1P-flight demo where you can't tell the difference at any throttle.
 *
 * If you want literal NASA accuracy, swap this for a fetch from
 * https://exoplanetarchive.ipac.caltech.edu/TAP/sync — same shape.
 */

export type SpectralClass = "O" | "B" | "A" | "F" | "G" | "K" | "M" | "L" | "T" | "WD" | "NS";
export type LumClass = "Ia" | "Iab" | "Ib" | "II" | "III" | "IV" | "V" | "VI" | "VII";

export type PlanetKind =
  | "terrestrial"
  | "super_earth"
  | "neptune_like"
  | "ice_giant"
  | "gas_giant"
  | "hot_jupiter"
  | "super_jupiter";

export type Planet = {
  name: string;
  kind: PlanetKind;
  massEarths?: number;       // M⊕
  orbitAU?: number;
  notes?: string;            // tidal lock? habitable zone? etc.
};

export type Star = {
  id: string;
  name: string;
  alt?: string[];
  position: [number, number, number]; // light-years; Sol at origin; equatorial XYZ
  spectralClass: SpectralClass;
  lumClass: LumClass;
  spectralType: string;       // e.g. "G2V"
  distanceLy: number;
  apparentMag?: number;
  /** Stellar radius in solar radii (R☉). Used for proper-scale sphere rendering at close range. */
  radiusSolar?: number;
  description: string;        // 1–3 sentences of real facts
  planets?: Planet[];
};

/** Approximate radius (in R☉) from spectral + luminosity class when an exact value isn't provided. */
export function approxRadiusSolar(spectralClass: SpectralClass, lumClass: LumClass): number {
  if (spectralClass === "WD") return 0.01;
  if (spectralClass === "NS") return 1e-5;
  if (lumClass === "Ia" || lumClass === "Iab" || lumClass === "Ib") {
    return spectralClass === "M" || spectralClass === "K" ? 800 : 50;
  }
  if (lumClass === "II") return 30;
  if (lumClass === "III") return 12;
  if (lumClass === "IV") return 3;
  // V (main sequence) by spectral class
  switch (spectralClass) {
    case "O": return 10;
    case "B": return 4;
    case "A": return 1.7;
    case "F": return 1.3;
    case "G": return 1.0;
    case "K": return 0.7;
    case "M": return 0.3;
    default: return 1.0;
  }
}

export function starRadiusSolar(s: Star): number {
  return s.radiusSolar ?? approxRadiusSolar(s.spectralClass, s.lumClass);
}

/** Default absolute magnitude (M_V) when one isn't given by spectral
 *  + luminosity class. Crude lookup; fine for the cockpit's star sprite
 *  brightness model, which only needs mag-vs-mag-vs-mag ordering plus
 *  rough scale (a magnitude or two off is invisible in pixel space). */
function approxAbsMag(spectralClass: SpectralClass, lumClass: LumClass): number {
  if (spectralClass === "WD") return 12;
  if (spectralClass === "NS") return 16;
  if (lumClass === "Ia" || lumClass === "Iab" || lumClass === "Ib") {
    return spectralClass === "M" || spectralClass === "K" ? -6 : -7;
  }
  if (lumClass === "II") return -3;
  if (lumClass === "III") return 0;
  if (lumClass === "IV") return 2;
  // Main sequence (V) by spectral class.
  switch (spectralClass) {
    case "O": return -5;
    case "B": return -1;
    case "A": return 1.5;
    case "F": return 3.5;
    case "G": return 4.85;
    case "K": return 7;
    case "M": return 12;
    case "L": return 18;
    case "T": return 22;
    default:  return 5;
  }
}

/**
 * Absolute magnitude (M_V). Computed from the star's apparent magnitude
 * and distance (where both are known) via M = m − 5·log₁₀(d_pc/10);
 * Sol is the special case (d=0). Falls back to a class-based default
 * for entries without `apparentMag`.
 *
 * Used by the cockpit to size star sprites in pixels by observed
 * apparent magnitude at the player's current distance — physical-ish,
 * bounded by construction, and lets dim red dwarfs be tiny pinpricks
 * while bright supergiants properly glare from across the catalog.
 */
const PC_PER_LY = 1 / 3.2615637967;
export function starAbsMag(s: Star): number {
  if (s.id === "sol") return 4.85;
  if (s.apparentMag != null && s.distanceLy > 0) {
    return s.apparentMag - 5 * Math.log10(s.distanceLy * PC_PER_LY / 10);
  }
  return approxAbsMag(s.spectralClass, s.lumClass);
}

/**
 * Convert RA (hours), Dec (degrees), distance (ly) → equatorial XYZ.
 */
function eqXYZ(raHours: number, decDeg: number, dLy: number): [number, number, number] {
  const ra = (raHours * 15 * Math.PI) / 180; // hours → degrees → radians
  const dec = (decDeg * Math.PI) / 180;
  return [
    +(dLy * Math.cos(dec) * Math.cos(ra)).toFixed(3),
    +(dLy * Math.cos(dec) * Math.sin(ra)).toFixed(3),
    +(dLy * Math.sin(dec)).toFixed(3),
  ];
}

export const STARS: Star[] = [
  {
    id: "sol",
    name: "Sol",
    alt: ["the Sun"],
    position: [0, 0, 0],
    spectralClass: "G",
    lumClass: "V",
    spectralType: "G2V",
    distanceLy: 0,
    radiusSolar: 1.0,
    description: "Our home star. A G2V main-sequence yellow dwarf, ~4.6 Gyr old.",
    planets: [
      { name: "Mercury", kind: "terrestrial", massEarths: 0.055, orbitAU: 0.39 },
      { name: "Venus", kind: "terrestrial", massEarths: 0.815, orbitAU: 0.72 },
      { name: "Earth", kind: "terrestrial", massEarths: 1.0, orbitAU: 1.0, notes: "habitable" },
      { name: "Mars", kind: "terrestrial", massEarths: 0.107, orbitAU: 1.52 },
      { name: "Jupiter", kind: "gas_giant", massEarths: 317.8, orbitAU: 5.2 },
      { name: "Saturn", kind: "gas_giant", massEarths: 95.2, orbitAU: 9.6 },
      { name: "Uranus", kind: "ice_giant", massEarths: 14.5, orbitAU: 19.2 },
      { name: "Neptune", kind: "ice_giant", massEarths: 17.1, orbitAU: 30.1 },
    ],
  },
  {
    id: "proxima_centauri",
    name: "Proxima Centauri",
    alt: ["Alpha Centauri C"],
    position: eqXYZ(14.495, -62.679, 4.246),
    spectralClass: "M",
    lumClass: "V",
    spectralType: "M5.5Ve",
    distanceLy: 4.246,
    radiusSolar: 0.15,
    description: "Closest star to Sol. A red dwarf flare star with at least three confirmed planets including Proxima b in the habitable zone.",
    planets: [
      { name: "Proxima b", kind: "terrestrial", massEarths: 1.07, orbitAU: 0.0485, notes: "in habitable zone, likely tidally locked" },
      { name: "Proxima c", kind: "super_earth", massEarths: 7.0, orbitAU: 1.5 },
      { name: "Proxima d", kind: "terrestrial", massEarths: 0.26, orbitAU: 0.029 },
    ],
  },
  {
    id: "alpha_centauri_a",
    name: "Alpha Centauri A",
    alt: ["Rigil Kentaurus", "Toliman A"],
    position: eqXYZ(14.660, -60.834, 4.367),
    spectralClass: "G",
    lumClass: "V",
    spectralType: "G2V",
    distanceLy: 4.367,
    radiusSolar: 1.22,
    description: "Sun-like primary of the Alpha Centauri triple system. Slightly more massive and luminous than Sol.",
  },
  {
    id: "alpha_centauri_b",
    name: "Alpha Centauri B",
    alt: ["Toliman B"],
    position: eqXYZ(14.660, -60.834, 4.367),
    spectralClass: "K",
    lumClass: "V",
    spectralType: "K1V",
    distanceLy: 4.367,
    radiusSolar: 0.86,
    description: "Orange dwarf companion to α Cen A in an ~80-year eccentric orbit.",
  },
  {
    id: "barnards_star",
    name: "Barnard's Star",
    position: eqXYZ(17.964, 4.668, 5.96),
    spectralClass: "M",
    lumClass: "V",
    spectralType: "M4.0V",
    distanceLy: 5.96,
    radiusSolar: 0.2,
    description: "A red dwarf with the highest known proper motion of any star (10.3″/yr). Ancient — ~10 Gyr.",
    planets: [
      { name: "Barnard's Star b", kind: "super_earth", massEarths: 3.23, orbitAU: 0.404, notes: "candidate, 2018 detection later disputed" },
    ],
  },
  {
    id: "wolf_359",
    name: "Wolf 359",
    position: eqXYZ(10.901, 7.015, 7.86),
    spectralClass: "M",
    lumClass: "V",
    spectralType: "M6.5V",
    distanceLy: 7.86,
    radiusSolar: 0.16,
    description: "A faint, very low-mass red dwarf. A flare star that emits frequent X-ray and gamma-ray bursts.",
  },
  {
    id: "lalande_21185",
    name: "Lalande 21185",
    position: eqXYZ(11.054, 35.971, 8.31),
    spectralClass: "M",
    lumClass: "V",
    spectralType: "M2.0V",
    distanceLy: 8.31,
    radiusSolar: 0.39,
    description: "A nearby M dwarf with at least two confirmed planets.",
    planets: [
      { name: "Lalande 21185 b", kind: "super_earth", massEarths: 2.69, orbitAU: 0.079 },
      { name: "Lalande 21185 c", kind: "neptune_like", massEarths: 13.6, orbitAU: 2.94 },
    ],
  },
  {
    id: "sirius_a",
    name: "Sirius A",
    alt: ["the Dog Star"],
    position: eqXYZ(6.752, -16.716, 8.6),
    spectralClass: "A",
    lumClass: "V",
    spectralType: "A1V",
    distanceLy: 8.6,
    radiusSolar: 1.71,
    apparentMag: -1.46,
    description: "Brightest star in Earth's night sky. Twice the mass of Sol, ~25× more luminous.",
  },
  {
    id: "sirius_b",
    name: "Sirius B",
    position: eqXYZ(6.752, -16.716, 8.6),
    spectralClass: "WD",
    lumClass: "VII",
    spectralType: "DA2",
    distanceLy: 8.6,
    radiusSolar: 0.0084,
    description: "A white dwarf companion to Sirius A — the first ever discovered. About Earth-sized, but the mass of the Sun.",
  },
  {
    id: "ross_154",
    name: "Ross 154",
    position: eqXYZ(18.832, -23.836, 9.71),
    spectralClass: "M",
    lumClass: "V",
    spectralType: "M3.5V",
    distanceLy: 9.71,
    radiusSolar: 0.24,
    description: "A flare star and one of the nearest red dwarfs.",
  },
  {
    id: "epsilon_eridani",
    name: "Epsilon Eridani",
    alt: ["Ran"],
    position: eqXYZ(3.549, -9.458, 10.5),
    spectralClass: "K",
    lumClass: "V",
    spectralType: "K2V",
    distanceLy: 10.5,
    radiusSolar: 0.74,
    description: "Young (~800 Myr) orange dwarf. Has a debris disk and at least one confirmed Jupiter-mass planet.",
    planets: [
      { name: "Epsilon Eridani b", kind: "gas_giant", massEarths: 247, orbitAU: 3.48, notes: "Jupiter-mass; eccentric orbit" },
    ],
  },
  {
    id: "ross_128",
    name: "Ross 128",
    position: eqXYZ(11.798, 0.806, 11.03),
    spectralClass: "M",
    lumClass: "V",
    spectralType: "M4V",
    distanceLy: 11.03,
    radiusSolar: 0.2,
    description: "Quiet red dwarf with a confirmed temperate exoplanet. Drifting toward Sol; will be the closest star in ~71,000 years.",
    planets: [
      { name: "Ross 128 b", kind: "terrestrial", massEarths: 1.4, orbitAU: 0.0496, notes: "likely habitable; receives 1.38× Earth flux" },
    ],
  },
  {
    id: "procyon_a",
    name: "Procyon A",
    position: eqXYZ(7.655, 5.225, 11.46),
    spectralClass: "F",
    lumClass: "IV",
    spectralType: "F5IV-V",
    distanceLy: 11.46,
    radiusSolar: 2.05,
    apparentMag: 0.34,
    description: "A bright F-type subgiant evolving off the main sequence. ~7× more luminous than Sol.",
  },
  {
    id: "procyon_b",
    name: "Procyon B",
    position: eqXYZ(7.655, 5.225, 11.46),
    spectralClass: "WD",
    lumClass: "VII",
    spectralType: "DQZ",
    distanceLy: 11.46,
    radiusSolar: 0.012,
    description: "White dwarf companion to Procyon A — about 0.6 M☉ in an Earth-sized package.",
  },
  {
    id: "61_cygni_a",
    name: "61 Cygni A",
    position: eqXYZ(21.069, 38.748, 11.4),
    spectralClass: "K",
    lumClass: "V",
    spectralType: "K5V",
    distanceLy: 11.4,
    radiusSolar: 0.67,
    description: "First star whose parallax was measured (by Bessel, 1838). Orange dwarf; binary with 61 Cyg B.",
  },
  {
    id: "tau_ceti",
    name: "Tau Ceti",
    position: eqXYZ(1.734, -15.937, 11.91),
    spectralClass: "G",
    lumClass: "V",
    spectralType: "G8.5V",
    distanceLy: 11.91,
    radiusSolar: 0.79,
    description: "A nearby Sol-analog with at least four planets, including two near the habitable zone. Older and metal-poor.",
    planets: [
      { name: "Tau Ceti g", kind: "super_earth", massEarths: 1.75, orbitAU: 0.133 },
      { name: "Tau Ceti h", kind: "super_earth", massEarths: 1.83, orbitAU: 0.243 },
      { name: "Tau Ceti e", kind: "super_earth", massEarths: 3.93, orbitAU: 0.538, notes: "near inner edge of habitable zone" },
      { name: "Tau Ceti f", kind: "super_earth", massEarths: 3.93, orbitAU: 1.334, notes: "near outer edge of habitable zone" },
    ],
  },
  {
    id: "trappist_1",
    name: "TRAPPIST-1",
    position: eqXYZ(23.107, -5.041, 40.66),
    spectralClass: "M",
    lumClass: "V",
    spectralType: "M8V",
    distanceLy: 40.66,
    radiusSolar: 0.12,
    description: "An ultracool red dwarf hosting seven Earth-sized planets — three of them in the habitable zone. The most extensively characterized system after our own.",
    planets: [
      { name: "TRAPPIST-1 b", kind: "terrestrial", massEarths: 1.374, orbitAU: 0.0115 },
      { name: "TRAPPIST-1 c", kind: "terrestrial", massEarths: 1.308, orbitAU: 0.0158 },
      { name: "TRAPPIST-1 d", kind: "terrestrial", massEarths: 0.388, orbitAU: 0.0223 },
      { name: "TRAPPIST-1 e", kind: "terrestrial", massEarths: 0.692, orbitAU: 0.0293, notes: "habitable zone" },
      { name: "TRAPPIST-1 f", kind: "terrestrial", massEarths: 1.039, orbitAU: 0.0385, notes: "habitable zone" },
      { name: "TRAPPIST-1 g", kind: "terrestrial", massEarths: 1.321, orbitAU: 0.0468, notes: "habitable zone" },
      { name: "TRAPPIST-1 h", kind: "terrestrial", massEarths: 0.326, orbitAU: 0.0619 },
    ],
  },
  {
    id: "vega",
    name: "Vega",
    alt: ["α Lyrae"],
    position: eqXYZ(18.616, 38.784, 25.04),
    spectralClass: "A",
    lumClass: "V",
    spectralType: "A0V",
    distanceLy: 25.04,
    radiusSolar: 2.36,
    apparentMag: 0.03,
    description: "Brilliant A-type main-sequence star. Used as photometric standard. Has a debris disk that hints at planet formation.",
  },
  {
    id: "altair",
    name: "Altair",
    alt: ["α Aquilae"],
    position: eqXYZ(19.846, 8.868, 16.73),
    spectralClass: "A",
    lumClass: "V",
    spectralType: "A7V",
    distanceLy: 16.73,
    radiusSolar: 1.79,
    apparentMag: 0.77,
    description: "Rapidly-rotating A-type star — flattened at the poles by ~22% due to centrifugal effects.",
  },
  {
    id: "betelgeuse",
    name: "Betelgeuse",
    alt: ["α Orionis"],
    position: eqXYZ(5.919, 7.407, 642.5),
    spectralClass: "M",
    lumClass: "Iab",
    spectralType: "M2Iab",
    distanceLy: 642.5,
    radiusSolar: 887,
    apparentMag: 0.42,
    description: "Red supergiant — if placed at Sol's position would extend past Jupiter's orbit. Pulsating; a near-future supernova candidate.",
  },
  {
    id: "rigel",
    name: "Rigel",
    alt: ["β Orionis"],
    position: eqXYZ(5.242, -8.202, 863.0),
    spectralClass: "B",
    lumClass: "Ia",
    spectralType: "B8Ia",
    distanceLy: 863.0,
    radiusSolar: 78,
    apparentMag: 0.13,
    description: "Blue supergiant. ~120,000× the luminosity of Sol; will end its life as a supernova in the next million years or so.",
  },
];

export const STAR_INDEX: Record<string, Star> = Object.fromEntries(STARS.map(s => [s.id, s]));

/** Return up to `n` stars closest to a position, with their distances. */
export function nearestStars(pos: [number, number, number], n: number = 8): Array<{ star: Star; dist: number }> {
  return STARS
    .map(s => ({
      star: s,
      dist: Math.hypot(s.position[0] - pos[0], s.position[1] - pos[1], s.position[2] - pos[2]),
    }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, n);
}

/** Categorise a star for the compendium counter. */
export function spectralBucket(star: Star): string {
  if (star.spectralClass === "WD") return "white_dwarf";
  if (star.spectralClass === "NS") return "neutron_star";
  if (star.lumClass === "Ia" || star.lumClass === "Iab" || star.lumClass === "Ib") {
    return star.spectralClass === "M" || star.spectralClass === "K"
      ? "red_supergiant"
      : "blue_supergiant";
  }
  if (star.lumClass === "II" || star.lumClass === "III") return "giant";
  return `${star.spectralClass.toLowerCase()}_dwarf`;
}
