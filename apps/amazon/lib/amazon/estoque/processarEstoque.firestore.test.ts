/**
 * The stock task on a REAL Firestore — the emulator of `ci-amazon.yml`, not the
 * in-memory fake (step 12, PR 12-e1). The offline suite drives every branch of
 * P0–P10 against `testing/fakeDb.ts`; this file runs the task IN-PROCESS on the
 * real server, end to end, and proves what only holds if the server behaves as
 * the fake says:
 *
 *  - the happy path's reads on the server: the link query's projection, the
 *    donos', the unit's, the estoque rows' and the stock lease's field masks,
 *    the children seek — then ONE PATCH of the ERP quantity, the outcome written
 *    back under its real `lastUpdateTime` precondition (the link's product
 *    payload untouched), and ONE read-back handed to the producer;
 *  - the feed-recent rule reading the lease's one masked field on the server;
 *  - an `INVALID` answer: `recusado` written back and the conta aviso raised,
 *    clocked by the write-back's own link-doc read (between the seed's commit
 *    and the outcome's);
 *  - the lost-answer case: a cut PATCH leaves the provisional `incerto` entry on
 *    the real document before the throw, and the retry, after the ERP moved
 *    back to Amazon's visible value, sends exactly ONE PATCH of it.
 *
 * ⚠️ D11. The read switch is ON in exactly one place: the object literal handed
 * to the task as `ambiente`. Never through `process.env` (the lane sets it
 * `off`; the setup refuses `on`; each case asserts it). Amazon is a scripted
 * `fetch` serving the listing read and the availability PATCH, composed in test
 * code, and REFUSING anything else (an LWA exchange included: the credential is
 * far from expiry). The producer is a RECORDER: nothing is enqueued onto a
 * queue the lane dispatches.
 *
 * ⚠️ The emulator is SHARED (`vitest.tasks.config.ts`'s rules): every document
 * id here starts with `e2e-estoque-processar-`, which no other suite seeds; the
 * conta is INCOMPLETE (no filial, no `dataCadastro`), so the conta trigger only
 * reads; no `nfev4` is written. Every case wipes what it reads first, and the
 * file leaves nothing behind.
 */
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { CAMINHO_LISTINGS, MARKETPLACE_ID_BR } from '@delfrance/integrations-amazon-sp-api';
import {
  INTEGRACAO_TIPO,
  MOTIVO_CONTA_AMAZON,
  makeEstoqueUid,
  motivoContaAmazonSchema,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { chaveContaPrecisaAtencao, relogioDoDocumentoUs } from '../avisos/avisos';
import { loadAmazonContext } from '../core/contexto';
import type { AmbienteAmazon } from '../env';
import {
  AMBIENTE_LIGADO,
  DIA_MS,
  SPID_A,
  caminhoConta,
  caminhoCredencial,
  credencialDoc,
  loggerEspiao,
  respostaJson,
} from '../testing/fixtures';
import { CAMPO_FEED_RECENTE_ESTOQUE_AMAZON, processarEstoqueAmazon } from './processarEstoque';
import { criarProdutorEstoqueAmazon } from './produtorEstoque';
import { ORIGEM_TAREFA_ESTOQUE_AMAZON, type TarefaEstoqueAmazon } from './tarefaEstoque';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const P = 'e2e-estoque-processar-';
/** The conta of this file — an id no other suite seeds. */
const CONTA = `${P}conta`;
const DEP = `${P}dep`;
const SKU = `${P}SKU-1`;
const ASIN = 'B0PROCES001';
const PRODUTO = `${P}prod`;
const CAMINHO_PRODUTO = `produtos/${PRODUTO}`;
const CAMINHO_LINK = `${CAMINHO_PRODUTO}/prodAmazon/${P}link`;
const CAMINHO_ESTOQUE = `${CAMINHO_PRODUTO}/estoques/${makeEstoqueUid(PRODUTO, DEP)}`;
const CAMINHO_VEZ = `feedsAmazonEmCurso/estoque-${CONTA}`;
const CAMINHO_ITEM = `${CAMINHO_LISTINGS}/${SPID_A}/${SKU}`;
const SUBMISSAO = `${P}sub-1`;

/** The ONE place the switch is on: an object literal (module header). */
const AMBIENTE_LIGADO_NO_PROCESSO: AmbienteAmazon = Object.freeze({
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

/** Everything this file writes, deleted (subcollections included). */
async function limpar(): Promise<void> {
  await db().recursiveDelete(db().doc(CAMINHO_PRODUTO));
  await Promise.all(
    [CAMINHO_VEZ, caminhoCredencial(CONTA), caminhoConta(CONTA), ...AVISOS].map((c) =>
      db().doc(c).delete(),
    ),
  );
}

/** An INCOMPLETE conta with its depósito, a fresh credential, a simple produto linked to the SKU. */
async function semear(erp: number): Promise<void> {
  await db()
    .doc(caminhoConta(CONTA))
    .set({
      tipo: INTEGRACAO_TIPO.amazon,
      nome: 'Conta de teste do estoque',
      ativo: true,
      padrao: false,
      selling_partner_id: SPID_A,
      depositoOuterRef: `documents/depositos/${DEP}`,
    });
  await db()
    .doc(caminhoCredencial(CONTA))
    .set(credencialDoc({ expirationDate: Date.now() + 365 * DIA_MS }));
  await db().doc(CAMINHO_PRODUTO).set({ nome: 'Produto de teste do estoque' });
  await db()
    .doc(CAMINHO_LINK)
    .set({
      contaAmazonOuterRef: `documents/integracao/${CONTA}`,
      sku: SKU,
      asin: ASIN,
      productDataJson: { pesado: 'x'.repeat(256) },
    });
  await definirErp(erp);
}

async function definirErp(quantidade: number): Promise<void> {
  await db()
    .doc(CAMINHO_ESTOQUE)
    .set({
      depositoOuterRef: `documents/depositos/${DEP}`,
      parentId: null,
      quantidade,
      quantidadeReservada: 0,
    });
}

interface Roteiro {
  readonly status?: number;
  readonly corpo?: unknown;
  readonly rede?: true;
}

const listing = (quantidade: number): Roteiro => ({
  status: 200,
  corpo: {
    sku: SKU,
    summaries: [{ marketplaceId: MARKETPLACE_ID_BR, asin: ASIN, productType: 'PRODUCT' }],
    fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: quantidade }],
    relationships: [{ marketplaceId: MARKETPLACE_ID_BR, relationships: [] }],
  },
});

const submissao = (status: string): Roteiro => ({
  status: 200,
  corpo: { sku: SKU, status, submissionId: SUBMISSAO, issues: [] },
});

/** A scripted fetch: the listing GET and the PATCH of THIS SKU only; everything else refused. */
function fetchRoteirizado(get: Roteiro, patch: Roteiro) {
  const patches: number[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    const url = new URL(String(input));
    const metodo = init?.method ?? 'GET';
    if (url.pathname !== CAMINHO_ITEM || (metodo !== 'GET' && metodo !== 'PATCH')) {
      return Promise.reject(new TypeError(`sem rede: ${metodo} ${url.pathname} não roteirizado`));
    }
    const r = metodo === 'GET' ? get : patch;
    if (metodo === 'PATCH') {
      const corpo = JSON.parse(String(init?.body)) as {
        patches: { value: { quantity: number }[] }[];
      };
      patches.push(corpo.patches[0]?.value[0]?.quantity ?? -1);
    }
    if (r.rede === true) return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(respostaJson(r.status ?? 200, r.corpo ?? {}));
  });
  return { fetch, patches };
}

