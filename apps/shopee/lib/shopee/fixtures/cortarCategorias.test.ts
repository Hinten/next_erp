import { describe, expect, it } from 'vitest';

import { ErroDeCorteDeCategorias, cortarArvoreDeCategorias } from './cortarCategorias';
import type { WireValue } from './redact';

/**
 * A synthetic `get_category` tree — invented ids and names, the page's row shape.
 *
 * ```
 * 1 ─┬─ 10 ─┬─ 100 (folha pedida)
 *    │      └─ 101 (irmã da folha)
 *    └─ 11 ─── 110          ← 11 é IRMÃ de um nó do caminho
 * 2 ─┬─ 20 ─── 200 (folha pedida)
 *    └─ 201
 * 3 ──── 30                 ← raiz sem folha pedida; 30 não é do caminho
 * ```
 *
 * ⚠️ The rows are deliberately OUT of tree order (a leaf before its root), so a
 * cut that re-sorted would be seen.
 */
function linha(id: number, pai: number, filhos: boolean): WireValue {
  return {
    category_id: id,
    parent_category_id: pai,
    original_category_name: `Category ${String(id)}`,
    display_category_name: `Categoria ${String(id)}`,
    has_children: filhos,
  };
}

const LINHAS: WireValue[] = [
  linha(100, 10, false),
  linha(1, 0, true),
  linha(11, 1, true),
  linha(10, 1, true),
  linha(2, 0, true),
  linha(101, 10, false),
  linha(3, 0, true),
  linha(20, 2, true),
  linha(110, 11, false),
  linha(200, 20, false),
  linha(30, 3, false),
  linha(201, 2, false),
];

function corpo(linhas: WireValue[] = LINHAS): WireValue {
  return {
    error: '',
    message: '',
    warning: '',
    debug_message: 'envelope verbatim',
    response: { category_list: linhas, chave_irma: { mantida: true } },
  };
}

const FOLHAS = [100, 200] as const;

type Corpo = {
  response: { category_list: { category_id: number }[]; chave_irma?: unknown };
  [chave: string]: unknown;
};

function ids(valor: WireValue): number[] {
  return (valor as unknown as Corpo).response.category_list.map((l) => l.category_id);
}

