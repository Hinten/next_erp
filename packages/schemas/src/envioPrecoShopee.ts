import { z } from 'zod';
import { envioPrecoFailureSchema, envioPrecoSkipSchema } from './envioPrecoMercadoLivre';
import { millisSinceEpoch } from './shared/datetime';
import { ttlExpiry } from './shared/ttl';

/**
 * `enviosPrecoShopee` (TOP-LEVEL) — the checkpoint/progress doc for the Shopee
 * "Atualizar preços" account-wide price job (master-plan step 13, #1521). ONE
 * document per run, auto id; the authed `atualizar-precos` route creates it,
 * the nested Cloud Function (`processShopeePriceSync`) drives it a bounded
 * batch per dispatch, and the status route reads it back for the UI to poll.
 * Its per-item report is sharded under it, in
 * `enviosPrecoShopee/{envioId}/relatorios`, and binds the SHARED
 * `relatorioEnvioPrecoSchema` (`./relatorioEnvioPrecoMercadoLivre`) — no second
 * report schema, because the row is channel-neutral and a twin would be two
 * definitions of one row that a CSV builder must then read twice.
 *
 * The shape is `envioPrecoMercadoLivre`'s twin, with three deliberate
 * differences:
 *
 *  - **The queue holds IDENTITIES, never prices.** ML freezes `preco` into its
 *    fila entry at plan time. This job may PARK a planned page across a daily
 *    quota rollover (up to ~24 h), and a frozen price would then send a day-old
 *    tabela value — so each entry names the listing and its models, and the job
 *    reads the `precos` of the items it drains seconds before sending them.
 *  - **No reconciliation phase** (`afterLinkPath`, `reconciliacaoConcluida`,
 *    `naoEnumerados`, …). Nothing here produces the `'reconciliacao'` fase.
 *  - **`parques` / `retomarEm`** — the daily-quota park, which ML has no
 *    counterpart for.
 *
 * `skips` / `failures` REUSE ML's `envioPrecoSkipSchema` /
 * `envioPrecoFailureSchema`: the sample row is the same fact on both channels,
 * and ⚠️ its `itemId` is therefore a STRING there — the job writes the Shopee
 * number's decimal spelling. The fila's `itemId` below stays a NUMBER.
 *
 * ## ⚠️ Units
 *
 * **Every stamp in this document is MILLISECONDS** (`startedAt`, `updatedAt`,
 * `finishedAt`, `retomarEm`) — the discipline `importacaoShopee`,
 * `estoqueShopeeSync` and `backfillPedidosShopee` carry, which keeps this
 * document off the µs SITE list `apps/shopee/CLAUDE.md` maintains. A
 * cross-unit comparison is "a guard that never fires" (root `CLAUDE.md`
 * rule 7). The ONE non-epoch instant is `expiraEm`, a real `Date` /
 * `Timestamp` — see its own docblock.
 *
 * ## ⚠️ Every field carries a `.default()`, and every array default is a FUNCTION
 *
 * A job doc written before a field shipped must still parse, or an in-flight
 * run stops resuming the moment the backend is deployed under it (ML's
 * retrofit lesson). Only `integracaoId`, `status`, `startedAt` and `updatedAt`
 * are required — no job doc is ever written without them.
 *
 * The array defaults are written as a FUNCTION (`() => []`). Zod 4 (4.4.3,
 * read from its `_default`) shallow-clones a VALUE default on every parse,
 * while Zod 3 handed the very same array back by reference — so a drain that
 * shifted one parsed `fila` would have left the schema's own default non-empty
 * for the rest of the process. The function form is correct under both, and
 * does not depend on which one the catalog resolves.
 *
 * ## Admin-only / default-deny
 *
 * NOT registered in `ALL_DOMAINS`, and this file deliberately exports NO
 * `…Meta` object (the report file's posture): pairing a schema with a meta is
 * what `registry.test.ts`'s `isDomainSchema()` sweeps, and a registration would
 * emit a rules match block — forcing `gen:rules` + `gen:rules:e2e` + two
 * snapshot refreshes + a manual rules deploy for a collection no browser can
 * read. Only the authed routes and the nested `apps/shopee/functions` codebase
 * (Admin SDK) ever touch it.
 *
 * ⚠️ The job's two queries — the start guard's `(integracaoId, status)` and the
 * history's `(integracaoId, startedAt DESC)` — ride composites declared by hand
 * in `firestore.indexes.json`: there is no `meta.defaultQuery` here, so
 * `delfrance/default-query-needs-index` cannot see them, and on Firestore
 * Enterprise a missing composite does not throw — it full-scans and bills.
 * Deploying them (and the TTL policy below) belongs to the migration window
 * (#1532).
 *
 * ⚠️ The collection name deliberately does not start with `notificacoes`:
 * `notificationGuardrails`' checks fire on every admin collection path with
 * that prefix and would demand a pipeline consumer this job doc does not have.
 */

