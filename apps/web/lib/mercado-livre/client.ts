'use client';

/**
 * `useMercadoLivreClient()` — a memoized typed client bound to the current
 * Firebase auth state, talking to the apps/mercado-livre marketplace routes
 * (its own App Hosting backend). Mirrors `useFreightClient` (lib/freight/client.ts):
 * returns `null` while logged out so components can disable their buttons, and
 * passes `() => user.getIdToken()` so token refreshes propagate.
 *
 * The client is defined here (not in `@delfrance/integrations-mercado-livre`)
 * on purpose: that package's root is SERVER-SIDE ONLY (its OAuth core handles
 * the app clientSecret) and must never be bundled into the browser. When the
 * endpoint surface grows, promote this to a browser-safe `./http-client`
 * subpath export like `@delfrance/integrations-freight-br/http-client`.
 */
import { useMemo } from 'react';
import type { z } from 'zod';

import { lerRespostaJson, resumirCampos } from '@delfrance/core/wire';

import { useAuth } from '@/lib/auth/useAuth';

import * as wire from './wire';
import type {
  MercadoLivreAnuncioTeste,
  MercadoLivreAtributoSugestao,
  MercadoLivreAtributosSugestao,
  MercadoLivreCategoriaAtributos,
  MercadoLivreCategoriaSugestao,
  MercadoLivreCategorias,
  MercadoLivreChartDeleteCheckResult,
  MercadoLivreChartDeleteResult,
  MercadoLivreChartDomain,
  MercadoLivreChartSpecs,
  MercadoLivreConta,
  MercadoLivreEnvioEstoqueResult,
  MercadoLivreEnvioPrecoResult,
  MercadoLivreIaModelos,
  MercadoLivreImportarResult,
  MercadoLivreJobsEmAndamento,
  MercadoLivreMassImportStatus,
  MercadoLivreMedidasSugestao,
  MercadoLivrePriceSyncStatus,
  MercadoLivrePublicarResult,
  MercadoLivreReclamacaoEstado,
  MercadoLivreRespostaChat,
  MercadoLivreReverificarResult,
  MercadoLivreSyncChartsResult,
  MercadoLivreUsuarioTeste,
  MercadoLivreUsuariosTesteResult,
} from './wire';

const DEFAULT_MERCADO_LIVRE_URL = 'http://localhost:3006';

/** Non-2xx response from the mercado-livre backend. */
export class MercadoLivreClientHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Optional machine code from the backend (e.g. ML_REAUTH_REQUIRED). */
    readonly code: string | null,
    /** Per-field validation issues (422 ML_PUBLISH_BLOCKED carries them). */
    readonly issues: string[] | null = null,
  ) {
    super(message);
    this.name = 'MercadoLivreClientHttpError';
  }
}

/**
 * The backend answered 2xx, and the body was not the shape this app claims it
 * is — the wrong fields, no body at all, or not JSON.
 *
 * ⚠️ **Nothing about this class describes what WE send.** It is a browser-side
 * `Error` that never leaves the tab; `status` records the status the backend
 * sent US, which for this failure is always a 2xx. That is the point: the
 * transport succeeded and the payload was still unusable, and until now that
 * combination was reported to the caller as a success.
 *
 * ⚠️ **A subclass of `MercadoLivreClientHttpError`, deliberately.** 27 catch
 * sites in `apps/web` narrow to exactly that class and `…NetworkError` and
 * `throw err` for anything else, and ~24 of them are imperative handlers with
 * no TanStack error state to fall into. A brand-new sibling class would sail
 * past every one of them and land as an unhandled rejection —
 * `ReclamacaoMlPanel.tsx` documents that exact outcome for the token-refresh
 * case: the operator confirms an irreversible refund, the spinner stops, no
 * alert appears, and they click again. Subclassing means all 27 keep working
 * unchanged, and `code === 'RESPOSTA_INVALIDA'` is what tells the two apart
 * where it matters.
 */
export class MercadoLivreClientRespostaInvalidaError extends MercadoLivreClientHttpError {
  constructor(
    message: string,
    /** The real 2xx the backend sent — never a hardcoded 200; `enviarNfe` answers 202. */
    status: number,
    /**
     * The field paths that failed, de-duplicated and with array indices
     * collapsed. ⚠️ Paths only, never values: a response body is a live
     * credential often enough (an ML test user's `password`) that the rule has
     * to hold unconditionally.
     */
    readonly campos: string[],
  ) {
    super(message, status, 'RESPOSTA_INVALIDA');
    this.name = 'MercadoLivreClientRespostaInvalidaError';
  }
}

/** Network-level failure reaching the mercado-livre backend. */
export class MercadoLivreClientNetworkError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MercadoLivreClientNetworkError';
  }
}

/**
 * The mercado-livre backend answered 200, but not to the question that was
 * asked — so the "success" describes work that did not happen.
 *
 * ⚠️ This exists because `apps/web` talks to the **deployed** channel backend,
 * never the one in this checkout (the `itemIds?` note above is the same skew,
 * handled by tolerating an absent field). Tolerance is right for a field the UI
 * merely displays and wrong for one that decides whether a permanent, billable,
 * unrecoverable side effect occurred — there, a mismatch has to stop.
 */
export class MercadoLivreBackendDesatualizadoError extends Error {
  constructor(
    message: string,
    /**
     * Which check failed, as a machine-readable discriminator.
     *
     * ⚠️ NOT a copy selector — the panel renders `message` verbatim for both
     * values and keys its sticky notification on `instanceof`. It exists so the
     * two refusals cannot silently merge into one: the tests pin it, and a
     * `contrato-violado` that started reporting `backend-desatualizado` would
     * otherwise send the operator to a deploy that fixes nothing.
     */
    readonly motivo: 'backend-desatualizado' | 'contrato-violado',
  ) {
    super(message);
    this.name = 'MercadoLivreBackendDesatualizadoError';
  }
}

/**
 * The wire types moved to `./wire`, where each is inferred from the Zod
 * schema that validates it — one definition instead of a hand-written type
 * and an unchecked cast that could disagree with it.
 *
 * Re-exported here so every consumer keeps importing them from
 * `@/lib/mercado-livre/client`, which is where 42 files already look.
 */
