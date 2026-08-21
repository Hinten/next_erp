/**
 * The MANUAL price push (#804 S6) — "enviar preço agora" for a hand-picked set
 * of produtos, as opposed to the account-wide `atualizar-precos` job.
 *
 * Why it exists: the legacy Flutter app had this button on the produtos table
 * (`.old/lib/produtos/pages/produtoTableView.dart:397-434`, registered at
 * `:1414`) — multi-select capped at 50, fanning out over every channel each
 * produto was linked to — and the port dropped it. The only surviving entry
 * point takes `{ integracaoId, baixarPreco }` and nothing else, so lowering ONE
 * produto's price meant running a whole-account job with "Permitir baixar
 * preços" ticked, which also lowers every other listing sitting below its ML
 * price. That is riskier than what it replaced.
 *
 * Shape, and how it differs from the bulk job:
 *
 *  - **Synchronous.** The acceptance is a per-LISTING outcome, and the work is
 *    bounded at {@link MANUAL_PRECO_MAX_PRODUTOS} by construction, so it needs
 *    neither a job document nor a poll route. Same call as `estoqueManual.ts`.
 *  - **Sends through `enviarPrecoDraft` verbatim.** That module owns gates
 *    (1)-(8) — the fresh GET, skip-if-equal, the status gate, the decrease
 *    guard, the price-only body, the PUT, the echo verification and the link
 *    writebacks. A second sender would be a second place for the sent price to
 *    drift.
 *  - **No anchor pre-filters.** `fetchPrecoFamiliasByIds` reads the anchors by
 *    KEY, so the three classes the bulk job's query silently excludes
 *    (#804 S7) reach the report here as explicit rows: `NAO_PUBLICADO`,
 *    `SEM_LINK` for a drifted `integracoesComProduto`, and a variation child
 *    resolved up to its anchor instead of dropped.
 *
 * ⚠️ **The motivo vocabulary is UPPER_SNAKE, not the stock envelope's kebab.**
 * That is deliberate: these codes are the price stack's own
 * (`buildPrecoDrafts`' plan-time skips and `enviarPrecoDraft`'s send-time
 * ones), and they are what the bulk job persists in its `skips` list. One
 * vocabulary across both price surfaces beats cosmetic agreement with the
 * stock one, whose codes come from a different sender.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { type EnvioPrecoFilaItem, idFromRef } from '@delfrance/schemas';
import { MercadoLivreError } from '@delfrance/integrations-mercado-livre';

import { envInt } from '../estoque/bulkEstoquePlan';
import { resolverAnchors, runPool } from '../estoque/estoqueManual';
import {
  type FetchPrecoFamiliasByIds,
  type PrecoFamilyRow,
  buildPrecoDrafts,
  fetchPrecoFamiliasByIds,
} from './precoPlan';
import { type PriceSyncApi, enviarPrecoDraft } from './precoDraftSend';

/* --------------------------------- tunables -------------------------------- */

/**
 * Legacy parity (`produtoTableView.dart:417`, whose own message told the
 * operator to use the integrações screen for more). An oversize selection is
 * REJECTED, never truncated: silently dropping 150 of 200 produtos under a
 * green summary is the silent-under-send failure this whole area guards against.
 */
export const MANUAL_PRECO_MAX_PRODUTOS = 50;

/** Wall-clock budget. Past it the remainder is REPORTED, never silently dropped. */
export function manualPrecoDeadlineMs(): number {
  return envInt('MERCADO_LIVRE_PRECO_MANUAL_DEADLINE_MS', 120_000);
}

/**
 * Concurrent sends. Each draft costs a `GET` + a `PUT`, so this is twice the
 * request rate the number suggests — kept modest, and floored at 1 so a
 * misconfigured `0` cannot deadlock the pool.
 */
export function manualPrecoConcurrency(): number {
  return Math.max(1, envInt('MERCADO_LIVRE_PRECO_MANUAL_CONCURRENCY', 4));
}

/* ------------------------------ result envelope ----------------------------- */

