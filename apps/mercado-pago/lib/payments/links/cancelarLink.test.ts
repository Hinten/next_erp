import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MercadoPagoHttpError,
  MercadoPagoNetworkError,
  MercadoPagoReauthRequiredError,
  type MercadoPagoApi,
} from '@delfrance/integrations-mercado-pago';
import {
  CODIGO_ERRO_LINK,
  MODO_LINK_PAGAMENTO,
  MOTIVO_RECUSA_LINK,
  STATUS_LINK_PAGAMENTO,
  cancelarLinkPagamentoRespostaSchema,
  erroLinkPagamentoSchema,
} from '@delfrance/schemas';

import {
  AGORA_MS,
  CAMINHO_LINKS,
  FakeDbLeitura,
  METODO_ID,
  PEDIDO_ID,
  UID,
  comoFirestore,
  docLink,
  docLinkLegado,
  linkId,
} from './testing/suporte';

const h = vi.hoisted(() => ({
  loadCtx: vi.fn(),
  resolveAccessToken: vi.fn(),
  marcarLinkTerminal: vi.fn(),
}));

vi.mock('../mercadoPago', async (importActual) => {
  const actual = await importActual<typeof import('../mercadoPago')>();
  return { ...actual, loadMercadoPagoContext: h.loadCtx };
});

vi.mock('./linkStore', () => ({ marcarLinkTerminal: h.marcarLinkTerminal }));

const { cancelarLink } = await import('./cancelarLink');

const PATCH_ESPERADO = {
  expires: true,
  expiration_date_to: '2026-09-29T12:00:00.000-03:00',
  date_of_expiration: '2026-09-29T12:00:00.000-03:00',
};

let db: FakeDbLeitura;
let api: {
  updatePreference: Mock<MercadoPagoApi['updatePreference']>;
};

async function executar(id = linkId(1)) {
  const entrada = { uid: UID, pedidoId: PEDIDO_ID, linkId: id, agoraMs: AGORA_MS };
  return cancelarLink(comoFirestore(db), entrada, { api: () => api as unknown as MercadoPagoApi });
}

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDbLeitura();
  db.semear(CAMINHO_LINKS, linkId(1), docLink());
  api = {
    updatePreference: vi.fn<MercadoPagoApi['updatePreference']>(async (id) => ({
      id,
      init_point: `https://mp.test/checkout/${id}`,
    })),
  };
  h.resolveAccessToken.mockResolvedValue('AT');
  h.loadCtx.mockResolvedValue({ metodoId: METODO_ID, resolveAccessToken: h.resolveAccessToken });
  h.marcarLinkTerminal.mockResolvedValue('marcado');
});

describe('cancelarLink — the happy path', () => {
  it('expires the preference NOW, then marks the link cancelado by the operator', async () => {
    const r = await executar();

    expect(r.status).toBe(200);
    expect(cancelarLinkPagamentoRespostaSchema.parse(r.corpo)).toEqual({
      linkId: linkId(1),
      status: STATUS_LINK_PAGAMENTO.cancelado,
    });
    expect(api.updatePreference).toHaveBeenCalledTimes(1);
    expect(api.updatePreference).toHaveBeenCalledWith('pref-1', PATCH_ESPERADO);
    expect(h.marcarLinkTerminal).toHaveBeenCalledTimes(1);
    expect(h.marcarLinkTerminal.mock.calls[0]![1]).toEqual({
      pedidoId: PEDIDO_ID,
      linkId: linkId(1),
      status: STATUS_LINK_PAGAMENTO.cancelado,
      encerradoEm: AGORA_MS,
      encerradoPorOuterRef: `documents/usuarios/${UID}`,
      erroEncerramento: null,
    });
  });

  it('marks the link only AFTER Mercado Pago accepted the expiry', async () => {
    await executar();
    const put = api.updatePreference.mock.invocationCallOrder[0]!;
    const marca = h.marcarLinkTerminal.mock.invocationCallOrder[0]!;
    expect(put).toBeLessThan(marca);
  });

  it('closes both deadlines with an explicit offset, never Z', async () => {
    await executar();
    const [, patch] = api.updatePreference.mock.calls[0]!;
    expect(patch.expiration_date_to).toMatch(/-03:00$/);
    expect(patch.date_of_expiration).toMatch(/-03:00$/);
    expect(JSON.stringify(patch)).not.toContain('Z"');
  });

  it('builds the client from the resolved access token', async () => {
    const fabrica = vi.fn(() => api as unknown as MercadoPagoApi);
    const entrada = { uid: UID, pedidoId: PEDIDO_ID, linkId: linkId(1), agoraMs: AGORA_MS };
    await cancelarLink(comoFirestore(db), entrada, { api: fabrica });
    expect(fabrica).toHaveBeenCalledWith('AT');
  });
});

