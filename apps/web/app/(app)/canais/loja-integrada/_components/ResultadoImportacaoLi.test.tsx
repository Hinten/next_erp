import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ACAO_IMPORTACAO_LI,
  ACAO_ITEM_IMPORTACAO_LI,
  ALVO_IMPORTACAO_LI,
  CATEGORIAS_IMPORTACAO_LI,
  CODIGO_ERRO_LI,
  FASE_IMPORTACAO_LI,
  FOTOS_IMPORTACAO_LI,
  type ItemRespostaImportacaoLi,
  MAX_SELECIONADOS_LI,
  MODO_IMPORTACAO_LI,
  MOTIVO_REVISAO_FISCAL_LI,
  PENDENCIA_IMPORTACAO_LI,
  type RespostaImportacaoLi,
  SITUACAO_ERP_ITEM_LI,
  STATUS_IMPORTACAO_LI,
  TIPO_PRODUTO_LI,
} from '@delfrance/schemas';

import type { LojaIntegradaClient } from '@/lib/loja-integrada/client';
import type { ContaRef } from '@/lib/marketplace/contaJobs/types';
import { respostaImportacaoLiFalsa } from '@/lib/testing/importacaoLiFalsa';
import { lojaIntegradaClientFalso } from '@/lib/testing/lojaIntegradaClientFalso';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { AlvoResultadoImportacaoLi } from './CartaoImportacaoLi';
import type {
  DesfechoInicioLi,
  ImportarProdutosLiActionState,
} from './useImportarProdutosLiAction';

/**
 * The result of an ended product import (master plan step 9): the report and
 * its filters, the tax-review list, and — from a finished Simular — the
 * selection and "Importar selecionados".
 *
 * Only the backend hook is replaced: the hooks, the readers, the copy and the
 * error classes are the REAL ones (the attach narrows with `instanceof`). The
 * ids are obviously fake.
 */

const h = vi.hoisted(() => ({
  clientRef: { current: null as LojaIntegradaClient | null },
}));

vi.mock('@/lib/loja-integrada/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/loja-integrada/client')>();
  return {
    ...actual,
    useBackendLojaIntegrada: () => ({ client: h.clientRef.current, indisponivel: null }),
  };
});

const {
  FILTRO_RESULTADO_LI,
  ResultadoImportacaoLi,
  contarPorFiltroLi,
  ehItemSelecionavelLi,
  estadoDoTodosLi,
  itemNoFiltroLi,
  jobDaListaEmAbertoLi,
  jobsDoSeletorLi,
  opcoesImportarSelecionadosLi,
  podeImportarSelecionadosLi,
  revisaoFiscalCompletaLi,
  selecaoAoAlternarTodosLi,
  textoCategoriasCriadasLi,
} = await import('./ResultadoImportacaoLi');
const { useImportarProdutosLiAction } = await import('./useImportarProdutosLiAction');
const { LojaIntegradaClientHttpError, corpoInicioImportacaoLi } =
  await import('@/lib/loja-integrada/client');
const { MENSAGEM_BACKEND_SEM_IMPORTACAO_LI, MENSAGEM_BACKEND_SEM_REVISAO_FISCAL_LI } =
  await import('@/lib/loja-integrada/importacao');
const { TEXTO_PENDENCIA_IMPORTACAO_LI } = await import('@/lib/loja-integrada/importacaoRotulos');

type Iniciar = ImportarProdutosLiActionState['iniciar'];

const CONTA: ContaRef = { id: 'conta-falsa-1', nome: 'Conta A' };

/** A finished Simular that would complete, create categories and copy photos. */
const SIMULACAO = respostaImportacaoLiFalsa({
  jobId: 'job-simulacao-1',
  status: STATUS_IMPORTACAO_LI.concluido,
  modo: MODO_IMPORTACAO_LI.simular,
  acao: ACAO_IMPORTACAO_LI.completar,
  categorias: CATEGORIAS_IMPORTACAO_LI.criarEVincular,
  fotos: FOTOS_IMPORTACAO_LI.soSemFotos,
});

/** A finished import (it wrote a tax-review list). */
const IMPORTACAO = respostaImportacaoLiFalsa({
  jobId: 'job-importacao-1',
  status: STATUS_IMPORTACAO_LI.concluido,
  modo: MODO_IMPORTACAO_LI.aplicar,
  fase: FASE_IMPORTACAO_LI.fim,
  iniciadoEmMs: 1_790_000_000_000,
});

/** An import cancelled while it processed products: before its tax-review re-check. */
const INTERROMPIDA = respostaImportacaoLiFalsa({
  jobId: 'job-interrompida-1',
  status: STATUS_IMPORTACAO_LI.cancelado,
  modo: MODO_IMPORTACAO_LI.aplicar,
  fase: FASE_IMPORTACAO_LI.familias,
});

/** What the action's `iniciar` resolves for a start that started a NEW job. */
const iniciou = (): DesfechoInicioLi[] => [
  { kind: 'started', conta: CONTA, jobId: 'job-novo', reatado: false },
];

function item(
  liId: number,
  over: Partial<ItemRespostaImportacaoLi> = {},
): ItemRespostaImportacaoLi {
  return {
    liId,
    tipo: TIPO_PRODUTO_LI.normal,
    sku: `SKU-FALSO-${String(liId)}`,
    nome: `Produto falso ${String(liId)}`,
    filhos: 0,
    situacaoErp: SITUACAO_ERP_ITEM_LI.ausente,
    erpId: null,
    acao: ACAO_ITEM_IMPORTACAO_LI.criar,
    aplicada: false,
    camposPreenchidos: [],
    categoriasCriadas: [],
    pendencias: [],
    atualizadoEmMs: 1_790_000_000_000,
    ...over,
  };
}

type PendenciaRespostaLi = ItemRespostaImportacaoLi['pendencias'][number];

