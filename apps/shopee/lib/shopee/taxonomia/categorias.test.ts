import { describe, expect, it } from 'vitest';

import type { ShopeeCategoria } from '@delfrance/integrations-shopee';

import {
  SHOPEE_CATEGORIA_PROFUNDIDADE_MAX,
  caminhoDaCategoria,
  construirIndice,
  ehFolha,
  filhosDe,
  raizes,
} from './categorias';

function no(
  category_id: number,
  parent_category_id: number,
  has_children: boolean,
  nome = `cat-${category_id}`,
): ShopeeCategoria {
  return {
    category_id,
    parent_category_id,
    has_children,
    original_category_name: nome,
    display_category_name: nome,
  };
}

/**
 * Três níveis, dois ramos e uma raiz que já é folha — a forma mínima que
 * distingue "folha", "não folha" e "desconhecida" ao mesmo tempo.
 *
 * 100000 Moda (raiz, com filhos)
 *   100100 Roupas (com filhos)
 *     100182 Camisetas (folha)
 *   100200 Calçados (folha)
 * 200000 Casa (raiz, folha)
 */
const ARVORE: readonly ShopeeCategoria[] = [
  no(100000, 0, true, 'Moda'),
  no(100100, 100000, true, 'Roupas'),
  no(100182, 100100, false, 'Camisetas'),
  no(100200, 100000, false, 'Calçados'),
  no(200000, 0, false, 'Casa'),
];

describe('construirIndice', () => {
  it('indexa todos os nós pelos dois lados', () => {
    const indice = construirIndice(ARVORE);
    expect(indice.lista).toHaveLength(5);
    expect(indice.porId.get(100182)?.display_category_name).toBe('Camisetas');
    expect(indice.filhosPorPai.get(100000)?.map((c) => c.category_id)).toEqual([100100, 100200]);
  });

  it('mantém a PRIMEIRA ocorrência de um id repetido, nos dois mapas', () => {
    // Sem isto, `porId` serviria uma cópia e `filhosPorPai` mostraria o filho
    // duas vezes: duas estruturas discordando sobre a mesma árvore.
    const indice = construirIndice([
      no(100000, 0, true, 'Moda'),
      no(100100, 100000, true, 'Roupas'),
      no(100100, 100000, false, 'Roupas (duplicada)'),
    ]);
    expect(indice.lista).toHaveLength(2);
    expect(indice.porId.get(100100)?.display_category_name).toBe('Roupas');
    expect(indice.filhosPorPai.get(100000)).toHaveLength(1);
  });

  it('indexa uma lista vazia sem quebrar', () => {
    const indice = construirIndice([]);
    expect(indice.lista).toEqual([]);
    expect(raizes(indice)).toEqual([]);
    expect(ehFolha(indice, 100182)).toBe('desconhecida');
  });
});

describe('ehFolha — três valores, nunca dois', () => {
  const indice = construirIndice(ARVORE);

  it('é folha quando has_children é exatamente false', () => {
    expect(ehFolha(indice, 100182)).toBe('folha');
  });

  it('não é folha quando o nó tem filhos — o par da linha acima', () => {
    expect(ehFolha(indice, 100100)).toBe('nao-folha');
  });

  it('responde desconhecida — e NÃO nao-folha — para um id fora da árvore', () => {
    // A quase-falha que importa: dobrar os dois em "não pode publicar" faria a
    // rota responder 200-com-nada para uma categoria que não existe, igualzinho
    // a um nó legítimo do meio da árvore. Por isso a rota devolve 404.
    const veredicto = ehFolha(indice, 999999);
    expect(veredicto).toBe('desconhecida');
    expect(veredicto).not.toBe('nao-folha');
  });

  it('NÃO trata a string "false" como folha', () => {
    // O provedor nunca deveria mandar isto (o schema do pacote é `z.boolean()`
    // estrito e falha antes de chegar aqui), mas este leitor não pode ser o
    // lugar que teria coagido: `!('false')` é false, ou seja, o teste frouxo
    // chamaria um NÃO-folha de folha e publicaria atributos do nó errado.
    const torto = { ...no(300000, 0, false), has_children: 'false' } as unknown as ShopeeCategoria;
    expect(ehFolha(construirIndice([torto]), 300000)).toBe('nao-folha');
  });

  it.each([
    ['true', true],
    ['1', 1],
    ['null', null],
    ['undefined', undefined],
  ])('trata has_children=%s como nao-folha', (_caso, valor) => {
    const torto = { ...no(300000, 0, false), has_children: valor } as unknown as ShopeeCategoria;
    expect(ehFolha(construirIndice([torto]), 300000)).toBe('nao-folha');
  });
});

