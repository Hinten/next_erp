/**
 * The shared manual selection read on the counting fake db: the one-hop
 * anchor, the label reads, the families' SKUs of the conta in both ref forms,
 * every read masked; and the two partition helpers it is built on.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { FakeDb, asDb } from '../testing/fakeDb';
import {
  CAMPOS_INDICE_FILHOS_SELECAO_MANUAL_AMAZON,
  CAMPOS_PRODUTO_SELECAO_MANUAL_AMAZON,
  CAMPOS_ROTULO_ANCORA_SELECAO_MANUAL_AMAZON,
  CAMPOS_VINCULO_SELECAO_MANUAL_AMAZON,
  LARGURA_LEITURAS_SELECAO_MANUAL_AMAZON,
  lerSelecaoManualAmazon,
  skuAlvoAmazon,
} from './selecaoManual';
import { FLUXO_LISTING_AMAZON } from './fluxoListing';
import { FLUXO_AMAZON, alvoValido } from '../core/valvulas';
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

describe('skuAlvoAmazon — the write valves’ own target grammar (step 13, PR 13-g)', () => {
  /** `n` code points of one character. */
  const de = (caractere: string, n: number) => caractere.repeat(n);
  const ASTRAL = String.fromCodePoint(0x1f600);

  it.each([FLUXO_LISTING_AMAZON.estoque, FLUXO_LISTING_AMAZON.preco])(
    '★ %s: 40 code points ⇒ a target; 41 ⇒ none (NEAR-MISS pair), counted in CODE POINTS, never UTF-16 units',
    (fluxo) => {
      expect(skuAlvoAmazon(fluxo, de('A', 40))).toBe(true);
      expect(skuAlvoAmazon(fluxo, de('A', 41))).toBe(false);
      // 40 astral characters are 80 UTF-16 units and still 40 code points.
      expect(de(ASTRAL, 40)).toHaveLength(80);
      expect(skuAlvoAmazon(fluxo, de(ASTRAL, 40))).toBe(true);
      expect(skuAlvoAmazon(fluxo, de(ASTRAL, 41))).toBe(false);
    },
  );

  it('★ empty, a control character or a lone surrogate ⇒ no target; a space, a comma, a slash or a non-ASCII letter IS one (only not listable, or pathless)', () => {
    const preco = FLUXO_LISTING_AMAZON.preco;
    const SURROGATE_SOLTO = String.fromCharCode(0xd800);
    for (const fora of ['', 'SKU\t1', 'SKU\n1', '\u0000', `SKU-${SURROGATE_SOLTO}`]) {
      expect(skuAlvoAmazon(preco, fora), JSON.stringify(fora)).toBe(false);
    }
    for (const dentro of ['SKU 1', 'SKU,1', 'a/b', 'CAMISETA-AÇAÍ', '*', '1']) {
      expect(skuAlvoAmazon(preco, dentro), dentro).toBe(true);
    }
  });

  it('★ it IS the valves’ predicate, called: the same answer as `alvoValido` for every SKU and both flows (no second copy of the grammar)', () => {
    const corpus = [
      '',
      'A',
      'SKU-1',
      de('A', 40),
      de('A', 41),
      de(ASTRAL, 40),
      de(ASTRAL, 41),
      'SKU\t1',
      'SKU 1',
      'a/b',
      `SKU-${String.fromCharCode(0xd800)}`,
    ];
    for (const fluxo of [FLUXO_LISTING_AMAZON.estoque, FLUXO_LISTING_AMAZON.preco]) {
      for (const sku of corpus) {
        expect(skuAlvoAmazon(fluxo, sku), `${fluxo} ${JSON.stringify(sku)}`).toBe(
          alvoValido(fluxo, sku),
        );
      }
    }
    // The listings flows ARE the valves' flows of the same name.
    expect(FLUXO_LISTING_AMAZON.preco).toBe(FLUXO_AMAZON.preco);
    expect(FLUXO_LISTING_AMAZON.estoque).toBe(FLUXO_AMAZON.estoque);
  });

  it('pure: it reads no Firestore (the counting fake sees no operation)', () => {
    expect(skuAlvoAmazon(FLUXO_LISTING_AMAZON.preco, 'SKU-1')).toBe(true);
    expect(db.operacoes).toBe(0);
  });

  it('★ its body IS the call, in the source: exactly `return alvoValido(fluxo, sku);`, the predicate imported from the valves (an answer-equal copy of the grammar is still a second copy, which the corpus above cannot tell apart)', () => {
    const fonte = readFileSync(
      fileURLToPath(new URL('./selecaoManual.ts', import.meta.url)),
      'utf8',
    );
    const corpoDe = (texto: string) =>
      /export function skuAlvoAmazon\([^)]*\): boolean \{\r?\n([\s\S]*?)\r?\n\}/
        .exec(texto)?.[1]
        ?.trim();
    expect(corpoDe(fonte)).toBe('return alvoValido(fluxo, sku);');
    expect(fonte).toContain("import { alvoValido } from '../core/valvulas';");
    // NEAR-MISS: a copy that keeps the import alive is seen.
    expect(
      corpoDe(
        'export function skuAlvoAmazon(fluxo: F, sku: string): boolean {\n  void alvoValido;\n  return /^.{1,40}$/u.test(sku);\n}\n',
      ),
    ).not.toBe('return alvoValido(fluxo, sku);');
  });
});
