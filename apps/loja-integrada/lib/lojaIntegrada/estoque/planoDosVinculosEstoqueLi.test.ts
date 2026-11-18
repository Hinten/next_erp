/**
 * `planoDosVinculosEstoqueLi` (master plan step 12, PR 12-e): the link-only first half of the run's
 * plan, asked first so a link skip reads no stock record. Its verdict must be EXACTLY the full
 * plan's with no duplicate found, whenever the full plan stops on the links — pinned here input by
 * input against `planoEstoqueLi` itself. The 12-c suites (`planoEstoqueLi.test.ts`, the property
 * suite and the captures replay) stay byte-unedited: they are the proof the extraction moved no
 * verdict of the full plan.
 */
import { describe, expect, it } from 'vitest';

import {
  type EntradaPlanoEstoqueLi,
  type PlanoDosVinculosEstoqueLi,
  planoDosVinculosEstoqueLi,
  planoEstoqueLi,
} from './planoEstoqueLi';

const CONTA = 'C1';
const ID = 123456789;

const filho = (extra: Record<string, unknown> = {}) => ({
  contaLojaIntegrada: `documents/integracao/${CONTA}`,
  id: ID,
  paiProdutoIntegradaId: 7654321,
  ...extra,
});
const raiz = (extra: Record<string, unknown> = {}) => ({
  contaLojaIntegrada: `documents/integracao/${CONTA}`,
  id: 7654321,
  paiProdutoIntegradaId: null,
  ...extra,
});
const paridade = (enviarEstoque: unknown) => ({
  statusProdutosMarketplace: { [`${CONTA}_${String(ID)}`]: { enviarEstoque } },
});

function entrada(e: Partial<EntradaPlanoEstoqueLi> = {}): EntradaPlanoEstoqueLi {
  return {
    contaId: CONTA,
    produtoId: 'p1',
    depositoId: 'dep1',
    produto: {},
    links: [filho()],
    estoque: {
      tipo: 'um',
      registro: { caminho: 'produtos/p1/estoques/est-p1-dep1', dados: { quantidade: 7 } },
    },
    componentes: [],
    apagado: false,
    temEstoqueEmQualquerDeposito: null,
    duplicado: false,
    ...e,
  };
}

const CASOS: readonly [string, Partial<EntradaPlanoEstoqueLi>, PlanoDosVinculosEstoqueLi][] = [
  ['no link', { links: [] }, { tipo: 'sem-vinculo' }],
  [
    'another conta’s',
    { links: [filho({ contaLojaIntegrada: 'documents/integracao/C2' })] },
    { tipo: 'sem-vinculo' },
  ],
  ['a trashed one', { links: [filho({ removido: true })] }, { tipo: 'sem-vinculo' }],
  ['an unreadable id', { links: [filho({ id: '0123' })] }, { tipo: 'sem-vinculo' }],
  ['junk', { links: ['x', null, 3] }, { tipo: 'sem-vinculo' }],
  ['a parent root', { links: [raiz({ grades: ['Cor'] })] }, { tipo: 'pai' }],
  ['a root with no grades', { links: [raiz({ grades: null })] }, { tipo: 'nao-suportado' }],
  ['two store ids', { links: [filho(), filho({ id: ID + 1 })] }, { tipo: 'vinculo-ambiguo' }],
  ['the parity switch off', { produto: paridade(false) }, { tipo: 'paridade', idLi: String(ID) }],
];

describe('planoDosVinculosEstoqueLi: the full plan’s first half, never a copy', () => {
  it.each(CASOS)('%s ⇒ the full plan’s own verdict', (_rotulo, e, esperado) => {
    expect(planoDosVinculosEstoqueLi(entrada(e))).toEqual(esperado);
    expect(planoEstoqueLi(entrada(e))).toEqual(esperado);
  });

  it('a counting child link, parity not off ⇒ vinculado with the store id, while the full plan goes on', () => {
    expect(planoDosVinculosEstoqueLi(entrada())).toEqual({ tipo: 'vinculado', idLi: String(ID) });
    expect(planoEstoqueLi(entrada()).tipo).toBe('enviar');
  });

  it('⚠️ NEAR-MISS: parity reads `false` EXACTLY — `"false"`, absent and true all go on', () => {
    for (const valor of ['false', undefined, true, 0]) {
      expect(planoDosVinculosEstoqueLi(entrada({ produto: paridade(valor) })).tipo).toBe(
        'vinculado',
      );
    }
  });

  it('it reads nothing but the produto and the links: no record, no component, no duplicate flag', () => {
    const semRegistros = entrada({
      estoque: { tipo: 'ambiguo' },
      componentes: [],
      temEstoqueEmQualquerDeposito: false,
      duplicado: true,
    });
    expect(planoDosVinculosEstoqueLi(semRegistros)).toEqual({
      tipo: 'vinculado',
      idLi: String(ID),
    });
  });

  it('the full plan keeps its own order: a duplicate wins over parity there (the run never probes a parity skip)', () => {
    expect(planoEstoqueLi(entrada({ produto: paridade(false), duplicado: true }))).toEqual({
      tipo: 'vinculo-duplicado',
      idLi: String(ID),
    });
  });
});
