/**
 * The price task on a REAL Firestore — the emulator of `ci-amazon.yml`, not
 * the in-memory fake (step 13, PR 13-d). The offline suite drives every rung
 * of P0–P11 against `testing/fakeDb.ts`; this file runs the task IN-PROCESS on
 * the real server, and the price binding of the shared write-back
 * (`CAMPO_DO_ENVIO_PRECO_AMAZON`, its two price parameters on) directly, and
 * proves what only holds if the server behaves as the fake says:
 *
 *  - the write-ahead record and the answered outcome change ONLY
 *    `envioPrecoAmazon`: the stored `envioEstoqueAmazon` and the product
 *    payload are byte-equal at the PATCH (read from the server by the scripted
 *    PATCH itself) and after it;
 *  - the masked reads on the server: the unit's ONE `precos.<tabela>` entry per
 *    tabela (two-segment paths; another tabela's entry and the produto's other
 *    fields never come back), the conta's two refs, the price lease's listed
 *    fields (the stock lease never read) and the outcome field alone;
 *  - under the preview flag the PATCH is a `VALIDATION_PREVIEW` and the link
 *    doc is not written at all (its `updateTime` unmoved);
 *  - the watermark: an older `emMs` after a newer one is dropped, an equal one
 *    keeps the stored, one ms newer writes; a concurrent `update` between our
 *    read and our write fails our precondition and the write-back re-reads and
 *    re-decides (a concurrent STOCK outcome costs one re-read, never a lost
 *    write); a check's refinement lands on the SAME entry; a stored `emMs` 10
 *    min in the future is overwritten with ONE WARNING, 4 min ahead is kept.
 *
 * The concurrent writer is injected by spying on the database's own `getAll`
 * (the real call runs; the competing `update` lands right after it answers).
 *
 * ⚠️ D11. The read switch is ON in exactly one place: the object literal handed
 * to the task as `ambiente`. Never through `process.env` (the lane sets it
 * `off`; the setup refuses `on`; each case asserts it). Amazon is a scripted
 * `fetch` serving the listing read and the offer PATCH of this SKU only,
 * REFUSING anything else (an LWA exchange included: the credential is far from
 * expiry). The producer is a RECORDER: nothing is enqueued onto a queue the
 * lane dispatches.
 *
 * ⚠️ The emulator is SHARED (`vitest.tasks.config.ts`'s rules): every document
 * id here starts with `e2e-preco-processar-`, which no other suite seeds; the
 * conta is INCOMPLETE (no filial, no `dataCadastro`), so the conta trigger only
 * reads; no `nfev4` is written. Every case wipes what it reads first, and the
 * file leaves nothing behind. PLACEHOLDERS ONLY (public repository).
 */
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { CAMINHO_LISTINGS, MARKETPLACE_ID_BR } from '@delfrance/integrations-amazon-sp-api';
import {
  type EnvioPrecoAmazon,
  type FaixaPrecoAmazon,
  INTEGRACAO_TIPO,
  MOTIVO_CONTA_AMAZON,
  RESULTADO_ENVIO_ESTOQUE_AMAZON,
  VIA_ENVIO_ESTOQUE_AMAZON,
  envioEstoqueAmazonSchema,
  envioPrecoAmazonSchema,
  motivoContaAmazonSchema,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { chaveContaPrecisaAtencao } from '../avisos/avisos';
import { loadAmazonContext } from '../core/contexto';
import type { AmbienteAmazon } from '../env';
import { gravarEnvioEstoqueAmazon } from '../estoque/envioEstoqueFirestore';
import {
  type LinkDoEnvioListingAmazon,
  MOTIVO_GRAVACAO_ENVIO_LISTING_FUTURO_IGNORADO,
  gravarEnvioListingAmazon,
} from '../listings/envioListingFirestore';
import {
  AMBIENTE_LIGADO,
  DIA_MS,
  SPID_A,
  caminhoConta,
  caminhoCredencial,
  credencialDoc,
  loggerEspiao,
} from '../testing/fixtures';
import {
  CAMPOS_CONTA_PRECO_AMAZON,
  CAMPOS_VEZ_TAREFA_PRECO_AMAZON,
  CAMPO_DO_ENVIO_PRECO_AMAZON,
  processarPrecoSkuAmazon,
} from './processarPreco';
import { ATRASO_VERIFICACAO_PRECO_S, criarProdutorPrecoAmazon } from './produtorPreco';
import type { TarefaPrecoSkuAmazon } from './tarefaPreco';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const P = 'e2e-preco-processar-';
/** The conta of this file — an id no other suite seeds. */
const CONTA = `${P}conta`;
const SKU = `${P}SKU-1`;
const ASIN = 'B0PRECOPR01';
const PRODUTO = `${P}prod`;
const LINK = `${P}link`;
const NORMAL = `${P}tab-normal`;
const PROMO = `${P}tab-promo`;
/** A third tabela the conta does not name: its entry must never come back. */
const OUTRA = `${P}tab-outra`;
const CAMINHO_PRODUTO = `produtos/${PRODUTO}`;
const CAMINHO_LINK = `${CAMINHO_PRODUTO}/prodAmazon/${LINK}`;
const CAMINHO_VEZ_PRECO = `feedsAmazonEmCurso/preco-${CONTA}`;
const CAMINHO_VEZ_ESTOQUE = `feedsAmazonEmCurso/estoque-${CONTA}`;
const CAMINHO_ITEM = `${CAMINHO_LISTINGS}/${SPID_A}/${SKU}`;
const SUBMISSAO = `${P}sub-1`;
const LINK_DIRETO: LinkDoEnvioListingAmazon = { produtoId: PRODUTO, linkId: LINK };
/** ms — the direct write-backs' clock (2027-01-15T08:00:00Z). */
const AGORA = 1_800_000_000_000;
const MINUTO_MS = 60_000;

/** The ERP faixa the seed prices: normal 60, promotional 55. */
const FAIXA_ERP: FaixaPrecoAmazon = { base: 60, minimo: 55, maximo: 60 };
/** Amazon's live offer before any send. */
const OFERTA_VIVA: FaixaPrecoAmazon = { base: 50, minimo: 45, maximo: 50 };

/** A stock outcome already on the link doc: the price writes must leave it byte-equal. */
const ESTOQUE_GUARDADO = {
  via: 'patch',
  emMs: 1_700_000_000_000,
  quantidade: 3,
  resultado: 'aceito',
  submissionId: 'sub-estoque-1',
  feedId: null,
  problemas: [],
};

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
  await db().recursiveDelete(db().doc(CAMINHO_PRODUTO));
  await Promise.all(
    [
      CAMINHO_VEZ_PRECO,
      CAMINHO_VEZ_ESTOQUE,
      caminhoCredencial(CONTA),
      caminhoConta(CONTA),
      ...AVISOS,
    ].map((c) => db().doc(c).delete()),
  );
}