export type PushPrecoOutcome =
  | 'enviado' // ML accepted the price and echoed it back
  | 'pulado' // deterministically not sent — see `motivo`
  | 'falha' // ML refused, or the echo did not carry the price
  | 'nao-tentado'; // aborted before its turn (rate-limit pause, deadline, reauth)

/**
 * One listing's outcome. Deliberately channel-NEUTRAL: `anuncioId` rather than
 * `itemId`. A second marketplace's `POST /api/marketplace/<canal>/enviar-precos`
 * returns this same envelope, and the web registry dispatches on it without
 * knowing which channel answered.
 */
export interface PushPrecoListing {
  /** The produto whose price this listing publishes — the family ANCHOR. */
  produtoId: string;
  produtoNome: string | null;
  /** The variation child behind a per-variation listing; null otherwise. */
  variacaoProdutoId: string | null;
  /** Channel-side listing id (ML: the MLB item id). Null when never published. */
  anuncioId: string | null;
  /** The ERP link doc id — the UI's key back into the produto's anúncios tab. */
  linkDocId: string | null;
  outcome: PushPrecoOutcome;
  /** Machine-readable code; null only on `'enviado'`. */
  motivo: string | null;
  /** Operator-facing pt-BR text — always present, always safe to render. */
  mensagem: string;
  /** The price actually sent; null when nothing was sent. */
  preco: number | null;
  /** What the listing carried BEFORE, when we got far enough to read it. */
  precoAnterior: number | null;
  /** Entry count when the channel took a bulk variations payload; else null. */
  variacoes: number | null;
}

export interface PushPrecoSemEnvio {
  produtoId: string;
  produtoNome: string | null;
  motivo: string;
  mensagem: string;
}

export interface PushPrecoResponse {
  canal: 'mercado-livre';
  integracaoId: string;
  contaNome: string | null;
  /** Deduped request size. */
  solicitados: number;
  /** Anchors actually discovered. */
  familias: number;
  resumo: { enviados: number; pulados: number; falhas: number; naoTentados: number };
  listings: PushPrecoListing[];
  /** Requested produtos that produced no listing at all, and why. */
  produtosSemEnvio: PushPrecoSemEnvio[];
  /** ISO-8601 — set when ML rate-limited the conta; the rest was not attempted. */
  pausadoAte: string | null;
}

/* ---------------------------------- guards --------------------------------- */

/**
 * A conta-level refusal the ROUTE turns into a 4xx. Fail-fast: it cannot be
 * reported per listing, because it stops the whole request.
 *
 * ⚠️ The code is `ML_CONTA_SEM_TABELA_NORMAL`, not the bulk route's bare
 * `SEM_TABELA_NORMAL`. They are the same condition on two different routes, and
 * the bulk one is already branched on by `mercadoLivreJobErrors.ts`; renaming
 * it would break that for no gain. New route, `ML_CONTA_*` prefix, matching
 * `enviar-estoque`'s ladder.
 */
export class ManualPrecoGuardError extends Error {
  constructor(
    readonly code: 'ML_CONTA_SEM_TABELA_NORMAL',
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ManualPrecoGuardError';
  }
}

/* ------------------------------ skip vocabulary ----------------------------- */

/**
 * pt-BR for every reason a listing can come back unsent. The manual push is the
 * ONLY surface where these codes reach a human — the bulk job persists them raw
 * in a capped `skips` list — so each one names the cause AND the remedy. A bare
 * `PRECO_NAO_MODIFICAVEL` is not actionable.
 */