describe('cancelarLink — the account comes from the link, never from the caller', () => {
  it('loads the account named by the link itself', async () => {
    db.semear(
      CAMINHO_LINKS,
      linkId(1),
      docLink({ contaMercadoPagoOuterRef: 'documents/metodo_pgto/outraConta' }),
    );
    await executar();
    expect(h.loadCtx).toHaveBeenCalledWith(comoFirestore(db), 'outraConta');
  });

  it('understands the short ref form the legacy corpus carries', async () => {
    db.semear(CAMINHO_LINKS, linkId(1), docLink({ contaMercadoPagoOuterRef: 'metodo_pgto/curta' }));
    await executar();
    expect(h.loadCtx).toHaveBeenCalledWith(comoFirestore(db), 'curta');
  });

  it.each([
    ['another collection', 'documents/integracoes/abc'],
    ['no ref at all', null],
    ['a blank ref', ''],
  ])('will not act on a link whose account ref is %s', async (_nome, ref) => {
    db.semear(CAMINHO_LINKS, linkId(1), docLink({ contaMercadoPagoOuterRef: ref }));
    const r = await executar();
    expect(r.status).toBe(409);
    expect(r.corpo).toMatchObject({ reason: MOTIVO_RECUSA_LINK.preferenciaInacessivel });
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(api.updatePreference).not.toHaveBeenCalled();
    expect(h.marcarLinkTerminal).not.toHaveBeenCalled();
  });
});

describe('cancelarLink — links that are not ours to touch', () => {
  it('404s on a link that does not exist', async () => {
    const r = await executar(linkId(9));
    expect(r.status).toBe(404);
    expect(erroLinkPagamentoSchema.parse(r.corpo).code).toBe(CODIGO_ERRO_LINK.linkNaoEncontrado);
    expect(api.updatePreference).not.toHaveBeenCalled();
  });

  it('refuses a LEGACY link (no modo): it belongs to the legacy application', async () => {
    db.semear(CAMINHO_LINKS, linkId(1), docLinkLegado());
    const r = await executar();
    expect(r.status).toBe(409);
    expect(r.corpo).toMatchObject({
      code: CODIGO_ERRO_LINK.naoElegivel,
      reason: MOTIVO_RECUSA_LINK.preferenciaInacessivel,
    });
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(api.updatePreference).not.toHaveBeenCalled();
    expect(h.marcarLinkTerminal).not.toHaveBeenCalled();
  });

  it.each([STATUS_LINK_PAGAMENTO.cancelado, STATUS_LINK_PAGAMENTO.concluido])(
    'answers a %s link with the status it has, calling nothing',
    async (status) => {
      db.semear(CAMINHO_LINKS, linkId(1), docLink({ status }));
      const r = await executar();
      expect(r.status).toBe(200);
      expect(cancelarLinkPagamentoRespostaSchema.parse(r.corpo)).toEqual({
        linkId: linkId(1),
        status,
      });
      expect(h.loadCtx).not.toHaveBeenCalled();
      expect(api.updatePreference).not.toHaveBeenCalled();
      expect(h.marcarLinkTerminal).not.toHaveBeenCalled();
    },
  );

  it('refuses a link with no preference id: there is nothing to expire', async () => {
    db.semear(CAMINHO_LINKS, linkId(1), docLink({ id: null }));
    const r = await executar();
    expect(r.status).toBe(409);
    expect(r.corpo).toMatchObject({ reason: MOTIVO_RECUSA_LINK.semPreferencia });
    expect(api.updatePreference).not.toHaveBeenCalled();
    expect(h.marcarLinkTerminal).not.toHaveBeenCalled();
  });

  it('cancels a link whose stored status is unreadable — it reads as aberto, end to end', async () => {
    // `lerLink` reads 'lixo' as aberto (the schema default), and so does the
    // store's `marcarLinkTerminal` (its own suite pins that it then WRITES): the
    // corrupt doc is expired and overwritten with cancelado, never stood down on.
    db.semear(CAMINHO_LINKS, linkId(1), docLink({ status: 'lixo' }));

    const r = await executar();

    expect(r.status).toBe(200);
    expect(cancelarLinkPagamentoRespostaSchema.parse(r.corpo)).toEqual({
      linkId: linkId(1),
      status: STATUS_LINK_PAGAMENTO.cancelado,
    });
    expect(api.updatePreference).toHaveBeenCalledWith('pref-1', PATCH_ESPERADO);
    expect(h.marcarLinkTerminal.mock.calls[0]![1]).toMatchObject({
      status: STATUS_LINK_PAGAMENTO.cancelado,
    });
  });

  it('cancels a shared link the same way as a per-person one', async () => {
    db.semear(
      CAMINHO_LINKS,
      linkId(1),
      docLink({ modo: MODO_LINK_PAGAMENTO.compartilhado, quantidadeMaxima: 3 }),
    );
    const r = await executar();
    expect(r.status).toBe(200);
    expect(api.updatePreference).toHaveBeenCalledTimes(1);
  });
});

