/**
 * `liquidarPagamentoShopee` — the WEEKLY settlement write (#1514, step 6, plan
 * §3.0-S S8), over the shared `FakeDb` + the REAL `OccEngine`.
 *
 * ⚠️ The four properties this file exists for, and none of them is visible to a
 * happy-path assertion:
 *
 *  1. **the release-time watermark is in MICROseconds, and the UNIT is the
 *     guard.** Test 29 runs the near-miss directly against `coerceToMicros` —
 *     the helper that would be reached for by anyone "simplifying" the
 *     conversion — and shows it answers 1970, which would make every stored
 *     stamp look newer than every incoming one for ever;
 *  2. **a re-covered overlap row writes NOTHING.** The one-day weekly overlap
 *     re-reads every row near the cursor, and `onPagamentoChanged` ignores only
 *     `id` and `ultimaModificacao` — so a write of any kind would file a history
 *     row per conta per week, for ever;
 *  3. **`tx.update`, never `tx.set`.** A set would wipe `valor`,
 *     `forma_de_pagamento` and `cartao`, and the nota sums `valor`;
 *  4. **the two writers own DISJOINT top-level masks.** Test 32 races a sweep
 *     write against a task-shaped write on the SAME document and asserts both
 *     halves stand.
 *
 * ⚠️ No real credential, shop or buyer datum: the SG body is the redacted
 * `__wire__` corpus and every synthetic vector goes through the package schema.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coerceToMicros } from '@delfrance/core/datetime';
import { deferred } from '@delfrance/data/testing';
import { pagamentoCollection } from '@delfrance/data/admin/collections';
import {
  FORMA_PAGAMENTO,
  LIQUIDACAO_FONTE,
  MARKETPLACE_PEDIDO_TIPO,
  STATUS_PAGAMENTO,
} from '@delfrance/schemas';
import {
  shopeeEscrowDetailPayloadSchema,
  type ShopeeEscrowDetail,
} from '@delfrance/integrations-shopee';

import { FakeDb, asDb } from '../testing/fakeDb';
import { FIXTURE_ESCROW_DETAIL_QTY2_SG, lerEscrowDetalhe } from '../fixtures/wireCorpus';
import { makePagamentoIdShopee, makePedidoIdShopee } from './orderIds';
import { microsDeSegundosShopee } from './orderMapping';
import { diarioMarketplaceDeEscrow, tarifasDeShopee } from './pagamentoMapping';
import { liquidarPagamentoShopee } from './liquidarPagamento';

/* -------------------------------------------------------------------------- */
/*  Identidades de teste — nenhuma delas é real.                               */
/* -------------------------------------------------------------------------- */

const CONTA = 'int-1';
const ORDER_SN = '260910KJBHUJDM';
const PEDIDO_ID = makePedidoIdShopee(CONTA, ORDER_SN);
const PAGAMENTO_ID = makePagamentoIdShopee(CONTA, ORDER_SN);
const PAGAMENTO_PATH = `pedidos/${PEDIDO_ID}/pagamentos/${PAGAMENTO_ID}`;
/** O carimbo de liberação do escrow, em SEGUNDOS — como a listagem o envia. */
const RELEASE_S = 1_788_973_400;
const RELEASE_US = microsDeSegundosShopee(RELEASE_S);
const AGORA_MS = 1_700_000_000_000;
const AGORA_US = AGORA_MS * 1000;
/** Um SEGUNDO relógio, para provar que `nowUs` não vaza num campo comparado. */
const OUTRO_AGORA_MS = 1_700_000_999_000;
const OUTRO_AGORA_US = OUTRO_AGORA_MS * 1000;
const PAYOUT = 30.7;
/** O relógio da ORDEM (µs) — a varredura não tem um e nunca o re-data. */
const RELOGIO_DA_ORDEM_US = 1_699_000_000_000_000;

function escrowSG(): ShopeeEscrowDetail {
  return lerEscrowDetalhe(FIXTURE_ESCROW_DETAIL_QTY2_SG).response;
}