const MENSAGEM_POR_MOTIVO: Record<string, string> = {
  // Plan-time (`buildPrecoDrafts`)
  SEM_LINK: 'Este produto não tem anúncio nesta conta.',
  SEM_ITEM_ID: 'O anúncio ainda não foi publicado no Mercado Livre.',
  AGUARDANDO_MIGRACAO: 'Anúncio em migração para User Products — envio suspenso.',
  PRECO_NAO_ENCONTRADO:
    'O produto não tem preço na tabela normal desta conta. Preencha o preço e tente de novo.',
  FAMILIA_MUITO_GRANDE: 'A família tem variações demais para um único envio.',
  // Send-time (`enviarPrecoDraft`)
  PRECO_ANTIGO_IGUAL: 'O anúncio já está com este preço.',
  PRECO_ANTIGO_MAIOR:
    'Pulado: o preço do ERP é MENOR que o do anúncio. Marque "Permitir baixar preços" para ' +
    'reduzir o preço no Mercado Livre.',
  PRECO_NAO_MODIFICAVEL:
    'O vendedor ativou a automação de preços do Mercado Livre para este anúncio, então o ML ' +
    'recusa preços vindos daqui. Desative a automação no anúncio para voltar a enviar.',
  PRECO_NAO_ATUALIZADO:
    'O Mercado Livre aceitou o envio mas não confirmou o preço novo. Confira o anúncio.',
  CLOSED: 'O anúncio está encerrado no Mercado Livre.',
  FORBIDDEN: 'O anúncio está em revisão e foi bloqueado pelo Mercado Livre.',
  STATUS_desconhecido: 'O Mercado Livre não informou o status deste anúncio.',
  GET_PRODUTO_ERROR: 'Não foi possível ler o anúncio no Mercado Livre.',
  UPDATE_PRECO_ERROR: 'O Mercado Livre recusou o novo preço.',
  // This module's own
  NAO_PUBLICADO: 'O produto está oculto (não publicado) no ERP.',
  PRODUTO_NAO_ENCONTRADO: 'Produto não encontrado.',
  FAMILIA_NAO_ENCONTRADA: 'Produto não encontrado ou não é um produto pai.',
  SEM_TABELA_NORMAL: 'A conta não tem tabela de preços normal configurada.',
  CONTA_PAUSADA: 'Não tentado: o Mercado Livre limitou as requisições desta conta.',
  TEMPO_ESGOTADO: 'Não tentado: o tempo do envio se esgotou. Tente com menos produtos.',
  REAUTH: 'Não tentado: a conta precisa ser reconectada ao Mercado Livre.',
  ERRO_CANAL: 'O Mercado Livre não respondeu. Tente novamente.',
  // The account-wide job's reconciliation phase (#1072). This module never
  // EMITS them — it reads anchors by key, so it has no unenumerated set — but
  // the table is the repo's registry of the price vocabulary, and a code that
  // is not in it is a code nobody can look up.
  NAO_ENUMERADO_CONTA_FORA_DO_PRODUTO:
    'O anúncio está ativo, mas o produto não registra esta conta — por isso o envio em massa ' +
    'não o alcançou. Envie o preço por aqui, pela tabela de produtos.',
  NAO_ENUMERADO_LINK_EM_VARIACAO:
    'O anúncio está vinculado a uma variação, não ao produto pai. Nenhuma tela consegue enviar ' +
    'preço para ele — corrija o vínculo do anúncio.',
  NAO_ENUMERADO_PAI_ID_INVALIDO:
    'O produto tem um vínculo de pai inválido (nem vazio, nem um produto real), então o envio ' +
    'em massa não o alcança. Corrija o cadastro do produto.',
  NAO_ENUMERADO_PRODUTO_AUSENTE:
    'O anúncio aponta para um produto que não existe mais. Refaça o vínculo ou remova o anúncio.',
  RECONCILIACAO_INCOMPLETA:
    'A conferência de anúncios não enumerados foi interrompida — o relatório está incompleto.',
};

/**
 * `podeEnviarPreco` emits `STATUS_<x>` for any status outside its accept set,
 * so the table above cannot enumerate them — the prefix arm names the status
 * back to the operator instead of falling through to a useless generic.
 */
export function mensagemDe(motivo: string): string {
  const exata = MENSAGEM_POR_MOTIVO[motivo];
  if (exata !== undefined) return exata;
  if (motivo.startsWith('STATUS_')) {
    return `O Mercado Livre não aceita envio de preço para um anúncio "${motivo.slice(7)}".`;
  }
  return 'Não enviado.';
}

/* ---------------------------------- the run --------------------------------- */

export interface EnviarPrecoManualArgs {
  integracaoId: string;
  produtoIds: readonly string[];
  /**
   * Allow the send to LOWER a listing's price (gate 4). The produtos table
   * defaults this ON — hand-picking produtos IS the explicit intent, and it is
   * what the legacy per-produto action did unconditionally
   * (`produtoTableView.dart:607`, `baixarPreco: true`). The account-wide job
   * keeps the opposite default, where one tick moves every listing at once.
   */
  baixarPreco?: boolean;
}

