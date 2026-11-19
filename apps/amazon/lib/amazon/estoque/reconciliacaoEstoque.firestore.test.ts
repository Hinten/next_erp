/**
 * The daily stock reconcile on a REAL Firestore — the emulator of
 * `ci-amazon.yml`, not the in-memory fake (step 12, PR 12-f). The offline suite
 * drives every branch against `testing/fakeDb.ts`; this file runs Start and the
 * pages IN-PROCESS on the real server and proves what only holds if the server
 * behaves as the fake says:
 *
 *  - ★ the walk's SHAPE on the server: a collection-group `==` on ONE conta ref
 *    form, ordered by `__name__`, projected to the SKU, resumed after a document
 *    REFERENCE built by the link handle from a stored path (even a path whose
 *    document no longer exists) — and another conta's links never walked;
 *  - ★ a whole run: both ref forms walked, a cursor carried across pages,
 *    every link counted once, the drift stored in a block, the decide's patch
 *    task, and the run's first read stored as a real `Timestamp` that clocks
 *    every aviso of its close;
 *  - ★ the run check under the server's own preconditions: a request written while
 *    a run walks lands on the REQUEST document and never breaks the page's
 *    update, and the close starts the next run; a run stuck in `decidindo` more
 *    than 2 h is reclaimed by the next Start (NEAR-MISS: 1 h 59 min ⇒ re-kicked,
 *    never reclaimed).
 *
 * ⚠️ The emulator does NOT enforce indexes: a pass here proves the walk's shape
 * and results, never its cost on Enterprise — the index pin is the cost guard
 * (`packages/schemas/src/estoqueAmazon.indexes.test.ts`).
 *
 * ⚠️ D11. The read switch is ON in exactly one place: the object literal handed
 * to the page as `ambiente`, never `process.env` (the lane sets it `off`; the
 * case asserts it). Amazon is a scripted `fetch` serving the search and the
 * listing read of this file's SKUs only and REFUSING anything else (an LWA
 * exchange included: the credential is far from expiry). Both producers are
 * the REAL ones over RECORDING queues: nothing is enqueued onto a queue the
 * lane dispatches.
 *
 * ⚠️ The emulator is SHARED (`vitest.tasks.config.ts`'s rules): every document
 * id, the conta and the depósito start with `e2e-estoque-reconciliacao-`,
 * which no other suite seeds (the walk is filtered on this file's conta); the
 * conta is INCOMPLETE (no filial, no `dataCadastro`), so the conta trigger only
 * reads; no `nfev4` is written. Every case wipes what it seeds first, and the
 * file leaves nothing behind.
 */
