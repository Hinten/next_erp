import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';

/**
 * `importacoesMercadoLivre` (TOP-LEVEL) — the checkpoint/progress doc for the
 * "Importar todos os anúncios" mass-import job (#621). This is an
 * **architecture upgrade over the legacy Flutter flow**, which drove the whole
 * scan+import loop client-side (`providers/importacao.dart`) with no resume:
 * one job doc here is the single source of truth for a Cloud Tasks-driven,
 * server-side loop that scans the seller's full listing set
 * (`GET /users/{id}/items/search?search_type=scan`) and imports each
 * unregistered item (`importProduto`, #519-#521), a bounded batch per dispatch,
 * re-enqueuing itself until the scan is exhausted and the queue (`fila`)
 * drains. Per-item failures are contained (not aborting the job) and recorded
 * up to a cap; the web UI polls this doc for progress.
 *
 * Fields split into three groups:
 *  - job identity/state: `integracaoId`, `status`, `options` (the mass-import
 *    toggles the route sanitizes from the request body);
 *  - the resumable cursor: `scrollId` (ML's scan cursor — `null` once the scan
 *    is exhausted) and `fila` (the unregistered ids still to import, drained
 *    `MASS_IMPORT_ITEMS_PER_DISPATCH` at a time, persisted after EVERY item so
 *    a retry resumes exactly where it left off);
 *  - progress counters (`scanned`/`imported`/`created`/`skipped`/
 *    `failureCount`/`failures`) surfaced to the UI as-is, and the terminal
 *    `finishedAt`/`erro`.
 *
 * Admin-only / default-deny: NOT registered in `ALL_DOMAINS` (mirrors
 * `notificacaoMercadoLivre` — same rationale: only the authed route
 * (`startMassImportJob`) and the nested Cloud Function
 * (`processMercadoLivreMassImport`) ever touch this collection, so there is no
 * client access and the rules generator emits no match block for it).
 */

/**
 * One mass-import job's lifecycle: `running` → `completed` | `failed` |
 * `cancelled`.
 *
 * `cancelled` is operator-initiated (the "Cancelar importação" action behind
 * the job card's close button) and is written by the `importar-todos/cancelar`
 * route, NOT by the task handler. It is terminal like the other two, which is
 * the whole point: `startMassImportJob` blocks on a `running` job with no
 * staleness bound, so a job whose task never dispatched would otherwise keep
 * the button returning 409 forever.
 *
 * ⚠️ The route and the task handler are therefore two writers of one field.
 * Every terminal stamp goes through `finalizeMassImportJob`, which re-derives
 * "still running" from the `tx.get` snapshot — a plain `merge()` would let a
 * dispatch finishing right after a cancel overwrite it with `completed` (root
 * `CLAUDE.md` rule 7).
 */
export const importacaoMercadoLivreStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export type ImportacaoMercadoLivreStatus = z.infer<typeof importacaoMercadoLivreStatusSchema>;

/** Named members of {@link importacaoMercadoLivreStatusSchema}. */
export const IMPORTACAO_MERCADO_LIVRE_STATUS = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
} as const satisfies Record<string, ImportacaoMercadoLivreStatus>;

/**
 * The mass-import toggles — the same per-item flags `ImportOptions` accepts
 * (`apps/mercado-livre/lib/marketplace/importacao/importCore.ts`) plus one mass-import-only
 * flag: `atualizarCadastrados` (default off — a plain re-scan only imports
 * items with NO existing link doc for this conta; turning this on also
 * re-drives already-registered items through the per-item import, which still
 * respects the other toggles' overwrite gates).
 */
export const massImportOptionsSchema = z.object({
  importarEstoque: z.boolean(),
  sobrescreverEstoque: z.boolean(),
  importarPreco: z.boolean(),
  sobrescreverPreco: z.boolean(),
  atualizarProdutoPai: z.boolean(),
  importarFotos: z.boolean(),
  importarCategorias: z.boolean(),
  /** Mass-import-only: also re-drive items that already have a link doc. */
  atualizarCadastrados: z.boolean(),
});
export type MassImportOptions = z.infer<typeof massImportOptionsSchema>;

/** One contained per-item import failure (`fila` drain, #621). */
export const massImportFailureSchema = z.object({
  itemId: z.string(),
  error: z.string(),
});
export type MassImportFailure = z.infer<typeof massImportFailureSchema>;

export const importacaoMercadoLivreSchema = z.object({
  /** The connected conta this job scans/imports for. */
  integracaoId: z.string().min(1),
  status: importacaoMercadoLivreStatusSchema,
  /** ML's scan cursor — `null` before the first page AND once exhausted. */
  scrollId: z.string().nullable().default(null),
  /** Unregistered item ids still queued for import, drained per dispatch. */
  fila: z.array(z.string()).default([]),
  /** Total ids seen across every scanned page (informational). */
  scanned: z.number().int().default(0),
  /** Items successfully run through `importProduto` (create OR update). */
  imported: z.number().int().default(0),
  /** Of `imported`, how many were first-time creates. */
  created: z.number().int().default(0),
  /** Ids the scan skipped as already-registered (when `atualizarCadastrados` is off). */
  skipped: z.number().int().default(0),
  /** Total per-item failures (may exceed `failures.length` past the cap). */
  failureCount: z.number().int().default(0),
  /** The first `MASS_IMPORT_FAILURES_CAP` failures, for the UI. */
  failures: z.array(massImportFailureSchema).default([]),
  options: massImportOptionsSchema,
  startedAt: millisSinceEpoch(),
  /** Bumped on every persisted checkpoint (scan page, per-item, terminal). */
  updatedAt: millisSinceEpoch(),
  finishedAt: millisSinceEpoch().nullable().default(null),
  /** Set only on `status: 'failed'` — the error that exhausted the retries. */
  erro: z.string().nullable().default(null),
});
export type ImportacaoMercadoLivre = z.infer<typeof importacaoMercadoLivreSchema>;
