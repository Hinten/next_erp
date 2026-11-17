import { describe, expect, it } from 'vitest';
import {
  analisarProduto,
  baldeDoCarimbo,
  contar,
  formaDaRefDaConta,
  formaDaRefDoDeposito,
  histogramaF,
  janelaDeDias,
  operacoesDasContasLi,
  produtoDoVinculo,
  recusaSemContasLi,
  recusaSemVinculos,
  refDaOperacao,
  registrosParaRazao,
  type ContaLida,
  type EntradaDaContagem,
  type EstoqueLido,
  type LeituraDaPerna,
  type OperacaoLida,
  type Perna,
  type ProdutoLido,
  type ProdutoTocado,
  type VinculoLido,
} from './predicate';

/**
 * The decisions and the counts. Every "same / different" decision is pinned from BOTH sides: a
 * pair that must come out equal and a near-miss that must stay distinct (root `CLAUDE.md`, the
 * fold-scope rule).
 */

/* -------------------------------------------------------------------------- */
/*                                  Clock                                      */
/* -------------------------------------------------------------------------- */

/** 2026-11-17 12:00 in São Paulo (UTC−3). */
const AGORA = Date.UTC(2026, 10, 17, 15, 0, 0);
/** Noon in São Paulo on a civil day of November 2026. */
const meioDia = (dia: number): number => Date.UTC(2026, 10, dia, 15, 0, 0);

/* -------------------------------------------------------------------------- */
/*                                 Readers                                     */
/* -------------------------------------------------------------------------- */

describe('ref forms', () => {
  it('EQUAL: both stored depósito forms name one depósito, and both are what the run matches', () => {
    expect(formaDaRefDoDeposito('documents/depositos/D1')).toEqual({
      forma: 'canonica',
      depositoId: 'D1',
    });
    expect(formaDaRefDoDeposito('depositos/D1')).toEqual({ forma: 'nua', depositoId: 'D1' });
  });

  it('⚠️ NEAR-MISS: another depósito stays distinct; a leading slash folds to it but is NOT exact', () => {
    expect(formaDaRefDoDeposito('documents/depositos/D2').depositoId).toBe('D2');
    expect(formaDaRefDoDeposito('/documents/depositos/D1')).toEqual({
      forma: 'dobrada',
      depositoId: 'D1',
    });
    expect(formaDaRefDoDeposito('documents/filiais/D1')).toEqual({
      forma: 'ilegivel',
      depositoId: null,
    });
    expect(formaDaRefDoDeposito(null)).toEqual({ forma: 'ausente', depositoId: null });
    expect(formaDaRefDoDeposito(undefined)).toEqual({ forma: 'ausente', depositoId: null });
    expect(formaDaRefDoDeposito(42)).toEqual({ forma: 'ilegivel', depositoId: null });
  });

  it('EQUAL / NEAR-MISS for the conta ref: both forms ≡; a fold is dobrada; another conta distinct', () => {
    expect(formaDaRefDaConta('documents/integracao/C1')).toEqual({
      forma: 'canonica',
      contaId: 'C1',
    });
    expect(formaDaRefDaConta('integracao/C1')).toEqual({ forma: 'nua', contaId: 'C1' });
    expect(formaDaRefDaConta('/documents/integracao/C1')).toEqual({
      forma: 'dobrada',
      contaId: 'C1',
    });
    expect(formaDaRefDaConta('documents/integracao/C2').contaId).toBe('C2');
    expect(formaDaRefDaConta('documents/categorias/C1')).toEqual({
      forma: 'ilegivel',
      contaId: null,
    });
  });

  it('the operação ref: both forms are one path; another collection or a nested path is unreadable', () => {
    expect(refDaOperacao('documents/operacao/O1')).toEqual({ tipo: 'ok', caminho: 'operacao/O1' });
    expect(refDaOperacao('operacao/O1')).toEqual({ tipo: 'ok', caminho: 'operacao/O1' });
    expect(refDaOperacao('documents/operacoes/O1')).toEqual({ tipo: 'ilegivel' });
    expect(refDaOperacao('documents/operacao/O1/x/y')).toEqual({ tipo: 'ilegivel' });
    expect(refDaOperacao(null)).toEqual({ tipo: 'ausente' });
  });

  it('a link belongs to the produto in its path, exactly four segments', () => {
    expect(produtoDoVinculo('produtos/PA/produtolojaintegrada/L1')).toBe('PA');
    expect(produtoDoVinculo('outros/PA/produtolojaintegrada/L1')).toBeNull();
    expect(produtoDoVinculo('produtos/PA/x/y/produtolojaintegrada/L1')).toBeNull();
  });
});

describe('the window (São Paulo civil days)', () => {
  it('is the last N days, today included, opening at São Paulo midnight', () => {
    const janela = janelaDeDias(AGORA, 3);
    expect(janela.dias).toEqual(['2026-11-15', '2026-11-16', '2026-11-17']);
    expect(janela.inicioMs).toBe(Date.UTC(2026, 10, 15, 3, 0, 0));
  });

  it('⚠️ NEAR-MISS across midnight: 02:59:59.999Z is the day BEFORE, 03:00:00.000Z the day', () => {
    const janela = janelaDeDias(AGORA, 3);
    expect(baldeDoCarimbo(Date.UTC(2026, 10, 16, 2, 59, 59, 999), janela)).toEqual({
      tipo: 'dia',
      dia: '2026-11-15',
    });
    expect(baldeDoCarimbo(Date.UTC(2026, 10, 16, 3, 0, 0, 0), janela)).toEqual({
      tipo: 'dia',
      dia: '2026-11-16',
    });
    expect(baldeDoCarimbo(janela.inicioMs - 1, janela)).toEqual({ tipo: 'antes' });
    expect(baldeDoCarimbo(janela.inicioMs, janela)).toEqual({ tipo: 'dia', dia: '2026-11-15' });
  });

  it('a stamp after the clock is futuro; text, a fraction, null and absent are invalido', () => {
    const janela = janelaDeDias(AGORA, 3);
    expect(baldeDoCarimbo(AGORA + 3000, janela)).toEqual({ tipo: 'futuro' });
    expect(baldeDoCarimbo(AGORA, janela)).toEqual({ tipo: 'dia', dia: '2026-11-17' });
    for (const v of [String(meioDia(16)), meioDia(16) + 0.5, null, undefined]) {
      expect(baldeDoCarimbo(v, janela)).toEqual({ tipo: 'invalido' });
    }
  });

  it('refuses a window outside 1..60 days', () => {
    expect(() => janelaDeDias(AGORA, 0)).toThrow(RangeError);
    expect(() => janelaDeDias(AGORA, 61)).toThrow(RangeError);
    expect(() => janelaDeDias(AGORA, 1.5)).toThrow(RangeError);
    expect(janelaDeDias(AGORA, 60).dias).toHaveLength(60);
  });
});

