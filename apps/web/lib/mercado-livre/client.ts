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

import { useAuth } from '@/lib/auth/useAuth';

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

export interface MercadoLivreConta {
  connected: boolean;
  me: { id: number; nickname: string | null; email: string | null } | null;
}

export interface MercadoLivrePublicarResult {
  itemId: string;
  /** Old-shape estado code, 1–2 chars ('p' publicado, 'pa' pausado, 'E' erro, …). */
  estado: string;
  permalink: string | null;
}

export interface MercadoLivreReverificarResult {
  /** Old-shape estado code derived from the listing's fresh ML status. */
  estado: string;
  /** Raw ML `status` as of the re-check (`active`/`paused`/`closed`/…). */
  status: string | null;
  subStatus: string[] | null;
  /** Whether the stock sweep will send to this listing again. */
  enviavel: boolean;
}

export interface MercadoLivreImportarResult {
  /** The created/updated ERP produto id. */
  produtoId: string;
  /** Old-shape estado code derived from the ML listing status. */
  estado: string;
  nome: string;
  /** True when a new produto was created (false = an existing one was re-synced). */
  created: boolean;
}

/** The `massImportOptionsSchema` booleans — all optional here, server defaults the rest. */
export interface MercadoLivreMassImportOptions {
  importarEstoque?: boolean;
  sobrescreverEstoque?: boolean;
  importarPreco?: boolean;
  sobrescreverPreco?: boolean;
  atualizarProdutoPai?: boolean;
  importarFotos?: boolean;
  importarCategorias?: boolean;
  /** Default false — a re-scan skips listings already linked to this account. */
  atualizarCadastrados?: boolean;
}

/** One per-item failure recorded on a mass-import job (capped server-side). */
export interface MercadoLivreMassImportFailure {
  itemId: string;
  error: string;
}

/** Progress snapshot of a mass-import job (`GET importar-todos/status`). */
export interface MercadoLivreMassImportStatus {
  status: 'running' | 'completed' | 'failed';
  scanned: number;
  imported: number;
  created: number;
  skipped: number;
  failureCount: number;
  failures: MercadoLivreMassImportFailure[];
  startedAt: number;
  finishedAt: number | null;
  erro: string | null;
}

/** One contained per-item skip on a price-sync job (`itemId` is null for plan-time skips). */
export interface MercadoLivrePriceSyncSkip {
  itemId: string | null;
  produtoId: string;
  code: string;
}

/** One per-item failure recorded on a price-sync job — a skip plus its error (capped server-side). */
export interface MercadoLivrePriceSyncFailure extends MercadoLivrePriceSyncSkip {
  error: string;
}

/** Progress snapshot of a price-sync job (`GET atualizar-precos/status`). */
export interface MercadoLivrePriceSyncStatus {
  status: 'running' | 'completed' | 'failed';
  baixarPreco: boolean;
  planejados: number;
  enviados: number;
  pulados: number;
  falhas: number;
  pausas: number;
  /** The first skips, for display — capped server-side; `pulados` stays exact. */
  skips: MercadoLivrePriceSyncSkip[];
  /** The first failures, for display — capped server-side; `falhas` stays exact. */
  failures: MercadoLivrePriceSyncFailure[];
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  erro: string | null;
}

/**
 * One listing's outcome from an on-demand stock push (#819).
 *
 * Channel-NEUTRAL on purpose (`anuncioId`, not `itemId`): the second
 * marketplace's `/api/marketplace/<canal>/enviar-estoque` answers with the same
 * envelope, and `lib/marketplace/estoque` dispatches without knowing which one
 * replied.
 */
export interface MercadoLivreEnvioEstoqueListing {
  produtoId: string;
  produtoNome: string | null;
  variacaoProdutoId: string | null;
  anuncioId: string | null;
  linkDocId: string | null;
  outcome: 'enviado' | 'pulado' | 'falha' | 'nao-tentado';
  /** Machine code; null only on `'enviado'`. */
  motivo: string | null;
  /** Operator-facing pt-BR text — the BACKEND owns this wording. */
  mensagem: string;
  quantidade: number | null;
  variacoes: number | null;
  rearme: { executado: boolean; estado: string | null; enviavel: boolean } | null;
}

/** A requested produto that produced no listing at all, and why. */
export interface MercadoLivreEnvioEstoqueSemEnvio {
  produtoId: string;
  produtoNome: string | null;
  motivo: string;
  mensagem: string;
}

