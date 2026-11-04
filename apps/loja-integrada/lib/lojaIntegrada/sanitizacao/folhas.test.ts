import { describe, expect, it } from 'vitest';

import { type ValorJsonLi, redigirCorpo, tabelaDoCaminho } from '../core/redacao';
import { criarListaDeNomes } from '../fixtures/piiScan';
import { chaveDeTeste } from '../testing/chaveDeFixtures';
import { formatarFolhas, tabelaDeFolhas } from './folhas';
import { PseudonimosLi, pseudonimizarCorpoLi } from './pseudonimo';

const LISTA = criarListaDeNomes(['Loja Exemplo']);

function sanitizar(caminho: string, corpo: unknown): ValorJsonLi {
  const r = redigirCorpo({ caminho, status: 200, corpo: JSON.stringify(corpo) }, 'fixture');
  if (!r.ok) throw new Error(`refused: ${r.motivo}`);
  return r.corpo;
}

function tabela(caminho: string, corpo: unknown): string[] {
  return formatarFolhas(tabelaDeFolhas(corpo, sanitizar(caminho, corpo), LISTA));
}

describe('tabelaDeFolhas', () => {
  it('indices print as `*`, and repeated leaves collapse with a count', () => {
    const corpo = {
      objects: [
        { numero: 1, itens: [{ sku: 'A-1' }, { sku: 'A-2' }] },
        { numero: 2, itens: [{ sku: 'B-1' }] },
      ],
    };
    expect(tabela('/v1/pedido/search', corpo)).toEqual([
      'objects.*.numero : number → mantido (2)',
      'objects.*.itens.*.sku : string → mantido (3)',
    ]);
  });

  it('reports the treatment per leaf: kept, faked, and redacted past the depth cap', () => {
    const fundo: Record<string, unknown> = {};
    let atual = fundo;
    for (let i = 0; i < 40; i++) {
      const proximo: Record<string, unknown> = {};
      atual.n = proximo;
      atual = proximo;
    }
    const linhas = tabela('/v1/pedido/1', {
      numero: 7,
      cliente: { nome: 'Fulano de Tal', ativo: true },
      itens: [],
      x: fundo,
    });
    expect(linhas).toEqual(
      expect.arrayContaining([
        'numero : number → mantido (1)',
        'cliente.nome : string → falsificado (1)',
        'cliente.ativo : boolean → falsificado (1)',
        'itens : array → mantido (1)',
      ]),
    );
    expect(linhas.some((l) => l.endsWith('object → redigido (1)'))).toBe(true);
  });

  it('an e-mail used as a key prints its tag, an odd key prints `<chave>`, a listed name prints `<chave>`', () => {
    const linhas = tabela('/v1/pedido/1', {
      'cliente.real@exemplo.invalid': 1,
      'João Silva': 2,
      loja_exemplo: 3,
    });
    expect(linhas).toEqual([
      '<redacted:email> : number → falsificado (1)',
      '<chave> : number → falsificado (2)',
    ]);
  });

  it('SENTINEL: no string or number value of the input appears in the output', () => {
    const corpo = {
      objects: [
        {
          numero: 987654321,
          id_externo: 'SENTINELA-id-externo',
          cliente: { nome: 'SENTINELA-nome', email: 'sentinela@exemplo.invalid' },
          itens: [{ sku: 'SENTINELA-SKU', preco_venda: '123.45' }],
          obs: 'SENTINELA-obs 00987650000',
        },
      ],
    };
    const texto = tabela('/v1/pedido/search', corpo).join('\n');
    for (const valor of ['987654321', 'SENTINELA', 'sentinela@', '123.45', '00987650000']) {
      expect(texto).not.toContain(valor);
    }
    // Anti-vacuity: the kept values WERE kept — the table just never prints them.
    expect(texto).toContain('objects.*.numero : number → mantido (1)');
    expect(texto).toContain('objects.*.itens.*.sku : string → mantido (1)');
  });
});

describe('tabelaDeFolhas — the pseudonymized catalogue ids', () => {
  const CATEGORIAS = {
    meta: { limit: 50, offset: 0, total_count: 2, previous: null, next: null },
    objects: [
      { id: 41, nome: 'Camisetas', categoria_pai: null, resource_uri: '/v1/categoria/41' },
      {
        id: 42,
        nome: 'Regatas',
        categoria_pai: '/v1/categoria/41',
        resource_uri: '/v1/categoria/42',
      },
    ],
  };

  /** The profile's output (`antes`), then the pseudonym mapping over it (`depois`). */
  function mapear(caminho: string, corpo: unknown) {
    const antes = sanitizar(caminho, corpo);
    const depois = pseudonimizarCorpoLi(
      corpo,
      antes,
      tabelaDoCaminho(caminho),
      new PseudonimosLi(chaveDeTeste()),
    );
    return { antes, depois };
  }

  const tabelaPseudonimizada = (caminho: string, corpo: unknown) => {
    const { antes, depois } = mapear(caminho, corpo);
    return formatarFolhas(tabelaDeFolhas(corpo, depois, LISTA, antes));
  };

  it('a leaf changed only by the mapping reads `pseudonimizado`; the others keep their treatment', () => {
    expect(tabelaPseudonimizada('/v1/categoria/', CATEGORIAS)).toEqual([
      'meta.limit : number → mantido (1)',
      'meta.offset : number → mantido (1)',
      'meta.total_count : number → mantido (1)',
      'meta.previous : null → mantido (1)',
      'meta.next : null → mantido (1)',
      'objects.*.id : number → pseudonimizado (2)',
      'objects.*.nome : string → falsificado (2)',
      'objects.*.categoria_pai : null → mantido (1)',
      'objects.*.resource_uri : string → pseudonimizado (2)',
      'objects.*.categoria_pai : string → pseudonimizado (1)',
    ]);
  });

  it('NEAR-MISS: without the profile output beside it, a mapped leaf reads as a fake', () => {
    const { depois } = mapear('/v1/categoria/', CATEGORIAS);
    const linhas = formatarFolhas(tabelaDeFolhas(CATEGORIAS, depois, LISTA));
    expect(linhas).toContain('objects.*.id : number → falsificado (2)');
    expect(linhas.join('\n')).not.toContain('pseudonimizado');
  });

  it('NEAR-MISS: a leaf the profile faked stays `falsificado`', () => {
    const corpo = { objects: [{ id: 7.5, resource_uri: 'https://x.invalid/v1/categoria/7' }] };
    expect(tabelaPseudonimizada('/v1/categoria/', corpo)).toEqual([
      'objects.*.id : number → falsificado (1)',
      'objects.*.resource_uri : string → falsificado (1)',
    ]);
  });

  it('SENTINEL: neither a real id nor its pseudonym is printed', () => {
    const texto = tabelaPseudonimizada('/v1/categoria/', CATEGORIAS).join('\n');
    expect(texto).not.toMatch(/\d{2,}/);
  });
});
