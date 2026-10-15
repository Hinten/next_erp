import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CODIGO_ERRO_LINK,
  MOTIVO_RECUSA_LINK,
  MOTIVO_RECUSA_LINK_LABELS,
} from '@delfrance/schemas';

import { FirebaseError } from 'firebase/app';

import {
  MercadoPagoClientHttpError,
  MercadoPagoClientNetworkError,
  MercadoPagoClientRespostaInvalidaError,
  MercadoPagoClientSessaoError,
  createMercadoPagoClient,
} from '@/lib/mercado-pago/client';

import { descreverFalhaLink, type ContextoFalhaLink } from './linkPagamentoErros';

const PODE: ContextoFalhaLink = { metodoId: 'conta1', podeReconectar: true };
const NAO_PODE: ContextoFalhaLink = { metodoId: 'conta1', podeReconectar: false };

const TITULO_REAUTH = 'Conta Mercado Pago desconectada';
const TITULO_GENERICO = 'Falha ao falar com o Mercado Pago';
const PECA_A_QUEM_ADMINISTRA =
  'Peça a quem administra os meios de pagamento para reconectar a conta.';

const NEXT_404 = '<!DOCTYPE html><html><head><title>404</title></head><body>404</body></html>';

/** An HTTP failure as the client raises it. */
function http(
  status: number,
  code: string | null,
  mensagem = 'mensagem do servidor',
  reason?: string,
): MercadoPagoClientHttpError {
  return new MercadoPagoClientHttpError(mensagem, status, code, reason ?? null);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('descreverFalhaLink — the reauth arm', () => {
  it('⭐ sends an operator who CAN reconnect to the account page', () => {
    expect(descreverFalhaLink(http(409, 'MP_REAUTH_REQUIRED'), PODE)).toStrictEqual({
      title: TITULO_REAUTH,
      message: 'Reconecte a conta para continuar.',
      link: { href: '/pagamentos/mercado-pago/conta1', label: 'Reconectar conta' },
    });
  });

  it('⭐ without the permission there is NO link, only the instruction', () => {
    // The page behind that link would show a disabled "Conectar" button.
    expect(descreverFalhaLink(http(409, 'MP_REAUTH_REQUIRED'), NAO_PODE)).toStrictEqual({
      title: TITULO_REAUTH,
      message: PECA_A_QUEM_ADMINISTRA,
    });
  });

  it('has no link when the account is unknown, even for an operator who could reconnect', () => {
    const d = descreverFalhaLink(http(409, 'MP_REAUTH_REQUIRED'), {
      metodoId: null,
      podeReconectar: true,
    });

    expect(d).not.toBeNull();
    expect(d).not.toHaveProperty('link');
    expect(d?.message).toBe(PECA_A_QUEM_ADMINISTRA);
  });

  it('encodes the account id in the href', () => {
    const d = descreverFalhaLink(http(409, 'MP_REAUTH_REQUIRED'), {
      metodoId: 'a b/c',
      podeReconectar: true,
    });

    expect(d?.link?.href).toBe('/pagamentos/mercado-pago/a%20b%2Fc');
  });

  it('is keyed on the code, not on the 409 status', () => {
    // A 409 that is NOT the reauth code must not send anyone to reconnect.
    const d = descreverFalhaLink(http(409, 'OUTRO_CONFLITO', 'conflito qualquer'), PODE);

    expect(d?.title).toBe(TITULO_GENERICO);
    expect(d).not.toHaveProperty('link');
    expect(d?.message).toBe('conflito qualquer');
  });
});

describe('descreverFalhaLink — LINK_NAO_ELEGIVEL', () => {
  it.each(Object.values(MOTIVO_RECUSA_LINK))('shows the label of %s', (reason) => {
    // The backend message is deliberately DIFFERENT from the label, so this
    // fails for an implementation that just echoes `err.message`.
    const err = http(409, CODIGO_ERRO_LINK.naoElegivel, 'texto do servidor', reason);

    expect(descreverFalhaLink(err, PODE)).toStrictEqual({
      title: 'Operação não permitida',
      message: MOTIVO_RECUSA_LINK_LABELS[reason],
    });
  });

  it.each([
    ['an unknown reason', 'motivoDoFuturo'],
    ['no reason', undefined],
    ['an empty reason', ''],
  ])('falls back to the backend message for %s', (_nome, reason) => {
    const err = http(409, CODIGO_ERRO_LINK.naoElegivel, 'texto do servidor', reason);

    const d = descreverFalhaLink(err, PODE);

    expect(d?.message).toBe('texto do servidor');
    expect(d?.title).toBe(TITULO_GENERICO);
  });

  it('a valid reason under ANOTHER code is not enough — the code gates the label', () => {
    const err = http(409, 'OUTRO_CONFLITO', 'texto do servidor', MOTIVO_RECUSA_LINK.excedeRestante);

    expect(descreverFalhaLink(err, PODE)?.message).toBe('texto do servidor');
  });
});

describe('descreverFalhaLink — statuses and the 404 near-miss', () => {
  it('⭐ MP_CONTA_NAO_CONFIGURADA says the ACCOUNT is not configured', () => {
    const err = http(404, CODIGO_ERRO_LINK.contaNaoConfigurada, 'texto do servidor');

    expect(descreverFalhaLink(err, PODE)).toStrictEqual({
      title: 'Conta Mercado Pago inválida',
      message: 'A conta escolhida não está configurada como Mercado Pago.',
    });
  });

  it('⭐ a 404 with NO code is a backend without the route — not a misconfigured account', () => {
    expect(descreverFalhaLink(http(404, null, 'HTTP 404'), PODE)).toStrictEqual({
      title: 'Backend do Mercado Pago desatualizado',
      message: 'O backend do Mercado Pago está desatualizado (rota não encontrada).',
    });
  });

  it.each([
    [CODIGO_ERRO_LINK.pedidoNaoEncontrado, 'Pedido não encontrado.'],
    [CODIGO_ERRO_LINK.linkNaoEncontrado, 'Link de pagamento não encontrado.'],
  ])('a 404 %s is the backend sentence, neither of the two above', (code, mensagem) => {
    const d = descreverFalhaLink(http(404, code, mensagem), PODE);

    expect(d?.message).toBe(mensagem);
    expect(d?.title).toBe(TITULO_GENERICO);
  });

  it('a 403 is a permission message', () => {
    expect(descreverFalhaLink(http(403, null), PODE)).toStrictEqual({
      title: 'Sem permissão',
      message: 'Sem permissão para gerenciar links de pagamento.',
    });
  });

  it('a 429 asks the operator to wait', () => {
    const err = http(429, CODIGO_ERRO_LINK.requisicaoRepetida);

    expect(descreverFalhaLink(err, PODE)).toStrictEqual({
      title: 'Aguarde um instante',
      message: 'Aguarde um minuto antes de sincronizar novamente.',
    });
  });

  it.each([
    [502, 'MP_HTTP_ERROR'],
    [502, 'MP_BAD_RESPONSE'],
    [503, 'MP_NETWORK_ERROR'],
  ])('a %i %s carries the Mercado Pago text after the lead-in', (status, code) => {
    expect(descreverFalhaLink(http(status, code, 'invalid token'), PODE)).toStrictEqual({
      title: 'Falha no Mercado Pago',
      message: 'O Mercado Pago não respondeu como esperado: invalid token',
    });
  });

  it.each([
    [500, 'MP_ERROR'],
    [401, 'auth/id-token-expired'],
    [400, CODIGO_ERRO_LINK.corpoInvalido],
    [418, null],
  ])('every other HTTP failure (%i %s) is the backend message, never null', (status, code) => {
    // Returning null here would make the CALLER rethrow a known failure as an
    // unhandled rejection.
    expect(descreverFalhaLink(http(status, code, 'texto do servidor'), PODE)).toStrictEqual({
      title: TITULO_GENERICO,
      message: 'texto do servidor',
    });
  });
});

describe('descreverFalhaLink — the client error classes', () => {
  it('⭐ RespostaInvalida is checked BEFORE its parent class', () => {
    // Status 502 is the discriminator: were this described as a plain HTTP
    // failure it would gain the "não respondeu como esperado" lead-in, which
    // is wrong for a body the backend answered with 2xx.
    const err = new MercadoPagoClientRespostaInvalidaError('corpo fora do formato', 502, ['links']);

    expect(descreverFalhaLink(err, PODE)).toStrictEqual({
      title: 'Resposta inesperada do Mercado Pago',
      message: 'corpo fora do formato',
    });
  });

  it('⭐ a session failure is checked BEFORE its parent class and asks to sign in again', () => {
    // As a plain 401 it would fall to the generic arm; as "Sem conexão" it would
    // keep the operator retrying a session that retrying cannot fix.
    const err = new MercadoPagoClientSessaoError('auth/user-token-expired');

    expect(descreverFalhaLink(err, PODE)).toStrictEqual({
      title: 'Sessão expirada',
      message: 'Sua sessão expirou. Entre novamente e tente de novo.',
    });
  });

  it('NEAR-MISS: a plain 401 from the backend is still the generic HTTP arm', () => {
    expect(descreverFalhaLink(http(401, null, 'token inválido'), PODE)).toStrictEqual({
      title: TITULO_GENERICO,
      message: 'token inválido',
    });
  });

  it('a network failure is described', () => {
    const err = new MercadoPagoClientNetworkError('Failed to fetch');

    expect(descreverFalhaLink(err, PODE)).toStrictEqual({
      title: 'Sem conexão',
      message: 'Sem conexão com o backend do Mercado Pago. Tente de novo.',
    });
  });

  it.each([
    ['a TypeError', new TypeError('x is undefined')],
    ['a plain Error', new Error('boom')],
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['an object shaped like the client error', { name: 'MercadoPagoClientHttpError', status: 500 }],
  ])('returns null for %s, so the caller rethrows it', (_nome, err) => {
    expect(descreverFalhaLink(err, PODE)).toBeNull();
  });
});

describe('descreverFalhaLink — a token the session cannot mint (through the real client)', () => {
  it.each<[string, string]>([
    ['auth/network-request-failed', 'Sem conexão'],
    ['auth/user-token-expired', 'Sessão expirada'],
  ])('%s reads as %s', async (code, titulo) => {
    const c = createMercadoPagoClient({
      baseUrl: 'http://localhost:3007',
      getAuthToken: () => Promise.reject(new FirebaseError(code, code)),
      fetch: async () => new Response('{}'),
    });
    const err = await c.sincronizarLinks({ pedidoId: 'ped_1' }).catch((e: unknown) => e);

    expect(descreverFalhaLink(err, PODE)?.title).toBe(titulo);
  });
});

describe('descreverFalhaLink — end to end through the real client', () => {
  /** What the tab actually catches: the client's own error for a stubbed answer. */
  async function falhaDoClient(resposta: () => Response): Promise<unknown> {
    const c = createMercadoPagoClient({
      baseUrl: 'http://localhost:3007',
      getAuthToken: async () => 'token',
      fetch: async () => resposta(),
    });
    return c.sincronizarLinks({ pedidoId: 'ped_1' }).catch((e: unknown) => e);
  }

  function jsonComStatus(corpo: unknown, status: number): Response {
    return new Response(JSON.stringify(corpo), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('⭐ the HTML 404 of a backend without the route reads as an outdated backend', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const err = await falhaDoClient(() => new Response(NEXT_404, { status: 404 }));

    expect(descreverFalhaLink(err, PODE)?.title).toBe('Backend do Mercado Pago desatualizado');
  });

  it('a real 404 MP_CONTA_NAO_CONFIGURADA body reads as a misconfigured account', async () => {
    const err = await falhaDoClient(() =>
      jsonComStatus({ error: 'x', code: CODIGO_ERRO_LINK.contaNaoConfigurada }, 404),
    );

    expect(descreverFalhaLink(err, PODE)?.title).toBe('Conta Mercado Pago inválida');
  });

  it('⭐ a real 409 body reaches its label — the reason survives the client', async () => {
    const reason = MOTIVO_RECUSA_LINK.valorDesatualizado;
    const err = await falhaDoClient(() =>
      jsonComStatus({ error: 'texto', code: CODIGO_ERRO_LINK.naoElegivel, reason }, 409),
    );

    expect(descreverFalhaLink(err, PODE)?.message).toBe(MOTIVO_RECUSA_LINK_LABELS[reason]);
  });

  it('a real 409 MP_REAUTH_REQUIRED body reaches the reconnect link', async () => {
    const err = await falhaDoClient(() =>
      jsonComStatus({ error: 'x', code: 'MP_REAUTH_REQUIRED' }, 409),
    );

    expect(descreverFalhaLink(err, PODE)?.link).toEqual({
      href: '/pagamentos/mercado-pago/conta1',
      label: 'Reconectar conta',
    });
  });

  it('a 2xx of the wrong shape is described with the client sentence', async () => {
    const err = await falhaDoClient(() => jsonComStatus({ encontrados: 'muitos' }, 200));

    expect(err).toBeInstanceOf(MercadoPagoClientRespostaInvalidaError);
    expect(descreverFalhaLink(err, PODE)).toEqual({
      title: 'Resposta inesperada do Mercado Pago',
      message: (err as MercadoPagoClientRespostaInvalidaError).message,
    });
  });

  it('a dropped connection reads as no connection', async () => {
    const err = await falhaDoClient(() => {
      throw new TypeError('Failed to fetch');
    });

    expect(descreverFalhaLink(err, PODE)?.title).toBe('Sem conexão');
  });
});
