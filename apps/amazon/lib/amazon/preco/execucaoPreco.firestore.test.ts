/**
 * A price run's PAGE and its Decide on a REAL Firestore — the emulator of
 * `ci-amazon.yml`, not the in-memory fake (step 13, PR 13-e). The offline
 * suite drives every branch against `testing/fakeDb.ts`; this file runs the
 * claim, a page and Decide IN-PROCESS on the real server and proves what only
 * holds if the server behaves as the fake says:
 *
 *  - ★ one run, end to end: the walk (the collection-group `==` ordered by key)
 *    finds exactly this conta's link docs, the part lands with its TTL stamp a
 *    server `Timestamp` seven days out, the run ends `concluida` with its
 *    counts, its cursors and `relogioInicio` a `Timestamp`, and Decide's task
 *    carries its part;
 *  - ★ step 0's read is projected BY THE SERVER to the page's fields alone;
 *  - ★ a cancel landing between step 0's read and the page's run update fails
 *    that update's precondition on the server: the cancel stands, the run is
 *    not advanced (the part, written before the update, is there to be
 *    overwritten by a re-run of the same page);
 *  - ★ a 429 stamps the run's progress on the server and pauses the SAME page,
 *    unnamed;
 *  - ★ (PR 13-f) a `lotes` Decide lands its batch ledger and wait on the server
 *    BEFORE it names any batch, and a retried Decide names the same batches.
 *
 * The concurrent writer is injected by spying on the database's own `getAll`
 * (the real call runs; the competing write lands right after the run's read).
 *
 * ⚠️ D11. The read switch is ON in exactly one place: the object literal handed
 * to the page as `ambiente`. Never through `process.env` (the lane sets it
 * `off`; each case asserts it). Amazon is a scripted `fetch` serving the search
 * of this conta's SKUs only, REFUSING anything else (an LWA exchange included:
 * the credential is far from expiry). Both producers are RECORDERS: nothing is
 * enqueued onto a queue the lane dispatches.
 *
 * ⚠️ The emulator is SHARED (`vitest.tasks.config.ts`'s rules): every document
 * id here starts with `e2e-preco-pagina-`, which no other suite seeds; the
 * conta is INCOMPLETE (no filial, no `dataCadastro`), so the conta trigger only
 * reads; no `nfev4` is written. Every case wipes what it reads first, and the
 * file leaves nothing behind. PLACEHOLDERS ONLY (public repository).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { CAMINHO_LISTINGS, MARKETPLACE_ID_BR } from '@delfrance/integrations-amazon-sp-api';
import {
  type FaixaPrecoAmazon,
  INTEGRACAO_TIPO,
  MOTIVO_CONTA_AMAZON,
  RETENCAO_DIVERGENCIA_PRECO_AMAZON_DIAS,
  TIPO_OFERTA_PRECO_AMAZON,
  idDivergenciaPrecoAmazon,
  motivoContaAmazonSchema,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { chaveContaPrecisaAtencao } from '../avisos/avisos';
import { loadAmazonContext } from '../core/contexto';
import type { AmbienteAmazon } from '../env';
import { criarAgendadorLotesAmazon } from '../feeds/agendadorLotes';
import {
  type TarefaLoteAmazon,
  execucaoIdDoLoteBlocosFeed,
  nomeEnvioFeed,
} from '../feeds/tarefaLote';
import { falhaDeTarefaJaExistente } from '../testing/falhaDeEnfileiramento';
import {
  AMBIENTE_LIGADO,
  DIA_MS,
  SPID_A,
  caminhoConta,
  caminhoCredencial,
  credencialDoc,
  loggerEspiao,
} from '../testing/fixtures';
import { gravarParteDivergenciaPrecoAmazon } from './divergenciasPrecoFirestore';
import {
  ACAO_PAGINA_PRECO_AMAZON,
  CAMPOS_PAGINA_EXECUCAO_PRECO_AMAZON,
  ESPERA_LOTE_BLOCOS_PRECO_MS,
  paginaPrecoAmazon,
} from './execucaoPreco';
import {
  ATRASO_PAUSA_PAGINA_PRECO_S,
  criarProdutorExecucaoPrecoAmazon,
  iniciarExecucaoPrecoAmazon,
} from './inicioExecucaoPreco';
import { criarProdutorPrecoAmazon } from './produtorPreco';
import type { TarefaPaginaPrecoAmazon, TarefaPrecoSkuAmazon } from './tarefaPreco';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const P = 'e2e-preco-pagina-';
/** The conta of this file — an id no other suite seeds. */
const CONTA = `${P}conta`;
const NORMAL = `${P}tab-normal`;
const RUN = `precosAmazon/${CONTA}`;
const CAMINHO_BUSCA = `${CAMINHO_LISTINGS}/${SPID_A}`;
/** The produtos this file seeds, each one SKU linked to the conta. */
const PRODUTOS = [`${P}prod-1`, `${P}prod-2`];
const SKU = (i: number) => `${P}SKU-${String(i + 1)}`;

