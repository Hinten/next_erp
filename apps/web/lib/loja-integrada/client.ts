'use client';

/**
 * `useLojaIntegradaClient()` — a memoized typed client bound to the current
 * Firebase auth state, talking to the `apps/loja-integrada` conta routes on their
 * own App Hosting backend. The shape of `useWhatsappClient`
 * (`lib/whatsapp/client.ts`): `null` while logged out, so the panel can disable
 * its buttons, and `() => user.getIdToken()` so a refreshed ID token propagates.
 *
 * Fourteen calls, one per route (`apps/loja-integrada/app/api/marketplace/loja-integrada/…`):
 *
 * | call | route | answer |
 * | --- | --- | --- |
 * | `conta(id)` | `GET …/conta/[id]` | `statusContaLojaIntegradaSchema` |
 * | `salvarCredencial(id, corpo)` | `PUT …/conta/[id]/credencial` | `respostaCredencialLojaIntegradaSchema` |
 * | `renovarValidade(id, corpo)` | `PUT …/conta/[id]/credencial/validade` | `respostaCredencialLojaIntegradaSchema` |
 * | `removerCredencial(id)` | `DELETE …/conta/[id]/credencial` | `respostaRemocaoCredencialLiSchema` |
 * | `grades(id, opcoes)` | `GET …/conta/[id]/grades` | `respostaGradesLiSchema` |
 * | `grade(id, gradeId, opcoes)` | `GET …/conta/[id]/grades/[gradeId]` | `respostaGradeLiSchema` |
 * | `iniciarImportacao(id, opcoes)` | `POST …/conta/[id]/importacoes` | `respostaInicioImportacaoLiSchema` |
 * | `importacoes(id, opcoes)` | `GET …/conta/[id]/importacoes` | `respostaImportacoesLiSchema` |
 * | `importacao(id, jobId, opcoes)` | `GET …/conta/[id]/importacoes/[jobId]` | `respostaImportacaoLiSchema` |
 * | `cancelarImportacao(id, jobId)` | `POST …/conta/[id]/importacoes/[jobId]/cancelar` | `respostaImportacaoLiSchema` |
 * | `itensImportacao(id, jobId, depois, opcoes)` | `GET …/conta/[id]/importacoes/[jobId]/itens` | `respostaItensImportacaoLiSchema` |
 * | `revisaoImportacao(id, jobId, depois, opcoes)` | `GET …/conta/[id]/importacoes/[jobId]/revisao` | `respostaRevisaoFiscalLiSchema` |
 * | `rotearEtiqueta(pedidoId, corpo)` | `PUT …/pedidos/[pedidoId]/rota-etiqueta` | `respostaRotaEtiquetaLiSchema` |
 * | `conferirPagamento(pedidoId, opcoes)` | `GET …/pedidos/[pedidoId]/pagamento` | `respostaConferenciaPagamentoLiSchema` |
 *
 * Every answer — the 2xx bodies AND the error envelope — is read against the ONE
 * shared contract in `@delfrance/schemas` (`contaLojaIntegrada.ts`,
 * `catalogoLojaIntegrada.ts`, `importacaoLojaIntegrada.ts`,
 * `rotaEtiquetaLojaIntegrada.ts`, `conferenciaPagamentoLojaIntegrada.ts`), the
 * same modules the routes build their answers with. Nothing here is cast.
 *
 * ## The two catalogue reads (master plan step 10)
 *
 * The variation linker's grade list and one grade's options. Both are READS
 * behind the backend's switch and its 15-minute cache, each bounded by its own
 * deadline ({@link PRAZO_CATALOGO_LI_MS}, {@link PRAZO_GRADE_LI_MS}) and by the
 * caller's signal (a cancelled query). `atualizar: true` asks the backend for a
 * fresh read (`?atualizar=1`). A backend older than these routes answers 404
 * without the envelope — an HTTP error with no `code`, which the linker reads as
 * "not offered yet".
 *
 * ## The product import (master plan step 9)
 *
 * Six calls over one job document per run: start one, list the conta's newest,
 * read one (the progress card polls it), cancel one, and page through its
 * report and its tax-review list. NONE of these routes calls Loja Integrada —
 * the start only creates the job, and the backend's queue does the reading — so
 * every call shares one short deadline, {@link PRAZO_IMPORTACAO_LI_MS}, and the
 * reads also honour the caller's signal (a cancelled query).
 *
 * - The start body is rebuilt by name and parsed through the shared strict
 *   schema before it is sent ({@link corpoInicioImportacaoLi}): under "só
 *   vincular" the category and photo options are sent at their defaults, which
 *   is the only value the backend accepts there.
 * - A conta that already runs an import answers 409
 *   `LI_IMPORTACAO_EM_ANDAMENTO` naming the running job: the error keeps that id
 *   ({@link LojaIntegradaClientHttpError.jobId}), so the screen attaches to the
 *   job instead of reporting a failure.
 * - A backend older than these routes answers the reads with a 404 WITHOUT the
 *   envelope: an HTTP error with no `code`, which the screen reads as "this
 *   backend does not offer the import yet" — never as "job not found", which
 *   always carries `LI_IMPORTACAO_NAO_ENCONTRADA`. Such a backend's CORS
 *   preflight does not allow `POST` either, so its start fails as a network
 *   error in the browser; the list read is where the screen finds out.
 *
 * ## The two pedidos routes (master plan step 15)
 *
 * Neither reaches Loja Integrada from here: the browser only ever talks to the
 * deployed `apps/loja-integrada` backend, which decides whether anything goes
 * further. Both carry a DEADLINE, unlike the conta routes:
 *
 * - `rotearEtiqueta` — {@link PRAZO_ROTA_ETIQUETA_LI_MS}. The route makes no
 *   call to Loja Integrada (ERP reads plus one guarded pedido write), and it is
 *   idempotent: a re-click after a timeout answers `ja-roteado`, so giving up
 *   early can never route a pedido twice.
 * - `conferirPagamento` — {@link PRAZO_CONFERENCIA_PAGAMENTO_LI_MS}, a read: a
 *   timeout is "não verificável", the gates' own answer for a backend that
 *   cannot say. The caller's `sinal` is honoured too.
 *
 * A deadline that fires (the catalogue reads', the import calls' or these two)
 * is a {@link LojaIntegradaClientTempoEsgotadoError} — a SUBCLASS of the network
 * error, so a catch written for the network still catches it. An abort the
 * CALLER asked for comes back as the abort itself. The deadlines:
 *
 * | constant | calls | why that long |
 * | --- | --- | --- |
 * | {@link PRAZO_CATALOGO_LI_MS} | `grades` | every page the route may read, paced |
 * | {@link PRAZO_GRADE_LI_MS} | `grade` | one paced read |
 * | {@link PRAZO_IMPORTACAO_LI_MS} | the six import calls | no Loja Integrada call: a cold start |
 * | {@link PRAZO_ROTA_ETIQUETA_LI_MS} | `rotearEtiqueta` | no Loja Integrada call: a cold start |
 * | {@link PRAZO_CONFERENCIA_PAGAMENTO_LI_MS} | `conferirPagamento` | one paced read |
 *
 * The conta routes have none.
 *
 * ## The Personal Token
 *
 * It travels exactly once, in the JSON BODY of the save `PUT`, and nowhere else:
 * never in a URL (the conta id is the only path segment, percent-encoded), never
 * in an error message, never in a log line. The status route never returns it.
 * A request that carried it never logs its response body either — a misbehaving
 * proxy that echoed the request would otherwise put the token on the console.
 *
 * ## Fail closed: an `https:` page never sends to an `http:` backend
 *
 * Every channel client falls back to its `localhost` port when its
 * `NEXT_PUBLIC_*_URL` is missing from a build. For this one the fallback would
 * carry a store's live token in a plain-http body, so {@link resolverBackendLojaIntegrada}
 * refuses that combination and the panel says the backend is not configured. It
 * deliberately keys on the PAGE's protocol rather than on `NODE_ENV`: CI's e2e
 * serves a production build over plain http with no `NEXT_PUBLIC_*_URL` set, and
 * its stubbed-backend cases must keep working.
 *
 * ⚠️ This client retries NOTHING, and the conta query does not either
 * (`retry: false` in the panel): a save is a validation against Loja Integrada,
 * and repeating one is the operator's decision.
 */