const pendencia = (
  codigo: string,
  acionavel: boolean,
  over: Partial<PendenciaRespostaLi> = {},
): PendenciaRespostaLi => ({
  codigo,
  acionavel,
  liId: null,
  referencias: [],
  ...over,
});

/** The report most cases read: two selectable rows, one link, one loose row, one unlisted id. */
const ITENS: ItemRespostaImportacaoLi[] = [
  item(103, {
    tipo: TIPO_PRODUTO_LI.atributo,
    filhos: 2,
    situacaoErp: SITUACAO_ERP_ITEM_LI.vinculado,
    erpId: 'produto-falso-103',
    acao: ACAO_ITEM_IMPORTACAO_LI.completar,
    camposPreenchidos: ['gtin', 'pesoBrutoKg'],
    categoriasCriadas: [3001, 3002],
  }),
  item(101),
  item(102, {
    situacaoErp: SITUACAO_ERP_ITEM_LI.encontrado,
    erpId: 'produto-falso-102',
    acao: ACAO_ITEM_IMPORTACAO_LI.vincular,
    pendencias: [
      pendencia(PENDENCIA_IMPORTACAO_LI.skuJaExiste, true, { referencias: ['produto-falso-9'] }),
      pendencia(PENDENCIA_IMPORTACAO_LI.vinculoAtualizado, false),
    ],
  }),
  item(104, {
    tipo: TIPO_PRODUTO_LI.atributoOpcao,
    situacaoErp: SITUACAO_ERP_ITEM_LI.avulso,
    acao: ACAO_ITEM_IMPORTACAO_LI.nenhuma,
    pendencias: [pendencia(PENDENCIA_IMPORTACAO_LI.orfao, false)],
  }),
  item(105, {
    situacaoErp: SITUACAO_ERP_ITEM_LI.naoListado,
    acao: ACAO_ITEM_IMPORTACAO_LI.nenhuma,
    sku: null,
    nome: null,
  }),
];

function client(over: Partial<LojaIntegradaClient> = {}) {
  return lojaIntegradaClientFalso({
    itensImportacao: vi.fn(async () => ({ itens: ITENS, proximo: null })),
    importacoes: vi.fn(async () => ({ importacoes: [] })),
    ...over,
  });
}

interface Abertura {
  job?: RespostaImportacaoLi;
  naRevisaoFiscal?: boolean;
  iniciar?: Mock<Iniciar>;
  semPermissao?: boolean;
  busy?: boolean;
}

function vista(
  a: Abertura,
  onClose: () => void,
  onAbrir: (alvo: AlvoResultadoImportacaoLi) => void,
) {
  const iniciar = a.iniciar ?? vi.fn<Iniciar>(async () => iniciou());
  return (
    <ResultadoImportacaoLi
      alvo={{
        conta: CONTA,
        job: a.job ?? SIMULACAO,
        ...(a.naRevisaoFiscal === true ? { naRevisaoFiscal: true } : {}),
      }}
      onClose={onClose}
      onAbrir={onAbrir}
      importacao={a.semPermissao === true ? null : { iniciar, busy: a.busy ?? false }}
    />
  );
}

function host(children: ReactNode, qc: QueryClient) {
  return (
    <MantineTestProvider>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineTestProvider>
  );
}

function abrir(a: Abertura = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const onAbrir = vi.fn<(alvo: AlvoResultadoImportacaoLi) => void>();
  const utils = render(host(vista(a, onClose, onAbrir), qc));
  return {
    onClose,
    onAbrir,
    ...utils,
    reabrir: (b: Abertura) => utils.rerender(host(vista(b, onClose, onAbrir), qc)),
  };
}

/** A row's accessible name holding a store id as a whole word (its box's label comes first). */
const porId = (liId: number) => new RegExp(`\\b${String(liId)}\\b`);
/** The table row of a store id. */
const linha = (liId: number) => screen.getByRole('row', { name: porId(liId) });
const caixa = (liId: number) =>
  screen.getByRole('checkbox', { name: `Selecionar o produto da loja ${String(liId)}` });
const filtro = (nome: RegExp) => screen.getByRole('radio', { name: nome });
const botaoImportar = () => screen.getByRole('button', { name: /^Importar selecionados/ });

beforeEach(() => {
  vi.clearAllMocks();
  h.clientRef.current = client();
});

/* -------------------------------------------------------------------------- */
/*                                 Pure rules                                  */
/* -------------------------------------------------------------------------- */