/** The link doc as seeded: a product payload, a stock outcome and, when given, a price outcome. */
function linkSemeado(envioPrecoAmazon?: unknown): Record<string, unknown> {
  return {
    contaAmazonOuterRef: `documents/integracao/${CONTA}`,
    sku: SKU,
    asin: ASIN,
    productDataJson: { pesado: 'x'.repeat(256) },
    envioEstoqueAmazon: ESTOQUE_GUARDADO,
    ...(envioPrecoAmazon === undefined ? {} : { envioPrecoAmazon }),
  };
}

/**
 * An INCOMPLETE conta naming both tabelas, a fresh credential, a simple produto
 * priced in three tabelas (the conta names two), linked to the SKU, and both
 * leases (the stock one must never be read).
 */
async function semear(envioPrecoAmazon?: unknown): Promise<void> {
  await db()
    .doc(caminhoConta(CONTA))
    .set({
      tipo: INTEGRACAO_TIPO.amazon,
      nome: 'Conta de teste do preço',
      ativo: true,
      padrao: false,
      selling_partner_id: SPID_A,
      tabelaNormalOuterRef: `documents/listaDePrecos/${NORMAL}`,
      tabelaPromocionalOuterRef: `documents/listaDePrecos/${PROMO}`,
    });
  await db()
    .doc(caminhoCredencial(CONTA))
    .set(credencialDoc({ expirationDate: Date.now() + 365 * DIA_MS }));
  await db()
    .doc(CAMINHO_PRODUTO)
    .set({
      nome: 'Produto de teste do preço',
      precos: {
        [NORMAL]: { valor: FAIXA_ERP.base },
        [PROMO]: { valor: FAIXA_ERP.minimo },
        [OUTRA]: { valor: 1 },
      },
    });
  await db().doc(CAMINHO_LINK).set(linkSemeado(envioPrecoAmazon));
  const lease = { estado: 'livre', ateMs: 0, atualizadoEmMs: 1, mensagens: 7, bytes: 70 };
  await db().doc(CAMINHO_VEZ_PRECO).set(lease);
  await db().doc(CAMINHO_VEZ_ESTOQUE).set(lease);
}

