/**
 * `runShopeeEscrowSettlement` — the WEEKLY settlement sweep (#1514, step 6, plan
 * §3.0-S S6/S7/S9), over the shared `FakeDb` and a stubbed client seam.
 *
 * ⚠️ The properties this file exists for are the ones no happy path shows:
 *
 *  - **a window that did not finish advances NOTHING.** Truncation by the page
 *    cap, by the per-tick settlement budget, or by a provider that ignores
 *    `page_no` all leave the cursor exactly where it was — a tick that advanced
 *    past a window it could not read is the one failure that loses money in
 *    silence;
 *  - **one conta's failure costs one conta.** Except `ShopeeConfigError`, which
 *    is OURS and must take the whole tick down (#778);
 *  - **an unreadable ROW is not an unreadable WINDOW.** `order_not_found` and a
 *    malformed escrow skip one order; anything else rethrows to the conta
 *    boundary, because a 30-second outage must not skip 300 orders and then
 *    declare the week drained;
 *  - **the parked list is READ, not just written.** It is the only place a
 *    released row survives once the cursor moves past its release time.
 *
 * ⚠️ Fixture ids only — no real partner id, key, shop id or buyer datum.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { INTEGRACAO_TIPO, LIQUIDACAO_FONTE, MOTIVO_PENDENTE_SHOPEE } from '@delfrance/schemas';
import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  type GetEscrowDetailParams,
  type GetEscrowListParams,
  type ShopeeClient,
  type ShopeeEscrowDetail,
  type ShopeeEscrowList,
} from '@delfrance/integrations-shopee';

import { type DocData, FakeDb, asDb, grpc } from '../testing/fakeDb';
import { ShopeeSemCredencialError } from '../core/tokenStore';
import { FIXTURE_ESCROW_DETAIL_QTY2_SG, lerEscrowDetalhe } from '../fixtures/wireCorpus';
import { dedupKeyOf, docIdOf, type ShopeeNotificationPayload } from '../notificacoes/notificacao';
import { notificacaoSinteticaDePedido } from '../notificacoes/notificacaoSintetica';
import type { ShopeeTaskScheduler } from '../shopeeTasks';
import { makePagamentoIdShopee, makePedidoIdShopee } from './orderIds';
import { microsDeSegundosShopee } from './orderMapping';
import {
  INITIAL_LOOKBACK_MS,
  LOG_LIQUIDACAO_DETALHADA_MAX,
  MAX_LIQUIDACOES_POR_TICK,
  MAX_PAGES_PER_TICK,
  MAX_PENDENTES,
  MAX_SINTETICAS_POR_TICK,
  MAX_TENTATIVAS,
  MAX_WINDOW_MS,
  MOTIVO_JANELA_DEGENERADA,
  MOTIVO_PAGINA_REPETIDA,
  MOTIVO_SEM_SHOP_ID,
  OVERLAP_MS,
  PAGE_SIZE,
  esquecerLogsDeLiquidacaoShopee,
  runShopeeEscrowSettlement,
  simularLiquidacaoShopee,
} from './liquidacaoSweep';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented values only.                                           */
/* -------------------------------------------------------------------------- */

const AGORA_MS = 1_760_000_000_000;
const SEGUNDO_MS = 1000;
const DIA_MS = 24 * 60 * 60 * 1000;

const INTEGRACAO_PATH = integracaoCollection.resolvePath({});
const CURSOR_PATH = 'liquidacaoShopee';
const INT_A = 'int-1';
const INT_B = 'int-2';
const SHOP_A = 987654;
const SHOP_B = 987655;
const PATH_ESCROW = '/api/v2/payment/get_escrow_list';

/**
 * A Shopee-shaped `order_sn` — ALPHANUMERIC, like the real ones.
 *
 * ⚠️ Deliberately not a digit run: the PII assertion below refuses a bounded
 * 14-digit sequence (a CNPJ), and a numeric fixture id would have made that
 * negative fail for a reason that has nothing to do with the code under test —
 * the classic way a real guard gets turned off.
 */
function sn(i: number): string {
  return `260910KJB${String(i).padStart(3, '0')}`;
}

function contaDoc(over: DocData = {}): DocData {
  return { tipo: INTEGRACAO_TIPO.shopee, ativo: true, nome: 'Loja BR', shop_id: SHOP_A, ...over };
}

function pedidoIdDe(orderSn: string, conta = INT_A): string {
  return makePedidoIdShopee(conta, orderSn);
}
function pagamentoPath(orderSn: string, conta = INT_A): string {
  return `pedidos/${pedidoIdDe(orderSn, conta)}/pagamentos/${makePagamentoIdShopee(conta, orderSn)}`;
}

const ESCROW_SG: ShopeeEscrowDetail = lerEscrowDetalhe(FIXTURE_ESCROW_DETAIL_QTY2_SG).response;

/** One `get_escrow_list` page. */
function pagina(
  linhas: ({
    order_sn: string;
    payout_amount?: number | null;
    escrow_release_time?: number | null;
  } | null)[],
  more: boolean,
): ShopeeEscrowList {
  return {
    more,
    escrow_list: linhas.map((l) =>
      l === null
        ? null
        : {
            order_sn: l.order_sn,
            payout_amount: l.payout_amount ?? 30.7,
            escrow_release_time: l.escrow_release_time ?? 1_759_000_000,
          },
    ),
  } as ShopeeEscrowList;
}

function apiError(code: string): ShopeeApiError {
  return new ShopeeApiError(`shopee recusou: ${code}`, {
    code,
    kind: SHOPEE_ERROR_KIND.other,
    httpStatus: 200,
    path: PATH_ESCROW,
  });
}

type GetEscrowListMock = Mock<(p: GetEscrowListParams) => Promise<ShopeeEscrowList>>;
type GetEscrowDetailMock = Mock<(p: GetEscrowDetailParams) => Promise<ShopeeEscrowDetail>>;
type EnqueueMock = Mock<(p: ShopeeNotificationPayload) => Promise<void>>;

interface Cenario {
  db: FakeDb;
  getEscrowList: GetEscrowListMock;
  getEscrowDetail: GetEscrowDetailMock;
  /** Per-conta client override — the default answers the two mocks above. */
  clientPor: Map<string, ShopeeClient>;
  enqueue: EnqueueMock;
  info: Mock<(msg: string, meta?: Record<string, unknown>) => void>;
  warn: Mock<(msg: string, meta?: Record<string, unknown>) => void>;
}

