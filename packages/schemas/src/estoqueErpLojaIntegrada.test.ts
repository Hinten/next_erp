import { describe, expect, it } from 'vitest';
import {
  caminhoEstoqueLi,
  depositoDaContaLi,
  estoqueNoDepositoLi,
  formasDoDepositoLi,
  idsDosVinculosDaContaLi,
  segmentoDeCaminhoLi,
  vinculoDaContaLi,
} from './estoqueErpLojaIntegrada';

/**
 * The Loja Integrada stock sync's shared ERP readers. The app's suites
 * (`apps/loja-integrada/lib/lojaIntegrada/estoque/*.test.ts`) still pin them through the
 * re-exports; these pin each reader's equal pair and its near-miss where it is defined, because a
 * `tools/migrations` audit calls it directly.
 */

const registro = (produtoId: string, estoqueId: string) => ({
  caminho: `produtos/${produtoId}/estoques/${estoqueId}`,
  dados: {},
});

describe('caminhoEstoqueLi / segmentoDeCaminhoLi', () => {
  it('splits exactly produtos/{p}/estoques/{e}', () => {
    expect(caminhoEstoqueLi('produtos/p1/estoques/e1')).toEqual({
      produtoId: 'p1',
      estoqueId: 'e1',
    });
  });

  it('⚠️ NEAR-MISS: a leading slash, a documents/ prefix, another leaf or an empty segment is null', () => {
    expect(caminhoEstoqueLi('/produtos/p1/estoques/e1')).toBeNull();
    expect(caminhoEstoqueLi('documents/produtos/p1/estoques/e1')).toBeNull();
    expect(caminhoEstoqueLi('produtos/p1/historicoEstoque/e1')).toBeNull();
    expect(caminhoEstoqueLi('produtos//estoques/e1')).toBeNull();
    expect(caminhoEstoqueLi('produtos/p1/estoques/e1/historicoEstoque/h1')).toBeNull();
  });

  it('a segment is non-empty and slash-free', () => {
    expect(segmentoDeCaminhoLi('d1')).toBe(true);
    expect(segmentoDeCaminhoLi('')).toBe(false);
    expect(segmentoDeCaminhoLi('depositos/d1')).toBe(false);
  });
});

describe('depositoDaContaLi / formasDoDepositoLi', () => {
  it('EQUAL: both stored forms (and a folded spelling) read as one bare id', () => {
    expect(depositoDaContaLi({ depositoOuterRef: 'documents/depositos/D1' })).toBe('D1');
    expect(depositoDaContaLi({ depositoOuterRef: 'depositos/D1' })).toBe('D1');
    expect(depositoDaContaLi({ depositoOuterRef: '/documents/depositos/D1' })).toBe('D1');
  });

  it('⚠️ NEAR-MISS: another depósito stays distinct; another collection, a nested path or junk is null', () => {
    expect(depositoDaContaLi({ depositoOuterRef: 'documents/depositos/D2' })).toBe('D2');
    expect(depositoDaContaLi({ depositoOuterRef: 'documents/filiais/D1' })).toBeNull();
    expect(depositoDaContaLi({ depositoOuterRef: 'documents/depositos/D1/sub/x' })).toBeNull();
    expect(depositoDaContaLi({ depositoOuterRef: 'D1' })).toBeNull();
    expect(depositoDaContaLi({ depositoOuterRef: null })).toBeNull();
    expect(depositoDaContaLi({ depositoOuterRef: 7 })).toBeNull();
    expect(depositoDaContaLi({})).toBeNull();
  });

  it('names the two exact stored forms, canonical first — a folded spelling is neither', () => {
    const formas = formasDoDepositoLi('D1');
    expect(formas).toEqual(['documents/depositos/D1', 'depositos/D1']);
    expect(formas).not.toContain('/documents/depositos/D1');
  });
});

describe('estoqueNoDepositoLi — canonical wins', () => {
  it('none, the only one, and the same path read twice as one', () => {
    expect(estoqueNoDepositoLi({ produtoId: 'p1', depositoId: 'd1', registros: [] })).toEqual({
      tipo: 'nenhum',
    });
    const legado = registro('p1', 'auto-1');
    expect(
      estoqueNoDepositoLi({ produtoId: 'p1', depositoId: 'd1', registros: [legado, legado] }),
    ).toEqual({ tipo: 'um', registro: legado });
  });

  it('EQUAL: the canonical record wins over a legacy one beside it', () => {
    const canonico = registro('p1', 'est-p1-d1');
    expect(
      estoqueNoDepositoLi({
        produtoId: 'p1',
        depositoId: 'd1',
        registros: [registro('p1', 'auto-1'), canonico],
      }),
    ).toEqual({ tipo: 'um', registro: canonico });
  });

  it('⚠️ NEAR-MISS: two legacy records, or the canonical id of ANOTHER depósito, are ambiguous', () => {
    expect(
      estoqueNoDepositoLi({
        produtoId: 'p1',
        depositoId: 'd1',
        registros: [registro('p1', 'auto-1'), registro('p1', 'auto-2')],
      }),
    ).toEqual({ tipo: 'ambiguo' });
    expect(
      estoqueNoDepositoLi({
        produtoId: 'p1',
        depositoId: 'd1',
        registros: [registro('p1', 'auto-1'), registro('p1', 'est-p1-d2')],
      }),
    ).toEqual({ tipo: 'ambiguo' });
  });

  it('throws on a ref for an id and on another produto’s record (bugs, never data)', () => {
    expect(() =>
      estoqueNoDepositoLi({ produtoId: 'p1', depositoId: 'depositos/d1', registros: [] }),
    ).toThrow(RangeError);
    expect(() =>
      estoqueNoDepositoLi({ produtoId: 'p1', depositoId: 'd1', registros: [registro('p2', 'e')] }),
    ).toThrow(RangeError);
  });
});