export interface EnviarPrecoManualDeps {
  /** ONE clock read for the whole request. */
  nowMs: number;
  /** The conta context, already loaded by the route (tabela normal + nome). */
  conta: Readonly<Record<string, unknown>>;
  contaNome: string | null;
  api: PriceSyncApi;
  fetchFamilias?: FetchPrecoFamiliasByIds;
  /** Injectable purely so tests do not go near the real sender. */
  sendDraft?: typeof enviarPrecoDraft;
}

export async function enviarPrecoManual(
  db: Firestore,
  args: EnviarPrecoManualArgs,
  deps: EnviarPrecoManualDeps,
): Promise<PushPrecoResponse> {
  const { nowMs, conta, api } = deps;
  const fetchFamilias = deps.fetchFamilias ?? fetchPrecoFamiliasByIds;
  const sendDraft = deps.sendDraft ?? enviarPrecoDraft;
  const baixarPreco = args.baixarPreco === true;

  // (1) Price-source guard — without a tabela normal there is no price to read,
  // and every listing would skip PRECO_NAO_ENCONTRADO for a reason that is a
  // conta misconfiguration, not a per-produto fact.
  const tabelaRef = conta.tabelaNormalOuterRef;
  const tabelaNormalId =
    typeof tabelaRef === 'string' && tabelaRef !== '' ? idFromRef(tabelaRef) : '';
  if (tabelaNormalId === '') {
    throw new ManualPrecoGuardError(
      'ML_CONTA_SEM_TABELA_NORMAL',
      400,
      'A conta não tem tabela de preços normal configurada — configure-a em Canais de venda.',
    );
  }

  // (2) Resolve each selection to its family anchor. See `resolverAnchors` for
  // why this is a masked `getAll` and not folded into the family read.
  const solicitados = [...new Set(args.produtoIds)];
  const resolved = await resolverAnchors(db, solicitados);

  const listings: PushPrecoListing[] = [];
  const produtosSemEnvio: PushPrecoSemEnvio[] = [];
  const nomeDe = (produtoId: string): string | null =>
    resolved.nomePorProdutoId.get(produtoId) ?? null;

  for (const produtoId of resolved.naoEncontrados) {
    produtosSemEnvio.push({
      produtoId,
      produtoNome: null,
      motivo: 'PRODUTO_NAO_ENCONTRADO',
      mensagem: mensagemDe('PRODUTO_NAO_ENCONTRADO'),
    });
  }

  if (resolved.anchorIds.length === 0) {
    return montarResposta(
      args.integracaoId,
      deps.contaNome,
      solicitados.length,
      0,
      listings,
      produtosSemEnvio,
      null,
    );
  }

  // (3) Read exactly those anchors by key — no `paiId`/`publicado`/
  // `integracoesComProduto` terms, which is what makes the rungs below fire.
  const rows = await fetchFamilias(db, {
    integracaoId: args.integracaoId,
    anchorIds: resolved.anchorIds,
  });
  const rowPorAnchor = new Map(rows.map((r) => [r.produtoId, r]));

  // An anchor the read did not return: the produto is gone. REPORTED, never
  // dropped — that is the whole difference from the bulk query.
  for (const anchorId of resolved.anchorIds) {
    if (rowPorAnchor.has(anchorId)) continue;
    produtosSemEnvio.push({
      produtoId: anchorId,
      produtoNome: nomeDe(anchorId),
      motivo: 'FAMILIA_NAO_ENCONTRADA',
      mensagem: mensagemDe('FAMILIA_NAO_ENCONTRADA'),
    });
  }

  const linhaSimples = (
    row: PrecoFamilyRow,
    motivo: string,
    anuncioId: string | null = null,
    linkDocId: string | null = null,
    produtoId = row.produtoId,
  ): PushPrecoListing => ({
    produtoId,
    produtoNome: nomeDe(produtoId) ?? nomeDe(row.produtoId),
    variacaoProdutoId: produtoId === row.produtoId ? null : produtoId,
    anuncioId,
    linkDocId,
    outcome: 'pulado',
    motivo,
    mensagem: mensagemDe(motivo),
    preco: null,
    precoAnterior: null,
    variacoes: null,
  });

  // (4) Plan. Family-level rungs first, then `buildPrecoDrafts` — reused
  // verbatim, so the manual push and the bulk job assemble drafts identically.
  const tarefas: Array<{ draft: EnvioPrecoFilaItem; row: PrecoFamilyRow }> = [];
  for (const row of rows) {
    // A 2-deep `paiId` chain: `resolverAnchors` hops exactly once, so the
    // "anchor" can itself be a variation child. Pathological, and pricing it
    // would price a family that is not one.
    if (row.paiId != null) {
      produtosSemEnvio.push({
        produtoId: row.produtoId,
        produtoNome: nomeDe(row.produtoId),
        motivo: 'FAMILIA_NAO_ENCONTRADA',
        mensagem: mensagemDe('FAMILIA_NAO_ENCONTRADA'),
      });
      continue;
    }
    // ⚠️ A DELIBERATE divergence from the bulk job since #1072, not an
    // oversight — do not "align" them without asking.
    //
    // The bulk job dropped this family server-side with no trace (#804 class
    // 1); it now enumerates it and SENDS, because for an account-wide "sync
    // every price" the live ML anúncio is the scope and `publicado` is an ERP
    // catalogue flag that has nothing to say about it.
    //
    // Here the operator hand-picked ONE produto, and the two gestures mean
    // different things: a hand-pick is worth confirming, so an oculto produto
    // reports rather than silently pushing a price the operator may not have
    // intended to touch.
    if (!row.publicado) {
      listings.push(linhaSimples(row, 'NAO_PUBLICADO'));
      continue;
    }
    const plan = buildPrecoDrafts(row, { integracaoId: args.integracaoId, tabelaNormalId });
    for (const skip of plan.skips) {
      listings.push(linhaSimples(row, skip.code, skip.itemId, null, skip.produtoId));
    }
    for (const draft of plan.drafts) tarefas.push({ draft, row });
  }

  // (5) Send, bounded. A 429 aborts the run: retrying inline would only earn
  // another one, and hammering a rate-limited conta is the one thing this must
  // never do.
  // ⚠️ ELAPSED wall-clock, measured from HERE — never `deps.nowMs + budget`.
  // `nowMs` is the request's ONE logical clock read and is INJECTED (tests pin
  // it, and the send stamps its writebacks from it), so comparing it against a
  // live `Date.now()` mixes two clocks: any injected value in the past would
  // trip the deadline on the first listing and report the whole run
  // `nao-tentado`.
  const iniciadoEmMs = Date.now();
  const orcamentoMs = manualPrecoDeadlineMs();
  let pausadoAte: string | null = null;
  /** Set once the run gives up; every remaining draft reports this motivo. */
  let motivoAborto: string | null = null;

  const executar = async (item: { draft: EnvioPrecoFilaItem; row: PrecoFamilyRow }) => {
    const { draft } = item;
    const base = {
      produtoId: draft.produtoId,
      produtoNome: nomeDe(draft.produtoId),
      variacaoProdutoId: draft.variacaoProdutoId,
      anuncioId: draft.itemId,
      linkDocId: draft.linkDocId,
      variacoes: null as number | null,
    };

    if (motivoAborto != null || Date.now() - iniciadoEmMs > orcamentoMs) {
      const motivo = motivoAborto ?? 'TEMPO_ESGOTADO';
      listings.push({
        ...base,
        outcome: 'nao-tentado',
        motivo,
        mensagem: mensagemDe(motivo),
        preco: null,
        precoAnterior: null,
      });
      return;
    }

    try {
      const result = await sendDraft(db, draft, api, { nowMs, baixarPreco });
      switch (result.kind) {
        case 'enviado':
          listings.push({
            ...base,
            outcome: 'enviado',
            motivo: null,
            mensagem:
              result.precoAtual != null
                ? `Preço atualizado de ${result.precoAtual} para ${result.preco}.`
                : `Preço ${result.preco} enviado.`,
            preco: result.preco,
            precoAnterior: result.precoAtual,
            variacoes: result.variacoes,
          });
          return;
        case 'pulado':
          listings.push({
            ...base,
            outcome: 'pulado',
            motivo: result.code,
            mensagem: mensagemDe(result.code),
            preco: null,
            precoAnterior: result.precoAtual,
          });
          return;
        case 'falha':
          listings.push({
            ...base,
            outcome: 'falha',
            motivo: result.code,
            // The channel's own message is more specific than the table's, and
            // `UPDATE_PRECO_ERROR` is exactly where that detail matters.
            mensagem: result.error !== '' ? result.error : mensagemDe(result.code),
            preco: null,
            precoAnterior: result.precoAtual,
          });
          return;
        case 'pausa':
          // Wall clock AT THE 429, not the request's `nowMs`: a 429 arriving 90s
          // into a run would otherwise report a window that already started 90s
          // ago and tell the operator to retry too early.
          motivoAborto = 'CONTA_PAUSADA';
          pausadoAte = new Date(
            Date.now() + (result.err.retryAfterSec ?? 300) * 1000,
          ).toISOString();
          listings.push({
            ...base,
            outcome: 'nao-tentado',
            motivo: 'CONTA_PAUSADA',
            mensagem: mensagemDe('CONTA_PAUSADA'),
            preco: null,
            precoAnterior: null,
          });
          return;
        case 'fatal':
          // A dead credential fails every remaining draft identically, and
          // reconnecting is a human action — stop rather than burn the rest.
          motivoAborto = 'REAUTH';
          listings.push({
            ...base,
            outcome: 'nao-tentado',
            motivo: 'REAUTH',
            mensagem: result.erro,
            preco: null,
            precoAnterior: null,
          });
          return;
      }
    } catch (err) {
      // `enviarPrecoDraft` rethrows everything it does not classify — a 5xx
      // `MercadoLivreHttpError`, but ALSO `MercadoLivreNetworkError` (`fetch`
      // itself failed) and `MercadoLivreValidationError` (ML changed a response
      // field). There is no queue behind a synchronous request, so this IS the
      // end of the line for that listing — report it and let the others run.
      //
      // ⚠️ Narrow on the BASE class, exactly as `estoqueManual.ts` does. Catching
      // only `MercadoLivreHttpError` let the other two escape `runPool`'s
      // `Promise.all`, so ONE `fetch` blip answered the request with an error
      // instead of the envelope — throwing away the outcome of every listing,
      // including the ones whose PUT had already landed and whose link
      // writebacks had already happened. That contradicts this route's contract
      // that a valid request answers 200 even when every listing failed.
      if (err instanceof MercadoLivreError) {
        listings.push({
          ...base,
          outcome: 'falha',
          motivo: 'ERRO_CANAL',
          mensagem: err.message,
          preco: null,
          precoAnterior: null,
        });
        return;
      }
      throw err; // Firestore / coding bug — never swallowed (repo rule 6)
    }
  };

  await runPool(tarefas, manualPrecoConcurrency(), executar);

  return montarResposta(
    args.integracaoId,
    deps.contaNome,
    solicitados.length,
    rows.length,
    listings,
    produtosSemEnvio,
    pausadoAte,
  );
}

/* --------------------------------- internals -------------------------------- */

function montarResposta(
  integracaoId: string,
  contaNome: string | null,
  solicitados: number,
  familias: number,
  listings: PushPrecoListing[],
  produtosSemEnvio: PushPrecoSemEnvio[],
  pausadoAte: string | null,
): PushPrecoResponse {
  return {
    canal: 'mercado-livre',
    integracaoId,
    contaNome,
    solicitados,
    familias,
    resumo: {
      enviados: listings.filter((l) => l.outcome === 'enviado').length,
      pulados: listings.filter((l) => l.outcome === 'pulado').length,
      falhas: listings.filter((l) => l.outcome === 'falha').length,
      naoTentados: listings.filter((l) => l.outcome === 'nao-tentado').length,
    },
    listings,
    produtosSemEnvio,
    pausadoAte,
  };
}
