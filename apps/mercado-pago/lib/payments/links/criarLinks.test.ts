import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MercadoPagoHttpError,
  MercadoPagoNetworkError,
  type MercadoPagoApi,
} from '@delfrance/integrations-mercado-pago';
import {
  CODIGO_ERRO_LINK,
  ESTADO_PEDIDO,
  MODO_LINK_PAGAMENTO,
  MOTIVO_RECUSA_LINK,
  MOTIVO_RECUSA_LINK_LABELS,
  STATUS_LINK_PAGAMENTO,
  TIPO_CLIENTE,
  TIPO_PAGAMENTO_MP,
  criarLinksPagamentoBodySchema,
  criarLinksPagamentoRespostaSchema,
  erroLinkPagamentoSchema,
  motivoRecusaLinkSchema,
  type CriarLinksPagamentoBody,
} from '@delfrance/schemas';

import {
  AGORA_MS,
  CAMINHO_CLIENTES,
  CAMINHO_LINKS,
  CAMINHO_PEDIDOS,
  FakeDbLeitura,
  METODO_ID,
  PEDIDO_ID,
  UID,
  comoFirestore,
  docLink,
  docLinkLegado,
  docPedido,
  linkId,
} from './testing/suporte';

// The account loader, the account cache, the store and the eligibility rule are
// replaced: this suite is about the ORCHESTRATION — the order of the steps, what
// each one is handed, and what is cleaned up when a later step says no. The
// Firestore reads run through the real collection handles over a read-only fake.
const h = vi.hoisted(() => ({
  loadCtx: vi.fn(),
  resolveAccessToken: vi.fn(),
  invalidate: vi.fn(),
  persistirLinks: vi.fn(),
  avaliar: vi.fn(),
}));

vi.mock('../mercadoPago', async (importActual) => {
  const actual = await importActual<typeof import('../mercadoPago')>();
  return { ...actual, loadMercadoPagoContext: h.loadCtx };
});

vi.mock('../metodoCache', async (importActual) => {
  const actual = await importActual<typeof import('../metodoCache')>();
  return { ...actual, invalidateMercadoPagoMetodo: h.invalidate };
});

vi.mock('./linkStore', () => ({ persistirLinks: h.persistirLinks }));
vi.mock('./elegibilidade', () => ({ avaliarElegibilidade: h.avaliar }));

const { criarLinks, expirePatch } = await import('./criarLinks');

const FLAG = 'MERCADO_PAGO_LINK_COMPARTILHADO_ENABLED';

/** A parsed body (defaults applied) — built through the REAL wire schema. */
function corpo(over: Partial<CriarLinksPagamentoBody> = {}) {
  return criarLinksPagamentoBodySchema.parse({
    pedidoId: PEDIDO_ID,
    metodoId: METODO_ID,
    modo: MODO_LINK_PAGAMENTO.individual,
    valorCobradoEsperado: 100,
    expiraEm: '2026-10-02',
    links: [
      { linkId: linkId(1), nomePagador: 'Maria', valor: 50 },
      { linkId: linkId(2), nomePagador: 'João', valor: 50 },
    ],
    ...over,
  });
}

/** A Mercado Pago client that mints `pref-1`, `pref-2`, … and accepts every expiry. */
function fakeApi() {
  let n = 0;
  return {
    getMe: vi.fn<MercadoPagoApi['getMe']>(),
    getPayment: vi.fn<MercadoPagoApi['getPayment']>(),
    searchPayments: vi.fn<MercadoPagoApi['searchPayments']>(),
    createPreference: vi.fn<MercadoPagoApi['createPreference']>(async () => {
      n += 1;
      return { id: `pref-${n}`, init_point: `https://mp.test/checkout/pref-${n}` };
    }),
    updatePreference: vi.fn<MercadoPagoApi['updatePreference']>(async (id) => ({
      id,
      init_point: `https://mp.test/checkout/${id}`,
    })),
  };
}

let db: FakeDbLeitura;
let api: ReturnType<typeof fakeApi>;

