/**
 * The shared manual selection read on a REAL Firestore — the emulator of
 * `ci-amazon.yml`: the one-hop anchor, the children seek ordered by `nome`, the
 * projected partition listings and the conta's SKUs in both ref forms, as the
 * server answers them.
 *
 * ⚠️ The emulator is SHARED (`vitest.tasks.config.ts`'s rules): every document
 * id here starts with `e2e-listings-selecao-`, which no other suite seeds; no
 * `integracao` document is written (the selection never reads the conta), so
 * no trigger fires. Every case wipes what it reads first, and the file leaves
 * nothing behind. Nothing calls Amazon and nothing is enqueued.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { lerSelecaoManualAmazon } from './selecaoManual';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const P = 'e2e-listings-selecao-';
const CONTA = `${P}conta`;
const CANONICA = `documents/integracao/${CONTA}`;
const NUA = `integracao/${CONTA}`;
const PRODUTOS = ['A', 'C1', 'C2', 'SOLTO', 'ORFAO'];

function db(): Firestore {
  return getAdminFirestore();
}

async function limpar(): Promise<void> {
  for (const id of PRODUTOS) await db().recursiveDelete(db().doc(`produtos/${P}${id}`));
}

const produto = (id: string, dados: Record<string, unknown> = {}) =>
  db()
    .doc(`produtos/${P}${id}`)
    .set({ nome: `Produto ${id}`, precos: { t: { valor: 1 } }, ...dados });

const vinculo = (produtoId: string, linkId: string, sku: string, conta: string) =>
  db()
    .doc(`produtos/${P}${produtoId}/prodAmazon/${linkId}`)
    .set({ contaAmazonOuterRef: conta, sku, productDataJson: { pesado: 'x'.repeat(64) } });

describe.skipIf(!EMULATED)('the shared manual selection on real Firestore (emulator)', () => {
  beforeEach(async () => {
    await limpar();
    await produto('A');
    await produto('C1', { paiId: `${P}A` });
    await produto('C2', { paiId: `${P}A` });
    await produto('ORFAO', { paiId: `${P}NINGUEM` });
    await vinculo('A', 'la', `${P}SKU-A`, CANONICA);
    await vinculo('C1', 'l1', `${P}SKU-C1`, NUA);
    await vinculo('C2', 'l2', `${P}SKU-C2`, CANONICA);
    await vinculo('C2', 'l3', `${P}SKU-C2`, NUA);
    await vinculo('C2', 'l4', `${P}SKU-OUTRA`, 'documents/integracao/outra-conta');
  });

  afterAll(async () => {
    await limpar();
  });

  it('★ a child hops to its anchor; the anchor’s family gives the conta’s SKUs in both ref forms, sorted and deduplicated, labelled by the anchor', async () => {
    const s = await lerSelecaoManualAmazon(db(), CONTA, [`${P}C1`, `${P}SOLTO`, `${P}ORFAO`]);
    expect([...s.ancoraDe]).toEqual([
      [`${P}C1`, `${P}A`],
      [`${P}ORFAO`, `${P}NINGUEM`],
    ]);
    expect([...s.skusDaAncora]).toEqual([[`${P}A`, [`${P}SKU-A`, `${P}SKU-C1`, `${P}SKU-C2`]]]);
    expect(s.nomeDe.get(`${P}A`)).toBe('Produto A');
    // A produto with no document has no anchor; an anchor with no document is ausente.
    expect(s.ancoraDe.has(`${P}SOLTO`)).toBe(false);
    expect(s.ancorasAusentes).toEqual(new Set([`${P}NINGUEM`]));
  });
});