export interface MercadoLivreEnvioEstoqueResult {
  canal: 'mercado-livre';
  integracaoId: string;
  contaNome: string | null;
  solicitados: number;
  familias: number;
  resumo: { enviados: number; pulados: number; falhas: number; naoTentados: number };
  listings: MercadoLivreEnvioEstoqueListing[];
  produtosSemEnvio: MercadoLivreEnvioEstoqueSemEnvio[];
  /** ISO-8601 — set when the conta is rate-limit paused. */
  pausadoAte: string | null;
}

/**
 * The RUNNING jobs of both bulk flows for a set of contas
 * (`GET jobs-em-andamento`). Each entry carries the `jobId` the caller then
 * polls through the per-flow `…Status` methods, plus the `integracaoId` that
 * places it against a row. Running-only by design: a job that finished while
 * the page was closed is not listed (#816).
 */
export interface MercadoLivreJobsEmAndamento {
  importacoes: Array<MercadoLivreMassImportStatus & { jobId: string; integracaoId: string }>;
  enviosPreco: Array<MercadoLivrePriceSyncStatus & { jobId: string; integracaoId: string }>;
}

/** A node of the ML category tree (`GET categorias`). */
export interface MercadoLivreCategoriaNo {
  id: string;
  name: string | null;
}

export interface MercadoLivreCategorias {
  /** Populated only when no `categoryId` was asked for. */
  roots: MercadoLivreCategoriaNo[] | null;
  node: {
    id: string;
    name: string | null;
    /** Ancestors, root-first — the cascade's breadcrumb. */
    pathFromRoot: MercadoLivreCategoriaNo[];
    children: MercadoLivreCategoriaNo[];
    /** Only a leaf has listing types and attributes. */
    isLeaf: boolean;
    settings: Record<string, unknown> | null;
  } | null;
}

/** One ML category suggestion (`GET categorias/sugestoes`). */
export interface MercadoLivreCategoriaSugestao {
  categoryId: string;
  categoryName: string | null;
  domainId: string | null;
  domainName: string | null;
  /**
   * Ancestor trail, root-first, resolved server-side because
   * `domain_discovery/search` returns only the LEAF name.
   *
   * ⚠️ Without it the picker is unusable, not merely terse: ML files the same
   * leaf name (e.g. "Camisetas e Regatas") under several different parents, so
   * every suggestion renders identically and the operator cannot tell which is
   * which. `null` when the path could not be resolved — the row degrades to its
   * leaf name rather than disappearing.
   */
  pathFromRoot: Array<{ id: string; name: string | null }> | null;
}

/**
 * One editable ML category attribute (`GET categorias/atributos`).
 *
 * Already filtered and normalised server-side: ERP-owned ids (SELLER_SKU,
 * PACKAGE_*), hidden attributes, size-chart attributes and out-of-scope
 * variation attributes never appear here, and the list arrives ordered
 * required-first.
 */
export interface MercadoLivreCategoriaAtributo {
  id: string;
  name: string | null;
  /** `string | number | number_unit | boolean | list`, or whatever ML adds. */
  valueType: string | null;
  values: Array<{ id: string | null; name: string | null }>;
  /** Helper text (`hint`, falling back to `tooltip`). */
  hint: string | null;
  valueMaxLength: number | null;
  defaultUnit: string | null;
  allowedUnits: Array<{ id: string | null; name: string | null }>;
  groupId: string | null;
  groupName: string | null;
  required: boolean;
  multivalued: boolean;
  readOnly: boolean;
  relevance: number | null;
}

export interface MercadoLivreCategoriaAtributos {
  /** False ⇒ a mid-tree category; keep the operator in the cascade. */
  leaf: boolean;
  atributos: MercadoLivreCategoriaAtributo[];
  /** Why an attribute was withheld, so a gap is explainable. */
  omitidos: Array<{ id: string; motivo: string }>;
}

/** The listing types available for a leaf category (`GET tipos-anuncio`). */
export interface MercadoLivreTiposAnuncio {
  leaf: boolean;
  tipos: MercadoLivreCategoriaNo[];
}

/**
 * `GET /anuncio-teste` — the data ML requires a test listing to carry, resolved
 * against the live catalogue, plus whether the target account is a test user.
 */
