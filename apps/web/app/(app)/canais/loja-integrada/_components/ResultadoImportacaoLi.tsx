'use client';

/**
 * The result of one ENDED product import (master plan step 9), opened from its
 * card in the rail ("Ver resultado", `CartaoImportacaoLi.tsx`): the job's
 * report, one row per store product, and — for an import — its tax-review list.
 *
 * ## The report
 *
 * Every page of the job's `itens` (`useItensImportacaoLi`, read once per open
 * and kept for an ended job), sorted by store id and shown 100 rows at a time.
 * A row says what the store holds (id, SKU, name, tipo, variations), where it
 * stands against the ERP, what the run did — or, under Simular, would do — the
 * ERP fields it filled, the store categories it created, its pendências (an
 * actionable one marked "ação necessária") and, when there is one, a link to the
 * ERP produto. Every code is read through `importacaoRotulos.ts`, so a code a
 * newer backend adds still shows, quoted.
 *
 * The filters narrow the report by what the run did (`acao`), by the
 * pendências a person must act on ("Ação necessária": what the card's "a
 * resolver" counts and the summary aviso keeps open), by any pendência and by
 * loose rows. "Revisão fiscal" is NOT a report filter: it is the tax-review
 * list, read only when picked (below).
 *
 * ## Which job
 *
 * The view opens on the job whose card was clicked; the header's picker lists
 * the conta's other ENDED jobs (the backend's newest ten, `useImportacoesLi`),
 * so an older import's result — the one an aviso names, the one before a
 * Simular — is never out of reach. The conta page shows the same panel, so the
 * avisos' link to it lands on the result too.
 *
 * ## The tax-review list ("Revisão fiscal")
 *
 * Each `aplicar` job holds the WHOLE list as its re-check (its `revisao`
 * phase) left it, carried forward from the jobs before. So:
 *  - an import whose re-check ran shows its own list — and, when a newer one
 *    also ran, says the open list is that one's, one click away;
 *  - an import that stopped before its re-check (`falhou`/`cancelado` before
 *    the last phase) holds only part of the list (what it put on it, and what
 *    it had carried so far): the view says the list is partial, shows it, and
 *    points at the open one — the next import joins the two;
 *  - a Simular writes no list, and the view points at the open one.
 * "The open list" is the newest import among the conta's ten whose re-check
 * ran — the list the `lojaIntegradaRevisaoFiscal` aviso counts.
 *
 * ## "Importar selecionados"
 *
 * Only for a Simular that ended `concluido`, and only for a viewer who may
 * start (the page passes `importacao` only with `PERM.integracao.write`). The
 * operator picks rows — store parents and simple products, never a loose row
 * (`avulso`) or a selected id the store no longer lists (`nao-listado`): the
 * backend's `selecionados` are family roots — at most `MAX_SELECIONADOS_LI`,
 * a cap the UI holds (no box can push past it, and "select all" refuses a
 * filter that would). The button starts an `aplicar` job over EXACTLY those
 * store ids, with the Simular's own `acao`, `categorias` and `fotos`, naming the
 * Simular as `simulacaoId` — through the action's `iniciar`, so it lands in the
 * same ledger as any other start and a busy start's 409 attaches to the running
 * job there. The view closes only when THIS conta's start really started a new
 * job (its card is then in the panel). A failed start, or a busy start that
 * attached to the running job (the selection was NOT applied), keeps the view
 * open with the selection and says why, so nothing picked by hand is lost; and
 * a start that settles after the view moved on (closed, or another job opened)
 * touches nothing.
 *
 * The selection belongs to one job: the body is keyed by conta and job, so a
 * different job opens with nothing selected.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  Loader,
  Modal,
  Pagination,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import {
  ACAO_ITEM_IMPORTACAO_LI,
  ALVO_IMPORTACAO_LI,
  type AcaoItemImportacaoLi,
  FASE_IMPORTACAO_LI,
  STATUS_EM_CURSO_IMPORTACAO_LI,
  type EntradaRespostaRevisaoFiscalLi,
  type ItemRespostaImportacaoLi,
  MAX_SELECIONADOS_LI,
  MODO_IMPORTACAO_LI,
  type RespostaImportacaoLi,
  SITUACAO_ERP_ITEM_LI,
  STATUS_IMPORTACAO_LI,
  TIPO_PRODUTO_LI,
  acaoItemImportacaoLiSchema,
  situacaoErpItemLiSchema,
  tipoProdutoLiSchema,
} from '@delfrance/schemas';

import { RetryAlert } from '@/components/feedback/RetryAlert';
import type { EntradaOpcoesImportacaoLi } from '@/lib/loja-integrada/client';
import {
  descreverFalhaLeituraImportacaoLi,
  descreverFalhaLeituraRevisaoFiscalLi,
  useImportacoesLi,
  useItensImportacaoLi,
  useRevisaoImportacaoLi,
} from '@/lib/loja-integrada/importacao';
import {
  COR_STATUS_IMPORTACAO_LI,
  ROTULO_MODO_IMPORTACAO_LI,
  ROTULO_STATUS_IMPORTACAO_LI,
  lerAcaoItemImportacaoLi,
  lerCampoLi,
  lerMotivoRevisaoFiscalLi,
  lerPendenciaLi,
  lerSituacaoErpItemLi,
  lerTipoProdutoLi,
  textoReferenciasDaPendenciaLi,
} from '@/lib/loja-integrada/importacaoRotulos';
import { formatarInstanteJob } from '@/lib/marketplace/contaJobs/cadencia';
import type { ContaRef } from '@/lib/marketplace/contaJobs/types';
import { type RetryableQuery, queryRetry } from '@/lib/query/queryRetry';
import {
  type AlvoResultadoImportacaoLi,
  linhasDosContadoresLi,
  resumoDasOpcoesLi,
} from './CartaoImportacaoLi';
import type {
  DesfechoInicioLi,
  ImportarProdutosLiActionState,
} from './useImportarProdutosLiAction';

/** Rows per page of the report and of the tax-review list. */
export const LINHAS_POR_PAGINA_RESULTADO_LI = 100;

