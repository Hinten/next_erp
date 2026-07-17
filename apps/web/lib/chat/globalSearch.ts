import type { Mensagem } from '@delfrance/schemas';
import { searchableText, testRegex } from './searchRegex';

/**
 * Pure core for CROSS-CONVERSATION search (PR-C5). The impure hook
 * (`useGlobalSearch`) fetches bounded pages of the `mensagem` collection-group
 * (orderBy timestamp desc); everything here — client-side regex matching,
 * per-conversa grouping, and snippet extraction — is a pure transform so it can
 * be unit-tested with plain fixtures. Matching reuses the SHARED thread
 * semantics (`searchableText` + a non-global `.test()`), so a term that hits in
 * the thread hits here identically.
 */

/** One fetched group-query row: the parsed message + its recovered location. */
export interface FetchedMensagem {
  conversaId: string;
  mensagemId: string;
  /** ms-epoch ordering key (the collection-group orderBy field); may be null. */
  timestamp: number | null;
  mensagem: Mensagem;
}

/** A single message that matched the search term, with its searchable text. */
export interface GlobalMatchRow {
  conversaId: string;
  mensagemId: string;
  timestamp: number | null;
  /** The full haystack the match was found in (snippet is derived from it). */
  text: string;
}

/** Matches within one conversa, plus the conversa's newest-match timestamp. */
export interface ConversaGroup {
  conversaId: string;
  /** Matches in the fetched (newest-first) order. */
  matches: GlobalMatchRow[];
  /** The newest matching-message timestamp in the group (for ordering). */
  newestTimestamp: number | null;
}

/**
 * Filter fetched docs down to the ones whose searchable text matches `regex`.
 * Preserves input order (the caller feeds newest-first pages). Event bubbles
 * (`tipo 'e'`) and text-less media are dropped by `searchableText`.
 */
export function matchFetched(docs: FetchedMensagem[], regex: RegExp): GlobalMatchRow[] {
  const test = testRegex(regex);
  const rows: GlobalMatchRow[] = [];
  for (const d of docs) {
    const text = searchableText(d.mensagem);
    if (text != null && test.test(text)) {
      rows.push({
        conversaId: d.conversaId,
        mensagemId: d.mensagemId,
        timestamp: d.timestamp,
        text,
      });
    }
  }
  return rows;
}

/**
 * Group match rows by conversa, ordered by newest match first. The caller feeds
 * rows newest-first (the group query is orderBy timestamp desc), so a first-seen
 * grouping preserves that: each conversa surfaces at the position of its newest
 * match, and matches within a group stay newest-first. Stable + allocation-light.
 */
export function groupMatches(rows: GlobalMatchRow[]): ConversaGroup[] {
  const byConversa = new Map<string, ConversaGroup>();
  const order: string[] = [];
  for (const row of rows) {
    let group = byConversa.get(row.conversaId);
    if (!group) {
      group = { conversaId: row.conversaId, matches: [], newestTimestamp: row.timestamp };
      byConversa.set(row.conversaId, group);
      order.push(row.conversaId);
    }
    group.matches.push(row);
    // Track the newest timestamp seen (rows arrive newest-first, but a null
    // timestamp mustn't clobber a real one, so guard the max explicitly).
    if (
      row.timestamp != null &&
      (group.newestTimestamp == null || row.timestamp > group.newestTimestamp)
    ) {
      group.newestTimestamp = row.timestamp;
    }
  }
  return order.map((id) => byConversa.get(id)!);
}

/** A truncated window of text around the first match, with ellipsis flags. */
export interface Snippet {
  /** The sliced text (highlight the match inside it with the shared splitter). */
  text: string;
  /** True when text was cut on the left (prepend '…'). */
  prefixEllipsis: boolean;
  /** True when text was cut on the right (append '…'). */
  suffixEllipsis: boolean;
}

/** Default context radius (chars) kept on each side of the first match. */
export const SNIPPET_RADIUS = 60;

/**
 * Extract a snippet of `text` centred on the FIRST match of `regex`, keeping
 * `radius` chars of context on each side. When the pattern doesn't match (should
 * not happen for a row already filtered by {@link matchFetched}) the head of the
 * text is returned. The returned `text` is re-highlighted by the caller with the
 * same regex, so match offsets shifting under truncation is a non-issue.
 */
export function buildSnippet(
  text: string,
  regex: RegExp,
  radius: number = SNIPPET_RADIUS,
): Snippet {
  const re = testRegex(regex);
  const m = re.exec(text);
  const matchStart = m ? m.index : 0;
  const matchEnd = m ? m.index + m[0].length : 0;
  const start = Math.max(0, matchStart - radius);
  const end = Math.min(text.length, matchEnd + radius);
  return {
    text: text.slice(start, end),
    prefixEllipsis: start > 0,
    suffixEllipsis: end < text.length,
  };
}
