/**
 * The Welcome template library (`docs/architecture.md` §5.11).
 *
 * The cards come from Ketcher's real Structure Library, never from a curated
 * hand-written pool: `App` reads `FunctionalGroupsProvider` and
 * `SaltsAndSolventsProvider` after `onInit`, serializes each struct to KET and
 * hands the entries here. This module only maps that data (pure, no DOM, no
 * Ketcher runtime) and holds the two layout helpers the Welcome grid needs, so
 * the pane stays render-only and Vitest pins the mapping.
 */

/** The source lists the cards are built from; the value is the card's chip. */
export type TemplateGroup = "functional-group" | "salt-solvent";

/** One library struct after `App` serialized it to KET. */
export interface TemplateSource {
  /** The provider's display name (trimmed by the mapper). */
  name: string;
  /** Which provider list the struct came from. */
  group: TemplateGroup;
  /** The serialized structure (`KetSerializer.serializeMicromolecules`). */
  ket: string;
}

/** One Welcome card backed by a real library entry the editor can load. */
export interface LibraryTemplate {
  /** Unique lower-case slug of the name (collisions get `-2`, `-3`, …). */
  id: string;
  /** Trimmed display name, also the new tab's first name. */
  name: string;
  group: TemplateGroup;
  /** The entry's own KET; the only structure a card inserts or previews. */
  ket: string;
}

/** `"Acetic Acid"` → `"acetic-acid"`; non-alphanumerics collapse to one dash. */
function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Maps the provider entries to cards in provider order: functional groups
 * first, then salts and solvents. The mapper trims the name, skips an entry
 * with no name or no KET, dedupes by the case-insensitive name (first wins)
 * and gives every entry a unique slug id, appending `-2`, `-3`, … when two
 * different names slug to the same value.
 */
export function buildLibraryTemplates(entries: readonly TemplateSource[]): LibraryTemplate[] {
  const templates: LibraryTemplate[] = [];
  const seenNames = new Set<string>();
  const usedIds = new Set<string>();

  for (const entry of entries) {
    const name = entry.name.trim();
    if (name.length === 0 || entry.ket.trim().length === 0) continue;

    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);

    const base = slugify(name) || "template";
    let id = base;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);

    templates.push({ id, name, group: entry.group, ket: entry.ket });
  }

  return templates;
}

/**
 * How many cards the Welcome grid shows, independent of the viewport width
 * (`docs/architecture.md` §5.11): always exactly four.
 */
export const TEMPLATE_CARD_COUNT = 4;

/**
 * Picks `count` **distinct** entries from `pool`, in pool order so the grid
 * stays stable left to right and top to bottom. A non-positive count yields an
 * empty list; a count at or above the pool size yields the whole pool. The RNG
 * is injected so the UI passes `Math.random` while tests stay reproducible.
 */
export function sampleTemplates<T extends { id: string }>(
  pool: readonly T[],
  count: number,
  random: () => number = Math.random,
): T[] {
  if (count <= 0) return [];
  if (count >= pool.length) return [...pool];

  const indexes = pool.map((_, index) => index);

  // Partial Fisher-Yates: choose one of the remaining slots for each pick.
  for (let picked = 0; picked < count; picked += 1) {
    const remaining = pool.length - picked;
    const offset = Math.min(remaining - 1, Math.max(0, Math.floor(random() * remaining)));
    const swap = picked + offset;
    [indexes[picked], indexes[swap]] = [indexes[swap], indexes[picked]];
  }

  return indexes
    .slice(0, count)
    .sort((left, right) => left - right)
    .map((index) => pool[index]);
}