export type {
  MercadoLivreAnuncioTeste,
  MercadoLivreAtributoSugestao,
  MercadoLivreAtributosSugestao,
  MercadoLivreCategoriaAtributo,
  MercadoLivreCategoriaAtributos,
  MercadoLivreCategoriaNo,
  MercadoLivreCategoriaSugestao,
  MercadoLivreCategorias,
  MercadoLivreChartDeleteCheckResult,
  MercadoLivreChartDeleteResult,
  MercadoLivreChartDomain,
  MercadoLivreChartSpecs,
  MercadoLivreChartValidationError,
  MercadoLivreConselhoParcial,
  MercadoLivreConta,
  MercadoLivreEnvioEstoqueListing,
  MercadoLivreEnvioEstoqueResult,
  MercadoLivreEnvioEstoqueSemEnvio,
  MercadoLivreEnvioPrecoListing,
  MercadoLivreEnvioPrecoResult,
  MercadoLivreExpectativaReclamacao,
  MercadoLivreIaModelo,
  MercadoLivreIaModelos,
  MercadoLivreImportarResult,
  MercadoLivreJobsEmAndamento,
  MercadoLivreMassImportFailure,
  MercadoLivreMassImportStatus,
  MercadoLivreMedidaSugestao,
  MercadoLivreMedidasContexto,
  MercadoLivreMedidasSugestao,
  MercadoLivreOfertaParcial,
  MercadoLivrePrazoAcao,
  MercadoLivrePriceSyncFailure,
  MercadoLivrePriceSyncSkip,
  MercadoLivrePriceSyncStatus,
  MercadoLivrePublicarResult,
  MercadoLivreReclamacaoEstado,
  MercadoLivreRespostaChat,
  MercadoLivreReverificarMembro,
  MercadoLivreReverificarResult,
  MercadoLivreSyncChartsResult,
  MercadoLivreUsuarioTeste,
  MercadoLivreUsuariosTesteResult,
} from './wire';

/** The `massImportOptionsSchema` booleans — all optional here, server defaults the rest. */
export interface MercadoLivreMassImportOptions {
  importarEstoque?: boolean;
  sobrescreverEstoque?: boolean;
  importarPreco?: boolean;
  sobrescreverPreco?: boolean;
  atualizarProdutoPai?: boolean;
  /** Default false — fill blanks only, never replace produto data already stored. */
  sobrescreverDadosProduto?: boolean;
  importarFotos?: boolean;
  importarCategorias?: boolean;
  /** Default false — a re-scan skips listings already linked to this account. */
  atualizarCadastrados?: boolean;
}

/**
 * The single-role mint's post-condition, checked in the BROWSER.
 *
 * ⚠️ It has to live here: the half that can be wrong is the half that is not
 * running this code. `apps/web` calls the deployed `apps/mercado-livre`, and
 * before the single-role mint existed that route **ignored its body entirely**
 * and always ran the pair bootstrap. Against a stale deployment a
 * `{role: 'comprador'}` POST therefore reuses both stored users, mints nothing,
 * wipes the conta's credential anyway, and answers **200**. `call()` used to
 * cast rather than validate, so every one of those was reported as a success:
 * the list did not change, and the reveal modal showed `usuarios[0]` — the
 * SELLER — under a "Comprador" badge, with the seller's password.
 *
 * ⚠️ **The schema does not make this redundant, and must not be made to.** The
 * old shape is a perfectly well-formed `UsuariosTesteResult`; what is wrong
 * with it is SEMANTIC — it describes work that did not happen — and no schema
 * catches that class. `credencialRevogada` is therefore `.optional()` in
 * `wire.ts` on purpose, so the refusal stays here where it can name the deploy
 * to run instead of reciting a field list.
 *
 * Two checks, because the remedies differ:
 *
 *  1. `credencialRevogada` is the CAPABILITY PROBE — the field did not exist
 *     before the single-role mint, so its absence dates the backend.
 *  2. The contract itself: exactly one account, of the role asked for, freshly
 *     minted and nothing reused.
 *
 * ⚠️ Throwing loses nothing. The backend persists every record BEFORE it
 * answers (rule 1 of the mint: persist before the next mint, before the
 * revocation, before the response), so whatever it did is already on disk and
 * readable through `GET`. Refusing only stops one account's password being
 * presented as another's.
 *
 * ⚠️ The PAIR bootstrap deliberately gets no such check: a stale backend does
 * exactly what that button asks, and its toast reads no field the old shape
 * lacks.
 */
function exigirMintAvulso(
  result: MercadoLivreUsuariosTesteResult,
  role: 'vendedor' | 'comprador',
): MercadoLivreUsuariosTesteResult {
  if (typeof result.credencialRevogada !== 'boolean') {
    throw new MercadoLivreBackendDesatualizadoError(
      'O backend do Mercado Livre é anterior à criação avulsa: ele ignorou o `role`, rodou a ' +
        'criação do PAR e não criou nenhum comprador novo — mas apagou as credenciais desta ' +
        'conta assim mesmo. Nenhuma senha foi revelada aqui, porque a conta que ele devolveu ' +
        'não é a que você pediu. Faça o deploy de `apps/mercado-livre` (com ' +
        'MERCADO_LIVRE_TEST_USERS_ENABLED=1) antes de usar este botão.',
      'backend-desatualizado',
    );
  }
  const criouSoOSolicitado =
    result.criados.length === 1 && result.criados[0] === role && result.reaproveitados.length === 0;
  const umUnicoDoRole = result.usuarios.length === 1 && result.usuarios[0]?.role === role;
  if (!criouSoOSolicitado || !umUnicoDoRole) {
    throw new MercadoLivreBackendDesatualizadoError(
      `O backend não criou o ${role} solicitado: respondeu com ${String(result.criados.length)} ` +
        `criado(s) e ${String(result.reaproveitados.length)} reaproveitado(s). Nenhuma senha ` +
        'foi revelada, para não mostrar a credencial de outra conta como se fosse a nova. ' +
        'Confira a lista antes de clicar de novo — cada clique gasta uma vaga permanente.',
      'contrato-violado',
    );
  }
  return result;
}

/** One grid row as the suggestion route describes it. */
export interface MercadoLivreMedidaRow {
  /** The editor's stable row key — round-tripped, never shown to the model. */
  key: string;
  /** The row's main-attribute value (`P`, `M`, `42`). What the model matches on. */
  size: string;
}

