/**
 * Per-conversa unsent-draft store, backed by `localStorage` under the key
 * `chat:draft:<conversaId>`. The composer rework (a later PR) will read/write
 * these; this PR only needs the tile's "has a draft" indicator (legacy
 * `getRascunhoMensagem(...).isNotEmpty` → a `textsms` icon,
 * `.old/lib/chat/menu_lateral.dart:763-768`).
 */

const PREFIX = 'chat:draft:';

export function draftKey(conversaId: string): string {
  return `${PREFIX}${conversaId}`;
}

/** The stored draft text for a conversa, or '' when none / unavailable (SSR). */
export function getDraft(conversaId: string): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(draftKey(conversaId)) ?? '';
  } catch (err) {
    // localStorage access can throw a DOMException (private mode / disabled
    // storage / blocked cookies) — treat that as "no draft"; rethrow anything
    // else (repo rule: no generic catch).
    if (err instanceof DOMException) return '';
    throw err;
  }
}

/** Whether the conversa has a non-empty saved draft. */
export function hasDraft(conversaId: string): boolean {
  return getDraft(conversaId).trim() !== '';
}
