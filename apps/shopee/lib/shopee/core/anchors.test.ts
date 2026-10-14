import { describe, expect, it } from 'vitest';

import { type DocData, FakeDb, asDb } from '../testing/fakeDb';
import { anchorDoProduto, conferirContabilidadePorAnchor, resolverAnchorsShopee } from './anchors';

/**
 * `core/anchors.ts` (#1529, step 21 — reconcile §4 S5, S6). The stock and status
 * suites pin what each push DOES with a resolved child; this one pins the rule,
 * the one batch read and the accounting on their own.
 */

/* -------------------------------------------------------------------------- */
/*   Fixtures — invented ids only.                                            */
/* -------------------------------------------------------------------------- */

const ANCORA = 'prod-ancora';
const FILHO = 'prod-filho';
const OUTRO = 'prod-outro';
const TAG = '[teste] contabilidade';

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

/* -------------------------------------------------------------------------- */
/*  S5 — the rule                                                             */
/* -------------------------------------------------------------------------- */

describe('anchorDoProduto — a regra de um salto', () => {
  it('PAR: um paiId que nomeia um documento é a âncora', () => {
    expect(anchorDoProduto(FILHO, { paiId: ANCORA })).toBe(ANCORA);
  });

  it.each([
    ['vazio', ''],
    ['com separador', 'a/b'],
    ['relativo', '..'],
    ['número', 42],
    ['null', null],
    ['booleano verdadeiro', true],
  ])(
    '⚠️ (S5) QUASE-PAR: paiId %s ⇒ o produto é a PRÓPRIA âncora (nunca uma dobra por truthiness)',
    (_nome, paiId) => {
      expect(anchorDoProduto(FILHO, { paiId })).toBe(FILHO);
    },
  );

  it('sem paiId, ou sem dados, o produto é a própria âncora', () => {
    expect(anchorDoProduto(ANCORA, { nome: 'Camiseta' })).toBe(ANCORA);
    expect(anchorDoProduto(ANCORA, undefined)).toBe(ANCORA);
  });
});

/* -------------------------------------------------------------------------- */
/*  the one batch read                                                        */
/* -------------------------------------------------------------------------- */