/**
 * One price job's lifecycle: `running` → `completed` | `failed` | `cancelled`.
 *
 * ⚠️ A PARKED job is `running` with {@link envioPrecoShopeeSchema}'s
 * `retomarEm` set — parking is not a status, so the one-active guard keeps
 * seeing it and the operator's cancel still reaches it.
 *
 * `cancelled` is operator-initiated (the `atualizar-precos/cancelar` route),
 * the other two are stamped by the task handler — so the field has
 * uncoordinated writers, and every terminal stamp goes through the job
 * module's ONE transaction, which re-derives "still running" from the `tx.get`
 * snapshot. A plain `merge()` would let a dispatch finishing right after a
 * cancel bury it under `completed` (root `CLAUDE.md` rule 7).
 */
export const envioPrecoShopeeStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled']);
export type EnvioPrecoShopeeStatus = z.infer<typeof envioPrecoShopeeStatusSchema>;

/** Named members of {@link envioPrecoShopeeStatusSchema}. */
export const ENVIO_PRECO_SHOPEE_STATUS = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
} as const satisfies Record<string, EnvioPrecoShopeeStatus>;

/**
 * One model a queued listing addresses — an IDENTITY, no price.
 *
 * `.passthrough()`: the fila round-trips through a schema parse on every
 * persisted checkpoint, so a key a newer planner adds must survive an older
 * consumer's rewrite (ML's fila posture).
 */
export const envioPrecoShopeeModeloSchema = z
  .object({
    /**
     * Shopee's `model_id`, a positive integer. ⚠️ A NUMBER — a stringified id
     * matches nothing — and never the no-model `0`: a no-model listing has NO
     * entry here at all.
     */
    modelId: z.number().int().positive(),
    /** The CHILD produto whose `precos` price this model at drain time. */
    produtoId: z.string().min(1),
    /** The `variashopee` document the per-model write-back stamps. */
    varLinkDocId: z.string().min(1),
  })
  .passthrough();
export type EnvioPrecoShopeeModelo = z.infer<typeof envioPrecoShopeeModeloSchema>;

/**
 * One queued listing — exactly the planner's `ItemPlanejadoPreco`
 * (`apps/shopee/lib/shopee/precos/planoPreco.ts`): the fila entry IS the planned
 * item. That app declares the interface and this schema must match it; a type
 * test in `apps/shopee/lib/shopee/precos/filaPreco.types.test.ts` pins the two
 * together, because this package cannot import the app.
 *
 * Same `.passthrough()` posture as {@link envioPrecoShopeeModeloSchema}.
 */
export const envioPrecoShopeeFilaItemSchema = z
  .object({
    /** The family ANCHOR — the produto that owns the `prodshopee` link. */
    produtoId: z.string().min(1),
    /** The `prodshopee` document id — the write-back target, never re-resolved. */
    linkDocId: z.string().min(1),
    /**
     * Shopee's `item_id`. ⚠️ A NUMBER: a stringified id matches nothing on the
     * `prodshopee` composite, silently.
     */
    itemId: z.number().int().positive(),
    /** `[]` ⇔ a NO-MODEL listing (one write, at the anchor's price). */
    modelos: z.array(envioPrecoShopeeModeloSchema).default(() => []),
  })
  .passthrough();
export type EnvioPrecoShopeeFilaItem = z.infer<typeof envioPrecoShopeeFilaItemSchema>;

