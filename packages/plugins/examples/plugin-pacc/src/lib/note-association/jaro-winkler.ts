/**
 * Jaro-Winkler string similarity — T-2.3 title-fuzzy-match rule (PLAN
 * "Title fuzzy match (Jaro-Winkler >= 0.9) -> confidence 0.4").
 *
 * Hand-rolled rather than a new dependency: the workspace ships no
 * fuzzy-string-matching package today (checked: no `jaro-winkler`,
 * `string-similarity`, `fastest-levenshtein`, etc. in any package.json or
 * the lockfile), and the algorithm is small and well-specified enough that
 * a dependency would trade a few dozen lines for a supply-chain addition.
 *
 * Pure domain logic per docs/substrate-firewall.md: no I/O, no Paperclip
 * imports.
 */

/** Standard Jaro similarity in [0, 1]. */
export function jaroSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0 || bLen === 0) return 0;

  const matchDistance = Math.max(0, Math.floor(Math.max(aLen, bLen) / 2) - 1);

  const aMatches = new Array<boolean>(aLen).fill(false);
  const bMatches = new Array<boolean>(bLen).fill(false);

  let matches = 0;
  for (let i = 0; i < aLen; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, bLen);
    for (let j = start; j < end; j++) {
      if (bMatches[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < aLen; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions = Math.floor(transpositions / 2);

  return (matches / aLen + matches / bLen + (matches - transpositions) / matches) / 3;
}

const WINKLER_PREFIX_SCALE = 0.1;
const WINKLER_MAX_PREFIX_LENGTH = 4;

/**
 * Jaro-Winkler similarity in [0, 1]: Jaro similarity boosted for strings
 * that share a common prefix (up to 4 chars), which favors title-like
 * matches ("NDIS" vs "NDIS overview") over the plain Jaro score.
 */
export function jaroWinklerSimilarity(a: string, b: string): number {
  const jaro = jaroSimilarity(a, b);
  if (jaro === 0) return 0;

  let prefixLength = 0;
  const maxPrefix = Math.min(WINKLER_MAX_PREFIX_LENGTH, a.length, b.length);
  for (let i = 0; i < maxPrefix; i++) {
    if (a[i] !== b[i]) break;
    prefixLength++;
  }

  return jaro + prefixLength * WINKLER_PREFIX_SCALE * (1 - jaro);
}