describe('itemNoFiltroLi — exact codes', () => {
  it('each ação filter keeps exactly its own ação', () => {
    expect(itemNoFiltroLi(item(1, { acao: 'criar' }), FILTRO_RESULTADO_LI.criados)).toBe(true);
    expect(itemNoFiltroLi(item(1, { acao: 'vincular' }), FILTRO_RESULTADO_LI.vinculados)).toBe(
      true,
    );
    expect(itemNoFiltroLi(item(1, { acao: 'completar' }), FILTRO_RESULTADO_LI.completados)).toBe(
      true,
    );
    expect(itemNoFiltroLi(item(1, { acao: 'vincular' }), FILTRO_RESULTADO_LI.criados)).toBe(false);
  });

  it('NEAR MISS — a code off by case or a space, or unknown, is in no narrowing filter (only "Todos")', () => {
    for (const acao of ['Criar', ' criar', 'criar ', 'criada', 'recriar']) {
      expect(itemNoFiltroLi(item(1, { acao }), FILTRO_RESULTADO_LI.criados)).toBe(false);
      expect(itemNoFiltroLi(item(1, { acao }), FILTRO_RESULTADO_LI.todos)).toBe(true);
    }
    expect(itemNoFiltroLi(item(1, { situacaoErp: 'Avulso' }), FILTRO_RESULTADO_LI.avulsos)).toBe(
      false,
    );
    expect(
      itemNoFiltroLi(
        item(1, { situacaoErp: SITUACAO_ERP_ITEM_LI.avulso }),
        FILTRO_RESULTADO_LI.avulsos,
      ),
    ).toBe(true);
  });

  it('⭐ "Ação necessária" holds an item with ONE actionable pendência, whatever else it has', () => {
    const acionavel = item(1, {
      pendencias: [pendencia('orfao', false), pendencia('sku-parecido-na-loja', true)],
    });
    expect(itemNoFiltroLi(acionavel, FILTRO_RESULTADO_LI.acionaveis)).toBe(true);
    // An unknown code takes the backend's stored flag.
    expect(
      itemNoFiltroLi(
        item(2, { pendencias: [pendencia('codigo-novo', true)] }),
        FILTRO_RESULTADO_LI.acionaveis,
      ),
    ).toBe(true);
  });

  it('NEAR MISS — informational pendências only, a stale stored flag on a KNOWN code, or none: not in "Ação necessária"', () => {
    const informativas = item(1, {
      pendencias: [pendencia('orfao', false), pendencia('vinculo-atualizado', false)],
    });
    expect(itemNoFiltroLi(informativas, FILTRO_RESULTADO_LI.acionaveis)).toBe(false);
    expect(itemNoFiltroLi(informativas, FILTRO_RESULTADO_LI.pendencias)).toBe(true);
    // A known code's class is the shared set's, never the stored flag's.
    expect(
      itemNoFiltroLi(
        item(2, { pendencias: [pendencia('nome-cortado', true)] }),
        FILTRO_RESULTADO_LI.acionaveis,
      ),
    ).toBe(false);
    expect(
      itemNoFiltroLi(
        item(3, { pendencias: [pendencia('codigo-novo', false)] }),
        FILTRO_RESULTADO_LI.acionaveis,
      ),
    ).toBe(false);
    expect(itemNoFiltroLi(item(4), FILTRO_RESULTADO_LI.acionaveis)).toBe(false);
  });

  it('"Com pendências" holds either class; "Revisão fiscal" holds no item at all', () => {
    const informativa = item(1, { pendencias: [pendencia('orfao', false)] });
    const acionavel = item(2, { pendencias: [pendencia('sem-sku', true)] });
    expect(itemNoFiltroLi(informativa, FILTRO_RESULTADO_LI.pendencias)).toBe(true);
    expect(itemNoFiltroLi(acionavel, FILTRO_RESULTADO_LI.pendencias)).toBe(true);
    expect(itemNoFiltroLi(item(3), FILTRO_RESULTADO_LI.pendencias)).toBe(false);
    expect(itemNoFiltroLi(acionavel, FILTRO_RESULTADO_LI.revisao)).toBe(false);
  });

  it('contarPorFiltroLi counts every report filter', () => {
    expect(contarPorFiltroLi(ITENS)).toEqual({
      todos: 5,
      criados: 1,
      vinculados: 1,
      completados: 1,
      acionaveis: 1,
      pendencias: 2,
      avulsos: 1,
    });
  });
});

describe('ehItemSelecionavelLi — family roots only', () => {
  it('a simple product and a parent, in any of the four family situações', () => {
    for (const situacaoErp of ['vinculado', 'encontrado', 'ausente', 'conflito']) {
      expect(ehItemSelecionavelLi({ tipo: 'normal', situacaoErp })).toBe(true);
      expect(ehItemSelecionavelLi({ tipo: 'atributo', situacaoErp })).toBe(true);
    }
  });

  it('NEAR MISS — a loose row, an unlisted id, a variation, an unknown or mis-spelled code', () => {
    expect(ehItemSelecionavelLi({ tipo: 'normal', situacaoErp: 'avulso' })).toBe(false);
    expect(ehItemSelecionavelLi({ tipo: 'normal', situacaoErp: 'nao-listado' })).toBe(false);
    expect(ehItemSelecionavelLi({ tipo: 'atributo_opcao', situacaoErp: 'ausente' })).toBe(false);
    expect(ehItemSelecionavelLi({ tipo: 'desconhecido', situacaoErp: 'ausente' })).toBe(false);
    expect(ehItemSelecionavelLi({ tipo: 'Normal', situacaoErp: 'ausente' })).toBe(false);
    expect(ehItemSelecionavelLi({ tipo: ' atributo', situacaoErp: 'ausente' })).toBe(false);
    expect(ehItemSelecionavelLi({ tipo: 'normal', situacaoErp: 'Ausente' })).toBe(false);
    expect(ehItemSelecionavelLi({ tipo: 'normal', situacaoErp: 'codigo-novo' })).toBe(false);
  });
});

describe('podeImportarSelecionadosLi', () => {
  it('only a Simular that ended concluido', () => {
    expect(podeImportarSelecionadosLi(SIMULACAO)).toBe(true);
    for (const status of [
      STATUS_IMPORTACAO_LI.cancelado,
      STATUS_IMPORTACAO_LI.falhou,
      STATUS_IMPORTACAO_LI.executando,
    ]) {
      expect(podeImportarSelecionadosLi({ ...SIMULACAO, status })).toBe(false);
    }
    expect(podeImportarSelecionadosLi(IMPORTACAO)).toBe(false);
  });
});