import { FieldValue, type Firestore, type Timestamp } from 'firebase-admin/firestore';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { produtoAmazonLinkCollection } from '@delfrance/data/admin/collections';
import { CAMINHO_LISTINGS, MARKETPLACE_ID_BR } from '@delfrance/integrations-amazon-sp-api';
import {
  INTEGRACAO_TIPO,
  MOTIVO_CONTA_AMAZON,
  makeEstoqueUid,
  motivoContaAmazonSchema,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { chaveContaPrecisaAtencao, relogioDoDocumentoUs } from '../avisos/avisos';
import type { AmbienteAmazon } from '../env';
import { type FilaLotesAmazon, criarAgendadorLotesAmazon } from '../feeds/agendadorLotes';
import type { TarefaLoteAmazon, TarefaPaginaReconciliacaoAmazon } from '../feeds/tarefaLote';
import { falhaDeTarefaJaExistente } from '../testing/falhaDeEnfileiramento';
import {
  AMBIENTE_LIGADO,
  DIA_MS,
  HORA_MS,
  SPID_A,
  caminhoConta,
  caminhoCredencial,
  credencialDoc,
  loggerEspiao,
  respostaJson,
} from '../testing/fixtures';
import { type FilaEstoqueAmazon, criarProdutorEstoqueAmazon } from './produtorEstoque';
import {
  type DepsPaginaReconciliacaoEstoqueAmazon,
  iniciarReconciliacaoEstoqueAmazon,
  processarPaginaReconciliacaoEstoqueAmazon,
  solicitarReconciliacaoEstoqueAmazon,
} from './reconciliacaoEstoque';
import type { TarefaEstoqueAmazon } from './tarefaEstoque';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const P = 'e2e-estoque-reconciliacao-';
/** The conta of this file — an id no other suite seeds. */
const CONTA = `${P}conta`;
const REF_CONTA = `documents/integracao/${CONTA}`;
const REF_CONTA_NUA = `integracao/${CONTA}`;
const DEP = `${P}dep`;
const REF_DEP = `documents/depositos/${DEP}`;
const RUN = `reconciliacaoEstoqueAmazon/${CONTA}`;
const PEDIDO = `pedidoReconciliacaoEstoqueAmazon/${CONTA}`;
const CAMINHO_BUSCA = `${CAMINHO_LISTINGS}/${SPID_A}`;
const SKU_DRIFT = `${P}SKU-DRIFT`;
const SKU_OK = `${P}SKU-OK`;

/** The ONE place the switch is on: an object literal (module header). */
const AMBIENTE: AmbienteAmazon = Object.freeze({
  ...AMBIENTE_LIGADO,
  AMAZON_CHAMADAS: 'on',
  AMAZON_MODO_ESTOQUE: 'on',
  AMAZON_CANARIO_ESTOQUE: '*',
});

function db(): Firestore {
  return getAdminFirestore();
}

const AVISOS = motivoContaAmazonSchema.options.map(
  (m) => `avisos/${chaveContaPrecisaAtencao(CONTA, m)}`,
);

/** Every produto this file may seed: the two real ones, the other conta's, the fillers. */
const PRODUTOS = [
  `${P}p-drift`,
  `${P}p-ok`,
  `${P}p-outra`,
  ...Array.from({ length: 305 }, (_v, i) => `${P}f${String(i).padStart(4, '0')}`),
];

async function limpar(): Promise<void> {
  for (const id of PRODUTOS) await db().recursiveDelete(db().doc(`produtos/${id}`));
  await db().recursiveDelete(db().doc(RUN));
  await Promise.all(
    [PEDIDO, caminhoConta(CONTA), caminhoCredencial(CONTA), ...AVISOS].map((c) =>
      db().doc(c).delete(),
    ),
  );
}

/** The conta (INCOMPLETE), its credential, one drifted SKU (canonical form) and one in sync (bare form). */
async function semear(): Promise<void> {
  await db().doc(caminhoConta(CONTA)).set({
    tipo: INTEGRACAO_TIPO.amazon,
    nome: 'Conta de teste da reconciliação de estoque',
    ativo: true,
    padrao: false,
    selling_partner_id: SPID_A,
    depositoOuterRef: REF_DEP,
  });
  await db()
    .doc(caminhoCredencial(CONTA))
    .set(credencialDoc({ expirationDate: Date.now() + 365 * DIA_MS }));
  await produto('p-drift', SKU_DRIFT, REF_CONTA, 4);
  await produto('p-ok', SKU_OK, REF_CONTA_NUA, 2);
  // Another conta's link: never walked.
  await db().doc(`produtos/${P}p-outra`).set({ nome: 'Outra' });
  await db()
    .doc(`produtos/${P}p-outra/prodAmazon/l1`)
    .set({ contaAmazonOuterRef: `documents/integracao/${P}outra`, sku: `${P}SKU-OUTRA` });
}

async function produto(id: string, sku: string, refConta: string, erp: number): Promise<void> {
  await db()
    .doc(`produtos/${P}${id}`)
    .set({ nome: `Produto ${id}`, precos: { varejo: 10 } });
  await db()
    .doc(`produtos/${P}${id}/prodAmazon/l1`)
    .set({ contaAmazonOuterRef: refConta, sku, productDataJson: { pesado: 'x'.repeat(256) } });
  await db()
    .doc(`produtos/${P}${id}/estoques/${makeEstoqueUid(`${P}${id}`, DEP)}`)
    .set({
      depositoOuterRef: REF_DEP,
      parentId: `${P}${id}`,
      quantidade: erp,
      quantidadeReservada: 0,
    });
}

/** `n` links of this conta under produtos that do not exist (refused, never read on Amazon). */
async function fantasmas(n: number): Promise<void> {
  const lote = db().batch();
  for (let i = 0; i < n; i += 1) {
    lote.set(db().doc(`produtos/${P}f${String(i).padStart(4, '0')}/prodAmazon/l1`), {
      contaAmazonOuterRef: REF_CONTA,
      sku: `${P}SKU-F-${String(i)}`,
    });
  }
  await lote.commit();
}

const listing = (sku: string, quantidade: number) => ({
  sku,
  summaries: [{ marketplaceId: MARKETPLACE_ID_BR, productType: 'PRODUCT', status: ['BUYABLE'] }],
  fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: quantidade }],
  relationships: [{ marketplaceId: MARKETPLACE_ID_BR, relationships: [] }],
});