function cenario(): Cenario {
  const db = new FakeDb();
  const getEscrowList: GetEscrowListMock = vi.fn(() => Promise.resolve(pagina([], false)));
  const getEscrowDetail: GetEscrowDetailMock = vi.fn(() => Promise.resolve(ESCROW_SG));
  const enqueue: EnqueueMock = vi.fn(() => Promise.resolve());
  return {
    db,
    getEscrowList,
    getEscrowDetail,
    clientPor: new Map<string, ShopeeClient>(),
    enqueue,
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function rodar(
  c: Cenario,
  over: {
    nowMs?: number;
    apenasIntegracoes?: readonly string[];
    janela?: { deMs: number; ateMs: number };
    persistirCursor?: boolean;
  } = {},
) {
  const scheduler: ShopeeTaskScheduler = { enqueue: c.enqueue };
  return runShopeeEscrowSettlement(asDb(c.db), {
    nowMs: over.nowMs ?? AGORA_MS,
    scheduler,
    logger: { info: c.info, warn: c.warn },
    clientFor: (_db, integracaoId) =>
      Promise.resolve(
        c.clientPor.get(integracaoId) ??
          ({
            getEscrowList: c.getEscrowList,
            getEscrowDetail: c.getEscrowDetail,
          } as unknown as ShopeeClient),
      ),
    ...(over.apenasIntegracoes === undefined ? {} : { apenasIntegracoes: over.apenasIntegracoes }),
    ...(over.janela === undefined ? {} : { janela: over.janela }),
    ...(over.persistirCursor === undefined ? {} : { persistirCursor: over.persistirCursor }),
  });
}

/** The params of `getEscrowList` call `n` (0-based), or a loud failure. */
function chamada(c: Cenario, n: number): GetEscrowListParams {
  const p = c.getEscrowList.mock.calls[n]?.[0];
  if (p === undefined) throw new Error(`getEscrowList não foi chamado ${String(n + 1)} vez(es)`);
  return p;
}

/** The last patch merged onto a conta's cursor document. */
function ultimoPatch(db: FakeDb, integracaoId: string): DocData | undefined {
  const path = `${CURSOR_PATH}/${integracaoId}`;
  const meus = db.writes.filter((w) => w.path === path);
  return meus[meus.length - 1]?.patch;
}

/** The meta of the per-conta aggregate line. */
function linhaDoTick(c: Cenario): Record<string, unknown> {
  const call = c.info.mock.calls.find(([msg]) => msg === '[shopee/liquidacao] conta varrida');
  if (call === undefined) throw new Error('a linha agregada do tick não foi emitida');
  return call[1] ?? {};
}

beforeEach(() => {
  esquecerLogsDeLiquidacaoShopee();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/* ========================================================================== */
/*  1–4 · a janela e o avanço                                                 */
/* ========================================================================== */

describe('runShopeeEscrowSettlement — a janela drenada', () => {
  it('1. drenada ⇒ cursor = topo da JANELA, o trio limpo, lastError null, UM merge', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());

    const r = await rodar(c);

    const conta = r.contas[0]!;
    expect(conta.drenada).toBe(true);
    expect(conta.truncada).toBe(false);
    const ateMs = conta.janela!.ateMs;
    // ⛔ MUTANTE: avançar para `nowMs`. A faixa acima de `ateMs` NUNCA foi
    // consultada; reivindicá-la pula o que cair lá.
    expect(ultimoPatch(c.db, INT_A)).toEqual({
      lastSweepAtMs: AGORA_MS,
      lastError: null,
      cursorMs: ateMs,
      pendingWindowFromMs: null,
      pendingWindowToMs: null,
      pendingPageNo: null,
    });
    // ⚠️ Sem cursor gravado a janela COMEÇA no lookback inteiro (30 dias), mas
    // o topo é medido a partir de `deMs` e não de `nowMs`: 30 dias para trás
    // mais o teto de 15 dias ainda fica ABAIXO de agora, então a primeira
    // janela cobre metade do lookback e o resto vem no tick seguinte.
    expect(conta.janela).toEqual({
      deMs: AGORA_MS - INITIAL_LOOKBACK_MS,
      ateMs: AGORA_MS - INITIAL_LOOKBACK_MS + MAX_WINDOW_MS,
    });
    // UM merge por conta por tick.
    expect(c.db.writes.filter((w) => w.path === `${CURSOR_PATH}/${INT_A}`)).toHaveLength(1);
    // Nada a liquidar ⇒ NENHUMA transação.
    expect(c.db.occ.txLog).toEqual([]);
  });

  it('1b. com cursor gravado, a janela começa UM DIA antes dele e o avanço é monotônico', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    const cursorMs = AGORA_MS - 40 * DIA_MS;
    c.db.seed(`${CURSOR_PATH}/${INT_A}`, { cursorMs });

    const r = await rodar(c);

    const janela = r.contas[0]!.janela!;
    expect(janela.deMs).toBe(cursorMs - OVERLAP_MS);
    // ⚠️ O teto é medido a partir de `deMs`, NUNCA do cursor: `cursor + 15 d`
    // mais a sobreposição é uma janela mais larga do que a que se quis pedir.
    expect(janela.ateMs).toBe(janela.deMs + MAX_WINDOW_MS);
    expect(ultimoPatch(c.db, INT_A)!.cursorMs).toBe(janela.ateMs);
    // A conversão ms → s acontece UMA vez, nos dois lados.
    expect(chamada(c, 0).releaseTimeFromS).toBe(Math.floor(janela.deMs / SEGUNDO_MS));
    expect(chamada(c, 0).releaseTimeToS).toBe(Math.floor(janela.ateMs / SEGUNDO_MS));
    expect(chamada(c, 0).pageSize).toBe(PAGE_SIZE);
    expect(chamada(c, 0).pageNo).toBe(1);
  });

  it('2. truncada pelo TETO DE PÁGINAS ⇒ cursor intacto, janela persistida, pendingPageNo 21', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.db.seed(`${CURSOR_PATH}/${INT_A}`, { cursorMs: AGORA_MS - 10 * DIA_MS });
    // 21 páginas VAZIAS com `more: true` — uma página vazia continua paginando.
    c.getEscrowList.mockImplementation(() => Promise.resolve(pagina([], true)));

    const r = await rodar(c);

    const conta = r.contas[0]!;
    expect(conta.paginas).toBe(MAX_PAGES_PER_TICK);
    expect(conta.truncada).toBe(true);
    expect(conta.drenada).toBe(false);
    const patch = ultimoPatch(c.db, INT_A)!;
    // ⛔ MUTANTE: avançar numa janela truncada. Nada aqui avança.
    expect(patch.cursorMs).toBeUndefined();
    expect(patch.pendingWindowFromMs).toBe(conta.janela!.deMs);
    expect(patch.pendingWindowToMs).toBe(conta.janela!.ateMs);
    expect(patch.pendingPageNo).toBe(MAX_PAGES_PER_TICK + 1);
    expect(patch.lastError).toBeNull();
  });

  it('3. truncada pelo ORÇAMENTO de liquidações ⇒ 300 transações e a página da linha 301', async () => {
    // ⚠️ Este, e não o teto de páginas, é o orçamento real: 20 × 100 linhas não
    // cabem em 540 s, e um tick que estourasse o tempo no meio não avançaria
    // nada e se repetiria para sempre.
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    for (let i = 1; i <= 301; i += 1) c.db.seed(pagamentoPath(sn(i)), { id: sn(i) });
    const paginas = [
      pagina(
        Array.from({ length: 100 }, (_, k) => ({ order_sn: sn(k + 1) })),
        true,
      ),
      pagina(
        Array.from({ length: 100 }, (_, k) => ({ order_sn: sn(k + 101) })),
        true,
      ),
      pagina(
        Array.from({ length: 100 }, (_, k) => ({ order_sn: sn(k + 201) })),
        true,
      ),
      pagina([{ order_sn: sn(301) }], false),
    ];
    let i = 0;
    c.getEscrowList.mockImplementation(() => Promise.resolve(paginas[i++]!));

    const r = await rodar(c);

    const conta = r.contas[0]!;
    expect(conta.liquidados).toBe(MAX_LIQUIDACOES_POR_TICK);
    expect(c.getEscrowDetail).toHaveBeenCalledTimes(MAX_LIQUIDACOES_POR_TICK);
    expect(conta.truncada).toBe(true);
    expect(conta.paginas).toBe(4);
    // A linha 301 está na PÁGINA 4 — é dali que o próximo tick retoma.
    expect(ultimoPatch(c.db, INT_A)!.pendingPageNo).toBe(4);
    expect(ultimoPatch(c.db, INT_A)!.cursorMs).toBeUndefined();
  });

  it('4. retomada: a janela E a página GRAVADAS vão para o fio, não a recalculada', async () => {
    // ⚠️ Um número de página só significa alguma coisa contra a janela para a
    // qual foi emitido: aplicá-lo a uma janela RECALCULADA (o relógio andou)
    // retoma noutro conjunto de resultados, que é um pulo em silêncio.
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    const deMs = AGORA_MS - 20 * DIA_MS;
    const ateMs = AGORA_MS - 5 * DIA_MS;
    c.db.seed(`${CURSOR_PATH}/${INT_A}`, {
      cursorMs: AGORA_MS - 30 * DIA_MS,
      pendingWindowFromMs: deMs,
      pendingWindowToMs: ateMs,
      pendingPageNo: 7,
    });

    const r = await rodar(c);

    expect(chamada(c, 0).releaseTimeFromS).toBe(Math.floor(deMs / SEGUNDO_MS));
    expect(chamada(c, 0).releaseTimeToS).toBe(Math.floor(ateMs / SEGUNDO_MS));
    expect(chamada(c, 0).pageNo).toBe(7);
    expect(r.contas[0]!.retomada).toBe(true);
  });
});

