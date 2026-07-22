import { describe, expect, it } from 'vitest';

import { buildPrecoAlteracoesCsv, PRECO_CSV_HEADER, precoCsvFilename } from './precoCsv';
import type { PrecoAlteracao } from './types';

function row(overrides: Partial<PrecoAlteracao> = {}): PrecoAlteracao {
  return {
    produtoId: 'p1',
    sku: 'SKU1',
    nome: 'Produto 1',
    custo: 10,
    precoAtual: 20,
    precoNovo: 25,
    erro: null,
    precos: null,
    ...overrides,
  };
}

describe('buildPrecoAlteracoesCsv', () => {
  it('starts with the BOM followed by the header row', () => {
    const csv = buildPrecoAlteracoesCsv([]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split('\r\n')[0]).toBe(PRECO_CSV_HEADER.join(';'));
  });

  it('sorts rows by sku, with null skus last', () => {
    const rows = [
      row({ sku: 'B', nome: 'B' }),
      row({ sku: null, nome: 'Sem sku' }),
      row({ sku: 'A', nome: 'A' }),
    ];
    const lines = buildPrecoAlteracoesCsv(rows).slice(1).split('\r\n').slice(1);
    expect(lines.map((l) => l.split(';')[0])).toEqual(['A', 'B', '']);
  });

  it('formats Preço Atual / Novo Preço / Diferença with a BR decimal comma', () => {
    const csv = buildPrecoAlteracoesCsv([row({ precoAtual: 20, precoNovo: 25.5 })]);
    const cells = csv.slice(1).split('\r\n')[1]!.split(';');
    expect(cells[2]).toBe('20,00'); // Preço Atual
    expect(cells[3]).toBe('25,50'); // Novo Preço
    expect(cells[4]).toBe('5,50'); // Diferença
  });

  it('groups thousands like the legacy NumberFormat.currency report (1.234,56)', () => {
    const csv = buildPrecoAlteracoesCsv([row({ precoAtual: 1234.56, precoNovo: 2000 })]);
    const cells = csv.slice(1).split('\r\n')[1]!.split(';');
    expect(cells[2]).toBe('1.234,56');
    expect(cells[3]).toBe('2.000,00');
    expect(cells[4]).toBe('765,44');
  });

  it('fills Diferença with the full novo price when precoAtual is null (first price under this lista)', () => {
    const semAtual = buildPrecoAlteracoesCsv([row({ precoAtual: null, precoNovo: 25 })])
      .slice(1)
      .split('\r\n')[1]!
      .split(';');
    expect(semAtual[2]).toBe(''); // Preço Atual blank
    expect(semAtual[4]).toBe('25,00'); // Diferença = full novo price, not blank
  });

  it('leaves Novo Preço and Diferença blank when precoNovo is null', () => {
    const semNovo = buildPrecoAlteracoesCsv([
      row({ precoAtual: 20, precoNovo: null, erro: 'algum erro' }),
    ])
      .slice(1)
      .split('\r\n')[1]!
      .split(';');
    expect(semNovo[3]).toBe(''); // Novo Preço blank
    expect(semNovo[4]).toBe(''); // Diferença blank
    expect(semNovo[5]).toBe('algum erro');
  });

  it('leaves the Erro column blank when there is no error', () => {
    const cells = buildPrecoAlteracoesCsv([row({ erro: null })])
      .slice(1)
      .split('\r\n')[1]!
      .split(';');
    expect(cells[5]).toBe('');
  });

  it('rides csvCell for formula-injection safety on the Nome/Erro columns', () => {
    const cells = buildPrecoAlteracoesCsv([row({ nome: '=SUM(A1)', erro: '+cmd' })])
      .slice(1)
      .split('\r\n')[1]!
      .split(';');
    expect(cells[1]).toBe("'=SUM(A1)");
    expect(cells[5]).toBe("'+cmd");
  });
});

describe('precoCsvFilename', () => {
  it('slugifies the lista name and appends a local YYYYMMDD-HHmm stamp', () => {
    const now = new Date(2026, 6, 21, 9, 5, 0); // 2026-07-21 09:05 local
    expect(precoCsvFilename('Lista Padrão', now)).toBe(
      'recalculo-precos-lista-padro-20260721-0905.csv',
    );
  });

  it('collapses multiple spaces and strips punctuation other than the inserted hyphens', () => {
    const now = new Date(2026, 0, 1, 0, 0, 0);
    expect(precoCsvFilename('Atacado  (SP/RJ)!', now)).toBe(
      'recalculo-precos-atacado-sprj-20260101-0000.csv',
    );
  });
});
