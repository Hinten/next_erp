import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MercadoPagoHttpError,
  MercadoPagoReauthRequiredError,
  type MercadoPagoApi,
  type MpPaymentSearch,
} from '@delfrance/integrations-mercado-pago';
import {
  CODIGO_ERRO_LINK,
  ESTADO_PEDIDO,
  MOTIVO_RECUSA_LINK,
  erroLinkPagamentoSchema,
  sincronizarLinksPagamentoRespostaSchema,
} from '@delfrance/schemas';

import { MercadoPagoConfigError, MercadoPagoContaNotConfiguredError } from '../mercadoPago';
import type { ReconcileOutcome, processNotificationPayload } from '../notificacao';
import {
  AGORA_MS,
  CAMINHO_LINKS,
  CAMINHO_PAGAMENTOS,
  CAMINHO_PEDIDOS,
  FakeDbLeitura,
  METODO_ID,
  PEDIDO_ID,
  comoFirestore,
  docLink,
  docLinkLegado,
  docPagamento,
  docPedido,
  linkId,
} from './testing/suporte';

const h = vi.hoisted(() => ({
  loadCtx: vi.fn(),
}));

// The account loader is replaced (keeping the real error classes the code narrows
// on); the pipeline entry point arrives through `deps.process`, so what is under
// test is the SEARCH, the paging, the fan-out and the tally — never the reconcile.
vi.mock('../mercadoPago', async (importActual) => {
  const actual = await importActual<typeof import('../mercadoPago')>();
  return { ...actual, loadMercadoPagoContext: h.loadCtx };
});

const { sincronizarPedido } = await import('./sincronizarPedido');

const USER_ID = 4242;

/** The ref a link or pagamento stores for the account `id`. */
const refDaConta = (id: string) => `documents/metodo_pgto/${id}`;

/** A conta context for `metodoId`: connected (user_id) unless `userId` says otherwise. */
function contexto(metodoId: string, userId: unknown = USER_ID) {
  return {
    metodoId,
    conta: { hasLinkPagamento: true, user_id: userId },
    resolveAccessToken: vi.fn(async () => `AT-${metodoId}`),
  };
}

/** A search page: ids `[de, ate]` inclusive, all for `PEDIDO_ID` unless told otherwise. */
function pagina(de: number, ate: number, total?: number) {
  const results = Array.from({ length: ate - de + 1 }, (_, k) => ({
    id: de + k,
    external_reference: PEDIDO_ID,
  }));
  return { paging: total === undefined ? null : { total, limit: 30, offset: 0 }, results };
}

function reconciliado(detail: ReconcileOutcome = 'sem-transicao', metodoId: string = METODO_ID) {
  return { kind: 'reconciled' as const, metodoId, pedidoId: PEDIDO_ID, detail };
}

let db: FakeDbLeitura;
let api: { searchPayments: Mock<MercadoPagoApi['searchPayments']> };
let processar: Mock<typeof processNotificationPayload>;
let fabrica: Mock<(token: string) => MercadoPagoApi>;

async function executar() {
  const entrada = { pedidoId: PEDIDO_ID, agoraMs: AGORA_MS };
  return sincronizarPedido(comoFirestore(db), entrada, { process: processar, api: fabrica });
}

/** The pedido has one link on `METODO_ID`, so exactly that account is synchronised. */
function pedidoComUmaConta() {
  db.semear(CAMINHO_LINKS, linkId(1), docLink());
}