interface Roteiro {
  readonly status?: number;
  readonly corpo?: unknown;
}

/** Our offer element as Amazon's purchasable-offer guide writes it (synthetic prices). */
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

/** A price issue as the model shapes one (synthetic text). */
const issuePreco = (code: string) => ({
  code,
  message: 'texto da Amazon',
  severity: 'ERROR',
  attributeNames: ['purchasable_offer'],
  categories: ['INVALID_PRICE'],
});

const listing = (oferta: FaixaPrecoAmazon, issues: unknown[] = []): Roteiro => ({
  status: 200,
  corpo: {
    sku: SKU,
    summaries: [
      { marketplaceId: MARKETPLACE_ID_BR, asin: ASIN, productType: 'LUGGAGE', status: ['BUYABLE'] },
    ],
    attributes: { purchasable_offer: [elemento(oferta)] },
    issues,
    relationships: [{ marketplaceId: MARKETPLACE_ID_BR, relationships: [] }],
  },
});

const submissao = (status: string): Roteiro => ({
  status: 200,
  corpo: { sku: SKU, status, submissionId: SUBMISSAO, issues: [] },
});

/** What one PATCH carried, and the link doc as the SERVER held it when the PATCH left. */
interface PatchVisto {
  readonly oferta: FaixaPrecoAmazon;
  readonly modo: string | null;
  readonly linkNoServidor: Record<string, unknown>;
}

/**
 * Set while the scripted PATCH reads the link doc for itself: the SDK's
 * `DocumentReference.get()` goes through the same `getAll` the read spy
 * watches, and that read is the test's, never the task's.
 */
let leituraDoTeste = false;