async function executar(c = corpo(), agoraMs = AGORA_MS) {
  const entrada = { uid: UID, corpo: c, agoraMs };
  return criarLinks(comoFirestore(db), entrada, { api: () => api });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  delete process.env[FLAG];
  db = new FakeDbLeitura();
  db.semear(CAMINHO_PEDIDOS, PEDIDO_ID, docPedido());
  api = fakeApi();
  h.resolveAccessToken.mockResolvedValue('AT');
  h.loadCtx.mockResolvedValue({
    metodoId: METODO_ID,
    conta: { hasLinkPagamento: true, user_id: 4242 },
    resolveAccessToken: h.resolveAccessToken,
  });
  h.avaliar.mockReturnValue(null);
  h.persistirLinks.mockResolvedValue({
    kind: 'criado',
    transicao: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('criarLinks — the account gates', () => {
  it('refuses an account without links, after evicting the cache and re-reading', async () => {
    h.loadCtx.mockResolvedValue({
      metodoId: METODO_ID,
      conta: { hasLinkPagamento: false, user_id: 4242 },
      resolveAccessToken: h.resolveAccessToken,
    });
    const r = await executar();
    expect(r.status).toBe(409);
    expect(r.corpo).toMatchObject({
      code: CODIGO_ERRO_LINK.naoElegivel,
      reason: MOTIVO_RECUSA_LINK.metodoSemLink,
    });
    expect(h.invalidate).toHaveBeenCalledWith(METODO_ID);
    expect(h.loadCtx).toHaveBeenCalledTimes(2);
    expect(api.createPreference).not.toHaveBeenCalled();
    expect(h.resolveAccessToken).not.toHaveBeenCalled();
  });

  it('proceeds when the re-read shows the operator just enabled links (stale cache)', async () => {
    h.loadCtx
      .mockResolvedValueOnce({
        metodoId: METODO_ID,
        conta: { hasLinkPagamento: false, user_id: 4242 },
        resolveAccessToken: h.resolveAccessToken,
      })
      .mockResolvedValueOnce({
        metodoId: METODO_ID,
        conta: { hasLinkPagamento: true, user_id: 4242 },
        resolveAccessToken: h.resolveAccessToken,
      });
    const r = await executar();
    expect(r.status).toBe(201);
    expect(h.invalidate).toHaveBeenCalledTimes(1);
    expect(h.loadCtx).toHaveBeenCalledTimes(2);
  });

  it('does not evict or re-read an account that already issues links', async () => {
    await executar();
    expect(h.invalidate).not.toHaveBeenCalled();
    expect(h.loadCtx).toHaveBeenCalledTimes(1);
  });

  it('keeps the shared link off unless the flag is exactly "1"', async () => {
    const compartilhado = corpo({
      modo: MODO_LINK_PAGAMENTO.compartilhado,
      quantidadeMaxima: 3,
      links: [{ linkId: linkId(1), nomePagador: null, valor: 33.34 }],
    });
    const recusado = await executar(compartilhado);
    expect(recusado.status).toBe(409);
    expect(recusado.corpo).toMatchObject({ reason: MOTIVO_RECUSA_LINK.compartilhadoDesabilitado });
    expect(api.createPreference).not.toHaveBeenCalled();

    // A near-miss value is still off — the flag is a switch, not a truthiness test.
    vi.stubEnv(FLAG, 'true');
    expect((await executar(compartilhado)).status).toBe(409);
    expect(api.createPreference).not.toHaveBeenCalled();

    vi.stubEnv(FLAG, '1');
    expect((await executar(compartilhado)).status).toBe(201);
    expect(api.createPreference).toHaveBeenCalledTimes(1);
  });

  it('never gates the per-person mode on the shared-link flag', async () => {
    delete process.env[FLAG];
    expect((await executar()).status).toBe(201);
  });

  it.each([
    ['null', null],
    ['zero', 0],
    ['a fraction', 42.5],
    ['a numeric string', '4242'],
    ['negative', -7],
  ])('refuses a user_id that is %s (payments could not be attributed)', async (_nome, userId) => {
    h.loadCtx.mockResolvedValue({
      metodoId: METODO_ID,
      conta: { hasLinkPagamento: true, user_id: userId },
      resolveAccessToken: h.resolveAccessToken,
    });
    const r = await executar();
    expect(r.status).toBe(409);
    expect(r.corpo).toMatchObject({ reason: MOTIVO_RECUSA_LINK.contaSemUsuario });
    expect(api.createPreference).not.toHaveBeenCalled();
  });
});

describe('criarLinks — the deadline', () => {
  // "Today" is 2026-09-29 in São Paulo; the horizon is 29 days (the END of day
  // today + 29 stays under Pix's 30-day bound).
  it.each(['2026-09-28', '2026-10-29'])('rejects %s, outside the 29-day window', async (dia) => {
    const r = await executar(corpo({ expiraEm: dia }));
    expect(r.status).toBe(400);
    expect(r.corpo).toMatchObject({ code: CODIGO_ERRO_LINK.corpoInvalido });
    expect(api.createPreference).not.toHaveBeenCalled();
    expect(h.persistirLinks).not.toHaveBeenCalled();
  });

  it.each(['2026-09-29', '2026-10-28'])('accepts %s, the edge of the window', async (dia) => {
    expect((await executar(corpo({ expiraEm: dia }))).status).toBe(201);
  });

  describe('a deadline that is too close to now', () => {
    // The end of 2026-09-29 in São Paulo: 23:59:59-03:00 = 02:59:59Z on the 30th.
    const FIM_DE_HOJE = Date.UTC(2026, 8, 30, 2, 59, 59);
    const HORA = 60 * 60_000;
    const hoje = corpo({ expiraEm: '2026-09-29' });

    it('refuses today when its end is less than 60 minutes away, minting nothing', async () => {
      const r = await executar(hoje, FIM_DE_HOJE - HORA + 1);
      expect(r.status).toBe(400);
      expect(r.corpo).toMatchObject({
        code: CODIGO_ERRO_LINK.corpoInvalido,
        error: 'Escolha uma data de expiração a partir de amanhã.',
      });
      expect(api.createPreference).not.toHaveBeenCalled();
      expect(h.persistirLinks).not.toHaveBeenCalled();
    });

    it.each([
      ['exactly 60 minutes', 0],
      ['just over 60 minutes', 1],
    ])('accepts today with %s left', async (_nome, folga) => {
      expect((await executar(hoje, FIM_DE_HOJE - HORA - folga)).status).toBe(201);
    });

    it('accepts tomorrow at that same late hour', async () => {
      const amanha = corpo({ expiraEm: '2026-09-30' });
      expect((await executar(amanha, FIM_DE_HOJE - HORA + 1)).status).toBe(201);
    });
  });

  it('turns the civil day into 23:59:59 São Paulo, in the preference and in the doc', async () => {
    await executar(corpo({ expiraEm: '2026-10-02' }));
    // 23:59:59-03:00 on the 2nd is 02:59:59Z on the 3rd.
    const fim = Date.UTC(2026, 9, 3, 2, 59, 59);
    for (const [pedido] of api.createPreference.mock.calls) {
      expect(pedido.expiration_date_to).toBe('2026-10-02T23:59:59.000-03:00');
      expect(pedido.date_of_expiration).toBe('2026-10-02T23:59:59.000-03:00');
    }
    const { novos } = h.persistirLinks.mock.calls[0]![1];
    for (const novo of novos) expect(novo.doc.dataExpiracao).toBe(fim);
  });
});

describe('criarLinks — the advisory pre-check', () => {
  it('404s when the pedido does not exist, before any Mercado Pago call', async () => {
    db = new FakeDbLeitura();
    const r = await executar();
    expect(r.status).toBe(404);
    expect(r.corpo).toMatchObject({ code: CODIGO_ERRO_LINK.pedidoNaoEncontrado });
    expect(api.createPreference).not.toHaveBeenCalled();
    expect(h.persistirLinks).not.toHaveBeenCalled();
  });

  it('answers a replay with the stored links and ZERO Mercado Pago calls', async () => {
    // Stored in the opposite order to the request: the answer follows the request.
    db.semear(CAMINHO_LINKS, linkId(2), docLink({ id: 'pref-b', ordem: 1, nomePagador: 'João' }));
    db.semear(CAMINHO_LINKS, linkId(1), docLink({ id: 'pref-a', ordem: 0 }));
    const r = await executar();
    expect(r.status).toBe(200);
    expect(criarLinksPagamentoRespostaSchema.parse(r.corpo)).toEqual({
      reaproveitado: true,
      estado: null,
      links: [
        expect.objectContaining({ linkId: linkId(1), preferenceId: 'pref-a' }),
        expect.objectContaining({ linkId: linkId(2), preferenceId: 'pref-b' }),
      ],
    });
    expect(api.createPreference).not.toHaveBeenCalled();
    expect(api.updatePreference).not.toHaveBeenCalled();
    expect(h.persistirLinks).not.toHaveBeenCalled();
    expect(h.resolveAccessToken).not.toHaveBeenCalled();
  });

  it('refuses a PARTIAL overlap instead of replaying part of the batch', async () => {
    db.semear(CAMINHO_LINKS, linkId(1), docLink());
    const r = await executar();
    expect(r.status).toBe(409);
    expect(r.corpo).toMatchObject({ reason: MOTIVO_RECUSA_LINK.conflitoLinkId });
    expect(api.createPreference).not.toHaveBeenCalled();
  });

  it.each([
    ['another operator created them', { criadoPorOuterRef: 'documents/usuarios/outro' }],
    ['the amount differs by one centavo', { valorCobrado: 50.01 }],
  ])('is a collision, not a replay, when %s', async (_nome, diferenca) => {
    db.semear(CAMINHO_LINKS, linkId(1), docLink(diferenca));
    db.semear(CAMINHO_LINKS, linkId(2), docLink({ ...diferenca, nomePagador: 'João' }));
    const r = await executar();
    expect(r.status).toBe(409);
    expect(r.corpo).toMatchObject({ reason: MOTIVO_RECUSA_LINK.conflitoLinkId });
    expect(api.createPreference).not.toHaveBeenCalled();
  });

  it('is a collision when the colliding docs are legacy links (not created links)', async () => {
    const legado = docLinkLegado({ criadoPorOuterRef: `documents/usuarios/${UID}` });
    db.semear(CAMINHO_LINKS, linkId(1), legado);
    db.semear(CAMINHO_LINKS, linkId(2), legado);
    const r = await executar();
    expect(r.status).toBe(409);
    expect(r.corpo).toMatchObject({ reason: MOTIVO_RECUSA_LINK.conflitoLinkId });
  });

  it('hands the eligibility rule its inputs, leaving the transaction-only facts open', async () => {
    db.semear(CAMINHO_LINKS, linkId(9), docLink({ modo: MODO_LINK_PAGAMENTO.individual }));
    await executar();
    expect(h.avaliar).toHaveBeenCalledTimes(1);
    const entrada = h.avaliar.mock.calls[0]![0];
    expect(entrada.pedido).toEqual({
      ehSaida: true,
      estado: ESTADO_PEDIDO.iniciado,
      valorCobrado: 100,
      itensDevolvidos: null,
    });
    expect(entrada.links.map((l: { id: string }) => l.id)).toEqual([linkId(9)]);
    expect(entrada.pagamentos).toEqual([]);
    // Both are read only inside the transaction; guessing them here would refuse wrongly.
    expect(entrada.canalMarketplace).toBe(false);
    expect(entrada.pagamentosTravadosPorNFe).toBe(false);
    expect(entrada.novos).toEqual([
      { valor: 50, quantidade: 1 },
      { valor: 50, quantidade: 1 },
    ]);
    expect(entrada.valorCobradoEsperado).toBe(100);
    expect(entrada.agoraMs).toBe(AGORA_MS);
  });

  it.each([
    ['missing', undefined],
    ['unknown', 'inexistente'],
    ['not a string', 7],
  ])('refuses a pedido whose estado is %s', async (_nome, estado) => {
    db.semear(CAMINHO_PEDIDOS, PEDIDO_ID, docPedido({ estado }));
    const r = await executar();
    expect(r.status).toBe(409);
    expect(r.corpo).toMatchObject({ reason: MOTIVO_RECUSA_LINK.estado });
    expect(h.avaliar).not.toHaveBeenCalled();
    expect(api.createPreference).not.toHaveBeenCalled();
  });

  it('reads an odd pedido document the way the transaction does (raw, fail-safe)', async () => {
    db.semear(CAMINHO_PEDIDOS, PEDIDO_ID, docPedido({ ehSaida: 'sim', valorCobrado: '100' }));
    await executar();
    const { pedido } = h.avaliar.mock.calls[0]![0];
    expect(pedido).toMatchObject({ ehSaida: null, valorCobrado: null });
  });

  it('sizes a shared link by its payments: valor x quantidadeMaxima', async () => {
    vi.stubEnv(FLAG, '1');
    await executar(
      corpo({
        modo: MODO_LINK_PAGAMENTO.compartilhado,
        quantidadeMaxima: 3,
        links: [{ linkId: linkId(1), nomePagador: null, valor: 33.34 }],
      }),
    );
    expect(h.avaliar.mock.calls[0]![0].novos).toEqual([{ valor: 33.34, quantidade: 3 }]);
  });

  it.each(motivoRecusaLinkSchema.options)(
    'turns the eligibility refusal "%s" into a 409 with its label, minting nothing',
    async (motivo) => {
      h.avaliar.mockReturnValue(motivo);
      const r = await executar();
      expect(r.status).toBe(409);
      expect(erroLinkPagamentoSchema.parse(r.corpo)).toEqual({
        code: CODIGO_ERRO_LINK.naoElegivel,
        error: MOTIVO_RECUSA_LINK_LABELS[motivo],
        reason: motivo,
      });
      expect(api.createPreference).not.toHaveBeenCalled();
      expect(h.persistirLinks).not.toHaveBeenCalled();
      expect(h.resolveAccessToken).not.toHaveBeenCalled();
    },
  );
});

describe('criarLinks — the preferences', () => {
  it('creates ONE preference per link, in order, each carrying its own link id', async () => {
    const r = await executar();
    expect(r.status).toBe(201);
    expect(api.createPreference).toHaveBeenCalledTimes(2);
    const pedidos = api.createPreference.mock.calls.map(([p]) => p);
    expect(pedidos.map((p) => p.metadata.link_id)).toEqual([linkId(1), linkId(2)]);
    expect(pedidos.map((p) => p.items[0].id)).toEqual([linkId(1), linkId(2)]);
    expect(pedidos.map((p) => p.items[0].unit_price)).toEqual([50, 50]);
    // The pedido id verbatim — the webhook reads the pedido off it.
    expect(pedidos.map((p) => p.external_reference)).toEqual([PEDIDO_ID, PEDIDO_ID]);
    const titulos = pedidos.map((p) => p.items[0].title);
    expect(titulos).toEqual(['Pedido #123 — Maria', 'Pedido #123 — João']);
    expect(pedidos[0]).not.toHaveProperty('notification_url');
    expect(pedidos[0]).not.toHaveProperty('back_urls');
  });

  it('titles the item without a number when the pedido has none', async () => {
    db.semear(CAMINHO_PEDIDOS, PEDIDO_ID, docPedido({ numero: null }));
    await executar();
    const titulos = api.createPreference.mock.calls.map(([p]) => p.items[0].title);
    expect(titulos).toEqual(['Pedido — Maria', 'Pedido — João']);
  });

  it('builds the client from the resolved access token', async () => {
    const fabrica = vi.fn(() => api);
    const entrada = { uid: UID, corpo: corpo(), agoraMs: AGORA_MS };
    await criarLinks(comoFirestore(db), entrada, { api: fabrica });
    expect(fabrica).toHaveBeenCalledWith('AT');
  });

  it('does not start the next preference before the previous one answered', async () => {
    let liberar: () => void = () => {};
    const primeira = new Promise<void>((resolve) => {
      liberar = resolve;
    });
    api.createPreference.mockImplementationOnce(async () => {
      await primeira;
      return { id: 'pref-1', init_point: 'https://mp.test/checkout/pref-1' };
    });
    const execucao = executar();
    await vi.waitFor(() => expect(api.createPreference).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.createPreference).toHaveBeenCalledTimes(1);
    liberar();
    await execucao;
    expect(api.createPreference).toHaveBeenCalledTimes(2);
  });

  it('sends payment_methods only when something is excluded or capped', async () => {
    await executar();
    expect(api.createPreference.mock.calls[0]![0]).not.toHaveProperty('payment_methods');

    api.createPreference.mockClear();
    await executar(corpo({ tiposExcluidos: [TIPO_PAGAMENTO_MP.boleto], parcelasMaximas: 6 }));
    expect(api.createPreference.mock.calls[0]![0].payment_methods).toEqual({
      excluded_payment_types: [{ id: TIPO_PAGAMENTO_MP.boleto }],
      installments: 6,
    });
  });
});

describe('criarLinks — prefilling the payer', () => {
  const CLIENTE_REF = 'documents/clientes/cli1';

  beforeEach(() => {
    db.semear(CAMINHO_PEDIDOS, PEDIDO_ID, docPedido({ clientePedidoOuterRef: CLIENTE_REF }));
    db.semear(CAMINHO_CLIENTES, 'cli1', {
      tipo: TIPO_CLIENTE.pessoaFisica,
      nome: 'Maria da Silva',
      email: 'maria@exemplo.com',
      cpf_cnpj: '52998224725',
      telefone: '11999998888',
    });
  });

  const umLink = { links: [{ linkId: linkId(1), nomePagador: 'Maria', valor: 100 }] };

  it('sends a payer only when asked, and reads the cliente only then', async () => {
    await executar(corpo({ ...umLink, preencherPagador: false }));
    expect(api.createPreference.mock.calls[0]![0]).not.toHaveProperty('payer');
    expect(db.leituras.some((caminho) => caminho.startsWith(CAMINHO_CLIENTES))).toBe(false);

    api.createPreference.mockClear();
    await executar(corpo({ ...umLink, preencherPagador: true }));
    expect(api.createPreference.mock.calls[0]![0].payer).toMatchObject({ name: 'Maria' });
    expect(db.leituras).toContain(`${CAMINHO_CLIENTES}/cli1`);
  });

  it('flags a foreign cliente, so no Brazilian phone or CPF is sent', async () => {
    db.semear(CAMINHO_CLIENTES, 'cli1', {
      tipo: TIPO_CLIENTE.estrangeiro,
      nome: 'Jane Doe',
      email: 'jane@example.com',
      cpf_cnpj: '52998224725',
      telefone: '14155550123',
    });
    await executar(corpo({ ...umLink, preencherPagador: true }));
    const payer = api.createPreference.mock.calls[0]![0].payer;
    expect(payer).toMatchObject({ name: 'Jane' });
    expect(payer).not.toHaveProperty('phone');
    expect(payer).not.toHaveProperty('identification');
  });

  it.each([
    ['the pedido has no cliente', docPedido({ clientePedidoOuterRef: null })],
    ['the cliente doc is gone', docPedido({ clientePedidoOuterRef: 'documents/clientes/sumiu' })],
  ])('creates the link without a payer when %s', async (_nome, pedido) => {
    db.semear(CAMINHO_PEDIDOS, PEDIDO_ID, pedido);
    const r = await executar(corpo({ ...umLink, preencherPagador: true }));
    expect(r.status).toBe(201);
    expect(api.createPreference.mock.calls[0]![0]).not.toHaveProperty('payer');
  });
});

describe('criarLinks — persisting', () => {
  it('hands the transaction the preference ids and the whole link doc', async () => {
    await executar(corpo({ tiposExcluidos: [TIPO_PAGAMENTO_MP.pix], parcelasMaximas: 3 }));
    expect(h.persistirLinks).toHaveBeenCalledTimes(1);
    const [, entrada] = h.persistirLinks.mock.calls[0]!;
    expect(entrada).toMatchObject({
      pedidoId: PEDIDO_ID,
      criadoPorOuterRef: `documents/usuarios/${UID}`,
      valorCobradoEsperado: 100,
      agoraMs: AGORA_MS,
    });
    expect(entrada.novos).toEqual([
      {
        linkId: linkId(1),
        quantidade: 1,
        doc: {
          contaMercadoPagoOuterRef: `documents/metodo_pgto/${METODO_ID}`,
          valorCobrado: 50,
          link: 'https://mp.test/checkout/pref-1',
          id: 'pref-1',
          dataCriacao: AGORA_MS,
          dataExpiracao: Date.UTC(2026, 9, 3, 2, 59, 59),
          modo: MODO_LINK_PAGAMENTO.individual,
          nomePagador: 'Maria',
          quantidadeMaxima: 1,
          grupoId: linkId(1),
          ordem: 0,
          status: STATUS_LINK_PAGAMENTO.aberto,
          criadoPorOuterRef: `documents/usuarios/${UID}`,
          tiposExcluidos: [TIPO_PAGAMENTO_MP.pix],
          parcelasMaximas: 3,
        },
      },
      expect.objectContaining({
        linkId: linkId(2),
        doc: expect.objectContaining({
          id: 'pref-2',
          link: 'https://mp.test/checkout/pref-2',
          nomePagador: 'João',
          grupoId: linkId(1),
          ordem: 1,
        }),
      }),
    ]);
  });

  it('stores no excluded types as null, not as an empty list', async () => {
    await executar();
    const { novos } = h.persistirLinks.mock.calls[0]![1];
    expect(novos[0].doc.tiposExcluidos).toBeNull();
    expect(novos[0].doc.parcelasMaximas).toBeNull();
  });

  it('stores a shared link with its quota, and passes the quota to the transaction', async () => {
    vi.stubEnv(FLAG, '1');
    const r = await executar(
      corpo({
        modo: MODO_LINK_PAGAMENTO.compartilhado,
        quantidadeMaxima: 3,
        links: [{ linkId: linkId(1), nomePagador: null, valor: 33.34 }],
      }),
    );
    const { novos } = h.persistirLinks.mock.calls[0]![1];
    expect(novos).toHaveLength(1);
    expect(novos[0]).toMatchObject({
      quantidade: 3,
      doc: { modo: MODO_LINK_PAGAMENTO.compartilhado, quantidadeMaxima: 3, nomePagador: null },
    });
    expect(criarLinksPagamentoRespostaSchema.parse(r.corpo).links[0]).toMatchObject({
      modo: MODO_LINK_PAGAMENTO.compartilhado,
      quantidadeMaxima: 3,
    });
  });

  it('answers 201 with the created links and the estado the pedido moved to', async () => {
    const r = await executar();
    expect(r.status).toBe(201);
    expect(criarLinksPagamentoRespostaSchema.parse(r.corpo)).toEqual({
      reaproveitado: false,
      estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
      links: [
        {
          linkId: linkId(1),
          preferenceId: 'pref-1',
          link: 'https://mp.test/checkout/pref-1',
          valorCobrado: 50,
          nomePagador: 'Maria',
          dataExpiracao: Date.UTC(2026, 9, 3, 2, 59, 59),
          modo: MODO_LINK_PAGAMENTO.individual,
          quantidadeMaxima: 1,
        },
        expect.objectContaining({ linkId: linkId(2), preferenceId: 'pref-2', nomePagador: 'João' }),
      ],
    });
    // The created links are what the operator was handed — nothing is expired.
    expect(api.updatePreference).not.toHaveBeenCalled();
  });

  it('reports no estado when the creation left the pedido alone', async () => {
    h.persistirLinks.mockResolvedValue({ kind: 'criado', transicao: null });
    const r = await executar();
    expect(r.status).toBe(201);
    expect(criarLinksPagamentoRespostaSchema.parse(r.corpo).estado).toBeNull();
  });
});

describe('criarLinks — when it must not leave a payable preference behind', () => {
  it('expires the earlier preferences when a later one fails, creating no more', async () => {
    const tres = corpo({
      valorCobradoEsperado: 90,
      links: [
        { linkId: linkId(1), nomePagador: 'Ana', valor: 30 },
        { linkId: linkId(2), nomePagador: 'Bia', valor: 30 },
        { linkId: linkId(3), nomePagador: 'Caio', valor: 30 },
      ],
    });
    const falha = new MercadoPagoHttpError('MP 503: fora do ar', 503, {});
    api.createPreference
      .mockResolvedValueOnce({ id: 'pref-1', init_point: 'https://mp.test/checkout/pref-1' })
      .mockRejectedValueOnce(falha);

    await expect(executar(tres)).rejects.toBe(falha);

    expect(api.createPreference).toHaveBeenCalledTimes(2);
    expect(api.updatePreference).toHaveBeenCalledTimes(1);
    const [id, patch] = api.updatePreference.mock.calls[0]!;
    expect(id).toBe('pref-1');
    expect(patch).toEqual({
      expires: true,
      expiration_date_to: '2026-09-29T12:00:00.000-03:00',
      date_of_expiration: '2026-09-29T12:00:00.000-03:00',
    });
    expect(h.persistirLinks).not.toHaveBeenCalled();
  });

  it('has nothing to expire when the FIRST preference fails', async () => {
    api.createPreference.mockRejectedValueOnce(new MercadoPagoNetworkError('sem rede'));
    await expect(executar()).rejects.toBeInstanceOf(MercadoPagoNetworkError);
    expect(api.updatePreference).not.toHaveBeenCalled();
  });

  it('still surfaces the ORIGINAL failure when the cleanup itself fails', async () => {
    const original = new MercadoPagoHttpError('MP 500: erro', 500, {});
    api.createPreference
      .mockResolvedValueOnce({ id: 'pref-1', init_point: 'https://mp.test/checkout/pref-1' })
      .mockRejectedValueOnce(original);
    api.updatePreference.mockRejectedValueOnce(new MercadoPagoNetworkError('sem rede'));
    await expect(executar()).rejects.toBe(original);
    expect(console.error).toHaveBeenCalled();
  });

  it.each([
    [
      'the transaction refuses (the guard changed in the window)',
      { kind: 'recusado', motivo: MOTIVO_RECUSA_LINK.excedeRestante },
      409,
      { reason: MOTIVO_RECUSA_LINK.excedeRestante, code: CODIGO_ERRO_LINK.naoElegivel },
    ],
    [
      'the pedido vanished',
      { kind: 'pedidoInexistente' },
      404,
      { code: CODIGO_ERRO_LINK.pedidoNaoEncontrado },
    ],
  ])('expires EVERY created preference when %s', async (_nome, resultado, status, esperado) => {
    h.persistirLinks.mockResolvedValue(resultado);
    const r = await executar();
    expect(r.status).toBe(status);
    expect(r.corpo).toMatchObject(esperado);
    expect(api.updatePreference.mock.calls.map(([id]) => id)).toEqual(['pref-1', 'pref-2']);
    for (const [, patch] of api.updatePreference.mock.calls) {
      expect(patch.expiration_date_to).toMatch(/-03:00$/);
      expect(patch.date_of_expiration).toMatch(/-03:00$/);
    }
  });

  it('adopts the winner of an identical concurrent request; expires its own', async () => {
    h.persistirLinks.mockResolvedValue({
      kind: 'reaproveitado',
      links: [
        { id: linkId(1), data: docLink({ id: 'pref-a' }) },
        { id: linkId(2), data: docLink({ id: 'pref-b', nomePagador: 'João' }) },
      ],
    });
    const r = await executar();
    expect(r.status).toBe(200);
    const corpoResposta = criarLinksPagamentoRespostaSchema.parse(r.corpo);
    expect(corpoResposta.reaproveitado).toBe(true);
    expect(corpoResposta.links.map((l) => l.preferenceId)).toEqual(['pref-a', 'pref-b']);
    expect(api.updatePreference.mock.calls.map(([id]) => id)).toEqual(['pref-1', 'pref-2']);
  });

  it('will not adopt "winner" links this caller did not create', async () => {
    const outro = 'documents/usuarios/outro';
    h.persistirLinks.mockResolvedValue({
      kind: 'reaproveitado',
      links: [
        { id: linkId(1), data: docLink({ id: 'pref-x', criadoPorOuterRef: outro }) },
        { id: linkId(2), data: docLink({ id: 'pref-y', criadoPorOuterRef: outro }) },
      ],
    });
    const r = await executar();
    expect(r.status).toBe(409);
    expect(r.corpo).toMatchObject({ reason: MOTIVO_RECUSA_LINK.conflitoLinkId });
    expect(api.updatePreference).toHaveBeenCalledTimes(2);
  });

  it('expires everything and rethrows when the transaction throws and wrote nothing', async () => {
    const queda = new Error('firestore indisponível');
    h.persistirLinks.mockRejectedValue(queda);
    await expect(executar()).rejects.toBe(queda);
    // It LOOKED first: both requested docs were re-read, and neither exists.
    expect(db.leituras).toEqual(
      expect.arrayContaining([`${CAMINHO_LINKS}/${linkId(1)}`, `${CAMINHO_LINKS}/${linkId(2)}`]),
    );
    expect(api.updatePreference.mock.calls.map(([id]) => id)).toEqual(['pref-1', 'pref-2']);
  });
});

describe('criarLinks — never expiring a preference a PERSISTED link carries', () => {
  /** The two docs our own commit writes: each carries the preference minted for it. */
  function semearNossosLinks() {
    db.semear(CAMINHO_LINKS, linkId(1), docLink({ id: 'pref-1' }));
    db.semear(CAMINHO_LINKS, linkId(2), docLink({ id: 'pref-2', nomePagador: 'João', ordem: 1 }));
  }

  /** An ambiguous commit, the way the Admin SDK surfaces one. */
  const ambiguo = () => Object.assign(new Error('DEADLINE_EXCEEDED'), { code: 4 });

  it('reports a creation — 201, no expiry — when the "replay" is our own landed commit', async () => {
    // The first attempt committed; the SDK re-ran the callback after an ambiguous
    // commit, and that attempt read OUR docs back as a replay.
    h.persistirLinks.mockResolvedValue({
      kind: 'reaproveitado',
      links: [
        { id: linkId(1), data: docLink({ id: 'pref-1' }) },
        { id: linkId(2), data: docLink({ id: 'pref-2', nomePagador: 'João' }) },
      ],
    });
    const r = await executar();

    expect(r.status).toBe(201);
    expect(criarLinksPagamentoRespostaSchema.parse(r.corpo)).toEqual({
      reaproveitado: false,
      // The flip (if any) happened in the landed commit; it is not guessed here.
      estado: null,
      links: [
        expect.objectContaining({ linkId: linkId(1), preferenceId: 'pref-1' }),
        expect.objectContaining({ linkId: linkId(2), preferenceId: 'pref-2' }),
      ],
    });
    expect(api.updatePreference).not.toHaveBeenCalled();
  });

  it('near-miss: an identical TWIN’s links (other preference ids) are adopted and ours expired', async () => {
    h.persistirLinks.mockResolvedValue({
      kind: 'reaproveitado',
      links: [
        { id: linkId(1), data: docLink({ id: 'pref-a' }) },
        { id: linkId(2), data: docLink({ id: 'pref-b', nomePagador: 'João' }) },
      ],
    });
    const r = await executar();

    expect(r.status).toBe(200);
    expect(criarLinksPagamentoRespostaSchema.parse(r.corpo).reaproveitado).toBe(true);
    expect(api.updatePreference.mock.calls.map(([id]) => id)).toEqual(['pref-1', 'pref-2']);
  });

  it('answers 201 and expires NOTHING when the transaction threw but its commit landed', async () => {
    const queda = ambiguo();
    h.persistirLinks.mockImplementation(async () => {
      semearNossosLinks();
      throw queda;
    });
    const r = await executar();

    expect(r.status).toBe(201);
    expect(criarLinksPagamentoRespostaSchema.parse(r.corpo)).toEqual({
      reaproveitado: false,
      estado: null,
      links: [
        expect.objectContaining({ linkId: linkId(1), preferenceId: 'pref-1' }),
        expect.objectContaining({ linkId: linkId(2), preferenceId: 'pref-2' }),
      ],
    });
    expect(api.updatePreference).not.toHaveBeenCalled();
  });

  it('near-miss: docs that carry OTHER preferences are not our commit — ours expire, error rethrown', async () => {
    const queda = ambiguo();
    h.persistirLinks.mockImplementation(async () => {
      db.semear(CAMINHO_LINKS, linkId(1), docLink({ id: 'pref-a' }));
      db.semear(CAMINHO_LINKS, linkId(2), docLink({ id: 'pref-b', nomePagador: 'João' }));
      throw queda;
    });
    await expect(executar()).rejects.toBe(queda);
    expect(api.updatePreference.mock.calls.map(([id]) => id)).toEqual(['pref-1', 'pref-2']);
  });

  it('expires only the preferences no persisted doc carries', async () => {
    // Only link 1 is stored (with our preference): link 2's preference is the orphan.
    const queda = ambiguo();
    h.persistirLinks.mockImplementation(async () => {
      db.semear(CAMINHO_LINKS, linkId(1), docLink({ id: 'pref-1' }));
      throw queda;
    });
    await expect(executar()).rejects.toBe(queda);
    expect(api.updatePreference.mock.calls.map(([id]) => id)).toEqual(['pref-2']);
  });

  it('expires NOTHING and rethrows the ORIGINAL error when the re-read fails too', async () => {
    const queda = ambiguo();
    const releitura = new Error('UNAVAILABLE');
    h.persistirLinks.mockImplementation(async () => {
      const original = db.collection.bind(db);
      vi.spyOn(db, 'collection').mockImplementation((caminho: string) => {
        if (caminho !== CAMINHO_LINKS) return original(caminho);
        return {
          ...original(caminho),
          doc: (id: string) => ({
            id,
            get: async () => {
              throw releitura;
            },
          }),
        };
      });
      throw queda;
    });

    await expect(executar()).rejects.toBe(queda);
    expect(api.updatePreference).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('expiring nothing'),
      expect.objectContaining({ pedidoId: PEDIDO_ID, motivo: 'UNAVAILABLE' }),
    );
  });
});

describe('expirePatch', () => {
  it('moves BOTH deadlines to now, with an explicit offset and never Z', () => {
    const patch = expirePatch(AGORA_MS);
    expect(patch).toEqual({
      expires: true,
      expiration_date_to: '2026-09-29T12:00:00.000-03:00',
      date_of_expiration: '2026-09-29T12:00:00.000-03:00',
    });
  });
});