/* -------------------------------------------------------------------------- */
/*                                  The filters                                */
/* -------------------------------------------------------------------------- */

/** The view's filters: seven over the report, and the tax-review list. */
export const FILTRO_RESULTADO_LI = {
  todos: 'todos',
  criados: 'criados',
  vinculados: 'vinculados',
  completados: 'completados',
  acionaveis: 'acionaveis',
  pendencias: 'pendencias',
  avulsos: 'avulsos',
  revisao: 'revisao',
} as const;
export type FiltroResultadoLi = (typeof FILTRO_RESULTADO_LI)[keyof typeof FILTRO_RESULTADO_LI];

/** The filters over the report, in the order they show. */
export const FILTROS_DO_RELATORIO_LI = [
  FILTRO_RESULTADO_LI.todos,
  FILTRO_RESULTADO_LI.criados,
  FILTRO_RESULTADO_LI.vinculados,
  FILTRO_RESULTADO_LI.completados,
  FILTRO_RESULTADO_LI.acionaveis,
  FILTRO_RESULTADO_LI.pendencias,
  FILTRO_RESULTADO_LI.avulsos,
] as const satisfies readonly FiltroResultadoLi[];
export type FiltroDoRelatorioLi = (typeof FILTROS_DO_RELATORIO_LI)[number];

const TODOS_OS_FILTROS: readonly FiltroResultadoLi[] = [
  ...FILTROS_DO_RELATORIO_LI,
  FILTRO_RESULTADO_LI.revisao,
];

/** The three filters that read the item's `acao`, and the ação each one keeps. */
const ACAO_DO_FILTRO = {
  [FILTRO_RESULTADO_LI.criados]: ACAO_ITEM_IMPORTACAO_LI.criar,
  [FILTRO_RESULTADO_LI.vinculados]: ACAO_ITEM_IMPORTACAO_LI.vincular,
  [FILTRO_RESULTADO_LI.completados]: ACAO_ITEM_IMPORTACAO_LI.completar,
} as const satisfies Partial<Record<FiltroDoRelatorioLi, AcaoItemImportacaoLi>>;

/** A filter's label: what was done, or — under Simular — what an import would do. */
function rotuloDoFiltro(filtro: FiltroResultadoLi, simular: boolean): string {
  switch (filtro) {
    case FILTRO_RESULTADO_LI.todos:
      return 'Todos';
    case FILTRO_RESULTADO_LI.criados:
      return simular ? 'A criar' : 'Criados';
    case FILTRO_RESULTADO_LI.vinculados:
      return simular ? 'A vincular' : 'Vinculados';
    case FILTRO_RESULTADO_LI.completados:
      return simular ? 'A completar' : 'Completados';
    case FILTRO_RESULTADO_LI.acionaveis:
      return 'Ação necessária';
    case FILTRO_RESULTADO_LI.pendencias:
      return 'Com pendências';
    case FILTRO_RESULTADO_LI.avulsos:
      return 'Avulsos';
    case FILTRO_RESULTADO_LI.revisao:
      return 'Revisão fiscal';
  }
}

/**
 * Whether a report item belongs to a filter. Every code is matched EXACTLY
 * through its schema — `item.acao` and `item.situacaoErp` are plain strings in
 * the answer, and a code this build does not know belongs to no narrowing
 * filter (it still shows under "Todos"). "Revisão fiscal" holds no item.
 */
export function itemNoFiltroLi(
  item: Pick<ItemRespostaImportacaoLi, 'acao' | 'situacaoErp' | 'pendencias'>,
  filtro: FiltroResultadoLi,
): boolean {
  switch (filtro) {
    case FILTRO_RESULTADO_LI.todos:
      return true;
    case FILTRO_RESULTADO_LI.criados:
    case FILTRO_RESULTADO_LI.vinculados:
    case FILTRO_RESULTADO_LI.completados: {
      const acao = acaoItemImportacaoLiSchema.safeParse(item.acao);
      return acao.success && acao.data === ACAO_DO_FILTRO[filtro];
    }
    case FILTRO_RESULTADO_LI.acionaveis:
      // The class is `lerPendenciaLi`'s: the shared set for a known code, the
      // stored flag for one this build does not know — the same reading that
      // marks the row "ação necessária".
      return item.pendencias.some((p) => lerPendenciaLi(p).acionavel);
    case FILTRO_RESULTADO_LI.pendencias:
      // Either class: the "ação necessária" mark tells them apart in the row.
      return item.pendencias.length > 0;
    case FILTRO_RESULTADO_LI.avulsos: {
      const situacao = situacaoErpItemLiSchema.safeParse(item.situacaoErp);
      return situacao.success && situacao.data === SITUACAO_ERP_ITEM_LI.avulso;
    }
    case FILTRO_RESULTADO_LI.revisao:
      return false;
  }
}