import { useMemo } from 'react';
import type { z } from 'zod';
import {
  ACAO_IMPORTACAO_LI,
  type CorpoRenovarValidadeLi,
  type CorpoRotaEtiquetaLi,
  type CorpoSalvarCredencialLi,
  OPCOES_IMPORTACAO_LI_PADRAO,
  type OpcoesImportacaoLi,
  type RespostaConferenciaPagamentoLi,
  type RespostaCredencialLojaIntegrada,
  type RespostaGradeLi,
  type RespostaGradesLi,
  type RespostaImportacaoLi,
  type RespostaImportacoesLi,
  type RespostaInicioImportacaoLi,
  type RespostaItensImportacaoLi,
  type RespostaRemocaoCredencialLi,
  type RespostaRevisaoFiscalLi,
  type RespostaRotaEtiquetaLi,
  type StatusContaLojaIntegrada,
  erroContaLojaIntegradaSchema,
  opcoesImportacaoLiSchema,
  respostaConferenciaPagamentoLiSchema,
  respostaCredencialLojaIntegradaSchema,
  respostaGradeLiSchema,
  respostaGradesLiSchema,
  respostaImportacaoLiSchema,
  respostaImportacoesLiSchema,
  respostaInicioImportacaoLiSchema,
  respostaItensImportacaoLiSchema,
  respostaRemocaoCredencialLiSchema,
  respostaRevisaoFiscalLiSchema,
  respostaRotaEtiquetaLiSchema,
  statusContaLojaIntegradaSchema,
} from '@delfrance/schemas';
import { lerRespostaJson, resumirCampos } from '@delfrance/core/wire';

import { useAuth } from '@/lib/auth/useAuth';

/** The local dev port of `apps/loja-integrada` (root `CLAUDE.md`, Layout). */
export const DEFAULT_LOJA_INTEGRADA_URL = 'http://localhost:3010';

/** Every conta route hangs off this prefix (`apps/loja-integrada/proxy.ts` allows `/api/marketplace/*`). */
const CONTA_PATH = '/api/marketplace/loja-integrada/conta';

/** The pedidos route family (master plan step 15): label routing and the paid re-check. */
const PEDIDOS_PATH = '/api/marketplace/loja-integrada/pedidos';

