/**
 * The batch evaluator on a REAL Firestore — the emulator of `ci-amazon.yml`,
 * not the in-memory fake (step 12, PR 12-f). The offline suite drives every
 * branch against `testing/fakeDb.ts`; this file runs one batch IN-PROCESS on
 * the real server and proves what only holds if the server behaves as the fake
 * says:
 *
 *  - the WHOLE pipeline over real documents: a simple produto, a family-of-one
 *    wrapper (its member's row), two kits sharing a component (component-min,
 *    the shared row read once), a wrapper whose member is gone, a child link
 *    whose parent pointer resolves on the server, and an ambiguous SKU — each
 *    with its verdict, its quantity and its live read;
 *  - the MASKS: every `getAll` the evaluator makes answers ONLY its mask's
 *    fields on the server (a link doc's product payload, a produto's `nome` or
 *    prices never come back), and each produto is read ONCE in the batch;
 *  - PARITY on the server: every SKU's link verdict is the one the patch task's
 *    own resolver reads alone.
 *
 * ⚠️ D11. The read switch is ON in exactly one place: the object literal handed
 * to the context as `ambiente`. Never through `process.env` (the lane sets it
 * `off`; the setup refuses `on`; the case asserts it). Amazon is a scripted
 * `fetch` serving the search and the listing read of this file's SKUs only,
 * composed in test code, and REFUSING anything else (an LWA exchange included:
 * the credential is far from expiry). Nothing is enqueued.
 *
 * ⚠️ The emulator is SHARED (`vitest.tasks.config.ts`'s rules): every document
 * id here starts with `e2e-estoque-avaliacao-`, which no other suite seeds; the
 * conta is INCOMPLETE (no filial, no `dataCadastro`), so the conta trigger only
 * reads; no `nfev4` is written. Every case wipes what it reads first, and the
 * file leaves nothing behind.
 */
import type { DocumentReference, Firestore, ReadOptions } from 'firebase-admin/firestore';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { CAMINHO_LISTINGS, MARKETPLACE_ID_BR } from '@delfrance/integrations-amazon-sp-api';
import { INTEGRACAO_TIPO, makeEstoqueUid } from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

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
import {
  type AvaliacaoLoteEstoqueAmazon,
  type AvaliacaoSkuEstoqueAmazon,
  avaliarSkusEstoqueAmazon,
} from './avaliacaoLoteEstoque';
import { lerVinculoEstoqueAmazon } from './resolverEstoque';
import { avaliarVinculoEstoqueAmazon } from './vinculoEstoque';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const P = 'e2e-estoque-avaliacao-';
/** The conta of this file — an id no other suite seeds. */
const CONTA = `${P}conta`;
const REF_CONTA = `documents/integracao/${CONTA}`;
const DEP = `${P}dep`;
const REF_DEP = `documents/depositos/${DEP}`;
const CAMINHO_BUSCA = `${CAMINHO_LISTINGS}/${SPID_A}`;

const SKU = {
  simples: `${P}SKU-SIMPLES`,
  wrapper: `${P}SKU-WRAPPER`,
  kit1: `${P}SKU-KIT-1`,
  kit2: `${P}SKU-KIT-2`,
  sumido: `${P}SKU-SUMIDO`,
  filho: `${P}SKU-FILHO`,
  ambiguo: `${P}SKU-AMBIGUO`,
} as const;
const SKUS = Object.values(SKU);

/** The ONE place the switch is on: an object literal (module header). */
const AMBIENTE_LIGADO_NO_PROCESSO: AmbienteAmazon = Object.freeze({
  ...AMBIENTE_LIGADO,
  AMAZON_CHAMADAS: 'on',
});

function db(): Firestore {
  return getAdminFirestore();
}

const PRODUTOS = ['simples', 'W', 'M', 'K1', 'K2', 'C', 'WG', 'PAI', 'F', 'A1', 'A2'].map(
  (id) => `produtos/${P}${id}`,
);

/** Everything this file writes, deleted (subcollections included). */
async function limpar(): Promise<void> {
  for (const caminho of [...PRODUTOS, caminhoConta(CONTA)]) {
    await db().recursiveDelete(db().doc(caminho));
  }
}

const produto = (id: string, dados: Record<string, unknown> = {}) =>
  db()
    .doc(`produtos/${P}${id}`)
    .set({ nome: `Produto ${id}`, precos: { varejo: 10 }, ...dados });

