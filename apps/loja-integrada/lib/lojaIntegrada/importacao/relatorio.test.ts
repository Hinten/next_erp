/**
 * The product import's report (`relatorio.ts`): the item of one family (its action, whether it was
 * applied, its pendências tagged actionable or informational), the `nao-listado` item, the counter
 * delta, the whole-document write, and the actionable count over a job's items, page by page.
 *
 * Nothing reaches the network (D17): the GLOBAL `fetch` is stubbed to throw for the whole file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACAO_ITEM_IMPORTACAO_LI,
  LIMITE_ITENS_IMPORTACAO_LI,
  MODO_IMPORTACAO_LI,
  PENDENCIA_IMPORTACAO_LI,
  SITUACAO_ERP_ITEM_LI,
} from '@delfrance/schemas';

import { FakeDb, asDb } from '../testing/fakeDb';
import { AGORA_MS } from '../testing/fixtures';
import { caminhoItemLi, seedItemLi } from '../testing/importacaoLi';
import { linhaProdutoLi, vistaLi } from '../testing/produtosLi';
import type { FamiliaLi } from './familias';
import { PAPEL_DO_VINCULO_LI, type PlanoDaFamiliaLi, type VinculoPlanejadoLi } from './plano';
import {
  contadoresDoItemLi,
  contadoresZeradosLi,
  contarPendenciasAcionaveisLi,
  gravarItemLi,
  itemAvulsoLi,
  itemNaoListadoLi,
  montarItemDaFamiliaLi,
  somarContadoresLi,
} from './relatorio';
import {
  DESFECHO_DO_VINCULO_LI,
  type DesfechoDoVinculoLi,
  type ResultadoDosVinculosLi,
} from './vinculos';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('relatorio.test: nenhuma chamada de rede'))),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const FAMILIA: FamiliaLi = {
  raiz: vistaLi(linhaProdutoLi(10, { sku: 'X', nome: 'Caneca' })),
  detalheDaRaiz: null,
  filhos: [],
  semDetalhe: [],
  pendencias: [],
};

function vinculo(papel: 'raiz' | 'filho', liId: number): VinculoPlanejadoLi {
  return {
    papel: papel === 'raiz' ? PAPEL_DO_VINCULO_LI.raiz : PAPEL_DO_VINCULO_LI.filho,
    liId,
    produtoId: `p${String(liId)}`,
    paiLiId: papel === 'raiz' ? null : 10,
    espelho: { removido: false },
    preencher: {},
    doc: null,
  };
}

function plano(over: Partial<PlanoDaFamiliaLi> = {}): PlanoDaFamiliaLi {
  return {
    liId: 10,
    noAlvo: true,
    relatar: true,
    situacaoErp: SITUACAO_ERP_ITEM_LI.encontrado,
    erpId: 'p10',
    raizVinculo: vinculo('raiz', 10),
    filhosVinculos: [],
    criacao: null,
    pendencias: [],
    ...over,
  };
}

function vinculos(
  raiz: DesfechoDoVinculoLi,
  ...filhos: DesfechoDoVinculoLi[]
): ResultadoDosVinculosLi {
  return {
    raiz: { vinculo: vinculo('raiz', 10), desfecho: raiz, gravado: false },
    filhos: filhos.map((desfecho, i) => ({
      vinculo: vinculo('filho', 11 + i),
      desfecho,
      gravado: false,
    })),
  };
}

const CRIADO: DesfechoDoVinculoLi = { tipo: DESFECHO_DO_VINCULO_LI.criado, docId: '10' };
const SEM_MUDANCA: DesfechoDoVinculoLi = {
  tipo: DESFECHO_DO_VINCULO_LI.semMudanca,
  docIds: ['10'],
};

function item(
  v: ResultadoDosVinculosLi,
  over: Partial<Parameters<typeof montarItemDaFamiliaLi>[0]> = {},
) {
  return montarItemDaFamiliaLi({
    familia: FAMILIA,
    plano: plano(),
    vinculos: v,
    modo: MODO_IMPORTACAO_LI.aplicar,
    agoraMs: AGORA_MS,
    ...over,
  });
}

describe('montarItemDaFamiliaLi — situacaoErp after a retried unit', () => {
  const RETOMADO: DesfechoDoVinculoLi = {
    tipo: DESFECHO_DO_VINCULO_LI.criado,
    docId: '10',
    retomado: true,
  };
  const vinculado = { plano: plano({ situacaoErp: SITUACAO_ERP_ITEM_LI.vinculado }) };

  it('a root vinculado only through the link THIS job created (retomado) ⇒ encontrado, vincular, +1 vinculado', () => {
    const i = item(vinculos(RETOMADO), vinculado);
    expect(i).toMatchObject({
      situacaoErp: SITUACAO_ERP_ITEM_LI.encontrado,
      acao: ACAO_ITEM_IMPORTACAO_LI.vincular,
    });
    expect(contadoresDoItemLi(i, vinculos(RETOMADO))).toMatchObject({
      vinculados: 1,
      semMudanca: 0,
    });
  });

  it('NEAR-MISS: vinculado with a link found unchanged, or created by THIS attempt ⇒ vinculado stays', () => {
    expect(item(vinculos(SEM_MUDANCA), vinculado).situacaoErp).toBe(SITUACAO_ERP_ITEM_LI.vinculado);
    expect(item(vinculos(CRIADO), vinculado).situacaoErp).toBe(SITUACAO_ERP_ITEM_LI.vinculado);
  });

  it('NEAR-MISS: only a VARIATION link retomado leaves the root’s situacaoErp alone', () => {
    expect(item(vinculos(SEM_MUDANCA, RETOMADO), vinculado).situacaoErp).toBe(
      SITUACAO_ERP_ITEM_LI.vinculado,
    );
  });
});

describe('montarItemDaFamiliaLi — the action', () => {
  it('a link created ⇒ vincular, applied; nothing created ⇒ nenhuma', () => {
    expect(item(vinculos(CRIADO))).toMatchObject({
      liId: 10,
      tipo: 'normal',
      sku: 'X',
      nome: 'Caneca',
      situacaoErp: SITUACAO_ERP_ITEM_LI.encontrado,
      erpId: 'p10',
      acao: ACAO_ITEM_IMPORTACAO_LI.vincular,
      aplicada: true,
      pendencias: [],
    });
    expect(item(vinculos(SEM_MUDANCA)).acao).toBe(ACAO_ITEM_IMPORTACAO_LI.nenhuma);
  });

  it('only a VARIATION link created still makes the family vincular', () => {
    expect(item(vinculos(SEM_MUDANCA, CRIADO)).acao).toBe(ACAO_ITEM_IMPORTACAO_LI.vincular);
  });

  it('Simular: the same action, applied false', () => {
    expect(item(vinculos(CRIADO), { modo: MODO_IMPORTACAO_LI.simular })).toMatchObject({
      acao: ACAO_ITEM_IMPORTACAO_LI.vincular,
      aplicada: false,
    });
  });

  it('a viable create ⇒ criar, applied only once the complete step carried it out', () => {
    const criacao = { viavel: true, nome: 'Caneca', nomeCortado: false, filhos: [], ocultos: [] };
    const sem = { raiz: null, filhos: [] };
    expect(item(sem, { plano: plano({ raizVinculo: null, criacao }) })).toMatchObject({
      acao: ACAO_ITEM_IMPORTACAO_LI.criar,
      aplicada: false,
    });
    expect(
      item(sem, { plano: plano({ raizVinculo: null, criacao }), criacaoAplicada: true }).aplicada,
    ).toBe(true);
    // Near-miss: a create that is not viable is no action.
    expect(
      item(sem, { plano: plano({ raizVinculo: null, criacao: { ...criacao, viavel: false } }) })
        .acao,
    ).toBe(ACAO_ITEM_IMPORTACAO_LI.nenhuma);
  });
});

describe('montarItemDaFamiliaLi — the pendências', () => {
  it('a refusal is actionable (root ⇒ liId null, variation ⇒ its id); a refresh is informational', () => {
    const it1 = item(
      vinculos(
        { tipo: DESFECHO_DO_VINCULO_LI.atualizado, docIds: ['10'], campos: ['removido'] },
        {
          tipo: DESFECHO_DO_VINCULO_LI.recusado,
          codigo: PENDENCIA_IMPORTACAO_LI.vinculoPaiAusente,
          referencias: [],
        },
      ),
    );
    expect(it1.pendencias).toEqual([
      {
        codigo: PENDENCIA_IMPORTACAO_LI.vinculoAtualizado,
        acionavel: false,
        liId: null,
        referencias: ['removido'],
      },
      {
        codigo: PENDENCIA_IMPORTACAO_LI.vinculoPaiAusente,
        acionavel: true,
        liId: 11,
        referencias: [],
      },
    ]);
    expect(it1.acao).toBe(ACAO_ITEM_IMPORTACAO_LI.nenhuma);
  });

  it("the plan's pendências come first, tagged by the schema's predicate; duplicates dropped", () => {
    const p = plano({
      pendencias: [
        { codigo: PENDENCIA_IMPORTACAO_LI.orfao, liId: 12, referencias: [] },
        { codigo: PENDENCIA_IMPORTACAO_LI.skuAmbiguo, liId: null, referencias: ['a', 'b'] },
        { codigo: PENDENCIA_IMPORTACAO_LI.orfao, liId: 12, referencias: [] },
      ],
    });
    expect(item(vinculos(SEM_MUDANCA), { plano: p }).pendencias).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.orfao, acionavel: false, liId: 12, referencias: [] },
      {
        codigo: PENDENCIA_IMPORTACAO_LI.skuAmbiguo,
        acionavel: true,
        liId: null,
        referencias: ['a', 'b'],
      },
    ]);
  });

  it('a selected id the listing lacks: its own informational nao-listado item', () => {
    expect(itemNaoListadoLi(77, AGORA_MS)).toMatchObject({
      liId: 77,
      situacaoErp: SITUACAO_ERP_ITEM_LI.naoListado,
      acao: ACAO_ITEM_IMPORTACAO_LI.nenhuma,
      pendencias: [
        {
          codigo: PENDENCIA_IMPORTACAO_LI.naoListado,
          acionavel: false,
          liId: null,
          referencias: [],
        },
      ],
    });
  });

  it('a LOOSE row is its own avulso item: its tipo, SKU and name, never matched, its one informational code', () => {
    const linha = vistaLi(linhaProdutoLi(31, { tipo: 'atributo_opcao', sku: 'F-31', nome: null }));
    expect(itemAvulsoLi({ linha, codigo: PENDENCIA_IMPORTACAO_LI.naLixeira }, AGORA_MS)).toEqual({
      liId: 31,
      tipo: 'atributo_opcao',
      sku: 'F-31',
      nome: null,
      filhos: 0,
      situacaoErp: SITUACAO_ERP_ITEM_LI.avulso,
      erpId: null,
      acao: ACAO_ITEM_IMPORTACAO_LI.nenhuma,
      aplicada: false,
      camposPreenchidos: [],
      categoriasCriadas: [],
      pendencias: [
        {
          codigo: PENDENCIA_IMPORTACAO_LI.naLixeira,
          acionavel: false,
          liId: null,
          referencias: [],
        },
      ],
      atualizadoEmMs: AGORA_MS,
    });
  });
});

describe('the counters', () => {
  it('a linked family: familias 1, vinculados per link created, not semMudanca', () => {
    const v = vinculos(CRIADO, CRIADO, SEM_MUDANCA);
    expect(contadoresDoItemLi(item(v), v)).toEqual({
      ...contadoresZeradosLi(),
      familias: 1,
      vinculados: 2,
    });
  });

  it('nothing changed and nothing would ⇒ semMudanca 1; a refresh is a change', () => {
    const quieto = vinculos(SEM_MUDANCA);
    expect(contadoresDoItemLi(item(quieto), quieto)).toMatchObject({
      semMudanca: 1,
      vinculados: 0,
    });
    const refresco = vinculos({
      tipo: DESFECHO_DO_VINCULO_LI.atualizado,
      docIds: ['10'],
      campos: ['ativo'],
    });
    expect(contadoresDoItemLi(item(refresco), refresco)).toMatchObject({
      semMudanca: 0,
      pendenciasInformativas: 1,
    });
  });

  it('a nao-listado item counts its pendência, not a family', () => {
    expect(contadoresDoItemLi(itemNaoListadoLi(77, AGORA_MS), null)).toEqual({
      ...contadoresZeradosLi(),
      pendenciasInformativas: 1,
    });
  });

  it('an avulso item counts its pendência, not a family — ⚠️ NEAR-MISS: a family item that changed nothing counts one family and one semMudanca', () => {
    const avulso = itemAvulsoLi(
      {
        linha: vistaLi(linhaProdutoLi(88, { tipo: 'kit' })),
        codigo: PENDENCIA_IMPORTACAO_LI.tipoDesconhecido,
      },
      AGORA_MS,
    );
    expect(contadoresDoItemLi(avulso, null)).toEqual({
      ...contadoresZeradosLi(),
      pendenciasInformativas: 1,
    });
    expect(
      contadoresDoItemLi({ ...avulso, situacaoErp: SITUACAO_ERP_ITEM_LI.ausente }, null),
    ).toEqual({ ...contadoresZeradosLi(), familias: 1, semMudanca: 1, pendenciasInformativas: 1 });
  });

  it('somarContadoresLi adds counter by counter', () => {
    const a = { ...contadoresZeradosLi(), familias: 2, vinculados: 1 };
    const b = { ...contadoresZeradosLi(), familias: 1, pendenciasAcionaveis: 3 };
    expect(somarContadoresLi(a, b)).toEqual({
      ...contadoresZeradosLi(),
      familias: 3,
      vinculados: 1,
      pendenciasAcionaveis: 3,
    });
  });
});

describe('gravarItemLi and contarPendenciasAcionaveisLi', () => {
  it('the item is written WHOLE at itens/{liId}; a retry overwrites its own attempt', async () => {
    const db = new FakeDb();
    const i = item(vinculos(CRIADO));
    await gravarItemLi(asDb(db), 'job-1', i);
    await gravarItemLi(asDb(db), 'job-1', i);
    expect(db.escritas.map((e) => [e.verbo, e.caminho, e.sobrescrita])).toEqual([
      ['set', caminhoItemLi('job-1', '10'), true],
      ['set', caminhoItemLi('job-1', '10'), true],
    ]);
    expect(db.ler(caminhoItemLi('job-1', '10'))).toEqual(i);
  });

  it('counts only actionable codes, per code, across more than one page of items', async () => {
    const db = new FakeDb();
    const total = LIMITE_ITENS_IMPORTACAO_LI + 3;
    for (let n = 1; n <= total; n += 1) {
      seedItemLi(db, 'job-1', n, {
        pendencias:
          n % 2 === 0
            ? [
                { codigo: 'sem-sku', acionavel: true },
                { codigo: 'orfao', acionavel: false },
              ]
            : [{ codigo: 'vinculo-ambiguo', acionavel: true }],
      });
    }
    // Another job's items never count.
    seedItemLi(db, 'job-2', 1, { pendencias: [{ codigo: 'sem-sku', acionavel: true }] });
    const c = await contarPendenciasAcionaveisLi(asDb(db), 'job-1');
    const pares = Math.floor(total / 2);
    expect(c).toEqual({
      total,
      porCodigo: { 'sem-sku': pares, 'vinculo-ambiguo': total - pares },
    });
  });

  it('a job with no item counts zero', async () => {
    expect(await contarPendenciasAcionaveisLi(asDb(new FakeDb()), 'job-1')).toEqual({
      total: 0,
      porCodigo: {},
    });
  });
});