/**
 * How long the label routing call may take, in ms. The route reads the ERP and
 * writes the pedido once (up to three attempts on a lost race), and calls
 * nothing outside — so this only has to cover a cold start of the
 * scale-to-zero backend plus the CORS preflight. A timeout is safe to retry: the
 * route is idempotent, and a second call on a routed pedido answers
 * `ja-roteado` without writing.
 */
export const PRAZO_ROTA_ETIQUETA_LI_MS = 30_000;

/**
 * How long the paid re-check may take, in ms: a cold start, the backend's 2 s
 * pacer before the one Loja Integrada read, that read's own 20 s deadline, and
 * margin. A READ: when it fires, the gates read the outcome as "não
 * verificável", never as a verdict.
 */
export const PRAZO_CONFERENCIA_PAGAMENTO_LI_MS = 45_000;

/**
 * How long the grade LIST may take, in ms: the route's own worst case — every
 * page it may read (`MAX_PAGINAS_CATALOGO_LI`), each the 2 s pacer plus its 20 s
 * deadline, plus its margin: 250 s — and 10 s of slack for a cold start. A list
 * normally answers in a few seconds (one page, or the backend's cached copy).
 */
export const PRAZO_CATALOGO_LI_MS = 260_000;

/**
 * How long ONE grade's options may take, in ms: one paced call (2 s), its 20 s
 * deadline, and 30 s of margin for a cold start.
 */
export const PRAZO_GRADE_LI_MS = 60_000;

/**
 * How long each product-import call may take, in ms. None of the six routes
 * calls Loja Integrada (the start creates the job document; the backend's queue
 * does the reading), so this only has to cover a cold start of the
 * scale-to-zero backend, the CORS preflight and a few Firestore reads. A start
 * that times out is safe to repeat: if the first one did create the job, the
 * second answers 409 with its id, and the screen attaches to it.
 */
export const PRAZO_IMPORTACAO_LI_MS = 30_000;

/** Optional detail an error envelope may carry beyond `error` and `code`. */
export interface DetalhesErroLojaIntegrada {
  /** Field PATHS the backend blamed (`issues`), never values. */
  readonly campos?: readonly string[];
  /** The HTTP status Loja Integrada answered a validation with, when there was one. */
  readonly statusLi?: number | null;
  /** The validation call's correlation id, for support. */
  readonly correlationId?: string | null;
  /** The RUNNING product import a busy start named (`LI_IMPORTACAO_EM_ANDAMENTO` only). */
  readonly jobId?: string | null;
}

/** Non-2xx response from the `apps/loja-integrada` backend. */
export class LojaIntegradaClientHttpError extends Error {
  /** Field PATHS only (`issues` on the envelope, or the 2xx paths that failed). */
  readonly campos: readonly string[];
  /** The HTTP status Loja Integrada answered a validation with (`status` on the envelope). */
  readonly statusLi: number | null;
  readonly correlationId: string | null;
  /**
   * The envelope's `jobId`, as the shared envelope schema read it: a string or
   * `null`, nothing else. Only `LI_IMPORTACAO_EM_ANDAMENTO` carries one; read it
   * through `jobIdDaImportacaoEmAndamentoLi` (`importacao.ts`), which also checks
   * the code and the id's grammar.
   */
  readonly jobId: string | null;

  constructor(
    message: string,
    readonly status: number,
    /**
     * The backend's machine code (`CODIGO_ERRO_LI`, or `RESPOSTA_INVALIDA` from
     * the subclass). A plain string: a code a newer backend adds must still
     * reach the caller. ⚠️ Key copy on THIS, never on `status` alone — a 422 is
     * either "Loja Integrada refused the token" or "malformed, never sent".
     */
    readonly code: string | null,
    detalhes: DetalhesErroLojaIntegrada = {},
  ) {
    super(message);
    this.name = 'LojaIntegradaClientHttpError';
    this.campos = detalhes.campos ?? [];
    this.statusLi = detalhes.statusLi ?? null;
    this.correlationId = detalhes.correlationId ?? null;
    this.jobId = detalhes.jobId ?? null;
  }
}

/**
 * The backend answered 2xx and the body was not the shape this app claims — the
 * wrong fields, no body at all, or not JSON.
 *
 * ⚠️ A SUBCLASS of {@link LojaIntegradaClientHttpError}, matching the sibling
 * clients: catch sites narrow to that class and rethrow anything else, so a
 * sibling class would land as an unhandled rejection instead of a message.
 * `code === 'RESPOSTA_INVALIDA'` is what tells the two apart. Narrow it FIRST.
 */
export class LojaIntegradaClientRespostaInvalidaError extends LojaIntegradaClientHttpError {
  constructor(
    message: string,
    /** The real 2xx the backend sent — never a hardcoded 200. */
    status: number,
    /** Field PATHS that failed, never values. */
    campos: readonly string[],
  ) {
    super(message, status, 'RESPOSTA_INVALIDA', { campos });
    this.name = 'LojaIntegradaClientRespostaInvalidaError';
  }
}

/**
 * Network-level failure reaching the backend (or reading its body).
 *
 * ⚠️ The message is a FIXED sentence: the transport's own text stays on
 * `cause`, so nothing a runtime chose to put in it can reach the operator's
 * screen or a log through `err.message`.
 */
export class LojaIntegradaClientNetworkError extends Error {
  constructor(override readonly cause?: unknown) {
    super('Falha de rede ao contatar o backend da Loja Integrada.');
    this.name = 'LojaIntegradaClientNetworkError';
  }
}