/** A link doc naming this conta, carrying a product payload no read may return. */
const vinculo = (
  produtoId: string,
  linkId: string,
  sku: string,
  asin: string,
  dados: Record<string, unknown> = {},
) =>
  db()
    .doc(`produtos/${P}${produtoId}/prodAmazon/${P}${linkId}`)
    .set({
      contaAmazonOuterRef: REF_CONTA,
      sku,
      asin,
      productDataJson: { pesado: 'x'.repeat(256) },
      issues: [],
      ...dados,
    });

const estoque = (produtoId: string, quantidade: number) =>
  db()
    .doc(`produtos/${P}${produtoId}/estoques/${makeEstoqueUid(`${P}${produtoId}`, DEP)}`)
    .set({ depositoOuterRef: REF_DEP, parentId: null, quantidade, quantidadeReservada: 0 });

/** The ASIN each SKU's link and listing carry (placeholders in the fakes' `B0ZZ` form). */
const ASIN: Record<string, string> = {
  [SKU.simples]: 'B0ZZSIMPLE',
  [SKU.wrapper]: 'B0ZZWRAPPE',
  [SKU.kit1]: 'B0ZZKITUMA',
  [SKU.kit2]: 'B0ZZKITDOI',
  [SKU.sumido]: 'B0ZZSUMIDO',
  [SKU.filho]: 'B0ZZFILHOA',
  [SKU.ambiguo]: 'B0ZZAMBIGU',
};

async function semear(): Promise<void> {
  await db().doc(caminhoConta(CONTA)).set({
    tipo: INTEGRACAO_TIPO.amazon,
    nome: 'Conta de teste da avaliação',
    ativo: true,
    padrao: false,
    selling_partner_id: SPID_A,
    depositoOuterRef: REF_DEP,
  });
  await db()
    .doc(caminhoCredencial(CONTA))
    .set(credencialDoc({ expirationDate: Date.now() + 365 * DIA_MS }));
  // A simple produto.
  await produto('simples');
  await vinculo('simples', 'l1', SKU.simples, ASIN[SKU.simples] ?? '');
  await estoque('simples', 4);
  // A family-of-one wrapper: its member owns the stock.
  await produto('W', { paiId: null, filhoUnicoId: `${P}M` });
  await produto('M', { paiId: `${P}W` });
  await vinculo('W', 'l1', SKU.wrapper, ASIN[SKU.wrapper] ?? '');
  await estoque('M', 3);
  // Two kits sharing one component.
  await produto('K1', { ehKit: true, componentesKit: { [`${P}C`]: { quantidade: 2 } } });
  await produto('K2', { ehKit: true, componentesKit: { [`${P}C`]: { quantidade: 3 } } });
  await produto('C');
  await vinculo('K1', 'l1', SKU.kit1, ASIN[SKU.kit1] ?? '');
  await vinculo('K2', 'l1', SKU.kit2, ASIN[SKU.kit2] ?? '');
  await estoque('C', 9);
  // A wrapper whose member is gone.
  await produto('WG', { paiId: null, filhoUnicoId: `${P}MG` });
  await vinculo('WG', 'l1', SKU.sumido, ASIN[SKU.sumido] ?? '');
  // A child link whose parent pointer resolves (another SKU, another ASIN).
  await produto('PAI');
  await vinculo('PAI', 'lp', `${P}SKU-PAI`, 'B0ZZPAIPAI');
  await produto('F');
  await vinculo('F', 'l1', SKU.filho, ASIN[SKU.filho] ?? '', {
    produtoAmazonPaiOuterRef: `documents/produtos/${P}PAI/prodAmazon/${P}lp`,
  });
  await estoque('F', 2);
  // Two live donos for one SKU.
  await produto('A1');
  await produto('A2');
  await vinculo('A1', 'l1', SKU.ambiguo, ASIN[SKU.ambiguo] ?? '');
  await vinculo('A2', 'l1', SKU.ambiguo, ASIN[SKU.ambiguo] ?? '');
}

const listing = (sku: string, quantidade: number) => ({
  sku,
  summaries: [{ marketplaceId: MARKETPLACE_ID_BR, asin: ASIN[sku], productType: 'PRODUCT' }],
  fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: quantidade }],
  relationships: [{ marketplaceId: MARKETPLACE_ID_BR, relationships: [] }],
});