/** A scripted fetch: the listing GET and the offer PATCH of THIS SKU only; everything else refused. */
function fetchRoteirizado(get: Roteiro, patch: Roteiro) {
  const patches: PatchVisto[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    const metodo = init?.method ?? 'GET';
    if (url.pathname !== CAMINHO_ITEM || (metodo !== 'GET' && metodo !== 'PATCH')) {
      throw new TypeError(`sem rede: ${metodo} ${url.pathname} não roteirizado`);
    }
    if (metodo === 'PATCH') {
      const corpo = JSON.parse(String(init?.body)) as {
        patches: { value: Record<string, { schedule: { value_with_tax: number }[] }[]>[] }[];
      };
      const v = corpo.patches[0]?.value[0] ?? {};
      const preco = (chave: string) => v[chave]?.[0]?.schedule[0]?.value_with_tax ?? NaN;
      patches.push({
        oferta: {
          base: preco('our_price'),
          minimo: preco('minimum_seller_allowed_price'),
          maximo: preco('maximum_seller_allowed_price'),
        },
        modo: url.searchParams.get('mode'),
        linkNoServidor: await lerLinkNoTeste(),
      });
    }
    const r = metodo === 'GET' ? get : patch;
    return new Response(JSON.stringify(r.corpo ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fetch, patches };
}

const tarefa = (over: Partial<TarefaPrecoSkuAmazon> = {}): TarefaPrecoSkuAmazon => ({
  v: 1,
  tipo: 'preco-sku',
  contaId: CONTA,
  sku: SKU,
  origem: 'manual',
  referencia: `${P}req-1`,
  parte: null,
  baixarPreco: false,
  solicitadoEmMs: Date.now(),
  codigosAntes: [],
  ...over,
});

/** The link doc as the server holds it, read by the TEST (outside the read spy's record). */
async function lerLinkNoTeste(): Promise<Record<string, unknown>> {
  leituraDoTeste = true;
  try {
    const leitura = db().doc(CAMINHO_LINK).get();
    leituraDoTeste = false;
    return (await leitura).data() ?? {};
  } finally {
    leituraDoTeste = false;
  }
}

/** One price dispatch, in-process: the switch on as a literal, Amazon scripted, the queue a recorder. */
function processar(
  t: TarefaPrecoSkuAmazon,
  get: Roteiro,
  patch: Roteiro,
  o: { readonly soValidacao?: boolean; readonly ambiente?: AmbienteAmazon } = {},
) {
  expect(process.env.AMAZON_CHAMADAS).not.toBe('on');
  const { fetch, patches } = fetchRoteirizado(get, patch);
  const enfileiradas: { readonly tarefa: TarefaPrecoSkuAmazon; readonly opcoes: unknown }[] = [];
  const produtor = criarProdutorPrecoAmazon({
    desligado: false,
    fila: () => ({
      enqueue: (tarefaEnfileirada, opcoes) => {
        enfileiradas.push({ tarefa: tarefaEnfileirada, opcoes });
        return Promise.resolve();
      },
    }),
  });
  const execucao = processarPrecoSkuAmazon(t, {
    db: db(),
    ambiente: o.ambiente ?? AMBIENTE_LIGADO_NO_PROCESSO,
    agora: () => Date.now(),
    logger: loggerEspiao().logger,
    increment: (by) => FieldValue.increment(by),
    carregarContexto: loadAmazonContext,
    produtor: () => produtor,
    soValidacao: o.soValidacao ?? false,
    registro: { tentativa: 0, idTarefa: 'tarefa-preco-ci' },
    fetch,
    gerarCorrelationId: () => 'corr-preco-ci',
  });
  return { execucao, patches, enfileiradas, fetch };
}

/** A snapshot's commit time, which a written document always has. */
function carimbo(t: Timestamp | undefined): Timestamp {
  if (t === undefined) throw new TypeError('documento sem updateTime');
  return t;
}

async function link(): Promise<Record<string, unknown>> {
  return (await db().doc(CAMINHO_LINK).get()).data() ?? {};
}

/** The link doc without its price outcome: what no price write may move. */
function semPreco(dados: Record<string, unknown>): Record<string, unknown> {
  const { envioPrecoAmazon: _envioPrecoAmazon, ...resto } = dados;
  return resto;
}

/** A price outcome of the field's own schema. */
function envio(over: Partial<EnvioPrecoAmazon> & Pick<EnvioPrecoAmazon, 'emMs'>): EnvioPrecoAmazon {
  return envioPrecoAmazonSchema.parse({
    via: VIA_ENVIO_ESTOQUE_AMAZON.patch,
    oferta: FAIXA_ERP,
    resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.aceito,
    submissionId: SUBMISSAO,
    feedId: null,
    problemas: [],
    ...over,
  });
}

/** The price binding of the shared write-back, on the server, at {@link AGORA}. */
function gravarPreco(e: EnvioPrecoAmazon, logger = loggerEspiao().logger) {
  return gravarEnvioListingAmazon(
    db(),
    CAMPO_DO_ENVIO_PRECO_AMAZON,
    { contaId: CONTA, sku: SKU, links: [LINK_DIRETO], envio: e, agoraMs: AGORA },
    { logger },
  );
}

/** After the FIRST `getAll` answers, `competir` lands (once): the window a concurrent writer uses. */
function concorrenteAposALeitura(competir: () => Promise<unknown>) {
  const original = db().getAll.bind(db());
  const getAll = vi.spyOn(db(), 'getAll');
  getAll.mockImplementationOnce(async (...args: Parameters<Firestore['getAll']>) => {
    const snaps = await original(...args);
    await competir();
    return snaps;
  });
  return getAll;
}

/** Every snapshot the database's own `getAll` answered: its path and its fields. */
function espiarLeituras() {
  const instancia = db();
  const original = instancia.getAll.bind(instancia);
  const lidos: { readonly caminho: string; readonly dados: Record<string, unknown> }[] = [];
  vi.spyOn(instancia, 'getAll').mockImplementation(async (...args) => {
    const doTeste = leituraDoTeste;
    const snaps = await original(...args);
    if (!doTeste) for (const s of snaps) lidos.push({ caminho: s.ref.path, dados: s.data() ?? {} });
    return snaps;
  });
  return lidos;
}

describe.skipIf(!EMULATED)('the price task on real Firestore (emulator)', () => {
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

  it('★ the write-ahead and the answered outcome change ONLY envioPrecoAmazon: the stock outcome and the payload byte-equal at the PATCH and after it', async () => {
    await semear();
    const semeado = await link();
    const { execucao, patches, enfileiradas } = processar(
      tarefa(),
      listing(OFERTA_VIVA),
      submissao('ACCEPTED'),
    );
    const r = await execucao;
    expect(r).toMatchObject({
      acao: 'enviado',
      motivo: 'enviado',
      gravados: 1,
      verificacao: 'enfileirada',
    });
    // ONE PATCH of the faixa computed NOW, and the write-ahead was on the
    // server, as `incerto` of that very offer, when it left.
    expect(patches.map((p) => [p.oferta, p.modo])).toEqual([[FAIXA_ERP, null]]);
    const noPatch = patches[0]?.linkNoServidor ?? {};
    const previo = envioPrecoAmazonSchema.parse(noPatch.envioPrecoAmazon);
    expect(previo).toMatchObject({
      via: 'patch',
      resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto,
      oferta: FAIXA_ERP,
    });
    expect(semPreco(noPatch)).toEqual(semeado);
    // The answer replaced its own record: strictly newer, ours in ms.
    const depois = await link();
    const final = envioPrecoAmazonSchema.parse(depois.envioPrecoAmazon);
    expect(final).toMatchObject({
      resultado: 'aceito',
      submissionId: SUBMISSAO,
      oferta: FAIXA_ERP,
    });
    expect(final.emMs).toBeGreaterThan(previo.emMs);
    expect(Math.abs(final.emMs - Date.now())).toBeLessThan(60_000);
    expect(semPreco(depois)).toEqual(semeado);
    expect(depois.envioEstoqueAmazon).toEqual(ESTOQUE_GUARDADO);
    // ONE check, named after the submission, 15 min later.
    expect(enfileiradas).toHaveLength(1);
    expect(enfileiradas[0]?.tarefa).toMatchObject({ origem: 'verificacao', referencia: SUBMISSAO });
    expect(enfileiradas[0]?.opcoes).toMatchObject({
      scheduleDelaySeconds: ATRASO_VERIFICACAO_PRECO_S,
    });
  });

  it('★ the masked reads on the server: the unit’s ONE precos.<tabela> entry per tabela, the conta’s two refs, the price lease’s listed fields, the outcome field alone — the stock lease never read', async () => {
    await semear();
    const lidos = espiarLeituras();
    const { execucao, patches } = processar(tarefa(), listing(OFERTA_VIVA), submissao('ACCEPTED'));
    expect((await execucao).motivo).toBe('enviado');
    expect(patches).toHaveLength(1);

    const de = (caminho: string) => lidos.filter((l) => l.caminho === caminho).map((l) => l.dados);
    // The unit (and its dono, the same produto): never `nome`, never the third tabela.
    const doProduto = de(CAMINHO_PRODUTO);
    expect(doProduto).toContainEqual({
      precos: { [NORMAL]: { valor: FAIXA_ERP.base }, [PROMO]: { valor: FAIXA_ERP.minimo } },
    });
    for (const dados of doProduto) {
      expect(
        Object.keys(dados).every((k) => k === 'precos'),
        JSON.stringify(dados),
      ).toBe(true);
      expect(Object.keys((dados.precos ?? {}) as object).sort()).not.toContain(OUTRA);
    }
    // The conta, masked to its two refs on P3's read (the context's own read aside).
    expect(de(caminhoConta(CONTA))).toContainEqual({
      tabelaNormalOuterRef: `documents/listaDePrecos/${NORMAL}`,
      tabelaPromocionalOuterRef: `documents/listaDePrecos/${PROMO}`,
    });
    expect([...CAMPOS_CONTA_PRECO_AMAZON].sort()).toEqual([
      'tabelaNormalOuterRef',
      'tabelaPromocionalOuterRef',
    ]);
    // The PRICE lease, its listed fields only (`mensagens`, `bytes` never come back).
    const daVez = de(CAMINHO_VEZ_PRECO);
    expect(daVez).toEqual([{ estado: 'livre', ateMs: 0, atualizadoEmMs: 1 }]);
    for (const dados of daVez) {
      expect(
        Object.keys(dados).every((k) =>
          (CAMPOS_VEZ_TAREFA_PRECO_AMAZON as readonly string[]).includes(k),
        ),
      ).toBe(true);
    }
    // NEAR-MISS: the stock lease holds the same document shape, and is never read.
    expect(de(CAMINHO_VEZ_ESTOQUE)).toEqual([]);
    // The link doc by id: the write-back's two reads (the write-ahead's, before
    // any price outcome, and the answer's), each the price field alone — never
    // the product payload, never the stock outcome (the verdict's own read is a
    // projected query, not a `getAll`).
    expect(de(CAMINHO_LINK).map((dados) => Object.keys(dados))).toEqual([[], ['envioPrecoAmazon']]);
  });

  it('★ NEAR-MISS: under the preview flag the PATCH is a VALIDATION_PREVIEW and the link doc is NOT written at all; no check', async () => {
    await semear();
    const antes = carimbo((await db().doc(CAMINHO_LINK).get()).updateTime);
    const { execucao, patches, enfileiradas } = processar(
      tarefa(),
      listing(OFERTA_VIVA),
      submissao('VALID'),
      {
        soValidacao: true,
        ambiente: { ...AMBIENTE_LIGADO_NO_PROCESSO, AMAZON_CANARIO_PRECO: `${CONTA}:${SKU}` },
      },
    );
    expect(await execucao).toMatchObject({ acao: 'enviado', motivo: 'previa', previa: true });
    expect(patches.map((p) => [p.oferta, p.modo])).toEqual([[FAIXA_ERP, 'VALIDATION_PREVIEW']]);
    // No write-ahead either: the server held no price outcome when the PATCH left.
    expect(patches[0]?.linkNoServidor.envioPrecoAmazon).toBeUndefined();
    expect(carimbo((await db().doc(CAMINHO_LINK).get()).updateTime).isEqual(antes)).toBe(true);
    expect(enfileiradas).toEqual([]);
  });

  it('★ a check’s refinement lands on the SAME entry: a NEW price ERROR ⇒ recusado with the checked emMs and submission, NO PATCH, the conta aviso raised', async () => {
    const enviadoEmMs = Date.now() - 15 * MINUTO_MS;
    await semear(envio({ emMs: enviadoEmMs }));
    const semeado = await link();
    const { execucao, patches } = processar(
      tarefa({
        origem: 'verificacao',
        referencia: SUBMISSAO,
        solicitadoEmMs: enviadoEmMs,
      }),
      listing(OFERTA_VIVA, [issuePreco('19037')]),
      submissao('ACCEPTED'),
    );
    expect(await execucao).toMatchObject({ acao: 'encerrado', gravados: 1, avisoLevantado: true });
    expect(patches).toEqual([]);
    const depois = await link();
    expect(depois.envioPrecoAmazon).toMatchObject({
      emMs: enviadoEmMs,
      submissionId: SUBMISSAO,
      resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.recusado,
      problemas: [expect.objectContaining({ code: '19037' })],
    });
    expect(semPreco(depois)).toEqual(semPreco(semeado));
    const aviso = await db()
      .doc(`avisos/${chaveContaPrecisaAtencao(CONTA, MOTIVO_CONTA_AMAZON.precoRecusadoPelaAmazon)}`)
      .get();
    expect(aviso.data()).toMatchObject({ resolvidoEm: null });
  });

  it('★ NEAR-MISS of the refinement: the SAME emMs under ANOTHER submission keeps the stored; the same submission refines', async () => {
    await semear(envio({ emMs: AGORA }));
    const outra = await gravarPreco(
      envio({
        emMs: AGORA,
        submissionId: `${P}sub-2`,
        resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.recusado,
      }),
    );
    expect(outra).toMatchObject({ gravados: 0, mantidos: 1 });
    expect((await link()).envioPrecoAmazon).toMatchObject({
      resultado: 'aceito',
      submissionId: SUBMISSAO,
    });
    const mesma = await gravarPreco(
      envio({ emMs: AGORA, resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.recusado }),
    );
    expect(mesma).toMatchObject({ gravados: 1, mantidos: 0 });
    expect((await link()).envioPrecoAmazon).toMatchObject({
      emMs: AGORA,
      resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.recusado,
      submissionId: SUBMISSAO,
    });
  });

  it('★ an older emMs arriving after a newer one is dropped; NEAR-MISS: an EQUAL one (another offer) keeps the stored, one ms newer writes — the stock outcome untouched throughout', async () => {
    await semear();
    expect(await gravarPreco(envio({ emMs: AGORA + 1_000 }))).toMatchObject({ gravados: 1 });
    const tardio = await gravarPreco(
      envio({ emMs: AGORA, oferta: { base: 70, minimo: 70, maximo: 70 } }),
    );
    expect(tardio).toMatchObject({ gravados: 0, mantidos: 1 });
    expect((await link()).envioPrecoAmazon).toMatchObject({
      emMs: AGORA + 1_000,
      oferta: FAIXA_ERP,
    });
    const igual = await gravarPreco(
      envio({
        emMs: AGORA + 1_000,
        oferta: { base: 70, minimo: 70, maximo: 70 },
        submissionId: null,
        resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto,
      }),
    );
    expect(igual).toMatchObject({ gravados: 0, mantidos: 1 });
    expect((await link()).envioPrecoAmazon).toMatchObject({ oferta: FAIXA_ERP });
    const novo = await gravarPreco(
      envio({ emMs: AGORA + 1_001, oferta: { base: 70, minimo: 70, maximo: 70 } }),
    );
    expect(novo).toMatchObject({ gravados: 1 });
    expect((await link()).envioPrecoAmazon).toMatchObject({
      emMs: AGORA + 1_001,
      oferta: { base: 70, minimo: 70, maximo: 70 },
    });
    expect((await link()).envioEstoqueAmazon).toEqual(ESTOQUE_GUARDADO);
  });

  it('★ a concurrent NEWER price outcome between our read and our write ⇒ re-read, re-decide: ours is dropped', async () => {
    await semear(envio({ emMs: AGORA - MINUTO_MS }));
    const getAll = concorrenteAposALeitura(() =>
      db()
        .doc(CAMINHO_LINK)
        .update({
          envioPrecoAmazon: envio({
            emMs: AGORA + 5_000,
            oferta: { base: 80, minimo: 80, maximo: 80 },
          }),
        }),
    );
    const r = await gravarPreco(envio({ emMs: AGORA }));
    expect(getAll).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ gravados: 0, mantidos: 1, emConflito: 0 });
    expect((await link()).envioPrecoAmazon).toMatchObject({
      emMs: AGORA + 5_000,
      oferta: { base: 80, minimo: 80, maximo: 80 },
    });
  });

  it('★ NEAR-MISS: a concurrent STOCK outcome on the same link doc costs ONE re-read, never a lost write: ours lands, and so does theirs', async () => {
    await semear(envio({ emMs: AGORA - MINUTO_MS }));
    const estoqueConcorrente = { ...ESTOQUE_GUARDADO, emMs: AGORA + 2_000, quantidade: 9 };
    const getAll = concorrenteAposALeitura(() =>
      db().doc(CAMINHO_LINK).update({ envioEstoqueAmazon: estoqueConcorrente }),
    );
    const r = await gravarPreco(envio({ emMs: AGORA }));
    expect(getAll).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ gravados: 1, mantidos: 0, emConflito: 0 });
    const depois = await link();
    expect(depois.envioPrecoAmazon).toMatchObject({ emMs: AGORA, oferta: FAIXA_ERP });
    expect(depois.envioEstoqueAmazon).toEqual(estoqueConcorrente);
  });

  it('★ a stored emMs 10 min in the FUTURE is overwritten with ONE WARNING; NEAR-MISS: 4 min ahead is kept, and the stock binding keeps its own 10-min-ahead value', async () => {
    await semear(
      envio({
        emMs: AGORA + 10 * MINUTO_MS,
        resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto,
        submissionId: null,
      }),
    );
    const espiao = loggerEspiao();
    const r = await gravarPreco(envio({ emMs: AGORA }), espiao.logger);
    expect(r).toMatchObject({ gravados: 1, mantidos: 0 });
    expect((await link()).envioPrecoAmazon).toMatchObject({ emMs: AGORA, resultado: 'aceito' });
    expect(
      espiao.linhas.filter(
        (l) =>
          l.nivel === 'warn' &&
          JSON.stringify(l.meta ?? {}).includes(MOTIVO_GRAVACAO_ENVIO_LISTING_FUTURO_IGNORADO),
      ),
    ).toHaveLength(1);

    await db()
      .doc(CAMINHO_LINK)
      .update({
        envioPrecoAmazon: envio({
          emMs: AGORA + 4 * MINUTO_MS,
          resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto,
          submissionId: null,
        }),
      });
    expect(await gravarPreco(envio({ emMs: AGORA }))).toMatchObject({ gravados: 0, mantidos: 1 });
    expect((await link()).envioPrecoAmazon).toMatchObject({ emMs: AGORA + 4 * MINUTO_MS });

    // Stock passes neither price parameter: the same far-future stamp holds there.
    const estoqueFuturo = { ...ESTOQUE_GUARDADO, emMs: AGORA + 10 * MINUTO_MS };
    await db().doc(CAMINHO_LINK).update({ envioEstoqueAmazon: estoqueFuturo });
    const estoque = await gravarEnvioEstoqueAmazon(
      db(),
      {
        contaId: CONTA,
        sku: SKU,
        links: [LINK_DIRETO],
        envio: envioEstoqueAmazonSchema.parse({ ...ESTOQUE_GUARDADO, emMs: AGORA, quantidade: 1 }),
        agoraMs: AGORA,
      },
      { logger: loggerEspiao().logger },
    );
    expect(estoque).toMatchObject({ gravados: 0, mantidos: 1 });
    expect((await link()).envioEstoqueAmazon).toEqual(estoqueFuturo);
  });
});