/** The ONE place the switch is on: an object literal (module header). */
const AMBIENTE_LIGADO_NO_PROCESSO: AmbienteAmazon = Object.freeze({
  ...AMBIENTE_LIGADO,
  AMAZON_CHAMADAS: 'on',
  AMAZON_MODO_PRECO: 'on',
  AMAZON_CANARIO_PRECO: '*',
});

function db(): Firestore {
  return getAdminFirestore();
}

const AVISOS = motivoContaAmazonSchema.options.map(
  (m) => `avisos/${chaveContaPrecisaAtencao(CONTA, m)}`,
);

/** Everything this file writes, deleted (subcollections included). */
async function limpar(): Promise<void> {
  for (const p of PRODUTOS) await db().recursiveDelete(db().doc(`produtos/${p}`));
  await db().recursiveDelete(db().doc(RUN));
  await Promise.all(
    [caminhoCredencial(CONTA), caminhoConta(CONTA), ...AVISOS].map((c) => db().doc(c).delete()),
  );
}

/**
 * An INCOMPLETE conta naming its normal tabela, a fresh credential, and one
 * simple produto per SKU priced 60, linked to the conta (Amazon holds 50).
 */
async function semear(): Promise<void> {
  await db()
    .doc(caminhoConta(CONTA))
    .set({
      tipo: INTEGRACAO_TIPO.amazon,
      nome: 'Conta de teste da página de preço',
      ativo: true,
      padrao: false,
      selling_partner_id: SPID_A,
      tabelaNormalOuterRef: `documents/listaDePrecos/${NORMAL}`,
      tabelaPromocionalOuterRef: null,
    });
  await db()
    .doc(caminhoCredencial(CONTA))
    .set(credencialDoc({ expirationDate: Date.now() + 365 * DIA_MS }));
  for (const [i, p] of PRODUTOS.entries()) {
    await db()
      .doc(`produtos/${p}`)
      .set({ nome: `Produto ${String(i)}`, precos: { [NORMAL]: { valor: 60 } } });
    await db()
      .doc(`produtos/${p}/prodAmazon/${P}link`)
      .set({
        contaAmazonOuterRef: `documents/integracao/${CONTA}`,
        sku: SKU(i),
        productDataJson: { pesado: 'x'.repeat(64) },
      });
  }
}

/** Our offer element in the documented write shape (synthetic prices). */
function elemento(o: FaixaPrecoAmazon): Record<string, unknown> {
  return {
    marketplace_id: MARKETPLACE_ID_BR,
    currency: 'BRL',
    audience: 'ALL',
    our_price: [{ schedule: [{ value_with_tax: o.base }] }],
    minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: o.minimo }] }],
    maximum_seller_allowed_price: [{ schedule: [{ value_with_tax: o.maximo }] }],
  };
}

