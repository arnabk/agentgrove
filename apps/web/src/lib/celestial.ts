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
  { display: "Capella", kind: "star" },
  { display: "Canopus", kind: "star" },
  { display: "Alphard", kind: "star" },
  { display: "Alnilam", kind: "star" },
  { display: "Mintaka", kind: "star" },
  { display: "Rigil Kentaurus", kind: "star" },
  { display: "Toliman", kind: "star" },
  { display: "Proxima", kind: "star" },
  { display: "Wezen", kind: "star" },
  { display: "Sargas", kind: "star" },
  { display: "Kaus Australis", kind: "star" },
  { display: "Avior", kind: "star" },
  { display: "Alkaid", kind: "star" },
  { display: "Menkalinan", kind: "star" },
  { display: "Atria", kind: "star" },
  { display: "Alhena", kind: "star" },
  { display: "Peacock", kind: "star" },
  { display: "Alsephina", kind: "star" },
  { display: "Mirzam", kind: "star" },
  { display: "Alphecca", kind: "star" },
  { display: "Suhail", kind: "star" },
  { display: "Sadr", kind: "star" },
  { display: "Naos", kind: "star" },
  { display: "Almach", kind: "star" },
  { display: "Caph", kind: "star" },
  { display: "Izar", kind: "star" },
  { display: "Schedar", kind: "star" },
  { display: "Rasalhague", kind: "star" },
  { display: "Kochab", kind: "star" },
  { display: "Denebola", kind: "star" },
  { display: "Algol", kind: "star" },
  { display: "Tarazed", kind: "star" },
  { display: "Enif", kind: "star" },
  { display: "Scheat", kind: "star" },
  { display: "Markab", kind: "star" },
  { display: "Alderamin", kind: "star" },
  { display: "Alnair", kind: "star" },
  { display: "Diphda", kind: "star" },
  { display: "Nunki", kind: "star" },
  { display: "Menkar", kind: "star" },
  { display: "Alcyone", kind: "star" },
  { display: "Electra", kind: "star" },
  { display: "Maia", kind: "star" },
  { display: "Merope", kind: "star" },
  { display: "Taygeta", kind: "star" },
  { display: "Sheratan", kind: "star" },
  { display: "Hamal", kind: "star" },
  { display: "Gienah", kind: "star" },
  { display: "Zosma", kind: "star" },
  { display: "Vindemiatrix", kind: "star" },
  { display: "Porrima", kind: "star" },
  { display: "Zubenelgenubi", kind: "star" },
  { display: "Unukalhai", kind: "star" },
  { display: "Rastaban", kind: "star" },
  { display: "Eltanin", kind: "star" },
  { display: "Cursa", kind: "star" },
  { display: "Sadalsuud", kind: "star" },
  { display: "Sadalmelik", kind: "star" },
  { display: "Baten Kaitos", kind: "star" },
  { display: "Acrab", kind: "star" },
  { display: "Dschubba", kind: "star" },
  { display: "Sabik", kind: "star" },
  { display: "Shaula", kind: "star" },
  { display: "Lesath", kind: "star" },
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
  { display: "Gonggong", kind: "planet" },
  { display: "Salacia", kind: "planet" },
  { display: "Chaos", kind: "planet" },
  { display: "Deucalion", kind: "planet" },
  { display: "Huya", kind: "planet" },
  { display: "Logos", kind: "planet" },
  { display: "Rhadamanthus", kind: "planet" },
  { display: "Vesta", kind: "planet" },
  { display: "Pallas", kind: "planet" },
  { display: "Hygiea", kind: "planet" },
  { display: "Juno", kind: "planet" },
  { display: "Astraea", kind: "planet" },
  { display: "Iris", kind: "planet" },
  { display: "Flora", kind: "planet" },
  { display: "Hebe", kind: "planet" },
  { display: "Egeria", kind: "planet" },
  { display: "Psyche", kind: "planet" },
  { display: "Eunomia", kind: "planet" },
  { display: "Davida", kind: "planet" },
  { display: "Interamnia", kind: "planet" },
  { display: "Europa", kind: "planet" },
  { display: "Ganymede", kind: "planet" },
  { display: "Callisto", kind: "planet" },
  { display: "Io", kind: "planet" },
  { display: "Titan", kind: "planet" },
  { display: "Enceladus", kind: "planet" },
  { display: "Rhea", kind: "planet" },
  { display: "Iapetus", kind: "planet" },
  { display: "Dione", kind: "planet" },
  { display: "Tethys", kind: "planet" },
  { display: "Mimas", kind: "planet" },
  { display: "Titania", kind: "planet" },
  { display: "Oberon", kind: "planet" },
  { display: "Umbriel", kind: "planet" },
  { display: "Ariel", kind: "planet" },
  { display: "Miranda", kind: "planet" },
  { display: "Triton", kind: "planet" },
  { display: "Nereid", kind: "planet" },
  { display: "Charon", kind: "planet" },
  { display: "Phobos", kind: "planet" },
  { display: "Deimos", kind: "planet" },
  { display: "Osiris", kind: "planet" },
  { display: "Bellerophon", kind: "planet" },
  { display: "Dimidium", kind: "planet" },
  { display: "Methuselah", kind: "planet" },
  { display: "Tadmor", kind: "planet" },
  { display: "Galileo", kind: "planet" },
  { display: "Poltergeist", kind: "planet" },
  { display: "Phobetor", kind: "planet" },
  { display: "Draugr", kind: "planet" },
  { display: "Amateru", kind: "planet" },
  { display: "Arion", kind: "planet" },
  { display: "Janssen", kind: "planet" },
  { display: "Harriot", kind: "planet" },
  { display: "Quijote", kind: "planet" },
  { display: "Dulcinea", kind: "planet" },
  { display: "Rocinante", kind: "planet" },
  { display: "Sancho", kind: "planet" },
  { display: "Halla", kind: "planet" },
  { display: "Spe", kind: "planet" },
  { display: "Arkas", kind: "planet" },
  { display: "Tanager", kind: "planet" },
  { display: "Lipperhey", kind: "planet" },
  { display: "Meridiana", kind: "planet" },
  { display: "Cayahuanca", kind: "planet" },
  { display: "Taphao Thong", kind: "planet" },
  { display: "Taphao Kaew", kind: "planet" },
  { display: "Thestias", kind: "planet" },
  { display: "Samh", kind: "planet" },
  { display: "Sazum", kind: "planet" },
  { display: "Naqu", kind: "planet" },
  { display: "Aumatex", kind: "planet" },
  { display: "Ugarit", kind: "planet" },
  { display: "Yvaga", kind: "planet" },
  { display: "Tondra", kind: "planet" },
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
  { display: "Sombrero Twin", kind: "galaxy" },
  { display: "Sunburst", kind: "galaxy" },
  { display: "Comet", kind: "galaxy" },
  { display: "Hoag", kind: "galaxy" },
  { display: "Spindle", kind: "galaxy" },
  { display: "Southern Pinwheel", kind: "galaxy" },
  { display: "Little Sombrero", kind: "galaxy" },
  { display: "Meathook", kind: "galaxy" },
  { display: "Grand Design", kind: "galaxy" },
  { display: "Fireworks", kind: "galaxy" },
  { display: "Hockey Stick", kind: "galaxy" },
  { display: "Whale", kind: "galaxy" },
  { display: "Cocoon", kind: "galaxy" },
  { display: "Sculptor Dwarf", kind: "galaxy" },
  { display: "Draco Dwarf", kind: "galaxy" },
  { display: "Carina Dwarf", kind: "galaxy" },
  { display: "Fornax Dwarf", kind: "galaxy" },
  { display: "Sextans", kind: "galaxy" },
  { display: "Sagittarius Dwarf", kind: "galaxy" },
  { display: "Large Magellanic", kind: "galaxy" },
  { display: "Small Magellanic", kind: "galaxy" },
  { display: "Wolf-Lundmark", kind: "galaxy" },
  { display: "Barnard", kind: "galaxy" },
  { display: "Phoenix Dwarf", kind: "galaxy" },
  { display: "Pegasus Dwarf", kind: "galaxy" },
  { display: "Aquarius Dwarf", kind: "galaxy" },
  { display: "Tucana Dwarf", kind: "galaxy" },
  { display: "Circinus", kind: "galaxy" },
  { display: "Maffei", kind: "galaxy" },
  { display: "Dwingeloo", kind: "galaxy" },
  { display: "Sunflower Twin", kind: "galaxy" },
  { display: "Eye of Sauron", kind: "galaxy" },
  { display: "Medusa", kind: "galaxy" },
  { display: "Penguin", kind: "galaxy" },
  { display: "Atoms for Peace", kind: "galaxy" },
  { display: "Integral Sign", kind: "galaxy" },
  { display: "Condor", kind: "galaxy" },
  { display: "Sculptor Filament", kind: "galaxy" },
  { display: "Backward", kind: "galaxy" },
  { display: "Lindsay-Shapley", kind: "galaxy" },
  { display: "Papillon", kind: "galaxy" },
  { display: "Serpens", kind: "galaxy" },
  { display: "Ursa Major", kind: "galaxy" },
  { display: "Ursa Minor", kind: "galaxy" },
  { display: "Bootes", kind: "galaxy" },
  { display: "Coma Berenices", kind: "galaxy" },
  { display: "Canes Venatici", kind: "galaxy" },
  { display: "Reticulum", kind: "galaxy" },
  { display: "Hercules", kind: "galaxy" },
  { display: "Willman", kind: "galaxy" },
  { display: "Segue", kind: "galaxy" },
  { display: "Leo Twin", kind: "galaxy" },
  { display: "Crater", kind: "galaxy" },
  { display: "Antlia", kind: "galaxy" },
  { display: "Grus", kind: "galaxy" },
  { display: "Horologium", kind: "galaxy" },
  { display: "Pictor", kind: "galaxy" },
  { display: "Columba", kind: "galaxy" },
  { display: "Pisces", kind: "galaxy" },
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

/**
 * Count how many times each celestial body is visited across a list of
 * branch names. Unlike {@link extractVisits}, repeated visits to the
 * same body (e.g. two worktrees both on `feature/mars`) are tallied
 * rather than collapsed. Keyed by the body's display name.
 */
export function countVisits(branches: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const branch of branches) {
    const body = parseCelestial(branch);
    if (body) counts.set(body.display, (counts.get(body.display) ?? 0) + 1);
  }
  return counts;
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
