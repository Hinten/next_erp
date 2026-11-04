import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// `useSearchParams` and the notification sink are the only seams — the hook is
// otherwise pure. Same hoisted-mock shape as
// canais/mercado-livre/_components/useMassImportAction.test.tsx.
const h = vi.hoisted(() => ({
  params: new URLSearchParams(),
  notify: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useSearchParams: () => h.params }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: h.notify } }));

const { oauthCallbackMessage, useOAuthCallbackToast } = await import('./useOAuthCallbackToast');

const MENSAGENS = {
  server_config: 'Servidor sem credenciais.',
  codigo_invalido: 'O código expirou.',
} as const;

const CONFIG = {
  chave: 'ml',
  sucesso: 'Conta conectada.',
  tituloErro: 'Falha ao conectar',
  mensagens: MENSAGENS,
};

function render(query: string) {
  h.params = new URLSearchParams(query);
  h.notify.mockClear();
  const { rerender } = renderHook(() => useOAuthCallbackToast(CONFIG));
  // What `useSearchParams` does on every URL change, the TableView's own
  // `history.replaceState` included: a NEW params object, same mounted hook.
  return (next: string) => {
    h.params = new URLSearchParams(next);
    rerender();
  };
}

describe('oauthCallbackMessage', () => {
  it('maps a known slug to its actionable message', () => {
    expect(oauthCallbackMessage('codigo_invalido', MENSAGENS)).toBe('O código expirou.');
  });

  it('echoes an unknown slug only when it looks like one of ours', () => {
    expect(oauthCallbackMessage('algo_novo', MENSAGENS)).toBe(
      'Motivo não reconhecido (algo_novo).',
    );
  });

  // Near-miss pair. `server_config` is an OWN key of the map; `constructor` is only
  // an INHERITED one. A bare `mensagens[reason]` cannot tell them apart — it hands
  // back `Object`, a truthy FUNCTION, which the toast would render as an empty red
  // notification instead of the unknown-reason fallback.
  it('resolves a slug the map actually owns', () => {
    expect(oauthCallbackMessage('server_config', MENSAGENS)).toBe('Servidor sem credenciais.');
  });

  it.each([
    ['constructor', 'Motivo não reconhecido (constructor).'],
    ['__proto__', 'Motivo não reconhecido (__proto__).'],
    // `valueOf` carries an uppercase letter, so it fails the slug alphabet too and
    // lands one branch further along — same class of key, different fallback.
    ['valueOf', 'Motivo não informado.'],
  ])('treats the inherited %j as unknown, never as a message', (reason, esperado) => {
    const msg = oauthCallbackMessage(reason, MENSAGENS);
    expect(typeof msg).toBe('string');
    expect(msg).toBe(esperado);
  });

  it.each([
    ['<img src=x onerror=alert(1)>', 'an HTML payload'],
    ['a'.repeat(64), 'an overlong value'],
    ['UPPER-case', 'characters outside the slug alphabet'],
  ])('refuses to reflect %j (%s)', (reason) => {
    // `reason` arrives in the URL and is untrusted. React escapes it, but an
    // arbitrary query string must never reach the UI verbatim regardless.
    const msg = oauthCallbackMessage(reason, MENSAGENS);
    expect(msg).toBe('Motivo não informado.');
    expect(msg).not.toContain(reason);
  });

  it('handles a missing reason', () => {
    expect(oauthCallbackMessage(null, MENSAGENS)).toBe('Motivo não informado.');
  });
});

describe('useOAuthCallbackToast', () => {
  it('toasts success when the channel key says connected', () => {
    render('ml=connected');
    expect(h.notify).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'green', message: 'Conta conectada.' }),
    );
  });

  it('toasts the mapped message with a title on error', () => {
    render('ml=error&reason=server_config');
    expect(h.notify).toHaveBeenCalledWith({
      color: 'red',
      title: 'Falha ao conectar',
      message: 'Servidor sem credenciais.',
    });
  });

  it('toasts the fallback text, not a function, for a prototype-named reason', () => {
    render('ml=error&reason=constructor');
    expect(h.notify).toHaveBeenCalledWith({
      color: 'red',
      title: 'Falha ao conectar',
      message: 'Motivo não reconhecido (constructor).',
    });
  });

  it('stays silent when its own channel key is absent', () => {
    // Two channels can share a screen; a `me=error` must not fire the ML toast.
    render('me=error&reason=server_config');
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('stays silent on an unrelated navigation', () => {
    render('page=2');
    expect(h.notify).not.toHaveBeenCalled();
  });

  // Near-miss pair. The list pages that mount this hook also mount a TableView,
  // which mirrors its sort into the query string and keeps every foreign key — so
  // the SAME callback result arrives again inside a NEW params object. Keyed on
  // that object, the effect re-showed the failure on every sort click.
  it('shows a callback result once when an unrelated param changes around it', () => {
    const navegar = render('ml=error&reason=bad_state');
    navegar('ml=error&reason=bad_state&sort=nome');
    navegar('ml=error&reason=bad_state&sort=-nome&pages=2');
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('still shows a genuinely new callback result on the same mounted page', () => {
    const navegar = render('ml=error&reason=bad_state&sort=nome');
    navegar('ml=error&reason=server_config&sort=nome');
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(h.notify).toHaveBeenLastCalledWith({
      color: 'red',
      title: 'Falha ao conectar',
      message: 'Servidor sem credenciais.',
    });
  });
});