/* ========================================================================== */
/*  5–9 · pendentes e sintéticas                                              */
/* ========================================================================== */

describe('runShopeeEscrowSettlement — a linha sem pagamento', () => {
  const ORDER = '260910KJBHUJDM';

  it('5. sem pedido ⇒ pendente `sem-pedido`, UM code 3 sintético com a identidade certa', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.getEscrowList.mockResolvedValueOnce(
      pagina([{ order_sn: ORDER, payout_amount: 12.5, escrow_release_time: 1_759_111_111 }], false),
    );

    const r = await rodar(c);

    expect(r.contas[0]!.pendentes).toBe(1);
    expect(ultimoPatch(c.db, INT_A)!.pendentes).toEqual([
      {
        orderSn: ORDER,
        payoutAmount: 12.5,
        // ⚠️ SEGUNDOS, verbatim. O sufixo `S` é o mecanismo de segurança, e a
        // conversão acontece UMA vez, na escrita da liquidação.
        escrowReleaseTimeS: 1_759_111_111,
        motivo: MOTIVO_PENDENTE_SHOPEE.semPedido,
        tentativas: 1,
      },
    ]);
    // O payload é IDÊNTICO ao do construtor compartilhado — nada é sintetizado
    // aqui.
    const esperado = notificacaoSinteticaDePedido({
      shopId: SHOP_A,
      orderSn: ORDER,
      nowMs: AGORA_MS,
      origem: 'liquidacao',
    });
    expect(c.enqueue).toHaveBeenCalledTimes(1);
    const enviado = c.enqueue.mock.calls[0]![0];
    expect(enviado).toEqual(esperado);
    expect(docIdOf(enviado)).toBe(`3:${String(SHOP_A)}:${ORDER}:${String(AGORA_MS)}`);
    expect(dedupKeyOf(enviado)).toBe(`3:${String(SHOP_A)}:${ORDER}`);
    // O escrow nem é lido: não há o que liquidar.
    expect(c.getEscrowDetail).not.toHaveBeenCalled();
  });

  it('6. ⚠️ NEAR-MISS de 5: o PEDIDO existe e o pagamento não ⇒ `sem-pagamento`', async () => {
    // Os dois motivos mandam o operador a lugares diferentes: `sem-pedido` é a
    // importação que ainda não rodou, `sem-pagamento` é um pedido importado sem
    // `pay_time` utilizável (ou com o pagamento apagado à mão).
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.db.seed(`pedidos/${pedidoIdDe(ORDER)}`, { numero: ORDER });
    c.getEscrowList.mockResolvedValueOnce(pagina([{ order_sn: ORDER }], false));

    await rodar(c);

    const pendentes = ultimoPatch(c.db, INT_A)!.pendentes as { motivo: string }[];
    expect(pendentes[0]!.motivo).toBe(MOTIVO_PENDENTE_SHOPEE.semPagamento);
  });

  it('7. passado o MÁXIMO de tentativas a linha é DESCARTADA, com um warn sem valores', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.db.seed(`${CURSOR_PATH}/${INT_A}`, {
      cursorMs: AGORA_MS - 10 * DIA_MS,
      pendentes: [
        {
          orderSn: ORDER,
          payoutAmount: 999.99,
          escrowReleaseTimeS: 1_759_111_111,
          motivo: MOTIVO_PENDENTE_SHOPEE.semPedido,
          tentativas: MAX_TENTATIVAS,
        },
      ],
    });

    const r = await rodar(c);

    expect(ultimoPatch(c.db, INT_A)!.pendentes).toEqual([]);
    expect(r.contas[0]!.pendentesDescartados).toBe(1);
    const warn = c.warn.mock.calls.find(([msg]) => msg.includes('pendente descartado'));
    expect(warn).toBeDefined();
    // ⚠️ Nem o payout nem o carimbo entram na linha: é o único warn que um
    // operador lê fora de contexto, e um número de liquidação não é dele para
    // sair colando por aí.
    expect(warn![1]).toEqual({
      integracaoId: INT_A,
      orderSn: ORDER,
      tentativas: MAX_TENTATIVAS + 1,
      motivo: MOTIVO_PENDENTE_SHOPEE.semPedido,
    });
    expect(JSON.stringify(warn![1])).not.toContain('999.99');
  });

  it('7b. ⚠️ NEAR-MISS de 7: na PENÚLTIMA tentativa a linha ainda ganha a sua quarta e FICA', async () => {
    // ⚠️ O teste 7 semeia `tentativas: MAX_TENTATIVAS` — que vira 5, e 5 > 4 e
    // 5 >= 4 são ambos verdade, então a FRONTEIRA em si fica sem ninguém a
    // fixar: um `>=` no lugar do `>` descartaria na QUARTA tentativa e a
    // promessa de "quatro tentativas semanais" passaria a valer três, com o
    // arquivo inteiro verde.
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.db.seed(`${CURSOR_PATH}/${INT_A}`, {
      cursorMs: AGORA_MS - 10 * DIA_MS,
      pendentes: [
        {
          orderSn: ORDER,
          payoutAmount: 12.5,
          escrowReleaseTimeS: 1_759_111_111,
          motivo: MOTIVO_PENDENTE_SHOPEE.semPedido,
          tentativas: MAX_TENTATIVAS - 1,
        },
      ],
    });

    const r = await rodar(c);

    expect(r.contas[0]!.pendentesDescartados).toBe(0);
    expect(c.warn.mock.calls.filter(([msg]) => msg.includes('pendente descartado'))).toEqual([]);
    // A linha SOBREVIVE, exatamente em MAX_TENTATIVAS — é esta igualdade que
    // mata o mutante.
    expect(ultimoPatch(c.db, INT_A)!.pendentes).toEqual([
      {
        orderSn: ORDER,
        payoutAmount: 12.5,
        escrowReleaseTimeS: 1_759_111_111,
        motivo: MOTIVO_PENDENTE_SHOPEE.semPedido,
        tentativas: MAX_TENTATIVAS,
      },
    ]);
  });

  it('8. a lista é LIMITADA: 250 guardados saem 200, com os 50 mais antigos contados', async () => {
    // Um array sem teto dentro de um documento é o penhasco de 1 MiB. O schema
    // deliberadamente NÃO declara o teto — um documento que já o excede tem de
    // continuar parseando, ou a varredura não conseguiria aparar.
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.db.seed(`${CURSOR_PATH}/${INT_A}`, {
      cursorMs: AGORA_MS - 10 * DIA_MS,
      pendentes: Array.from({ length: 250 }, (_, i) => ({
        orderSn: sn(i),
        payoutAmount: null,
        escrowReleaseTimeS: null,
        motivo: MOTIVO_PENDENTE_SHOPEE.semPedido,
        tentativas: 0,
      })),
    });

    const r = await rodar(c);

    const pendentes = ultimoPatch(c.db, INT_A)!.pendentes as { orderSn: string }[];
    expect(pendentes).toHaveLength(MAX_PENDENTES);
    expect(r.contas[0]!.pendentesDescartados).toBe(50);
    // Os mais ANTIGOS (a frente do array) são os que saem.
    expect(pendentes[0]!.orderSn).toBe(sn(50));
  });

  it('9. as sintéticas são LIMITADAS por tick: 60 linhas órfãs ⇒ 50 enfileiradas, 60 estacionadas', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.getEscrowList.mockResolvedValueOnce(
      pagina(
        Array.from({ length: 60 }, (_, i) => ({ order_sn: sn(i) })),
        false,
      ),
    );

    const r = await rodar(c);

    // ⚠️ O enfileiramento é o ÚNICO efeito colateral criador de pedidos desta
    // varredura, então é o que tem o teto mais duro. Estacionar é barato.
    expect(c.enqueue).toHaveBeenCalledTimes(MAX_SINTETICAS_POR_TICK);
    expect(r.contas[0]!.sinteticas).toBe(MAX_SINTETICAS_POR_TICK);
    expect(r.contas[0]!.pendentes).toBe(60);
  });

  it('9b. a lista estacionada é REPLAYADA no tick seguinte — e some quando liquida', async () => {
    // ⚠️ É por isso que um pendente guarda a LINHA inteira e não só um id: a
    // linha não volta depois que o cursor passa do `escrow_release_time` dela.
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.db.seed(`${CURSOR_PATH}/${INT_A}`, {
      cursorMs: AGORA_MS - 10 * DIA_MS,
      pendentes: [
        {
          orderSn: ORDER,
          payoutAmount: 30.7,
          escrowReleaseTimeS: 1_759_111_111,
          motivo: MOTIVO_PENDENTE_SHOPEE.semPedido,
          tentativas: 1,
        },
      ],
    });
    // O pedido chegou pela importação entre um tick e o outro.
    c.db.seed(pagamentoPath(ORDER), { id: ORDER });

    const r = await rodar(c);

    expect(r.contas[0]!.liquidados).toBe(1);
    expect(ultimoPatch(c.db, INT_A)!.pendentes).toEqual([]);
    const gravado = c.db.store[pagamentoPath(ORDER)]!.data.liquidacao as Record<string, unknown>;
    expect(gravado.fonte).toBe(LIQUIDACAO_FONTE.escrowList);
    expect(gravado.escrowReleaseTimeUs).toBe(microsDeSegundosShopee(1_759_111_111));
  });
});