describe('whose tax-review list is open', () => {
  it('⭐ a whole list: an aplicar that ended after its re-check (concluido, or stopped in its last phase)', () => {
    expect(revisaoFiscalCompletaLi(IMPORTACAO)).toBe(true);
    expect(
      revisaoFiscalCompletaLi({
        ...INTERROMPIDA,
        status: STATUS_IMPORTACAO_LI.falhou,
        fase: FASE_IMPORTACAO_LI.fim,
      }),
    ).toBe(true);
  });

  it('NEAR MISS — stopped before the re-check, still running, or a Simular: not whole', () => {
    expect(revisaoFiscalCompletaLi(INTERROMPIDA)).toBe(false);
    expect(revisaoFiscalCompletaLi({ ...INTERROMPIDA, fase: FASE_IMPORTACAO_LI.revisao })).toBe(
      false,
    );
    expect(
      revisaoFiscalCompletaLi({
        ...IMPORTACAO,
        status: STATUS_IMPORTACAO_LI.executando,
      }),
    ).toBe(false);
    expect(revisaoFiscalCompletaLi(SIMULACAO)).toBe(false);
    expect(revisaoFiscalCompletaLi({ ...SIMULACAO, fase: FASE_IMPORTACAO_LI.fim })).toBe(false);
  });

  it('the open list is the NEWEST whole one, past Simulars and interrupted imports', () => {
    const antiga = { ...IMPORTACAO, jobId: 'job-importacao-0' };
    expect(jobDaListaEmAbertoLi([SIMULACAO, INTERROMPIDA, IMPORTACAO, antiga])).toBe(IMPORTACAO);
    expect(jobDaListaEmAbertoLi([SIMULACAO, INTERROMPIDA])).toBeNull();
  });

  it('the picker offers the ended jobs, and the one on screen even when the list lacks it', () => {
    const rodando = {
      ...IMPORTACAO,
      jobId: 'job-rodando',
      status: STATUS_IMPORTACAO_LI.executando,
    };
    expect(jobsDoSeletorLi([rodando, SIMULACAO, IMPORTACAO], IMPORTACAO)).toEqual([
      SIMULACAO,
      IMPORTACAO,
    ]);
    expect(jobsDoSeletorLi([SIMULACAO], INTERROMPIDA)).toEqual([INTERROMPIDA, SIMULACAO]);
  });
});

describe('the selection rules', () => {
  it('estadoDoTodosLi', () => {
    expect(estadoDoTodosLi(new Set([1, 2]), [1, 2])).toBe('todos');
    expect(estadoDoTodosLi(new Set([1]), [1, 2])).toBe('alguns');
    expect(estadoDoTodosLi(new Set([3]), [1, 2])).toBe('nenhum');
  });

  it('select all adds the filter’s ids to what is already picked; all on ⇒ all of them off', () => {
    expect([...selecaoAoAlternarTodosLi(new Set([9]), [1, 2])!].sort()).toEqual([1, 2, 9]);
    expect([...selecaoAoAlternarTodosLi(new Set([1, 2, 9]), [1, 2])!]).toEqual([9]);
  });

  it('⭐ the cap: exactly max fits; one past it refuses the whole select-all (never a partial fill)', () => {
    expect(selecaoAoAlternarTodosLi(new Set([1]), [2, 3], 3)?.size).toBe(3);
    expect(selecaoAoAlternarTodosLi(new Set([1, 4]), [2, 3], 3)).toBeNull();
    // The default cap is the contract's.
    const mil = Array.from({ length: MAX_SELECIONADOS_LI }, (_, i) => i + 1);
    expect(selecaoAoAlternarTodosLi(new Set(), mil)?.size).toBe(MAX_SELECIONADOS_LI);
    expect(selecaoAoAlternarTodosLi(new Set([0]), mil)).toBeNull();
  });

  it('⭐ the body: an aplicar over EXACTLY the picked ids, with the Simular’s own options', () => {
    const opcoes = opcoesImportarSelecionadosLi(SIMULACAO, new Set([300, 20, 1000]));
    expect(opcoes).toEqual({
      modo: MODO_IMPORTACAO_LI.aplicar,
      alvo: ALVO_IMPORTACAO_LI.selecionados,
      acao: ACAO_IMPORTACAO_LI.completar,
      categorias: CATEGORIAS_IMPORTACAO_LI.criarEVincular,
      fotos: FOTOS_IMPORTACAO_LI.soSemFotos,
      selecionados: [20, 300, 1000],
      simulacaoId: 'job-simulacao-1',
    });
    // And the strict start schema takes it as it is.
    expect(corpoInicioImportacaoLi(opcoes)).toEqual(opcoes);
  });

  it('NEAR MISS — a Simular that only linked carries its own defaults, not the previous body’s', () => {
    const soVincular = { ...IMPORTACAO, jobId: 'job-simulacao-2' };
    expect(opcoesImportarSelecionadosLi(soVincular, new Set([7]))).toMatchObject({
      acao: ACAO_IMPORTACAO_LI.soVincular,
      categorias: CATEGORIAS_IMPORTACAO_LI.soVincular,
      fotos: FOTOS_IMPORTACAO_LI.naoImportar,
      simulacaoId: 'job-simulacao-2',
    });
  });

  it('textoCategoriasCriadasLi names the store ids with their count', () => {
    expect(textoCategoriasCriadasLi([])).toBeNull();
    expect(textoCategoriasCriadasLi([3001])).toBe('1 categoria: 3001');
    expect(textoCategoriasCriadasLi([3001, 3002])).toBe('2 categorias: 3001, 3002');
  });
});

/* -------------------------------------------------------------------------- */
/*                                 The report                                  */
/* -------------------------------------------------------------------------- */