/** Um escrow sintético, pelo schema do pacote — nunca um literal com cast. */
function escrowSintetico(orderIncome: Record<string, unknown>): ShopeeEscrowDetail {
  return shopeeEscrowDetailPayloadSchema.parse({
    order_sn: ORDER_SN,
    order_income: {
      escrow_amount: 30.7,
      escrow_amount_after_adjustment: 30.7,
      buyer_total_amount: 31.99,
      ...orderIncome,
    },
  });
}

/** O que o caminho da TAREFA (passo 5) deixa gravado antes da varredura passar. */
function pagamentoDaTarefa(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ORDER_SN,
    valor: 31.99,
    forma_de_pagamento: FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria,
    status_pagamento: STATUS_PAGAMENTO.aprovado,
    parcelas: 1,
    aVista: true,
    duplicata: false,
    juros: null,
    cartao: null,
    tarifas: 1.29,
    dataCadastro: AGORA_US,
    dataAprovacao: AGORA_US,
    ultimaModificacao: AGORA_US,
    marketplace: {
      tipo: MARKETPLACE_PEDIDO_TIPO.shopee,
      orderSn: ORDER_SN,
      buyerTotalAmount: 31.99,
      escrowAmount: 30.7,
      escrowAmountAfterAdjustment: 30.7,
      tarifasBrutas: 1.29,
      taxas: {
        comissao: 0.65,
        servico: 0,
        transacaoVendedor: 0.64,
        campanha: 0,
        protecaoFrete: 0,
        processamento: 0,
        ajustes: 0,
        devolucoes: 0,
      },
      atualizadoEm: AGORA_US,
    },
    liquidacao: null,
    ...over,
  };
}

function liquidar(
  db: FakeDb,
  args: {
    escrow?: ShopeeEscrowDetail;
    escrowReleaseTimeS?: number | null;
    payoutAmount?: number | null;
    nowMs?: number;
  } = {},
) {
  return liquidarPagamentoShopee(asDb(db), {
    pedidoId: PEDIDO_ID,
    contaId: CONTA,
    orderSn: ORDER_SN,
    escrow: args.escrow ?? escrowSG(),
    escrowReleaseTimeS: args.escrowReleaseTimeS === undefined ? RELEASE_S : args.escrowReleaseTimeS,
    payoutAmount: args.payoutAmount === undefined ? PAYOUT : args.payoutAmount,
    nowMs: args.nowMs ?? AGORA_MS,
  });
}

function doc(db: FakeDb): Record<string, unknown> {
  return db.store[PAGAMENTO_PATH]!.data;
}

