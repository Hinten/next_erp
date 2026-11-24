/**
 * The shared manual selection read on the counting fake db: the one-hop
 * anchor, the label reads, the families' SKUs of the conta in both ref forms,
 * every read masked; and the two partition helpers it is built on.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeDb, asDb } from '../testing/fakeDb';
import {
  CAMPOS_INDICE_FILHOS_SELECAO_MANUAL_AMAZON,
  CAMPOS_PRODUTO_SELECAO_MANUAL_AMAZON,
  CAMPOS_ROTULO_ANCORA_SELECAO_MANUAL_AMAZON,
  CAMPOS_VINCULO_SELECAO_MANUAL_AMAZON,
  LARGURA_LEITURAS_SELECAO_MANUAL_AMAZON,
  lerSelecaoManualAmazon,
} from './selecaoManual';
import { skusDaConta, sondasDoProduto } from './sondasVinculos';

const CONTA = 'conta-selecao';
const CANONICA = `documents/integracao/${CONTA}`;
const NUA = `integracao/${CONTA}`;

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
  db.exigirMascaraEm('produtos');
  db.exigirMascaraEm('prodAmazon');
});

function produto(id: string, dados: Record<string, unknown> = {}) {
  db.seed(`produtos/${id}`, { nome: `Produto ${id}`, precos: { t: { valor: 1 } }, ...dados });
}

function vinculo(produtoId: string, linkId: string, sku: string, conta = CANONICA) {
  db.seed(`produtos/${produtoId}/prodAmazon/${linkId}`, {
    contaAmazonOuterRef: conta,
    sku,
    productDataJson: { pesado: 'x'.repeat(64) },
  });
}

const ler = (ids: readonly string[]) => lerSelecaoManualAmazon(asDb(db), CONTA, ids);

describe('★ the selection: one hop to the anchor, the anchor’s family, the conta’s SKUs', () => {
  it('a variation child hops ONE level: its anchor’s family (children and selected) in both ref forms, sorted, deduplicated', async () => {
    produto('A');
    produto('C1', { paiId: 'A' });
    produto('C2', { paiId: 'A' });
    vinculo('A', 'la', 'SKU-A');
    vinculo('C1', 'l1', 'SKU-C1', NUA);
    vinculo('C2', 'l2', 'SKU-C2');
    vinculo('C2', 'l3', 'SKU-C2', NUA);
    vinculo('C2', 'l4', 'SKU-OUTRA', 'documents/integracao/outra-conta');
    const s = await ler(['C1']);
    expect([...s.ancoraDe]).toEqual([['C1', 'A']]);
    expect([...s.skusDaAncora]).toEqual([['A', ['SKU-A', 'SKU-C1', 'SKU-C2']]]);
    expect(s.nomeDe.get('A')).toBe('Produto A');
    expect(s.ancorasAusentes.size).toBe(0);
  });

  it('NEAR-MISS: a grandchild still hops ONE level only — its parent is its anchor', async () => {
    produto('A');
    produto('B', { paiId: 'A' });
    produto('N', { paiId: 'B' });
    const s = await ler(['N']);
    expect(s.ancoraDe.get('N')).toBe('B');
  });

  it('a produto with no document has no anchor; a child whose parent has none names it ausente, and no family is read for it', async () => {
    produto('F', { paiId: 'SUMIDO' });
    const s = await ler(['NADA', 'F']);
    expect(s.ancoraDe.has('NADA')).toBe(false);
    expect(s.ancorasAusentes).toEqual(new Set(['SUMIDO']));
    expect(s.skusDaAncora.size).toBe(0);
    expect(db.consultas).toEqual([]);
  });

  it('every read is masked: the produtos to their pointer and label, an unselected anchor to its label, the partitions projected, the seek keys only', async () => {
    produto('A');
    produto('C1', { paiId: 'A' });
    vinculo('A', 'la', 'SKU-A');
    await ler(['C1']);
    const leitura = (caminho: string) => db.leiturasDetalhadas.filter((l) => l.caminho === caminho);
    expect(leitura('produtos/C1')).toMatchObject([
      { via: 'getAll', mascara: [...CAMPOS_PRODUTO_SELECAO_MANUAL_AMAZON] },
    ]);
    expect(leitura('produtos/A')).toMatchObject([
      { via: 'getAll', mascara: [...CAMPOS_ROTULO_ANCORA_SELECAO_MANUAL_AMAZON] },
    ]);
    const particoes = db.consultas.filter((q) => q.colecao.endsWith('/prodAmazon'));
    expect(particoes.length).toBe(2);
    for (const q of particoes) {
      expect(q.selecao).toEqual([...CAMPOS_VINCULO_SELECAO_MANUAL_AMAZON]);
      expect(q.filtros).toEqual([]);
    }
    const seek = db.consultas.find((q) => q.colecao === 'produtos');
    const [campoPai, campoOrdem] = CAMPOS_INDICE_FILHOS_SELECAO_MANUAL_AMAZON;
    expect(seek).toMatchObject({
      filtros: [[campoPai, 'A']],
      ordens: [[campoOrdem, 'asc']],
      selecao: [],
    });
  });

  it('a selected anchor is never read twice: its own read already carried its label, and its partition is listed once', async () => {
    produto('A');
    produto('C1', { paiId: 'A' });
    vinculo('A', 'la', 'SKU-A');
    const s = await ler(['A', 'C1']);
    expect(db.leiturasDetalhadas.filter((l) => l.caminho === 'produtos/A')).toHaveLength(1);
    // The anchor is a member of its own family only once: one listing per partition.
    expect(
      db.consultas
        .filter((q) => q.colecao.endsWith('/prodAmazon'))
        .map((q) => q.colecao)
        .sort(),
    ).toEqual(['produtos/A/prodAmazon', 'produtos/C1/prodAmazon']);
    expect([...s.skusDaAncora]).toEqual([['A', ['SKU-A']]]);
  });
});

describe('★ the selection’s own bounds', () => {
  it('★ a selected child stored WITHOUT `nome` (outside the schema) is still a member of its anchor’s family (NEAR-MISS: the anchor alone does not find it — the seek filters it out)', async () => {
    produto('ancora');
    db.seed('produtos/sem-nome', { paiId: 'ancora' });
    vinculo('sem-nome', 'l1', 'SKU-1');
    const so = await ler(['ancora']);
    expect([...so.skusDaAncora]).toEqual([['ancora', []]]);
    const s = await ler(['sem-nome']);
    expect([...s.ancoraDe]).toEqual([['sem-nome', 'ancora']]);
    expect([...s.skusDaAncora]).toEqual([['ancora', ['SKU-1']]]);
  });

  it(`keeps at most ${String(LARGURA_LEITURAS_SELECAO_MANUAL_AMAZON)} reads in flight (the produtos and the families alike)`, async () => {
    for (let i = 0; i < 40; i += 1) {
      produto(`p${String(i)}`);
      for (let f = 0; f < 3; f += 1)
        produto(`p${String(i)}-f${String(f)}`, { paiId: `p${String(i)}` });
    }
    const real = asDb(db);
    let emVoo = 0;
    let maximo = 0;
    const atrasar = async <T>(fn: () => Promise<T>): Promise<T> => {
      emVoo += 1;
      maximo = Math.max(maximo, emVoo);
      await new Promise((r) => setTimeout(r, 1));
      try {
        return await fn();
      } finally {
        emVoo -= 1;
      }
    };
    const embrulhar = <Q extends object>(q: Q): Q =>
      new Proxy(q, {
        get(alvo, chave) {
          const v = Reflect.get(alvo, chave) as unknown;
          if (typeof v !== 'function') return v;
          if (chave === 'get') return () => atrasar(() => (v as () => Promise<unknown>).call(alvo));
          return (...args: unknown[]) => {
            const saida = (v as (...a: unknown[]) => unknown).apply(alvo, args);
            return typeof saida === 'object' && saida !== null && 'get' in saida
              ? embrulhar(saida)
              : saida;
          };
        },
      });
    const comVoo = new Proxy(real, {
      get(alvo, chave) {
        const v = Reflect.get(alvo, chave) as unknown;
        if (chave === 'getAll') {
          return (...args: unknown[]) =>
            atrasar(() => (v as (...a: unknown[]) => Promise<unknown>).apply(alvo, args));
        }
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          const saida = (v as (...a: unknown[]) => unknown).apply(alvo, args);
          return typeof saida === 'object' && saida !== null && 'get' in saida
            ? embrulhar(saida)
            : saida;
        };
      },
    });
    const ids = Array.from({ length: 40 }, (_, i) => `p${String(i)}`);
    const s = await lerSelecaoManualAmazon(comVoo, CONTA, ids);
    // EXACTLY the bound: 40 produto reads arrive at once, so a narrower
    // limiter reds too.
    expect(maximo).toBe(LARGURA_LEITURAS_SELECAO_MANUAL_AMAZON);
    // Anti-vacuity: every produto, child list and partition was read.
    expect(s.skusDaAncora.size).toBe(40);
    expect(db.consultas.length).toBe(40 + 40 * 4);
  });
});

describe('the partition helpers', () => {
  it('sondasDoProduto: itself, then the parent its paiId names; NEAR-MISS a self or path-like paiId is none', () => {
    expect(sondasDoProduto('M', { paiId: 'W' })).toEqual(['M', 'W']);
    expect(sondasDoProduto('M', { paiId: 'M' })).toEqual(['M']);
    expect(sondasDoProduto('M', { paiId: 'a/b' })).toEqual(['M']);
    expect(sondasDoProduto('M', null)).toEqual(['M']);
    expect(() => sondasDoProduto('a/b', null)).toThrow(RangeError);
  });

  it('skusDaConta: either stored form of THIS conta, exact; NEAR-MISS another conta, a case change or an empty SKU', () => {
    expect(
      skusDaConta(
        [
          { contaAmazonOuterRef: CANONICA, sku: 'B' },
          { contaAmazonOuterRef: NUA, sku: 'A' },
          { contaAmazonOuterRef: NUA, sku: 'B' },
          { contaAmazonOuterRef: `documents/integracao/${CONTA.toUpperCase()}`, sku: 'C' },
          { contaAmazonOuterRef: 'documents/integracao/outra', sku: 'D' },
          { contaAmazonOuterRef: CANONICA, sku: '' },
        ],
        CONTA,
      ),
    ).toEqual(['A', 'B']);
    expect(() => skusDaConta([], 'a/b')).toThrow(RangeError);
  });
});