/** How many items each report filter holds — the counts in the filter labels. */
export function contarPorFiltroLi(
  itens: readonly Pick<ItemRespostaImportacaoLi, 'acao' | 'situacaoErp' | 'pendencias'>[],
): Record<FiltroDoRelatorioLi, number> {
  const contagem = Object.fromEntries(FILTROS_DO_RELATORIO_LI.map((f) => [f, 0])) as Record<
    FiltroDoRelatorioLi,
    number
  >;
  for (const item of itens) {
    for (const f of FILTROS_DO_RELATORIO_LI) if (itemNoFiltroLi(item, f)) contagem[f] += 1;
  }
  return contagem;
}

/* -------------------------------------------------------------------------- */
/*                                The selection                                */
/* -------------------------------------------------------------------------- */

/** A Simular that ended `concluido` — the only job a selection can come from. */
export function podeImportarSelecionadosLi(job: Pick<RespostaImportacaoLi, 'modo' | 'status'>) {
  return job.modo === MODO_IMPORTACAO_LI.simular && job.status === STATUS_IMPORTACAO_LI.concluido;
}

/**
 * Whether a report row can be selected: a store PARENT or SIMPLE product that
 * the listing placed as a family root. The backend's `selecionados` are family
 * roots, so a loose row (`avulso`: an orphan variation, a variation of a
 * trashed parent, an unknown tipo) and a selected id the store no longer lists
 * (`nao-listado`) never are; nor is a row whose tipo or situação this build
 * does not know — both are read EXACTLY through their schemas.
 */
export function ehItemSelecionavelLi(
  item: Pick<ItemRespostaImportacaoLi, 'tipo' | 'situacaoErp'>,
): boolean {
  const tipo = tipoProdutoLiSchema.safeParse(item.tipo);
  if (!tipo.success) return false;
  if (tipo.data !== TIPO_PRODUTO_LI.normal && tipo.data !== TIPO_PRODUTO_LI.atributo) return false;
  const situacao = situacaoErpItemLiSchema.safeParse(item.situacaoErp);
  return (
    situacao.success &&
    situacao.data !== SITUACAO_ERP_ITEM_LI.avulso &&
    situacao.data !== SITUACAO_ERP_ITEM_LI.naoListado
  );
}

/** Whether a filter's selectable ids are all, some or none of the selection. */
export type EstadoDoTodosLi = 'todos' | 'alguns' | 'nenhum';

export function estadoDoTodosLi(
  selecao: ReadonlySet<number>,
  ids: readonly number[],
): EstadoDoTodosLi {
  const marcados = ids.filter((id) => selecao.has(id)).length;
  if (marcados === 0) return 'nenhum';
  return marcados === ids.length ? 'todos' : 'alguns';
}

/**
 * The selection after "select all" over a filter's selectable `ids`: all of
 * them off when every one is on, otherwise all of them on — or `null` when that
 * would pass `max`. Never a partial fill: a selection silently cut at the cap
 * would import a set the operator did not choose.
 */
export function selecaoAoAlternarTodosLi(
  selecao: ReadonlySet<number>,
  ids: readonly number[],
  max: number = MAX_SELECIONADOS_LI,
): ReadonlySet<number> | null {
  if (ids.length > 0 && estadoDoTodosLi(selecao, ids) === 'todos') {
    const sem = new Set(selecao);
    for (const id of ids) sem.delete(id);
    return sem;
  }
  const com = new Set(selecao);
  for (const id of ids) com.add(id);
  return com.size > max ? null : com;
}

/**
 * The start body of "Importar selecionados": an `aplicar` over EXACTLY the
 * selected store ids (ascending, so the body does not depend on the click
 * order), with the Simular's own `acao`, `categorias` and `fotos`, naming it as
 * the selection's source. The client parses it through the strict start schema
 * before anything is sent (an empty selection throws `ZodError` there).
 */
export function opcoesImportarSelecionadosLi(
  simulacao: Pick<RespostaImportacaoLi, 'jobId' | 'acao' | 'categorias' | 'fotos'>,
  selecao: ReadonlySet<number>,
): EntradaOpcoesImportacaoLi {
  return {
    modo: MODO_IMPORTACAO_LI.aplicar,
    alvo: ALVO_IMPORTACAO_LI.selecionados,
    acao: simulacao.acao,
    categorias: simulacao.categorias,
    fotos: simulacao.fotos,
    selecionados: [...selecao].sort((a, b) => a - b),
    simulacaoId: simulacao.jobId,
  };
}

/* -------------------------------------------------------------------------- */
/*                         Whose tax-review list is open                       */
/* -------------------------------------------------------------------------- */

/**
 * Whether an import's tax-review list is WHOLE: an `aplicar` job that ended
 * after its re-check ran — `concluido`, or stopped only in its last phase
 * (`fim`), past the `revisao` phase. A Simular writes no list; a job that
 * stopped earlier holds only part of it.
 */
export function revisaoFiscalCompletaLi(
  job: Pick<RespostaImportacaoLi, 'modo' | 'status' | 'fase'>,
): boolean {
  if (job.modo !== MODO_IMPORTACAO_LI.aplicar) return false;
  if (STATUS_EM_CURSO_IMPORTACAO_LI.has(job.status)) return false;
  return job.status === STATUS_IMPORTACAO_LI.concluido || job.fase === FASE_IMPORTACAO_LI.fim;
}

/**
 * The job whose list is the OPEN one — the newest of `importacoes` (the
 * backend's newest first) whose list is whole — or `null` when none of them is.
 */
export function jobDaListaEmAbertoLi<
  J extends Pick<RespostaImportacaoLi, 'modo' | 'status' | 'fase'>,
>(importacoes: readonly J[]): J | null {
  return importacoes.find(revisaoFiscalCompletaLi) ?? null;
}