describe('ResultadoImportacaoLi — the report', () => {
  it('⭐ each row: tipo, situação, the proposed ação, filled fields (in pt-BR), created categories, the ERP link', async () => {
    abrir();
    const pai = await screen.findByRole('row', { name: porId(103) });
    const t = within(pai);
    expect(t.getByText('Com variações')).not.toBeNull();
    expect(t.getByText('Vinculado')).not.toBeNull();
    // A Simular words its ação as a proposal.
    expect(t.getByText('A completar')).not.toBeNull();
    expect(t.getByText('GTIN, Peso bruto (kg)')).not.toBeNull();
    // NEAR MISS — never the schema's own names.
    expect(t.queryByText(/pesoBrutoKg/)).toBeNull();
    expect(t.getByText('2 categorias: 3001, 3002')).not.toBeNull();
    expect(t.getByRole('link', { name: 'produto-falso-103' }).getAttribute('href')).toBe(
      '/produtos/produto-falso-103/editar',
    );
    expect(screen.getByText('Resultado da simulação — Conta A')).not.toBeNull();
  });

  it('an import words the same ação as done', async () => {
    h.clientRef.current = client({
      itensImportacao: vi.fn(async () => ({
        itens: [item(101, { aplicada: true })],
        proximo: null,
      })),
    });
    abrir({ job: IMPORTACAO });
    expect(
      await within(await screen.findByRole('row', { name: porId(101) })).findByText('Criado'),
    ).not.toBeNull();
    expect(screen.getByText('Resultado da importação — Conta A')).not.toBeNull();
  });

  it('⭐ pendências: an actionable one is marked and says what to do, with what it names; an informational one is not', async () => {
    abrir();
    const r = within(await screen.findByRole('row', { name: porId(102) }));
    const acionavel = TEXTO_PENDENCIA_IMPORTACAO_LI[PENDENCIA_IMPORTACAO_LI.skuJaExiste];
    const informativa = TEXTO_PENDENCIA_IMPORTACAO_LI[PENDENCIA_IMPORTACAO_LI.vinculoAtualizado];
    expect(r.getByText(acionavel.rotulo)).not.toBeNull();
    expect(r.getByText(acionavel.descricao)).not.toBeNull();
    expect(r.getAllByText('ação necessária')).toHaveLength(1);
    expect(r.getByText('Referências: produto-falso-9')).not.toBeNull();
    expect(r.getByText(informativa.rotulo)).not.toBeNull();
    expect(r.queryByText(informativa.descricao)).toBeNull();
  });

  it('what a pendência names reads in pt-BR where it is a field, a length or a picture', async () => {
    h.clientRef.current = client({
      itensImportacao: vi.fn(async () => ({
        itens: [
          item(101, {
            pendencias: [
              pendencia('dado-invalido', true, { referencias: ['nome', 'categoria.nome'] }),
              pendencia('descricao-longa', true, { referencias: ['4123'] }),
              pendencia('foto-recusada', false, { referencias: ['77', 'muito-grande'] }),
              pendencia('vinculo-atualizado', false, { referencias: ['campo-novo'] }),
            ],
          }),
        ],
        proximo: null,
      })),
    });
    abrir();
    const r = within(await screen.findByRole('row', { name: porId(101) }));
    expect(r.getByText('Campos: Nome, Categoria da loja: Nome')).not.toBeNull();
    expect(r.getByText('Descrição com 4.123 caracteres')).not.toBeNull();
    expect(r.getByText('Imagem 77: grande demais')).not.toBeNull();
    // A field name this build does not know is shown as it came.
    expect(r.getByText('Campos: campo-novo')).not.toBeNull();
  });

  it('a code this build does not know still shows, quoted', async () => {
    h.clientRef.current = client({
      itensImportacao: vi.fn(async () => ({
        itens: [
          item(101, {
            tipo: 'novo-tipo',
            situacaoErp: 'nova-situacao',
            acao: 'nova-acao',
            pendencias: [pendencia('nova-pendencia', true)],
          }),
        ],
        proximo: null,
      })),
    });
    abrir();
    const r = within(await screen.findByRole('row', { name: porId(101) }));
    expect(r.getByText('Tipo "novo-tipo"')).not.toBeNull();
    expect(r.getByText('Situação "nova-situacao"')).not.toBeNull();
    expect(r.getByText('Ação "nova-acao"')).not.toBeNull();
    expect(r.getByText('Pendência "nova-pendencia"')).not.toBeNull();
    // The stored flag is the only source for an unknown code's class.
    expect(r.getByText('ação necessária')).not.toBeNull();
  });

  it('the filters narrow the rows, and say what each holds', async () => {
    abrir();
    await screen.findByRole('row', { name: porId(101) });
    expect(filtro(/^Todos \(5\)$/)).not.toBeNull();
    expect(filtro(/^A criar \(1\)$/)).not.toBeNull();

    fireEvent.click(filtro(/^Avulsos/));
    expect(screen.getByRole('row', { name: porId(104) })).not.toBeNull();
    expect(screen.queryByRole('row', { name: porId(101) })).toBeNull();

    fireEvent.click(filtro(/^Com pendências/));
    expect(screen.getByRole('row', { name: porId(102) })).not.toBeNull();
    expect(screen.getByRole('row', { name: porId(104) })).not.toBeNull();
    expect(screen.queryByRole('row', { name: porId(103) })).toBeNull();

    // Only the row a person must act on: 104's pendência is informational.
    fireEvent.click(filtro(/^Ação necessária \(1\)$/));
    expect(screen.getByRole('row', { name: porId(102) })).not.toBeNull();
    expect(screen.queryByRole('row', { name: porId(104) })).toBeNull();

    fireEvent.click(filtro(/^A vincular/));
    expect(screen.getByRole('row', { name: porId(102) })).not.toBeNull();
    expect(screen.queryByRole('row', { name: porId(104) })).toBeNull();
  });

  it('a long report is shown 100 rows at a time', async () => {
    h.clientRef.current = client({
      itensImportacao: vi.fn(async () => ({
        itens: Array.from({ length: 150 }, (_, i) => item(1000 + i)),
        proximo: null,
      })),
    });
    abrir({ job: IMPORTACAO });
    await screen.findByRole('row', { name: porId(1000) });
    expect(screen.queryByRole('row', { name: porId(1100) })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    expect(screen.getByRole('row', { name: porId(1100) })).not.toBeNull();
    expect(screen.queryByRole('row', { name: porId(1000) })).toBeNull();
  });

  it('a backend without the import gets its own copy', async () => {
    h.clientRef.current = client({
      itensImportacao: vi.fn(async () => {
        throw new LojaIntegradaClientHttpError('404', 404, null);
      }),
    });
    abrir();
    expect(await screen.findByText(MENSAGEM_BACKEND_SEM_IMPORTACAO_LI)).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                              The tax-review list                            */
/* -------------------------------------------------------------------------- */

describe('ResultadoImportacaoLi — "Revisão fiscal"', () => {
  it('⭐ an import: the list is read only when picked, and it shows only its produtos', async () => {
    const revisaoImportacao = vi.fn(async () => ({
      entradas: [
        {
          produtoId: 'produto-revisao-1',
          motivos: [MOTIVO_REVISAO_FISCAL_LI.produtoCriado],
          liId: 101,
          desdeJobId: 'job-importacao-1',
          desdeMs: 1_790_000_000_000,
        },
        {
          produtoId: 'produto-revisao-2',
          motivos: [MOTIVO_REVISAO_FISCAL_LI.semCategoria, 'motivo-novo'],
          liId: null,
          desdeJobId: 'job-anterior',
          desdeMs: null,
        },
      ],
      proximo: null,
    }));
    h.clientRef.current = client({ revisaoImportacao });
    abrir({ job: IMPORTACAO });
    await screen.findByRole('row', { name: porId(101) });
    expect(revisaoImportacao).not.toHaveBeenCalled();

    fireEvent.click(filtro(/^Revisão fiscal$/));
    const link1 = await screen.findByRole('link', { name: 'produto-revisao-1' });
    expect(link1.getAttribute('href')).toBe('/produtos/produto-revisao-1/editar');
    expect(screen.getByText('Produto criado pela importação')).not.toBeNull();
    expect(screen.getByText('Ficou sem categoria · Motivo "motivo-novo"')).not.toBeNull();
    expect(screen.getByText(/de uma importação anterior/)).not.toBeNull();
    // Only the list's produtos: no report row and no report link.
    expect(screen.queryByText('SKU-FALSO-101')).toBeNull();
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual([
      'produto-revisao-1',
      'produto-revisao-2',
    ]);
    expect(revisaoImportacao).toHaveBeenCalledTimes(1);
    expect(revisaoImportacao).toHaveBeenCalledWith(
      'conta-falsa-1',
      'job-importacao-1',
      null,
      expect.anything(),
    );
  });

  it('NEAR MISS — a Simular says it writes no list, and reads none', async () => {
    const revisaoImportacao = vi.fn();
    h.clientRef.current = client({ revisaoImportacao });
    abrir();
    await screen.findByRole('row', { name: porId(101) });
    fireEvent.click(filtro(/^Revisão fiscal$/));
    expect(
      screen.getByText(/Uma simulação não grava nada no ERP, nem a lista de revisão fiscal/),
    ).not.toBeNull();
    expect(revisaoImportacao).not.toHaveBeenCalled();
  });

  it('⭐ a Simular points at the OPEN list — the newest import that re-checked it — one click away', async () => {
    const revisaoImportacao = vi.fn();
    h.clientRef.current = client({
      revisaoImportacao,
      importacoes: vi.fn(async () => ({ importacoes: [SIMULACAO, INTERROMPIDA, IMPORTACAO] })),
    });
    const { onAbrir } = abrir();
    await screen.findByRole('row', { name: porId(101) });
    fireEvent.click(filtro(/^Revisão fiscal$/));

    fireEvent.click(await screen.findByRole('button', { name: 'Ver a lista em aberto' }));

    expect(onAbrir).toHaveBeenCalledWith({ conta: CONTA, job: IMPORTACAO, naRevisaoFiscal: true });
    // The Simular itself has no list to read.
    expect(revisaoImportacao).not.toHaveBeenCalled();
  });

  it('opened on the open list, the view starts on "Revisão fiscal" and names no other', async () => {
    const revisaoImportacao = vi.fn(async () => ({ entradas: [], proximo: null }));
    h.clientRef.current = client({
      revisaoImportacao,
      importacoes: vi.fn(async () => ({ importacoes: [SIMULACAO, IMPORTACAO] })),
    });
    abrir({ job: IMPORTACAO, naRevisaoFiscal: true });

    expect(
      await screen.findByText('Nenhum produto na revisão fiscal desta importação.'),
    ).not.toBeNull();
    expect(revisaoImportacao).toHaveBeenCalledWith(
      'conta-falsa-1',
      'job-importacao-1',
      null,
      expect.anything(),
    );
    expect(screen.queryByRole('button', { name: 'Ver a lista em aberto' })).toBeNull();
    expect(screen.queryByText(/parou antes de terminar de conferir/)).toBeNull();
  });

  it('⭐ an import that stopped before its re-check: its list is said PARTIAL, and the open one is pointed at', async () => {
    const revisaoImportacao = vi.fn(async () => ({ entradas: [], proximo: null }));
    h.clientRef.current = client({
      revisaoImportacao,
      importacoes: vi.fn(async () => ({ importacoes: [INTERROMPIDA, IMPORTACAO] })),
    });
    const { onAbrir } = abrir({ job: INTERROMPIDA, naRevisaoFiscal: true });

    expect(
      await screen.findByText(/parou antes de terminar de conferir a lista de revisão fiscal/),
    ).not.toBeNull();
    expect(await screen.findByText('Nenhum produto nesta lista parcial.')).not.toBeNull();
    // NEAR MISS — never the whole list's wording.
    expect(screen.queryByText('Nenhum produto na revisão fiscal desta importação.')).toBeNull();
    expect(revisaoImportacao).toHaveBeenCalledWith(
      'conta-falsa-1',
      'job-interrompida-1',
      null,
      expect.anything(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ver a lista em aberto' }));
    expect(onAbrir).toHaveBeenCalledWith({ conta: CONTA, job: IMPORTACAO, naRevisaoFiscal: true });
  });

  it('no import among the ten re-checked the list: the view says so', async () => {
    h.clientRef.current = client({
      importacoes: vi.fn(async () => ({ importacoes: [SIMULACAO] })),
    });
    abrir({ naRevisaoFiscal: true });
    expect(
      await screen.findByText(
        'Nenhuma das 10 importações mais recentes desta conta conferiu a lista de revisão fiscal.',
      ),
    ).not.toBeNull();
  });

  it('a backend that has the import but not the list says exactly that', async () => {
    h.clientRef.current = client({
      revisaoImportacao: vi.fn(async () => {
        throw new LojaIntegradaClientHttpError('404', 404, null);
      }),
    });
    abrir({ job: IMPORTACAO });
    await screen.findByRole('row', { name: porId(101) });
    fireEvent.click(filtro(/^Revisão fiscal$/));
    expect(await screen.findByText(MENSAGEM_BACKEND_SEM_REVISAO_FISCAL_LI)).not.toBeNull();
  });
});

describe('ResultadoImportacaoLi — the job picker', () => {
  it('⭐ lists the conta’s other ended jobs and opens the one picked', async () => {
    const rodando = {
      ...IMPORTACAO,
      jobId: 'job-rodando',
      status: STATUS_IMPORTACAO_LI.executando,
    };
    h.clientRef.current = client({
      importacoes: vi.fn(async () => ({ importacoes: [rodando, SIMULACAO, IMPORTACAO] })),
    });
    const { onAbrir } = abrir();
    const seletor = await screen.findByRole('combobox', { name: 'Importação' });

    fireEvent.click(seletor);
    const opcoes = await screen.findAllByRole('option');
    // NEAR MISS — the running job has no result yet: not offered.
    expect(opcoes).toHaveLength(2);
    fireEvent.click(opcoes.find((o) => o.textContent?.includes('Importar')) as HTMLElement);

    expect(onAbrir).toHaveBeenCalledWith({ conta: CONTA, job: IMPORTACAO });
  });

  it('nothing else to offer: no picker', async () => {
    h.clientRef.current = client({
      importacoes: vi.fn(async () => ({ importacoes: [SIMULACAO] })),
    });
    abrir();
    await screen.findByRole('row', { name: porId(101) });
    expect(screen.queryByRole('combobox', { name: 'Importação' })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                              Importar selecionados                          */
/* -------------------------------------------------------------------------- */

describe('ResultadoImportacaoLi — "Importar selecionados"', () => {
  it('⭐ only family roots get a box: never a loose row nor an unlisted id', async () => {
    abrir();
    await screen.findByRole('row', { name: porId(101) });
    for (const id of [101, 102, 103]) expect(caixa(id)).not.toBeNull();
    expect(within(linha(104)).queryByRole('checkbox')).toBeNull();
    expect(within(linha(105)).queryByRole('checkbox')).toBeNull();
  });

  it('⭐ sends EXACTLY the picked ids with the Simular’s options, then closes', async () => {
    const iniciar = vi.fn<Iniciar>(async () => iniciou());
    const { onClose } = abrir({ iniciar });
    await screen.findByRole('row', { name: porId(101) });
    expect((botaoImportar() as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(caixa(103));
    fireEvent.click(caixa(101));
    expect(screen.getByText('2 produtos selecionados (no máximo 1.000)')).not.toBeNull();
    await act(async () => {
      fireEvent.click(botaoImportar());
    });

    expect(iniciar).toHaveBeenCalledTimes(1);
    expect(iniciar).toHaveBeenCalledWith([CONTA], {
      modo: MODO_IMPORTACAO_LI.aplicar,
      alvo: ALVO_IMPORTACAO_LI.selecionados,
      acao: ACAO_IMPORTACAO_LI.completar,
      categorias: CATEGORIAS_IMPORTACAO_LI.criarEVincular,
      fotos: FOTOS_IMPORTACAO_LI.soSemFotos,
      selecionados: [101, 103],
      simulacaoId: 'job-simulacao-1',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('⭐ a start that FAILED keeps the view open, the selection marked, and says why', async () => {
    const iniciar = vi.fn<Iniciar>(async () => [
      { kind: 'error', conta: CONTA, color: 'red', message: 'Falha de rede.' },
    ]);
    const { onClose } = abrir({ iniciar });
    await screen.findByRole('row', { name: porId(101) });
    fireEvent.click(caixa(101));
    await act(async () => {
      fireEvent.click(botaoImportar());
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Falha de rede. A seleção continua marcada aqui.')).not.toBeNull();
    expect((caixa(101) as HTMLInputElement).checked).toBe(true);
  });

  it('⭐ NEAR MISS — a busy start that ATTACHED keeps the view open too: the selection was not applied', async () => {
    const iniciar = vi.fn<Iniciar>(async () => [
      { kind: 'started', conta: CONTA, jobId: 'job-rodando', reatado: true },
    ]);
    const { onClose } = abrir({ iniciar });
    await screen.findByRole('row', { name: porId(101) });
    fireEvent.click(caixa(101));
    await act(async () => {
      fireEvent.click(botaoImportar());
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/a seleção não foi importada/)).not.toBeNull();
    expect((caixa(101) as HTMLInputElement).checked).toBe(true);
  });

  it('⭐ a start that settles after the view moved on to another job closes nothing', async () => {
    let soltar: ((d: DesfechoInicioLi[]) => void) | null = null;
    const iniciar = vi.fn<Iniciar>(
      () =>
        new Promise<DesfechoInicioLi[]>((resolve) => {
          soltar = resolve;
        }),
    );
    const { onClose, reabrir } = abrir({ iniciar });
    await screen.findByRole('row', { name: porId(101) });
    fireEvent.click(caixa(101));
    fireEvent.click(botaoImportar());

    // The operator opened another job's result meanwhile.
    reabrir({ job: { ...SIMULACAO, jobId: 'job-simulacao-2' }, iniciar });
    await screen.findByRole('row', { name: porId(101) });
    await act(async () => {
      soltar?.(iniciou());
      await Promise.resolve();
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('a box ticked twice is off again', async () => {
    const iniciar = vi.fn<Iniciar>(async () => iniciou());
    abrir({ iniciar });
    await screen.findByRole('row', { name: porId(101) });
    fireEvent.click(caixa(101));
    fireEvent.click(caixa(102));
    fireEvent.click(caixa(101));
    await act(async () => {
      fireEvent.click(botaoImportar());
    });
    expect(iniciar.mock.calls[0]?.[1]).toMatchObject({ selecionados: [102] });
  });

  it('⭐ select all covers the FILTERED selectable rows only, across the filter switch', async () => {
    const iniciar = vi.fn<Iniciar>(async () => iniciou());
    abrir({ iniciar });
    await screen.findByRole('row', { name: porId(101) });
    fireEvent.click(filtro(/^Com pendências/));
    // 102 and 104 are in the filter; only 102 is a family root.
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Selecionar todos os produtos do filtro' }),
    );
    fireEvent.click(filtro(/^Todos/));
    expect((caixa(102) as HTMLInputElement).checked).toBe(true);
    expect((caixa(101) as HTMLInputElement).checked).toBe(false);
    await act(async () => {
      fireEvent.click(botaoImportar());
    });
    expect(iniciar.mock.calls[0]?.[1]).toMatchObject({ selecionados: [102] });
  });

  it('⭐ the cap holds in the UI: at 1,000 no other box can be ticked, and select all refuses to pass it', async () => {
    const mil = Array.from({ length: MAX_SELECIONADOS_LI }, (_, i) => item(10_000 + i));
    const extra = item(90_000, { acao: ACAO_ITEM_IMPORTACAO_LI.vincular });
    h.clientRef.current = client({
      itensImportacao: vi.fn(async () => ({ itens: [...mil, extra], proximo: null })),
    });
    abrir();
    await screen.findByRole('row', { name: porId(10000) });
    const todos = () =>
      screen.getByRole('checkbox', {
        name: 'Selecionar todos os produtos do filtro',
      }) as HTMLInputElement;
    // 1,001 selectable rows under "Todos": select all would pass the cap.
    expect(todos().disabled).toBe(true);
    expect(screen.getByText(/passa do limite de 1\.000 por importação/)).not.toBeNull();

    // Exactly 1,000 under "A criar" fits.
    fireEvent.click(filtro(/^A criar/));
    fireEvent.click(todos());
    expect(screen.getByText('1000 produtos selecionados (no máximo 1.000)')).not.toBeNull();

    fireEvent.click(filtro(/^A vincular/));
    expect((caixa(90_000) as HTMLInputElement).disabled).toBe(true);
    expect((botaoImportar() as HTMLButtonElement).disabled).toBe(false);
  });

  it('NEAR MISS — not a finished Simular: no box and no button', async () => {
    for (const job of [IMPORTACAO, { ...SIMULACAO, status: STATUS_IMPORTACAO_LI.cancelado }]) {
      const { unmount } = abrir({ job });
      await screen.findByRole('row', { name: porId(101) });
      expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
      expect(screen.queryByRole('button', { name: /^Importar selecionados/ })).toBeNull();
      unmount();
    }
  });

  it('NEAR MISS — a viewer who may not start sees the report, and why there is no button', async () => {
    abrir({ semPermissao: true });
    await screen.findByRole('row', { name: porId(101) });
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByText(/precisa da permissão de escrita de Integrações/)).not.toBeNull();
  });

  it('a start in flight keeps the button disabled', async () => {
    abrir({ busy: true });
    await screen.findByRole('row', { name: porId(101) });
    fireEvent.click(caixa(101));
    expect((botaoImportar() as HTMLButtonElement).disabled).toBe(true);
  });

  it('⭐ the selection belongs to one job: another job opens with nothing selected', async () => {
    const { reabrir } = abrir();
    await screen.findByRole('row', { name: porId(101) });
    fireEvent.click(caixa(101));
    expect((caixa(101) as HTMLInputElement).checked).toBe(true);

    reabrir({ job: { ...SIMULACAO, jobId: 'job-simulacao-2' } });
    await screen.findByRole('row', { name: porId(101) });
    expect((caixa(101) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText('0 produtos selecionados (no máximo 1.000)')).not.toBeNull();
  });
});

describe('ResultadoImportacaoLi — through the real action', () => {
  /** The page's wiring: the action's state is what the view starts through. */
  function Pagina({ job }: { job: RespostaImportacaoLi }) {
    const { state } = useImportarProdutosLiAction();
    return (
      <>
        <ResultadoImportacaoLi
          alvo={{ conta: CONTA, job }}
          onClose={() => {}}
          onAbrir={() => {}}
          importacao={state}
        />
        <output data-testid="ledger">{JSON.stringify(state.entries)}</output>
        <output data-testid="reatados">{JSON.stringify([...state.reatados])}</output>
      </>
    );
  }

  it('⭐ a busy start’s 409 ATTACHES to the running job, as the action does', async () => {
    const iniciarImportacao = vi.fn(async () => {
      throw new LojaIntegradaClientHttpError(
        'Esta conta já tem uma importação em andamento.',
        409,
        CODIGO_ERRO_LI.importacaoEmAndamento,
        { jobId: 'job-rodando' },
      );
    });
    h.clientRef.current = client({
      iniciarImportacao,
      importacoes: vi.fn(async () => ({ importacoes: [] })),
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(host(<Pagina job={SIMULACAO} />, qc));
    await screen.findByRole('row', { name: porId(101) });
    fireEvent.click(caixa(101));
    await act(async () => {
      fireEvent.click(botaoImportar());
    });

    expect(iniciarImportacao).toHaveBeenCalledWith('conta-falsa-1', {
      modo: MODO_IMPORTACAO_LI.aplicar,
      alvo: ALVO_IMPORTACAO_LI.selecionados,
      acao: ACAO_IMPORTACAO_LI.completar,
      categorias: CATEGORIAS_IMPORTACAO_LI.criarEVincular,
      fotos: FOTOS_IMPORTACAO_LI.soSemFotos,
      selecionados: [101],
      simulacaoId: 'job-simulacao-1',
    });
    expect(JSON.parse(screen.getByTestId('ledger').textContent ?? '')).toEqual([
      { kind: 'started', conta: CONTA, jobId: 'job-rodando' },
    ]);
    expect(JSON.parse(screen.getByTestId('reatados').textContent ?? '')).toEqual(['job-rodando']);
  });
});
