'use client';

import { useMemo } from 'react';
import { Text } from '@mantine/core';
import DOMPurify from 'dompurify';
import { HighlightedText } from '@/lib/chat/highlight';

/** Cheap heuristic: does the string contain an HTML tag? */
function looksLikeHtml(s: string): boolean {
  return /<[a-z][\s\S]*>/i.test(s);
}

/** Strip tags for a text-only fallback (SSR / no DOM available). */
function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

/**
 * Message body renderer:
 *   - ML-origem HTML (`ORIGEM_RULES[origem].isHtml` AND the body looks like
 *     HTML) → sanitized via DOMPurify and rendered as markup (legacy
 *     `HtmlWidget(sanitizeHtml(conteudo))`, `mensagem.dart:303-304`);
 *   - otherwise plain text with newlines preserved and the search term
 *     highlighted (highlight is skipped in the HTML branch).
 *
 * DOMPurify needs a DOM; the thread only ever renders client-side (behind
 * `useRequireAuth`, data via `onSnapshot`), so the `typeof window` guard's
 * tag-stripped fallback is a defensive path, not the hot path.
 */
export function MensagemContent({
  conteudo,
  isHtml,
  regex,
  active = false,
}: {
  conteudo: string;
  isHtml: boolean;
  regex: RegExp | null;
  active?: boolean;
}) {
  const html = useMemo(() => {
    if (!isHtml || !looksLikeHtml(conteudo)) return null;
    if (typeof window === 'undefined') return null;
    return DOMPurify.sanitize(conteudo);
  }, [conteudo, isHtml]);

  if (isHtml && looksLikeHtml(conteudo)) {
    if (html == null) {
      // No DOM yet — render the tag-stripped text so nothing dangerous shows.
      return (
        <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {stripTags(conteudo)}
        </Text>
      );
    }
    return (
      <Text
        size="sm"
        component="div"
        style={{ wordBreak: 'break-word' }}
        // Sanitized above with DOMPurify — safe to inject.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      <HighlightedText text={conteudo} regex={regex} active={active} />
    </Text>
  );
}