/** The ended jobs the header's picker offers: the list's, plus the job on screen when the list lacks it. */
export function jobsDoSeletorLi(
  importacoes: readonly RespostaImportacaoLi[],
  atual: RespostaImportacaoLi,
): RespostaImportacaoLi[] {
  const encerrados = importacoes.filter((j) => !STATUS_EM_CURSO_IMPORTACAO_LI.has(j.status));
  return encerrados.some((j) => j.jobId === atual.jobId) ? encerrados : [atual, ...encerrados];
}

/* -------------------------------------------------------------------------- */
/*                                 Small readers                               */
/* -------------------------------------------------------------------------- */

/** `n` with its noun, singular or plural. */
function contar(n: number, singular: string, plural: string): string {
  return `${String(n)} ${n === 1 ? singular : plural}`;
}

/** The store categories a family's run created, with their count — or `null` for none. */
export function textoCategoriasCriadasLi(ids: readonly number[]): string | null {
  if (ids.length === 0) return null;
  return `${contar(ids.length, 'categoria', 'categorias')}: ${ids.map(String).join(', ')}`;
}

/** One page of a list, 1-based. */
function paginaDe<T>(lista: readonly T[], pagina: number): readonly T[] {
  const inicio = (pagina - 1) * LINHAS_POR_PAGINA_RESULTADO_LI;
  return lista.slice(inicio, inicio + LINHAS_POR_PAGINA_RESULTADO_LI);
}

function totalDePaginas(n: number): number {
  return Math.max(1, Math.ceil(n / LINHAS_POR_PAGINA_RESULTADO_LI));
}

/** The ERP produto's edit page (the produtos screen's own route). */
function hrefDoProduto(produtoId: string): string {
  return `/produtos/${encodeURIComponent(produtoId)}/editar`;
}

const MAX_SELECIONADOS_TEXTO = MAX_SELECIONADOS_LI.toLocaleString('pt-BR');

/* -------------------------------------------------------------------------- */
/*                                  The view                                   */
/* -------------------------------------------------------------------------- */

export interface ResultadoImportacaoLiProps {
  /** The ended job to show, or `null` — the view is closed. */
  readonly alvo: AlvoResultadoImportacaoLi | null;
  readonly onClose: () => void;
  /** Opens another ended job of the conta (the picker, "Ver a lista em aberto"). */
  readonly onAbrir: (alvo: AlvoResultadoImportacaoLi) => void;
  /**
   * The start "Importar selecionados" goes through (the action's), or `null`
   * when the viewer may not start one (`PERM.integracao.write`).
   */
  readonly importacao: Pick<ImportarProdutosLiActionState, 'iniciar' | 'busy'> | null;
}

export function ResultadoImportacaoLi({
  alvo,
  onClose,
  onAbrir,
  importacao,
}: ResultadoImportacaoLiProps) {
  const titulo =
    alvo === null
      ? ''
      : `${alvo.job.modo === MODO_IMPORTACAO_LI.simular ? 'Resultado da simulação' : 'Resultado da importação'} — ${alvo.conta.nome}`;
  return (
    <Modal opened={alvo !== null} onClose={onClose} title={titulo} size="90%" centered>
      {alvo !== null && (
        <CorpoDoResultadoLi
          // A different job is a fresh body: nothing selected, first page.
          key={`${alvo.conta.id}/${alvo.job.jobId}`}
          conta={alvo.conta}
          job={alvo.job}
          filtroInicial={
            alvo.naRevisaoFiscal === true ? FILTRO_RESULTADO_LI.revisao : FILTRO_RESULTADO_LI.todos
          }
          importacao={importacao}
          onClose={onClose}
          onAbrir={onAbrir}
        />
      )}
    </Modal>
  );
}