/** What Amazon shows: the drifted SKU at 1 (the ERP holds 4), the other in sync. */
const AMAZON = new Map<string, ReturnType<typeof listing>>([
  [SKU_DRIFT, listing(SKU_DRIFT, 1)],
  [SKU_OK, listing(SKU_OK, 2)],
]);

/** One world: the real producers over recording queues, a scripted Amazon. */
function mundo() {
  const lotes: { tarefa: TarefaLoteAmazon; nome: string | null; atrasoS: number }[] = [];
  const patches: { tarefa: TarefaEstoqueAmazon; nome: string | null; atrasoS: number }[] = [];
  const ids = new Set<string>();
  const despachadas = new Set<number>();
  let deslocamento = 0;
  const log = loggerEspiao();
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    const url = new URL(String(input));
    const metodo = init?.method ?? 'GET';
    if (metodo === 'GET' && url.pathname === CAMINHO_BUSCA) {
      const pedidos = (url.searchParams.get('identifiers') ?? '').split(',');
      const items = pedidos.filter((s) => AMAZON.has(s)).map((s) => AMAZON.get(s));
      return Promise.resolve(respostaJson(200, { numberOfResults: items.length, items }));
    }
    if (metodo === 'GET' && url.pathname.startsWith(`${CAMINHO_BUSCA}/`)) {
      const sku = decodeURIComponent(url.pathname.slice(CAMINHO_BUSCA.length + 1));
      const corpo = AMAZON.get(sku);
      return Promise.resolve(
        corpo === undefined
          ? respostaJson(404, { errors: [{ code: 'NOT_FOUND' }] })
          : respostaJson(200, corpo),
      );
    }
    return Promise.reject(new TypeError(`sem rede: ${metodo} ${url.pathname} não roteirizado`));
  });
  const enfileirar =
    <T>(destino: { tarefa: T; nome: string | null; atrasoS: number }[]) =>
    (tarefa: T, opcoes?: { id?: string; scheduleDelaySeconds?: number }) => {
      const id = opcoes?.id;
      if (id !== undefined) {
        if (ids.has(id)) return Promise.reject(falhaDeTarefaJaExistente(id));
        ids.add(id);
      }
      destino.push({ tarefa, nome: id ?? null, atrasoS: opcoes?.scheduleDelaySeconds ?? 0 });
      return Promise.resolve();
    };
  let execucoes = 0;
  const deps: DepsPaginaReconciliacaoEstoqueAmazon = {
    ambiente: AMBIENTE,
    agora: () => Date.now() + deslocamento,
    logger: log.logger,
    increment: (by) => FieldValue.increment(by),
    agendador: () =>
      criarAgendadorLotesAmazon({
        desligado: false,
        fila: (): FilaLotesAmazon => ({ enqueue: enfileirar(lotes) }),
      }),
    produtorEstoque: () =>
      criarProdutorEstoqueAmazon({
        desligado: false,
        fila: (): FilaEstoqueAmazon => ({ enqueue: enfileirar(patches) }),
      }),
    gerarExecucaoId: () => {
      execucoes += 1;
      return `${P}exec-${String(execucoes)}-${String(Date.now())}`;
    },
    registro: { tentativa: 0, idTarefa: `${P}tarefa` },
    fetch,
    gerarCorrelationId: () => `${P}corr`,
    esperar: (ms) => {
      deslocamento += ms;
      return Promise.resolve();
    },
  };
  const paginas = () =>
    lotes.flatMap((x, i) =>
      x.tarefa.tipo === 'reconciliacao'
        ? [{ i, t: x.tarefa as TarefaPaginaReconciliacaoAmazon }]
        : [],
    );
  return {
    lotes,
    patches,
    deps,
    fetch,
    paginas,
    avancar: (ms: number) => {
      deslocamento += ms;
    },
    iniciar: () => iniciarReconciliacaoEstoqueAmazon(db(), CONTA, deps),
    drenar: async (quantas = 20) => {
      const saidas = [];
      for (let n = 0; n < quantas; n += 1) {
        const proxima = paginas().find((p) => !despachadas.has(p.i));
        if (proxima === undefined) break;
        despachadas.add(proxima.i);
        saidas.push(await processarPaginaReconciliacaoEstoqueAmazon(db(), proxima.t, deps));
      }
      return saidas;
    },
  };
}