/**
 * A bounded route did not answer within its deadline (the table in the header:
 * the catalogue reads, the import calls and the two pedidos routes).
 *
 * ⚠️ A SUBCLASS of {@link LojaIntegradaClientNetworkError}: as far as a caller
 * that only knows "the network failed" is concerned, it did. Narrow it FIRST
 * where the two need different copy. The message is fixed, like its parent's.
 */
export class LojaIntegradaClientTempoEsgotadoError extends LojaIntegradaClientNetworkError {
  constructor(cause?: unknown) {
    super(cause);
    this.message = 'O backend da Loja Integrada não respondeu a tempo.';
    this.name = 'LojaIntegradaClientTempoEsgotadoError';
  }
}

/** Options of the paid re-check call. */
export interface OpcoesConferenciaPagamentoLi {
  /**
   * Aborts the call (a dialog the operator closed). The abort comes back as
   * the abort itself — the caller already knows it asked for it.
   */
  readonly sinal?: AbortSignal;
}

/** Options of the two catalogue reads. */
export interface OpcoesCatalogoLi {
  /**
   * Ask the backend for a FRESH read (`?atualizar=1`): its cached copy is
   * evicted first. The operator's "Atualizar", never a background refresh.
   */
  readonly atualizar?: boolean;
  /** Aborts the call (a cancelled query); the abort comes back as itself. */
  readonly sinal?: AbortSignal;
}

/** Options of the four import READS (the list, one job, its report, its tax-review list). */
export interface OpcoesLeituraImportacaoLi {
  /** Aborts the call (a cancelled query); the abort comes back as itself. */
  readonly sinal?: AbortSignal;
}

/**
 * The start options as a caller builds them: `modo`, `alvo` and `acao` always,
 * the rest optional (the shared schema's INPUT, so its defaults apply).
 */
export type EntradaOpcoesImportacaoLi = z.input<typeof opcoesImportacaoLiSchema>;

/**
 * The start body exactly as sent: rebuilt BY NAME (the route's body is strict,
 * so a caller object carrying one more key must not reach it) and parsed through
 * the shared {@link opcoesImportacaoLiSchema}, so every default is explicit and
 * a contradictory body never leaves the browser.
 *
 * Under `acao: soVincular` the category and photo options are sent at their
 * DEFAULTS whatever the caller held: they mean something under `completar`
 * only, the start dialog disables them there, and the backend refuses any other
 * value as contradictory. A dialog that switched from "Completar" back to "Só
 * vincular" still holds its last picks; they are not the operator's intent for
 * this run.
 *
 * ⚠️ Throws `ZodError` for a body the schema refuses even so — a selection
 * outside `alvo: selecionados`, `selecionados` with no id or past
 * `MAX_SELECIONADOS_LI`, a malformed `simulacaoId`. That is a bug in the caller,
 * which must never offer such a body, so it is not one of this client's error
 * classes: it reaches the caller's catch as itself (root `CLAUDE.md` rule 6).
 */
export function corpoInicioImportacaoLi(opcoes: EntradaOpcoesImportacaoLi): OpcoesImportacaoLi {
  const soVincular = opcoes.acao === ACAO_IMPORTACAO_LI.soVincular;
  return opcoesImportacaoLiSchema.parse({
    modo: opcoes.modo,
    alvo: opcoes.alvo,
    acao: opcoes.acao,
    categorias: soVincular ? OPCOES_IMPORTACAO_LI_PADRAO.categorias : opcoes.categorias,
    fotos: soVincular ? OPCOES_IMPORTACAO_LI_PADRAO.fotos : opcoes.fotos,
    selecionados: opcoes.selecionados,
    simulacaoId: opcoes.simulacaoId,
  });
}

