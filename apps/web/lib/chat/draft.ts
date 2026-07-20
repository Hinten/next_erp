/**
 * Per-conversa unsent-draft store, backed by `localStorage` under the key
 * `chat:draft:<conversaId>`. The tile reads the "has a draft" indicator
 * (legacy `getRascunhoMensagem(...).isNotEmpty` → a `textsms` icon,
 * `.old/lib/chat/menu_lateral.dart:763-768`); the composer (PR-C3) restores the
 * draft on mount, saves it debounced while typing, and clears it on a
 * successful send (legacy `setRascunhoMensagem`/`clearRascunhoMensagem`,
 * `.old/lib/chat/providers/conversaProvider.dart:992-1013`).
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

/**
 * Persist (or, for empty text, clear) the conversa's draft. A no-op on the
 * server / when storage is unavailable — a lost draft is never worth throwing.
 */
export function setDraft(conversaId: string, text: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (text === '') {
      window.localStorage.removeItem(draftKey(conversaId));
    } else {
      window.localStorage.setItem(draftKey(conversaId), text);
    }
  } catch (err) {
    // Same rationale as `getDraft`: a DOMException (private mode / disabled
    // storage) means "can't persist the draft" — swallow it, rethrow anything
    // else (repo rule: no generic catch).
    if (err instanceof DOMException) return;
    throw err;
  }
}

/** Remove the conversa's saved draft (post-send). */
export function clearDraft(conversaId: string): void {
  setDraft(conversaId, '');
}