/* ========================================================================== */
/*  10–11 · o que a transação decide                                          */
/* ========================================================================== */

describe('runShopeeEscrowSettlement — obsoleto e sem mudança', () => {
  const ORDER = '260910KJBHUJDM';

  it('10. carimbo guardado ESTRITAMENTE mais novo ⇒ `ignorado-obsoleto`, zero escritas no pagamento', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.db.seed(pagamentoPath(ORDER), {
      id: ORDER,
      liquidacao: {
        payoutAmount: 1,
        escrowReleaseTimeUs: microsDeSegundosShopee(1_759_999_999),
        liquidadoEmUs: 1,
        fonte: LIQUIDACAO_FONTE.escrowList,
      },
    });
    c.getEscrowList.mockResolvedValueOnce(
      pagina([{ order_sn: ORDER, escrow_release_time: 1_759_000_000 }], false),
    );

    const r = await rodar(c);

    expect(r.contas[0]!.obsoletos).toBe(1);
    expect(r.contas[0]!.liquidados).toBe(0);
    expect(c.db.writes.filter((w) => w.path === pagamentoPath(ORDER))).toEqual([]);
  });

  it('11. a SOBREPOSIÇÃO relida é idempotente: nada é escrito no pagamento (só um `get`)', async () => {
    // ⚠️ É isto que torna a sobreposição de um dia grátis. `onPagamentoChanged`
    // ignora só `id` e `ultimaModificacao`, então QUALQUER escrita arquivaria
    // uma linha de histórico por conta por semana, para sempre.
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.getEscrowList.mockImplementation(() =>
      Promise.resolve(pagina([{ order_sn: ORDER, escrow_release_time: 1_759_000_000 }], false)),
    );
    c.db.seed(pagamentoPath(ORDER), { id: ORDER });

    await rodar(c);
    const escritasDepoisDoPrimeiro = c.db.writes.filter(
      (w) => w.path === pagamentoPath(ORDER),
    ).length;
    expect(escritasDepoisDoPrimeiro).toBe(1);

    const opsAntes = c.db.opLog.length;
    const r2 = await rodar(c, { nowMs: AGORA_MS + DIA_MS });

    expect(r2.contas[0]!.semMudanca).toBe(1);
    expect(c.db.writes.filter((w) => w.path === pagamentoPath(ORDER))).toHaveLength(1);
    // A segunda passada toca o pagamento com DOIS `get` e NENHUMA escrita — e
    // os dois são deliberados: o primeiro é a classificação fora da transação
    // (existe? então vale gastar uma chamada de escrow), o segundo é o `tx.get`
    // de onde a decisão é re-derivada. O que o teste compra é a ausência de
    // `update`/`set`.
    const opsDoPagamento = c.db.opLog
      .slice(opsAntes)
      .filter((o) => o.path === pagamentoPath(ORDER));
    expect(opsDoPagamento.map((o) => o.op)).toEqual(['get', 'get']);
  });
});

/* ========================================================================== */
/*  12–16 · contenção                                                         */
/* ========================================================================== */

