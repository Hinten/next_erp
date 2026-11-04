import { describe, expect, it } from 'vitest';

import { type DocData, FakeDb, asDb } from '../testing/fakeDb';
import { lerNomesDosProdutos } from './nomesDosProdutos';

/**
 * `lerNomesDosProdutos` (#1529, step 21) — the `nome` / `sku` join the report
 * route and the manual push share. The report route's own suite stays UNEDITED
 * across the move (reconcile K9); this one pins the helper on its own.
 */

/**
 * The shared double plus the ONE Admin-SDK read it does not model —
 * `Firestore.getAll(...refs, { fieldMask })`, with a real mask. Extended HERE
 * (the price suites' rule), never in `testing/fakeDb.ts`.
 */
class FakeDbComLote extends FakeDb {
  /** Every `getAll`: the ids read and the mask. */
  readonly leiturasEmLote: { ids: string[]; campos: string[] | null }[] = [];

  getAll(...args: unknown[]) {
    const ultimo = args[args.length - 1];
    const opcoes =
      typeof ultimo === 'object' && ultimo !== null && 'fieldMask' in ultimo
        ? (ultimo as { fieldMask: string[] })
        : null;
    const refs = (opcoes === null ? args : args.slice(0, -1)) as {
      id: string;
      get: () => Promise<{ exists: boolean; data: () => DocData | undefined }>;
    }[];
    const campos = opcoes?.fieldMask ?? null;
    this.leiturasEmLote.push({ ids: refs.map((r) => r.id), campos });
    return Promise.all(
      refs.map(async (ref) => {
        const snap = await ref.get();
        const dados = snap.data();
        return {
          id: ref.id,
          exists: snap.exists,
          data: () => {
            if (!snap.exists || dados === undefined) return undefined;
            if (campos === null) return dados;
            const saida: DocData = {};
            for (const c of campos) if (Object.hasOwn(dados, c)) saida[c] = dados[c];
            return saida;
          },
        };
      }),
    );
  }
}

describe('lerNomesDosProdutos', () => {
  it('lê os ids DISTINTOS uma vez, mascarados em nome + sku', async () => {
    const db = new FakeDbComLote();
    db.seed('produtos/prod-p', { nome: 'Camiseta P', sku: 'CAM-P', precos: { x: 1 } });
    db.seed('produtos/prod-m', { nome: 'Camiseta M', sku: 'CAM-M' });

    const nomes = await lerNomesDosProdutos(asDb(db), ['prod-p', 'prod-m', 'prod-p']);

    expect(db.leiturasEmLote).toEqual([{ ids: ['prod-p', 'prod-m'], campos: ['nome', 'sku'] }]);
    expect([...nomes]).toEqual([
      ['prod-p', { nome: 'Camiseta P', sku: 'CAM-P' }],
      ['prod-m', { nome: 'Camiseta M', sku: 'CAM-M' }],
    ]);
  });

  it('⚠️ um produto AUSENTE é dado, não erro: simplesmente fica fora do mapa', async () => {
    const db = new FakeDbComLote();
    db.seed('produtos/prod-p', { nome: 'Camiseta P', sku: 'CAM-P' });

    const nomes = await lerNomesDosProdutos(asDb(db), ['prod-fantasma', 'prod-p']);

    expect(nomes.has('prod-fantasma')).toBe(false);
    expect(nomes.get('prod-p')).toEqual({ nome: 'Camiseta P', sku: 'CAM-P' });
  });

  it('um campo que não é texto lê null — o nome e o sku independentes um do outro', async () => {
    const db = new FakeDbComLote();
    db.seed('produtos/prod-p', { nome: 42, sku: 'CAM-P' });
    db.seed('produtos/prod-m', { nome: 'Camiseta M' });

    const nomes = await lerNomesDosProdutos(asDb(db), ['prod-p', 'prod-m']);

    expect(nomes.get('prod-p')).toEqual({ nome: null, sku: 'CAM-P' });
    expect(nomes.get('prod-m')).toEqual({ nome: 'Camiseta M', sku: null });
  });

  it('uma lista vazia não lê nada (getAll sem referência rejeita)', async () => {
    const db = new FakeDbComLote();

    const nomes = await lerNomesDosProdutos(asDb(db), []);

    expect(nomes.size).toBe(0);
    expect(db.leiturasEmLote).toEqual([]);
  });

  it('em lotes de 300: 301 ids distintos custam DUAS leituras, e nenhum se perde', async () => {
    const db = new FakeDbComLote();
    const ids = Array.from({ length: 301 }, (_v, i) => `prod-${String(i)}`);
    for (const id of ids) db.seed(`produtos/${id}`, { nome: id, sku: null });

    const nomes = await lerNomesDosProdutos(asDb(db), ids);

    expect(db.leiturasEmLote.map((l) => l.ids.length)).toEqual([300, 1]);
    expect(nomes.size).toBe(301);
    expect(nomes.get('prod-300')).toEqual({ nome: 'prod-300', sku: null });
  });
});