/** One grid column as the suggestion route describes it. */
export interface MercadoLivreMedidaColumn {
  attributeId: string;
  label: string;
  kind: 'text' | 'number' | 'select' | 'multiselect';
  values: Array<{ id: string; name: string }>;
  unitId: string | null;
  required: boolean;
  /**
   * ML's size-equivalence column (`FILTRABLE_SIZE`): which standard Mercado
   * Livre size(s) the row corresponds to. The only column in the grid the model
   * DERIVES rather than transcribes, and the flag is what tells it so.
   */
  sizeEquivalence: boolean;
}

/** The tabela's fields as the BROWSER has them — including unsaved edits. */
export interface MercadoLivreMedidasFatos {
  nome?: string | null;
  codigo?: string | null;
  descricao?: string | null;
  fotos?: unknown[] | null;
}

/** A binary shipment label fetched from the mercado-livre backend (`GET etiqueta`). */
export interface MercadoLivreEtiquetaArtifact {
  blob: Blob;
  filename: string;
  contentType: string;
}

export interface MercadoLivreClient {
  /** Mint the ML consent URL for an account (PERM.integracao.write). */
  oauthStart(integracaoId: string): Promise<{ authorizeUrl: string }>;
  /** Connection status: `/users/me` identity or `connected: false`. */
  conta(integracaoId: string): Promise<MercadoLivreConta>;
  /**
   * Publish (or re-publish) a produto as an ML listing
   * (PERM.integracao.write). Blocking validation problems surface as a 422
   * `MercadoLivreClientHttpError` with `code: 'ML_PUBLISH_BLOCKED'` + `issues`.
   */
  publicar(input: {
    integracaoId: string;
    produtoId: string;
    listingTypeId?: string;
    /**
     * WHICH of the conta's anúncios to publish. A produto can carry more than
     * one listing on the same account, and the backend's link lookup would
     * otherwise take the first — silently re-publishing the wrong one. Omit for
     * a conta whose listing is unambiguous; the backend 404s an id that names a
     * doc this produto does not have or that belongs to another conta.
     */
    linkDocId?: string;
  }): Promise<MercadoLivrePublicarResult>;
  /**
   * Re-read ONE listing from ML and record its real state on the link doc
   * (PERM.integracao.write) — the operator's way out of a stock latch (#781).
   * It does not send stock; the next sweep (≤15 min) does that on its own.
   */
  reverificarAnuncio(input: {
    integracaoId: string;
    produtoId: string;
    linkDocId: string;
  }): Promise<MercadoLivreReverificarResult>;
  /**
   * Where ONE listing lives on Mercado Livre (PERM.integracao.read).
   *
   * Only a **User-Products** listing needs this: its link doc holds a FAMILY id,
   * which addresses nothing public, so the URL has to come from ML. A legacy
   * listing is a pure string transform `listingPermalink` already does in the
   * browser. Nothing is persisted — the Flutter app's unmasked `set()` would wipe
   * a cached field on its next save.
   *
   * 404 when the listing is gone; 409 when it was never published.
   */
  linkAnuncio(input: {
    integracaoId: string;
    produtoId: string;
    linkDocId: string;
  }): Promise<{ url: string }>;
  /**
   * Import (or re-sync) an ML listing into an ERP produto (PERM.integracao.write).
   * All three listing models import: simple, legacy `variations[]` (#520) and
   * `family_name` / User-Products (#521). A listing the importer cannot take —
   * closed, owned by another seller, untitled, or on an integração with no
   * `user_id` — returns a 422 `MercadoLivreClientHttpError` with
   * `code: 'ML_IMPORT_BLOCKED'` + `issues`.
   */
  importar(input: {
    integracaoId: string;
    itemId: string;
    options?: {
      importarEstoque?: boolean;
      sobrescreverEstoque?: boolean;
      importarPreco?: boolean;
      sobrescreverPreco?: boolean;
      atualizarProdutoPai?: boolean;
      /** Default false — fill blanks only, never replace produto data already stored. */
      sobrescreverDadosProduto?: boolean;
      importarFotos?: boolean;
      importarCategorias?: boolean;
    };
  }): Promise<MercadoLivreImportarResult>;
  /**
   * Kick off a full mass import ("Importar todos os anúncios") for the account
   * (PERM.integracao.write) — scans every listing and imports each one,
   * checkpointed server-side. Poll progress with `massImportStatus`. A second
   * call while one is already running comes back as a 409
   * `MercadoLivreClientHttpError` with `code: 'ML_MASS_IMPORT_RUNNING'`.
   */
  startMassImport(input: {
    integracaoId: string;
    options?: MercadoLivreMassImportOptions;
  }): Promise<{ jobId: string }>;
  /** Poll a mass-import job's progress (PERM.integracao.read). 404s on an unknown/foreign jobId. */
  massImportStatus(input: {
    integracaoId: string;
    jobId: string;
  }): Promise<MercadoLivreMassImportStatus>;
  /**
   * Cancel a running mass import (PERM.integracao.write) — stamps the job
   * `cancelled`, which the task handler observes at its next dispatch: an
   * in-flight batch finishes and nothing further is scheduled.
   *
   * It is also how a job that is `running` with no worker gets cleared — until
   * it is terminal, `startMassImport` keeps answering 409
   * `ML_MASS_IMPORT_RUNNING`. A job that already finished comes back as a 409
   * `MercadoLivreClientHttpError` with `code: 'ML_MASS_IMPORT_NOT_RUNNING'`;
   * an unknown or foreign jobId 404s.
   */
  cancelMassImport(input: {
    integracaoId: string;
    jobId: string;
  }): Promise<{ status: 'cancelled' }>;
  /**
   * Kick off the manual bulk price sync ("Atualizar preços") for the account
   * (PERM.integracao.write) — pushes each linked produto's tabela-normal price
   * to its ML listings, checkpointed server-side. Poll progress with
   * `priceSyncStatus`. A second call while one is already running comes back
   * as a 409 `MercadoLivreClientHttpError` with `code: 'ML_PRICE_SYNC_RUNNING'`;
   * a conta without a tabela normal as a 400 with `code: 'SEM_TABELA_NORMAL'`;
   * an unreachable queue as a 503 with `code: 'ML_PRICE_SYNC_ENQUEUE_FAILED'`.
   */
  startPriceSync(input: {
    integracaoId: string;
    /** Default false — price DECREASES are skipped (`PRECO_ANTIGO_MAIOR`) unless opted in. */
    baixarPreco?: boolean;
  }): Promise<{ jobId: string }>;
  /** Poll a price-sync job's progress (PERM.integracao.read). 404s on an unknown/foreign jobId. */
  priceSyncStatus(input: {
    integracaoId: string;
    jobId: string;
  }): Promise<MercadoLivrePriceSyncStatus>;
  /**
   * Push the CURRENT stock of up to 50 produtos to their ML listings, right now
   * (PERM.integracao.write) — the on-demand twin of the 15-minute sweep (#819).
   *
   * SYNCHRONOUS: it returns one outcome per LISTING, not a job id. Per-listing
   * failure is DATA — a valid request answers 200 even when every listing
   * failed — so only conta-level refusals throw: 400 `ML_SELECAO_EXCEDE_LIMITE`
   * (an oversize selection is rejected, never truncated), 400
   * `ML_CONTA_SEM_DEPOSITO`, 409 `ML_CONTA_PAUSADA`, 409 `ML_CONTA_MULTIORIGEM`.
   *
   * `reenviarComErro` re-verifies a listing latched by #781 against ML and
   * clears its errors before sending. Default false, because `estado 'E'` means
   * ML already confirmed the anúncio is healthy and it was our payload it
   * refused — re-sending unchanged just re-earns the rejection.
   */
  enviarEstoque(input: {
    integracaoId: string;
    produtoIds: string[];
    reenviarComErro?: boolean;
    signal?: AbortSignal;
  }): Promise<MercadoLivreEnvioEstoqueResult>;
  /**
   * Push the CURRENT price of up to 50 produtos to their ML listings, right now
   * (PERM.integracao.write) — the produto-scoped twin of `startPriceSync`
   * (#804), restoring the legacy produtos-table row action.
   *
   * SYNCHRONOUS: it returns one outcome per LISTING, not a job id. Per-listing
   * failure is DATA — a valid request answers 200 even when every listing
   * failed — so only conta-level refusals throw: 400 `ML_SELECAO_EXCEDE_LIMITE`
   * (an oversize selection is rejected, never truncated) and 400
   * `ML_CONTA_SEM_TABELA_NORMAL`.
   *
   * `baixarPreco` allows the send to LOWER a listing's price. The produtos
   * table defaults it ON, unlike the account-wide job: hand-picking produtos IS
   * the explicit intent, and it is what the legacy per-produto action did
   * unconditionally. Unticked, a decrease skips `PRECO_ANTIGO_MAIOR`.
   */
  enviarPrecos(input: {
    integracaoId: string;
    produtoIds: string[];
    baixarPreco?: boolean;
    signal?: AbortSignal;
  }): Promise<MercadoLivreEnvioPrecoResult>;
  /**
   * The RUNNING mass-import and price-sync jobs across a set of contas, in one
   * round trip (PERM.integracao.read) — how the channel list re-attaches its
   * pollers after a reload, since a `jobId` only ever lived in React state.
   * The caller must name the contas (400 otherwise); at most 300 per call.
   */
  jobsEmAndamento(input: { integracaoIds: string[] }): Promise<MercadoLivreJobsEmAndamento>;
  /**
   * One level of the ML category tree for the listing editor's cascade picker
   * (PERM.integracao.read). Omit `categoryId` for the roots.
   */
  categorias(input: {
    integracaoId: string;
    categoryId?: string | null;
  }): Promise<MercadoLivreCategorias>;
  /**
   * ML's ranked category suggestions for a title (PERM.integracao.read).
   *
   * OFFERS them — publish no longer applies a suggestion itself (#799), so the
   * operator picks from this list.
   */
  sugerirCategorias(input: {
    integracaoId: string;
    q: string;
    limit?: number;
  }): Promise<{ sugestoes: MercadoLivreCategoriaSugestao[] }>;
  /**
   * The attribute definitions to render for a LEAF category, already filtered
   * and ordered required-first (PERM.integracao.read). `leaf: false` means the
   * operator has not reached a leaf yet — show the cascade, not an empty grid.
   */
  categoriaAtributos(input: {
    integracaoId: string;
    categoryId: string;
    escopo?: 'item' | 'variacao';
  }): Promise<MercadoLivreCategoriaAtributos>;
  /**
   * Send a reply on a Mercado Livre conversa (PERM.mensagem.write, #533).
   *
   * ⚠️ SYNCHRONOUS, and that is the point: an ML reply is single-shot and its
   * refusals are terminal — already answered, thread blocked, mediation open.
   * A rejection arrives as `MercadoLivreClientHttpError` with a 409 and an
   * operator-facing message, which the composer shows verbatim.
   */
  responderConversa(input: {
    integracaoId: string;
    conversaId: string;
    texto: string;
  }): Promise<MercadoLivreRespostaChat>;
  /**
   * Delete a Mercado Livre question, or block its author (PERM.mensagem.delete).
   *
   * ⚠️ Both are PUBLIC and not undoable from here — a deleted question leaves
   * the listing for everyone, a blocked buyer cannot ask on any listing.
   */
  /**
   * Live state of one ML claim (`PERM.incidenteResolucao.read`).
   *
   * ⚠️ Never cache the result. `available_actions` is stale the moment it leaves
   * ML, so the panel refetches rather than remembering.
   */
  reclamacaoEstado(input: {
    integracaoId: string;
    claimId: number;
  }): Promise<MercadoLivreReclamacaoEstado>;
  /**
   * Run one resolution action on an ML claim
   * (`PERM.incidenteResolucao.write`).
   *
   * ⚠️ **Irreversible and money-moving.** Writes NOTHING locally — the claims
   * importer stays the single writer of the resulting incidente state, so the
   * caller learns the outcome by refetching {@link reclamacaoEstado}, which is
   * ML's own word rather than our guess.
   *
   * ⚠️ For `reembolso_parcial` BOTH `valorReembolsoMinor` and
   * `percentualExibido` are required, and the backend refuses without them:
   * Mercado Livre treats a MISSING percentage as **50%**.
   */
  reclamacaoAcao(input: {
    integracaoId: string;
    claimId: number;
    acao: 'reembolso' | 'reembolso_parcial' | 'aceitar_devolucao' | 'abrir_mediacao';
    valorReembolsoMinor?: number;
    percentualExibido?: number;
  }): Promise<{ ok: boolean; status: string | null; acao: string }>;
  acaoPergunta(input: {
    integracaoId: string;
    conversaId: string;
    acao: 'excluir' | 'bloquear';
  }): Promise<{ conversaId: string; acao: 'excluir' | 'bloquear' }>;
  /**
   * The documented test-listing data for this account (PERM.integracao.read).
   *
   * ⚠️ Read-only — it resolves what a test listing must look like and reports
   * whether the account is a test user. Publishing remains a separate,
   * deliberate click.
   */
  anuncioTeste(integracaoId: string): Promise<MercadoLivreAnuncioTeste>;
  /**
   * The Mercado Livre test users stored for this conta (PERM.integracao.read).
   *
   * The subcollection is admin-only, so this route is the only way the browser
   * can reach them — and ML never reissues a password, so it is also the only
   * way to see one again after the mint.
   *
   * Both this and {@link criarUsuariosTeste} answer **404** unless the backend
   * sets `MERCADO_LIVRE_TEST_USERS_ENABLED=1`. Callers treat that as "the
   * feature is off here", not as an error worth surfacing.
   */
  usuariosTeste(integracaoId: string): Promise<{ usuarios: MercadoLivreUsuarioTeste[] }>;
  /**
   * Mint the seller/buyer test-user pair (PERM.integracao.write).
   *
   * ⚠️ **Destructive.** On success the backend deletes every OAuth credential of
   * the conta it used — that is the point (the bootstrap account is a real
   * seller account and must not stay wired to the ERP), but it means this must
   * never be called without an explicit confirmation naming that conta.
   */
  criarUsuariosTeste(integracaoId: string): Promise<MercadoLivreUsuariosTesteResult>;
  /**
   * Mint ONE additional test user of `role` (PERM.integracao.write) — #1087's
   * case, where Mercado Pago stopped accepting purchases from the buyer and it
   * has to be replaced without re-minting the seller that still works.
   *
   * ⚠️ **This never reuses.** The stored record of that role is left untouched
   * and the new account lands at its own doc id, so every call spends one of
   * the account's ten permanent slots. A retry after a lost response spends a
   * second one — check the list before clicking again.
   *
   * ⚠️ **It needs the real application-owner account connected.** A previous
   * mint deleted this conta's credential, and the backend resolves a token
   * before any guard runs, so an unconnected conta answers 409
   * `ML_REAUTH_REQUIRED`. Pass `manterCredencial` to skip the revocation and
   * keep the conta connected for a follow-up mint — the default revokes.
   */
  criarUsuarioTesteAvulso(
    integracaoId: string,
    role: 'vendedor' | 'comprador',
    opts?: { manterCredencial?: boolean },
  ): Promise<MercadoLivreUsuariosTesteResult>;
  /**
   * Models the AI settings page may offer, plus what a suggestion would actually
   * use right now (PERM.integracao.read).
   *
   * ⚠️ Takes no `integracaoId`: the agent config is per-installation, not per ML
   * account — one model serves every connected seller. It lives on this client
   * anyway because the route is hosted by the ML backend, which is where the
   * Vertex credential and the IAM grant are.
   */
  /** `agenteId` picks whose settings and whose default instruction to report. */
  iaModelos(agenteId?: string): Promise<MercadoLivreIaModelos>;
  /** Chart-enabled ML domains for the chart-editor picker (PERM.integracao.read). */
  sizeChartDomains(integracaoId: string): Promise<{ domains: MercadoLivreChartDomain[] }>;
  /**
   * The domain's technical specs (PERM.integracao.read). Without `attributes`
   * → the full domain spec (where the chart editor finds the grid template);
   * with `attributes` → the `?section=grids` column spec.
   */
  sizeChartSpecs(input: {
    integracaoId: string;
    domainId: string;
    attributes?: Array<Record<string, unknown>>;
  }): Promise<MercadoLivreChartSpecs>;
  /**
   * Send the tabMedi's edited chart list for one account to ML and persist
   * the ids (PERM.integracao.write). ML chart-validation problems come back
   * as `validationErrors` on the 200 body (partial success is DATA); only
   * infrastructure failures throw.
   */
  sizeChartSync(input: {
    integracaoId: string;
    tabMediId: string;
    tabelas: unknown[];
  }): Promise<MercadoLivreSyncChartsResult>;
  /**
   * Ask a model to read the tabela's photos and fill the grid
   * (PERM.integracao.write).
   *
   * Returns suggestions to STAGE — nothing is written on either side.
   * `contexto` is load-bearing in the UI: it says which sources actually reached
   * the model, so a text-only run reads as "there was nothing to read" rather
   * than as a broken feature.
   *
   * ⚠️ `fatos` carries the tabela's fields as the BROWSER has them. The editor
   * lives inside an `ObjectView` form, so a descrição just typed and a photo just
   * uploaded are not on the document yet; without them the server reads a stale
   * record. Each field falls back to the stored one individually, so omitting
   * `fatos` entirely keeps the old behaviour.
   */
  /**
   * Ask the agent to fill this listing's category attributes
   * (PERM.integracao.write). Returns suggestions to STAGE — the server writes
   * nothing, and the review modal applies only what the operator ticked.
   *
   * `feedback` + `anterior` are the revise turn: the operator says what is wrong
   * and the previous answer rides along so the model corrects rather than
   * restarts.
   */
  sugerirAtributos(input: {
    integracaoId: string;
    produtoId: string;
    categoryId: string;
    feedback?: string;
    anterior?: MercadoLivreAtributoSugestao[];
  }): Promise<MercadoLivreAtributosSugestao>;
  sugerirMedidas(input: {
    tabMediId: string;
    rows: MercadoLivreMedidaRow[];
    columns: MercadoLivreMedidaColumn[];
    measureType?: string | null;
    mainAttributeId?: string | null;
    /** The chart being edited — never offered back as its own reference. */
    chartId?: string | null;
    fatos?: MercadoLivreMedidasFatos;
  }): Promise<MercadoLivreMedidasSugestao>;
  /**
   * Ask ML to remove one guia de tamanho (PERM.integracao.write).
   *
   * ⚠️ Resolving does NOT mean the guia is gone: ML acks the request and then
   * checks asynchronously (up to 24h) that no listing still links it, keeping
   * it silently if one does. The guia stays on the doc flagged
   * `exclusaoSolicitadaEm`; call `sizeChartVerificarExclusao` for the verdict.
   */
  sizeChartExcluir(input: {
    integracaoId: string;
    tabMediId: string;
    chartId: string;
  }): Promise<MercadoLivreChartDeleteResult>;
  /**
   * Settle a pending removal (PERM.integracao.write): reads the chart back from
   * ML and, once ML confirms it is gone, drops it from the tabMedi doc.
   * `removed: false` with `chartStatus: 'ACTIVE'` means it is still linked to a
   * listing and has to be unlinked first.
   */
  sizeChartVerificarExclusao(input: {
    integracaoId: string;
    tabMediId: string;
    chartId: string;
  }): Promise<MercadoLivreChartDeleteCheckResult>;
  /**
   * Fetch the pedido's marketplace-generated shipment label (PERM.frete.read).
   * Binary success body; error bodies are JSON and surface as a
   * `MercadoLivreClientHttpError` carrying the route's `code` (e.g. a 409
   * `ML_INVOICE_PENDING` while the shipment hasn't received the NF-e yet).
   */
  etiqueta(pedidoId: string, formato: 'pdf' | 'zpl2'): Promise<MercadoLivreEtiquetaArtifact>;
  /**
   * Manually (re)send the pedido's approved NF-e to its ML shipment
   * (PERM.pedido.write). 202 `{ enqueued: true }` means ENQUEUED, not uploaded —
   * the actual ML call runs in an async task. An ineligible doc comes back as a
   * 409 `MercadoLivreClientHttpError` with `code: 'NFE_NAO_ELEGIVEL'`.
   */
  enviarNfe(input: { pedidoId: string; nfeId: string }): Promise<{ enqueued: boolean }>;
}