function CorpoDoResultadoLi({
  conta,
  job,
  filtroInicial,
  importacao,
  onClose,
  onAbrir,
}: {
  conta: ContaRef;
  job: RespostaImportacaoLi;
  filtroInicial: FiltroResultadoLi;
  importacao: ResultadoImportacaoLiProps['importacao'];
  onClose: () => void;
  onAbrir: (alvo: AlvoResultadoImportacaoLi) => void;
}) {
  const [filtro, setFiltro] = useState<FiltroResultadoLi>(filtroInicial);
  const [pagina, setPagina] = useState(1);
  const [selecao, setSelecao] = useState<ReadonlySet<number>>(new Set());
  /** This body's last "Importar selecionados" that did NOT start a new job. */
  const [desfecho, setDesfecho] = useState<DesfechoInicioLi | null>(null);
  const simular = job.modo === MODO_IMPORTACAO_LI.simular;
  // A start settles up to a deadline later: by then the operator may have closed
  // the view or opened another job, and this body is gone.
  const montado = useRef(true);
  useEffect(() => {
    montado.current = true;
    return () => {
      montado.current = false;
    };
  }, []);

  const leitura = useItensImportacaoLi(conta.id, job);
  const itens = useMemo(
    () => [...(leitura.dados ?? [])].sort((a, b) => a.liId - b.liId),
    [leitura.dados],
  );
  const contagem = useMemo(() => contarPorFiltroLi(itens), [itens]);
  const filtrados = useMemo(() => itens.filter((i) => itemNoFiltroLi(i, filtro)), [itens, filtro]);

  // The selection exists only for a finished Simular a writer is looking at.
  const comSelecao = importacao !== null && podeImportarSelecionadosLi(job);

  function trocarFiltro(valor: string) {
    const novo = TODOS_OS_FILTROS.find((f) => f === valor);
    if (novo === undefined) return;
    setFiltro(novo);
    setPagina(1);
  }

  async function importarSelecionados() {
    if (importacao === null) return;
    setDesfecho(null);
    const desfechos = await importacao.iniciar([conta], opcoesImportarSelecionadosLi(job, selecao));
    if (!montado.current) return;
    const meu = desfechos.find((d) => d.conta.id === conta.id) ?? null;
    if (meu?.kind === 'started' && !meu.reatado) {
      onClose();
      return;
    }
    setDesfecho(meu);
  }

  return (
    <Stack gap="sm">
      <SeletorDeJobLi conta={conta} job={job} onAbrir={onAbrir} />
      <CabecalhoDoResultadoLi job={job} />

      {leitura.erro != null ? (
        <FalhaDeLeituraLi leitura={leitura} descrever={descreverFalhaLeituraImportacaoLi} />
      ) : leitura.dados === undefined ? (
        <Carregando texto="Carregando o relatório…" />
      ) : (
        <>
          <Box style={{ overflowX: 'auto' }}>
            <SegmentedControl
              size="xs"
              aria-label="Filtro do resultado"
              value={filtro}
              onChange={trocarFiltro}
              data={TODOS_OS_FILTROS.map((f) => ({
                value: f,
                label:
                  f === FILTRO_RESULTADO_LI.revisao
                    ? rotuloDoFiltro(f, simular)
                    : `${rotuloDoFiltro(f, simular)} (${String(contagem[f])})`,
              }))}
            />
          </Box>

          {filtro === FILTRO_RESULTADO_LI.revisao ? (
            <RevisaoFiscalLi conta={conta} job={job} onAbrir={onAbrir} />
          ) : (
            <>
              {comSelecao && (
                <BarraDeSelecaoLi
                  job={job}
                  selecao={selecao}
                  busy={importacao.busy}
                  desfecho={desfecho}
                  onImportar={() => {
                    void importarSelecionados();
                  }}
                />
              )}
              {simular && !comSelecao && (
                <Text size="xs" c="dimmed">
                  {podeImportarSelecionadosLi(job)
                    ? 'Importar uma seleção desta simulação precisa da permissão de escrita de Integrações.'
                    : 'Só uma simulação concluída permite importar uma seleção dos seus produtos.'}
                </Text>
              )}
              <TabelaDoRelatorioLi
                itens={filtrados}
                pagina={pagina}
                onPagina={setPagina}
                comSelecao={comSelecao}
                selecao={selecao}
                onSelecao={setSelecao}
                vazio={
                  itens.length === 0
                    ? 'O relatório desta importação está vazio: nenhum produto da loja chegou a ser processado.'
                    : 'Nenhum produto neste filtro.'
                }
              />
            </>
          )}
        </>
      )}
    </Stack>
  );
}

/** One job as the picker names it: when, mode and how it ended. */
function rotuloDoJobNoSeletor(j: RespostaImportacaoLi): string {
  return `${formatarInstanteJob(j.iniciadoEmMs, { comAno: true })} · ${ROTULO_MODO_IMPORTACAO_LI[j.modo]} · ${ROTULO_STATUS_IMPORTACAO_LI[j.status]}`;
}

/**
 * The conta's other ended jobs, to open one instead (module header, "Which
 * job"). The list read is the panel's own (cached); nothing shows until it has
 * more than this job to offer.
 */
function SeletorDeJobLi({
  conta,
  job,
  onAbrir,
}: {
  conta: ContaRef;
  job: RespostaImportacaoLi;
  onAbrir: (alvo: AlvoResultadoImportacaoLi) => void;
}) {
  const lista = useImportacoesLi(conta.id);
  const jobs = jobsDoSeletorLi(lista.dados?.importacoes ?? [], job);
  if (jobs.length < 2) return null;
  return (
    <Select
      size="xs"
      label="Importação"
      description="Entre as 10 importações mais recentes desta conta, as que já terminaram."
      allowDeselect={false}
      value={job.jobId}
      data={jobs.map((j) => ({ value: j.jobId, label: rotuloDoJobNoSeletor(j) }))}
      onChange={(jobId) => {
        const escolhido = jobs.find((j) => j.jobId === jobId);
        if (escolhido !== undefined && escolhido.jobId !== job.jobId) {
          onAbrir({ conta, job: escolhido });
        }
      }}
    />
  );
}

/** The job as the card shows it: status, mode, when, the options and the counters. */
function CabecalhoDoResultadoLi({ job }: { job: RespostaImportacaoLi }) {
  const simular = job.modo === MODO_IMPORTACAO_LI.simular;
  return (
    <Stack gap={4}>
      <Group gap={4}>
        <Badge size="sm" variant="light" color={COR_STATUS_IMPORTACAO_LI[job.status]}>
          {ROTULO_STATUS_IMPORTACAO_LI[job.status]}
        </Badge>
        <Badge size="sm" variant="outline" color="gray">
          {ROTULO_MODO_IMPORTACAO_LI[job.modo]}
        </Badge>
      </Group>
      <Text size="xs" c="dimmed">
        Iniciada em {formatarInstanteJob(job.iniciadoEmMs, { comAno: true })} ·{' '}
        {resumoDasOpcoesLi(job)}
      </Text>
      {linhasDosContadoresLi(job).map((linha) => (
        <Text key={linha} size="xs">
          {linha}
        </Text>
      ))}
      {simular && (
        <Text size="xs" c="dimmed">
          Simulação: o relatório diz o que uma importação faria; nada foi gravado no ERP.
        </Text>
      )}
      {job.status !== STATUS_IMPORTACAO_LI.concluido && (
        <Text size="xs" c="dimmed">
          Esta execução não chegou ao fim: o relatório mostra só os produtos que ela processou.
        </Text>
      )}
    </Stack>
  );
}