describe('vinculoDaContaLi', () => {
  const filho = (id: unknown, extra: Record<string, unknown> = {}) => ({
    contaLojaIntegrada: 'documents/integracao/C1',
    id,
    paiProdutoIntegradaId: 900,
    ...extra,
  });

  it('EQUAL: a number id and its canonical text are ONE store product, either conta ref form', () => {
    expect(
      vinculoDaContaLi('C1', [filho(123), filho('123', { contaLojaIntegrada: 'integracao/C1' })]),
    ).toEqual({ tipo: 'vinculado', idLi: '123' });
  });

  it('⚠️ NEAR-MISS: two different ids are ambiguous; non-canonical text never counts', () => {
    expect(vinculoDaContaLi('C1', [filho(123), filho(124)])).toEqual({ tipo: 'vinculo-ambiguo' });
    expect(vinculoDaContaLi('C1', [filho('0123')])).toEqual({ tipo: 'sem-vinculo' });
  });

  it('sem-vinculo: another conta’s link, one in the trash, no link at all', () => {
    expect(
      vinculoDaContaLi('C1', [filho(123, { contaLojaIntegrada: 'documents/integracao/C2' })]),
    ).toEqual({ tipo: 'sem-vinculo' });
    expect(vinculoDaContaLi('C1', [filho(123, { removido: true })])).toEqual({
      tipo: 'sem-vinculo',
    });
    expect(vinculoDaContaLi('C1', [])).toEqual({ tipo: 'sem-vinculo' });
  });

  it('roots: all with grades ⇒ pai; any without ⇒ nao-suportado; a null parent id is a root', () => {
    const raiz = (extra: Record<string, unknown>) =>
      filho(123, { paiProdutoIntegradaId: null, ...extra });
    expect(vinculoDaContaLi('C1', [raiz({ grades: [1] })])).toEqual({ tipo: 'pai' });
    expect(vinculoDaContaLi('C1', [raiz({ grades: [] })])).toEqual({ tipo: 'nao-suportado' });
    expect(vinculoDaContaLi('C1', [raiz({ grades: [1] }), raiz({})])).toEqual({
      tipo: 'nao-suportado',
    });
  });
});

describe('idsDosVinculosDaContaLi — the ids vinculoDaContaLi decides over', () => {
  const link = (id: unknown, extra: Record<string, unknown> = {}) => ({
    contaLojaIntegrada: 'documents/integracao/C1',
    id,
    ...extra,
  });

  it('EQUAL: a number id and its canonical text are ONE id, roots and children alike', () => {
    expect(
      idsDosVinculosDaContaLi('C1', [
        link(123, { paiProdutoIntegradaId: 9 }),
        link('123', { contaLojaIntegrada: 'integracao/C1', grades: [1] }),
      ]),
    ).toEqual(['123']);
  });

  it('⚠️ NEAR-MISS: two ids stay two (sorted); another conta, the trash and non-canonical text name none', () => {
    expect(idsDosVinculosDaContaLi('C1', [link(124), link(123)])).toEqual(['123', '124']);
    expect(
      idsDosVinculosDaContaLi('C1', [
        link(5, { contaLojaIntegrada: 'documents/integracao/C2' }),
        link(6, { removido: true }),
        link('0123'),
        'junk',
      ]),
    ).toEqual([]);
  });

  it('agrees with vinculoDaContaLi: two ids ⇔ vinculo-ambiguo, none ⇔ sem-vinculo', () => {
    const casos = [[link(1)], [link(1), link(2)], [], [link(1, { removido: true })]];
    for (const links of casos) {
      const ids = idsDosVinculosDaContaLi('C1', links);
      const v = vinculoDaContaLi('C1', links);
      expect(ids.length > 1).toBe(v.tipo === 'vinculo-ambiguo');
      expect(ids.length === 0).toBe(v.tipo === 'sem-vinculo');
    }
  });
});
