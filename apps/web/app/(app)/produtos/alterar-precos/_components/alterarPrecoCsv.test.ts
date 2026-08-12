import { describe, expect, it } from 'vitest';

import type { ApplyOutcome, PrecoAlteracao } from '@/lib/produtos/bulkPreco/types';
import {
  ALTERAR_PRECO_CSV_HEADER,
  alterarPrecoCsvFilename,
  buildAlterarPrecoCsv,
} from './alterarPrecoCsv';

function row(overrides: Partial<PrecoAlteracao> = {}): PrecoAlteracao {
  return {
    produtoId: 'p1',
    sku: 'SKU1',
    nome: 'Produto 1',
    custo: 10,
    precoAtual: 20,
    precoNovo: 25,
    erro: null,
    foraDosLimites: false,
    precos: null,
    ...overrides,
  };
}

function outcome(overrides: Partial<ApplyOutcome> = {}): ApplyOutcome {
  return { produtoId: 'p1', status: 'aplicado', erro: null, ...overrides };
}

describe('buildAlterarPrecoCsv', () => {
  it('starts with the BOM followed by the legacy-shaped header row', () => {
    const csv = buildAlterarPrecoCsv([]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split('\r\n')[0]).toBe(ALTERAR_PRECO_CSV_HEADER.join(';'));
    expect(ALTERAR_PRECO_CSV_HEADER).toEqual([
      'Sku',
      'Produto',
      'Custo',
      'Preço Antigo',
      'Novo Valor',
      'Erro',
    ]);
  });

  it('falls back Sku to "Sem Sku" (legacy parity) when null', () => {
    const cells = buildAlterarPrecoCsv([row({ sku: null })])
      .slice(1)
      .split('\r\n')[1]!
      .split(';');
    expect(cells[0]).toBe('Sem Sku');
  });

  it('formats Custo and Preço Antigo as pt-BR grouped decimals, "N/A" when null', () => {
    const withValues = buildAlterarPrecoCsv([row({ custo: 1234.5, precoAtual: 20 })])
      .slice(1)
      .split('\r\n')[1]!
      .split(';');
    expect(withValues[2]).toBe('1.234,50');
    expect(withValues[3]).toBe('20,00');

    const withNulls = buildAlterarPrecoCsv([row({ custo: null, precoAtual: null })])
      .slice(1)
      .split('\r\n')[1]!
      .split(';');
    expect(withNulls[2]).toBe('N/A');
    expect(withNulls[3]).toBe('N/A');
  });

  it('formats Novo Valor as a pt-BR grouped decimal, and fixes the legacy "calular" typo when null', () => {
    const withValue = buildAlterarPrecoCsv([row({ precoNovo: 2000 })])
      .slice(1)
      .split('\r\n')[1]!
      .split(';');
    expect(withValue[4]).toBe('2.000,00');

    const withNull = buildAlterarPrecoCsv([row({ precoNovo: null, erro: 'algum erro' })])
      .slice(1)
      .split('\r\n')[1]!
      .split(';');
    expect(withNull[4]).toBe('Não foi possível calcular');
    expect(withNull[4]).not.toContain('calular');
  });

  it('Erro column: a calc-time erro always wins over foraDosLimites or any outcome', () => {
    const outcomes = new Map([['p1', outcome({ status: 'pulado' })]]);
    const cells = buildAlterarPrecoCsv(
      [row({ erro: 'Custo do produto não encontrado', foraDosLimites: true })],
      outcomes,
    )
      .slice(1)
      .split('\r\n')[1]!
      .split(';');
    expect(cells[5]).toBe('Custo do produto não encontrado');
  });

  it('Erro column: foraDosLimites (no erro) reports "Fora dos limites" regardless of outcome', () => {
    const outcomes = new Map([['p1', outcome({ status: 'aplicado' })]]);
    const cells = buildAlterarPrecoCsv([row({ foraDosLimites: true, precoNovo: null })], outcomes)
      .slice(1)
      .split('\r\n')[1]!
      .split(';');
    expect(cells[5]).toBe('Fora dos limites');
  });

  it('Erro column: maps each ApplyOutcome status once erro/foraDosLimites are ruled out', () => {
    const cases: Array<[ApplyOutcome['status'], string]> = [
      ['pulado', 'pulado (direção)'],
      ['semAlteracao', 'sem alteração'],
      ['aplicado', ''],
    ];
    for (const [status, expected] of cases) {
      const outcomes = new Map([['p1', outcome({ status })]]);
      const cells = buildAlterarPrecoCsv([row()], outcomes).slice(1).split('\r\n')[1]!.split(';');
      expect(cells[5]).toBe(expected);
    }
  });

  it('Erro column: a write-time "erro" outcome surfaces its own message', () => {
    const outcomes = new Map([
      ['p1', outcome({ status: 'erro', erro: 'permission-denied: nope' })],
    ]);
    const cells = buildAlterarPrecoCsv([row()], outcomes).slice(1).split('\r\n')[1]!.split(';');
    expect(cells[5]).toBe('permission-denied: nope');
  });

  it('Erro column: blank pre-apply (no outcomes map at all) when there is nothing to report', () => {
    const cells = buildAlterarPrecoCsv([row()]).slice(1).split('\r\n')[1]!.split(';');
    expect(cells[5]).toBe('');
  });

  it('rides csvCell for formula-injection safety on the Produto/Erro columns', () => {
    const cells = buildAlterarPrecoCsv([row({ nome: '=SUM(A1)', erro: '+cmd' })])
      .slice(1)
      .split('\r\n')[1]!
      .split(';');
    expect(cells[1]).toBe("'=SUM(A1)");
    expect(cells[5]).toBe("'+cmd");
  });
});

describe('alterarPrecoCsvFilename', () => {
  it('interpolates the raw lista name and unpadded date parts (legacy template, no slug/pad)', () => {
    const now = new Date(2026, 0, 5, 3, 7, 9); // 2026-01-05 03:07:09 local
    expect(alterarPrecoCsvFilename('Lista A', now)).toBe('Lista A_2026_1_5_3_7_9.csv');
  });

  it('does not zero-pad double-digit parts either (plain int interpolation)', () => {
    const now = new Date(2026, 6, 21, 14, 30, 45); // 2026-07-21 14:30:45 local
    expect(alterarPrecoCsvFilename('Lista Padrão', now)).toBe(
      'Lista Padrão_2026_7_21_14_30_45.csv',
    );
  });
});
