/**
 * The shared batched link reader on a REAL Firestore — the emulator of
 * `ci-amazon.yml` — with the PRICE masks: each tabela's `precos` entry read as
 * a two-segment path, which the offline fake db does not model. It proves on
 * the server:
 *
 *  - PARITY: every SKU's verdict, verdict input and unit parent are exactly
 *    what the per-SKU reader (`resolverVinculo.ts`) gives alone, at the price
 *    masks;
 *  - the NESTED masks: a unit and a parent come back with ONLY the asked
 *    tabelas' entries (a tabela id holding a dot is ONE key), never another
 *    tabela, the label or the link payload;
 *  - the parent is read only for a unit that has a `paiId`, once however many
 *    units share it.
 *
 * ⚠️ The emulator is SHARED (`vitest.tasks.config.ts`'s rules): every document
 * id here starts with `e2e-listings-lote-`, which no other suite seeds; no
 * `integracao` document is written (the reader never reads the conta), so no
 * trigger fires. Every case wipes what it reads first, and the file leaves
 * nothing behind. Nothing calls Amazon and nothing is enqueued.
 */
import type { DocumentReference, Firestore, ReadOptions } from 'firebase-admin/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { FLUXO_LISTING_AMAZON } from './fluxoListing';
import { avaliarVinculosEmLoteAmazon } from './avaliacaoLoteVinculos';
import { camposDoResolverListingAmazon, lerVinculoListingAmazon } from './resolverVinculo';
import {
  type EnvioDoVinculoListingAmazon,
  type RegraVinculoListingAmazon,
  avaliarVinculoListingAmazon,
} from './vinculoListing';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const P = 'e2e-listings-lote-';
const CONTA = `${P}conta`;
const REF_CONTA = `documents/integracao/${CONTA}`;
/** The conta's two tabelas: the second id holds a dot, and must read as ONE key. */
const NORMAL = `${P}normal`;
const PROMO = `${P}pro.mo`;
const OUTRA = `${P}outra`;
const CAMPOS = camposDoResolverListingAmazon({
  fluxo: FLUXO_LISTING_AMAZON.preco,
  tabelaIds: [NORMAL, PROMO],
});
const REGRA: RegraVinculoListingAmazon<EnvioDoVinculoListingAmazon> = {
  fluxo: FLUXO_LISTING_AMAZON.preco,
  lerEnvio: () => null,
};

const SKU = {
  simples: `${P}SKU-SIMPLES`,
  filho: `${P}SKU-FILHO`,
  filho2: `${P}SKU-FILHO2`,
  wrapper: `${P}SKU-WRAPPER`,
  kit: `${P}SKU-KIT`,
  ambiguo: `${P}SKU-AMBIGUO`,
} as const;
const SKUS = Object.values(SKU);

const PRODUTOS = ['S', 'PAI', 'F', 'F2', 'W', 'M', 'K', 'KM', 'A1', 'A2'];

function db(): Firestore {
  return getAdminFirestore();
}

async function limpar(): Promise<void> {
  for (const id of PRODUTOS) await db().recursiveDelete(db().doc(`produtos/${P}${id}`));
}

/** A produto with three tabelas' prices, the dotted one beside a NESTED look-alike. */
const produto = (id: string, dados: Record<string, unknown> = {}) =>
  db()
    .doc(`produtos/${P}${id}`)
    .set({
      nome: `Produto ${id}`,
      precos: {
        [NORMAL]: { valor: 10 },
        [PROMO]: { valor: 8 },
        [OUTRA]: { valor: 99 },
        [`${P}pro`]: { mo: { valor: 1 } },
      },
      ...dados,
    });

const vinculo = (produtoId: string, sku: string, asin: string) =>
  db()
    .doc(`produtos/${P}${produtoId}/prodAmazon/${P}l1`)
    .set({
      contaAmazonOuterRef: REF_CONTA,
      sku,
      asin,
      productDataJson: { pesado: 'x'.repeat(256) },
      envioPrecoAmazon: { emMs: 1 },
      envioEstoqueAmazon: { emMs: 2 },
    });

async function semear(): Promise<void> {
  await produto('S');
  await vinculo('S', SKU.simples, 'B0ZZSIMPLE');
  // Two variation children of one parent, which propagates.
  await produto('PAI', { propagatePriceToChildren: true });
  await produto('F', { paiId: `${P}PAI` });
  await produto('F2', { paiId: `${P}PAI` });
  await vinculo('F', SKU.filho, 'B0ZZFILHOA');
  await vinculo('F2', SKU.filho2, 'B0ZZFILHOB');
  // A family-of-one wrapper: its member is the unit, the wrapper its parent.
  await produto('W', { paiId: null, filhoUnicoId: `${P}M`, propagatePriceToChildren: false });
  await produto('M', { paiId: `${P}W` });
  await vinculo('W', SKU.wrapper, 'B0ZZWRAPPE');
  // A kit root and its mirror: no parent.
  await produto('K', { ehKit: true, paiId: null, filhoUnicoId: `${P}KM` });
  await produto('KM', { paiId: `${P}K` });
  await vinculo('K', SKU.kit, 'B0ZZKITKIT');
  // Two live donos.
  await produto('A1');
  await produto('A2');
  await vinculo('A1', SKU.ambiguo, 'B0ZZAMBIGU');
  await vinculo('A2', SKU.ambiguo, 'B0ZZAMBIGU');
}