export interface LojaIntegradaClient {
  /** The conta's credential status (`PERM.integracao.read`). Never the token. */
  conta(integracaoId: string): Promise<StatusContaLojaIntegrada>;
  /**
   * The store's grades, its own and the platform's (`PERM.integracao.read`).
   * Bounded by {@link PRAZO_CATALOGO_LI_MS}.
   */
  grades(integracaoId: string, opcoes?: OpcoesCatalogoLi): Promise<RespostaGradesLi>;
  /**
   * One grade and the options it offers (`PERM.integracao.read`). Bounded by
   * {@link PRAZO_GRADE_LI_MS}.
   */
  grade(integracaoId: string, gradeId: number, opcoes?: OpcoesCatalogoLi): Promise<RespostaGradeLi>;
  /**
   * Validate a Personal Token against Loja Integrada and store it
   * (`PERM.integracao.write`). The body is sent exactly as given, rebuilt by
   * name — `credencialForm.ts` trims the token and supplies `versaoEsperada`.
   */
  salvarCredencial(
    integracaoId: string,
    corpo: CorpoSalvarCredencialLi,
  ): Promise<RespostaCredencialLojaIntegrada>;
  /** Re-validate the STORED token and store a new expiry date (`PERM.integracao.write`). */
  renovarValidade(
    integracaoId: string,
    corpo: CorpoRenovarValidadeLi,
  ): Promise<RespostaCredencialLojaIntegrada>;
  /** Remove the stored token — idempotent and unconditional (`PERM.integracao.write`). */
  removerCredencial(integracaoId: string): Promise<RespostaRemocaoCredencialLi>;
  /**
   * Start a product import for the conta (`PERM.integracao.write`): 202 with the
   * new job's id. The body is {@link corpoInicioImportacaoLi}'s. A conta already
   * running one rejects with `LI_IMPORTACAO_EM_ANDAMENTO` and that job's
   * `jobId`; the read switch off (every environment until the migration)
   * rejects with `LI_CHAMADAS_DESLIGADAS`, and no job exists. Bounded by
   * {@link PRAZO_IMPORTACAO_LI_MS}.
   */
  iniciarImportacao(
    integracaoId: string,
    opcoes: EntradaOpcoesImportacaoLi,
  ): Promise<RespostaInicioImportacaoLi>;
  /**
   * The conta's newest imports, newest first (`PERM.integracao.read`). Works
   * with the read switch off. Bounded by {@link PRAZO_IMPORTACAO_LI_MS}.
   */
  importacoes(
    integracaoId: string,
    opcoes?: OpcoesLeituraImportacaoLi,
  ): Promise<RespostaImportacoesLi>;
  /**
   * One import's status, what the progress card polls (`PERM.integracao.read`).
   * Bounded by {@link PRAZO_IMPORTACAO_LI_MS}.
   */
  importacao(
    integracaoId: string,
    jobId: string,
    opcoes?: OpcoesLeituraImportacaoLi,
  ): Promise<RespostaImportacaoLi>;
  /**
   * Stop an import (`PERM.integracao.write`); answers the job as written. An
   * ended job rejects with `LI_IMPORTACAO_ENCERRADA`; a job that kept writing its
   * progress over every attempt rejects with `LI_IMPORTACAO_EM_CONFLITO` (still
   * running: try again). Bounded by {@link PRAZO_IMPORTACAO_LI_MS}.
   */
  cancelarImportacao(integracaoId: string, jobId: string): Promise<RespostaImportacaoLi>;
  /**
   * One page of an import's report after `depois` (`PERM.integracao.read`);
   * `null`, `undefined` or `''` = the first page. The answer's `proximo` is the
   * next page's `depois`, `null` on the last. Bounded by
   * {@link PRAZO_IMPORTACAO_LI_MS}.
   */
  itensImportacao(
    integracaoId: string,
    jobId: string,
    depois?: string | null,
    opcoes?: OpcoesLeituraImportacaoLi,
  ): Promise<RespostaItensImportacaoLi>;
  /**
   * An import's tax-review list (`PERM.integracao.read`), paged like the report
   * — though today's backend answers the whole list at once (`proximo: null`).
   * Bounded by {@link PRAZO_IMPORTACAO_LI_MS}.
   */
  revisaoImportacao(
    integracaoId: string,
    jobId: string,
    depois?: string | null,
    opcoes?: OpcoesLeituraImportacaoLi,
  ): Promise<RespostaRevisaoFiscalLi>;
  /**
   * Route a pedido still on its conta's Loja Integrada freight doc to its label
   * target (`PERM.frete.write`): `escolha` is the operator's pick, `null` lets the
   * stored override or the conta's `mapa` decide. A refusal is a 200
   * (`tipo: 'recusado'`), never an error. Bounded by
   * {@link PRAZO_ROTA_ETIQUETA_LI_MS}.
   */
  rotearEtiqueta(pedidoId: string, corpo: CorpoRotaEtiquetaLi): Promise<RespostaRotaEtiquetaLi>;
  /**
   * The paid re-check of one pedido (`PERM.pedido.read`): the order's current
   * Loja Integrada situação as a verdict, the ERP's contested mirror when it
   * cannot be read, or `aplicavel: false` for a pedido that is not an imported
   * order. Bounded by {@link PRAZO_CONFERENCIA_PAGAMENTO_LI_MS}.
   */
  conferirPagamento(
    pedidoId: string,
    opcoes?: OpcoesConferenciaPagamentoLi,
  ): Promise<RespostaConferenciaPagamentoLi>;
}

/**
 * What to say when the backend answered a non-2xx WITHOUT our JSON envelope —
 * the request never reached one of the conta routes (a proxy page, a platform
 * timeout, a backend without these routes).
 */
export function mensagemHttpLojaIntegrada(status: number): string {
  if (status === 401 || status === 403) {
    return 'Sem permissão para esta operação no backend da Loja Integrada.';
  }
  if (status === 404) {
    return (
      `O backend da Loja Integrada não respondeu por esta rota (HTTP ${String(status)}). ` +
      'Atualize a página e, se continuar, avise o suporte.'
    );
  }
  if (status >= 500) {
    return `O backend da Loja Integrada falhou (HTTP ${String(status)}). Tente novamente em instantes.`;
  }
  return `Falha na comunicação com o backend da Loja Integrada (HTTP ${String(status)}).`;
}

/** What a body read may log: the text, or a marker when the request carried the token. */
function corpoParaLog(texto: string, levouToken: boolean): string {
  if (levouToken) {
    return `(corpo omitido: a requisição levava o token; ${String(texto.length)} caracteres)`;
  }
  return texto.length === 0 ? '(corpo vazio)' : texto.slice(0, 500);
}

function logarCorpoNaoJson(path: string, status: number, corpo: string): void {
  console.error(`[loja-integrada] resposta não-JSON em ${path} (HTTP ${String(status)})`, corpo);
}

/** Who aborted a bounded call, read when a transport step rejects. */
interface Interrupcao {
  /** Our own deadline fired. */
  readonly estourou: () => boolean;
  /** The caller's signal aborted. */
  readonly cancelada: () => boolean;
}

