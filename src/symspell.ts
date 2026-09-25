// symspell.ts — symmetric-delete fuzzy index (SymSpell core), the single
// distance engine behind Milton's three fuzzy matchers:
//
//   1. fuzzy.ts intent matcher — bestToken over MATCHERS keyword aliases
//      (index built once at module load; one lookup per input token).
//   2. commands.ts suggestCommands — input words over the command target
//      vocabulary (index built once beside the commandRegistry cache).
//   3. crm.ts matchByName — query tokens over entity name tokens, backing
//      the typo tier (index rebuilt per call from the fetched snapshot;
//      the fetch is the refresh policy — nothing to cache or invalidate).
//
// How it works: the index maps every delete variant (all strings reachable
// by 1..maxEdit deletions) of every dictionary word back to its word(s).
// Lookup generates the query's own deletes and intersects. Any two words
// within edit distance d share a delete variant — substitutions, insertions
// and deletions reduce to a shared delete trivially, and an adjacent
// transposition does too (deleting the same one of the two transposed
// characters from both words yields the same string) — so no candidate
// within maxEdit is ever missed.
//
// Precision is NOT the index's job. Every candidate is verified by the
// caller's own accept predicate (per-pair budget, guards, boundedEdit), so
// each consumer keeps its exact current acceptance behavior; the index only
// narrows the candidate set.
//
// Fully deterministic: dictionary words are inserted in sorted order (each
// variant's word list is therefore sorted), and lookup results are sorted
// by (distance asc, word asc). No randomness, no clock.

/** Every unique string reachable by deleting 1..maxEdit chars from word. */
export function deletesOf(word: string, maxEdit: number): Set<string> {
  const out = new Set<string>();
  let level = new Set<string>([word]);
  for (let d = 0; d < maxEdit; d++) {
    const next = new Set<string>();
    for (const w of level) {
      for (let i = 0; i < w.length; i++) {
        const v = w.slice(0, i) + w.slice(i + 1);
        if (!out.has(v)) {
          out.add(v);
          next.add(v);
        }
      }
    }
    level = next;
    if (level.size === 0) break;
  }
  return out;
}

export interface SymHit {
  word: string;
  d: number; // caller-verified distance (whatever accept returned)
}

export interface SymSpellIndex {
  /** Number of dictionary words in the index. */
  readonly size: number;
  /**
   * Every dictionary word the caller's accept predicate admits for q,
   * sorted by (distance asc, word asc) for deterministic consumers.
   * accept(word) returns the verified distance, or null to reject.
   */
  lookup(q: string, accept: (word: string) => number | null): SymHit[];
}

export function buildSymSpellIndex(words: Iterable<string>, maxEdit = 2): SymSpellIndex {
  const dict = [...new Set(words)].sort();
  const variantToWords = new Map<string, string[]>();
  const addVariant = (variant: string, word: string) => {
    const arr = variantToWords.get(variant);
    if (arr) arr.push(word); // dict sorted => every word list stays sorted
    else variantToWords.set(variant, [word]);
  };
  for (const w of dict) {
    addVariant(w, w); // the word itself: exact hits need no deletions
    for (const v of deletesOf(w, maxEdit)) addVariant(v, w);
  }
  return {
    size: dict.length,
    lookup(q: string, accept: (word: string) => number | null): SymHit[] {
      const seen = new Set<string>();
      const hits: SymHit[] = [];
      const probe = (v: string) => {
        const arr = variantToWords.get(v);
        if (!arr) return;
        for (const w of arr) {
          if (seen.has(w)) continue;
          seen.add(w);
          const d = accept(w);
          if (d !== null) hits.push({ word: w, d });
        }
      };
      probe(q);
      for (const v of deletesOf(q, maxEdit)) probe(v);
      hits.sort((a, b) => a.d - b.d || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
      return hits;
    },
  };
}