async function lerRun(): Promise<Record<string, unknown>> {
  return (await db().doc(RUN).get()).data() ?? {};
}

describe.skipIf(!EMULATED)('the daily stock reconcile on real Firestore (emulator)', () => {
  beforeEach(async () => {
    expect(process.env.AMAZON_CHAMADAS).not.toBe('on');
    __resetAllReadCaches();
    await limpar();
    await semear();
  });

  afterAll(async () => {
    await limpar();
  });

  it('★ the walk’s shape on the server: ONE == per form, key order, the SKU alone, resumed after a handle reference (even to a doc that is gone)', async () => {
    await produto('p-drift', `${P}SKU-SEGUNDO`, REF_CONTA, 1);
    const base = () =>
      produtoAmazonLinkCollection
        .groupQuery(db())
        .where('contaAmazonOuterRef', '==', REF_CONTA)
        .orderBy('__name__')
        .select('sku');
    const tudo = await base().get();
    expect(tudo.docs.map((d) => d.ref.path)).toEqual([`produtos/${P}p-drift/prodAmazon/l1`]);
    expect(tudo.docs.map((d) => Object.keys(d.data()))).toEqual([['sku']]);
    // Two links under one produto, then resume after the first by REFERENCE.
    await db()
      .doc(`produtos/${P}p-drift/prodAmazon/l2`)
      .set({ contaAmazonOuterRef: REF_CONTA, sku: `${P}SKU-L2`, productDataJson: { x: 1 } });
    const ref = (linkId: string) =>
      produtoAmazonLinkCollection.docRef(db(), { produtoId: `${P}p-drift` }, linkId);
    const depois = await base().startAfter(ref('l1')).limit(5).get();
    expect(depois.docs.map((d) => d.ref.path)).toEqual([`produtos/${P}p-drift/prodAmazon/l2`]);
    // A reference to a document that does not exist still seeks by its KEY.
    const aposSumido = await base().startAfter(ref('l15')).limit(5).get();
    expect(aposSumido.docs.map((d) => d.ref.path)).toEqual([`produtos/${P}p-drift/prodAmazon/l2`]);
    // The bare form is its own query.
    const nua = await produtoAmazonLinkCollection
      .groupQuery(db())
      .where('contaAmazonOuterRef', '==', REF_CONTA_NUA)
      .orderBy('__name__')
      .select('sku')
      .get();
    expect(nua.docs.map((d) => d.data())).toEqual([{ sku: SKU_OK }]);
  });

  it('★ a whole run on the server: both forms, the drift in a block, ONE patch task, relogioInicio a real Timestamp clocking the close’s avisos', async () => {
    const m = mundo();
    expect(await m.iniciar()).toMatchObject({ acao: 'iniciada' });
    const saidas = await m.drenar();
    expect(saidas.map((s) => s.acao)).toEqual(['concluida']);
    const run = await lerRun();
    expect(run).toMatchObject({
      fase: 'concluida',
      paginas: 1,
      depositoOuterRef: REF_DEP,
      contagens: expect.objectContaining({
        vinculosLidos: 2,
        skusAvaliados: 2,
        enviaveis: 2,
        divergencias: 1,
      }) as unknown,
    });
    const relogio = run.relogioInicio as Timestamp;
    expect(typeof relogio.toMillis).toBe('function');
    const blocos = await db().collection(`${RUN}/divergenciasEstoqueAmazon`).get();
    expect(blocos.docs.map((d) => (d.data().itens as { sku: string }[]).map((i) => i.sku))).toEqual(
      [[SKU_DRIFT]],
    );
    expect(m.patches).toHaveLength(1);
    expect(m.patches[0]).toMatchObject({
      atrasoS: 1_200,
      tarefa: { sku: SKU_DRIFT, origem: 'reconciliacao', depositoId: DEP },
    });
    const aviso = (
      await db()
        .doc(
          `avisos/${chaveContaPrecisaAtencao(CONTA, MOTIVO_CONTA_AMAZON.estoqueVinculosRecusados)}`,
        )
        .get()
    ).data();
    expect(aviso?.resolvidoEm).not.toBeNull();
    expect(aviso?.relogioEvento).toBe(relogioDoDocumentoUs(relogio));
  });

  it('★ a cursor carried across dispatches: 305 more links ⇒ two pages, every link counted once', async () => {
    await fantasmas(305);
    const m = mundo();
    await m.iniciar();
    const saidas = await m.drenar();
    expect(saidas.map((s) => s.acao)).toEqual(['pagina-concluida', 'concluida']);
    const run = await lerRun();
    expect(run).toMatchObject({ paginas: 2, fase: 'concluida' });
    expect((run.contagens as Record<string, unknown>).vinculosLidos).toBe(307);
    expect(run.cursores).toMatchObject({ canonica: { concluida: true }, nua: { concluida: true } });
  });

  it('★ a request written while a run walks lands on the REQUEST doc, the page’s update still lands, and the close starts the next run', async () => {
    const m = mundo();
    await m.iniciar();
    const r = await solicitarReconciliacaoEstoqueAmazon(db(), CONTA, 'tick', m.deps);
    expect(r).toMatchObject({ acao: 'pedido', inicio: { acao: 'em-execucao' } });
    expect((await db().doc(PEDIDO).get()).data()).toMatchObject({ pendente: true });
    expect(await lerRun()).not.toHaveProperty('pendente');
    const [saida] = await m.drenar(1);
    expect(saida).toMatchObject({ acao: 'concluida', proximo: 'iniciada' });
    expect((await db().doc(PEDIDO).get()).data()).toMatchObject({ pendente: false });
    expect(await lerRun()).toMatchObject({ fase: 'varrendo', proximaPagina: 0 });
  });

  it('★ a run stuck in decidindo more than 2 h is RECLAIMED by the next Start (NEAR-MISS: 1 h 59 min ⇒ re-kicked, never reclaimed)', async () => {
    const m = mundo();
    const parado = (progressoEmMs: number) => ({
      execucaoId: `${P}parado`,
      fase: 'decidindo',
      depositoOuterRef: REF_DEP,
      proximaPagina: 3,
      paginas: 3,
      progressoEmMs,
      iniciadaEmMs: progressoEmMs,
    });
    await db()
      .doc(RUN)
      .set(parado(Date.now() - (2 * HORA_MS - 60_000)));
    expect(await m.iniciar()).toMatchObject({
      acao: 'retomada',
      execucaoId: `${P}parado`,
      pagina: 3,
    });
    expect((await lerRun()).execucaoId).toBe(`${P}parado`);
    await db()
      .doc(RUN)
      .set(parado(Date.now() - (2 * HORA_MS + 1)));
    expect(await m.iniciar()).toMatchObject({ acao: 'iniciada' });
    const run = await lerRun();
    expect(run.execucaoId).not.toBe(`${P}parado`);
    expect(run).toMatchObject({ fase: 'varrendo', proximaPagina: 0, paginas: 0 });
  });
});
