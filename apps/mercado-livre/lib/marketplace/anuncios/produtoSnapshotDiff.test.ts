import { describe, expect, it } from 'vitest';

import {
  CAMPOS_ROUND_TRIP,
  CAMPOS_VOLATEIS,
  diffSnapshots,
  same,
  type ProdutoDump,
  type Snapshot,
} from './produtoSnapshotDiff';

/**
 * ⚠️ A checker needs TWO controls: a known-BAD input must fail AND a known-GOOD
 * input must pass. Only the pair rules out the two ways this can be useless —
 * a diff that reports everything, and one that reports nothing.
 */

function dump(produto: Record<string, unknown>, link?: Record<string, unknown>): ProdutoDump {
  return {
    produtoId: 'p1',
    produto,
    subcolecoes: link ? { produtoMercadoLivre: [{ id: 'l1', data: link }] } : {},
  };
}

function snap(raiz: ProdutoDump, filhos: ProdutoDump[] = []): Snapshot {
  return {
    versao: 1,
    capturadoEm: '2026-08-26T00:00:00.000Z',
    projectId: 'demo',
    integracaoId: 'i1',
    itemId: 'MLB1',
    raiz,
    filhos,
  };
}

const PRODUTO_BASE = {
  nome: 'Vaso Decorativo',
  sku: 'vaso123',
  pesoLiquidoKg: 2.4,
  alturaCm: 32,
  larguraCm: 18,
  profundidadeCm: 14,
  ehKit: false,
};

const LINK_BASE = {
  id: 'MLB1',
  category_id: 'MLB1637',
  estado: 'a',
  status: 'active',
  attributes: [{ id: 'BRAND', value_name: 'Genérica' }],
};

describe('diffSnapshots — control A: a produto compared with itself', () => {
  it('reports ZERO findings when nothing changed', () => {
    const s = snap(dump({ ...PRODUTO_BASE }, { ...LINK_BASE }));
    const r = diffSnapshots(s, s);
    expect(r.achados).toEqual([]);
    expect(r.conhecidas).toEqual([]);
  });

  it('still reports zero when only VOLATILE fields moved', () => {
    // The doc id, the clocks and the trigger-maintained denorms always differ
    // after a re-import. If these leaked into the findings the report would be
    // noise on every single run.
    const antes = snap({
      ...dump({ ...PRODUTO_BASE, timestamp: 1, ultimaModificacao: 1 }, { ...LINK_BASE }),
      produtoId: 'antigo',
    });
    const depois = snap({
      ...dump(
        {
          ...PRODUTO_BASE,
          timestamp: 999,
          ultimaModificacao: 999,
          integracoesComProduto: ['i1'],
        },
        { ...LINK_BASE, contaOuterRef: 'documents/integracao/i1' },
      ),
      produtoId: 'novo',
    });
    expect(diffSnapshots(antes, depois).achados).toEqual([]);
  });
});

describe('diffSnapshots — control B: a real round-trip loss', () => {
  it('reports a produto field the import failed to restore', () => {
    const antes = snap(dump({ ...PRODUTO_BASE }, { ...LINK_BASE }));
    const depois = snap(dump({ ...PRODUTO_BASE, pesoLiquidoKg: null }, { ...LINK_BASE }));

    const r = diffSnapshots(antes, depois);
    expect(r.achados.map((a) => a.campo)).toEqual(['pesoLiquidoKg']);
    expect(r.achados[0]!.bucket).toBe('ausente');
  });

  it('reports a CHANGED value as divergente, not ausente', () => {
    const antes = snap(dump({ ...PRODUTO_BASE }, { ...LINK_BASE }));
    const depois = snap(dump({ ...PRODUTO_BASE, nome: 'Outro nome' }, { ...LINK_BASE }));

    const r = diffSnapshots(antes, depois);
    expect(r.achados.map((a) => a.campo)).toEqual(['nome']);
    expect(r.achados[0]!.bucket).toBe('divergente');
  });

  it('reports a link-doc field the import dropped', () => {
    const antes = snap(dump({ ...PRODUTO_BASE }, { ...LINK_BASE }));
    const depois = snap(
      dump({ ...PRODUTO_BASE }, { ...LINK_BASE, attributes: [{ id: 'BRAND', value_name: 'X' }] }),
    );
    expect(diffSnapshots(antes, depois).achados.map((a) => a.campo)).toEqual(['attributes']);
  });

  it('reports a LOST variation child', () => {
    const filho = dump({ ...PRODUTO_BASE, sku: 'v1' });
    const antes = snap(dump({ ...PRODUTO_BASE }, { ...LINK_BASE }), [filho]);
    const depois = snap(dump({ ...PRODUTO_BASE }, { ...LINK_BASE }), []);
    expect(diffSnapshots(antes, depois).achados.map((a) => a.campo)).toContain('filhos (produtos)');
  });
});