/** The count, the cap and the button — a finished Simular's way to an import of some rows. */
function BarraDeSelecaoLi({
  job,
  selecao,
  busy,
  desfecho,
  onImportar,
}: {
  job: RespostaImportacaoLi;
  selecao: ReadonlySet<number>;
  busy: boolean;
  /** The last click's outcome when it started no new job, else `null`. */
  desfecho: DesfechoInicioLi | null;
  onImportar: () => void;
}) {
  const n = selecao.size;
  return (
    <Alert color="blue" variant="light" p="xs">
      <Stack gap={4}>
        {desfecho?.kind === 'error' && (
          <Alert color={desfecho.color} variant="light" p="xs">
            <Text size="xs">{desfecho.message} A seleção continua marcada aqui.</Text>
          </Alert>
        )}
        {desfecho?.kind === 'started' && (
          <Alert color="gray" variant="light" p="xs">
            <Text size="xs">
              Esta conta já tinha uma importação em andamento, e o painel passou a acompanhá-la: a
              seleção não foi importada. Ela continua marcada aqui; importe-a quando aquela
              importação terminar.
            </Text>
          </Alert>
        )}
        <Text size="xs">
          Selecione os produtos da loja para importar só eles, com as opções desta simulação (
          {resumoDasOpcoesLi({
            ...job,
            alvo: ALVO_IMPORTACAO_LI.selecionados,
            selecionados: n,
          })}
          ). A importação grava no ERP; o andamento aparece no painel ao lado da lista.
        </Text>
        <Group justify="space-between" gap="xs">
          <Text size="xs" fw={600}>
            {`${contar(n, 'produto selecionado', 'produtos selecionados')} (no máximo ${MAX_SELECIONADOS_TEXTO})`}
          </Text>
          <Button
            size="xs"
            onClick={onImportar}
            loading={busy}
            // Disabled, not only spinning: two starts in the same second can
            // both pass the backend's guard.
            disabled={busy || n === 0 || n > MAX_SELECIONADOS_LI}
          >
            {`Importar selecionados (${String(n)})`}
          </Button>
        </Group>
      </Stack>
    </Alert>
  );
}