/** One `getAll` made: its paths and the fields each document returned. */
interface LeituraGravada {
  readonly caminhos: readonly string[];
  readonly dados: readonly Readonly<Record<string, unknown>>[];
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
          const snaps = await (comOpcoes
            ? alvo.getAll(...refs, ultimo as ReadOptions)
            : alvo.getAll(...refs));
          leituras.push({
            caminhos: refs.map((r) => r.path),
            dados: snaps.map((s) => s.data() ?? {}),
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
  const gravado = dbGravado(db());
  const agora = Date.now();
  const r = await avaliarVinculosEmLoteAmazon(gravado.db, CONTA, SKUS, {
    campos: CAMPOS,
    regra: REGRA,
    prazo: { agora: () => agora, prazoMs: agora + 600_000 },
  });
  if (r.tipo !== 'completa') throw new Error(`esperava completa, veio ${r.tipo}`);
  return { r, leituras: gravado.leituras };
}

describe.skipIf(!EMULATED)(
  'the batched link reader on real Firestore, price masks (emulator)',
  () => {
    beforeEach(async () => {
      await limpar();
      await semear();
    });

    afterAll(async () => {
      await limpar();
    });

    it('★ parity on the server: each SKU’s verdict, input and unit parent are the per-SKU reader’s, at the price masks', async () => {
      const { r } = await avaliar();
      expect(r.skus.map((s) => s.sku).sort()).toEqual([...SKUS].sort());
      for (const s of r.skus) {
        const sozinho = await lerVinculoListingAmazon(db(), CONTA, s.sku, CAMPOS);
        expect(s.entrada, s.sku).toEqual(sozinho.entrada);
        expect(s.paiDaUnidade, s.sku).toEqual(sozinho.paiDaUnidade);
        expect(s.veredicto, s.sku).toEqual(avaliarVinculoListingAmazon(sozinho.entrada, REGRA));
      }
      // Anti-vacuity: the shapes do reach the verdicts and the parents they name.
      const doSku = (sku: string) => r.skus.find((s) => s.sku === sku);
      expect(doSku(SKU.ambiguo)?.veredicto).toEqual({ apto: false, motivo: 'vinculo-ambiguo' });
      expect(doSku(SKU.wrapper)?.veredicto).toMatchObject({ apto: true, unidadeId: `${P}M` });
      expect(doSku(SKU.filho)?.paiDaUnidade).toEqual({
        id: `${P}PAI`,
        raw: {
          precos: { [NORMAL]: { valor: 10 }, [PROMO]: { valor: 8 } },
          propagatePriceToChildren: true,
        },
      });
      expect(doSku(SKU.wrapper)?.paiDaUnidade).toMatchObject({
        id: `${P}W`,
        raw: { propagatePriceToChildren: false },
      });
      expect(doSku(SKU.simples)?.paiDaUnidade).toBeNull();
      expect(doSku(SKU.kit)?.paiDaUnidade).toBeNull();
    });

    it('★ the nested masks on the server: ONLY the asked tabelas’ entries come back — a dotted tabela id is one key, never its nested look-alike', async () => {
      const { r } = await avaliar();
      const unidade = r.skus.find((s) => s.sku === SKU.simples)?.unidade;
      expect(unidade).toEqual({ precos: { [NORMAL]: { valor: 10 }, [PROMO]: { valor: 8 } } });
      // NEAR-MISS: the other tabela, the nested `<P>pro.mo` look-alike and the label never come back.
      const precos = (unidade?.precos ?? {}) as Record<string, unknown>;
      expect(Object.keys(precos).sort()).toEqual([NORMAL, PROMO].sort());
      expect(unidade).not.toHaveProperty('nome');
    });

    it('★ the parent is read only for a unit with a paiId, once however many units share it; no read returns a link payload', async () => {
      const { leituras } = await avaliar();
      const lidos = leituras.flatMap((l) => l.caminhos);
      const contar = (caminho: string) => lidos.filter((c) => c === caminho).length;
      // PAI is two units' parent: read ONCE as a parent (it is no dono or unit here).
      expect(contar(`produtos/${P}PAI`)).toBe(1);
      // W is a dono AND its member's parent: one dono read, one parent read.
      expect(contar(`produtos/${P}W`)).toBe(2);
      // NEAR-MISS: the kit root and the simple produto name no parent: each is
      // read exactly twice (as a dono, then as its own unit at the nested mask,
      // which no dono's read carries), never a third time as a parent.
      expect(contar(`produtos/${P}K`)).toBe(2);
      expect(contar(`produtos/${P}S`)).toBe(2);
      for (const l of leituras) {
        for (const d of l.dados) {
          expect(d).not.toHaveProperty('productDataJson');
          expect(d).not.toHaveProperty('nome');
        }
      }
    });
  },
);