/** A scripted fetch: this conta's search only, a 429 when asked; everything else refused. */
function fetchRoteirizado(o: { readonly limitar?: boolean } = {}) {
  const buscas: string[][] = [];
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    const url = new URL(String(input));
    const metodo = init?.method ?? 'GET';
    if (url.pathname !== CAMINHO_BUSCA || metodo !== 'GET') {
      return Promise.reject(new TypeError(`sem rede: ${metodo} ${url.pathname} não roteirizado`));
    }
    const pedidos = (url.searchParams.get('identifiers') ?? '').split(',');
    buscas.push(pedidos);
    if (o.limitar === true) {
      return Promise.resolve(
        new Response(JSON.stringify({ errors: [{ code: 'QuotaExceeded' }] }), { status: 429 }),
      );
    }
    const items = pedidos.map((sku) => ({
      sku,
      summaries: [
        {
          marketplaceId: MARKETPLACE_ID_BR,
          asin: 'B0PAGINA001',
          productType: 'LUGGAGE',
          status: ['BUYABLE'],
        },
      ],
      attributes: { purchasable_offer: [elemento({ base: 50, minimo: 50, maximo: 50 })] },
      issues: [],
      relationships: [{ marketplaceId: MARKETPLACE_ID_BR, relationships: [] }],
    }));
    return Promise.resolve(
      new Response(JSON.stringify({ numberOfResults: items.length, items }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return { fetch, buscas };
}

/**
 * The three recorders: the run's pages, Decide's tasks and (PR 13-f) Decide's
 * block batches — each batch with the run as the SERVER held it at that
 * enqueue (nothing reaches a real queue).
 */
function produtores() {
  const paginas: { readonly tarefa: TarefaPaginaPrecoAmazon; readonly opcoes: unknown }[] = [];
  const tarefas: { readonly tarefa: TarefaPrecoSkuAmazon; readonly opcoes: unknown }[] = [];
  const lotes: {
    readonly tarefa: TarefaLoteAmazon;
    readonly opcoes: unknown;
    readonly run: Record<string, unknown> | undefined;
  }[] = [];
  const nomesLotes = new Set<string>();
  const agendadorLotes = criarAgendadorLotesAmazon({
    desligado: false,
    fila: () => ({
      enqueue: async (tarefa, opcoes) => {
        const id = opcoes?.id;
        if (id !== undefined && nomesLotes.has(id)) throw falhaDeTarefaJaExistente(id);
        if (id !== undefined) nomesLotes.add(id);
        lotes.push({ tarefa, opcoes, run: (await db().doc(RUN).get()).data() });
      },
    }),
  });
  const produtorPaginas = criarProdutorExecucaoPrecoAmazon({
    desligado: false,
    fila: () => ({
      enqueue: (tarefa, opcoes) => {
        paginas.push({ tarefa, opcoes });
        return Promise.resolve();
      },
    }),
  });
  const produtorPreco = criarProdutorPrecoAmazon({
    desligado: false,
    fila: () => ({
      enqueue: (tarefa, opcoes) => {
        tarefas.push({ tarefa, opcoes });
        return Promise.resolve();
      },
    }),
  });
  return { paginas, tarefas, lotes, produtorPaginas, produtorPreco, agendadorLotes };
}

/** The claim, in-process (its page 0 recorded, never enqueued). */
async function iniciar(p: ReturnType<typeof produtores>): Promise<string> {
  const r = await iniciarExecucaoPrecoAmazon(
    db(),
    CONTA,
    { baixarPreco: false, confirmarReducaoEmMassa: false, solicitadaPor: `${P}uid` },
    {
      filaDesligada: false,
      produtor: () => p.produtorPaginas,
      agora: () => Date.now(),
      gerarExecucaoId: () => `${P}exec`,
      logger: loggerEspiao().logger,
    },
  );
  if (!r.ok) throw new Error(`teste: a reivindicação falhou (${r.codigo})`);
  return r.corpo.execucaoId;
}

/** One page dispatch, in-process: the switch on as a literal, Amazon scripted, the queues recorders. */
function pagina(
  t: TarefaPaginaPrecoAmazon,
  p: ReturnType<typeof produtores>,
  fetch: typeof globalThis.fetch,
) {
  expect(process.env.AMAZON_CHAMADAS).not.toBe('on');
  return paginaPrecoAmazon(db(), t, {
    ambiente: AMBIENTE_LIGADO_NO_PROCESSO,
    agora: () => Date.now(),
    logger: loggerEspiao().logger,
    increment: (by) => FieldValue.increment(by),
    registro: { tentativa: 0, idTarefa: 'tarefa-pagina-ci' },
    fetch,
    gerarCorrelationId: () => 'corr-pagina-ci',
    carregarContexto: loadAmazonContext,
    produtorPaginas: () => p.produtorPaginas,
    produtorPreco: () => p.produtorPreco,
    agendadorLotes: () => p.agendadorLotes,
    soValidacao: false,
    esperar: () => Promise.resolve(),
  });
}

const paginaZero = (execucaoId: string): TarefaPaginaPrecoAmazon => ({
  v: 1,
  tipo: 'preco-pagina',
  contaId: CONTA,
  execucaoId,
  pagina: 0,
});

describe.skipIf(!EMULATED)('a price run’s page on real Firestore (emulator)', () => {
  beforeEach(async () => {
    __resetAllReadCaches();
    await limpar();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    __resetAllReadCaches();
    await limpar();
  });

  it('★ one run end to end on the server: the walk finds this conta’s links, the part lands with a Timestamp TTL, Decide hands each SKU to a task with its part, concluida last', async () => {
    await semear();
    const p = produtores();
    const execucaoId = await iniciar(p);
    expect(p.paginas.map((x) => x.tarefa)).toEqual([paginaZero(execucaoId)]);
    const { fetch, buscas } = fetchRoteirizado();
    const antes = Date.now();
    const r = await pagina(paginaZero(execucaoId), p, fetch);
    expect(r.acao).toBe(ACAO_PAGINA_PRECO_AMAZON.concluida);
    expect(buscas).toEqual([[SKU(0), SKU(1)]]);
    const parte = (
      await db()
        .doc(`${RUN}/divergenciasPrecoAmazon/${idDivergenciaPrecoAmazon(execucaoId, 0)}`)
        .get()
    ).data();
    expect(parte?.execucaoId).toBe(execucaoId);
    expect((parte?.itens as { sku: string }[]).map((i) => i.sku)).toEqual([SKU(0), SKU(1)]);
    expect(parte?.expiraEm).toBeInstanceOf(Timestamp);
    const ttlMs = (parte?.expiraEm as Timestamp).toMillis();
    expect(ttlMs).toBeGreaterThanOrEqual(
      antes + RETENCAO_DIVERGENCIA_PRECO_AMAZON_DIAS * DIA_MS - 1,
    );
    expect(ttlMs).toBeLessThanOrEqual(Date.now() + RETENCAO_DIVERGENCIA_PRECO_AMAZON_DIAS * DIA_MS);
    const run = (await db().doc(RUN).get()).data();
    expect(run).toMatchObject({
      execucaoId,
      fase: 'concluida',
      decisao: 'tarefas',
      proximaPagina: 1,
      proximaParte: 1,
      itensPorParte: [2],
    });
    expect(run?.contagens).toMatchObject({ lidos: 2, enviaveis: 2, sobe: 2 });
    expect(run?.relogioInicio).toBeInstanceOf(Timestamp);
    expect(run?.cursores).toMatchObject({
      canonica: { concluida: true },
      nua: { concluida: true },
    });
    expect(p.tarefas.map((x) => [x.tarefa.sku, x.tarefa.parte, x.tarefa.referencia])).toEqual([
      [SKU(0), 0, execucaoId],
      [SKU(1), 0, execucaoId],
    ]);
    // The run's avisos, on the server, clocked by its first read.
    const faixa = await db()
      .doc(`avisos/${chaveContaPrecisaAtencao(CONTA, MOTIVO_CONTA_AMAZON.precoFaixaInvertida)}`)
      .get();
    expect(faixa.exists).toBe(true);
  });

  it('★ step 0’s read of the run is projected by the SERVER to the page’s fields alone', async () => {
    await semear();
    const p = produtores();
    const execucaoId = await iniciar(p);
    const instancia = db();
    const original = instancia.getAll.bind(instancia);
    const doRun: Record<string, unknown>[] = [];
    vi.spyOn(instancia, 'getAll').mockImplementation(async (...args) => {
      const snaps = await original(...args);
      for (const s of snaps) if (s.ref.path === RUN) doRun.push(s.data() ?? {});
      return snaps;
    });
    const { fetch } = fetchRoteirizado();
    await pagina(paginaZero(execucaoId), p, fetch);
    expect(doRun.length).toBeGreaterThan(0);
    const campos = Object.keys(doRun[0] ?? {});
    for (const c of campos)
      expect(CAMPOS_PAGINA_EXECUCAO_PRECO_AMAZON as readonly string[]).toContain(c);
    // The stored run holds them, the server answered none of them.
    expect(campos).toEqual(
      expect.arrayContaining(['execucaoId', 'fase', 'proximaPagina', 'cursores']),
    );
    const cru = (await db().doc(RUN).get()).data() ?? {};
    expect(Object.keys(cru)).toEqual(expect.arrayContaining(['solicitadaPor', 'iniciadaEmMs']));
    expect(campos).not.toContain('solicitadaPor');
    expect(campos).not.toContain('iniciadaEmMs');
  });

  it('★ a cancel landing after step 0’s read fails the page’s run update ON THE SERVER: the cancel stands, the run not advanced', async () => {
    await semear();
    const p = produtores();
    const execucaoId = await iniciar(p);
    const instancia = db();
    const original = instancia.getAll.bind(instancia);
    let cancelou = false;
    vi.spyOn(instancia, 'getAll').mockImplementation(async (...args) => {
      const snaps = await original(...args);
      if (!cancelou && snaps.some((s) => s.ref.path === RUN)) {
        cancelou = true;
        await instancia.doc(RUN).update({ fase: 'cancelada' });
      }
      return snaps;
    });
    const { fetch } = fetchRoteirizado();
    const r = await pagina(paginaZero(execucaoId), p, fetch);
    expect(cancelou).toBe(true);
    expect(r.acao).toBe(ACAO_PAGINA_PRECO_AMAZON.vezPerdida);
    const run = (await db().doc(RUN).get()).data();
    expect(run).toMatchObject({ fase: 'cancelada', proximaPagina: 0, proximaParte: 0 });
    expect(p.tarefas).toEqual([]);
    expect(p.paginas).toHaveLength(1);
  });

  it('★ a 429 stamps the run’s progress on the server, then pauses the SAME page unnamed', async () => {
    await semear();
    const p = produtores();
    const execucaoId = await iniciar(p);
    const { fetch } = fetchRoteirizado({ limitar: true });
    const antes = Date.now();
    const r = await pagina(paginaZero(execucaoId), p, fetch);
    expect(r.acao).toBe(ACAO_PAGINA_PRECO_AMAZON.limitada);
    const run = (await db().doc(RUN).get()).data();
    expect(run).toMatchObject({ fase: 'paginando', proximaPagina: 0 });
    expect(run?.progressoEmMs as number).toBeGreaterThanOrEqual(antes);
    expect(p.paginas.at(-1)).toEqual({
      tarefa: paginaZero(execucaoId),
      opcoes: { scheduleDelaySeconds: ATRASO_PAUSA_PAGINA_PRECO_S },
    });
    expect((await db().collection(`${RUN}/divergenciasPrecoAmazon`).get()).empty).toBe(true);
  });

  it('★ (13-f) a lotes Decide: the batch ledger and the wait are ON THE SERVER before the first batch is named; a retried Decide names the same batches (each held), the wait unmoved', async () => {
    await semear();
    const execucaoId = `${P}exec-lotes`;
    // 31 parts of one SKU each: past the switch, ONE block batch.
    for (let n = 0; n < 31; n += 1) {
      await gravarParteDivergenciaPrecoAmazon(db(), {
        contaId: CONTA,
        execucaoId,
        parte: n,
        itens: [
          {
            sku: `${P}LOTE-${String(n)}`,
            vinculo: `produtos/${P}prod-lote-${String(n)}/prodAmazon/${P}link`,
            unidadeId: `${P}prod-lote-${String(n)}`,
            oferta: { tipo: TIPO_OFERTA_PRECO_AMAZON.lida, base: 50, minimo: 50, maximo: 50 },
            faixa: { base: 60, minimo: 60, maximo: 60 },
            tipoProduto: 'LUGGAGE',
            lidoEmMs: Date.now(),
          },
        ],
        agoraMs: Date.now(),
      });
    }
    await db()
      .doc(RUN)
      .set({
        execucaoId,
        fase: 'decidindo',
        baixarPreco: false,
        solicitadaPor: `${P}uid`,
        cursores: {
          canonica: { ultimoCaminho: null, concluida: true },
          nua: { ultimoCaminho: null, concluida: true },
        },
        proximaPagina: 4,
        proximaParte: 31,
        itensPorParte: Array.from({ length: 31 }, () => 1),
        contagens: { enviaveis: 31, sobe: 31 },
        iniciadaEmMs: Date.now() - 60_000,
        progressoEmMs: Date.now() - 60_000,
        relogioInicio: null,
      });
    const p = produtores();
    const t: TarefaPaginaPrecoAmazon = {
      v: 1,
      tipo: 'preco-pagina',
      contaId: CONTA,
      execucaoId,
      pagina: 4,
    };
    const { fetch, buscas } = fetchRoteirizado();
    const antes = Date.now();
    const r = await pagina(t, p, fetch);
    expect(r.acao).toBe(ACAO_PAGINA_PRECO_AMAZON.concluida);
    expect(r.decide).toMatchObject({ decisao: 'lotes', lotes: 1, lotesJaEnfileirados: 0 });
    expect(buscas).toEqual([]);
    const loteId = execucaoIdDoLoteBlocosFeed(CONTA, execucaoId, 0);
    expect(p.lotes).toHaveLength(1);
    const [lote] = p.lotes;
    expect(lote?.opcoes).toEqual({ id: nomeEnvioFeed(CONTA, loteId) });
    // At the enqueue the server already held the whole plan.
    expect(lote?.run).toMatchObject({
      fase: 'decidindo',
      decisao: 'lotes',
      lotes: {
        '0': { execucaoIdLote: loteId, parteInicial: 0, partes: 31, itens: 31, desfecho: null },
      },
    });
    const espera = lote?.run?.esperaLotesAteMs as number;
    expect(espera).toBeGreaterThanOrEqual(antes + ESPERA_LOTE_BLOCOS_PRECO_MS);
    expect(espera).toBeLessThanOrEqual(Date.now() + ESPERA_LOTE_BLOCOS_PRECO_MS);
    expect(lote?.tarefa).toMatchObject({
      tipo: 'feed-enviar',
      fluxo: 'preco',
      execucaoId: loteId,
      lote: { tipo: 'blocos', execucaoIdRun: execucaoId, parteInicial: 0, partes: 31 },
    });
    expect(lote?.tarefa.tipo === 'feed-enviar' ? lote.tarefa.lote.esperaAteMs : null).toBe(espera);
    expect((await db().doc(RUN).get()).data()?.fase).toBe('concluida');

    // A retried Decide (the run deciding again): the stored ledger, the same name, held.
    await db().doc(RUN).update({ fase: 'decidindo' });
    const de = await pagina(t, p, fetch);
    expect(de.decide).toMatchObject({ planoGuardado: true, lotes: 1, lotesJaEnfileirados: 1 });
    expect(p.lotes).toHaveLength(1);
    expect((await db().doc(RUN).get()).data()).toMatchObject({
      fase: 'concluida',
      esperaLotesAteMs: espera,
    });
    expect(p.tarefas).toEqual([]);
  });
});
