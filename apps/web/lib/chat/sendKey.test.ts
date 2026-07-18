import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SEND_KEY, getSendKey, sendKeyAction, setSendKey } from './sendKey';

afterEach(() => {
  window.localStorage.clear();
});

describe('getSendKey / setSendKey', () => {
  it('defaults to ctrlEnter when unset', () => {
    expect(getSendKey()).toBe('ctrlEnter');
    expect(DEFAULT_SEND_KEY).toBe('ctrlEnter');
  });

  it('round-trips a stored preference', () => {
    setSendKey('enter');
    expect(getSendKey()).toBe('enter');
    setSendKey('ctrlEnter');
    expect(getSendKey()).toBe('ctrlEnter');
  });

  it('falls back to the default for an unrecognised stored value', () => {
    window.localStorage.setItem('chat:sendKey', 'garbage');
    expect(getSendKey()).toBe('ctrlEnter');
  });
});

describe('sendKeyAction', () => {
  it('ctrlEnter: ⌘/Ctrl+Enter sends, Enter is a newline', () => {
    expect(sendKeyAction('ctrlEnter', { key: 'Enter', ctrlOrMeta: true, shift: false })).toBe(
      'send',
    );
    expect(sendKeyAction('ctrlEnter', { key: 'Enter', ctrlOrMeta: false, shift: false })).toBe(
      'newline',
    );
  });

  it('enter: Enter sends, Shift+Enter and ⌘/Ctrl+Enter are newlines', () => {
    expect(sendKeyAction('enter', { key: 'Enter', ctrlOrMeta: false, shift: false })).toBe('send');
    expect(sendKeyAction('enter', { key: 'Enter', ctrlOrMeta: false, shift: true })).toBe(
      'newline',
    );
    expect(sendKeyAction('enter', { key: 'Enter', ctrlOrMeta: true, shift: false })).toBe(
      'newline',
    );
  });

  it('ignores non-Enter keys', () => {
    expect(sendKeyAction('enter', { key: 'a', ctrlOrMeta: false, shift: false })).toBe('ignore');
    expect(sendKeyAction('ctrlEnter', { key: 'Escape', ctrlOrMeta: true, shift: false })).toBe(
      'ignore',
    );
  });

  it('never sends mid-IME-composition (isComposing)', () => {
    // Enter would normally send in the `enter` mode, and ⌘/Ctrl+Enter in the
    // `ctrlEnter` mode — but an active composition confirms the IME candidate.
    expect(
      sendKeyAction('enter', { key: 'Enter', ctrlOrMeta: false, shift: false, isComposing: true }),
    ).toBe('ignore');
    expect(
      sendKeyAction('ctrlEnter', {
        key: 'Enter',
        ctrlOrMeta: true,
        shift: false,
        isComposing: true,
      }),
    ).toBe('ignore');
    // Sanity: the same events send once composition ends.
    expect(
      sendKeyAction('enter', { key: 'Enter', ctrlOrMeta: false, shift: false, isComposing: false }),
    ).toBe('send');
  });
});