export interface MercadoLivreAnuncioTeste {
  title: string;
  descricao: string;
  /**
   * A **leaf** under ML's "Outros", which the route descends to — only a leaf can
   * be published into. Null when the site has no such root, or when no leaf is
   * reachable beneath it within the depth cap; the operator then picks.
   */
  categoryId: string | null;
  /**
   * Names from the "Outros" root down to `categoryId`, so the alert can say which
   * category was chosen. Null whenever `categoryId` is.
   */
  categoriaPath: string[] | null;
  /** Lowest-exposure type the category offers; null ⇒ the operator picks. */
  listingTypeId: string | null;
  conta: {
    nickname: string | null;
    /** False ⇒ warn: ML forbids test listings on a real seller account. */
    ehContaDeTeste: boolean;
  };
}

/** One model the AI settings page may offer. */
export interface MercadoLivreIaModelo {
  id: string;
  label: string;
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
}

/** One suggested cell. `value_id` is set only for a closed-list match. */
export interface MercadoLivreMedidaSugestao {
  rowKey: string;
  attributeId: string;
  value_id: string | null;
  value_name: string;
}

/** `POST /sugerir-medidas` — staged suggestions, never applied server-side. */
/**
 * One attribute the model proposes, in the shape the listing's rows already use.
 *
 * ⚠️ Redeclared here rather than imported. `@delfrance/integrations-mercado-livre`
 * is server-only at its root (its OAuth core holds the app clientSecret), which
 * is why every ML wire type in this file is a local declaration.
 */
export interface MercadoLivreAtributoSugestao {
  id: string;
  /** ML's enumerated value id, the `-1` N/A sentinel, or null for free text. */
  value_id: string | null;
  value_name: string;
  unit_id: string | null;
}

/** `POST /sugerir-atributos` — suggestions to STAGE, never applied by the server. */
export interface MercadoLivreAtributosSugestao {
  /** False ⇒ a mid-tree category; no model call was made. */
  leaf: boolean;
  /** How many attributes were offered to the model. */
  atributos: number;
  sugestoes: MercadoLivreAtributoSugestao[];
  /** Whether a produto photo reached the model at all. */
  comFoto: boolean;
}

export interface MercadoLivreMedidasSugestao {
  sugestoes: MercadoLivreMedidaSugestao[];
  /** How many cells were offered to the model. */
  celulas: number;
  /** Whether a photo reached the model at all. */
  comFoto: boolean;
  /** True when a cap or a duplicate size label dropped part of the grid. */
  truncado: boolean;
}

/** `GET /ia/modelos` — the catalogue plus the currently effective resolution. */
export interface MercadoLivreIaModelos {
  modelos: MercadoLivreIaModelo[];
  /**
   * `'live'` = straight from the provider. `'fallback'` = the shipped list,
   * because the provider could not be reached or answered nothing usable. The
   * page must say which, rather than implying the catalogue is current.
   */
  fonte: 'live' | 'fallback';
  /** Why the list is a fallback. Present only when `fonte === 'fallback'`. */
  erro?: string;
  /**
   * The shipped system instruction, verbatim — what runs when `promptSistema` is
   * left empty.
   *
   * ⚠️ It arrives over the wire rather than being imported: the ML integrations
   * package root is **server-only** (its OAuth core holds the app clientSecret),
   * and a copy kept in `apps/web` would drift from the text the model is
   * actually given.
   */
  promptPadrao: string;
  efetivo: {
    /** What a suggestion would use right now. */
    modelo: string;
    /** True ⇒ the stored model is not served and this is a substitute. */
    substituido: boolean;
    /**
     * Which link of the chain won. `'env'` is the one worth surfacing: a
     * backend env var silently overrides the shipped default and the operator
     * has no other way to discover it.
     */
    origem: 'config' | 'env' | 'padrao';
    padrao: string;
  };
}

/** One chart-enabled ML domain (`GET size-charts/domains`). */
export interface MercadoLivreChartDomain {
  domain_id: string;
  name: string | null;
}

/**
 * The domain technical-specs tree (`POST size-charts/specs`) — deeply nested,
 * ML-owned and consumed only by the chart editor's walk, so it stays opaque
 * here (`unknown`); `chartSpec.ts` reads it defensively.
 */
export type MercadoLivreChartSpecs = Record<string, unknown>;