describe('runShopeeEscrowSettlement — contenção por conta', () => {
  const familia: [string, () => unknown][] = [
    ['ShopeeApiError', () => apiError('income_not_found')],
    ['ShopeeNetworkError', () => new ShopeeNetworkError('ECONNRESET')],
    ['ShopeeHttpError', () => new ShopeeHttpError('502', { httpStatus: 502, path: PATH_ESCROW })],
    [
      'ShopeeSchemaError',
      () =>
        new ShopeeSchemaError('corpo inesperado', {
          campos: ['response.more'],
          httpStatus: 200,
          path: PATH_ESCROW,
        }),
    ],
    ['ShopeeSemCredencialError', () => new ShopeeSemCredencialError('sem credencial')],
    [
      'ShopeeRateLimitError',
      () =>
        new ShopeeRateLimitError('estourou', {
          code: 'error_rate_limit',
          kind: 'burst',
          httpStatus: 200,
          path: PATH_ESCROW,
        }),
    ],
    ['gRPC 14', () => grpc(14, 'UNAVAILABLE')],
  ];

  it.each(familia)('12. %s na conta A é CONTIDO e a conta B roda mesmo assim', async (_n, mk) => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.db.seed(`${INTEGRACAO_PATH}/${INT_B}`, contaDoc({ shop_id: SHOP_B }));
    c.db.seed(`${CURSOR_PATH}/${INT_A}`, { cursorMs: AGORA_MS - 10 * DIA_MS });
    c.clientPor.set(INT_A, {
      getEscrowList: () => Promise.reject(mk()),
      getEscrowDetail: c.getEscrowDetail,
    } as unknown as ShopeeClient);

    const r = await rodar(c);

    const a = r.contas.find((x) => x.integracaoId === INT_A)!;
    const b = r.contas.find((x) => x.integracaoId === INT_B)!;
    expect(a.error).not.toBeNull();
    expect(b.error).toBeNull();
    expect(b.drenada).toBe(true);
    // A conta contida grava `lastSweepAtMs` + `lastError` e NADA do cursor.
    expect(ultimoPatch(c.db, INT_A)).toEqual({
      lastSweepAtMs: AGORA_MS,
      lastError: (mk() as Error).message,
    });
  });

  it('13. ⚠️ NEAR-MISS: `ShopeeConfigError` RELANÇA e a conta B nem roda', async () => {
    // Faltar `SHOPEE_PARTNER_KEY` é MISCONFIGURAÇÃO NOSSA (#778): a execução que
    // nomeia o binding ausente é a que tem de falhar. Um `instanceof
    // ShopeeError` na fronteira engoliria exatamente esta — e transformaria um
    // deploy quebrado em N `lastError` iguais com um tick verde.
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.db.seed(`${INTEGRACAO_PATH}/${INT_B}`, contaDoc({ shop_id: SHOP_B }));
    c.clientPor.set(INT_A, {
      getEscrowList: () => Promise.reject(new ShopeeConfigError('SHOPEE_PARTNER_KEY ausente')),
      getEscrowDetail: c.getEscrowDetail,
    } as unknown as ShopeeClient);

    await expect(rodar(c)).rejects.toBeInstanceOf(ShopeeConfigError);
    expect(c.db.writes.filter((w) => w.path.startsWith(CURSOR_PATH))).toEqual([]);
  });

  it('14. um erro de LINHA no meio da conta contém a conta e NÃO avança o cursor', async () => {
    // ⚠️ Uma queda de 30 segundos não pode pular 300 pedidos e declarar a semana
    // drenada. Só `order_not_found` e um escrow ilegível pulam UMA linha;
    // qualquer outra coisa é problema da conta.
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.db.seed(`${CURSOR_PATH}/${INT_A}`, { cursorMs: AGORA_MS - 10 * DIA_MS });
    for (let i = 1; i <= 5; i += 1) c.db.seed(pagamentoPath(sn(i)), { id: sn(i) });
    c.getEscrowList.mockResolvedValueOnce(
      pagina(
        Array.from({ length: 5 }, (_, k) => ({ order_sn: sn(k + 1) })),
        false,
      ),
    );
    let n = 0;
    c.getEscrowDetail.mockImplementation(() => {
      n += 1;
      if (n === 3) return Promise.reject(new ShopeeNetworkError('ECONNRESET'));
      return Promise.resolve(ESCROW_SG);
    });

    const r = await rodar(c);

    expect(r.contas[0]!.error).toContain('ECONNRESET');
    expect(ultimoPatch(c.db, INT_A)!.cursorMs).toBeUndefined();
    // As linhas 1 e 2 liquidaram; 3, 4 e 5 não.
    expect(c.db.store[pagamentoPath(sn(1))]!.data.liquidacao).toBeDefined();
    expect(c.db.store[pagamentoPath(sn(4))]!.data.liquidacao).toBeUndefined();
    expect(c.db.store[pagamentoPath(sn(5))]!.data.liquidacao).toBeUndefined();
  });

  const NAO_PULAM: readonly [string, () => unknown][] = [
    [
      'ShopeeRateLimitError',
      () =>
        new ShopeeRateLimitError('estourou', {
          code: 'error_rate_limit',
          kind: 'burst',
          httpStatus: 200,
          path: PATH_ESCROW,
        }),
    ],
    [
      'ShopeeReauthRequiredError',
      () =>
        new ShopeeReauthRequiredError('grant morto', {
          code: 'error_auth',
          kind: SHOPEE_ERROR_KIND.reauth,
          httpStatus: 200,
          path: PATH_ESCROW,
        }),
    ],
    ['ShopeeApiError(income_not_found)', () => apiError('income_not_found')],
  ];

  it.each(NAO_PULAM)(
    '14b. ⚠️ NEAR-MISS de 15/16: um %s no get_escrow_detail CONTÉM a conta',
    async (_nome, mk) => {
      // ⚠️ O conjunto que pula UMA linha tem exatamente DUAS classes:
      // `order_not_found` e um escrow ilegível. O teste 14 injeta um
      // `ShopeeNetworkError`, que NÃO é um `ShopeeApiError` — então ele continua
      // relançando mesmo se as duas guardas de cima forem apagadas e o braço do
      // `order_not_found` for afrouxado para um `ShopeeApiError` qualquer. Sob
      // esse mutante um grant morto ou um estouro de cota viram `puladas`, a
      // página drena e o cursor AVANÇA por cima de uma semana inteira de
      // dinheiro, com o arquivo todo verde.
      const c = cenario();
      c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
      c.db.seed(`${CURSOR_PATH}/${INT_A}`, { cursorMs: AGORA_MS - 10 * DIA_MS });
      for (let i = 1; i <= 5; i += 1) c.db.seed(pagamentoPath(sn(i)), { id: sn(i) });
      c.getEscrowList.mockResolvedValueOnce(
        pagina(
          Array.from({ length: 5 }, (_, k) => ({ order_sn: sn(k + 1) })),
          false,
        ),
      );
      let n = 0;
      c.getEscrowDetail.mockImplementation(() => {
        n += 1;
        if (n === 3) return Promise.reject(mk());
        return Promise.resolve(ESCROW_SG);
      });

      const r = await rodar(c);

      expect(r.contas[0]!.error).not.toBeNull();
      expect(r.contas[0]!.puladas).toBe(0);
      // ⚠️ O par que mata o mutante: a janela NÃO drenou e o cursor NÃO andou.
      expect(r.contas[0]!.drenada).toBe(false);
      expect(ultimoPatch(c.db, INT_A)!.cursorMs).toBeUndefined();
      expect(c.db.store[pagamentoPath(sn(5))]!.data.liquidacao).toBeUndefined();
    },
  );

  it('15. `order_not_found` pula a LINHA e a janela ainda drena', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    for (let i = 1; i <= 2; i += 1) c.db.seed(pagamentoPath(sn(i)), { id: sn(i) });
    c.getEscrowList.mockResolvedValueOnce(
      pagina([{ order_sn: sn(1) }, { order_sn: sn(2) }], false),
    );
    c.getEscrowDetail.mockImplementationOnce(() => Promise.reject(apiError('order_not_found')));

    const r = await rodar(c);

    expect(r.contas[0]!.puladas).toBe(1);
    expect(r.contas[0]!.liquidados).toBe(1);
    expect(r.contas[0]!.drenada).toBe(true);
    expect(ultimoPatch(c.db, INT_A)!.cursorMs).toBe(r.contas[0]!.janela!.ateMs);
  });

  it('16. `ShopeeSchemaError` numa linha pula a linha e o warn carrega só CAMINHOS', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    const ORDER = '260910KJBHUJDM';
    c.db.seed(pagamentoPath(ORDER), { id: ORDER });
    c.getEscrowList.mockResolvedValueOnce(pagina([{ order_sn: ORDER }], false));
    c.getEscrowDetail.mockImplementationOnce(() =>
      Promise.reject(
        new ShopeeSchemaError('escrow ilegível', {
          campos: ['response.order_income.escrow_amount'],
          httpStatus: 200,
          path: PATH_ESCROW,
        }),
      ),
    );

    const r = await rodar(c);

    expect(r.contas[0]!.puladas).toBe(1);
    expect(r.contas[0]!.drenada).toBe(true);
    const warn = c.warn.mock.calls.find(([msg]) => msg.includes('escrow ilegível'));
    expect(warn![1]).toEqual({
      integracaoId: INT_A,
      orderSn: ORDER,
      campos: ['response.order_income.escrow_amount'],
    });
  });
});

