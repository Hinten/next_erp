import { Fragment, type ReactNode } from 'react';

/**
 * In-thread search highlighting — the pure splitter + a thin renderer used by
 * `useThreadSearch` (`.old/lib/chat/providers/conversaManager.dart:136-226`
 * ported to a regex-capable search). Legacy highlighted whole matching messages
 * as it navigated between them; this keeps that message-level "active" notion
 * (the current hit's marks render distinctly) while marking every matched
 * substring inside a message.
 */

/** One run of message text: a literal chunk or a matched (highlighted) chunk. */
export interface HighlightSegment {
  text: string;
  match: boolean;
}

/** Hard cap on marks per message — a pathological pattern never floods the DOM. */
export const MAX_MATCHES_PER_MESSAGE = 50;

/** Escape a literal string for safe embedding in a `RegExp` (the search fallback). */
export function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Force the global flag on so `exec` iterates every occurrence (dedupe 'g'). */
function withGlobal(re: RegExp): RegExp {
  return re.flags.includes('g') ? re : new RegExp(re.source, `${re.flags}g`);
}

/**
 * Split `text` into literal/matched segments against `regex`. Pure + allocation-
 * bounded:
 *   - a ZERO-WIDTH match (e.g. `a*` matching '') never advances `lastIndex`, so
 *     it is skipped (guard bumps past it) — no infinite loop, no empty marks;
 *   - at most {@link MAX_MATCHES_PER_MESSAGE} marks; the remainder is one literal
 *     tail segment.
 * Adjacent matches produce adjacent `match: true` segments (no empty gaps).
 */
export function splitHighlight(
  text: string,
  regex: RegExp,
  maxMatches: number = MAX_MATCHES_PER_MESSAGE,
): HighlightSegment[] {
  if (text === '') return [];
  const re = withGlobal(regex);
  re.lastIndex = 0;

  const segments: HighlightSegment[] = [];
  let cursor = 0;
  let count = 0;
  let m: RegExpExecArray | null;

  while (count < maxMatches && (m = re.exec(text)) !== null) {
    // Zero-width match: skip it and advance, otherwise `exec` loops forever.
    if (m[0] === '') {
      re.lastIndex += 1;
      continue;
    }
    const start = m.index;
    const end = start + m[0].length;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: m[0], match: true });
    cursor = end;
    count += 1;
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}

/**
 * Render `text` with the substrings matching `regex` wrapped in `<mark>`. When
 * `active`, the current hit's marks render in a distinct (stronger) colour so
 * the operator can see which message navigation landed on. `regex == null`
 * (no active search) renders the plain text unchanged.
 */
export function HighlightedText({
  text,
  regex,
  active = false,
}: {
  text: string;
  regex: RegExp | null;
  active?: boolean;
}): ReactNode {
  if (!regex) return text;
  const segments = splitHighlight(text, regex);
  if (segments.length === 0) return text;
  return segments.map((seg, i) =>
    seg.match ? (
      <mark
        key={i}
        data-active={active || undefined}
        style={{
          backgroundColor: active
            ? 'var(--mantine-color-orange-4)'
            : 'var(--mantine-color-yellow-3)',
          color: 'inherit',
          borderRadius: 2,
          padding: '0 1px',
        }}
      >
        {seg.text}
      </mark>
    ) : (
      <Fragment key={i}>{seg.text}</Fragment>
    ),
  );
}