describe('cortarArvoreDeCategorias (#1911) — o recorte de get_category que vira fixture', () => {
  it('mantém EXATAMENTE os ancestrais-ou-a-própria de cada folha pedida, mais TODA raiz', () => {
    expect(new Set(ids(cortarArvoreDeCategorias(corpo(), FOLHAS)))).toEqual(
      new Set([1, 2, 3, 10, 20, 100, 200]),
    );
  });

  it('mantém a ORDEM da Shopee — nunca reordena (a folha antes da raiz continua antes)', () => {
    expect(ids(cortarArvoreDeCategorias(corpo(), FOLHAS))).toEqual([100, 1, 10, 2, 3, 20, 200]);
  });

  it('⭐ NEAR-MISS: a IRMÃ de um nó do caminho NÃO fica — o próprio nó do caminho fica', () => {
    // O par que separa "o caminho" de "a vizinhança do caminho": 10 e 11 são
    // filhas da mesma raiz; só 10 leva a uma folha pedida. E 101 é irmã da
    // própria folha 100.
    const cortados = ids(cortarArvoreDeCategorias(corpo(), FOLHAS));
    expect(cortados).toContain(10);
    expect(cortados).not.toContain(11);
    expect(cortados).toContain(100);
    expect(cortados).not.toContain(101);
    expect(cortados).toContain(20);
    expect(cortados).not.toContain(201);
  });

  it('NEAR-MISS: um nó que não é raiz nem do caminho NÃO fica — nem o filho de uma irmã', () => {
    const cortados = ids(cortarArvoreDeCategorias(corpo(), FOLHAS));
    expect(cortados).not.toContain(30);
    expect(cortados).not.toContain(110);
  });

  it('TODA raiz fica, inclusive a que não leva a folha pedida nenhuma (o nível 1 inteiro)', () => {
    expect(ids(cortarArvoreDeCategorias(corpo(), FOLHAS))).toContain(3);
    // …e sem folha pedida nenhuma, o recorte é exatamente as raízes.
    expect(ids(cortarArvoreDeCategorias(corpo(), []))).toEqual([1, 2, 3]);
  });

  it('o ENVELOPE e o resto de `response` saem verbatim, as linhas mantidas intocadas, e a entrada não muda', () => {
    const entrada = corpo();
    const antes = structuredClone(entrada);
    const cortado = cortarArvoreDeCategorias(entrada, FOLHAS) as unknown as Corpo;

    expect(entrada).toEqual(antes);
    expect(cortado.error).toBe('');
    expect(cortado.message).toBe('');
    expect(cortado.warning).toBe('');
    expect(cortado.debug_message).toBe('envelope verbatim');
    expect(Object.keys(cortado).sort()).toEqual(Object.keys(antes as object).sort());
    expect(cortado.response.chave_irma).toEqual({ mantida: true });
    const porId = new Map(LINHAS.map((l) => [(l as { category_id: number }).category_id, l]));
    for (const l of cortado.response.category_list) expect(l).toEqual(porId.get(l.category_id));
  });

  it('é IDEMPOTENTE — recortar o recorte não tira nada', () => {
    const uma = cortarArvoreDeCategorias(corpo(), FOLHAS);
    const duas = cortarArvoreDeCategorias(uma, FOLHAS);
    expect(duas).toEqual(uma);
    expect(cortarArvoreDeCategorias(duas, FOLHAS)).toEqual(uma);
  });

  describe('falha FECHADA — recusa, nunca um recorte menor', () => {
    const recusa =
      (valor: WireValue, folhas: readonly number[] = FOLHAS) =>
      () =>
        cortarArvoreDeCategorias(valor, folhas);

    it('uma folha pedida que NÃO está na lista', () => {
      expect(recusa(corpo(), [100, 999])).toThrow(ErroDeCorteDeCategorias);
      expect(recusa(corpo(), [100, 999])).toThrow(/999/);
    });

    it('um `category_id` DUPLICADO — mesmo fora do caminho', () => {
      expect(recusa(corpo([...LINHAS, linha(30, 3, false)]))).toThrow(ErroDeCorteDeCategorias);
      expect(recusa(corpo([...LINHAS, linha(100, 10, false)]))).toThrow(/100/);
    });

    it('um CICLO de `parent_category_id` — mesmo num galho sem folha pedida', () => {
      // 40 → 41 → 40: nenhum dos dois chega a 0.
      const ciclo = [...LINHAS, linha(40, 41, true), linha(41, 40, true)];
      expect(recusa(corpo(ciclo))).toThrow(ErroDeCorteDeCategorias);
      // …e o ciclo de um só: uma categoria que é o próprio pai.
      expect(recusa(corpo([...LINHAS, linha(50, 50, false)]))).toThrow(ErroDeCorteDeCategorias);
      // …e o que passa por um nó do caminho pedido.
      const noCaminho = LINHAS.map((l) =>
        (l as { category_id: number }).category_id === 1 ? linha(1, 100, true) : l,
      );
      expect(recusa(corpo(noCaminho))).toThrow(ErroDeCorteDeCategorias);
    });

    it('um pai que não é raiz e NÃO está na lista — mesmo fora do caminho', () => {
      expect(recusa(corpo([...LINHAS, linha(60, 6, false)]))).toThrow(ErroDeCorteDeCategorias);
      expect(recusa(corpo([...LINHAS, linha(60, 6, false)]))).toThrow(/\b6\b/);
      // …e no caminho pedido: a raiz da folha sumiu.
      const semRaiz = LINHAS.filter((l) => (l as { category_id: number }).category_id !== 2);
      expect(recusa(corpo(semRaiz))).toThrow(ErroDeCorteDeCategorias);
    });

    it('um corpo fora da forma documentada', () => {
      expect(recusa(null)).toThrow(ErroDeCorteDeCategorias);
      expect(recusa([])).toThrow(ErroDeCorteDeCategorias);
      expect(recusa({ error: '' })).toThrow(ErroDeCorteDeCategorias);
      expect(recusa({ response: { category_list: null } })).toThrow(ErroDeCorteDeCategorias);
      expect(recusa(corpo([...LINHAS, 'linha']))).toThrow(ErroDeCorteDeCategorias);
      // Um id que não é inteiro: string, fração, e a sentinela `0` como categoria.
      expect(
        recusa(
          corpo([...LINHAS, { category_id: '70', parent_category_id: 0, has_children: false }]),
        ),
      ).toThrow(ErroDeCorteDeCategorias);
      expect(recusa(corpo([...LINHAS, linha(70.5, 0, false)]))).toThrow(ErroDeCorteDeCategorias);
      expect(recusa(corpo([...LINHAS, linha(0, 0, false)]))).toThrow(ErroDeCorteDeCategorias);
      expect(recusa(corpo([...LINHAS, linha(71, -1, false)]))).toThrow(ErroDeCorteDeCategorias);
    });
  });
});