/** One ML chart-validation problem (`POST size-charts/sync` → 200 data). */
export interface MercadoLivreChartValidationError {
  chartIndex: number;
  code: string | null;
  message: string | null;
  /** Offending row, or null for a chart-level problem (a rejected name, …). */
  rowIndex: number | null;
  /** Attribute ids the cell covers — more than one for a combined column. */
  attributeIds: string[];
  /** The row's main-attribute value as ML echoed it, for when `rowIndex` is null. */
  rowMainValue: string | null;
}

export interface MercadoLivreSyncChartsResult {
  /** The charts after the sync (ML ids written back where accepted). */
  tabelas: unknown[];
  validationErrors: MercadoLivreChartValidationError[];
  updated: boolean;
}

/** `POST size-charts/excluir` — ML accepted the REMOVAL REQUEST (see the method doc). */
export interface MercadoLivreChartDeleteResult {
  requested: true;
  message: string | null;
  tabelas: unknown[];
}

/** `POST size-charts/verificar-exclusao` — the verdict on a pending removal. */
export interface MercadoLivreChartDeleteCheckResult {
  /** True ⇒ ML confirmed the removal and the guia is off the tabMedi doc. */
  removed: boolean;
  /** `'ACTIVE'` = still linked to a listing; null once ML stopped serving it. */
  chartStatus: string | null;
  tabelas: unknown[];
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
  /** The listing types ML offers for a LEAF category (PERM.integracao.read). */
  tiposAnuncio(input: {
    integracaoId: string;
    categoryId: string;
  }): Promise<MercadoLivreTiposAnuncio>;
  /**
   * The documented test-listing data for this account (PERM.integracao.read).
   *
   * ⚠️ Read-only — it resolves what a test listing must look like and reports
   * whether the account is a test user. Publishing remains a separate,
   * deliberate click.
   */
  anuncioTeste(integracaoId: string): Promise<MercadoLivreAnuncioTeste>;
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
   * Ask a model to read the tabela's own photo and fill the grid
   * (PERM.integracao.write).
   *
   * Returns suggestions to STAGE — nothing is written on either side. `comFoto`
   * is load-bearing in the UI: a `false` means the model only had the
   * description, and a text-only answer to a transcription task is close to
   * worthless, so the operator must be able to tell that apart from a bad model.
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

  async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
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

