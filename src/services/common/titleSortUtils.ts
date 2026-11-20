export const LIBRARY_TITLE_COLLATOR = new Intl.Collator(undefined, {
  sensitivity: 'base',
});

export interface TitleSortOptions {
  ignoreLeadingThe?: boolean;
}

const LEADING_THE_RE = /^the\s+(.+)$/i;

/**
 * Computes the alphabetical sort key for a game title.
 *
 * Strict word-boundary matching (`^the\s+(.+)$/i`):
 * - "The Witcher 3: Wild Hunt" -> "Witcher 3: Wild Hunt" (sorts under W)
 * - "the elder scrolls v"      -> "elder scrolls v"      (sorts under E)
 * - "THE LAST OF US"           -> "LAST OF US"           (sorts under L)
 * - "The   Long Dark"          -> "Long Dark"            (sorts under L)
 * - "Theater of War"           -> "Theater of War"       (stays under T)
 * - "Them's Fightin' Herds"    -> "Them's Fightin' Herds"(stays under T)
 * - "The" / "The   "           -> "The"                  (never empty; stays under T)
 * - "A Plague Tale"            -> "A Plague Tale"        (stays under A)
 */
export function getAlphabeticalTitleSortKey(
  rawTitle: string | undefined | null,
  ignoreLeadingThe = true
): string {
  const trimmed = (rawTitle || '').trim();
  if (!trimmed || !ignoreLeadingThe) {
    return trimmed;
  }
  const match = LEADING_THE_RE.exec(trimmed);
  if (match && match[1]) {
    const rest = match[1].trim();
    if (rest.length > 0) {
      return rest;
    }
  }
  return trimmed;
}

/**
 * Deterministic comparator for two titles with optional leading-"The" stripping:
 * 1. Primary: collator compare of computed sort keys
 * 2. Secondary: collator compare of raw trimmed titles (e.g. "Forest" before "The Forest")
 * 3. Tertiary: optional stable ID tie-breaker
 */
export function compareGameTitles(
  titleA: string | undefined | null,
  titleB: string | undefined | null,
  options?: TitleSortOptions & { idA?: string; idB?: string }
): number {
  const ignoreLeadingThe = options?.ignoreLeadingThe ?? true;
  const rawA = (titleA || '').trim();
  const rawB = (titleB || '').trim();
  const keyA = getAlphabeticalTitleSortKey(rawA, ignoreLeadingThe);
  const keyB = getAlphabeticalTitleSortKey(rawB, ignoreLeadingThe);

  const keyCmp = LIBRARY_TITLE_COLLATOR.compare(keyA, keyB);
  if (keyCmp !== 0) return keyCmp;

  const rawCmp = LIBRARY_TITLE_COLLATOR.compare(rawA, rawB);
  if (rawCmp !== 0) return rawCmp;

  if (options?.idA !== undefined && options?.idB !== undefined && options.idA !== options.idB) {
    return options.idA < options.idB ? -1 : 1;
  }
  return 0;
}

/**
 * O(N) precomputed sort-key Schwartzian transform for zero-jank alphabetical
 * sorting across large game libraries without running regex extraction O(N log N) times.
 */
export function sortByTitleKey<T>(
  items: readonly T[],
  getTitle: (item: T) => string | undefined | null,
  options?: TitleSortOptions & { getId?: (item: T) => string }
): T[] {
  if (items.length <= 1) {
    return [...items];
  }
  const ignoreLeadingThe = options?.ignoreLeadingThe ?? true;
  const getId = options?.getId;
  const decorated = new Array<{ item: T; key: string; raw: string; id: string }>(items.length);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const raw = (getTitle(item) || '').trim();
    decorated[i] = {
      item,
      key: getAlphabeticalTitleSortKey(raw, ignoreLeadingThe),
      raw,
      id: getId ? getId(item) : '',
    };
  }

  decorated.sort((a, b) => {
    const keyCmp = LIBRARY_TITLE_COLLATOR.compare(a.key, b.key);
    if (keyCmp !== 0) return keyCmp;
    const rawCmp = LIBRARY_TITLE_COLLATOR.compare(a.raw, b.raw);
    if (rawCmp !== 0) return rawCmp;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  });

  const result = new Array<T>(decorated.length);
  for (let i = 0; i < decorated.length; i++) {
    result[i] = decorated[i].item;
  }
  return result;
}
