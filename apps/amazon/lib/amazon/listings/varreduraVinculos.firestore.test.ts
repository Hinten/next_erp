/**
 * The shared walk and page core on a REAL Firestore — the emulator of
 * `ci-amazon.yml`: the server's key order, its `startAfter` cursor across a
 * full page, and the stateless smallest-path dedupe — a SKU whose two link docs
 * sit on two pages is evaluated on exactly ONE of them, for both flows.
 *
 * ⚠️ The emulator is SHARED (`vitest.tasks.config.ts`'s rules): every document
 * id here starts with `e2e-listings-varredura-`, which no other suite seeds; no
 * `integracao` document is written (the walk never reads the conta), so no
 * trigger fires. Every case wipes what it reads first, and the file leaves
 * nothing behind. Nothing calls Amazon and nothing is enqueued.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { FLUXO_LISTING_AMAZON } from './fluxoListing';
import { camposDoResolverListingAmazon } from './resolverVinculo';
import {
  CONTADOR_VARREDURA_VINCULOS_AMAZON,
  type CursoresVarreduraVinculosAmazon,
  PAGINA_VARREDURA_VINCULOS_AMAZON,
  paginaVarreduraVinculosAmazon,
  varreduraVinculosConcluida,
} from './varreduraVinculos';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const P = 'e2e-listings-varredura-';
const CONTA = `${P}conta`;
const REF_CONTA = `documents/integracao/${CONTA}`;
const SKU_X = `${P}SKU-X`;
/** The three produtos every link doc sits under, in key order. */
const PRODUTOS = [`${P}a`, `${P}f`, `${P}z`];

const INICIO: CursoresVarreduraVinculosAmazon = {
  canonica: { ultimoCaminho: null, concluida: false },
  nua: { ultimoCaminho: null, concluida: false },
};

function db(): Firestore {
  return getAdminFirestore();
}

async function limpar(): Promise<void> {
  for (const id of PRODUTOS) await db().recursiveDelete(db().doc(`produtos/${id}`));
}

/**
 * SKU X under `<P>a` (the smallest path), a full page of fillers under `<P>f`,
 * and SKU X again under `<P>z`: the walk's first page ends inside the fillers.
 */
async function semear(): Promise<void> {
  const lote = db().batch();
  const link = (produtoId: string, linkId: string, sku: string) =>
    lote.set(db().doc(`produtos/${produtoId}/prodAmazon/${linkId}`), {
      contaAmazonOuterRef: REF_CONTA,
      sku,
      productDataJson: { pesado: 'x'.repeat(64) },
    });
  link(`${P}a`, 'l', SKU_X);
  for (let i = 0; i < PAGINA_VARREDURA_VINCULOS_AMAZON; i += 1) {
    const n = String(i).padStart(3, '0');
    link(`${P}f`, `l${n}`, `${P}SKU-F${n}`);
  }
  link(`${P}z`, 'l', SKU_X);
  await lote.commit();
}

describe.skipIf(!EMULATED)('the shared walk on real Firestore (emulator)', () => {
  beforeEach(async () => {
    await limpar();
    await semear();
  });

  afterAll(async () => {
    await limpar();
  });

  it.each([FLUXO_LISTING_AMAZON.estoque, FLUXO_LISTING_AMAZON.preco])(
    '★ %s: a SKU straddling the page boundary is evaluated on the page of its smallest path and counted ja-visto on the other',
    async (fluxo) => {
      const agora = Date.now();
      const opcoes = {
        campos:
          fluxo === FLUXO_LISTING_AMAZON.estoque
            ? camposDoResolverListingAmazon({ fluxo })
            : camposDoResolverListingAmazon({ fluxo, tabelaIds: [] }),
        prazo: { agora: () => agora, prazoMs: agora + 600_000 },
      };
      const p1 = await paginaVarreduraVinculosAmazon(db(), CONTA, INICIO, opcoes);
      if (p1.tipo !== 'pagina') throw new Error(`a primeira página: ${p1.motivo}`);
      expect(p1.vinculos).toBe(PAGINA_VARREDURA_VINCULOS_AMAZON);
      expect(p1.aAvaliar).toContain(SKU_X);
      expect(varreduraVinculosConcluida(p1.cursores)).toBe(false);

      const p2 = await paginaVarreduraVinculosAmazon(db(), CONTA, p1.cursores, opcoes);
      if (p2.tipo !== 'pagina') throw new Error(`a segunda página: ${p2.motivo}`);
      expect(p2.skus).toContain(SKU_X);
      expect(p2.aAvaliar).not.toContain(SKU_X);
      expect(p2.porChave[CONTADOR_VARREDURA_VINCULOS_AMAZON.jaVisto]).toBe(1);
      expect(varreduraVinculosConcluida(p2.cursores)).toBe(true);

      const avaliados = [...p1.aAvaliar, ...p2.aAvaliar];
      expect(avaliados.filter((s) => s === SKU_X)).toHaveLength(1);
      expect(avaliados).toHaveLength(PAGINA_VARREDURA_VINCULOS_AMAZON + 1);
      // The dedupe's reads never bring the link payload back.
      for (const leitura of [...p1.vinculosLidos.values(), ...p2.vinculosLidos.values()]) {
        if (leitura.tipo !== 'docs') continue;
        for (const d of leitura.docs) expect(d.dados).not.toHaveProperty('productDataJson');
      }
    },
  );
});