/* ========================================================================== */
/*  17–21 · paginação e linhas                                                */
/* ========================================================================== */

describe('runShopeeEscrowSettlement — a paginação', () => {
  it('17. a guarda de PÁGINA REPETIDA para o tick, nomeia o motivo e LIMPA o pendingPageNo', async () => {
    // Uma página não-vazia que não contribui NENHUM `order_sn` novo enquanto
    // `more` continua `true` quer dizer que a Shopee está ignorando `page_no`:
    // sem a guarda, o laço releria a página 1 até o teto de páginas.
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.db.seed(`${CURSOR_PATH}/${INT_A}`, { cursorMs: AGORA_MS - 10 * DIA_MS });
    c.getEscrowList.mockImplementation(() =>
      Promise.resolve(pagina([{ order_sn: sn(1) }, { order_sn: sn(2) }], true)),
    );

    const r = await rodar(c);

    const conta = r.contas[0]!;
    expect(conta.paginas).toBe(2);
    expect(conta.truncada).toBe(true);
    expect(conta.duplicadas).toBe(2);
    const patch = ultimoPatch(c.db, INT_A)!;
    expect(patch.lastError).toBe(MOTIVO_PAGINA_REPETIDA);
    expect(patch.cursorMs).toBeUndefined();
    expect(patch.pendingWindowFromMs).toBe(conta.janela!.deMs);
    // ⚠️ LIMPO, não `pageNo + 1`: um `page_no` que a Shopee ignora não é chave
    // de retomada nenhuma — o próximo tick recomeça da página 1.
    expect(patch.pendingPageNo).toBeNull();
    const warn = c.warn.mock.calls.find(([msg]) => msg.includes('página repetida'));
    expect(warn![1]).toEqual({ integracaoId: INT_A, pageNo: 2, linhas: 2 });
  });

  it('18. ⚠️ NEAR-MISS de 17: uma página VAZIA com `more: true` CONTINUA paginando', async () => {
    // O oposto explícito da regra do `missedFeedsSweep` do Mercado Livre. Uma
    // página vazia é um fato diferente de uma página repetida.
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    const respostas = [pagina([], true), pagina([], true), pagina([], false)];
    let i = 0;
    c.getEscrowList.mockImplementation(() => Promise.resolve(respostas[i++]!));

    const r = await rodar(c);

    expect(r.contas[0]!.paginas).toBe(3);
    expect(r.contas[0]!.drenada).toBe(true);
    expect(chamada(c, 2).pageNo).toBe(3);
    expect(ultimoPatch(c.db, INT_A)!.lastError).toBeNull();
  });

  it('18b. ⚠️ NEAR-MISS de 17: uma página cujas linhas vieram todas do REPLAY CONTINUA paginando', async () => {
    // ⚠️ `vistos` é compartilhado entre o replay dos estacionados e a
    // paginação — tem de ser, porque a mesma order liquida UMA vez por tick.
    // Mas a guarda de página repetida mede PROGRESSO DE PAGINAÇÃO: se um
    // `duplicada` vindo do replay contasse como "zero novos", uma página que a
    // Shopee serviu corretamente truncaria a janela, limparia o `pendingPageNo`
    // e o cursor nunca andaria — por tantos ticks semanais quantos os
    // estacionados sobrevivessem — enquanto o `lastError` culpava a Shopee.
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.db.seed(`${CURSOR_PATH}/${INT_A}`, {
      cursorMs: AGORA_MS - 10 * DIA_MS,
      pendentes: [sn(1), sn(2)].map((orderSn) => ({
        orderSn,
        payoutAmount: 30.7,
        escrowReleaseTimeS: 1_759_000_000,
        motivo: MOTIVO_PENDENTE_SHOPEE.semPedido,
        tentativas: 1,
      })),
    });
    // A página 1 traz exatamente as duas linhas que o replay acabou de tratar;
    // a página 2 tem a order que realmente liquida.
    c.db.seed(pagamentoPath(sn(3)), { id: sn(3) });
    const paginas = [
      pagina([{ order_sn: sn(1) }, { order_sn: sn(2) }], true),
      pagina([{ order_sn: sn(3) }], false),
    ];
    let i = 0;
    c.getEscrowList.mockImplementation(() => Promise.resolve(paginas[i++]!));

    const r = await rodar(c);

    const conta = r.contas[0]!;
    expect(conta.paginas).toBe(2);
    expect(conta.truncada).toBe(false);
    expect(conta.drenada).toBe(true);
    expect(conta.duplicadas).toBe(2);
    // A página 2 foi pedida, a order dela liquidou e o cursor ANDOU.
    expect(chamada(c, 1).pageNo).toBe(2);
    expect(conta.liquidados).toBe(1);
    const patch = ultimoPatch(c.db, INT_A)!;
    expect(patch.cursorMs).toBe(conta.janela!.ateMs);
    expect(patch.lastError).toBeNull();
    expect(c.warn.mock.calls.filter(([msg]) => msg.includes('página repetida'))).toEqual([]);
  });

  it('19. uma linha `null` (o sentinela por-ELEMENTO do schema) é contada e pulada', async () => {
    // Uma linha ilegível não pode bloquear a semana inteira de todos os outros
    // pedidos — e o sentinela é `null`, que nenhuma linha real pode ser.
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.db.seed(pagamentoPath(sn(1)), { id: sn(1) });
    c.getEscrowList.mockResolvedValueOnce(pagina([null, { order_sn: sn(1) }], false));

    const r = await rodar(c);

    expect(r.contas[0]!.ilegiveis).toBe(1);
    expect(r.contas[0]!.linhas).toBe(2);
    expect(r.contas[0]!.liquidados).toBe(1);
    expect(r.contas[0]!.drenada).toBe(true);
  });

  it('20. a mesma order duas vezes no tick é UMA liquidação e uma `duplicada`', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.db.seed(pagamentoPath(sn(1)), { id: sn(1) });
    c.getEscrowList.mockResolvedValueOnce(
      pagina([{ order_sn: sn(1) }, { order_sn: sn(1) }], false),
    );

    const r = await rodar(c);

    expect(r.contas[0]!.duplicadas).toBe(1);
    expect(r.contas[0]!.liquidados).toBe(1);
    expect(c.getEscrowDetail).toHaveBeenCalledTimes(1);
  });

  it('21. janela DEGENERADA pula a conta sem chamada; o NEAR-MISS de largura ZERO vai ao fio', async () => {
    // ⚠️ O teste é `<` e não `<=`: uma janela de largura zero é LEGAL nesta
    // página (a Shopee recusa só "start later than end", ao contrário de
    // `get_order_list`), e uma conta já drenada até `now` precisa poder pedi-la.
    const degenerada = cenario();
    degenerada.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    degenerada.db.seed(`${CURSOR_PATH}/${INT_A}`, { cursorMs: AGORA_MS + 2 * DIA_MS });

    const rd = await rodar(degenerada);

    expect(rd.contas[0]!.pulada).toBe(MOTIVO_JANELA_DEGENERADA);
    expect(degenerada.getEscrowList).not.toHaveBeenCalled();
    expect(degenerada.db.writes.filter((w) => w.path.startsWith(CURSOR_PATH))).toEqual([]);

    const zero = cenario();
    zero.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    zero.db.seed(`${CURSOR_PATH}/${INT_A}`, { cursorMs: AGORA_MS + OVERLAP_MS });

    const rz = await rodar(zero);

    expect(rz.contas[0]!.pulada).toBeNull();
    expect(chamada(zero, 0).releaseTimeFromS).toBe(chamada(zero, 0).releaseTimeToS);
  });
});

