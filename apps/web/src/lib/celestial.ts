export type CelestialKind = "star" | "planet" | "galaxy";

export interface CelestialBody {
  display: string;
  kind: CelestialKind;
}

const STARS: readonly CelestialBody[] = [
  { display: "Sirius", kind: "star" },
  { display: "Vega", kind: "star" },
  { display: "Rigel", kind: "star" },
  { display: "Arcturus", kind: "star" },
  { display: "Betelgeuse", kind: "star" },
  { display: "Antares", kind: "star" },
  { display: "Polaris", kind: "star" },
  { display: "Altair", kind: "star" },
  { display: "Deneb", kind: "star" },
  { display: "Spica", kind: "star" },
  { display: "Procyon", kind: "star" },
  { display: "Achernar", kind: "star" },
  { display: "Hadar", kind: "star" },
  { display: "Acrux", kind: "star" },
  { display: "Aldebaran", kind: "star" },
  { display: "Regulus", kind: "star" },
  { display: "Castor", kind: "star" },
  { display: "Pollux", kind: "star" },
  { display: "Mizar", kind: "star" },
  { display: "Fomalhaut", kind: "star" },
  { display: "Bellatrix", kind: "star" },
  { display: "Adhara", kind: "star" },
  { display: "Alnitak", kind: "star" },
  { display: "Saiph", kind: "star" },
  { display: "Mirach", kind: "star" },
];

const PLANETS: readonly CelestialBody[] = [
  { display: "Mercury", kind: "planet" },
  { display: "Venus", kind: "planet" },
  { display: "Earth", kind: "planet" },
  { display: "Mars", kind: "planet" },
  { display: "Jupiter", kind: "planet" },
  { display: "Saturn", kind: "planet" },
  { display: "Uranus", kind: "planet" },
  { display: "Neptune", kind: "planet" },
  { display: "Pluto", kind: "planet" },
  { display: "Eris", kind: "planet" },
  { display: "Ceres", kind: "planet" },
  { display: "Haumea", kind: "planet" },
  { display: "Makemake", kind: "planet" },
  { display: "Sedna", kind: "planet" },
  { display: "Orcus", kind: "planet" },
  { display: "Quaoar", kind: "planet" },
  { display: "Varuna", kind: "planet" },
  { display: "Ixion", kind: "planet" },
];

const GALAXIES: readonly CelestialBody[] = [
  { display: "Andromeda", kind: "galaxy" },
  { display: "Triangulum", kind: "galaxy" },
  { display: "Whirlpool", kind: "galaxy" },
  { display: "Sombrero", kind: "galaxy" },
  { display: "Pinwheel", kind: "galaxy" },
  { display: "Cartwheel", kind: "galaxy" },
  { display: "Cigar", kind: "galaxy" },
  { display: "Bode", kind: "galaxy" },
  { display: "Sunflower", kind: "galaxy" },
  { display: "Tadpole", kind: "galaxy" },
  { display: "Coma", kind: "galaxy" },
  { display: "Centaurus", kind: "galaxy" },
  { display: "Perseus", kind: "galaxy" },
  { display: "Virgo", kind: "galaxy" },
  { display: "Hydra", kind: "galaxy" },
  { display: "Leo", kind: "galaxy" },
  { display: "Fornax", kind: "galaxy" },
  { display: "Antennae", kind: "galaxy" },
  { display: "Butterfly", kind: "galaxy" },
  { display: "Mice", kind: "galaxy" },
  { display: "Needle", kind: "galaxy" },
  { display: "Black Eye", kind: "galaxy" },
  { display: "Silver Coin", kind: "galaxy" },
  { display: "Sculptor", kind: "galaxy" },
  { display: "Cetus", kind: "galaxy" },
];

export const ALL_CELESTIAL: readonly CelestialBody[] = [...STARS, ...PLANETS, ...GALAXIES];

const BY_SLUG: ReadonlyMap<string, CelestialBody> = new Map(
  ALL_CELESTIAL.map((b) => [slug(b.display), b]),
);

function slug(display: string): string {
  return display.toLowerCase().replace(/\s+/g, "-");
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/**
 * Suggest a unique celestial branch name under `feature/`.
 *
 * Tiers:
 * 1. Random sampling across stars, planets, and galaxies.
 * 2. Exhaustive scan of all celestial bodies.
 * 3. Hex-suffix fallback for extreme collision cases.
 * 4. Timestamp fallback so the function is total.
 */
export function suggestBranchName(taken: Set<string>): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const body = pick(ALL_CELESTIAL);
    const name = `feature/${slug(body.display)}`;
    if (!taken.has(name)) return name;
  }
  for (const body of ALL_CELESTIAL) {
    const name = `feature/${slug(body.display)}`;
    if (!taken.has(name)) return name;
  }
  for (let attempt = 0; attempt < 200; attempt++) {
    const body = pick(ALL_CELESTIAL);
    const suffix = Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, "0");
    const name = `feature/${slug(body.display)}-${suffix}`;
    if (!taken.has(name)) return name;
  }
  return `feature/orbit-${Date.now().toString(36)}`;
}

/** Parse a branch name and return the matching celestial body, if any. */
export function parseCelestial(branch: string): CelestialBody | undefined {
  const part = branch.split("/").pop() ?? "";
  return BY_SLUG.get(part.toLowerCase());
}

/**
 * Extract the unique celestial bodies visited by a set of branch names.
 * Order is preserved by first appearance.
 */
export function extractVisits(branches: readonly string[]): CelestialBody[] {
  const seen = new Set<string>();
  const out: CelestialBody[] = [];
  for (const branch of branches) {
    const body = parseCelestial(branch);
    if (body && !seen.has(body.display)) {
      seen.add(body.display);
      out.push(body);
    }
  }
  return out;
}

export function visitsByKind(
  visits: readonly CelestialBody[],
): Record<CelestialKind, CelestialBody[]> {
  return {
    star: visits.filter((v) => v.kind === "star"),
    planet: visits.filter((v) => v.kind === "planet"),
    galaxy: visits.filter((v) => v.kind === "galaxy"),
  };
}

export const KIND_LABEL: Record<CelestialKind, string> = {
  star: "Stars",
  planet: "Planets",
  galaxy: "Galaxies",
};