const SEM_INTERRUPCAO: Interrupcao = { estourou: () => false, cancelada: () => false };

/**
 * Read the body, turning a socket that drops MID-BODY into a network error: a
 * bare `TypeError` there would sail past every `instanceof` in the panel.
 *
 * A bounded call's abort rejects the body read too, with the abort itself (an
 * `AbortError`, not a `TypeError`): our deadline becomes the
 * {@link LojaIntegradaClientTempoEsgotadoError} the caller narrows on, and the
 * caller's own abort comes back untouched.
 */
async function lerCorpo(res: Response, interrupcao: Interrupcao): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    if (interrupcao.estourou()) throw new LojaIntegradaClientTempoEsgotadoError(err);
    if (interrupcao.cancelada()) throw err;
    if (err instanceof TypeError) throw new LojaIntegradaClientNetworkError(err);
    throw err;
  }
}

/**
 * The deadline and the caller's signal folded into ONE signal for `fetch`, plus
 * who fired it. `null` when the call is unbounded (the conta routes), so those
 * keep sending no signal at all. `encerrar()` must run however the call ends:
 * it clears the timer and unhooks the caller's signal.
 */
function controlarChamada(
  prazoMs: number | undefined,
  sinal: AbortSignal | undefined,
): {
  readonly sinal: AbortSignal;
  readonly interrupcao: Interrupcao;
  readonly encerrar: () => void;
} | null {
  if (prazoMs === undefined && sinal === undefined) return null;
  const controle = new AbortController();
  let estourou = false;
  const repassar = () => controle.abort(sinal?.reason);
  if (sinal?.aborted === true) repassar();
  else sinal?.addEventListener('abort', repassar, { once: true });
  const prazo =
    prazoMs === undefined
      ? undefined
      : setTimeout(() => {
          estourou = true;
          controle.abort();
        }, prazoMs);
  return {
    sinal: controle.signal,
    interrupcao: {
      estourou: () => estourou,
      cancelada: () => !estourou && sinal?.aborted === true,
    },
    encerrar: () => {
      if (prazo !== undefined) clearTimeout(prazo);
      sinal?.removeEventListener('abort', repassar);
    },
  };
}

/** A non-2xx body, read as the shared error envelope. */
function erroHttp(path: string, status: number, texto: string, levouToken: boolean): Error {
  const leitura = lerRespostaJson(texto, erroContaLojaIntegradaSchema);
  if (leitura.ok) {
    const env = leitura.data;
    return new LojaIntegradaClientHttpError(env.error, status, env.code, {
      campos: env.issues ?? [],
      statusLi: env.status ?? null,
      correlationId: env.correlationId ?? null,
      jobId: env.jobId ?? null,
    });
  }
  // Not our envelope: the request never reached a conta route that answers one.
  // The body stays on the console (unless the request carried the token) and
  // NEVER in `err.message` — a proxy's whole HTML page would bury the cause.
  if (leitura.motivo === 'nao-json') {
    logarCorpoNaoJson(path, status, corpoParaLog(leitura.texto, levouToken));
  }
  return new LojaIntegradaClientHttpError(mensagemHttpLojaIntegrada(status), status, null);
}

/** A 2xx body read against its schema, or the one error each failure earns. */
function lerCorpoJson<S extends z.ZodType>(
  path: string,
  status: number,
  texto: string,
  schema: S,
  levouToken: boolean,
): z.infer<S> {
  const leitura = lerRespostaJson(texto, schema);
  if (leitura.ok) return leitura.data;

  if (leitura.motivo !== 'formato') {
    // EMPTY and NON-JSON share this branch: neither is version skew — in both
    // the request failed to reach a route that answers JSON, so neither may
    // tell the operator to deploy anything.
    logarCorpoNaoJson(
      path,
      status,
      leitura.motivo === 'nao-json' ? corpoParaLog(leitura.texto, levouToken) : '(corpo vazio)',
    );
    throw new LojaIntegradaClientRespostaInvalidaError(
      `O backend da Loja Integrada respondeu HTTP ${String(status)} sem um corpo JSON — ` +
        'o pedido não chegou à rota esperada. Atualize a página e, se continuar, avise o suporte.',
      status,
      [],
    );
  }

  throw new LojaIntegradaClientRespostaInvalidaError(
    'O backend da Loja Integrada respondeu num formato que este aplicativo não reconhece. ' +
      `Campos inválidos: ${resumirCampos(leitura.campos)}. Normalmente isso significa que o ` +
      'backend e esta tela estão em versões diferentes — faça o deploy de `apps/loja-integrada` ' +
      'e recarregue a página.',
    status,
    leitura.campos,
  );
}

