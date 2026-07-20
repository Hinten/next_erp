/**
 * Composer "send key" preference, backed by `localStorage` under
 * `chat:sendKey`. Legacy offered Enter / Alt+Enter / Ctrl+Enter / Shift+Enter
 * (`.old/lib/chat/basico/chat_input.dart:435-458`, key `enviarMsg`); this port
 * keeps the two the modern composer supports:
 *   - `ctrlEnter` (default) — ⌘/Ctrl+Enter sends, Enter inserts a newline;
 *   - `enter` — Enter sends, Shift+Enter inserts a newline.
 */

const KEY = 'chat:sendKey';

export type SendKey = 'enter' | 'ctrlEnter';

export const DEFAULT_SEND_KEY: SendKey = 'ctrlEnter';

/** The stored send-key preference, or the default when unset/unavailable. */
export function getSendKey(): SendKey {
  if (typeof window === 'undefined') return DEFAULT_SEND_KEY;
  try {
    return window.localStorage.getItem(KEY) === 'enter' ? 'enter' : DEFAULT_SEND_KEY;
  } catch (err) {
    // localStorage can throw (private mode / disabled storage) — fall back to
    // the default; rethrow anything else (repo rule: no generic catch).
    if (err instanceof DOMException) return DEFAULT_SEND_KEY;
    throw err;
  }
}

/** Persist the send-key preference. No-op on the server / when unavailable. */
export function setSendKey(value: SendKey): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, value);
  } catch (err) {
    if (err instanceof DOMException) return;
    throw err;
  }
}

/**
 * Given a keydown (`key` + whether ⌘/Ctrl or Shift is held) and the current
 * preference, decide the composer's reaction. Pure so it is unit-testable
 * without a DOM event.
 *   - `send`    → submit the message (preventDefault);
 *   - `newline` → let the textarea insert a newline (default behaviour);
 *   - `ignore`  → not the Enter key (or mid-IME-composition), do nothing special.
 */
export function sendKeyAction(
  pref: SendKey,
  ev: { key: string; ctrlOrMeta: boolean; shift: boolean; isComposing?: boolean },
): 'send' | 'newline' | 'ignore' {
  if (ev.key !== 'Enter') return 'ignore';
  // Mid-IME-composition (e.g. selecting a CJK candidate): Enter confirms the
  // candidate — it must NOT send. Let the IME/textarea handle it (`ignore`).
  if (ev.isComposing) return 'ignore';
  if (pref === 'ctrlEnter') {
    return ev.ctrlOrMeta ? 'send' : 'newline';
  }
  // pref === 'enter': Enter sends, Shift+Enter (or ⌘/Ctrl+Enter) inserts a newline.
  return ev.shift || ev.ctrlOrMeta ? 'newline' : 'send';
}