describe('kits: the shared fold decides what constrains', () => {
  const kit = (componentesKit: unknown, flags: Record<string, unknown> = { ehKit: true }) =>
    analisarProduto({ ...flags, componentesKit });

  it('a component constrains with a finite quantity above 0 and limitarEstoque not false', () => {
    const p = kit({ c1: { quantidade: 2, limitarEstoque: true }, c2: { quantidade: 1 } });
    expect(p.restritivos).toEqual(['c1', 'c2']);
  });

  it('⚠️ NEAR-MISS: limitarEstoque false or quantidade 0 does NOT constrain — but the first still limits under the planned rule', () => {
    const p = kit({
      c1: { quantidade: 1, limitarEstoque: false },
      c2: { quantidade: 0, limitarEstoque: true },
      c3: { quantidade: -1 },
      c4: { quantidade: 1 },
    });
    expect(p.restritivos).toEqual(['c4']);
    expect(p.todosLimitam).toEqual(['c1', 'c4']);
  });

  it('⚠️ NEAR-MISS: the kit flags are exact — "true" or 1 is not a kit; ehKitVirtual alone is', () => {
    const comps = { c1: { quantidade: 1 } };
    expect(kit(comps, { ehKit: 'true' }).restritivos).toEqual([]);
    expect(kit(comps, { ehKit: 1 }).restritivos).toEqual([]);
    expect(kit(comps, { ehKitVirtual: true }).restritivos).toEqual(['c1']);
  });

  it('counts unreadable shapes: an array map, a non-object entry, an id that is no path segment', () => {
    expect(kit([{ quantidade: 1 }]).componentesIlegiveis).toBe(true);
    const p = kit({
      c1: { quantidade: 1 },
      lixo: 'texto',
      'a/b': { quantidade: 1 },
      '': { quantidade: 1 },
    });
    expect(p.descartados).toBe(1);
    expect(p.idsInvalidos).toBe(2);
    expect(p.restritivos).toEqual(['c1']);
    expect(kit(null).semComponentes).toBe(true);
    expect(kit({}).semComponentes).toBe(true);
  });

  it('⚠️ NEAR-MISS: a quantity that is not a finite number constrains nothing — and is COUNTED; 0 is a number', () => {
    const p = kit({
      c1: { quantidade: '2' },
      c2: {},
      c3: { quantidade: null },
      c4: { quantidade: 0 },
      c5: { quantidade: 1 },
    });
    expect(p.restritivos).toEqual(['c5']);
    expect(p.todosLimitam).toEqual(['c5']);
    expect(p.quantidadesIlegiveis).toBe(3);
    expect(kit({ c1: { quantidade: 1 } }, { ehKit: false }).quantidadesIlegiveis).toBe(0);
  });
});

describe('the F histogram', () => {
  const mapa = (tamanhos: number[]) =>
    new Map(
      tamanhos.map((n, i) => [
        `comp-${String(i)}`,
        new Set(Array.from({ length: n }, (_, k) => `kit-${String(i)}-${String(k)}`)),
      ]),
    );

  it('buckets on the 30 / 1000 edges of the stock sync, top-10 values only', () => {
    const h = histogramaF(mapa([1, 2, 5, 6, 30, 31, 1000, 1001]));
    expect(h.faixas).toEqual({
      '1': 1,
      '2-5': 2,
      '6-10': 1,
      '11-30': 1,
      '31-100': 1,
      '101-300': 0,
      '301-1000': 1,
      '>1000': 1,
    });
    expect(h.top10).toEqual([1001, 1000, 31, 30, 6, 5, 2, 1]);
    expect(h.maximo).toBe(1001);
    expect(h.componentesAcimaDoLimiteEmLinha).toBe(3);
    expect(h.kitsComComponenteAcimaDoLimiteEmLinha).toBe(31 + 1000 + 1001);
    expect(h.componentesAcimaDaFatia).toBe(1);
    expect(h.limiteEmLinha).toBe(30);
    expect(h.limiteDaFatia).toBe(1000);
  });

  it('a kit shared by two components is one kit; an empty map is all zeros', () => {
    const h = histogramaF(
      new Map([
        ['a', new Set(['k1', 'k2'])],
        ['b', new Set(['k1'])],
      ]),
    );
    expect(h.componentes).toBe(2);
    expect(h.kits).toBe(2);
    expect(histogramaF(new Map()).maximo).toBe(0);
  });

  it('top10 keeps exactly the ten largest of eleven, dropping the smallest', () => {
    const h = histogramaF(mapa([3, 1, 4, 10, 5, 9, 2, 6, 8, 11, 7]));
    expect(h.componentes).toBe(11);
    expect(h.top10).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  });
});

/* -------------------------------------------------------------------------- */
/*                               The corpus                                    */
/* -------------------------------------------------------------------------- */

const ALFA = 'CONTA-LI-ALFA';
const BETA = 'CONTA-LI-BETA';
const DEP = 'DEP-PRINCIPAL';
const OUTRO_DEP = 'DEP-OUTRO';

const contas: ContaLida[] = [
  {
    id: ALFA,
    tipo: 3,
    depositoOuterRef: `documents/depositos/${DEP}`,
    operacaoOuterRef: 'documents/operacao/OP-SAIDA',
    operacaoDevolucaoOuterRef: 'operacao/OP-DEV',
    ativo: true,
  },
  {
    id: BETA,
    tipo: 3,
    depositoOuterRef: `depositos/${DEP}`,
    operacaoOuterRef: null,
    operacaoDevolucaoOuterRef: 'documents/operacao/OP-SUMIDA',
    ativo: false,
  },
  {
    id: 'CONTA-ML',
    tipo: 1,
    depositoOuterRef: `documents/depositos/${DEP}`,
    operacaoOuterRef: null,
    operacaoDevolucaoOuterRef: null,
    ativo: true,
  },
  {
    id: 'CONTA-SHOPEE',
    tipo: 5,
    depositoOuterRef: `documents/depositos/${OUTRO_DEP}`,
    operacaoOuterRef: null,
    operacaoDevolucaoOuterRef: null,
    ativo: true,
  },
];

const operacoes = new Map<string, OperacaoLida>([
  [
    'operacao/OP-SAIDA',
    { existe: true, dados: { movimentaIndisponivelEstoque: true, movimentaEstoque: true } },
  ],
  ['operacao/OP-DEV', { existe: true, dados: { movimentaEstoque: false } }],
  ['operacao/OP-SUMIDA', { existe: false, dados: {} }],
]);

const link = (produto: string, doc: string, dados: Record<string, unknown>): VinculoLido => ({
  caminho: `produtos/${produto}/produtolojaintegrada/${doc}`,
  dados,
});
const canonica = (conta: string) => `documents/integracao/${conta}`;

const vinculos: VinculoLido[] = [
  link('PROD-FILHO-1', 'a', {
    contaLojaIntegrada: canonica(ALFA),
    id: 918273601,
    paiProdutoIntegradaId: 900,
  }),
  link('PROD-FILHO-1', 'b', {
    contaLojaIntegrada: `integracao/${ALFA}`,
    id: '918273601',
    paiProdutoIntegradaId: 900,
  }),
  link('PROD-FILHO-2', 'a', {
    contaLojaIntegrada: `/documents/integracao/${ALFA}`,
    id: 918273602,
    paiProdutoIntegradaId: 900,
  }),
  link('PROD-KIT', 'a', {
    contaLojaIntegrada: canonica(ALFA),
    id: 918273603,
    paiProdutoIntegradaId: 901,
  }),
  link('PROD-AMBIGUO', 'a', {
    contaLojaIntegrada: canonica(ALFA),
    id: 918273604,
    paiProdutoIntegradaId: 900,
  }),
  link('PROD-AMBIGUO', 'b', {
    contaLojaIntegrada: canonica(ALFA),
    id: 918273605,
    paiProdutoIntegradaId: 900,
  }),
  link('PROD-PAI', 'a', { contaLojaIntegrada: canonica(ALFA), id: 900, grades: [1] }),
  link('PROD-SIMPLES', 'a', { contaLojaIntegrada: canonica(ALFA), id: 918273606 }),
  link('PROD-LIXO', 'a', {
    contaLojaIntegrada: canonica(ALFA),
    id: 918273607,
    paiProdutoIntegradaId: 900,
    removido: true,
  }),
  link('PROD-ID-RUIM', 'a', { contaLojaIntegrada: canonica(ALFA), id: '0918273607' }),
  link('PROD-DUP-A', 'a', {
    contaLojaIntegrada: canonica(BETA),
    id: 918273608,
    paiProdutoIntegradaId: 902,
  }),
  link('PROD-DUP-B', 'a', {
    contaLojaIntegrada: canonica(BETA),
    id: 918273608,
    paiProdutoIntegradaId: 902,
  }),
  link('PROD-OUTRO-CANAL', 'a', { contaLojaIntegrada: canonica('CONTA-ML'), id: 1 }),
  link('PROD-SEM-CONTA', 'a', { contaLojaIntegrada: canonica('CONTA-SUMIDA'), id: 1 }),
  link('PROD-REF-RUIM', 'a', { contaLojaIntegrada: 'documents/categorias/X', id: 1 }),
  {
    caminho: 'outros/X/produtolojaintegrada/a',
    dados: { contaLojaIntegrada: canonica(ALFA), id: 1 },
  },
];