/**
 * The message for a non-2xx response whose body was NOT our JSON `{error}`
 * envelope.
 *
 * ⚠️ The body is deliberately DISCARDED rather than shown. Every route in
 * apps/mercado-livre answers JSON, so a non-JSON body means the request never
 * reached one — a Next.js 404 page, an App Hosting 502, a proxy login redirect.
 * Those are entire HTML documents, and putting one in `err.message` dumps the
 * raw page into whatever renders the error. It kept the real cause (the backend
 * is down / out of date) completely invisible behind a wall of markup.
 */
export function mercadoLivreHttpFallbackMessage(status: number): string {
  // Written for the OPERATOR, who cannot inspect a deployment — so it says what
  // to do, and carries the status only so support can act on a screenshot.
  if (status === 401 || status === 403) {
    return 'Sem permissão para esta operação no Mercado Livre.';
  }
  if (status === 404) {
    return `A integração com o Mercado Livre não respondeu (HTTP ${String(status)}). Atualize a página e, se continuar, avise o suporte.`;
  }
  if (status >= 500) {
    return `A integração com o Mercado Livre falhou (HTTP ${String(status)}). Tente novamente em instantes.`;
  }
  return `Falha na comunicação com o Mercado Livre (HTTP ${String(status)}).`;
}

/** Our JSON error envelope, when the body actually parsed as one. */
function errorEnvelope(
  parsed: unknown,
): { error?: string; code?: string; issues?: string[] } | null {
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as { error?: string; code?: string; issues?: string[] };
}