function TabelaDoRelatorioLi({
  itens,
  pagina,
  onPagina,
  comSelecao,
  selecao,
  onSelecao,
  vazio,
}: {
  itens: readonly ItemRespostaImportacaoLi[];
  pagina: number;
  onPagina: (p: number) => void;
  comSelecao: boolean;
  selecao: ReadonlySet<number>;
  onSelecao: (s: ReadonlySet<number>) => void;
  vazio: string;
}) {
  if (itens.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {vazio}
      </Text>
    );
  }
  const idsDoFiltro = itens.filter(ehItemSelecionavelLi).map((i) => i.liId);
  const estado = estadoDoTodosLi(selecao, idsDoFiltro);
  const comTodos = selecaoAoAlternarTodosLi(selecao, idsDoFiltro);
  const cheia = selecao.size >= MAX_SELECIONADOS_LI;
  const total = totalDePaginas(itens.length);

  return (
    <Stack gap="xs">
      {comSelecao && comTodos === null && (
        <Text size="xs" c="dimmed">
          {`Este filtro tem ${String(idsDoFiltro.length)} produtos selecionáveis: com a seleção atual, passa do limite de ${MAX_SELECIONADOS_TEXTO} por importação. Selecione um a um ou use um filtro menor.`}
        </Text>
      )}
      <Table.ScrollContainer minWidth={1100}>
        <Table striped verticalSpacing={4} fz="xs">
          <Table.Thead>
            <Table.Tr>
              {comSelecao && (
                <Table.Th>
                  <Checkbox
                    size="xs"
                    aria-label="Selecionar todos os produtos do filtro"
                    checked={estado === 'todos'}
                    indeterminate={estado === 'alguns'}
                    disabled={idsDoFiltro.length === 0 || comTodos === null}
                    onChange={() => {
                      if (comTodos !== null) onSelecao(comTodos);
                    }}
                  />
                </Table.Th>
              )}
              <Table.Th>Id na loja</Table.Th>
              <Table.Th>SKU</Table.Th>
              <Table.Th>Nome</Table.Th>
              <Table.Th>Tipo</Table.Th>
              <Table.Th>Variações</Table.Th>
              <Table.Th>No ERP</Table.Th>
              <Table.Th>Ação</Table.Th>
              <Table.Th>Campos preenchidos</Table.Th>
              <Table.Th>Categorias criadas</Table.Th>
              <Table.Th>Pendências</Table.Th>
              <Table.Th>Produto no ERP</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {paginaDe(itens, pagina).map((item) => (
              <LinhaDoRelatorioLi
                key={item.liId}
                item={item}
                comSelecao={comSelecao}
                marcado={selecao.has(item.liId)}
                bloqueado={cheia}
                onAlternar={() => {
                  const proxima = new Set(selecao);
                  if (proxima.has(item.liId)) proxima.delete(item.liId);
                  else if (proxima.size < MAX_SELECIONADOS_LI) proxima.add(item.liId);
                  onSelecao(proxima);
                }}
              />
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {total > 1 && (
        <Group justify="center">
          <Pagination size="sm" total={total} value={pagina} onChange={onPagina} />
        </Group>
      )}
    </Stack>
  );
}

function LinhaDoRelatorioLi({
  item,
  comSelecao,
  marcado,
  bloqueado,
  onAlternar,
}: {
  item: ItemRespostaImportacaoLi;
  comSelecao: boolean;
  marcado: boolean;
  /** The selection is at the cap: an unmarked box cannot be ticked. */
  bloqueado: boolean;
  onAlternar: () => void;
}) {
  const categorias = textoCategoriasCriadasLi(item.categoriasCriadas);
  return (
    <Table.Tr>
      {comSelecao && (
        <Table.Td>
          {ehItemSelecionavelLi(item) && (
            <Checkbox
              size="xs"
              aria-label={`Selecionar o produto da loja ${String(item.liId)}`}
              checked={marcado}
              disabled={!marcado && bloqueado}
              onChange={onAlternar}
            />
          )}
        </Table.Td>
      )}
      <Table.Td>{item.liId}</Table.Td>
      <Table.Td>{item.sku ?? '—'}</Table.Td>
      <Table.Td>{item.nome ?? '—'}</Table.Td>
      <Table.Td>{lerTipoProdutoLi(item.tipo).texto}</Table.Td>
      <Table.Td>{item.filhos}</Table.Td>
      <Table.Td>{lerSituacaoErpItemLi(item.situacaoErp).texto}</Table.Td>
      <Table.Td>{lerAcaoItemImportacaoLi(item.acao, item.aplicada).texto}</Table.Td>
      <Table.Td>
        {item.camposPreenchidos.length === 0
          ? '—'
          : item.camposPreenchidos.map(lerCampoLi).join(', ')}
      </Table.Td>
      <Table.Td>{categorias ?? '—'}</Table.Td>
      <Table.Td>
        {item.pendencias.length === 0 ? (
          '—'
        ) : (
          <Stack gap={4}>
            {item.pendencias.map((p, i) => (
              <PendenciaDoItemLi key={`${p.codigo}-${String(p.liId)}-${String(i)}`} pendencia={p} />
            ))}
          </Stack>
        )}
      </Table.Td>
      <Table.Td>{item.erpId === null ? '—' : <LinkDoProduto produtoId={item.erpId} />}</Table.Td>
    </Table.Tr>
  );
}

/**
 * One pendência: its label, "ação necessária" when a person must act, and
 * what it names. An actionable one also says what to do; an informational one
 * keeps that sentence in its label's tooltip, so a long report of routine facts
 * stays readable.
 */
function PendenciaDoItemLi({
  pendencia,
}: {
  pendencia: ItemRespostaImportacaoLi['pendencias'][number];
}) {
  const lida = lerPendenciaLi(pendencia);
  const referencias = textoReferenciasDaPendenciaLi(pendencia);
  return (
    <Stack gap={0}>
      <Group gap={4} wrap="nowrap">
        <Badge
          size="xs"
          variant="light"
          color={lida.acionavel ? 'orange' : 'gray'}
          title={lida.descricao}
        >
          {lida.rotulo}
        </Badge>
        {lida.acionavel && (
          <Text size="xs" c="orange" fw={600}>
            ação necessária
          </Text>
        )}
      </Group>
      {lida.acionavel && (
        <Text size="xs" c="dimmed">
          {lida.descricao}
        </Text>
      )}
      {pendencia.liId !== null && (
        <Text size="xs" c="dimmed">
          Variação {pendencia.liId}
        </Text>
      )}
      {referencias !== null && (
        <Text size="xs" c="dimmed">
          {referencias}
        </Text>
      )}
    </Stack>
  );
}

/**
 * The produto's edit page in a NEW tab: the result view and its selection stay
 * where they are.
 */
function LinkDoProduto({ produtoId }: { produtoId: string }) {
  return (
    <Anchor
      component={Link}
      href={hrefDoProduto(produtoId)}
      target="_blank"
      rel="noopener noreferrer"
      size="xs"
      style={{ wordBreak: 'break-all' }}
    >
      {produtoId}
    </Anchor>
  );
}

/* -------------------------------------------------------------------------- */
/*                               The tax-review list                           */
/* -------------------------------------------------------------------------- */

/**
 * "Revisão fiscal" (module header): the job's own list when it is whole, its
 * partial list said as such when it stopped before its re-check, and for a
 * Simular none — each pointing at the open list when that is another job's.
 */
function RevisaoFiscalLi({
  conta,
  job,
  onAbrir,
}: {
  conta: ContaRef;
  job: RespostaImportacaoLi;
  onAbrir: (alvo: AlvoResultadoImportacaoLi) => void;
}) {
  const lista = useImportacoesLi(conta.id);
  const emAberto = jobDaListaEmAbertoLi(lista.dados?.importacoes ?? []);
  const outraEmAberto = emAberto !== null && emAberto.jobId !== job.jobId ? emAberto : null;
  const irParaEmAberto =
    outraEmAberto === null ? null : (
      <IrParaListaEmAbertoLi
        job={outraEmAberto}
        onAbrir={() => onAbrir({ conta, job: outraEmAberto, naRevisaoFiscal: true })}
      />
    );

  if (job.modo === MODO_IMPORTACAO_LI.simular) {
    return (
      <Stack gap="xs">
        <Alert color="gray" variant="light" p="xs">
          <Text size="sm">
            Uma simulação não grava nada no ERP, nem a lista de revisão fiscal: ela só existe para
            uma importação (modo &ldquo;Importar&rdquo;).
          </Text>
        </Alert>
        {irParaEmAberto ?? <SemListaEmAbertoLi carregando={lista.dados === undefined} />}
      </Stack>
    );
  }
  const completa = revisaoFiscalCompletaLi(job);
  return (
    <Stack gap="xs">
      {!completa && (
        <Alert color="yellow" variant="light" p="xs">
          <Text size="xs">
            Esta importação parou antes de terminar de conferir a lista de revisão fiscal, então a
            lista abaixo é parcial. A próxima importação junta o que está nela à lista em aberto e
            confere todos.
          </Text>
        </Alert>
      )}
      {irParaEmAberto ??
        (completa ? null : <SemListaEmAbertoLi carregando={lista.dados === undefined} />)}
      <ListaRevisaoFiscalLi conta={conta} job={job} completa={completa} />
    </Stack>
  );
}

/** The open list is another job's: which, and the way to it. */
function IrParaListaEmAbertoLi({
  job,
  onAbrir,
}: {
  job: RespostaImportacaoLi;
  onAbrir: () => void;
}) {
  return (
    <Group gap="xs" justify="space-between">
      <Text size="xs">
        A lista em aberto, a que o aviso de revisão fiscal acompanha, é a da importação iniciada em{' '}
        {formatarInstanteJob(job.iniciadoEmMs, { comAno: true })}, a mais recente que conferiu a
        lista.
      </Text>
      <Button size="compact-xs" variant="light" onClick={onAbrir}>
        Ver a lista em aberto
      </Button>
    </Group>
  );
}

/** No job among the conta's ten has a whole list (or the list is still loading). */
function SemListaEmAbertoLi({ carregando }: { carregando: boolean }) {
  if (carregando) return null;
  return (
    <Text size="xs" c="dimmed">
      Nenhuma das 10 importações mais recentes desta conta conferiu a lista de revisão fiscal.
    </Text>
  );
}

/** Its own component, so the list is read only when the filter is picked on an import. */
function ListaRevisaoFiscalLi({
  conta,
  job,
  completa,
}: {
  conta: ContaRef;
  job: RespostaImportacaoLi;
  /** The job's re-check ran: its list is the whole list as it left it. */
  completa: boolean;
}) {
  const leitura = useRevisaoImportacaoLi(conta.id, job);
  const [pagina, setPagina] = useState(1);

  if (leitura.erro != null) {
    return <FalhaDeLeituraLi leitura={leitura} descrever={descreverFalhaLeituraRevisaoFiscalLi} />;
  }
  if (leitura.dados === undefined) return <Carregando texto="Carregando a revisão fiscal…" />;

  const entradas = leitura.dados;
  const total = totalDePaginas(entradas.length);
  return (
    <Stack gap="xs">
      <Text size="xs" c="dimmed">
        Produtos do ERP cuja configuração de impostos precisa ser conferida, porque a importação os
        criou, criou ou preencheu a categoria deles, ou os deixou sem categoria. Cada um sai da
        lista quando ganha a sua própria configuração, quando a categoria dele ganha uma, ou quando
        uma regra de imposto o cobre.
        {completa
          ? ' Esta é a lista como esta importação a deixou: a importação seguinte a carrega adiante e a confere de novo.'
          : ''}
      </Text>
      {entradas.length === 0 ? (
        <Text size="sm" c="dimmed">
          {completa
            ? 'Nenhum produto na revisão fiscal desta importação.'
            : 'Nenhum produto nesta lista parcial.'}
        </Text>
      ) : (
        <>
          <Table.ScrollContainer minWidth={700}>
            <Table striped verticalSpacing={4} fz="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Produto no ERP</Table.Th>
                  <Table.Th>Id na loja</Table.Th>
                  <Table.Th>Motivos</Table.Th>
                  <Table.Th>Na lista desde</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {paginaDe(entradas, pagina).map((e) => (
                  <LinhaDaRevisaoLi key={e.produtoId} entrada={e} jobId={job.jobId} />
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          {total > 1 && (
            <Group justify="center">
              <Pagination size="sm" total={total} value={pagina} onChange={setPagina} />
            </Group>
          )}
        </>
      )}
    </Stack>
  );
}

function LinhaDaRevisaoLi({
  entrada,
  jobId,
}: {
  entrada: EntradaRespostaRevisaoFiscalLi;
  jobId: string;
}) {
  const motivos = entrada.motivos.map((m) => lerMotivoRevisaoFiscalLi(m).texto);
  const desde =
    entrada.desdeMs === null ? '—' : formatarInstanteJob(entrada.desdeMs, { comAno: true });
  return (
    <Table.Tr>
      <Table.Td>
        <LinkDoProduto produtoId={entrada.produtoId} />
      </Table.Td>
      <Table.Td>{entrada.liId ?? '—'}</Table.Td>
      <Table.Td>{motivos.length === 0 ? '—' : motivos.join(' · ')}</Table.Td>
      <Table.Td>
        {desde}
        {entrada.desdeJobId !== null && entrada.desdeJobId !== jobId && (
          <Text span size="xs" c="dimmed">
            {' '}
            (de uma importação anterior)
          </Text>
        )}
      </Table.Td>
    </Table.Tr>
  );
}

/* -------------------------------------------------------------------------- */
/*                                   Shared                                    */
/* -------------------------------------------------------------------------- */

function Carregando({ texto }: { texto: string }) {
  return (
    <Group gap="xs">
      <Loader size="sm" />
      <Text size="sm" c="dimmed">
        {texto}
      </Text>
    </Group>
  );
}

function FalhaDeLeituraLi({
  leitura,
  descrever,
}: {
  leitura: { erro: unknown; consulta: RetryableQuery };
  descrever: (err: unknown) => { mensagem: string; repetivel: boolean };
}) {
  const falha = descrever(leitura.erro);
  const retry = queryRetry(leitura.consulta);
  return (
    <RetryAlert
      variant="compact"
      color="yellow"
      message={falha.mensagem}
      onRetry={falha.repetivel ? retry.retry : undefined}
      retrying={retry.retrying}
    />
  );
}
