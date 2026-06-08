import { describe, expect, it } from 'vitest';
import {
  FIN_NFE_OPERACAO_LABELS,
  IND_INTERMED_OPERACAO_LABELS,
  IND_PRES_OPERACAO_LABELS,
  TIPO_NFE,
  TIPO_NFE_LABELS,
  operacaoMeta,
  operacaoSchema,
} from './operacao';

const MINIMAL = {
  nome: 'Venda em SP',
  naturezaDaOperacao: 'Venda de mercadoria',
  tipo: TIPO_NFE.saida,
  ehServico: false,
  ehExterior: false,
  ehConsumidorFinal: true,
  cfop: '5102',
  cfopInterestadual: null,
  NCM: '12345678',
  CEST: null,
  unidade: 'UN',
  infCpl: null,
};

describe('operacaoSchema', () => {
  it('accepts a minimal valid operacao and applies defaults', () => {
    const out = operacaoSchema.parse(MINIMAL);
    expect(out).toMatchObject({
      nome: 'Venda em SP',
      tipo: 1,
      padrao: false,
      ativo: true,
      movimentaEstoque: true,
      movimentaIndisponivelEstoque: true,
      ehFiscal: true,
      indPres: '2',
      indIntermed: '1',
    });
  });

  it('rejects empty nome', () => {
    expect(operacaoSchema.safeParse({ ...MINIMAL, nome: '' }).success).toBe(false);
  });

  it('rejects naturezaDaOperacao > 60 chars', () => {
    expect(
      operacaoSchema.safeParse({
        ...MINIMAL,
        naturezaDaOperacao: 'x'.repeat(61),
      }).success,
    ).toBe(false);
  });

  it('rejects NCM > 8 chars', () => {
    expect(operacaoSchema.safeParse({ ...MINIMAL, NCM: '123456789' }).success).toBe(false);
  });

  it('rejects CEST > 7 chars', () => {
    expect(operacaoSchema.safeParse({ ...MINIMAL, CEST: '12345678' }).success).toBe(false);
  });

  it('rejects unidade > 6 chars', () => {
    expect(operacaoSchema.safeParse({ ...MINIMAL, unidade: 'ABCDEFG' }).success).toBe(false);
  });

  it('rejects infCpl > 5000 chars', () => {
    expect(operacaoSchema.safeParse({ ...MINIMAL, infCpl: 'x'.repeat(5001) }).success).toBe(false);
  });

  it('rejects tipo not in {0,1}', () => {
    expect(operacaoSchema.safeParse({ ...MINIMAL, tipo: 2 }).success).toBe(false);
  });

  it('rejects unknown indPres value', () => {
    expect(operacaoSchema.safeParse({ ...MINIMAL, indPres: '7' }).success).toBe(false);
  });

  it('accepts known UFs in estados and estadosDestino', () => {
    const out = operacaoSchema.parse({
      ...MINIMAL,
      estados: ['SP', 'RJ'],
      estadosDestino: ['MG'],
    });
    expect(out.estados).toEqual(['SP', 'RJ']);
  });

  it('rejects invalid UF', () => {
    expect(operacaoSchema.safeParse({ ...MINIMAL, estados: ['ZZ'] }).success).toBe(false);
  });

  // Regression: Firebase JS SDK v12 rejects `undefined` in addDoc/setDoc.
  it('rejects missing cfop (must be string | null, not undefined)', () => {
    const { cfop, ...without } = MINIMAL;
    void cfop;
    expect(operacaoSchema.safeParse(without).success).toBe(false);
  });
});

describe('Operacao enums and labels', () => {
  it('TIPO_NFE_LABELS covers every tipo', () => {
    expect(TIPO_NFE_LABELS[0]).toBeDefined();
    expect(TIPO_NFE_LABELS[1]).toBeDefined();
  });

  it('FIN_NFE_OPERACAO_LABELS covers every value', () => {
    for (const v of [1, 2, 3, 4] as const) {
      expect(FIN_NFE_OPERACAO_LABELS[v]).toBeDefined();
    }
  });

  it('IND_PRES_OPERACAO_LABELS covers every value', () => {
    for (const v of ['0', '1', '2', '3', '4', '5', '9'] as const) {
      expect(IND_PRES_OPERACAO_LABELS[v]).toBeDefined();
    }
  });

  it('IND_INTERMED_OPERACAO_LABELS covers every value', () => {
    expect(IND_INTERMED_OPERACAO_LABELS['0']).toBeDefined();
    expect(IND_INTERMED_OPERACAO_LABELS['1']).toBeDefined();
  });
});

describe('operacaoMeta', () => {
  it('targets the operacao collection (singular, Flutter wire name)', () => {
    expect(operacaoMeta.collectionPath).toBe('operacao');
  });

  it('uses the new fiscal BigInt permission bits (byte 9)', () => {
    expect(operacaoMeta.permissions.read).toBe(1n << 72n);
    expect(operacaoMeta.permissions.write).toBe(1n << 73n);
    expect(operacaoMeta.permissions.delete).toBe(1n << 74n);
  });
});
