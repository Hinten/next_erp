/**
 * The feed's PROCESSING REPORT reduced to what the core writes (step 12a, PR
 * 12-b), pure. Unwired in 12-b: the result handler (12-c) reads the report
 * with the package's `lerRelatorioProcessamentoListings` and hands it here.
 *
 * ## Attribution by `sku` ONLY
 *
 * The input document is never stored, so an issue's `messageId` (a position
 * in a document we no longer have) cannot be mapped back to a SKU — and for
 * the same reason the result handler has no list of the SKUs the feed sent,
 * hours after the send. An issue belongs to the SKU its own `sku` names, EXACTLY
 * as Amazon wrote it (no trim, no case fold); one whose `sku` is absent or empty
 * is feed-level: counted in `semSku` by severity, never attributed. Whether a
 * named SKU is one of the conta's is the provider's write-back to decide: a
 * SKU with no link of the conta has nowhere to be written.
 *
 * ## The link shape, bounded
 *
 * Each attributed issue becomes the link docs' issue shape,
 * `{ code, message, severity, attributeNames, categories: null }` (the report
 * names ONE `attributeName`; the link holds a list). At most
 * {@link MAX_PROBLEMAS_POR_SKU} per SKU, `ERROR` first, then `WARNING`, then
 * anything else, each in report order. Severities are compared EXACTLY.
 *
 * {@link skusParaGravar} keeps at most {@link MAX_SKUS_COM_PROBLEMA_GRAVADOS}
 * SKUs for the provider's write-back: those with an `ERROR` first, then the
 * rest, each in SKU order (code-unit order, never a locale's). The others are
 * only counted: a report with thousands of SKU errors is a systemic failure
 * the aviso shows, not something thousands of document writes fix.
 *
 * `codigos` (for the dispatch line) holds the distinct issue codes that match
 * a short token grammar, sorted, at most {@link MAX_CODIGOS_RELATORIO_FEED}:
 * never a message, never a SKU.
 */
import type { RelatorioProcessamentoListings } from '@delfrance/integrations-amazon-sp-api';
import type { ProblemasSemSkuFeedAmazon, ResultadoFeedAmazon } from '@delfrance/schemas';

/** The most issues kept per SKU. */
export const MAX_PROBLEMAS_POR_SKU = 10;

/** The most SKUs one report writes back; the rest are only counted. */
export const MAX_SKUS_COM_PROBLEMA_GRAVADOS = 200;

/** The most distinct issue codes a dispatch line names. */
export const MAX_CODIGOS_RELATORIO_FEED = 20;

/** An issue code the dispatch line may carry: a short token, never free text. */
const CODIGO_LOGAVEL = /^[A-Za-z0-9_.-]{1,32}$/;

/** The two severities the core counts, as Amazon spells them. */
export const SEVERIDADE_ISSUE_FEED = {
  erro: 'ERROR',
  aviso: 'WARNING',
} as const;

/** One report issue, as the package's tolerant schema reads it. */
type IssueRelatorioFeed = NonNullable<RelatorioProcessamentoListings['issues']>[number];

/** One attributed problem, in the link docs' issue shape. */
export interface ProblemaSku {
  readonly code: string | null;
  readonly message: string | null;
  readonly severity: string | null;
  readonly attributeNames: readonly string[] | null;
  readonly categories: null;
}

/** What one report reduces to. */
export interface ReducaoRelatorioFeed {
  /** The report's summary, as the record's `resultado`. */
  readonly resumo: ResultadoFeedAmazon;
  /** SKU → its problems (≤ {@link MAX_PROBLEMAS_POR_SKU}, `ERROR` first), for every SKU attributed one. */
  readonly porSku: ReadonlyMap<string, readonly ProblemaSku[]>;
  /** The feed-level issues, counted by severity. */
  readonly semSku: ProblemasSemSkuFeedAmazon;
  /** Distinct loggable issue codes, sorted, bounded. */
  readonly codigos: readonly string[];
}