const existe = (dados: Record<string, unknown>): ProdutoLido => ({ existe: true, dados });
const produtos = new Map<string, ProdutoLido>([
  ['PROD-FILHO-1', existe({ paiId: 'PAI-ERP', ultimaModificacao: meioDia(16) })],
  ['PROD-FILHO-2', existe({ paiId: 'PAI-ERP', ultimaModificacao: 'texto' })],
  [
    'PROD-KIT',
    existe({
      ehKit: true,
      ultimaModificacao: meioDia(17),
      componentesKit: {
        'COMP-1': { quantidade: 1, limitarEstoque: true },
        'COMP-2': { quantidade: 2, limitarEstoque: false },
        'COMP-3': { quantidade: 0 },
        'a/b': { quantidade: 1 },
        'COMP-LIXO': 'texto',
      },
    }),
  ],
  ['PROD-AMBIGUO', existe({})],
  ['PROD-PAI', existe({})],
  ['PROD-SIMPLES', existe({})],
  ['PROD-LIXO', existe({})],
  ['PROD-ID-RUIM', existe({})],
  ['PROD-DUP-A', existe({ ultimaModificacao: meioDia(15) })],
  ['PROD-DUP-B', { existe: false, dados: {} }],
  ['PROD-OUTRO-CANAL', existe({})],
  ['PROD-SEM-CONTA', existe({})],
  ['PROD-REF-RUIM', existe({})],
]);

const estoque = (produto: string, id: string, dados: Record<string, unknown>): EstoqueLido => ({
  caminho: `produtos/${produto}/estoques/${id}`,
  dados,
});
const depCanon = (d: string) => `documents/depositos/${d}`;

const estoques: EstoqueLido[] = [
  estoque('PROD-FILHO-1', `est-PROD-FILHO-1-${DEP}`, {
    depositoOuterRef: depCanon(DEP),
    parentId: 'PROD-FILHO-1',
    ultimaModificacao: meioDia(16),
  }),
  estoque('PROD-FILHO-1', 'LEGADO-1', {
    depositoOuterRef: `depositos/${DEP}`,
    ultimaModificacao: meioDia(15),
  }),
  estoque('PROD-FILHO-2', 'E2', {
    depositoOuterRef: depCanon(OUTRO_DEP),
    parentId: 'PROD-FILHO-2',
    ultimaModificacao: meioDia(10),
  }),
  estoque('PROD-FILHO-2', 'E2B', {
    depositoOuterRef: `/documents/depositos/${DEP}`,
    parentId: 'PROD-FILHO-2',
    ultimaModificacao: meioDia(16),
  }),
  estoque('PROD-DUP-A', 'L1', {
    depositoOuterRef: depCanon(DEP),
    parentId: null,
    ultimaModificacao: meioDia(17),
  }),
  estoque('PROD-DUP-A', 'L2', { depositoOuterRef: depCanon(DEP), parentId: '' }),
  estoque('COMP-1', 'C1', {
    depositoOuterRef: depCanon(OUTRO_DEP),
    parentId: 'COMP-1',
    ultimaModificacao: meioDia(16),
  }),
  estoque('OUTRO', 'E9', {
    depositoOuterRef: depCanon(DEP),
    parentId: 'OUTRO-ERRADO',
    ultimaModificacao: meioDia(17),
  }),
  estoque('PROD-KIT', 'K', {
    depositoOuterRef: depCanon(DEP),
    parentId: 'PROD-KIT',
    ultimaModificacao: AGORA + 3000,
  }),
  estoque('SEM-DEP', 'E10', { depositoOuterRef: null, parentId: 'SEM-DEP' }),
  { caminho: 'outra/coisa/estoques/E', dados: { depositoOuterRef: depCanon(DEP) } },
];

const produtosTocados: ProdutoTocado[] = [
  { id: 'PROD-FILHO-1', ultimaModificacao: meioDia(16) },
  { id: 'PROD-PAI', ultimaModificacao: meioDia(17) },
  { id: 'OUTRO-P', ultimaModificacao: meioDia(15) },
  { id: 'PROD-FUTURO', ultimaModificacao: AGORA + 1000 },
  { id: 'PROD-TEXTO', ultimaModificacao: 'abc' },
];

const leituraZero = (): LeituraDaPerna => ({ documentos: 0, consultas: 0, consultasVazias: 0 });
const leituras: Record<Perna, LeituraDaPerna> = {
  contas: { documentos: 4, consultas: 1, consultasVazias: 0 },
  operacoes: { documentos: 3, consultas: 1, consultasVazias: 0 },
  vinculos: { documentos: 16, consultas: 1, consultasVazias: 0 },
  produtos: { documentos: 13, consultas: 1, consultasVazias: 0 },
  estoques: { documentos: 11, consultas: 1, consultasVazias: 0 },
  produtosTocados: { documentos: 5, consultas: 1, consultasVazias: 0 },
  razao: { documentos: 6, consultas: 5, consultasVazias: 1 },
};

const razao = new Map<string, readonly unknown[]>([
  [`produtos/PROD-FILHO-1/estoques/est-PROD-FILHO-1-${DEP}`, [meioDia(16), meioDia(16) + 1]],
  ['produtos/PROD-FILHO-1/estoques/LEGADO-1', []],
  ['produtos/PROD-DUP-A/estoques/L1', [meioDia(17)]],
  ['produtos/OUTRO/estoques/E9', [meioDia(17), 'x']],
  ['produtos/PROD-KIT/estoques/K', [AGORA + 3000]],
]);

const entrada = (over: Partial<EntradaDaContagem> = {}): EntradaDaContagem => ({
  agoraMs: AGORA,
  dias: 3,
  contas,
  operacoes,
  vinculos,
  produtos,
  estoques,
  produtosTocados,
  razao,
  leituras,
  ...over,
});

/** Reach into the summary's untyped sections. */
const sec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

describe('the refusals', () => {
  it('no Loja Integrada conta, or no counting link of one, refuses', () => {
    expect(recusaSemContasLi(contas)).toBeNull();
    expect(recusaSemContasLi(contas.filter((c) => c.tipo !== 3))).toBe('sem-contas-li');
    expect(recusaSemVinculos(contas, vinculos)).toBeNull();
    expect(
      recusaSemVinculos(
        contas,
        vinculos.filter((v) => v.dados.removido === true),
      ),
    ).toBe('sem-vinculos-que-contam');
    // Only another channel's links, or links naming a conta that is gone: still no measurement.
    expect(
      recusaSemVinculos(
        contas,
        vinculos.filter(
          (v) => v.caminho.includes('OUTRO-CANAL') || v.caminho.includes('SEM-CONTA'),
        ),
      ),
    ).toBe('sem-vinculos-que-contam');
  });

  it('names each Loja Integrada conta’s operações, both refs, unique', () => {
    expect(operacoesDasContasLi(contas)).toEqual([
      'operacao/OP-DEV',
      'operacao/OP-SAIDA',
      'operacao/OP-SUMIDA',
    ]);
  });
});