beforeEach(() => {
  // Silenciado, não asserido: este módulo não loga nada — os avisos da
  // varredura moram em `liquidacaoSweep.test.ts`.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

/* ========================================================================== */
/*  26 · liquidado                                                            */
/* ========================================================================== */

describe('liquidarPagamentoShopee — o caminho feliz', () => {
  it('26. carimba `liquidacao`, refresca o dinheiro e NÃO toca em nada da tarefa', async () => {
    const db = new FakeDb();
    db.seed(PAGAMENTO_PATH, pagamentoDaTarefa({ tarifas: 9.99 }));

    const r = await liquidar(db);

    expect(r.acao).toBe('liquidado');
    expect(r.pagamentoId).toBe(PAGAMENTO_ID);
    expect(r.escrowReleaseTimeUs).toBe(RELEASE_US);

    const d = doc(db);
    expect(d.liquidacao).toEqual({
      payoutAmount: PAYOUT,
      escrowReleaseTimeUs: RELEASE_US,
      liquidadoEmUs: AGORA_US,
      fonte: LIQUIDACAO_FONTE.escrowList,
    });
    // ⚠️ O número vem da MESMA função pura que o mapper da importação usa —
    // importada, nunca re-derivada: se as duas divergissem, uma varredura e uma
    // tarefa concorrentes escreveriam valores diferentes no mesmo documento a
    // cada semana.
    expect(d.tarifas).toBe(tarifasDeShopee(escrowSG()).tarifas);
    expect(d.tarifas).toBe(1.29);

    // ⛔ MUTANTE: `tx.set` no lugar de `tx.update` apagaria TODOS estes campos —
    // e `valor` é o que a nota soma (cStat 865/866, sem troco no marketplace).
    expect(d.valor).toBe(31.99);
    expect(d.forma_de_pagamento).toBe(FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria);
    expect(d.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(d.parcelas).toBe(1);
    expect(d.aVista).toBe(true);
    expect(d.id).toBe(ORDER_SN);
    expect(d.dataAprovacao).toBe(AGORA_US);
    expect(d.dataCadastro).toBe(AGORA_US);

    // Verbo: update, nunca set, nunca create.
    expect(db.opLog.filter((o) => o.op === 'update')).toHaveLength(1);
    expect(db.opLog.filter((o) => o.op === 'set')).toHaveLength(0);
    expect(db.opLog.filter((o) => o.op === 'create')).toHaveLength(0);
    // UMA leitura: o pagamento primário, e nada mais.
    expect(db.opLog.filter((o) => o.op === 'get')).toHaveLength(1);
  });

  it('27. a metade do `marketplace` que a TAREFA escreveu sobrevive ao rebuild', async () => {
    // `update` mascara na CHAVE de topo e substitui o mapa inteiro, então o
    // diário tem de ser reconstruído a partir do que está gravado. `tipo`,
    // `orderSn` e `atualizadoEm` não são derivados do escrow — e `atualizadoEm`
    // é o relógio da ORDEM, que esta varredura não tem.
    const db = new FakeDb();
    db.seed(
      PAGAMENTO_PATH,
      pagamentoDaTarefa({
        marketplace: {
          tipo: MARKETPLACE_PEDIDO_TIPO.shopee,
          orderSn: ORDER_SN,
          buyerTotalAmount: 1,
          escrowAmount: 1,
          escrowAmountAfterAdjustment: 1,
          tarifasBrutas: 1,
          taxas: null,
          atualizadoEm: RELOGIO_DA_ORDEM_US,
          // Uma chave desconhecida, que só existe por causa do `.passthrough()`.
          campoDeUmPassoFuturo: 'x',
        },
      }),
    );

    await liquidar(db);

    const mk = doc(db).marketplace as Record<string, unknown>;
    expect(mk.tipo).toBe(MARKETPLACE_PEDIDO_TIPO.shopee);
    expect(mk.orderSn).toBe(ORDER_SN);
    // ⛔ MUTANTE: dropar a metade gravada re-dataria o diário com o relógio
    // errado e perderia a chave desconhecida.
    expect(mk.atualizadoEm).toBe(RELOGIO_DA_ORDEM_US);
    expect(mk.campoDeUmPassoFuturo).toBe('x');
    // …e o dinheiro do escrow FOI atualizado, que é o ponto da varredura.
    expect(mk.escrowAmount).toBe(30.7);
    expect(mk.buyerTotalAmount).toBe(31.99);
    expect(mk.tarifasBrutas).toBe(diarioMarketplaceDeEscrow(escrowSG())!.tarifasBrutas);
  });

  it('27b. ⚠️ NEAR-MISS: um pagamento SEM `marketplace` ganha o mapa, com `tipo` preenchido', async () => {
    // `marketplacePagamentoSchema.tipo` é OBRIGATÓRIO e um pagamento cuja
    // importação não conseguiu ler o escrow tem `marketplace: null` — então a
    // varredura pode ser a PRIMEIRA escritora do mapa. Sem o preenchimento o
    // `parseMerge` lançaria ZodError dentro da transação.
    const db = new FakeDb();
    db.seed(PAGAMENTO_PATH, pagamentoDaTarefa({ marketplace: null, tarifas: null }));

    const r = await liquidar(db);

    expect(r.acao).toBe('liquidado');
    const mk = doc(db).marketplace as Record<string, unknown>;
    expect(mk.tipo).toBe(MARKETPLACE_PEDIDO_TIPO.shopee);
    expect(mk.orderSn).toBe(ORDER_SN);
    expect(mk.escrowAmount).toBe(30.7);
  });
});

/* ========================================================================== */
/*  28 · sem pagamento                                                        */
/* ========================================================================== */

describe('liquidarPagamentoShopee — documento ausente', () => {
  it('28. `ignorado-sem-pagamento`: nada é gravado e NADA é criado', async () => {
    // A varredura nunca cria um pagamento: só a importação conhece o `valor`
    // voltado ao comprador que a nota tem de somar. A linha é estacionada e um
    // code 3 sintético traz o pedido pelo caminho normal.
    const db = new FakeDb();

    const r = await liquidar(db);

    expect(r.acao).toBe('ignorado-sem-pagamento');
    expect(r.campos).toEqual([]);
    expect(db.writes).toEqual([]);
    expect(db.opLog.map((o) => o.op)).toEqual(['get']);
    expect(db.store[PAGAMENTO_PATH]).toBeUndefined();
  });
});

/* ========================================================================== */
/*  29–30 · o carimbo de liberação                                            */
/* ========================================================================== */

describe('liquidarPagamentoShopee — a marca d’água de liberação', () => {
  it('29. ⚠️ o quase-erro de UNIDADE, rodado contra o `coerceToMicros` de verdade', async () => {
    // ⛔ MUTANTE 1, e é O mutante deste arquivo: trocar
    // `microsDeSegundosShopee` por `coerceToMicros`. O segundo classifica por
    // MAGNITUDE — `1.79e9` fica abaixo do teto de milissegundos (9e12) — então
    // lê SEGUNDOS como MILISSEGUNDOS e responde 1970.
    // `coerceToMicros` devolve `number | null`; aqui ele devolve um número —
    // e é exatamente esse o problema: ele NÃO recusa segundos, ele os aceita
    // com a magnitude errada.
    const errado = coerceToMicros(RELEASE_S)!;
    const certo = microsDeSegundosShopee(RELEASE_S);
    expect(errado).toBe(RELEASE_S * 1000);
    expect(certo).toBe(RELEASE_S * 1_000_000);
    expect(new Date(errado / 1000).getUTCFullYear()).toBe(1970);
    expect(new Date(certo / 1000).getUTCFullYear()).toBeGreaterThan(2020);

    // …e a consequência, não só a aritmética: um carimbo construído com o
    // helper errado é REJEITADO como obsoleto contra qualquer carimbo real já
    // guardado, para sempre.
    const db = new FakeDb();
    db.seed(
      PAGAMENTO_PATH,
      pagamentoDaTarefa({
        liquidacao: {
          payoutAmount: PAYOUT,
          escrowReleaseTimeUs: certo,
          liquidadoEmUs: AGORA_US,
          fonte: LIQUIDACAO_FONTE.escrowList,
        },
      }),
    );
    // `errado / 1000` é o valor em SEGUNDOS que produziria `errado` em µs se a
    // conversão fosse a certa — isto é, o que uma linha "de 1970" enviaria.
    const r = await liquidar(db, { escrowReleaseTimeS: errado / 1_000_000 });
    expect(r.acao).toBe('ignorado-obsoleto');
    expect(db.writes).toEqual([]);
  });

  it('30. guarda ESTRITO: mais novo guardado descarta; IGUAL passa; `null` dos dois lados passa', async () => {
    // EQUAL tem de passar — é exatamente o que a sobreposição de um dia relê
    // toda semana, e um `>=` aqui tornaria a sobreposição inútil.
    const semear = (over: Record<string, unknown>): FakeDb => {
      const db = new FakeDb();
      db.seed(PAGAMENTO_PATH, pagamentoDaTarefa(over));
      return db;
    };
    const liquidacaoCom = (us: number | null) => ({
      payoutAmount: PAYOUT,
      escrowReleaseTimeUs: us,
      liquidadoEmUs: AGORA_US,
      fonte: LIQUIDACAO_FONTE.escrowList,
    });

    // (a) guardado estritamente MAIS NOVO ⇒ descarta, zero escritas.
    const maisNovo = semear({ liquidacao: liquidacaoCom(RELEASE_US + 1_000_000) });
    expect((await liquidar(maisNovo)).acao).toBe('ignorado-obsoleto');
    expect(maisNovo.writes).toEqual([]);

    // (b) IGUAL ⇒ cai para a comparação de conteúdo (e aqui nada mudou).
    const igual = semear({ liquidacao: liquidacaoCom(RELEASE_US) });
    expect((await liquidar(igual)).acao).toBe('ignorado-sem-mudanca');
    expect(igual.writes).toEqual([]);

    // (c) guardado `null` ⇒ passa; um carimbo ausente não é prova de ordem.
    const semGuardado = semear({ liquidacao: liquidacaoCom(null) });
    expect((await liquidar(semGuardado)).acao).toBe('liquidado');

    // (d) recebido `null` com guardado presente ⇒ TAMBÉM passa, e o campo muda
    // para null: é por isso que a CLI recusa `--order-sn --live`, que é o único
    // caminho capaz de chegar aqui com um `null` por ignorância.
    const semRecebido = semear({ liquidacao: liquidacaoCom(RELEASE_US) });
    const r = await liquidar(semRecebido, { escrowReleaseTimeS: null });
    expect(r.acao).toBe('liquidado');
    expect(r.campos).toContain('liquidacao.escrowReleaseTimeUs');
  });

  it('31. `ignorado-sem-mudanca` com um RELÓGIO DIFERENTE — `liquidadoEmUs` não é comparado', async () => {
    // ⚠️ Com o MESMO `nowUs` este teste passaria mesmo se `liquidadoEmUs`
    // entrasse na comparação. O segundo relógio é o que o torna verdadeiro: o
    // campo é `nowUs`, e comparar `nowUs` tornaria o ramo "sem mudança"
    // INALCANÇÁVEL — uma linha de `historicoDeModificacoes` por conta por
    // semana, para sempre.
    const db = new FakeDb();
    db.seed(
      PAGAMENTO_PATH,
      pagamentoDaTarefa({
        liquidacao: {
          payoutAmount: PAYOUT,
          escrowReleaseTimeUs: RELEASE_US,
          liquidadoEmUs: AGORA_US,
          fonte: LIQUIDACAO_FONTE.escrowList,
        },
      }),
    );

    const r = await liquidar(db, { nowMs: OUTRO_AGORA_MS });

    expect(r.acao).toBe('ignorado-sem-mudanca');
    expect(r.campos).toEqual([]);
    // ZERO escritas — nem `ultimaModificacao`.
    expect(db.writes).toEqual([]);
    expect(db.opLog.map((o) => o.op)).toEqual(['get']);
    expect(doc(db).ultimaModificacao).toBe(AGORA_US);
  });
});

/* ========================================================================== */
/*  31b · o clamp                                                             */
/* ========================================================================== */

describe('liquidarPagamentoShopee — tarifas nunca negativas', () => {
  it('31b. um crédito líquido vira `tarifas: 0` e o bruto NEGATIVO fica no diário', async () => {
    // `pagamentoSchema.tarifas` é `.min(0)`, então um bruto negativo sem clamp
    // é um ZodError DENTRO da transação — que a varredura não contém e que
    // derrubaria a conta inteira (#794). O número não se perde: `tarifasBrutas`
    // o guarda, e negativo ali quer dizer "a Shopee creditou o vendedor".
    const db = new FakeDb();
    db.seed(PAGAMENTO_PATH, pagamentoDaTarefa({ tarifas: 1.29 }));
    const escrow = escrowSintetico({
      commission_fee: -0.5,
      service_fee: 0,
      seller_transaction_fee: 0,
    });

    const r = await liquidar(db, { escrow });

    expect(r.acao).toBe('liquidado');
    expect(doc(db).tarifas).toBe(0);
    expect((doc(db).marketplace as Record<string, unknown>).tarifasBrutas).toBe(-0.5);
  });

  it('31c. ⚠️ NEAR-MISS: um escrow SEM `order_income` omite `tarifas` e `marketplace`', async () => {
    // `undefined` ⇒ a chave é OMITIDA, nunca escrita como `null`: `update`
    // mascara na chave de topo, então um `null` apagaria uma tarifa que uma
    // entrega mais rica já aprendeu.
    const db = new FakeDb();
    db.seed(PAGAMENTO_PATH, pagamentoDaTarefa());
    const vazio = shopeeEscrowDetailPayloadSchema.parse({ order_sn: ORDER_SN });

    const r = await liquidar(db, { escrow: vazio });

    expect(r.acao).toBe('liquidado');
    expect(r.campos).toEqual([
      'liquidacao.payoutAmount',
      'liquidacao.escrowReleaseTimeUs',
      'liquidacao.fonte',
    ]);
    expect(doc(db).tarifas).toBe(1.29);
    expect((doc(db).marketplace as Record<string, unknown>).escrowAmount).toBe(30.7);
    const patch = db.patches.at(-1)!.patch;
    expect(Object.keys(patch).sort()).toEqual(['liquidacao', 'ultimaModificacao']);
  });
});

/* ========================================================================== */
/*  32 · a corrida varredura × tarefa                                          */
/* ========================================================================== */

describe('liquidarPagamentoShopee — varredura CONTRA tarefa no mesmo documento', () => {
  it('32. as duas metades ficam de pé: um abort, dois updates, zero sets', async () => {
    // As duas escritoras mascaram chaves de topo DISJUNTAS — a varredura só
    // `liquidacao`/`marketplace`/`tarifas`, a tarefa só `valor`/`status` — e é
    // exatamente por isso que `liquidacao` é um campo de topo e não um membro de
    // `marketplace`. O motor versiona o DOCUMENTO, então o abort é garantido; o
    // que este teste compra é a prova de que nada se perde no re-run.
    const db = new FakeDb();
    db.seed(PAGAMENTO_PATH, pagamentoDaTarefa({ status_pagamento: STATUS_PAGAMENTO.aprovado }));

    const portao = deferred();
    let segurou = false;
    // ⚠️ A execução segurada é identificada pelo QUE ELA ESCREVE, nunca por
    // `ctx.label` — rótulos seguem a ordem de abertura, que é um artefato de
    // qual cadeia de await chegou primeiro.
    db.occ.beforeCommit = (ctx) => {
      const ehVarredura = ctx.writes.some(
        (w) => (w.data as Record<string, unknown>).liquidacao !== undefined,
      );
      if (!ehVarredura || segurou) return undefined;
      segurou = true;
      return portao.promise;
    };

    const varredura = liquidar(db);
    // A "tarefa": outra transação que lê o MESMO documento e escreve só o que
    // o passo 5 escreve.
    const tarefa = asDb(db).runTransaction(async (tx) => {
      const ref = pagamentoCollection.docRef(asDb(db), { pedidoId: PEDIDO_ID }, PAGAMENTO_ID);
      const snap = await tx.get(ref);
      expect(snap.exists).toBe(true);
      tx.update(
        ref,
        pagamentoCollection.parseMerge({
          status_pagamento: STATUS_PAGAMENTO.em_disputa,
          ultimaModificacao: OUTRO_AGORA_US,
        }),
      );
    });

    await Promise.race([varredura, tarefa]);
    portao.resolve();
    const [r] = await Promise.all([varredura, tarefa]);

    expect(r.acao).toBe('liquidado');
    expect(db.occ.txLog.filter((e) => e.phase === 'abort')).toHaveLength(1);
    expect(db.occ.txLog.filter((e) => e.phase === 'commit')).toHaveLength(2);
    // `opLog` grava no STAGING, então o update descartado do perdedor aparece —
    // três updates encenados, dois commitados.
    expect(db.writes.filter((w) => w.path === PAGAMENTO_PATH)).toHaveLength(2);
    expect(db.opLog.filter((o) => o.op === 'set')).toHaveLength(0);
    expect(db.opLog.filter((o) => o.op === 'create')).toHaveLength(0);

    // AS DUAS METADES DE PÉ — a asserção que ganha o teste.
    const d = doc(db);
    expect((d.liquidacao as Record<string, unknown>).escrowReleaseTimeUs).toBe(RELEASE_US);
    expect(d.status_pagamento).toBe(STATUS_PAGAMENTO.em_disputa);
    expect(d.valor).toBe(31.99);
  });
});