/** A link of the pedido stored against the account `conta`. */
function semearLinkDaConta(n: number, conta: string) {
  db.semear(CAMINHO_LINKS, linkId(n), docLink({ contaMercadoPagoOuterRef: refDaConta(conta) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDbLeitura();
  db.semear(CAMINHO_PEDIDOS, PEDIDO_ID, docPedido());
  api = { searchPayments: vi.fn<MercadoPagoApi['searchPayments']>() };
  api.searchPayments.mockResolvedValue({ paging: null, results: [] });
  fabrica = vi.fn<(token: string) => MercadoPagoApi>(() => api as unknown as MercadoPagoApi);
  processar = vi.fn<typeof processNotificationPayload>(async () => reconciliado());
  h.loadCtx.mockImplementation(async (_db: unknown, metodoId: string) => contexto(metodoId));
});

describe('sincronizarPedido — which accounts', () => {
  it('404s on a pedido that does not exist', async () => {
    db = new FakeDbLeitura();
    const r = await executar();
    expect(r.status).toBe(404);
    expect(erroLinkPagamentoSchema.parse(r.corpo).code).toBe(CODIGO_ERRO_LINK.pedidoNaoEncontrado);
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('answers 409 semConta when nothing on the pedido names an account', async () => {
    const r = await executar();
    expect(r.status).toBe(409);
    expect(r.corpo).toMatchObject({
      code: CODIGO_ERRO_LINK.naoElegivel,
      reason: MOTIVO_RECUSA_LINK.semConta,
    });
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(api.searchPayments).not.toHaveBeenCalled();
  });

  it('derives the accounts from LEGACY links and from pagamentos, each once', async () => {
    // A legacy link (no modo) on account A, a modern one on A again, and a
    // pagamento recorded on account B whose link doc is gone.
    const legado = docLinkLegado({ contaMercadoPagoOuterRef: refDaConta('A') });
    db.semear(CAMINHO_LINKS, linkId(1), legado);
    semearLinkDaConta(2, 'A');
    const pagamento = docPagamento({ metodoPagamentoOuterRef: refDaConta('B') });
    db.semear(CAMINHO_PAGAMENTOS, 'pgto1', pagamento);
    await executar();
    expect(h.loadCtx.mock.calls.map(([, metodoId]) => metodoId)).toEqual(['A', 'B']);
    expect(api.searchPayments).toHaveBeenCalledTimes(2);
  });

  it('ignores a link or pagamento whose ref is not a metodo_pgto', async () => {
    db.semear(CAMINHO_LINKS, linkId(1), docLink({ contaMercadoPagoOuterRef: 'documents/x/y' }));
    db.semear(CAMINHO_PAGAMENTOS, 'pgto1', docPagamento({ metodoPagamentoOuterRef: null }));
    const r = await executar();
    expect(r.status).toBe(409);
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('skips an id that is not a Mercado Pago account, and syncs the others', async () => {
    // A pagamento registered by hand against a cash / card-machine method.
    pedidoComUmaConta();
    db.semear(
      CAMINHO_PAGAMENTOS,
      'pgto1',
      docPagamento({ metodoPagamentoOuterRef: refDaConta('maquininha') }),
    );
    h.loadCtx.mockImplementation(async (_db: unknown, metodoId: string) => {
      if (metodoId === 'maquininha') throw new MercadoPagoContaNotConfiguredError('não é MP');
      return contexto(metodoId);
    });
    api.searchPayments.mockResolvedValue(pagina(1, 2));

    const r = await executar();

    expect(r.status).toBe(200);
    expect(sincronizarLinksPagamentoRespostaSchema.parse(r.corpo).encontrados).toBe(2);
    expect(fabrica).toHaveBeenCalledTimes(1);
    expect(fabrica).toHaveBeenCalledWith(`AT-${METODO_ID}`);
  });

  it('answers 409 semConta when NONE of the ids is a usable Mercado Pago account', async () => {
    pedidoComUmaConta();
    h.loadCtx.mockRejectedValue(new MercadoPagoContaNotConfiguredError('não encontrado'));
    const r = await executar();
    expect(r.status).toBe(409);
    expect(r.corpo).toMatchObject({ reason: MOTIVO_RECUSA_LINK.semConta });
  });

  it('does not swallow a misconfigured server', async () => {
    pedidoComUmaConta();
    const erro = new MercadoPagoConfigError('MERCADO_PAGO_CLIENT_ID ausente');
    h.loadCtx.mockRejectedValue(erro);
    await expect(executar()).rejects.toBe(erro);
  });

  it('propagates a dead grant instead of reporting an empty sync', async () => {
    pedidoComUmaConta();
    const erro = new MercadoPagoReauthRequiredError('no_token', 'não conectada');
    h.loadCtx.mockImplementation(async (_db: unknown, metodoId: string) => ({
      ...contexto(metodoId),
      resolveAccessToken: vi.fn().mockRejectedValue(erro),
    }));
    await expect(executar()).rejects.toBe(erro);
  });

  it('searches each account with ITS OWN token', async () => {
    semearLinkDaConta(1, 'A');
    semearLinkDaConta(2, 'B');
    await executar();
    expect(fabrica.mock.calls.map(([token]) => token)).toEqual(['AT-A', 'AT-B']);
  });
});

describe('sincronizarPedido — the search and its paging', () => {
  beforeEach(pedidoComUmaConta);

  it('searches by the pedido id, 30 at a time, from offset 0', async () => {
    await executar();
    expect(api.searchPayments).toHaveBeenCalledTimes(1);
    expect(api.searchPayments).toHaveBeenCalledWith({
      externalReference: PEDIDO_ID,
      offset: 0,
      limit: 30,
    });
  });

  it('reads a second page when the first is full, and stops at the short one', async () => {
    api.searchPayments
      .mockResolvedValueOnce(pagina(1, 30, 35))
      .mockResolvedValueOnce(pagina(31, 35, 35));
    const r = await executar();

    expect(api.searchPayments.mock.calls.map(([p]) => p.offset)).toEqual([0, 30]);
    expect(processar).toHaveBeenCalledTimes(35);
    expect(sincronizarLinksPagamentoRespostaSchema.parse(r.corpo)).toMatchObject({
      encontrados: 35,
      reconciliados: 35,
      truncado: false,
    });
  });

  it('stops when a FULL page already reaches the reported total', async () => {
    api.searchPayments.mockResolvedValueOnce(pagina(1, 30, 30));
    await executar();
    expect(api.searchPayments).toHaveBeenCalledTimes(1);
  });

  it('keeps paging while the total says there is more', async () => {
    api.searchPayments
      .mockResolvedValueOnce(pagina(1, 30, 31))
      .mockResolvedValueOnce(pagina(31, 31, 31));
    await executar();
    expect(api.searchPayments).toHaveBeenCalledTimes(2);
  });

  it('reads at most 10 pages and reports the result as truncated', async () => {
    for (let p = 0; p < 12; p += 1) {
      api.searchPayments.mockResolvedValueOnce(pagina(p * 30 + 1, p * 30 + 30, 1000));
    }
    const r = await executar();
    expect(api.searchPayments).toHaveBeenCalledTimes(10);
    expect(sincronizarLinksPagamentoRespostaSchema.parse(r.corpo)).toMatchObject({
      encontrados: 300,
      truncado: true,
    });
  });

  it('is NOT truncated when the tenth page is exactly the last', async () => {
    for (let p = 0; p < 10; p += 1) {
      api.searchPayments.mockResolvedValueOnce(pagina(p * 30 + 1, p * 30 + 30, 300));
    }
    const r = await executar();
    expect(api.searchPayments).toHaveBeenCalledTimes(10);
    expect(sincronizarLinksPagamentoRespostaSchema.parse(r.corpo).truncado).toBe(false);
  });

  it('pages on when no total is reported, and stops at the first short page', async () => {
    api.searchPayments.mockResolvedValueOnce(pagina(1, 30)).mockResolvedValueOnce(pagina(31, 40));
    await executar();
    expect(api.searchPayments).toHaveBeenCalledTimes(2);
  });

  it('treats a response with no results as an empty sync', async () => {
    api.searchPayments.mockResolvedValue({} as MpPaymentSearch);
    const r = await executar();
    expect(r.status).toBe(200);
    expect(sincronizarLinksPagamentoRespostaSchema.parse(r.corpo)).toEqual({
      encontrados: 0,
      reconciliados: 0,
      ignorados: 0,
      falhas: [],
      transicoes: [],
      truncado: false,
    });
    expect(processar).not.toHaveBeenCalled();
  });
});

describe('sincronizarPedido — feeding the webhook pipeline', () => {
  beforeEach(pedidoComUmaConta);

  it('runs each payment through the pipeline exactly once, as a payment notification', async () => {
    api.searchPayments.mockResolvedValue(pagina(101, 103));
    await executar();
    expect(processar).toHaveBeenCalledTimes(3);
    for (const [k, id] of [101, 102, 103].entries()) {
      expect(processar.mock.calls[k]![1]).toEqual({
        id: null,
        paymentId: String(id),
        topic: 'payment',
        collectorUserId: USER_ID,
        liveMode: null,
        dateCreated: null,
      });
    }
  });

  it('processes a payment once even when the paging returns it twice', async () => {
    api.searchPayments
      .mockResolvedValueOnce(pagina(1, 30, 60))
      .mockResolvedValueOnce(pagina(30, 59, 60));
    await executar();
    // 1..30 then 30..59 → 59 distinct ids, not 60.
    expect(processar).toHaveBeenCalledTimes(59);
  });

  it('skips a result whose external_reference is another pedido, uncounted', async () => {
    api.searchPayments.mockResolvedValue({
      paging: null,
      results: [
        { id: 1, external_reference: PEDIDO_ID },
        { id: 2, external_reference: 'outroPedido' },
        { id: 3, external_reference: null },
        { id: 4 },
      ],
    });
    const r = await executar();
    expect(processar).toHaveBeenCalledTimes(1);
    expect(processar.mock.calls[0]![1]).toMatchObject({ paymentId: '1' });
    expect(sincronizarLinksPagamentoRespostaSchema.parse(r.corpo).encontrados).toBe(1);
  });

  it('processes a payment found under two accounts once', async () => {
    semearLinkDaConta(2, 'B');
    api.searchPayments.mockResolvedValue(pagina(7, 8));
    await executar();
    expect(api.searchPayments).toHaveBeenCalledTimes(2);
    expect(processar).toHaveBeenCalledTimes(2);
  });

  it('runs the payments one at a time', async () => {
    api.searchPayments.mockResolvedValue(pagina(1, 2));
    let liberar: () => void = () => {};
    const primeira = new Promise<void>((resolve) => {
      liberar = resolve;
    });
    processar.mockImplementationOnce(async () => {
      await primeira;
      return reconciliado();
    });
    const execucao = executar();
    await vi.waitFor(() => expect(processar).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(processar).toHaveBeenCalledTimes(1);
    liberar();
    await execucao;
    expect(processar).toHaveBeenCalledTimes(2);
  });

  it('lets a transient failure escape, so the route maps it and a re-run resumes', async () => {
    api.searchPayments.mockResolvedValue(pagina(1, 3));
    const queda = new Error('firestore indisponível');
    processar.mockResolvedValueOnce(reconciliado()).mockRejectedValueOnce(queda);
    await expect(executar()).rejects.toBe(queda);
    expect(processar).toHaveBeenCalledTimes(2);
  });
});

describe('sincronizarPedido — the tally', () => {
  beforeEach(pedidoComUmaConta);

  it('counts reconciled payments and lists each estado the pedido moved to, once', async () => {
    api.searchPayments.mockResolvedValue(pagina(1, 4));
    processar
      .mockResolvedValueOnce(reconciliado(ESTADO_PEDIDO.pago))
      .mockResolvedValueOnce(reconciliado(ESTADO_PEDIDO.pago))
      .mockResolvedValueOnce(reconciliado(ESTADO_PEDIDO.emAnalise))
      .mockResolvedValueOnce(reconciliado('sem-transicao'));
    const r = await executar();
    expect(sincronizarLinksPagamentoRespostaSchema.parse(r.corpo)).toEqual({
      encontrados: 4,
      reconciliados: 4,
      ignorados: 0,
      falhas: [],
      transicoes: [ESTADO_PEDIDO.pago, ESTADO_PEDIDO.emAnalise],
      truncado: false,
    });
  });

  it('counts a stale redelivery as ignored, not reconciled', async () => {
    api.searchPayments.mockResolvedValue(pagina(1, 2));
    processar
      .mockResolvedValueOnce(reconciliado('stale-ignorado'))
      .mockResolvedValueOnce(reconciliado(ESTADO_PEDIDO.pago));
    const r = await executar();
    expect(sincronizarLinksPagamentoRespostaSchema.parse(r.corpo)).toMatchObject({
      reconciliados: 1,
      ignorados: 1,
      transicoes: [ESTADO_PEDIDO.pago],
    });
  });

  it('counts a dropped payment (sandbox) as ignored', async () => {
    api.searchPayments.mockResolvedValue(pagina(1, 1));
    processar.mockResolvedValue({
      kind: 'dropped',
      reason: 'payment.live_mode=false (sandbox)',
      detail: 'sandbox-refetch',
      metodoId: METODO_ID,
    });
    const r = await executar();
    expect(sincronizarLinksPagamentoRespostaSchema.parse(r.corpo)).toMatchObject({
      encontrados: 1,
      reconciliados: 0,
      ignorados: 1,
      falhas: [],
    });
  });

  it('reports a parked payment as a failure carrying the pipeline reason', async () => {
    api.searchPayments.mockResolvedValue(pagina(11, 12));
    processar
      .mockResolvedValueOnce({ kind: 'failed', reason: 'pagamento 11 inexistente (404)' })
      .mockResolvedValueOnce(reconciliado());
    const r = await executar();
    expect(sincronizarLinksPagamentoRespostaSchema.parse(r.corpo)).toMatchObject({
      encontrados: 2,
      reconciliados: 1,
      falhas: [{ paymentId: '11', motivo: 'pagamento 11 inexistente (404)' }],
    });
  });

  it('reports a payment reconciled under ANOTHER account as a failure, not a success', async () => {
    api.searchPayments.mockResolvedValue(pagina(1, 1));
    processar.mockResolvedValue(reconciliado(ESTADO_PEDIDO.pago, 'contaErrada'));
    const r = await executar();
    expect(sincronizarLinksPagamentoRespostaSchema.parse(r.corpo)).toEqual({
      encontrados: 1,
      reconciliados: 0,
      ignorados: 0,
      falhas: [{ paymentId: '1', motivo: 'conta divergente' }],
      transicoes: [],
      truncado: false,
    });
  });
});

describe('sincronizarPedido — an account with no collector id', () => {
  beforeEach(pedidoComUmaConta);

  it.each([null, 0, 42.5, '4242'])(
    'never guesses the account when user_id is %s: every payment is a failure',
    async (userId) => {
      h.loadCtx.mockImplementation(async (_db: unknown, metodoId: string) =>
        contexto(metodoId, userId),
      );
      api.searchPayments.mockResolvedValue(pagina(1, 2));
      const r = await executar();

      expect(api.searchPayments).toHaveBeenCalledTimes(1);
      expect(processar).not.toHaveBeenCalled();
      expect(sincronizarLinksPagamentoRespostaSchema.parse(r.corpo)).toEqual({
        encontrados: 2,
        reconciliados: 0,
        ignorados: 0,
        falhas: [
          { paymentId: '1', motivo: 'conta sem usuário' },
          { paymentId: '2', motivo: 'conta sem usuário' },
        ],
        transicoes: [],
        truncado: false,
      });
    },
  );

  it('still syncs the other accounts of the pedido', async () => {
    semearLinkDaConta(2, 'B');
    h.loadCtx.mockImplementation(async (_db: unknown, metodoId: string) =>
      contexto(metodoId, metodoId === METODO_ID ? null : USER_ID),
    );
    api.searchPayments.mockResolvedValueOnce(pagina(1, 1)).mockResolvedValueOnce(pagina(2, 2));
    // Account B is the one actually synced, so the pipeline resolves B.
    processar.mockResolvedValue(reconciliado('sem-transicao', 'B'));
    const r = await executar();
    expect(processar).toHaveBeenCalledTimes(1);
    expect(processar.mock.calls[0]![1]).toMatchObject({ paymentId: '2' });
    expect(sincronizarLinksPagamentoRespostaSchema.parse(r.corpo)).toMatchObject({
      encontrados: 2,
      reconciliados: 1,
      falhas: [{ paymentId: '1', motivo: 'conta sem usuário' }],
    });
  });
});

describe('sincronizarPedido — an account whose grant is dead', () => {
  /** Two accounts on the pedido: A first, then B. */
  beforeEach(() => {
    semearLinkDaConta(1, 'A');
    semearLinkDaConta(2, 'B');
  });

  /** `loadMercadoPagoContext` answering a dead grant for the accounts in `mortas`. */
  function contasMortas(mortas: Record<string, MercadoPagoReauthRequiredError>) {
    h.loadCtx.mockImplementation(async (_db: unknown, metodoId: string) => {
      const erro = mortas[metodoId];
      if (erro === undefined) return contexto(metodoId);
      return { ...contexto(metodoId), resolveAccessToken: vi.fn().mockRejectedValue(erro) };
    });
  }

  it('records ONE failure for the dead account and still syncs the next one', async () => {
    contasMortas({ A: new MercadoPagoReauthRequiredError('refresh_failed', 'reconecte') });
    api.searchPayments.mockResolvedValue(pagina(7, 8));
    processar.mockResolvedValue(reconciliado(ESTADO_PEDIDO.pago, 'B'));

    const r = await executar();

    expect(r.status).toBe(200);
    expect(fabrica.mock.calls.map(([token]) => token)).toEqual(['AT-B']);
    expect(sincronizarLinksPagamentoRespostaSchema.parse(r.corpo)).toEqual({
      encontrados: 2,
      reconciliados: 2,
      ignorados: 0,
      falhas: [{ paymentId: '-', motivo: 'conta Mercado Pago desconectada: A' }],
      transicoes: [ESTADO_PEDIDO.pago],
      truncado: false,
    });
  });

  it('treats a 401 on the SEARCH (reauth) like a dead refresh', async () => {
    api.searchPayments
      .mockRejectedValueOnce(new MercadoPagoReauthRequiredError('refresh_failed', '401'))
      .mockResolvedValueOnce(pagina(9, 9));
    processar.mockResolvedValue(reconciliado('sem-transicao', 'B'));

    const r = await executar();

    expect(r.status).toBe(200);
    expect(sincronizarLinksPagamentoRespostaSchema.parse(r.corpo)).toMatchObject({
      encontrados: 1,
      reconciliados: 1,
      falhas: [{ paymentId: '-', motivo: 'conta Mercado Pago desconectada: A' }],
    });
  });

  it('rethrows the FIRST dead grant when no account could be synchronised at all', async () => {
    const primeira = new MercadoPagoReauthRequiredError('refresh_failed', 'A morta');
    contasMortas({ A: primeira, B: new MercadoPagoReauthRequiredError('no_token', 'B morta') });
    await expect(executar()).rejects.toBe(primeira);
    expect(processar).not.toHaveBeenCalled();
  });

  it('rethrows the dead grant, not semConta, when the other account is not Mercado Pago', async () => {
    const erro = new MercadoPagoReauthRequiredError('refresh_failed', 'A morta');
    h.loadCtx.mockImplementation(async (_db: unknown, metodoId: string) => {
      if (metodoId === 'B') throw new MercadoPagoContaNotConfiguredError('não é MP');
      return { ...contexto(metodoId), resolveAccessToken: vi.fn().mockRejectedValue(erro) };
    });
    await expect(executar()).rejects.toBe(erro);
  });

  it('rethrows the dead grant when the only other account has no user_id to process with', async () => {
    const erro = new MercadoPagoReauthRequiredError('refresh_failed', 'A morta');
    h.loadCtx.mockImplementation(async (_db: unknown, metodoId: string) => {
      if (metodoId === 'B') return contexto(metodoId, null);
      return { ...contexto(metodoId), resolveAccessToken: vi.fn().mockRejectedValue(erro) };
    });
    api.searchPayments.mockResolvedValue(pagina(1, 1));
    await expect(executar()).rejects.toBe(erro);
    expect(processar).not.toHaveBeenCalled();
  });

  it('near-miss: a failure that is NOT a dead grant still stops the whole sync', async () => {
    const erro = new MercadoPagoHttpError('MP 500', 500, {});
    api.searchPayments.mockRejectedValueOnce(erro).mockResolvedValueOnce(pagina(9, 9));
    await expect(executar()).rejects.toBe(erro);
    expect(api.searchPayments).toHaveBeenCalledTimes(1);
    expect(processar).not.toHaveBeenCalled();
  });
});

describe('sincronizarPedido — Mercado Pago rate limiting', () => {
  beforeEach(pedidoComUmaConta);

  it('answers 429 when Mercado Pago refuses a repeated search (cause 2001)', async () => {
    api.searchPayments.mockRejectedValue(
      new MercadoPagoHttpError('MP 400', 400, { cause: [{ code: 2001 }] }),
    );
    const r = await executar();
    expect(r.status).toBe(429);
    expect(erroLinkPagamentoSchema.parse(r.corpo)).toEqual({
      code: CODIGO_ERRO_LINK.requisicaoRepetida,
      error: 'Aguarde um minuto antes de sincronizar novamente.',
    });
  });

  it('answers 429 for a string cause code too', async () => {
    api.searchPayments.mockRejectedValue(
      new MercadoPagoHttpError('MP 400', 400, { cause: [{ code: '2001' }] }),
    );
    expect((await executar()).status).toBe(429);
  });

  it.each([
    ['another cause code', { cause: [{ code: 1000 }] }],
    ['no cause at all', { message: 'bad request' }],
  ])('rethrows a 400 with %s: it is not a double click', async (_nome, corpo) => {
    const erro = new MercadoPagoHttpError('MP 400', 400, corpo);
    api.searchPayments.mockRejectedValue(erro);
    await expect(executar()).rejects.toBe(erro);
  });

  it('rethrows a non-Mercado-Pago failure untouched', async () => {
    const erro = new TypeError('boom');
    api.searchPayments.mockRejectedValue(erro);
    await expect(executar()).rejects.toBe(erro);
  });
});