describe('the ledger leg reads only what it must', () => {
  it('records at a Loja Integrada depósito, in an EXACT form, touched in the window OR with no numeric stamp', () => {
    const caminhos = registrosParaRazao(
      [
        ...estoques,
        // ⚠️ NEAR-MISS: a numeric stamp before the window is not read.
        estoque('PROD-VELHO', 'V', {
          depositoOuterRef: depCanon(DEP),
          ultimaModificacao: meioDia(10),
        }),
      ],
      new Set([DEP]),
      janelaDeDias(AGORA, 3),
    );
    expect(caminhos).toEqual([
      'produtos/OUTRO/estoques/E9',
      'produtos/PROD-DUP-A/estoques/L1',
      // No stamp at all: no range places it, so its ledger is read.
      'produtos/PROD-DUP-A/estoques/L2',
      // Codepoint order: `L` sorts before `e`.
      'produtos/PROD-FILHO-1/estoques/LEGADO-1',
      `produtos/PROD-FILHO-1/estoques/est-PROD-FILHO-1-${DEP}`,
      'produtos/PROD-KIT/estoques/K',
    ]);
  });
});

describe('contar — the seven counts over one corpus', () => {
  const { resumo, achados, ignorados } = contar(entrada());

  it('(3)+(4) contas: pseudonyms by linked children, the shared depósito, the operação flags', () => {
    const c = sec(resumo.contas);
    const lojas = sec(c.lojas);
    expect(Object.keys(lojas)).toEqual(['loja-1', 'loja-2']);
    expect(lojas['loja-1']).toEqual({
      deposito: 'dep-1',
      formaDoDeposito: 'canonica',
      ativo: 'true',
      operacao: { movimentaIndisponivelEstoque: 'true', movimentaEstoque: 'true' },
      operacaoDevolucao: { movimentaIndisponivelEstoque: 'ausente', movimentaEstoque: 'false' },
      mesmaOperacaoNasDuas: false,
    });
    expect(sec(lojas['loja-2'])).toMatchObject({
      deposito: 'dep-1',
      formaDoDeposito: 'nua',
      ativo: 'false',
      operacao: { movimentaIndisponivelEstoque: 'ref-ausente', movimentaEstoque: 'ref-ausente' },
      operacaoDevolucao: {
        movimentaIndisponivelEstoque: 'operacao-inexistente',
        movimentaEstoque: 'operacao-inexistente',
      },
    });
    // Both stored forms of ONE depósito are one depósito.
    expect(c.contasLiNoMesmoDeposito).toBe(true);
    // The active Shopee conta stocks elsewhere, so not even the active ones share one.
    expect(c.todasAtivasNoMesmoDeposito).toBe(false);
    expect(c.mercadoLivre).toEqual({
      contas: 1,
      ativas: 1,
      semDeposito: 0,
      noDepositoLi: 1,
      porDeposito: { 'dep-1': 1 },
    });
    expect(c.shopee).toEqual({
      contas: 1,
      ativas: 1,
      semDeposito: 0,
      noDepositoLi: 0,
      porDeposito: { 'dep-2': 1 },
    });
    expect(c.todasNoMesmoDeposito).toBe(false);
    expect(achados).toContainEqual({
      caminho: `integracao/${ALFA}`,
      classe: 'pseudonimo-conta',
      valor: 'loja-1',
    });
    expect(achados).toContainEqual({
      caminho: `depositos/${DEP}`,
      classe: 'pseudonimo-deposito',
      valor: 'dep-1',
    });
  });

  it('links: number ≡ canonical text (one product), two ids ambiguous, text id flagged, trash excluded', () => {
    const v = sec(resumo.vinculos);
    expect(sec(v.lojas)['loja-1']).toEqual({
      documentos: 10,
      formasDaConta: { canonica: 8, nua: 1, dobrada: 1 },
      removidos: 1,
      contam: 8,
      idTexto: 1,
      idIlegivel: 1,
      filhos: 6,
      raizesComGrades: 1,
      raizesSemGrades: 1,
      produtos: { vinculados: 3, pais: 1, naoSuportados: 1, ambiguos: 1 },
      idsDuplicados: 0,
      filhosComIdDuplicado: 0,
    });
    expect(sec(v.lojas)['loja-2']).toMatchObject({
      contam: 2,
      produtos: { vinculados: 2, pais: 0, naoSuportados: 0, ambiguos: 0 },
      idsDuplicados: 1,
      filhosComIdDuplicado: 2,
    });
    expect(v).toMatchObject({
      documentos: 16,
      caminhoInesperado: 1,
      contaAusente: 0,
      contaIlegivel: 1,
      contaInexistente: 1,
      contaDeOutroTipo: 1,
    });
  });

  it('(1) kits: the constrained set through the shared fold, F per conta, the planned-rule F', () => {
    const k = sec(sec(resumo.kits).lojas)['loja-1'] as Record<string, unknown>;
    expect(k).toMatchObject({
      vinculadosExistentes: 3,
      ehKit: 1,
      ehKitVirtual: 0,
      kits: 1,
      restritos: 1,
      semRestricao: 0,
      comComponentesDescartados: 1,
      comComponenteIdInvalido: 1,
    });
    expect(sec(k.F)).toMatchObject({ componentes: 1, kits: 1, top10: [1], maximo: 1 });
    expect(sec(k.FSeTodosLimitarem)).toMatchObject({ componentes: 2, kits: 1, top10: [1, 1] });
    expect(achados).toContainEqual({
      caminho: 'produtos/PROD-KIT',
      classe: 'kit-vinculado',
      valor: { conta: 'loja-1', restritivos: ['COMP-1'], todosLimitam: ['COMP-1', 'COMP-2'] },
    });
    const combinado = sec(sec(resumo.kits).combinado);
    expect(sec(combinado.F)).toMatchObject({ componentes: 1, kits: 1, top10: [1] });
    expect(sec(combinado.FSeTodosLimitarem)).toMatchObject({ componentes: 2, kits: 1 });
  });

  it('(6) no record at the depósito: elsewhere vs none, the fold-only case, the >5% gate', () => {
    const s = sec(sec(resumo.semRegistro).lojas);
    expect(s['loja-1']).toMatchObject({
      deposito: 'dep-1',
      base: 2,
      comRegistro: 1,
      comRegistroCanonico: 1,
      comRegistroLegado: 0,
      estoqueAmbiguo: 0,
      semRegistroNoDeposito: 1,
      // Its folded record AT the depósito wins over its record elsewhere: the mapping is right.
      semRegistroComRegistrosEmOutroLugar: 0,
      semNenhumRegistro: 0,
      soNaFormaDobrada: 1,
      fracaoSemRegistro: 0.5,
      acimaDoLimite: true,
      kitsRestritos: 1,
      kitsComComponenteSemRegistro: 1,
      kitsSemNenhumComponenteNoDeposito: 1,
    });
    expect(s['loja-2']).toMatchObject({
      base: 1,
      produtosAusentes: 1,
      comIdDuplicado: 1,
      estoqueAmbiguo: 1,
      semRegistroNoDeposito: 0,
      fracaoSemRegistro: 0,
      acimaDoLimite: false,
    });
  });

  it('⚠️ NEAR-MISS: the canonical record wins over a legacy one; two legacy ones are ambiguous', () => {
    const d = sec(sec(resumo.duplicados).depositos)['dep-1'];
    expect(d).toEqual({
      grupos: 2,
      registros: 4,
      comCanonico: 1,
      semCanonico: 1,
      ambiguosNaLeituraDoApp: 1,
      gruposRelevantes: 2,
      relevantesSemCanonico: 1,
    });
    expect(achados).toContainEqual({
      caminho: 'produtos/PROD-DUP-A',
      classe: 'estoque-ambiguo',
      valor: { conta: 'loja-2', deposito: 'dep-1' },
    });
  });

  it('(7) parentId: absent, null, empty and a disagreeing owner, corpus-wide and where it matters', () => {
    const p = sec(resumo.semParentId);
    expect(p.corpus).toEqual({ ok: 6, ausente: 1, nulo: 1, vazio: 1, diverge: 1, 'outro-tipo': 0 });
    expect(p.relevantes).toEqual({ registros: 6, semParentId: 3, parentIdDiverge: 0 });
    // Every record at a Loja Integrada depósito, linked or not (the disagreeing one is unlinked).
    expect(p.depositosLi).toEqual({
      ok: 3,
      ausente: 1,
      nulo: 1,
      vazio: 1,
      diverge: 1,
      'outro-tipo': 0,
    });
    expect(sec(resumo.formasDoDeposito)).toMatchObject({
      corpus: { canonica: 7, nua: 1, dobrada: 1, ilegivel: 0, ausente: 1 },
      caminhoInesperado: 1,
      depositosLi: { 'dep-1': { canonica: 5, nua: 1, dobrada: 1 } },
    });
  });

  it('(2) writes per day: distinct records by their last stamp, and the ledger rows', () => {
    const e = sec(sec(resumo.escritasPorDia).depositos)['dep-1'] as Record<string, unknown>;
    expect(sec(resumo.escritasPorDia).razaoDisponivel).toBe(true);
    expect(e.lojas).toEqual(['loja-1', 'loja-2']);
    expect(e.dias).toEqual({
      '2026-11-15': {
        registros: { vinculado: 1, componente: 0, outro: 0, total: 1 },
        linhasDaRazao: 0,
      },
      '2026-11-16': {
        registros: { vinculado: 1, componente: 0, outro: 0, total: 1 },
        linhasDaRazao: 2,
      },
      '2026-11-17': {
        registros: { vinculado: 1, componente: 0, outro: 1, total: 2 },
        linhasDaRazao: 2,
      },
    });
    expect(e).toMatchObject({
      registrosNaJanela: 5,
      registrosNoFuturo: 1,
      registrosSemCarimboNumerico: 1,
      registrosDobradosNaJanela: 1,
      registrosSemLinhaNaRazao: 1,
      linhasDaRazaoDeRegistrosSemCarimbo: 0,
      linhasDaRazaoNoFuturo: 1,
      linhasDaRazaoInvalidas: 1,
      // Today (the 17th, 2 records and 2 rows) is partial: the means average the 15th and 16th.
      mediaDiaria: { registros: 1, linhasDaRazao: 1 },
      maximoDiario: { registros: 2, linhasDaRazao: 2 },
    });
    expect(resumo.janela).toEqual({ de: '2026-11-15', ate: '2026-11-17', diasCompletos: 2 });
  });

  it('(2) a record with no numeric stamp still has its ledger read, its rows counted per day and apart', () => {
    const l2 = 'produtos/PROD-DUP-A/estoques/L2';
    const com = contar(entrada({ razao: new Map([...razao, [l2, [meioDia(15), meioDia(16)]]]) }));
    const e = sec(sec(com.resumo.escritasPorDia).depositos)['dep-1'] as Record<string, unknown>;
    expect(sec(sec(e.dias)['2026-11-15']).linhasDaRazao).toBe(1);
    expect(sec(sec(e.dias)['2026-11-16']).linhasDaRazao).toBe(3);
    expect(e).toMatchObject({
      registrosSemCarimboNumerico: 1,
      linhasDaRazaoDeRegistrosSemCarimbo: 2,
      // It is not a record "touched in the window with no row": that figure stays as it was.
      registrosSemLinhaNaRazao: 1,
      mediaDiaria: { registros: 1, linhasDaRazao: 2 },
    });
  });

  it('(2)+(5) with --dias 1 there is no complete day: every mean is null, never a partial day', () => {
    const um = contar(entrada({ dias: 1 })).resumo;
    const e = sec(sec(um.escritasPorDia).depositos)['dep-1'] as Record<string, unknown>;
    expect(e.mediaDiaria).toEqual({ registros: null, linhasDaRazao: null });
    expect(sec(um.produtosTocados).mediaDiaria).toBeNull();
    expect(um.janela).toEqual({ de: '2026-11-17', ate: '2026-11-17', diasCompletos: 0 });
  });

  it('(2) without the ledger: the walk-based bound stands, the ledger figures are null', () => {
    const sem = contar(entrada({ razao: null })).resumo;
    const e = sec(sec(sem.escritasPorDia).depositos)['dep-1'] as Record<string, unknown>;
    expect(sec(sem.escritasPorDia).razaoDisponivel).toBe(false);
    expect(sec(sec(e.dias)['2026-11-17']).linhasDaRazao).toBeNull();
    expect(e.registrosSemLinhaNaRazao).toBeNull();
    expect(e.registrosNaJanela).toBe(5);
  });

  it('(5) produtos touched per day, ∩ linked children and parents', () => {
    expect(sec(resumo.produtosTocados)).toMatchObject({
      total: 4,
      noFuturo: 1,
      carimboInvalido: 1,
      vinculadosLi: 1,
      paisLi: 1,
      fracaoVinculadosLi: 0.25,
      // The 15th and 16th, one each; today's one is partial.
      mediaDiaria: 1,
      porDia: {
        '2026-11-15': { total: 1, vinculadosLi: 0, paisLi: 0 },
        '2026-11-16': { total: 1, vinculadosLi: 1, paisLi: 0 },
        '2026-11-17': { total: 1, vinculadosLi: 0, paisLi: 1 },
      },
      lojas: { 'loja-1': { vinculados: 1, pais: 1 }, 'loja-2': { vinculados: 0, pais: 0 } },
      vinculadosSemCarimboNumerico: { 'loja-1': 1, 'loja-2': 0 },
    });
  });

  it('every skipped shape is counted by reason, never silently dropped', () => {
    expect(resumo.ignorados).toEqual({
      'estoque-caminho-inesperado': 1,
      'estoque-deposito-ausente': 1,
      'estoque-deposito-dobrada': 1,
      'kit-componente-id-invalido': 1,
      'kit-componentes-descartados': 1,
      'produto-ausente': 1,
      'produto-tocado-carimbo-invalido': 1,
      'razao-carimbo-invalido': 1,
      'vinculo-caminho-inesperado': 1,
      'vinculo-conta-de-outro-tipo': 1,
      'vinculo-conta-ilegivel': 1,
      'vinculo-conta-inexistente': 1,
      'vinculo-id-ilegivel': 1,
    });
    expect(ignorados).toHaveLength(13);
  });

  it('reports the reads per leg and the billed estimate', () => {
    expect(sec(resumo.leituras).estimativaDeLeiturasCobradas).toBe(
      4 + 3 + 16 + 13 + 11 + 5 + 6 + 1,
    );
  });

  it('⚠️ PRIVACY: the summary carries no input id, path or ref — counts and pseudonyms only', () => {
    const texto = JSON.stringify(resumo);
    const proibidos = [
      ALFA,
      BETA,
      'CONTA-ML',
      'CONTA-SHOPEE',
      DEP,
      OUTRO_DEP,
      'PROD-',
      'COMP-',
      'OP-SAIDA',
      'OP-DEV',
      'LEGADO',
      'est-',
      'PAI-ERP',
      'integracao/',
      'depositos/',
      'produtos/',
      'operacao/',
      '91827360',
    ];
    for (const p of proibidos) expect(texto, p).not.toContain(p);
  });

  it('is deterministic: the same corpus in another order gives the same summary and rows', () => {
    const invertido = contar(
      entrada({
        contas: [...contas].reverse(),
        vinculos: [...vinculos].reverse(),
        estoques: [...estoques].reverse(),
        produtosTocados: [...produtosTocados].reverse(),
        produtos: new Map([...produtos].reverse()),
      }),
    );
    expect(invertido.resumo).toEqual(resumo);
    expect(invertido.achados).toEqual(achados);
    expect(invertido.ignorados).toEqual(ignorados);
  });
});