describe('caminhoDaCategoria', () => {
  const indice = construirIndice(ARVORE);

  it('devolve o caminho da RAIZ para baixo, incluindo o próprio nó', () => {
    expect(caminhoDaCategoria(indice, 100182).map((c) => c.category_id)).toEqual([
      100000, 100100, 100182,
    ]);
  });

  it('não devolve o caminho invertido — a raiz é o primeiro elemento', () => {
    // O par do teste acima: a mesma lista ao contrário passaria por qualquer
    // asserção de conjunto. O picker do apps/web e o `path_from_root` do ML
    // leem a raiz na posição 0; as duas telas não podem discordar disso.
    const caminho = caminhoDaCategoria(indice, 100182);
    expect(caminho[0]?.display_category_name).toBe('Moda');
    expect(caminho.at(-1)?.display_category_name).toBe('Camisetas');
  });

  it('devolve só o próprio nó quando ele já é raiz', () => {
    expect(caminhoDaCategoria(indice, 200000).map((c) => c.category_id)).toEqual([200000]);
  });

  it('devolve lista vazia para um id desconhecido', () => {
    expect(caminhoDaCategoria(indice, 999999)).toEqual([]);
  });

  it('termina quando o provedor manda um ciclo', () => {
    // Sem o conjunto de visitados isto seria um laço infinito dentro de uma
    // rota — a requisição nunca responderia e a instância travaria.
    const cicloIndice = construirIndice([no(1, 2, true), no(2, 1, true)]);
    const caminho = caminhoDaCategoria(cicloIndice, 1);
    expect(caminho.map((c) => c.category_id)).toEqual([2, 1]);
  });

  it('para no teto de profundidade quando a corrente de pais é absurda', () => {
    // A segunda metade da guarda: uma corrente longa SEM ciclo (nenhum id se
    // repete, então o conjunto de visitados nunca dispara).
    const corrente: ShopeeCategoria[] = [];
    const fundo = SHOPEE_CATEGORIA_PROFUNDIDADE_MAX + 10;
    for (let id = 1; id <= fundo; id += 1) {
      corrente.push(no(id, id === 1 ? 0 : id - 1, id !== fundo));
    }
    const caminho = caminhoDaCategoria(construirIndice(corrente), fundo);
    expect(caminho).toHaveLength(SHOPEE_CATEGORIA_PROFUNDIDADE_MAX);
    // Trunca no lado da RAIZ: o nó pedido continua sendo o último.
    expect(caminho.at(-1)?.category_id).toBe(fundo);
  });

  it('para quando o pai não está na árvore, sem inventar um nó', () => {
    const orfaoIndice = construirIndice([no(100182, 100100, false)]);
    expect(caminhoDaCategoria(orfaoIndice, 100182).map((c) => c.category_id)).toEqual([100182]);
  });
});

describe('filhosDe / raizes', () => {
  const indice = construirIndice(ARVORE);

  it('lista as raízes na ordem em que a Shopee mandou', () => {
    expect(raizes(indice).map((c) => c.display_category_name)).toEqual(['Moda', 'Casa']);
  });

  it('NÃO promove um órfão a raiz', () => {
    // A quase-falha: o pai 100100 não existe nesta árvore, mas
    // `parent_category_id` não é 0 — inventar uma raiz aqui colocaria uma
    // categoria do meio no topo do picker, indistinguível de uma real.
    const orfaoIndice = construirIndice([no(200000, 0, false, 'Casa'), no(100182, 100100, false)]);
    expect(raizes(orfaoIndice).map((c) => c.category_id)).toEqual([200000]);
  });

  it('lista os filhos diretos, e nada dos netos', () => {
    expect(filhosDe(indice, 100000).map((c) => c.category_id)).toEqual([100100, 100200]);
  });

  it('devolve lista vazia para uma folha e para um id desconhecido', () => {
    expect(filhosDe(indice, 100182)).toEqual([]);
    expect(filhosDe(indice, 999999)).toEqual([]);
  });
});