describe('diffSnapshots — the buckets', () => {
  it('classifies a KNOWN divergence separately, so it is not a finding', () => {
    // `IS_KIT` is read on import and never written on publish, so a kit always
    // round-trips to false. Counting it every run would bury the real result.
    const antes = snap(dump({ ...PRODUTO_BASE, ehKit: true }, { ...LINK_BASE }));
    const depois = snap(dump({ ...PRODUTO_BASE, ehKit: false }, { ...LINK_BASE }));

    const r = diffSnapshots(antes, depois);
    expect(r.achados).toEqual([]);
    expect(r.conhecidas.map((c) => c.campo)).toEqual(['ehKit']);
  });

  it('never counts a history subcollection as a finding', () => {
    const antes = snap({
      ...dump({ ...PRODUTO_BASE }, { ...LINK_BASE }),
      subcolecoes: {
        produtoMercadoLivre: [{ id: 'l1', data: { ...LINK_BASE } }],
        historicoDePrecos: [
          { id: 'h1', data: {} },
          { id: 'h2', data: {} },
        ],
      },
    });
    const depois = snap(dump({ ...PRODUTO_BASE }, { ...LINK_BASE }));

    const r = diffSnapshots(antes, depois);
    expect(r.achados).toEqual([]);
    expect(r.subcolecoesEsperadasPerdidas.map((s) => s.campo)).toContain(
      'historicoDePrecos (docs)',
    );
  });

  it('DOES count a lost estoque subcollection — it is not history', () => {
    const antes = snap({
      ...dump({ ...PRODUTO_BASE }, { ...LINK_BASE }),
      subcolecoes: {
        produtoMercadoLivre: [{ id: 'l1', data: { ...LINK_BASE } }],
        estoques: [{ id: 'e1', data: { quantidade: 5 } }],
      },
    });
    const depois = snap(dump({ ...PRODUTO_BASE }, { ...LINK_BASE }));
    expect(diffSnapshots(antes, depois).achados.map((a) => a.campo)).toContain('estoques (docs)');
  });
});

describe('same', () => {
  it('treats null and undefined as the same absence', () => {
    expect(same(null, undefined)).toBe(true);
  });

  it('tolerates a float ulp — a "0.6 kg" parse does not land exactly', () => {
    expect(same(0.1 + 0.2, 0.3)).toBe(true);
  });

  it('compares arrays and objects structurally', () => {
    expect(same([{ id: 'A' }], [{ id: 'A' }])).toBe(true);
    expect(same([{ id: 'A' }], [{ id: 'B' }])).toBe(false);
  });

  it('does not call 0 and null the same thing — a lost quantity must show', () => {
    expect(same(0, null)).toBe(false);
  });
});

describe('the field lists', () => {
  it('keeps ROUND_TRIP and VOLATILE disjoint', () => {
    // A field in both would be silently dropped from the findings — the exact
    // way this checker could report nothing while looking healthy.
    const overlap = CAMPOS_ROUND_TRIP.filter((c) => CAMPOS_VOLATEIS.has(c));
    expect(overlap).toEqual([]);
  });
});