/** What Amazon shows: every SKU listed at 1; the child is left out of the search page. */
const AMAZON = new Map<string, ReturnType<typeof listing>>(
  SKUS.map((sku) => [sku, listing(sku, 1)]),
);
const FORA_DA_BUSCA = new Set<string>([SKU.filho]);

/** A scripted fetch: this file's search and single reads only; everything else refused. */
function fetchRoteirizado() {
  const chamadas: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    const url = new URL(String(input));
    const metodo = init?.method ?? 'GET';
    if (metodo !== 'GET') {
      return Promise.reject(new TypeError(`sem rede: ${metodo} ${url.pathname} não roteirizado`));
    }
    if (url.pathname === CAMINHO_BUSCA) {
      const pedidos = (url.searchParams.get('identifiers') ?? '').split(',');
      chamadas.push(`busca:${pedidos.length}`);
      const items = pedidos
        .filter((s) => AMAZON.has(s) && !FORA_DA_BUSCA.has(s))
        .map((s) => AMAZON.get(s));
      return Promise.resolve(respostaJson(200, { numberOfResults: items.length, items }));
    }
    if (url.pathname.startsWith(`${CAMINHO_BUSCA}/`)) {
      const sku = decodeURIComponent(url.pathname.slice(CAMINHO_BUSCA.length + 1));
      chamadas.push(`get:${sku}`);
      const corpo = AMAZON.get(sku);
      return Promise.resolve(
        corpo === undefined
          ? respostaJson(404, { errors: [{ code: 'NOT_FOUND' }] })
          : respostaJson(200, corpo),
      );
    }
    return Promise.reject(new TypeError(`sem rede: ${metodo} ${url.pathname} não roteirizado`));
  });
  return { fetch, chamadas };
}

/** One `getAll` the evaluator made: its paths, its mask, and the fields each document returned. */
interface LeituraGravada {
  readonly caminhos: readonly string[];
  readonly mascara: readonly string[] | null;
  readonly campos: readonly (readonly string[])[];
}

/** The real database, with every `getAll` recorded (the reads themselves untouched). */
function dbGravado(real: Firestore): { db: Firestore; leituras: LeituraGravada[] } {
  const leituras: LeituraGravada[] = [];
  const proxy = new Proxy(real, {
    get(alvo, chave) {
      if (chave === 'getAll') {
        return async (...args: unknown[]) => {
          const ultimo = args.at(-1);
          const comOpcoes = typeof ultimo === 'object' && ultimo !== null && 'fieldMask' in ultimo;
          const refs = (comOpcoes ? args.slice(0, -1) : args) as DocumentReference[];
          const opcoes = comOpcoes ? (ultimo as ReadOptions) : undefined;
          const snaps = await (opcoes === undefined
            ? alvo.getAll(...refs)
            : alvo.getAll(...refs, opcoes));
          leituras.push({
            caminhos: refs.map((r) => r.path),
            mascara:
              opcoes?.fieldMask === undefined ? null : opcoes.fieldMask.map((f) => String(f)),
            campos: snaps.map((s) => Object.keys(s.data() ?? {}).sort()),
          });
          return snaps;
        };
      }
      const valor: unknown = Reflect.get(alvo, chave, alvo);
      return typeof valor === 'function'
        ? (valor as (...a: unknown[]) => unknown).bind(alvo)
        : valor;
    },
  });
  return { db: proxy, leituras };
}

async function avaliar() {
  expect(process.env.AMAZON_CHAMADAS).not.toBe('on');
  __resetAllReadCaches();
  const { fetch, chamadas } = fetchRoteirizado();
  const log = loggerEspiao();
  let relogio = Date.now();
  const agora = () => relogio;
  const contexto = await loadAmazonContext(db(), CONTA, {
    ambiente: AMBIENTE_LIGADO_NO_PROCESSO,
    agora,
    logger: log.logger,
    fetch,
    gerarCorrelationId: () => `${P}corr`,
  });
  const gravado = dbGravado(db());
  const r = await avaliarSkusEstoqueAmazon(
    {
      contexto,
      db: gravado.db,
      logger: log.logger,
      agora,
      sellerId: SPID_A,
      esperar: (ms) => {
        relogio += ms;
        return Promise.resolve();
      },
    },
    SKUS,
    { depositoId: DEP, prazoMs: relogio + 600_000, maxGets: null },
  );
  return { r, chamadas, leituras: gravado.leituras };
}