export function createLojaIntegradaClient(config: {
  baseUrl: string;
  getAuthToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
}): LojaIntegradaClient {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const doFetch = config.fetch ?? globalThis.fetch;

  /**
   * One JSON round trip.
   *
   * ⚠️ `getAuthToken()` stays OUTSIDE the try: a token failure is a
   * `FirebaseError`, not a transport failure, and relabelling it a network
   * error would send the operator to check a connection that is fine.
   */
  async function call<S extends z.ZodType>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    schema: S,
    corpo?: Readonly<Record<string, unknown>>,
    limites?: { readonly prazoMs?: number; readonly sinal?: AbortSignal },
  ): Promise<z.infer<S>> {
    const idToken = await config.getAuthToken();
    const levouToken = corpo !== undefined && 'token' in corpo;
    // Started AFTER the token, so a slow session refresh never eats the
    // route's budget — and never turns into a "tempo esgotado".
    const controle = controlarChamada(limites?.prazoMs, limites?.sinal);
    const interrupcao = controle?.interrupcao ?? SEM_INTERRUPCAO;
    try {
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${idToken}`,
            Accept: 'application/json',
            ...(corpo === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
          ...(controle === null ? {} : { signal: controle.sinal }),
        });
      } catch (err) {
        if (interrupcao.estourou()) throw new LojaIntegradaClientTempoEsgotadoError(err);
        if (interrupcao.cancelada()) throw err;
        // `cause` keeps the transport's own error for a debugger; the message is
        // fixed (see the class).
        throw new LojaIntegradaClientNetworkError(err);
      }

      const texto = await lerCorpo(res, interrupcao);
      if (!res.ok) throw erroHttp(path, res.status, texto, levouToken);
      return lerCorpoJson(path, res.status, texto, schema, levouToken);
    } finally {
      controle?.encerrar();
    }
  }

  const caminhoDaConta = (integracaoId: string) =>
    `${CONTA_PATH}/${encodeURIComponent(integracaoId)}`;
  const caminhoDoPedido = (pedidoId: string) => `${PEDIDOS_PATH}/${encodeURIComponent(pedidoId)}`;
  /** The fresh-read flag, spelled exactly as the route reads it. */
  const consultaDoCatalogo = (opcoes: OpcoesCatalogoLi | undefined) =>
    opcoes?.atualizar === true ? '?atualizar=1' : '';
  /** A read's deadline plus the caller's signal, when it gave one. */
  const limitesComSinal = (prazoMs: number, opcoes: OpcoesLeituraImportacaoLi | undefined) => ({
    prazoMs,
    ...(opcoes?.sinal === undefined ? {} : { sinal: opcoes.sinal }),
  });
  const caminhoDaImportacao = (integracaoId: string, jobId: string) =>
    `${caminhoDaConta(integracaoId)}/importacoes/${encodeURIComponent(jobId)}`;
  /** A page cursor, spelled as the routes read it: absent for the first page. */
  const consultaDaPagina = (depois: string | null | undefined) =>
    depois === undefined || depois === null || depois === ''
      ? ''
      : `?depois=${encodeURIComponent(depois)}`;

  return {
    conta: (integracaoId) =>
      call('GET', caminhoDaConta(integracaoId), statusContaLojaIntegradaSchema),
    grades: (integracaoId, opcoes) =>
      call(
        'GET',
        `${caminhoDaConta(integracaoId)}/grades${consultaDoCatalogo(opcoes)}`,
        respostaGradesLiSchema,
        undefined,
        limitesComSinal(PRAZO_CATALOGO_LI_MS, opcoes),
      ),
    grade: (integracaoId, gradeId, opcoes) =>
      call(
        'GET',
        `${caminhoDaConta(integracaoId)}/grades/${encodeURIComponent(String(gradeId))}` +
          consultaDoCatalogo(opcoes),
        respostaGradeLiSchema,
        undefined,
        limitesComSinal(PRAZO_GRADE_LI_MS, opcoes),
      ),
    // Both bodies are rebuilt BY NAME: the routes' schemas are strict (an
    // unknown key is a 400), so a caller object carrying one more field must
    // not reach them.
    salvarCredencial: (integracaoId, corpo) =>
      call(
        'PUT',
        `${caminhoDaConta(integracaoId)}/credencial`,
        respostaCredencialLojaIntegradaSchema,
        { token: corpo.token, expiraEm: corpo.expiraEm, versaoEsperada: corpo.versaoEsperada },
      ),
    renovarValidade: (integracaoId, corpo) =>
      call(
        'PUT',
        `${caminhoDaConta(integracaoId)}/credencial/validade`,
        respostaCredencialLojaIntegradaSchema,
        { expiraEm: corpo.expiraEm, versaoEsperada: corpo.versaoEsperada },
      ),
    removerCredencial: (integracaoId) =>
      call(
        'DELETE',
        `${caminhoDaConta(integracaoId)}/credencial`,
        respostaRemocaoCredencialLiSchema,
      ),
    // The body is parsed BEFORE the token is asked for, so a contradictory body
    // throws with no request at all.
    iniciarImportacao: async (integracaoId, opcoes) => {
      const corpo = corpoInicioImportacaoLi(opcoes);
      return call(
        'POST',
        `${caminhoDaConta(integracaoId)}/importacoes`,
        respostaInicioImportacaoLiSchema,
        corpo,
        { prazoMs: PRAZO_IMPORTACAO_LI_MS },
      );
    },
    importacoes: (integracaoId, opcoes) =>
      call(
        'GET',
        `${caminhoDaConta(integracaoId)}/importacoes`,
        respostaImportacoesLiSchema,
        undefined,
        limitesComSinal(PRAZO_IMPORTACAO_LI_MS, opcoes),
      ),
    importacao: (integracaoId, jobId, opcoes) =>
      call(
        'GET',
        caminhoDaImportacao(integracaoId, jobId),
        respostaImportacaoLiSchema,
        undefined,
        limitesComSinal(PRAZO_IMPORTACAO_LI_MS, opcoes),
      ),
    // No body: the route reads none.
    cancelarImportacao: (integracaoId, jobId) =>
      call(
        'POST',
        `${caminhoDaImportacao(integracaoId, jobId)}/cancelar`,
        respostaImportacaoLiSchema,
        undefined,
        { prazoMs: PRAZO_IMPORTACAO_LI_MS },
      ),
    itensImportacao: (integracaoId, jobId, depois, opcoes) =>
      call(
        'GET',
        `${caminhoDaImportacao(integracaoId, jobId)}/itens${consultaDaPagina(depois)}`,
        respostaItensImportacaoLiSchema,
        undefined,
        limitesComSinal(PRAZO_IMPORTACAO_LI_MS, opcoes),
      ),
    revisaoImportacao: (integracaoId, jobId, depois, opcoes) =>
      call(
        'GET',
        `${caminhoDaImportacao(integracaoId, jobId)}/revisao${consultaDaPagina(depois)}`,
        respostaRevisaoFiscalLiSchema,
        undefined,
        limitesComSinal(PRAZO_IMPORTACAO_LI_MS, opcoes),
      ),
    // Rebuilt BY NAME for the same reason as the credential bodies: the
    // route's body schema is strict.
    rotearEtiqueta: (pedidoId, corpo) =>
      call(
        'PUT',
        `${caminhoDoPedido(pedidoId)}/rota-etiqueta`,
        respostaRotaEtiquetaLiSchema,
        { escolha: corpo.escolha },
        { prazoMs: PRAZO_ROTA_ETIQUETA_LI_MS },
      ),
    conferirPagamento: (pedidoId, opcoes) =>
      call(
        'GET',
        `${caminhoDoPedido(pedidoId)}/pagamento`,
        respostaConferenciaPagamentoLiSchema,
        undefined,
        {
          prazoMs: PRAZO_CONFERENCIA_PAGAMENTO_LI_MS,
          ...(opcoes?.sinal === undefined ? {} : { sinal: opcoes.sinal }),
        },
      ),
  };
}

/** Why there is no client although someone is logged in. */
export type MotivoBackendLiIndisponivel =
  /** The page is `https:` and the backend URL is plain `http:` — the token would travel in clear. */
  | 'inseguro'
  /** `NEXT_PUBLIC_LOJA_INTEGRADA_URL` is not an `http(s)` URL at all. */
  | 'url-invalida';

export type BackendLojaIntegrada =
  | { readonly ok: true; readonly baseUrl: string }
  | { readonly ok: false; readonly motivo: MotivoBackendLiIndisponivel };

/**
 * Which backend URL this page may talk to, or why none.
 *
 * - an unset (or empty) variable falls back to {@link DEFAULT_LOJA_INTEGRADA_URL},
 *   like every channel client;
 * - an `https:` page and an `http:` backend is REFUSED (`inseguro`): the save
 *   carries a store's live token, and a production build missing the variable
 *   would otherwise post it to `http://localhost:3010` in clear;
 * - an `http:` page may talk to either (local dev, and CI's e2e build).
 *
 * Pure: the page protocol is a parameter, so the rule is testable without a
 * browser.
 */
export function resolverBackendLojaIntegrada(
  protocoloDaPagina: string,
  urlConfigurada: string | undefined,
): BackendLojaIntegrada {
  const baseUrl =
    urlConfigurada === undefined || urlConfigurada.trim() === ''
      ? DEFAULT_LOJA_INTEGRADA_URL
      : urlConfigurada.trim();
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (err) {
    // The WHATWG URL parser throws exactly a TypeError on an unparseable input.
    if (err instanceof TypeError) return { ok: false, motivo: 'url-invalida' };
    throw err;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, motivo: 'url-invalida' };
  }
  if (protocoloDaPagina === 'https:' && url.protocol === 'http:') {
    return { ok: false, motivo: 'inseguro' };
  }
  return { ok: true, baseUrl };
}

export interface EstadoBackendLojaIntegrada {
  /** The client, or `null` while logged out or when the backend is unusable. */
  readonly client: LojaIntegradaClient | null;
  /** Set only when someone IS logged in and still there is no client. */
  readonly indisponivel: MotivoBackendLiIndisponivel | null;
}

/**
 * The client plus the reason it is missing — what the panel renders from, so it
 * can tell "loading the session" (no reason) from "this build cannot talk to
 * the backend safely" (a reason, and a disabled form).
 *
 * `window` is read only once a user exists, which never happens during the
 * server render of this client component.
 */
export function useBackendLojaIntegrada(): EstadoBackendLojaIntegrada {
  const { user } = useAuth();
  return useMemo(() => {
    if (!user) return { client: null, indisponivel: null };
    const backend = resolverBackendLojaIntegrada(
      window.location.protocol,
      process.env.NEXT_PUBLIC_LOJA_INTEGRADA_URL,
    );
    if (!backend.ok) return { client: null, indisponivel: backend.motivo };
    return {
      client: createLojaIntegradaClient({
        baseUrl: backend.baseUrl,
        getAuthToken: () => user.getIdToken(),
      }),
      indisponivel: null,
    };
  }, [user]);
}

/** {@link useBackendLojaIntegrada}'s client alone: `null` while logged out or when unusable. */
export function useLojaIntegradaClient(): LojaIntegradaClient | null {
  return useBackendLojaIntegrada().client;
}
