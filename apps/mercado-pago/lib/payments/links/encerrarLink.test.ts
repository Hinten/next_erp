import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MercadoPagoHttpError,
  MercadoPagoNetworkError,
  MercadoPagoReauthRequiredError,
  type MercadoPagoApi,
} from '@delfrance/integrations-mercado-pago';
import { MODO_LINK_PAGAMENTO, STATUS_LINK_PAGAMENTO, linkAtingiuCota } from '@delfrance/schemas';

import {
  AGORA_MS,
  CAMINHO_LINKS,
  FakeDbLeitura,
  METODO_ID,
  PEDIDO_ID,
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

const { encerrarLinkSeCompleto } = await import('./encerrarLink');

const PATCH_ESPERADO = {
  expires: true,
  expiration_date_to: '2026-09-29T12:00:00.000-03:00',
  date_of_expiration: '2026-09-29T12:00:00.000-03:00',
};

let db: FakeDbLeitura;
let api: { updatePreference: Mock<MercadoPagoApi['updatePreference']> };

async function executar(aprovados: number, metodoId = METODO_ID) {
  const entrada = {
    metodoId,
    pedidoId: PEDIDO_ID,
    linkId: linkId(1),
    aprovados,
    agoraMs: AGORA_MS,
  };
  return encerrarLinkSeCompleto(comoFirestore(db), entrada, {
    api: () => api as unknown as MercadoPagoApi,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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

describe('encerrarLinkSeCompleto — below the quota nothing happens', () => {
  it('leaves a per-person link open until its one payment is approved', async () => {
    expect(await executar(0)).toBe('aberto');
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(api.updatePreference).not.toHaveBeenCalled();
    expect(h.marcarLinkTerminal).not.toHaveBeenCalled();
  });

  it('leaves a shared link open one payment short of its quota', async () => {
    db.semear(
      CAMINHO_LINKS,
      linkId(1),
      docLink({ modo: MODO_LINK_PAGAMENTO.compartilhado, quantidadeMaxima: 3 }),
    );
    expect(await executar(2)).toBe('aberto');
    expect(api.updatePreference).not.toHaveBeenCalled();
    expect(h.marcarLinkTerminal).not.toHaveBeenCalled();
  });

  it('leaves a link open when the count is not a number', async () => {
    expect(await executar(Number.NaN)).toBe('aberto');
    expect(api.updatePreference).not.toHaveBeenCalled();
    expect(h.marcarLinkTerminal).not.toHaveBeenCalled();
  });

  it('reads a traceable link with no stored quota as accepting ONE payment', async () => {
    db.semear(CAMINHO_LINKS, linkId(1), docLink({ quantidadeMaxima: null }));
    expect(await executar(0)).toBe('aberto');
    expect(await executar(1)).toBe('encerrado');
  });

  it('decides exactly like linkAtingiuCota for every quota and count', async () => {
    // `null` is the traceable link with no stored quota — one payment closes it.
    for (const quota of [null, 1, 2, 3, 4, 5]) {
      for (let aprovados = 0; aprovados <= 6; aprovados += 1) {
        vi.clearAllMocks();
        const doc = docLink({ quantidadeMaxima: quota });
        db.semear(CAMINHO_LINKS, linkId(1), doc);

        const linhas = Array.from({ length: aprovados }, () => ({ dataAprovacao: AGORA_MS }));
        const esperado = linkAtingiuCota({ quantidadeMaxima: quota, modo: doc.modo }, linhas);
        const resultado = await executar(aprovados);

        expect(resultado === 'encerrado', `quota ${quota}, aprovados ${aprovados}`).toBe(esperado);
        expect(resultado === 'aberto', `quota ${quota}, aprovados ${aprovados}`).toBe(!esperado);
      }
    }
  });
});

describe('encerrarLinkSeCompleto — at the quota', () => {
  it.each([
    ['exactly at it', 1],
    ['past it (a redelivery counted an extra payment)', 2],
  ])('expires the preference and marks the link concluido, %s', async (_nome, aprovados) => {
    expect(await executar(aprovados)).toBe('encerrado');

    expect(api.updatePreference).toHaveBeenCalledTimes(1);
    expect(api.updatePreference).toHaveBeenCalledWith('pref-1', PATCH_ESPERADO);
    expect(h.marcarLinkTerminal).toHaveBeenCalledTimes(1);
    expect(h.marcarLinkTerminal.mock.calls[0]![1]).toEqual({
      pedidoId: PEDIDO_ID,
      linkId: linkId(1),
      status: STATUS_LINK_PAGAMENTO.concluido,
      encerradoEm: AGORA_MS,
      // Auto-closed: no operator did it.
      encerradoPorOuterRef: null,
      erroEncerramento: null,
    });
  });

  it('marks the link only AFTER the expiry went through', async () => {
    await executar(1);
    const put = api.updatePreference.mock.invocationCallOrder[0]!;
    const marca = h.marcarLinkTerminal.mock.invocationCallOrder[0]!;
    expect(put).toBeLessThan(marca);
  });

  it('uses the account the webhook resolved, not the one stored on the link', async () => {
    await executar(1, 'contaDoWebhook');
    expect(h.loadCtx).toHaveBeenCalledWith(comoFirestore(db), 'contaDoWebhook');
  });

  it('closes a link that has no preference to expire, and says why', async () => {
    db.semear(CAMINHO_LINKS, linkId(1), docLink({ id: null }));
    expect(await executar(1)).toBe('encerrado');
    expect(api.updatePreference).not.toHaveBeenCalled();
    expect(h.marcarLinkTerminal.mock.calls[0]![1]).toMatchObject({
      status: STATUS_LINK_PAGAMENTO.concluido,
      erroEncerramento: 'sem preferência',
    });
  });
});

describe('encerrarLinkSeCompleto — links that need no closing', () => {
  it('reports a missing link', async () => {
    db = new FakeDbLeitura();
    expect(await executar(1)).toBe('inexistente');
    expect(h.marcarLinkTerminal).not.toHaveBeenCalled();
  });

  it.each([STATUS_LINK_PAGAMENTO.concluido, STATUS_LINK_PAGAMENTO.cancelado])(
    'leaves an already %s link alone (a redelivery, or a cancel that won)',
    async (status) => {
      db.semear(CAMINHO_LINKS, linkId(1), docLink({ status }));
      expect(await executar(1)).toBe('ja-terminal');
      expect(api.updatePreference).not.toHaveBeenCalled();
      expect(h.marcarLinkTerminal).not.toHaveBeenCalled();
    },
  );

  it('never closes a LEGACY link: it was created under the legacy application', async () => {
    db.semear(CAMINHO_LINKS, linkId(1), docLinkLegado());
    expect(await executar(5)).toBe('ja-terminal');
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(api.updatePreference).not.toHaveBeenCalled();
    expect(h.marcarLinkTerminal).not.toHaveBeenCalled();
  });
});

describe('encerrarLinkSeCompleto — when Mercado Pago does not cooperate', () => {
  it.each([400, 403, 404])(
    'marks the link concluido WITH the error on a definitive %s, and reports erro-mp',
    async (status) => {
      api.updatePreference.mockRejectedValue(new MercadoPagoHttpError(`MP ${status}`, status, {}));
      expect(await executar(1)).toBe('erro-mp');
      expect(h.marcarLinkTerminal).toHaveBeenCalledTimes(1);
      expect(h.marcarLinkTerminal.mock.calls[0]![1]).toMatchObject({
        status: STATUS_LINK_PAGAMENTO.concluido,
        encerradoPorOuterRef: null,
        erroEncerramento: `MP ${status}`,
      });
    },
  );

  it('retries a 400 once WITHOUT date_of_expiration, and closes cleanly when that is accepted', async () => {
    api.updatePreference.mockRejectedValueOnce(new MercadoPagoHttpError('MP 400', 400, {}));
    expect(await executar(1)).toBe('encerrado');
    expect(api.updatePreference.mock.calls).toEqual([
      ['pref-1', PATCH_ESPERADO],
      ['pref-1', { expires: true, expiration_date_to: PATCH_ESPERADO.expiration_date_to }],
    ]);
    // The retry went through: no error is recorded on the link.
    expect(h.marcarLinkTerminal.mock.calls[0]![1]).toMatchObject({
      status: STATUS_LINK_PAGAMENTO.concluido,
      erroEncerramento: null,
    });
  });

  it('records the 400 only after the fallback is refused too (two PUTs, erro-mp)', async () => {
    api.updatePreference.mockRejectedValue(new MercadoPagoHttpError('MP 400', 400, {}));
    expect(await executar(1)).toBe('erro-mp');
    expect(api.updatePreference).toHaveBeenCalledTimes(2);
    expect(h.marcarLinkTerminal.mock.calls[0]![1]).toMatchObject({ erroEncerramento: 'MP 400' });
  });

  it('does not retry a 500: one PUT, thrown, the link left open', async () => {
    const erro = new MercadoPagoHttpError('MP 500', 500, {});
    api.updatePreference.mockRejectedValueOnce(erro);
    await expect(executar(1)).rejects.toBe(erro);
    expect(api.updatePreference).toHaveBeenCalledTimes(1);
    expect(h.marcarLinkTerminal).not.toHaveBeenCalled();
  });

  it.each([
    ['a 429 (rate limiting)', new MercadoPagoHttpError('MP 429', 429, {})],
    ['a 500', new MercadoPagoHttpError('MP 500', 500, {})],
    ['a 503', new MercadoPagoHttpError('MP 503', 503, {})],
    ['a network failure', new MercadoPagoNetworkError('sem rede')],
    ['a dead grant', new MercadoPagoReauthRequiredError('refresh_failed', 'reconecte')],
  ])('THROWS on %s so the task retries, and leaves the link open', async (_nome, erro) => {
    api.updatePreference.mockRejectedValue(erro);
    await expect(executar(1)).rejects.toBe(erro);
    expect(h.marcarLinkTerminal).not.toHaveBeenCalled();
  });

  it('throws when the token cannot be resolved, before any expiry', async () => {
    const erro = new MercadoPagoReauthRequiredError('no_token', 'não conectada');
    h.resolveAccessToken.mockRejectedValue(erro);
    await expect(executar(1)).rejects.toBe(erro);
    expect(api.updatePreference).not.toHaveBeenCalled();
    expect(h.marcarLinkTerminal).not.toHaveBeenCalled();
  });

  it('reports what the mark said when another closer got there first', async () => {
    h.marcarLinkTerminal.mockResolvedValue('ja-terminal');
    expect(await executar(1)).toBe('ja-terminal');

    // ...and on the refusal path too: only the call that RECORDED the error says erro-mp.
    api.updatePreference.mockRejectedValue(new MercadoPagoHttpError('MP 403', 403, {}));
    expect(await executar(1)).toBe('ja-terminal');

    h.marcarLinkTerminal.mockResolvedValue('inexistente');
    expect(await executar(1)).toBe('inexistente');
  });
});