/** Pull the filename out of a `Content-Disposition` header, if present. */
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch (err) {
    // A stray '%' in the server-sent name must not fail a byte-successful
    // fetch — keep the undecoded filename.
    if (err instanceof URIError) return m[1];
    throw err;
  }
}

export function createMercadoLivreClient(config: {
  baseUrl: string;
  getAuthToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
}): MercadoLivreClient {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const doFetch = config.fetch ?? globalThis.fetch;

  /**
   * Log a body the operator will never see, capped so a whole HTML document
   * cannot flood the console (#818).
   */
  function logarCorpoNaoJson(path: string, status: number, corpo: string): void {
    console.error(
      `[mercado-livre] resposta não-JSON em ${path} (HTTP ${String(status)})`,
      corpo.slice(0, 500),
    );
  }

  async function call<S extends z.ZodType>(
    path: string,
    schema: S,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<z.infer<S>> {
    const token = await config.getAuthToken();
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        // Long-running calls (the manual stock push) let the operator cancel;
        // every existing caller passes nothing and is unaffected.
        ...(signal === undefined ? {} : { signal }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new MercadoLivreClientNetworkError(
        err instanceof Error ? err.message : 'fetch falhou',
        err,
      );
    }

    const text = await res.text();

    if (!res.ok) {
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          if (err instanceof SyntaxError) {
            // The body never reaches the UI, so keep it reachable for debugging.
            logarCorpoNaoJson(path, res.status, text);
          } else throw err;
        }
      }
      const errBody = errorEnvelope(parsed);
      throw new MercadoLivreClientHttpError(
        errBody?.error ?? mercadoLivreHttpFallbackMessage(res.status),
        res.status,
        errBody?.code ?? null,
        Array.isArray(errBody?.issues) ? errBody.issues : null,
      );
    }

    const leitura = lerRespostaJson(text, schema);
    if (leitura.ok) return leitura.data;

    if (leitura.motivo !== 'formato') {
      // ⚠️ EMPTY and NON-JSON share this branch, and they must: neither is
      // version skew — in both the request failed to reach a route that answers
      // JSON. An empty body used to fall through to the 'formato' arm below,
      // which told the operator to deploy `apps/mercado-livre` and logged
      // nothing at all — the quietest failure left in the file, sitting in the
      // branch that looked handled.
      //
      // A 2xx carrying HTML was the original of this pair: `nonJsonBody` was
      // captured and then read only inside the `!res.ok` branch, so it returned
      // `null as T` and logged nowhere.
      logarCorpoNaoJson(
        path,
        res.status,
        leitura.motivo === 'nao-json' ? leitura.texto : '(corpo vazio)',
      );
      throw new MercadoLivreClientRespostaInvalidaError(
        `A integração com o Mercado Livre respondeu HTTP ${String(res.status)} sem um corpo ` +
          'JSON — o pedido não chegou à rota esperada. Atualize a página e, se continuar, ' +
          'avise o suporte.',
        res.status,
        [],
      );
    }

    throw new MercadoLivreClientRespostaInvalidaError(
      'O backend do Mercado Livre respondeu num formato que este aplicativo não reconhece. ' +
        `Campos inválidos: ${resumirCampos(leitura.campos)}. Normalmente isso significa que o ` +
        'backend e esta tela estão em versões diferentes — faça o deploy de ' +
        '`apps/mercado-livre` e recarregue a página.',
      res.status,
      leitura.campos,
    );
  }

  /** Like `call`, but for a binary (non-JSON) success body. Errors are JSON. */
  async function fetchArtifact(
    path: string,
    fallback: { filename: string; contentType: string },
  ): Promise<MercadoLivreEtiquetaArtifact> {
    const token = await config.getAuthToken();
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      throw new MercadoLivreClientNetworkError(
        err instanceof Error ? err.message : 'fetch falhou',
        err,
      );
    }
    if (!res.ok) {
      let parsed: unknown = null;
      let nonJsonBody: string | null = null;
      const text = await res.text();
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          if (err instanceof SyntaxError) nonJsonBody = text;
          else throw err;
        }
      }
      const errBody = errorEnvelope(parsed);
      if (nonJsonBody != null) {
        logarCorpoNaoJson(path, res.status, nonJsonBody);
      }
      throw new MercadoLivreClientHttpError(
        errBody?.error ?? mercadoLivreHttpFallbackMessage(res.status),
        res.status,
        errBody?.code ?? null,
      );
    }

    const contentType = res.headers.get('content-type');
    // ⚠️ The one success path a schema cannot reach: the body is bytes, so
    // there is nothing to parse. What can still go wrong is the same thing —
    // a 200 that is not the artifact at all. A proxy login page or an App
    // Hosting error page arrives as `text/html`, and without this check it
    // became a `Blob` the operator "printed": a silent blank label, or a label
    // printer fed a chunk of markup. The route answers PDF or ZPL and never
    // HTML, so `text/html` on a 2xx means the request did not reach it.
    if (contentType !== null && /^\s*text\/html\b/i.test(contentType)) {
      logarCorpoNaoJson(path, res.status, await res.text());
      throw new MercadoLivreClientRespostaInvalidaError(
        `A integração com o Mercado Livre respondeu HTTP ${String(res.status)} com uma página ` +
          'HTML em vez da etiqueta — o pedido não chegou à rota esperada. Atualize a página e, ' +
          'se continuar, avise o suporte.',
        res.status,
        [],
      );
    }

    const blob = await res.blob();
    return {
      blob,
      // The route names the file via Content-Disposition, but the proxy does
      // not CORS-expose the header to the browser — tolerate its absence with
      // a client-side fallback (nfe `fetchArtifact` precedent).
      filename:
        filenameFromDisposition(res.headers.get('content-disposition')) ?? fallback.filename,
      contentType: res.headers.get('content-type') ?? fallback.contentType,
    };
  }

  return {
    oauthStart: (integracaoId) =>
      call(
        `/api/marketplace/mercado-livre/oauth/start?integracaoId=${encodeURIComponent(integracaoId)}`,
        wire.authorizeUrlSchema,
      ),
    conta: (integracaoId) =>
      call(
        `/api/marketplace/mercado-livre/conta?integracaoId=${encodeURIComponent(integracaoId)}`,
        wire.contaSchema,
      ),
    publicar: (input) =>
      call('/api/marketplace/mercado-livre/publicar', wire.publicarResultSchema, input),
    reverificarAnuncio: (input) =>
      call(
        '/api/marketplace/mercado-livre/reverificar-anuncio',
        wire.reverificarResultSchema,
        input,
      ),
    linkAnuncio: (input) =>
      call('/api/marketplace/mercado-livre/link-anuncio', wire.urlSchema, input),
    importar: (input) =>
      call('/api/marketplace/mercado-livre/importar', wire.importarResultSchema, input),
    startMassImport: (input) =>
      call('/api/marketplace/mercado-livre/importar-todos', wire.jobIdSchema, {
        integracaoId: input.integracaoId,
        options: input.options,
      }),
    massImportStatus: (input) =>
      call(
        `/api/marketplace/mercado-livre/importar-todos/status?integracaoId=${encodeURIComponent(input.integracaoId)}&jobId=${encodeURIComponent(input.jobId)}`,
        wire.massImportStatusSchema,
      ),
    cancelMassImport: (input) =>
      call('/api/marketplace/mercado-livre/importar-todos/cancelar', wire.cancelledSchema, {
        integracaoId: input.integracaoId,
        jobId: input.jobId,
      }),
    startPriceSync: (input) =>
      call('/api/marketplace/mercado-livre/atualizar-precos', wire.jobIdSchema, {
        integracaoId: input.integracaoId,
        baixarPreco: input.baixarPreco,
      }),
    enviarEstoque: (input) =>
      call(
        '/api/marketplace/mercado-livre/enviar-estoque',
        wire.envioEstoqueResultSchema,
        {
          integracaoId: input.integracaoId,
          produtoIds: input.produtoIds,
          reenviarComErro: input.reenviarComErro ?? false,
        },
        input.signal,
      ),
    enviarPrecos: (input) =>
      call(
        '/api/marketplace/mercado-livre/enviar-precos',
        wire.envioPrecoResultSchema,
        {
          integracaoId: input.integracaoId,
          produtoIds: input.produtoIds,
          baixarPreco: input.baixarPreco ?? false,
        },
        input.signal,
      ),
    priceSyncStatus: (input) =>
      call(
        `/api/marketplace/mercado-livre/atualizar-precos/status?integracaoId=${encodeURIComponent(input.integracaoId)}&jobId=${encodeURIComponent(input.jobId)}`,
        wire.priceSyncStatusSchema,
      ),
    jobsEmAndamento: (input) =>
      call(
        `/api/marketplace/mercado-livre/jobs-em-andamento?integracaoIds=${encodeURIComponent(input.integracaoIds.join(','))}`,
        wire.jobsEmAndamentoSchema,
      ),
    categorias: (input) =>
      call(
        `/api/marketplace/mercado-livre/categorias?integracaoId=${encodeURIComponent(input.integracaoId)}` +
          (input.categoryId ? `&categoryId=${encodeURIComponent(input.categoryId)}` : ''),
        wire.categoriasSchema,
      ),
    sugerirCategorias: (input) =>
      call(
        `/api/marketplace/mercado-livre/categorias/sugestoes?integracaoId=${encodeURIComponent(input.integracaoId)}` +
          `&q=${encodeURIComponent(input.q)}` +
          (input.limit == null ? '' : `&limit=${String(input.limit)}`),
        wire.sugestoesCategoriaSchema,
      ),
    categoriaAtributos: (input) =>
      call(
        `/api/marketplace/mercado-livre/categorias/atributos?integracaoId=${encodeURIComponent(input.integracaoId)}` +
          `&categoryId=${encodeURIComponent(input.categoryId)}` +
          (input.escopo == null ? '' : `&escopo=${input.escopo}`),
        wire.categoriaAtributosSchema,
      ),
    anuncioTeste: (integracaoId) =>
      call(
        `/api/marketplace/mercado-livre/anuncio-teste?integracaoId=${encodeURIComponent(integracaoId)}`,
        wire.anuncioTesteSchema,
      ),
    responderConversa: (input) =>
      call('/api/marketplace/mercado-livre/chat/responder', wire.respostaChatSchema, input),
    reclamacaoEstado: (input) =>
      call(
        `/api/marketplace/mercado-livre/reclamacao/estado?integracaoId=${encodeURIComponent(input.integracaoId)}&claimId=${encodeURIComponent(String(input.claimId))}`,
        wire.reclamacaoEstadoSchema,
      ),
    reclamacaoAcao: (input) =>
      call(
        '/api/marketplace/mercado-livre/reclamacao/acao',
        wire.reclamacaoAcaoResultSchema,
        input,
      ),
    acaoPergunta: (input) =>
      call(
        '/api/marketplace/mercado-livre/chat/pergunta-acao',
        wire.acaoPerguntaResultSchema,
        input,
      ),
    usuariosTeste: async (integracaoId) => {
      const { usuarios } = await call(
        `/api/marketplace/mercado-livre/usuarios-teste?integracaoId=${encodeURIComponent(integracaoId)}`,
        wire.usuariosTesteListSchema,
      );
      return { usuarios };
    },
    criarUsuariosTeste: (integracaoId) =>
      // `{}` is what makes this a POST — `call` picks the method from the
      // presence of a body. The id stays in the query string so both verbs read
      // it the same way. An empty body is ALSO the pair bootstrap on the
      // backend, so this stays correct if the placeholder ever goes away.
      call(
        `/api/marketplace/mercado-livre/usuarios-teste?integracaoId=${encodeURIComponent(integracaoId)}`,
        wire.usuariosTesteResultSchema,
        {},
      ),
    criarUsuarioTesteAvulso: async (integracaoId, role, opts) =>
      exigirMintAvulso(
        await call(
          `/api/marketplace/mercado-livre/usuarios-teste?integracaoId=${encodeURIComponent(integracaoId)}`,
          wire.usuariosTesteResultSchema,
          // ⚠️ Sent explicitly rather than omitted when false: the backend's
          // schema rejects unknown keys, so a typo here is a 400 rather than a
          // silently-skipped revocation.
          { role, manterCredencial: opts?.manterCredencial ?? false },
        ),
        role,
      ),
    iaModelos: (agenteId) =>
      call(
        '/api/marketplace/mercado-livre/ia/modelos' +
          (agenteId != null ? `?agente=${encodeURIComponent(agenteId)}` : ''),
        wire.iaModelosSchema,
      ),
    sizeChartDomains: (integracaoId) =>
      call(
        `/api/marketplace/mercado-livre/size-charts/domains?integracaoId=${encodeURIComponent(integracaoId)}`,
        wire.chartDomainsSchema,
      ),
    sizeChartSpecs: (input) =>
      call('/api/marketplace/mercado-livre/size-charts/specs', wire.chartSpecsSchema, input),
    sugerirAtributos: (input) =>
      call('/api/marketplace/mercado-livre/sugerir-atributos', wire.atributosSugestaoSchema, input),
    sugerirMedidas: ({ fatos, ...rest }) =>
      // `fatos` → `facts` on the wire: the route's own vocabulary is English,
      // and renaming here keeps the browser-facing API consistent with the rest
      // of this client.
      call('/api/marketplace/mercado-livre/sugerir-medidas', wire.medidasSugestaoSchema, {
        ...rest,
        ...(fatos ? { facts: fatos } : {}),
      }),
    sizeChartSync: (input) =>
      call('/api/marketplace/mercado-livre/size-charts/sync', wire.syncChartsResultSchema, input),
    sizeChartExcluir: (input) =>
      call(
        '/api/marketplace/mercado-livre/size-charts/excluir',
        wire.chartDeleteResultSchema,
        input,
      ),
    sizeChartVerificarExclusao: (input) =>
      call(
        '/api/marketplace/mercado-livre/size-charts/verificar-exclusao',
        wire.chartDeleteCheckResultSchema,
        input,
      ),
    etiqueta: (pedidoId, formato) =>
      fetchArtifact(
        `/api/marketplace/mercado-livre/etiqueta?pedidoId=${encodeURIComponent(pedidoId)}&formato=${formato}`,
        // ML's PDF endpoint may still hand back a ZIP batch — the route
        // byte-sniffs the real Content-Type; these are only header fallbacks.
        formato === 'pdf'
          ? { filename: `etiqueta-${pedidoId}.pdf`, contentType: 'application/pdf' }
          : { filename: `etiqueta-${pedidoId}.zip`, contentType: 'application/zip' },
      ),
    enviarNfe: (input) =>
      call('/api/marketplace/mercado-livre/enviar-nfe', wire.enqueuedSchema, input),
  };
}

export function useMercadoLivreClient(): MercadoLivreClient | null {
  const { user } = useAuth();
  return useMemo(() => {
    if (!user) return null;
    const baseUrl = process.env.NEXT_PUBLIC_MERCADO_LIVRE_URL ?? DEFAULT_MERCADO_LIVRE_URL;
    return createMercadoLivreClient({
      baseUrl,
      getAuthToken: () => user.getIdToken(),
    });
  }, [user]);
}
