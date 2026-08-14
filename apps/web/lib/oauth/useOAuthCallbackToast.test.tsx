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
  renderHook(() => useOAuthCallbackToast(CONFIG));
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

  it('stays silent when its own channel key is absent', () => {
    // Two channels can share a screen; a `me=error` must not fire the ML toast.
    render('me=error&reason=server_config');
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('stays silent on an unrelated navigation', () => {
    render('page=2');
    expect(h.notify).not.toHaveBeenCalled();
  });
});