describe('cancelarLink — when Mercado Pago does not cooperate', () => {
  it.each([403, 404])(
    'answers 409 preferenciaInacessivel on a %s and does NOT mark the link',
    async (status) => {
      api.updatePreference.mockRejectedValue(new MercadoPagoHttpError(`MP ${status}`, status, {}));
      const r = await executar();
      expect(r.status).toBe(409);
      expect(r.corpo).toMatchObject({
        code: CODIGO_ERRO_LINK.naoElegivel,
        reason: MOTIVO_RECUSA_LINK.preferenciaInacessivel,
      });
      // The preference may still be payable: the doc must keep saying so.
      expect(h.marcarLinkTerminal).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['a 500', new MercadoPagoHttpError('MP 500', 500, {})],
    ['a 429', new MercadoPagoHttpError('MP 429', 429, {})],
    ['a 400 on both PUTs (the fallback included)', new MercadoPagoHttpError('MP 400', 400, {})],
    ['a network failure', new MercadoPagoNetworkError('sem rede')],
    ['a dead grant', new MercadoPagoReauthRequiredError('refresh_failed', 'reconecte')],
  ])('rethrows %s for the route to map, marking nothing', async (_nome, erro) => {
    api.updatePreference.mockRejectedValue(erro);
    await expect(executar()).rejects.toBe(erro);
    expect(h.marcarLinkTerminal).not.toHaveBeenCalled();
  });

  it('retries a 400 once WITHOUT date_of_expiration, and marks the link when that is accepted', async () => {
    api.updatePreference.mockRejectedValueOnce(new MercadoPagoHttpError('MP 400', 400, {}));
    const r = await executar();

    expect(r.status).toBe(200);
    expect(cancelarLinkPagamentoRespostaSchema.parse(r.corpo).status).toBe(
      STATUS_LINK_PAGAMENTO.cancelado,
    );
    expect(api.updatePreference.mock.calls).toEqual([
      ['pref-1', PATCH_ESPERADO],
      ['pref-1', { expires: true, expiration_date_to: PATCH_ESPERADO.expiration_date_to }],
    ]);
    expect(h.marcarLinkTerminal).toHaveBeenCalledTimes(1);
    expect(h.marcarLinkTerminal.mock.calls[0]![1]).toMatchObject({
      status: STATUS_LINK_PAGAMENTO.cancelado,
      erroEncerramento: null,
    });
  });

  it('rethrows when the fallback is refused too — two PUTs, nothing marked', async () => {
    const segunda = new MercadoPagoHttpError('MP 400 de novo', 400, {});
    api.updatePreference
      .mockRejectedValueOnce(new MercadoPagoHttpError('MP 400', 400, {}))
      .mockRejectedValueOnce(segunda);
    await expect(executar()).rejects.toBe(segunda);
    expect(api.updatePreference).toHaveBeenCalledTimes(2);
    expect(h.marcarLinkTerminal).not.toHaveBeenCalled();
  });

  it('maps a 404 on the FALLBACK exactly like a 404 on the first PUT', async () => {
    api.updatePreference
      .mockRejectedValueOnce(new MercadoPagoHttpError('MP 400', 400, {}))
      .mockRejectedValueOnce(new MercadoPagoHttpError('MP 404', 404, {}));
    const r = await executar();
    expect(r.status).toBe(409);
    expect(r.corpo).toMatchObject({ reason: MOTIVO_RECUSA_LINK.preferenciaInacessivel });
    expect(h.marcarLinkTerminal).not.toHaveBeenCalled();
  });

  it('does not retry a 500: one PUT, rethrown', async () => {
    const erro = new MercadoPagoHttpError('MP 500', 500, {});
    api.updatePreference.mockRejectedValueOnce(erro);
    await expect(executar()).rejects.toBe(erro);
    expect(api.updatePreference).toHaveBeenCalledTimes(1);
    expect(h.marcarLinkTerminal).not.toHaveBeenCalled();
  });

  it('propagates a token failure before any expiry is attempted', async () => {
    const erro = new MercadoPagoReauthRequiredError('no_token', 'não conectada');
    h.resolveAccessToken.mockRejectedValue(erro);
    await expect(executar()).rejects.toBe(erro);
    expect(api.updatePreference).not.toHaveBeenCalled();
  });
});

describe('cancelarLink — the mark after the expiry', () => {
  it('reports the status another closer left when the link was already terminal', async () => {
    // An auto-close won the race between our read and our mark.
    h.marcarLinkTerminal.mockImplementation(async () => {
      db.semear(CAMINHO_LINKS, linkId(1), docLink({ status: STATUS_LINK_PAGAMENTO.concluido }));
      return 'ja-terminal';
    });
    const r = await executar();
    expect(r.status).toBe(200);
    expect(cancelarLinkPagamentoRespostaSchema.parse(r.corpo).status).toBe(
      STATUS_LINK_PAGAMENTO.concluido,
    );
  });

  it('404s when the link vanished before it could be marked', async () => {
    h.marcarLinkTerminal.mockResolvedValue('inexistente');
    const r = await executar();
    expect(r.status).toBe(404);
    expect(r.corpo).toMatchObject({ code: CODIGO_ERRO_LINK.linkNaoEncontrado });
  });
});