function doSku(r: AvaliacaoLoteEstoqueAmazon, sku: string): AvaliacaoSkuEstoqueAmazon {
  if (r.tipo !== 'completa') throw new Error(`esperava completa, veio ${r.tipo}`);
  const achado = r.skus.find((s) => s.sku === sku);
  if (achado === undefined) throw new Error(`sem avaliação de ${sku}`);
  return achado;
}

describe.skipIf(!EMULATED)('the batch evaluator on real Firestore (emulator)', () => {
  beforeEach(async () => {
    await limpar();
    await semear();
  });

  afterAll(async () => {
    await limpar();
  });

  it('★ one batch of every shape: the verdicts, the quantities and the live reads, on the server', async () => {
    const { r, chamadas } = await avaliar();
    expect(r.tipo).toBe('completa');
    expect(doSku(r, SKU.simples)).toMatchObject({
      enviavel: true,
      quantidadeErp: 4,
      quantidadeAmazon: 1,
      semLinha: false,
    });
    expect(doSku(r, SKU.wrapper)).toMatchObject({
      enviavel: true,
      quantidadeErp: 3,
      vinculo: { unidadeId: `${P}M`, donoId: `${P}W` },
    });
    expect(doSku(r, SKU.kit1)).toMatchObject({ enviavel: true, quantidadeErp: 4 });
    expect(doSku(r, SKU.kit2)).toMatchObject({ enviavel: true, quantidadeErp: 3 });
    expect(doSku(r, SKU.sumido)).toMatchObject({ enviavel: false, motivo: 'unidade-ausente' });
    expect(doSku(r, SKU.filho)).toMatchObject({
      enviavel: true,
      quantidadeErp: 2,
      contagens: ['confirmadoPorGet'],
    });
    expect(doSku(r, SKU.ambiguo)).toMatchObject({ enviavel: false, motivo: 'vinculo-ambiguo' });
    // The SKUs a refusal stopped never reached Amazon; the miss was confirmed once.
    expect(chamadas).toEqual(['busca:5', `get:${SKU.filho}`]);
  });

  it('★ every getAll answers ONLY its mask’s fields on the server, and each produto is read once', async () => {
    const { r, leituras } = await avaliar();
    expect(r.tipo).toBe('completa');
    // Positive first: the reads happened, every one of them masked.
    expect(leituras.length).toBeGreaterThan(0);
    for (const l of leituras) {
      expect(l.mascara, l.caminhos.join(',')).not.toBeNull();
      for (const campos of l.campos) {
        for (const campo of campos) expect(l.mascara, campo).toContain(campo);
      }
    }
    const todosOsCampos = new Set(leituras.flatMap((l) => l.campos.flat()));
    for (const proibido of ['productDataJson', 'nome', 'precos', 'issues']) {
      expect(todosOsCampos.has(proibido), proibido).toBe(false);
    }
    // The kits' shared component row came back with its quantity (the mask held it).
    expect(todosOsCampos.has('quantidade')).toBe(true);
    const produtosLidos = leituras
      .flatMap((l) => l.caminhos)
      .filter((c) => /^produtos\/[^/]+$/.test(c));
    expect(produtosLidos.length).toBe(new Set(produtosLidos).size);
    const linhaDoComponente = `produtos/${P}C/estoques/${makeEstoqueUid(`${P}C`, DEP)}`;
    expect(leituras.flatMap((l) => l.caminhos).filter((c) => c === linhaDoComponente)).toHaveLength(
      1,
    );
  });

  it('★ parity on the server: each SKU’s link verdict is the one the patch task’s resolver reads alone', async () => {
    const { r } = await avaliar();
    for (const sku of SKUS) {
      const sozinho = avaliarVinculoEstoqueAmazon(await lerVinculoEstoqueAmazon(db(), CONTA, sku));
      const lote = doSku(r, sku);
      if (sozinho.apto) expect(lote.vinculo, sku).toEqual(sozinho);
      else expect(lote, sku).toMatchObject({ enviavel: false, motivo: sozinho.motivo });
    }
  });
});