export const envioPrecoShopeeSchema = z.object({
  /** The connected conta whose linked listings this job prices. */
  integracaoId: z.string().min(1),
  status: envioPrecoShopeeStatusSchema,
  /**
   * The operator's explicit opt-in to price DECREASES — default OFF, in which
   * case a lower price is refused per item.
   */
  baixarPreco: z.boolean().default(false),
  /** The plan's keyset cursor over anchor produtos — `null` before the first page. */
  afterAnchorId: z.string().nullable().default(null),
  /**
   * Disambiguates the `null` cursor: `null` + `false` = planning not started,
   * `null` + `true` = every page planned. Closes the re-plan window a crash
   * between the final plan checkpoint and the `completed` flip would open.
   */
  planejamentoConcluido: z.boolean().default(false),
  /**
   * At most one plan page's listings — IDENTITIES only (see the header),
   * refilled only when empty, and persisted after EVERY drained item so a
   * retry resumes exactly where it stopped.
   */
  fila: z.array(envioPrecoShopeeFilaItemSchema).default(() => []),
  /** LISTINGS the plan produced (informational). */
  planejados: z.number().int().default(0),
  /** Report ROWS (one per model) whose resultado is `enviado`. */
  enviados: z.number().int().default(0),
  /** Report rows whose resultado is `pulado` (may exceed `skips.length` past the cap). */
  pulados: z.number().int().default(0),
  /** Report rows whose resultado is `falha` (may exceed `failures.length` past the cap). */
  falhas: z.number().int().default(0),
  /** Burst rate-limit re-enqueues taken — a delayed self re-enqueue, no attempt consumed. */
  pausas: z.number().int().default(0),
  /** Daily-quota PARKS taken; the job module fails the run past its own ceiling. */
  parques: z.number().int().default(0),
  /**
   * MILLISECONDS. Set while the job is PARKED on Shopee's daily quota — the
   * instant the parked dispatch will resume (the next 00:00 UTC+8) — and
   * cleared by the resumed dispatch's first checkpoint. The orphan reclaim
   * honours it: a parked job's `updatedAt` legitimately stops moving for hours,
   * and reclaiming it as a dead run would start a second one beside it.
   */
  retomarEm: millisSinceEpoch().nullable().default(null),
  /**
   * The first skips, for the UI — CAPPED by the job module; the counters stay
   * exact, this list is a sample. ⚠️ The schema deliberately declares no cap:
   * a stored document that exceeds a later, smaller budget must still parse.
   */
  skips: z.array(envioPrecoSkipSchema).default(() => []),
  /** The first failures, for the UI (same cap rule as `skips`). */
  failures: z.array(envioPrecoFailureSchema).default(() => []),
  /**
   * Rows written to the `relatorios` subcollection so far. Doubles as the shard
   * CURSOR: `floor(relatorioLinhas / RELATORIO_ENVIO_PRECO_SHARD_SIZE)` is the
   * shard a new row lands in, a pure function of a value that only advances on
   * a committed checkpoint — so a retry recomputes the SAME shard index. An
   * upper bound on distinct rows, never an exact count (a replay overwrites a
   * key while still incrementing this).
   */
  relatorioLinhas: z.number().int().default(0),
  /** How many shard documents exist — what the download pages over. */
  relatorioShards: z.number().int().default(0),
  /**
   * The report covers the WHOLE run — written true only on the `completed`
   * flip. It is what keeps a partial report from reading as a clean one, and
   * what tells "nothing was planned" (0 shards, true) from "no report yet"
   * (0 shards, false).
   */
  relatorioCompleto: z.boolean().default(false),
  /**
   * Listings still queued when the job stopped short — written by every
   * terminal stamp that abandons a queue (a failure, the operator's cancel), and
   * paired with exactly ONE synthetic report row naming the cause.
   */
  filaRestante: z.number().int().default(0),
  /** The authed uid that started the run (`null` when unknown). */
  startedBy: z.string().nullable().default(null),
  /** ⚠️ MILLISECONDS — and the key every TTL stamp of this run derives from. */
  startedAt: millisSinceEpoch(),
  /**
   * Rewritten on every persisted checkpoint. A dispatch reuses one clock read
   * across its checkpoints, so the value is fresh, not strictly increasing —
   * the orphan reclaim only needs "recent enough". MS.
   */
  updatedAt: millisSinceEpoch(),
  finishedAt: millisSinceEpoch().nullable().default(null),
  /** Set only on `status: 'failed'` — never a body, never a credential. */
  erro: z.string().nullable().default(null),
  /**
   * TTL expiry (`./shared/ttl`, policy `enviosPrecoShopee`): stamped once, at
   * creation, `RETENCAO_ENVIO_PRECO_SHOPEE_DIAS` after `startedAt`; the report
   * shards carry their own stamp a week later. A real `Date` on write — a
   * numeric epoch is REFUSED here, because the policy silently ignores one and
   * the run would never expire. The TTL deletes the run and its shards in no
   * guaranteed order, so it is the history route (hiding a run once this has
   * passed) that keeps a truncated report off the list, not the margin.
   */
  expiraEm: ttlExpiry().nullable().optional(),
});
export type EnvioPrecoShopee = z.infer<typeof envioPrecoShopeeSchema>;

// NOTE: exported as BARE constants — no `…Meta`, no `{ schema, meta }`
// DomainSchema object, NOT in `ALL_DOMAINS` — so `registry.test.ts`'s
// `isDomainSchema()` never sweeps it in and rules-gen never sees it. The admin
// handles (`envioPrecoShopeeCollection`, `relatorioEnvioPrecoShopeeCollection`
// in `@delfrance/data/admin/collections`) spell the paths.