/** `ERROR` 0, `WARNING` 1, anything else 2. */
function ordemDaSeveridade(severity: string | null | undefined): number {
  if (severity === SEVERIDADE_ISSUE_FEED.erro) return 0;
  if (severity === SEVERIDADE_ISSUE_FEED.aviso) return 1;
  return 2;
}

/** Code-unit order, never a locale's. */
function compararTexto(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function paraProblema(issue: IssueRelatorioFeed): ProblemaSku {
  return {
    code: issue.code ?? null,
    message: issue.message ?? null,
    severity: issue.severity ?? null,
    attributeNames: issue.attributeName ? [issue.attributeName] : null,
    categories: null,
  };
}

/** The report, reduced (module header). */
export function reduzirRelatorioFeed(
  relatorio: RelatorioProcessamentoListings,
): ReducaoRelatorioFeed {
  const agrupados = new Map<string, ProblemaSku[]>();
  const semSku = { erros: 0, avisos: 0 };
  const codigos = new Set<string>();

  for (const issue of relatorio.issues ?? []) {
    if (typeof issue.code === 'string' && CODIGO_LOGAVEL.test(issue.code)) codigos.add(issue.code);
    const sku = issue.sku;
    if (typeof sku === 'string' && sku !== '') {
      const lista = agrupados.get(sku);
      if (lista === undefined) agrupados.set(sku, [paraProblema(issue)]);
      else lista.push(paraProblema(issue));
      continue;
    }
    if (issue.severity === SEVERIDADE_ISSUE_FEED.erro) semSku.erros += 1;
    else if (issue.severity === SEVERIDADE_ISSUE_FEED.aviso) semSku.avisos += 1;
  }

  const porSku = new Map<string, readonly ProblemaSku[]>();
  for (const [sku, lista] of agrupados) {
    // A stable sort: report order within each severity.
    const ordenada = [...lista].sort(
      (a, b) => ordemDaSeveridade(a.severity) - ordemDaSeveridade(b.severity),
    );
    porSku.set(sku, ordenada.slice(0, MAX_PROBLEMAS_POR_SKU));
  }

  const { summary } = relatorio;
  return {
    resumo: {
      erros: summary.errors,
      avisos: summary.warnings,
      processadas: summary.messagesProcessed,
      aceitas: summary.messagesAccepted,
      invalidas: summary.messagesInvalid,
    },
    porSku,
    semSku,
    codigos: [...codigos].sort(compararTexto).slice(0, MAX_CODIGOS_RELATORIO_FEED),
  };
}

/** What {@link skusParaGravar} keeps, and how many it left out. */
export interface SkusParaGravarFeed {
  readonly problemas: ReadonlyMap<string, readonly ProblemaSku[]>;
  readonly omitidos: number;
}

/**
 * The SKUs written back (module header): at most
 * {@link MAX_SKUS_COM_PROBLEMA_GRAVADOS}, a SKU with an `ERROR` before one
 * without, then SKU order.
 */
export function skusParaGravar(
  porSku: ReadonlyMap<string, readonly ProblemaSku[]>,
): SkusParaGravarFeed {
  const ordemDoSku = (sku: string): number =>
    Math.min(...(porSku.get(sku) ?? []).map((p) => ordemDaSeveridade(p.severity)), 2);
  const ordenados = [...porSku.keys()].sort(
    (a, b) => ordemDoSku(a) - ordemDoSku(b) || compararTexto(a, b),
  );
  const mantidos = ordenados.slice(0, MAX_SKUS_COM_PROBLEMA_GRAVADOS);
  const problemas = new Map<string, readonly ProblemaSku[]>();
  for (const sku of mantidos) problemas.set(sku, porSku.get(sku) ?? []);
  return { problemas, omitidos: ordenados.length - mantidos.length };
}