describe('resolverAnchorsShopee — UMA leitura em lote, mascarada', () => {
  it('lê os pedidos DEDUPLICADOS em UM getAll mascarado em nome + paiId, nada além', async () => {
    const db = new FakeDbComLote();
    db.seed(`produtos/${ANCORA}`, { nome: 'Camiseta', paiId: null, precos: { x: 1 } });
    db.seed(`produtos/${FILHO}`, { nome: 'Camiseta P', paiId: ANCORA, sku: 'CAM-P' });

    const r = await resolverAnchorsShopee(asDb(db), [FILHO, ANCORA, FILHO]);

    expect(db.leiturasEmLote).toEqual([{ ids: [FILHO, ANCORA], campos: ['nome', 'paiId'] }]);
    // A child and its own anchor are ONE family, in first-seen order.
    expect(r.anchorIds).toEqual([ANCORA]);
    expect([...r.anchorDe]).toEqual([
      [FILHO, ANCORA],
      [ANCORA, ANCORA],
    ]);
    expect([...r.nomeDe]).toEqual([
      [FILHO, 'Camiseta P'],
      [ANCORA, 'Camiseta'],
    ]);
    expect(r.naoEncontrados).toEqual([]);
  });

  it('as âncoras saem na ordem do PRIMEIRO pedido que as nomeia', async () => {
    const db = new FakeDbComLote();
    db.seed(`produtos/${OUTRO}`, { nome: 'Outro', paiId: null });
    db.seed(`produtos/${ANCORA}`, { nome: 'Camiseta', paiId: null });
    db.seed(`produtos/${FILHO}`, { nome: 'Camiseta P', paiId: ANCORA });

    const r = await resolverAnchorsShopee(asDb(db), [FILHO, OUTRO, ANCORA]);

    expect(r.anchorIds).toEqual([ANCORA, OUTRO]);
  });

  it('um pedido sem documento vai para naoEncontrados e não entra em anchorDe nem em nomeDe', async () => {
    const db = new FakeDbComLote();
    db.seed(`produtos/${ANCORA}`, { nome: 'Camiseta', paiId: null });

    const r = await resolverAnchorsShopee(asDb(db), ['prod-fantasma', ANCORA]);

    expect(r.naoEncontrados).toEqual(['prod-fantasma']);
    expect(r.anchorDe.has('prod-fantasma')).toBe(false);
    expect(r.nomeDe.has('prod-fantasma')).toBe(false);
    expect(r.anchorIds).toEqual([ANCORA]);
  });

  it('um filho cujo paiId nomeia um documento AUSENTE ainda resolve nele — um salto, sem segunda leitura', async () => {
    const db = new FakeDbComLote();
    db.seed(`produtos/${FILHO}`, { nome: 'Órfão', paiId: 'prod-pai-apagado' });

    const r = await resolverAnchorsShopee(asDb(db), [FILHO]);

    expect(r.anchorDe.get(FILHO)).toBe('prod-pai-apagado');
    expect(r.anchorIds).toEqual(['prod-pai-apagado']);
    expect(db.leiturasEmLote).toHaveLength(1);
  });

  it('um nome em branco é AUSÊNCIA (null), nunca um rótulo vazio', async () => {
    const db = new FakeDbComLote();
    db.seed(`produtos/${ANCORA}`, { nome: '   ', paiId: null });
    db.seed(`produtos/${OUTRO}`, { nome: 7, paiId: null });

    const r = await resolverAnchorsShopee(asDb(db), [ANCORA, OUTRO]);

    expect(r.nomeDe.get(ANCORA)).toBeNull();
    expect(r.nomeDe.get(OUTRO)).toBeNull();
  });

  it('uma seleção vazia não lê nada (getAll sem referência rejeita)', async () => {
    const db = new FakeDbComLote();

    const r = await resolverAnchorsShopee(asDb(db), []);

    expect(r).toEqual({
      anchorIds: [],
      anchorDe: new Map(),
      nomeDe: new Map(),
      naoEncontrados: [],
    });
    expect(db.leiturasEmLote).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  S6 — the accounting                                                       */
/* -------------------------------------------------------------------------- */

describe('conferirContabilidadePorAnchor — S6', () => {
  const anchorDe = new Map([
    [FILHO, ANCORA],
    [ANCORA, ANCORA],
    [OUTRO, OUTRO],
  ]);

  it('PAR: filho e âncora cobertos pelas linhas da âncora, o outro sem envio — passa', () => {
    expect(() =>
      conferirContabilidadePorAnchor(TAG, [FILHO, ANCORA, OUTRO], anchorDe, new Set([ANCORA]), [
        OUTRO,
      ]),
    ).not.toThrow();
  });

  it('PAR: um pedido sem documento (fora de anchorDe) coberto pela própria entrada sem envio — passa', () => {
    expect(() =>
      conferirContabilidadePorAnchor(TAG, ['prod-fantasma'], new Map(), new Set(), [
        'prod-fantasma',
      ]),
    ).not.toThrow();
  });

  it.each([
    ['nas DUAS listas', [FILHO], new Set([ANCORA]), [FILHO], /aparece nas DUAS listas/],
    ['em NENHUMA lista', [FILHO, OUTRO], new Set([ANCORA]), [], /prod-outro foi solicitado/],
    [
      'uma âncora PERDIDA nas linhas',
      [OUTRO],
      new Set([OUTRO, ANCORA]),
      [],
      /a âncora prod-ancora aparece nas linhas/,
    ],
    [
      'um sem envio que ninguém pediu',
      [ANCORA],
      new Set([ANCORA]),
      [OUTRO],
      /prod-outro não foi solicitado/,
    ],
    ['um sem envio DUPLICADO', [OUTRO], new Set<string>(), [OUTRO, OUTRO], /DUAS vezes/],
    [
      'um pedido sem documento que NÃO está entre os sem envio',
      ['prod-fantasma'],
      new Set<string>(),
      [],
      /prod-fantasma foi solicitado/,
    ],
  ])(
    '⚠️ (S6) %s ⇒ LANÇA, com a etiqueta do chamador',
    (_nome, solicitados, linhas, semEnvio, re) => {
      const chamada = () =>
        conferirContabilidadePorAnchor(TAG, solicitados, anchorDe, linhas, semEnvio);
      expect(chamada).toThrow(re);
      expect(chamada).toThrow(TAG);
    },
  );
});