    if (!res.ok) {
      const errBody = errorEnvelope(parsed);
      if (nonJsonBody != null) {
        // The body never reaches the UI, so keep it reachable for debugging.
        console.error(
          `[mercado-livre] resposta não-JSON em ${path} (HTTP ${String(res.status)})`,
          nonJsonBody.slice(0, 500),
        );
      }
      throw new MercadoLivreClientHttpError(
        errBody?.error ?? mercadoLivreHttpFallbackMessage(res.status),
        res.status,
        errBody?.code ?? null,
        Array.isArray(errBody?.issues) ? errBody.issues : null,
      );
    }
    return parsed as T;
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
        console.error(
          `[mercado-livre] resposta não-JSON em ${path} (HTTP ${String(res.status)})`,
          nonJsonBody.slice(0, 500),
        );
      }
      throw new MercadoLivreClientHttpError(
        errBody?.error ?? mercadoLivreHttpFallbackMessage(res.status),
        res.status,
        errBody?.code ?? null,
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
      call<{ authorizeUrl: string }>(
        `/api/marketplace/mercado-livre/oauth/start?integracaoId=${encodeURIComponent(integracaoId)}`,
      ),
    conta: (integracaoId) =>
      call<MercadoLivreConta>(
        `/api/marketplace/mercado-livre/conta?integracaoId=${encodeURIComponent(integracaoId)}`,
      ),
    publicar: (input) =>
      call<MercadoLivrePublicarResult>('/api/marketplace/mercado-livre/publicar', input),
    reverificarAnuncio: (input) =>
      call<MercadoLivreReverificarResult>(
        '/api/marketplace/mercado-livre/reverificar-anuncio',
        input,
      ),
    importar: (input) =>
      call<MercadoLivreImportarResult>('/api/marketplace/mercado-livre/importar', input),
    startMassImport: (input) =>
      call<{ jobId: string }>('/api/marketplace/mercado-livre/importar-todos', {
        integracaoId: input.integracaoId,
        options: input.options,
      }),
    massImportStatus: (input) =>
      call<MercadoLivreMassImportStatus>(
        `/api/marketplace/mercado-livre/importar-todos/status?integracaoId=${encodeURIComponent(input.integracaoId)}&jobId=${encodeURIComponent(input.jobId)}`,
      ),
    startPriceSync: (input) =>
      call<{ jobId: string }>('/api/marketplace/mercado-livre/atualizar-precos', {
        integracaoId: input.integracaoId,
        baixarPreco: input.baixarPreco,
      }),
    enviarEstoque: (input) =>
      call<MercadoLivreEnvioEstoqueResult>(
        '/api/marketplace/mercado-livre/enviar-estoque',
        {
          integracaoId: input.integracaoId,
          produtoIds: input.produtoIds,
          reenviarComErro: input.reenviarComErro ?? false,
        },
        input.signal,
      ),
    priceSyncStatus: (input) =>
      call<MercadoLivrePriceSyncStatus>(
        `/api/marketplace/mercado-livre/atualizar-precos/status?integracaoId=${encodeURIComponent(input.integracaoId)}&jobId=${encodeURIComponent(input.jobId)}`,
      ),
    jobsEmAndamento: (input) =>
      call<MercadoLivreJobsEmAndamento>(
        `/api/marketplace/mercado-livre/jobs-em-andamento?integracaoIds=${encodeURIComponent(input.integracaoIds.join(','))}`,
      ),
    categorias: (input) =>
      call<MercadoLivreCategorias>(
        `/api/marketplace/mercado-livre/categorias?integracaoId=${encodeURIComponent(input.integracaoId)}` +
          (input.categoryId ? `&categoryId=${encodeURIComponent(input.categoryId)}` : ''),
      ),
    sugerirCategorias: (input) =>
      call<{ sugestoes: MercadoLivreCategoriaSugestao[] }>(
        `/api/marketplace/mercado-livre/categorias/sugestoes?integracaoId=${encodeURIComponent(input.integracaoId)}` +
          `&q=${encodeURIComponent(input.q)}` +
          (input.limit == null ? '' : `&limit=${String(input.limit)}`),
      ),
    categoriaAtributos: (input) =>
      call<MercadoLivreCategoriaAtributos>(
        `/api/marketplace/mercado-livre/categorias/atributos?integracaoId=${encodeURIComponent(input.integracaoId)}` +
          `&categoryId=${encodeURIComponent(input.categoryId)}` +
          (input.escopo == null ? '' : `&escopo=${input.escopo}`),
      ),
    tiposAnuncio: (input) =>
      call<MercadoLivreTiposAnuncio>(
        `/api/marketplace/mercado-livre/tipos-anuncio?integracaoId=${encodeURIComponent(input.integracaoId)}` +
          `&categoryId=${encodeURIComponent(input.categoryId)}`,
      ),
    anuncioTeste: (integracaoId) =>
      call<MercadoLivreAnuncioTeste>(
        `/api/marketplace/mercado-livre/anuncio-teste?integracaoId=${encodeURIComponent(integracaoId)}`,
      ),
    iaModelos: (agenteId) =>
      call<MercadoLivreIaModelos>(
        '/api/marketplace/mercado-livre/ia/modelos' +
          (agenteId != null ? `?agente=${encodeURIComponent(agenteId)}` : ''),
      ),
    sizeChartDomains: (integracaoId) =>
      call<{ domains: MercadoLivreChartDomain[] }>(
        `/api/marketplace/mercado-livre/size-charts/domains?integracaoId=${encodeURIComponent(integracaoId)}`,
      ),
    sizeChartSpecs: (input) =>
      call<MercadoLivreChartSpecs>('/api/marketplace/mercado-livre/size-charts/specs', input),
    sugerirAtributos: (input) =>
      call<MercadoLivreAtributosSugestao>(
        '/api/marketplace/mercado-livre/sugerir-atributos',
        input,
      ),
    sugerirMedidas: (input) =>
      call<MercadoLivreMedidasSugestao>('/api/marketplace/mercado-livre/sugerir-medidas', input),
    sizeChartSync: (input) =>
      call<MercadoLivreSyncChartsResult>('/api/marketplace/mercado-livre/size-charts/sync', input),
    sizeChartExcluir: (input) =>
      call<MercadoLivreChartDeleteResult>(
        '/api/marketplace/mercado-livre/size-charts/excluir',
        input,
      ),
    sizeChartVerificarExclusao: (input) =>
      call<MercadoLivreChartDeleteCheckResult>(
        '/api/marketplace/mercado-livre/size-charts/verificar-exclusao',
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
      call<{ enqueued: boolean }>('/api/marketplace/mercado-livre/enviar-nfe', input),
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