/* ========================================================================== */
/*  22–24 · as costuras                                                       */
/* ========================================================================== */

describe('runShopeeEscrowSettlement — as costuras da CLI', () => {
  it('22. `persistirCursor: false` ⇒ NADA é gravado em liquidacaoShopee', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    const ORDER = '260910KJBHUJDM';
    c.db.seed(pagamentoPath(ORDER), { id: ORDER });
    c.getEscrowList.mockResolvedValueOnce(pagina([{ order_sn: ORDER }], false));

    const r = await rodar(c, { persistirCursor: false });

    // A liquidação em si ACONTECE — só o cursor é que não é tocado.
    expect(r.contas[0]!.liquidados).toBe(1);
    expect(c.db.writes.filter((w) => w.path.startsWith(CURSOR_PATH))).toEqual([]);
  });

  it('23. `janela` sobrepõe o cursor gravado — e uma janela drenada NÃO avança o cursor', async () => {
    // ⚠️ Uma janela escolhida a mão não diz nada sobre o terreno entre o cursor
    // e ela, então `max(guardado, ateMs)` reivindicaria terreno não lido.
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.db.seed(`${CURSOR_PATH}/${INT_A}`, {
      cursorMs: AGORA_MS - 30 * DIA_MS,
      pendingWindowFromMs: AGORA_MS - 20 * DIA_MS,
      pendingWindowToMs: AGORA_MS - 19 * DIA_MS,
      pendingPageNo: 4,
    });
    const deMs = AGORA_MS - 3 * DIA_MS;
    const ateMs = AGORA_MS - 1 * DIA_MS;

    const r = await rodar(c, { janela: { deMs, ateMs } });

    expect(chamada(c, 0).releaseTimeFromS).toBe(Math.floor(deMs / SEGUNDO_MS));
    expect(chamada(c, 0).releaseTimeToS).toBe(Math.floor(ateMs / SEGUNDO_MS));
    // O trio pendente é IGNORADO: a página volta a ser a 1.
    expect(chamada(c, 0).pageNo).toBe(1);
    expect(r.contas[0]!.retomada).toBe(false);
    expect(r.contas[0]!.drenada).toBe(true);
    expect(ultimoPatch(c.db, INT_A)!.cursorMs).toBeUndefined();
  });

  it('24. `apenasIntegracoes` roda UMA conta e nem lê o cursor da outra', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.db.seed(`${INTEGRACAO_PATH}/${INT_B}`, contaDoc({ shop_id: SHOP_B }));

    const r = await rodar(c, { apenasIntegracoes: [INT_B] });

    expect(r.contas.map((x) => x.integracaoId)).toEqual([INT_B]);
    expect(c.db.caminhos).not.toContain(`${CURSOR_PATH}/${INT_A}`);
  });

  it('24b. uma conta sem `shop_id` é contada e nomeada, e NADA é escrito por ela', async () => {
    const c = cenario();
    const semShop = contaDoc();
    delete semShop.shop_id;
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, semShop);

    const r = await rodar(c);

    expect(r.semShopId).toBe(1);
    expect(r.contas[0]!.pulada).toBe(MOTIVO_SEM_SHOP_ID);
    expect(c.getEscrowList).not.toHaveBeenCalled();
    expect(c.db.writes).toEqual([]);
  });
});

/* ========================================================================== */
/*  25 · os logs                                                              */
/* ========================================================================== */