describe('contar — a constraining component’s writes are their own class', () => {
  it('a component of a linked kit, written at the depósito, counts as componente, not outro', () => {
    const { resumo } = contar(
      entrada({
        estoques: [
          estoque('COMP-1', `est-COMP-1-${DEP}`, {
            depositoOuterRef: depCanon(DEP),
            parentId: 'COMP-1',
            ultimaModificacao: meioDia(16),
          }),
        ],
        razao: new Map(),
      }),
    );
    const e = sec(sec(resumo.escritasPorDia).depositos)['dep-1'] as Record<string, unknown>;
    expect(sec(sec(e.dias)['2026-11-16']).registros).toEqual({
      vinculado: 0,
      componente: 1,
      outro: 0,
      total: 1,
    });
    // With its record at the depósito, the kit no longer misses a component.
    expect(sec(sec(sec(resumo.semRegistro).lojas)['loja-1']).kitsComComponenteSemRegistro).toBe(0);
    expect(sec(resumo.semParentId).componentesRestritivos).toEqual({
      registros: 1,
      semParentId: 0,
    });
  });

  it('every leg empty but the contas and links still yields a well-formed summary', () => {
    const vazia = contar(
      entrada({
        estoques: [],
        produtosTocados: [],
        razao: new Map(),
        leituras: {
          contas: leituraZero(),
          operacoes: leituraZero(),
          vinculos: leituraZero(),
          produtos: leituraZero(),
          estoques: leituraZero(),
          produtosTocados: leituraZero(),
          razao: leituraZero(),
        },
      }),
    );
    expect(sec(vazia.resumo.produtosTocados).fracaoVinculadosLi).toBeNull();
    expect(sec(sec(vazia.resumo.semRegistro).lojas)['loja-1']).toMatchObject({
      semRegistroNoDeposito: 2,
      semNenhumRegistro: 2,
      fracaoSemRegistro: 1,
      acimaDoLimite: true,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                         Focused corpora, one count each                     */
/* -------------------------------------------------------------------------- */

/** A counting CHILD link of `conta` on `produto`. */
const filho = (produto: string, conta: string, id: number | string, doc = 'a'): VinculoLido =>
  link(produto, doc, { contaLojaIntegrada: canonica(conta), id, paiProdutoIntegradaId: 900 });

/** Every id as an existing produto with no field. */
const existentes = (...ids: string[]): Map<string, ProdutoLido> =>
  new Map(ids.map((id) => [id, existe({})]));

const conta = (
  id: string,
  tipo: number,
  depositoOuterRef: unknown,
  extra: Partial<ContaLida> = {},
): ContaLida => ({
  id,
  tipo,
  depositoOuterRef,
  operacaoOuterRef: null,
  operacaoDevolucaoOuterRef: null,
  ativo: true,
  ...extra,
});

describe('contar — (1) kits across both contas: F accumulates per component', () => {
  const kits = new Map<string, ProdutoLido>([
    [
      'KIT-1',
      existe({
        ehKit: true,
        componentesKit: { SHARED: { quantidade: 1 }, 'OWN-1': { quantidade: 1 } },
      }),
    ],
    ['KIT-2', existe({ ehKit: true, componentesKit: { SHARED: { quantidade: 2 } } })],
    [
      'KIT-V',
      existe({
        ehKitVirtual: true,
        componentesKit: { SHARED: { quantidade: 1 }, 'V-COMP': { quantidade: 1 } },
      }),
    ],
    [
      'KIT-AMBOS',
      existe({ ehKit: true, ehKitVirtual: true, componentesKit: { 'OWN-2': { quantidade: 1 } } }),
    ],
    // Its components do not constrain it: one opts out, the other has quantity 0.
    [
      'KIT-LIVRE',
      existe({
        ehKit: true,
        componentesKit: {
          'FREE-1': { quantidade: 1, limitarEstoque: false },
          ZERO: { quantidade: 0 },
        },
      }),
    ],
    ['KIT-3', existe({ ehKit: true, componentesKit: { SHARED: { quantidade: 1 } } })],
  ]);
  const { resumo } = contar(
    entrada({
      vinculos: [
        filho('KIT-1', ALFA, 1001),
        filho('KIT-2', ALFA, 1002),
        filho('KIT-V', ALFA, 1003),
        filho('KIT-AMBOS', ALFA, 1004),
        filho('KIT-LIVRE', ALFA, 1005),
        filho('KIT-3', BETA, 1006),
        // KIT-1 is linked under BOTH contas: one kit in the combined F, not two.
        filho('KIT-1', BETA, 1007, 'b'),
      ],
      produtos: kits,
      estoques: [
        estoque('SHARED', `est-SHARED-${DEP}`, { depositoOuterRef: depCanon(DEP) }),
        estoque('V-COMP', 'VA', { depositoOuterRef: depCanon(DEP) }),
        estoque('V-COMP', 'VB', { depositoOuterRef: `depositos/${DEP}` }),
        estoque('KIT-LIVRE', `est-KIT-LIVRE-${DEP}`, { depositoOuterRef: depCanon(DEP) }),
      ],
      produtosTocados: [],
      razao: new Map(),
    }),
  );
  const lojas = sec(sec(resumo.kits).lojas);

  it('counts ehKit, ehKitVirtual alone and both; a kit no component constrains is semRestricao', () => {
    expect(lojas['loja-1']).toMatchObject({
      vinculadosExistentes: 5,
      kits: 5,
      ehKit: 4,
      ehKitVirtual: 2,
      ambos: 1,
      restritos: 4,
      semRestricao: 1,
    });
  });

  it('F counts every linked kit a component constrains — three kits share one component', () => {
    const k1 = sec(lojas['loja-1']);
    expect(sec(k1.F)).toMatchObject({ componentes: 4, kits: 4, top10: [3, 1, 1, 1], maximo: 3 });
    // The planned rule: the opted-out component limits too; quantity 0 still does not.
    expect(sec(k1.FSeTodosLimitarem)).toMatchObject({
      componentes: 5,
      kits: 5,
      top10: [3, 1, 1, 1, 1],
    });
    expect(sec(sec(lojas['loja-2']).F)).toMatchObject({ componentes: 2, kits: 2, top10: [2, 1] });
  });

  it('the combined F unions the contas: a kit linked under both counts once', () => {
    const combinado = sec(sec(resumo.kits).combinado);
    expect(sec(combinado.F)).toMatchObject({
      componentes: 4,
      kits: 5,
      top10: [4, 1, 1, 1],
      maximo: 4,
    });
    expect(sec(combinado.FSeTodosLimitarem)).toMatchObject({
      componentes: 5,
      kits: 6,
      top10: [4, 1, 1, 1, 1],
    });
  });

  it('(6) a kit missing SOME constraining components is not one missing all; an ambiguous one apart', () => {
    const s = sec(sec(resumo.semRegistro).lojas);
    expect(s['loja-1']).toMatchObject({
      // The unconstrained kit's own record feeds its quantity: it is in the >5% base.
      base: 1,
      comRegistro: 1,
      kitsRestritos: 4,
      // KIT-1 (one of two missing) and KIT-AMBOS (its only one missing).
      kitsComComponenteSemRegistro: 2,
      kitsSemNenhumComponenteNoDeposito: 1,
      // KIT-V: one component has two legacy records there.
      kitsComComponenteAmbiguo: 1,
    });
    expect(s['loja-2']).toMatchObject({
      base: 0,
      fracaoSemRegistro: null,
      acimaDoLimite: null,
      kitsRestritos: 2,
      kitsComComponenteSemRegistro: 1,
      kitsSemNenhumComponenteNoDeposito: 0,
    });
  });
});

describe('contar — (3) one depósito or several, from both sides', () => {
  const contasDe = (lista: ContaLida[]) => sec(contar(entrada({ contas: lista })).resumo.contas);

  it('EQUAL: every channel names one depósito, each in a different stored form ⇒ true', () => {
    const c = contasDe([
      conta(ALFA, 3, depCanon(DEP)),
      conta(BETA, 3, `depositos/${DEP}`),
      conta('CONTA-ML', 1, `depositos/${DEP}`),
      conta('CONTA-SHOPEE', 5, depCanon(DEP)),
    ]);
    expect(c.contasLiNoMesmoDeposito).toBe(true);
    expect(c.todasNoMesmoDeposito).toBe(true);
    expect(c.todasAtivasNoMesmoDeposito).toBe(true);
  });

  it('⚠️ NEAR-MISS: the two Loja Integrada contas at two depósitos ⇒ false', () => {
    const c = contasDe([
      conta(ALFA, 3, depCanon(DEP)),
      conta(BETA, 3, depCanon(OUTRO_DEP)),
      conta('CONTA-ML', 1, depCanon(DEP)),
    ]);
    expect(c.contasLiNoMesmoDeposito).toBe(false);
    expect(c.todasNoMesmoDeposito).toBe(false);
  });

  it('⚠️ NEAR-MISS: a conta with no readable depósito ⇒ false, never a match on null', () => {
    const c = contasDe([conta(ALFA, 3, depCanon(DEP)), conta(BETA, 3, null)]);
    expect(c.contasLiNoMesmoDeposito).toBe(false);
    expect(c.todasNoMesmoDeposito).toBe(false);
  });

  it('a DEACTIVATED conta at another depósito breaks "all", not "all active"', () => {
    const c = contasDe([
      conta(ALFA, 3, depCanon(DEP)),
      conta(BETA, 3, `depositos/${DEP}`),
      conta('CONTA-ML', 1, depCanon(DEP)),
      conta('CONTA-SHOPEE', 5, depCanon(OUTRO_DEP), { ativo: false }),
    ]);
    expect(c.todasNoMesmoDeposito).toBe(false);
    expect(c.todasAtivasNoMesmoDeposito).toBe(true);
  });
});

describe('contar — (4) an operação flag that is not a boolean is not read as one', () => {
  it('"true", 1, 0 and null are other classes; an unreadable operação ref is counted', () => {
    const { resumo } = contar(
      entrada({
        contas: [
          conta(ALFA, 3, depCanon(DEP), {
            operacaoOuterRef: 'documents/operacao/OP-TEXTO',
            operacaoDevolucaoOuterRef: 'operacao/OP-TEXTO',
            ativo: 'sim',
          }),
          conta(BETA, 3, depCanon(DEP), {
            operacaoOuterRef: 'operacao/OP-NULO',
            operacaoDevolucaoOuterRef: 'documents/operacoes/X',
          }),
        ],
        operacoes: new Map<string, OperacaoLida>([
          [
            'operacao/OP-TEXTO',
            { existe: true, dados: { movimentaIndisponivelEstoque: 'true', movimentaEstoque: 1 } },
          ],
          [
            'operacao/OP-NULO',
            { existe: true, dados: { movimentaIndisponivelEstoque: null, movimentaEstoque: 0 } },
          ],
        ]),
      }),
    );
    const lojas = sec(sec(resumo.contas).lojas);
    expect(lojas['loja-1']).toMatchObject({
      ativo: 'outro-tipo',
      operacao: { movimentaIndisponivelEstoque: 'outro-tipo', movimentaEstoque: 'outro-tipo' },
      operacaoDevolucao: {
        movimentaIndisponivelEstoque: 'outro-tipo',
        movimentaEstoque: 'outro-tipo',
      },
      // Both stored forms of one operação are one operação.
      mesmaOperacaoNasDuas: true,
    });
    expect(lojas['loja-2']).toMatchObject({
      operacao: { movimentaIndisponivelEstoque: 'nulo', movimentaEstoque: 'outro-tipo' },
      operacaoDevolucao: {
        movimentaIndisponivelEstoque: 'ref-ilegivel',
        movimentaEstoque: 'ref-ilegivel',
      },
      mesmaOperacaoNasDuas: false,
    });
    expect(resumo.ignorados['operacao-ref-ilegivel']).toBe(1);
  });
});

describe('contar — (6) the canonical record and the >5% gate, on its edge', () => {
  const ids = Array.from({ length: 20 }, (_, i) => `F${String(i + 1).padStart(2, '0')}`);
  /** Twenty linked children: F01 has only a LEGACY record, F02..F19 the canonical one. */
  const registros = (semRegistro: readonly string[]): EstoqueLido[] =>
    ids
      .filter((id) => id !== 'F20' && !semRegistro.includes(id))
      .map((id) =>
        id === 'F01'
          ? estoque(id, 'AUTO-F01', { depositoOuterRef: `depositos/${DEP}` })
          : estoque(id, `est-${id}-${DEP}`, { depositoOuterRef: depCanon(DEP) }),
      );
  const loja1 = (semRegistro: readonly string[]) =>
    sec(
      sec(
        contar(
          entrada({
            vinculos: ids.map((id, i) => filho(id, ALFA, 5000 + i)),
            produtos: existentes(...ids),
            estoques: registros(semRegistro),
            produtosTocados: [],
            razao: new Map(),
          }),
        ).resumo.semRegistro,
      ).lojas,
    )['loja-1'];

  it('⚠️ NEAR-MISS: a lone LEGACY record is read (comRegistro) but is not canonical', () => {
    expect(loja1([])).toMatchObject({
      base: 20,
      comRegistro: 19,
      comRegistroCanonico: 18,
      comRegistroLegado: 1,
    });
  });

  it('exactly 5% (1 of 20) is NOT above the gate; 10% (2 of 20) is', () => {
    expect(loja1([])).toMatchObject({
      semRegistroNoDeposito: 1,
      semNenhumRegistro: 1,
      fracaoSemRegistro: 0.05,
      acimaDoLimite: false,
    });
    expect(loja1(['F19'])).toMatchObject({
      semRegistroNoDeposito: 2,
      fracaoSemRegistro: 0.1,
      acimaDoLimite: true,
    });
  });
});

describe('contar — (6) no record at the depósito: three disjoint cases', () => {
  const { resumo, achados } = contar(
    entrada({
      vinculos: ['CASO-1', 'CASO-2', 'CASO-3', 'CASO-4', 'CASO-5', 'CASO-6'].map((id, i) =>
        filho(id, ALFA, 6000 + i),
      ),
      produtos: existentes('CASO-1', 'CASO-2', 'CASO-3', 'CASO-4', 'CASO-5', 'CASO-6'),
      estoques: [
        // Folded, AT the depósito.
        estoque('CASO-1', 'X', { depositoOuterRef: `/documents/depositos/${DEP}` }),
        // ⚠️ NEAR-MISS: folded, but at ANOTHER depósito — that is "elsewhere".
        estoque('CASO-2', 'X', { depositoOuterRef: `/documents/depositos/${OUTRO_DEP}` }),
        estoque('CASO-3', `est-CASO-3-${OUTRO_DEP}`, { depositoOuterRef: depCanon(OUTRO_DEP) }),
        // CASO-4: nothing anywhere. CASO-5: a record with no depósito at all is still a record.
        estoque('CASO-5', 'X', { depositoOuterRef: null }),
        // Folded at the depósito AND a record elsewhere: the folded one decides.
        estoque('CASO-6', 'X', { depositoOuterRef: `/documents/depositos/${DEP}` }),
        estoque('CASO-6', `est-CASO-6-${OUTRO_DEP}`, { depositoOuterRef: depCanon(OUTRO_DEP) }),
      ],
      produtosTocados: [],
      razao: new Map(),
    }),
  );

  it('folded at the depósito, elsewhere, none — they add up to the no-record count', () => {
    expect(sec(sec(resumo.semRegistro).lojas)['loja-1']).toMatchObject({
      base: 6,
      comRegistro: 0,
      semRegistroNoDeposito: 6,
      soNaFormaDobrada: 2,
      semRegistroComRegistrosEmOutroLugar: 3,
      semNenhumRegistro: 1,
      fracaoSemRegistro: 1,
    });
    expect(achados).toContainEqual({
      caminho: 'produtos/CASO-1',
      classe: 'sem-registro-no-deposito',
      valor: { conta: 'loja-1', deposito: 'dep-1', caso: 'so-na-forma-dobrada' },
    });
    expect(achados).toContainEqual({
      caminho: 'produtos/CASO-2',
      classe: 'sem-registro-no-deposito',
      valor: { conta: 'loja-1', deposito: 'dep-1', caso: 'registros-em-outro-lugar' },
    });
  });
});

describe('contar — (7) duplicates the app can and cannot read, and parentId where it matters', () => {
  const { resumo } = contar(
    entrada({
      vinculos: [filho('H1', ALFA, 7001), filho('H2', ALFA, 7002)],
      produtos: existentes('H1', 'H2'),
      estoques: [
        // One exact legacy record and one folded: the run reads the exact one, no ambiguity.
        estoque('H1', 'X1', { depositoOuterRef: `depositos/${DEP}`, parentId: 'OUTRO' }),
        estoque('H1', 'X2', { depositoOuterRef: `/documents/depositos/${DEP}`, parentId: 7 }),
        // ⚠️ NEAR-MISS: the canonical id of ANOTHER depósito, stored at this one, is not canonical here.
        estoque('H2', `est-H2-${OUTRO_DEP}`, { depositoOuterRef: depCanon(DEP), parentId: 'H2' }),
        estoque('H2', 'AUTO', { depositoOuterRef: `depositos/${DEP}`, parentId: 'H2' }),
      ],
      produtosTocados: [],
      razao: new Map(),
    }),
  );

  it('a folded record beside an exact one is no ambiguity; another depósito’s canonical id is none here', () => {
    expect(sec(sec(resumo.duplicados).depositos)['dep-1']).toEqual({
      grupos: 2,
      registros: 4,
      comCanonico: 0,
      semCanonico: 2,
      ambiguosNaLeituraDoApp: 1,
      gruposRelevantes: 2,
      relevantesSemCanonico: 2,
    });
    expect(sec(sec(resumo.semRegistro).lojas)['loja-1']).toMatchObject({
      comRegistro: 1,
      comRegistroCanonico: 0,
      comRegistroLegado: 1,
      estoqueAmbiguo: 1,
    });
  });

  it('a disagreeing owner and a numeric parentId on a LINKED child’s records are counted', () => {
    const p = sec(resumo.semParentId);
    expect(p.relevantes).toEqual({ registros: 4, semParentId: 1, parentIdDiverge: 1 });
    expect(p.depositosLi).toEqual({
      ok: 2,
      ausente: 0,
      nulo: 0,
      vazio: 0,
      diverge: 1,
      'outro-tipo': 1,
    });
  });
});

describe('contar — duplicate store ids: the key folds a number and its text, nothing more', () => {
  it('number on one produto ≡ its text on another; two different ids stay apart', () => {
    const { resumo } = contar(
      entrada({
        vinculos: [
          filho('DA', ALFA, 918273609),
          filho('DB', ALFA, '918273609'),
          filho('DC', ALFA, 918273610),
          filho('DD', ALFA, 918273611),
        ],
        produtos: existentes('DA', 'DB', 'DC', 'DD'),
      }),
    );
    expect(sec(sec(resumo.vinculos).lojas)['loja-1']).toMatchObject({
      contam: 4,
      idTexto: 1,
      idsDuplicados: 1,
      filhosComIdDuplicado: 2,
    });
    expect(sec(sec(resumo.semRegistro).lojas)['loja-1']).toMatchObject({ comIdDuplicado: 2 });
  });
});

describe('contar — every remaining skip reason is counted, never silently dropped', () => {
  const GAMA = 'CONTA-LI-GAMA';
  const { resumo } = contar(
    entrada({
      contas: [
        ...contas,
        conta(GAMA, 3, 'documents/filiais/X', { operacaoOuterRef: 'documents/operacoes/X' }),
      ],
      vinculos: [
        ...vinculos,
        link('PROD-SEM-REF', 'a', { id: 5, paiProdutoIntegradaId: 900 }),
        filho('KIT-ARR', ALFA, 918273620),
        filho('KIT-QTD', ALFA, 918273621),
        filho('G-ILEG', GAMA, 918273622),
      ],
      produtos: new Map([
        ...produtos,
        ['KIT-ARR', existe({ ehKit: true, componentesKit: [{ quantidade: 1 }] })],
        [
          'KIT-QTD',
          existe({
            ehKit: true,
            componentesKit: {
              'QTD-TEXTO': { quantidade: '2' },
              'QTD-AUSENTE': {},
              'QTD-OK': { quantidade: 1 },
            },
          }),
        ],
        ['G-ILEG', existe({})],
        ['PROD-SEM-REF', existe({})],
      ]),
      estoques: [...estoques, estoque('PROD-X', 'F', { depositoOuterRef: 'documents/filiais/X' })],
    }),
  );

  it('an unreadable record or conta depósito, a link with no conta, an unreadable kit or quantity', () => {
    expect(resumo.ignorados).toEqual({
      'conta-deposito-ilegivel': 1,
      'estoque-caminho-inesperado': 1,
      'estoque-deposito-ausente': 1,
      'estoque-deposito-dobrada': 1,
      'estoque-deposito-ilegivel': 1,
      'kit-componente-id-invalido': 1,
      'kit-componente-quantidade-ilegivel': 1,
      'kit-componentes-descartados': 1,
      'kit-componentes-ilegiveis': 1,
      'operacao-ref-ilegivel': 1,
      'produto-ausente': 1,
      'produto-tocado-carimbo-invalido': 1,
      'razao-carimbo-invalido': 1,
      'vinculo-caminho-inesperado': 1,
      'vinculo-conta-ausente': 1,
      'vinculo-conta-de-outro-tipo': 1,
      'vinculo-conta-ilegivel': 1,
      'vinculo-conta-inexistente': 1,
      'vinculo-id-ilegivel': 1,
    });
    expect(sec(resumo.vinculos).contaAusente).toBe(1);
    expect(sec(sec(resumo.formasDoDeposito).corpus).ilegivel).toBe(1);
    expect(sec(sec(resumo.kits).lojas)['loja-1']).toMatchObject({
      componentesKitIlegiveis: 1,
      comComponenteQuantidadeIlegivel: 1,
    });
  });

  it('⚠️ a conta whose depósito cannot be read reports NO share — never a 0% that passes the gate', () => {
    expect(sec(sec(resumo.semRegistro).lojas)['loja-3']).toMatchObject({
      deposito: null,
      depositoIlegivel: true,
      base: 1,
      comRegistro: null,
      semRegistroNoDeposito: null,
      fracaoSemRegistro: null,
      acimaDoLimite: null,
      kitsComComponenteSemRegistro: null,
    });
    expect(sec(resumo.contas).contasLiNoMesmoDeposito).toBe(false);
  });
});
