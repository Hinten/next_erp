import type { Mensagem } from '@delfrance/schemas';
import { TIPO_MENSAGEM } from '@delfrance/schemas';

/**
 * The SHARED regex-search core for chat, used by BOTH the in-thread search
 * (`useThreadSearch`) and the cross-conversation search (`useGlobalSearch` /
 * `lib/chat/globalSearch`). Extracted here so the two consumers apply IDENTICAL
 * semantics — accent-folded matching with original-text spans, regex build
 * (`iu`, SyntaxError→literal fallback, zero-width guard, 200-char cap), and the
 * searchable-haystack selection — from one place.
 * A regex-capable port of the legacy substring search
 * (`.old/lib/chat/providers/conversaManager.dart:136-226`).
 */

/**
 * Hard cap on the search-term length. A user-authored regex runs against every
 * loaded message, so an unbounded term is a catastrophic-backtracking blast
 * radius — capping the input bounds the worst-case per-message match cost.
 */
export const MAX_TERM_LENGTH = 200;

/**
 * Fold canonical accents for chat search, and nothing else. Case stays in the
 * regex's `i` flag; punctuation, whitespace and different base letters remain
 * distinct. NFD also makes precomposed and decomposed input behave identically.
 */
export function foldSearchText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '');
}

/** Escape a literal string for safe embedding in a `RegExp` (the fallback). */
export function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
 * Accent folding happens at execution time so the original compiled pattern is
 * retained for exact matches and the original text remains available to mark.
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

export interface SearchMatchSpan {
  /** UTF-16 offsets into the ORIGINAL (unfolded) text. */
  start: number;
  end: number;
}

function literalRegex(term: string): RegExp {
  return new RegExp(escapeRegExp(term), 'iu');
}

interface FoldedWithOffsets {
  text: string;
  starts: number[];
  ends: number[];
}

/**
 * Fold a haystack while retaining a UTF-16 offset map back to its original
 * spelling. The map is what lets `acao` highlight the exact original `ação`
 * (including a separately encoded combining mark) rather than a rewritten copy.
 */
function foldWithOffsets(text: string): FoldedWithOffsets {
  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];

  for (let start = 0; start < text.length; ) {
    const codePoint = text.codePointAt(start);
    if (codePoint == null) break;
    const original = String.fromCodePoint(codePoint);
    const end = start + original.length;
    let emitted = false;

    for (const part of original.normalize('NFD')) {
      if (/\p{M}/u.test(part)) continue;
      emitted = true;
      folded += part;
      for (let i = 0; i < part.length; i += 1) {
        starts.push(start);
        ends.push(end);
      }
    }

    // A combining mark can be a separate code point in the source. Attribute
    // it to the preceding base so a highlight never leaves the mark behind.
    if (!emitted && ends.length > 0) ends[ends.length - 1] = end;
    start = end;
  }

  return { text: folded, starts, ends };
}

function executableRegex(regex: RegExp, global: boolean, foldSource: boolean): RegExp {
  const flags = regex.flags.replace(/g/g, '');
  const source = foldSource ? foldSearchText(regex.source) : regex.source;
  return new RegExp(source, global ? `${flags}g` : flags);
}

function advancePastEmpty(text: string, index: number): number {
  const codePoint = text.codePointAt(index);
  return index + (codePoint != null && codePoint > 0xffff ? 2 : 1);
}

/**
 * Locate matches on accent-folded text and return their spans in the original
 * text. Regex syntax is preserved: only literal canonical accent marks in the
 * pattern and haystack are folded.
 */
export function findSearchRegexMatches(
  text: string,
  regex: RegExp,
  maxMatches: number = Number.POSITIVE_INFINITY,
): SearchMatchSpan[] {
  if (text === '' || maxMatches <= 0) return [];
  const originalMatches = findOriginalMatches(text, regex, maxMatches);
  const folded = foldWithOffsets(text);
  const re = executableRegex(regex, true, true);
  // Folding a pattern made only of combining marks can turn it into an empty
  // regex. The original pass above still preserves that pattern's old matches;
  // the folded pass must add no zero-width storm.
  if (re.test('')) return originalMatches;
  re.lastIndex = 0;
  const foldedMatches: SearchMatchSpan[] = [];
  let match: RegExpExecArray | null;

  while (foldedMatches.length < maxMatches && (match = re.exec(folded.text)) !== null) {
    if (match[0] === '') {
      re.lastIndex = advancePastEmpty(folded.text, re.lastIndex);
      continue;
    }
    const start = folded.starts[match.index];
    const end = folded.ends[match.index + match[0].length - 1];
    if (start != null && end != null) foldedMatches.push({ start, end });
  }

  // Run the original regex too. This keeps every pre-fold behavior — including
  // specialized mark patterns — then adds only accent-folded spans that do not
  // overlap an existing exact match.
  const merged = [...originalMatches];
  for (const candidate of foldedMatches) {
    const overlaps = merged.some(
      (existing) => candidate.start < existing.end && candidate.end > existing.start,
    );
    if (!overlaps) merged.push(candidate);
  }
  return merged.sort((a, b) => a.start - b.start || a.end - b.end).slice(0, maxMatches);
}

function findOriginalMatches(text: string, regex: RegExp, maxMatches: number): SearchMatchSpan[] {
  const re = executableRegex(regex, true, false);
  const matches: SearchMatchSpan[] = [];
  let match: RegExpExecArray | null;
  while (matches.length < maxMatches && (match = re.exec(text)) !== null) {
    if (match[0] === '') {
      re.lastIndex = advancePastEmpty(text, re.lastIndex);
      continue;
    }
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return matches;
}

/** A stateless accent-insensitive `.test()` for repeated message scans. */
export function searchRegexMatches(regex: RegExp, text: string): boolean {
  return findSearchRegexMatches(text, regex, 1).length === 1;
}

/** The first original-text span matched by the effective regex, if any. */
export function firstSearchRegexMatch(text: string, regex: RegExp): SearchMatchSpan | null {
  return findSearchRegexMatches(text, regex, 1)[0] ?? null;
}