describe('runShopeeEscrowSettlement — os logs', () => {
  it('25. a linha do tick tem EXATAMENTE o conjunto de chaves acordado e nenhum order_sn', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());

    await rodar(c);

    const meta = linhaDoTick(c);
    expect(Object.keys(meta).sort()).toEqual(
      [
        'duplicadas',
        'erros',
        'ilegiveis',
        'integracaoId',
        'janela',
        'liquidados',
        'linhas',
        'obsoletos',
        'paginas',
        'pendentes',
        'pendentesDescartados',
        'puladas',
        'semMudanca',
        'sinteticas',
      ].sort(),
    );
    // ⚠️ Nenhum `order_sn` na linha AGREGADA: nomear um pedido ali leria como
    // "foi este que falhou".
    expect(JSON.stringify(meta)).not.toContain('26091');
  });

  it('25b. a linha DETALHADA por pedido para no teto por instância — mas a razão anômala sempre sai', async () => {
    // ⚠️ A razão `payout ÷ escrow` é o instrumento do item 21 do registro: a
    // própria página da Shopee se contradiz sobre a unidade de `payout_amount`
    // (a tabela imprime um float, o exemplo imprime um inteiro 100× maior), e
    // ~1 quer dizer unidades enquanto ~100 quer dizer centavos.
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    const total = LOG_LIQUIDACAO_DETALHADA_MAX + 3;
    for (let i = 0; i < total; i += 1) c.db.seed(pagamentoPath(sn(i)), { id: sn(i) });
    c.getEscrowList.mockResolvedValueOnce(
      pagina(
        // As três últimas em CENTAVOS — razão ~100, fora de [0.5, 2].
        Array.from({ length: total }, (_, i) => ({
          order_sn: sn(i),
          payout_amount: i < LOG_LIQUIDACAO_DETALHADA_MAX ? 30.7 : 3070,
        })),
        false,
      ),
    );

    const r = await rodar(c);

    expect(r.contas[0]!.liquidados).toBe(total);
    const detalhadas = c.info.mock.calls.filter(
      ([msg]) => msg === '[shopee/liquidacao] pedido liquidado',
    );
    // 20 dentro do teto + 3 fora da faixa = 23, e não `total` nem 20.
    expect(detalhadas).toHaveLength(LOG_LIQUIDACAO_DETALHADA_MAX + 3);
    expect(detalhadas[0]![1]!.razaoPayoutSobreEscrow).toBe(1);
    expect(detalhadas.at(-1)![1]!.razaoPayoutSobreEscrow).toBe(100);
    // A linha detalhada carrega o `payout_amount` CRU, sem conversão nenhuma.
    expect(detalhadas.at(-1)![1]!.payoutAmount).toBe(3070);
    // ⚠️ `tarifas` é a FIGURA, como em toda parte deste canal (o log da
    // importação, o resumo da rehearsal, o runbook) — não um booleano "mudou?".
    // Um booleano sob esta chave seria um segundo significado para um nome só,
    // numa linha cujas outras chaves são todas dinheiro, e confundiria "a tarifa
    // já estava certa" com "não veio `order_income`". O "mudou" tem chave própria.
    expect(detalhadas[0]![1]!.tarifas).toBe(1.29);
    expect(detalhadas[0]![1]!.tarifasMudou).toBe(true);
  });

  it('25c. ⚠️ nenhum log desta varredura carrega um CNPJ, um cAut ou um campo do comprador', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    for (let i = 0; i < 3; i += 1) c.db.seed(pagamentoPath(sn(i)), { id: sn(i) });
    c.getEscrowList.mockResolvedValueOnce(
      pagina(
        Array.from({ length: 3 }, (_, i) => ({ order_sn: sn(i) })),
        false,
      ),
    );

    await rodar(c);

    const todas = [...c.info.mock.calls, ...c.warn.mock.calls];
    // Âncora: o negativo não pode ser vazio.
    expect(todas.length).toBeGreaterThan(0);
    const texto = JSON.stringify(todas);
    expect(texto).not.toMatch(/(?<!\d)\d{14}(?!\d)/);
    expect(texto).not.toContain('AUT-');
    expect(texto).not.toContain('buyer_');
    expect(texto).not.toContain('REDACTED');
  });
});

/* ========================================================================== */
/*  26 · a ENSAIO (dry-run) vê o mesmo conjunto de linhas que o tick           */
/* ========================================================================== */

describe('simularLiquidacaoShopee — paridade com o tick vivo', () => {
  const ORDER = '260910KJBHUJDM';

  function clienteDe(c: Cenario): ShopeeClient {
    return {
      getEscrowList: c.getEscrowList,
      getEscrowDetail: c.getEscrowDetail,
    } as unknown as ShopeeClient;
  }

  /** O mesmo estado semeado nos dois caminhos: um estacionado FORA da janela. */
  function semear(c: Cenario): void {
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.db.seed(`${CURSOR_PATH}/${INT_A}`, {
      cursorMs: AGORA_MS - 10 * DIA_MS,
      pendentes: [
        {
          orderSn: ORDER,
          payoutAmount: 30.7,
          // ⚠️ ABAIXO da janela que este cursor produz: a listagem é consultada
          // POR faixa de `escrow_release_time`, então esta linha nunca mais
          // volta por ali. É exatamente por isso que a lista estacionada guarda
          // a linha inteira — e exatamente o que uma rehearsal que só pagina
          // não teria como mostrar.
          escrowReleaseTimeS: 1_700_000_000,
          motivo: MOTIVO_PENDENTE_SHOPEE.semPedido,
          tentativas: 1,
        },
      ],
    });
    // O pedido chegou pela importação entre um tick e o outro.
    c.db.seed(pagamentoPath(ORDER), { id: ORDER });
  }

  it('26. o ensaio REPLAYA os estacionados — e o que ele prevê é o que o `--live` escreve', async () => {
    const seco = cenario();
    semear(seco);

    const sim = await simularLiquidacaoShopee(asDb(seco.db), {
      integracaoId: INT_A,
      client: clienteDe(seco),
      nowMs: AGORA_MS,
    });

    // A listagem respondeu VAZIA (o default do cenário) e ainda assim há uma
    // linha — a estacionada, marcada como tal.
    expect(sim.linhas.map((l) => [l.orderSn, l.origem])).toEqual([[ORDER, 'pendente']]);
    expect(sim.linhas[0]!.previsao?.acao).toBe('liquidado');
    // ⚠️ E nada foi escrito: não existe escritora no corpo do ensaio.
    expect(seco.db.writes).toEqual([]);
    expect(seco.db.occ.txLog).toEqual([]);

    // O MESMO estado, agora no tick vivo.
    const vivo = cenario();
    semear(vivo);
    const r = await rodar(vivo);

    expect(r.contas[0]!.liquidados).toBe(1);
    expect(vivo.db.store[pagamentoPath(ORDER)]!.data.liquidacao).toBeDefined();
    // A paridade que importa: o ensaio previu exatamente a mesma ORDER que o
    // `--live` liquidou, e não um conjunto vazio.
    expect(sim.linhas).toHaveLength(r.contas[0]!.liquidados);
  });

  it('26b. ⚠️ NEAR-MISS: sem nada estacionado o ensaio vê só a listagem', async () => {
    // A âncora do negativo acima: a linha extra vem da lista estacionada, não
    // de qualquer linha que o ensaio invente.
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT_A}`, contaDoc());
    c.db.seed(`${CURSOR_PATH}/${INT_A}`, { cursorMs: AGORA_MS - 10 * DIA_MS });
    c.db.seed(pagamentoPath(sn(1)), { id: sn(1) });
    c.getEscrowList.mockResolvedValueOnce(pagina([{ order_sn: sn(1) }], false));

    const sim = await simularLiquidacaoShopee(asDb(c.db), {
      integracaoId: INT_A,
      client: clienteDe(c),
      nowMs: AGORA_MS,
    });

    expect(sim.linhas.map((l) => [l.orderSn, l.origem])).toEqual([[sn(1), 'listagem']]);
    expect(sim.drenada).toBe(true);
    expect(c.db.writes).toEqual([]);
  });
});
