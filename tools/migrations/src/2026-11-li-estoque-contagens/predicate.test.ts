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
  it('records at a Loja Integrada depósito, in an EXACT form, touched in the window', () => {
    const caminhos = registrosParaRazao(estoques, new Set([DEP]), janelaDeDias(AGORA, 3));
    expect(caminhos).toEqual([
      'produtos/OUTRO/estoques/E9',
      'produtos/PROD-DUP-A/estoques/L1',
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
      semRegistroComRegistrosEmOutroLugar: 1,
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
      linhasDaRazaoNoFuturo: 1,
      linhasDaRazaoInvalidas: 1,
      maximoDiario: { registros: 2, linhasDaRazao: 2 },
    });
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
