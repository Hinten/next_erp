import { describe, expect, it } from 'vitest';

import { type ValorJsonLi, redigirCorpo } from '../core/redacao';
import { criarListaDeNomes } from '../fixtures/piiScan';
import { formatarFolhas, tabelaDeFolhas } from './folhas';

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
      'fulano.real@provedor.com.br': 1,
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
          cliente: { nome: 'SENTINELA-nome', email: 'sentinela@provedor.com.br' },
          itens: [{ sku: 'SENTINELA-SKU', preco_venda: '123.45' }],
          obs: 'SENTINELA-obs 31999998888',
        },
      ],
    };
    const texto = tabela('/v1/pedido/search', corpo).join('\n');
    for (const valor of ['987654321', 'SENTINELA', 'sentinela@', '123.45', '31999998888']) {
      expect(texto).not.toContain(valor);
    }
    // Anti-vacuity: the kept values WERE kept — the table just never prints them.
    expect(texto).toContain('objects.*.numero : number → mantido (1)');
    expect(texto).toContain('objects.*.itens.*.sku : string → mantido (1)');
  });
});