const tarefa = (): TarefaEstoqueAmazon => ({
  v: 1,
  contaId: CONTA,
  sku: SKU,
  origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.delta,
  referencia: '1800000000.000000001',
  depositoId: null,
});

/** One stock dispatch, in-process: the switch on as a literal, Amazon scripted, the queue a recorder. */
async function processar(get: Roteiro, patch: Roteiro) {
  expect(process.env.AMAZON_CHAMADAS).not.toBe('on');
  const { fetch, patches } = fetchRoteirizado(get, patch);
  const enfileiradas: { readonly tarefa: TarefaEstoqueAmazon; readonly id: string | null }[] = [];
  const produtor = criarProdutorEstoqueAmazon({
    desligado: false,
    fila: () => ({
      enqueue: (t, opcoes) => {
        enfileiradas.push({ tarefa: t, id: opcoes?.id ?? null });
        return Promise.resolve();
      },
    }),
  });
  const execucao = processarEstoqueAmazon(tarefa(), {
    db: db(),
    ambiente: AMBIENTE_LIGADO_NO_PROCESSO,
    agora: () => Date.now(),
    logger: loggerEspiao().logger,
    increment: (by) => FieldValue.increment(by),
    carregarContexto: loadAmazonContext,
    produtor: () => produtor,
    registro: { tentativa: 0, idTarefa: 'tarefa-estoque-ci' },
    fetch,
    gerarCorrelationId: () => 'corr-estoque-ci',
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

describe.skipIf(!EMULATED)('the stock task on real Firestore (emulator)', () => {
  beforeEach(async () => {
    __resetAllReadCaches();
    await limpar();
  });

  afterAll(async () => {
    __resetAllReadCaches();
    await limpar();
  });

  it('★ the happy path: ONE PATCH of the ERP quantity, the outcome under its precondition, ONE read-back', async () => {
    await semear(3);
    const { execucao, patches, enfileiradas } = await processar(listing(7), submissao('ACCEPTED'));
    const r = await execucao;
    expect(r).toMatchObject({
      acao: 'enviado',
      motivo: 'enviado',
      quantidadeErp: 3,
      quantidadeAmazon: 7,
      gravados: 1,
      verificacao: 'enfileirada',
    });
    expect(patches).toEqual([3]);
    const dados = await link();
    expect(dados.envioEstoqueAmazon).toMatchObject({
      via: 'patch',
      quantidade: 3,
      resultado: 'aceito',
      submissionId: SUBMISSAO,
    });
    // Our ms clock, never a µs value.
    const emMs = (dados.envioEstoqueAmazon as { emMs: number }).emMs;
    expect(Math.abs(emMs - Date.now())).toBeLessThan(60_000);
    // The write-back touched its one field: the product payload is intact.
    expect(dados.productDataJson).toEqual({ pesado: 'x'.repeat(256) });
    expect(enfileiradas).toHaveLength(1);
    expect(enfileiradas[0]?.tarefa).toMatchObject({
      origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.verificacao,
      referencia: SUBMISSAO,
    });
  });

  it('the feed-recent rule reads the lease’s ONE masked field on the server: equal quantities 4 min after a feed ⇒ one PATCH', async () => {
    await semear(3);
    const fimDoFeedMs = Date.now() - 4 * 60_000;
    await db()
      .doc(CAMINHO_VEZ)
      .set({ [CAMPO_FEED_RECENTE_ESTOQUE_AMAZON]: fimDoFeedMs, estado: 'livre' });
    // What the SERVER answered for the lease: the task's own getAll, observed.
    const instancia = db();
    const getAllReal = instancia.getAll.bind(instancia);
    const lidosDaVez: Record<string, unknown>[] = [];
    const espiao = vi.spyOn(instancia, 'getAll').mockImplementation(async (...args) => {
      const snaps = await getAllReal(...args);
      for (const s of snaps) if (s.ref.path === CAMINHO_VEZ) lidosDaVez.push(s.data() ?? {});
      return snaps;
    });
    try {
      const { execucao, patches } = await processar(listing(3), submissao('ACCEPTED'));
      const r = await execucao;
      expect(r.regra).toBe('feed-recente');
      expect(patches).toEqual([3]);
    } finally {
      espiao.mockRestore();
    }
    // NEAR-MISS: the lease also holds `estado`, which the masked read never returns.
    expect(lidosDaVez).toEqual([{ [CAMPO_FEED_RECENTE_ESTOQUE_AMAZON]: fimDoFeedMs }]);
  });

  it('NEAR-MISS: no lease on record and equal quantities ⇒ igual, no PATCH, nothing written', async () => {
    await semear(3);
    const antes = carimbo((await db().doc(CAMINHO_LINK).get()).updateTime);
    const { execucao, patches } = await processar(listing(3), submissao('ACCEPTED'));
    expect((await execucao).motivo).toBe('igual');
    expect(patches).toEqual([]);
    expect(carimbo((await db().doc(CAMINHO_LINK).get()).updateTime).isEqual(antes)).toBe(true);
  });

  it('★ INVALID ⇒ recusado written back, and the conta aviso raised, clocked by the write-back’s link read', async () => {
    await semear(3);
    const semeadoUs = relogioDoDocumentoUs(
      carimbo((await db().doc(CAMINHO_LINK).get()).updateTime),
    );
    const { execucao, enfileiradas } = await processar(listing(7), submissao('INVALID'));
    const r = await execucao;
    expect(r).toMatchObject({ acao: 'enviado', avisoLevantado: true });
    const snap = await db().doc(CAMINHO_LINK).get();
    expect((snap.data()?.envioEstoqueAmazon as { resultado: string }).resultado).toBe('recusado');
    const gravadoUs = relogioDoDocumentoUs(carimbo(snap.updateTime));
    const aviso = (
      await db()
        .doc(
          `avisos/${chaveContaPrecisaAtencao(CONTA, MOTIVO_CONTA_AMAZON.estoqueRecusadoPelaAmazon)}`,
        )
        .get()
    ).data();
    expect(aviso).toMatchObject({ resolvidoEm: null });
    const relogio = aviso?.relogioEvento as number;
    // Read after the seed's commit, before the outcome's own commit.
    expect(relogio).toBeGreaterThan(semeadoUs);
    expect(relogio).toBeLessThan(gravadoUs);
    expect(enfileiradas).toEqual([]);
  });

  it('★ the lost-answer case: a cut PATCH leaves incerto on the real document; the retry at ERP = Amazon sends ONE PATCH', async () => {
    await semear(4);
    const primeira = await processar(listing(3), { rede: true });
    await expect(primeira.execucao).rejects.toMatchObject({ name: 'AmazonNetworkError' });
    expect(primeira.patches).toEqual([4]);
    expect((await link()).envioEstoqueAmazon).toMatchObject({
      resultado: 'incerto',
      quantidade: 4,
    });

    await definirErp(3);
    __resetAllReadCaches();
    const retry = await processar(listing(3), submissao('ACCEPTED'));
    const r = await retry.execucao;
    expect(r.regra).toBe('envio-recente');
    expect(retry.patches).toEqual([3]);
    expect((await link()).envioEstoqueAmazon).toMatchObject({ resultado: 'aceito', quantidade: 3 });
  });
});
