import type { Mensagem } from '@delfrance/schemas';
import { TIPO_MENSAGEM } from '@delfrance/schemas';
import { escapeRegExp } from './highlight';

/**
 * The SHARED regex-search core for chat, used by BOTH the in-thread search
 * (`useThreadSearch`) and the cross-conversation search (`useGlobalSearch` /
 * `lib/chat/globalSearch`). Extracted here so the two consumers apply IDENTICAL
 * semantics — the regex build (`iu`, SyntaxError→literal fallback, zero-width
 * guard, 200-char cap) and the searchable-haystack selection — from one place.
 * A regex-capable port of the legacy substring search
 * (`.old/lib/chat/providers/conversaManager.dart:136-226`).
 */

/**
 * Hard cap on the search-term length. A user-authored regex runs against every
 * loaded message, so an unbounded term is a catastrophic-backtracking blast
 * radius — capping the input bounds the worst-case per-message match cost.
 */
export const MAX_TERM_LENGTH = 200;

/** Fields on a message the search can read (the `AnyMensagem` haystack subset). */
type SearchableMensagem = Pick<
  Mensagem,
  | 'tipo'
  | 'conteudo'
  | 'transcription'
  | 'image'
  | 'video'
  | 'sticker'
  | 'genericDocument'
  | 'anexoDescription'
>;

/**
 * The searchable haystack for one message: text first, then a transcription,
 * then a media caption (legacy searched `conteudo`/`transcription`; captions are
 * added so media replies are findable). Event bubbles (`tipo 'e'`) are never
 * searched (legacy `searchMensagem` skips them). Returns `null` when there is
 * nothing to match.
 */
export function searchableText(m: SearchableMensagem): string | null {
  if (m.tipo === TIPO_MENSAGEM.evento) return null;
  if (typeof m.conteudo === 'string' && m.conteudo.trim() !== '') return m.conteudo;
  if (typeof m.transcription === 'string' && m.transcription.trim() !== '') return m.transcription;
  const caption =
    m.image?.caption ??
    m.video?.caption ??
    m.sticker?.caption ??
    m.genericDocument?.caption ??
    null;
  if (typeof caption === 'string' && caption.trim() !== '') return caption;
  if (typeof m.anexoDescription === 'string' && m.anexoDescription.trim() !== '')
    return m.anexoDescription;
  return null;
}

/** The compiled search regex plus whether it fell back to a literal search. */
export interface SearchRegex {
  /** The effective regex (user pattern or literal fallback), or null when idle. */
  regex: RegExp | null;
  /** True when the user's pattern was invalid/zero-width → fell back to literal. */
  isLiteral: boolean;
}

/**
 * Build the effective search regex. Empty term → `{ regex: null }`. A valid
 * pattern that would match the empty string (`.*`, `x?`, …) is treated like an
 * invalid one: we fall back to a literal search so highlighting never marks
 * empty spans. On a `SyntaxError` (invalid pattern) we also fall back to a
 * literal (`escapeRegExp`) and flag `isLiteral` so the UI can show a hint.
 */
export function buildSearchRegex(term: string): SearchRegex {
  // Cap the term length before compiling — bounds catastrophic-backtracking
  // blast radius from a pathological user pattern (see MAX_TERM_LENGTH).
  const trimmed = term.trim().slice(0, MAX_TERM_LENGTH);
  if (trimmed === '') return { regex: null, isLiteral: false };
  try {
    const re = new RegExp(trimmed, 'iu');
    // Zero-width guard: a pattern that matches '' would highlight nothing useful
    // and can stall the splitter — fall back to literal.
    if (re.test('')) return { regex: literalRegex(trimmed), isLiteral: true };
    return { regex: re, isLiteral: false };
  } catch (err) {
    // Only an invalid pattern (SyntaxError) falls back; anything else is a bug.
    if (!(err instanceof SyntaxError)) throw err;
    return { regex: literalRegex(trimmed), isLiteral: true };
  }
}

/**
 * A fresh, NON-global copy of `regex` suitable for repeated `.test()` — a global
 * regex's stateful `lastIndex` would make consecutive tests skip messages.
 */
export function testRegex(regex: RegExp): RegExp {
  return new RegExp(regex.source, regex.flags.replace('g', ''));
}

function literalRegex(term: string): RegExp {
  return new RegExp(escapeRegExp(term), 'iu');
}
