import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';

/**
 * `importacoesShopee` (TOP-LEVEL) — the checkpoint/progress doc for the
 * "Importar todos os anúncios" Shopee mass-import job (master-plan step 9,
 * #1517). ONE document per run, auto id; the authed `importar-todos` route
 * creates it, the nested Cloud Function (`processShopeeMassImport`) drives it
 * to completion a bounded batch per dispatch, and the status route reads it
 * back for the UI to poll.
 *
 * The shape is `importacaoMercadoLivre`'s twin — deliberately, because step
 * 21's job card polls both and one DTO can only serve both while the counters
 * match. The Shopee-only fields are `nextOffset` (ML pages by an opaque
 * `scroll_id`, Shopee by an integer offset), `filaKits`, `kits`, and the
 * `{itemId, motivo, mensagem}` failure row (ML's is `{itemId, error}`).
 *
 * ## ⚠️ Units
 *
 * **Every stamp in this document is MILLISECONDS; the only SECONDS in it are
 * the two `…S` options, which are the wire's own unit and are never compared
 * against a stamp.**
 *
 * That is the same discipline `backfillPedidosShopee` and `liquidacaoShopee`
 * carry, and it keeps this document off the µs SITE list `apps/shopee/CLAUDE.md`
 * maintains: the importer writes produtos, whose stamps are ms. A cross-unit
 * comparison is "a guard that never fires" (root `CLAUDE.md` rule 7), so
 * `updateTimeFromS`/`updateTimeToS` name their unit in the field name and are
 * only ever handed to `get_item_list`.
 *
 * ## Field naming
 *
 * camelCase ENGLISH for mechanism fields, Portuguese for ERP nouns — ML's
 * spelling verbatim wherever the concept is identical. The two shipped Shopee
 * checkpoint schemas already do this (`cursorMs`, `pendingCursor`,
 * `lastSweepAtMs`, `lastError` beside `motivo`, `tentativas`, `pendentes`), so
 * Portuguese counters would make this the odd file out in its own app; `fila`
 * and `erro` stay Portuguese because ML spells them that way, which is the one
 * place "ML parity" and "house style" agree outright.
 *
 * ## ⚠️ Every field carries a `.default()`, from day one
 *
 * ML shipped eight required booleans and had to retrofit `.default(false)` on
 * the ninth: a job doc written before a field shipped fails a REQUIRED parse
 * mid-flight, so an in-flight import stops resuming the moment the backend is
 * deployed under it. Starting with defaults everywhere — including on the
 * `options` container itself — makes every future option additive by
 * construction. {@link OPCOES_IMPORTACAO_SHOPEE_PADRAO} is the one object every
 * default is built from, and the route's body sanitizer reads the same object,
 * so the schema and the route can never disagree.
 *
 * ⚠️ Every array default is written as a FUNCTION (`.default(() => [])`). Zod
 * hands a value-form default back by REFERENCE, so one parsed document's `fila`
 * would be the very same array as the next one's, and a drain that shifts it
 * would leave the schema's own default non-empty for the rest of the process.
 *
 * ## Admin-only / default-deny
 *
 * Permissions are `0n` and the schema is deliberately NOT registered in
 * `ALL_DOMAINS` (see the NOTE at the bottom), so the rules generator emits no
 * match block, Firestore default-denies every client read/write, and no rules
 * regeneration is needed for this file. Only the authed routes and the nested
 * `apps/shopee/functions` codebase (Admin SDK) ever touch this collection.
 *
 * ⚠️ The `(integracaoId, status)` composite this job's start guard queries is
 * declared by hand in `firestore.indexes.json`: there is no `meta.defaultQuery`
 * here, so `delfrance/default-query-needs-index` cannot see it, and on
 * Firestore Enterprise a missing composite does not throw — it full-scans and
 * bills. Deploy belongs to the migration window (#1532).
 */

/**
 * One mass-import job's lifecycle: `running` → `completed` | `failed` |
 * `cancelled`.
 *
 * `cancelled` is operator-initiated (the `importar-todos/cancelar` route), the
 * other two are stamped by the task handler — so the field has TWO uncoordinated
 * writers and every terminal stamp goes through the job module's one
 * transaction, which re-derives "still running" from the `tx.get` snapshot. A
 * plain `merge()` would let a dispatch finishing right after a cancel bury it
 * under `completed` (root `CLAUDE.md` rule 7).
 */
export const importacaoShopeeStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled']);
export type ImportacaoShopeeStatus = z.infer<typeof importacaoShopeeStatusSchema>;

/** Named members of {@link importacaoShopeeStatusSchema}. */
export const IMPORTACAO_SHOPEE_STATUS = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
} as const satisfies Record<string, ImportacaoShopeeStatus>;

/**
 * The statuses a mass import may ASK `get_item_list` for.
 *
 * ⚠️ FOUR of the six wire values. `SELLER_DELETE` and `SHOPEE_DELETE` are
 * REFUSED here and refused again per item (`item-deletado`): a deleted listing
 * stays readable for 90 days, and creating a produto from one would mint a
 * catalogue entry for something that no longer exists on the marketplace, with
 * nothing that ever removes it. The refusal lives in the ENUM rather than in a
 * filter so that a request body naming one gets a 400 that says so — dropping
 * it silently would import a narrower set than the operator asked for and
 * report success.
 *
 * ⚠️ This is the REQUEST-side vocabulary and is deliberately separate from
 * `shopeeItemStatusSchema` (`produto/collection/shopeeLink.ts`), which is the
 * six-value READ side stored on the link document. Narrowing the read side to
 * these four would fail a link write for a value Shopee legitimately returned.
 */
export const shopeeImportStatusSchema = z.enum(['NORMAL', 'UNLIST', 'BANNED', 'REVIEWING']);
export type ShopeeImportStatus = z.infer<typeof shopeeImportStatusSchema>;

/** Named members of {@link shopeeImportStatusSchema}. */
export const SHOPEE_IMPORT_STATUS = {
  normal: 'NORMAL',
  unlist: 'UNLIST',
  banned: 'BANNED',
  reviewing: 'REVIEWING',
} as const satisfies Record<string, ShopeeImportStatus>;

/**
 * The default status filter: NORMAL **and** UNLIST.
 *
 * ⚠️ The legacy Flutter importer only ever asked for NORMAL and never let the
 * operator choose, so every unlisted listing was structurally invisible for
 * years. `BANNED` and `REVIEWING` stay opt-in — they are states the seller is
 * expected to act on, not stock to mirror. ONE constant feeds the schema
 * default and the route's body sanitizer.
 */
export const SHOPEE_IMPORT_STATUS_PADRAO = [
  SHOPEE_IMPORT_STATUS.normal,
  SHOPEE_IMPORT_STATUS.unlist,
] as const;

/**
 * ONE source of truth for every import option's default — the schema's
 * `.default()`s AND the `importar-todos` route's sanitizer read this object, so
 * the two can never disagree, and a new option is added here once.
 */
export const OPCOES_IMPORTACAO_SHOPEE_PADRAO = {
  statuses: SHOPEE_IMPORT_STATUS_PADRAO,
  importarEstoque: true,
  sobrescreverEstoque: false,
  importarPreco: true,
  sobrescreverPreco: true,
  atualizarProdutoPai: true,
  sobrescreverDadosProduto: false,
  importarFotos: true,
  importarCategorias: true,
  atualizarCadastrados: false,
  updateTimeFromS: null,
  updateTimeToS: null,
} as const;

/**
 * The per-run import toggles — the same per-item flags the importer accepts,
 * plus the two mass-import-only ones (`atualizarCadastrados` and the
 * `update_time` window).
 */
export const importacaoShopeeOptionsSchema = z.object({
  /**
   * Which `item_status` values the scan asks `get_item_list` for. `.min(1)`
   * because the parameter is REQUIRED on the wire: an empty array emits no
   * query key at all and Shopee answers `error_param_item_status`, which reads
   * like a provider fault instead of our bug.
   */
  statuses: z
    .array(shopeeImportStatusSchema)
    .min(1)
    .default(() => [...OPCOES_IMPORTACAO_SHOPEE_PADRAO.statuses]),
  importarEstoque: z.boolean().default(OPCOES_IMPORTACAO_SHOPEE_PADRAO.importarEstoque),
  sobrescreverEstoque: z.boolean().default(OPCOES_IMPORTACAO_SHOPEE_PADRAO.sobrescreverEstoque),
  importarPreco: z.boolean().default(OPCOES_IMPORTACAO_SHOPEE_PADRAO.importarPreco),
  sobrescreverPreco: z.boolean().default(OPCOES_IMPORTACAO_SHOPEE_PADRAO.sobrescreverPreco),
  atualizarProdutoPai: z.boolean().default(OPCOES_IMPORTACAO_SHOPEE_PADRAO.atualizarProdutoPai),
  /** Let a re-import REPLACE produto data the ERP already holds (ML's #1087 carve-out). */
  sobrescreverDadosProduto: z
    .boolean()
    .default(OPCOES_IMPORTACAO_SHOPEE_PADRAO.sobrescreverDadosProduto),
  importarFotos: z.boolean().default(OPCOES_IMPORTACAO_SHOPEE_PADRAO.importarFotos),
  importarCategorias: z.boolean().default(OPCOES_IMPORTACAO_SHOPEE_PADRAO.importarCategorias),
  /** Mass-import-only: also re-drive items that already carry a link doc for this conta. */
  atualizarCadastrados: z.boolean().default(OPCOES_IMPORTACAO_SHOPEE_PADRAO.atualizarCadastrados),
  /**
   * The `update_time` window handed to `get_item_list`, in the wire's own
   * **SECONDS** — never compared against this document's ms stamps, which is
   * what the `S` suffix is for.
   *
   * ⚠️ A windowed run is a STRUCTURAL delta only: `faq 180` excludes price and
   * stock from the 26 edits that bump `update_time`, so narrowing the window to
   * "what changed since yesterday" will NOT pick up a price or stock change. It
   * is also the documented mitigation for the `get_item_list` offset cap, which
   * is the reason it exists at all.
   */
  updateTimeFromS: z.number().int().positive().nullable().default(null),
  updateTimeToS: z.number().int().positive().nullable().default(null),
});
export type ImportacaoShopeeOptions = z.infer<typeof importacaoShopeeOptionsSchema>;

/**
 * One contained per-item import failure.
 *
 * ⚠️ `motivo` is a PERSISTED closed vocabulary — a stable slug the UI groups
 * by, not free text, and not free to rename (the `SkuMatchKind` doctrine). The
 * slugs are `item-deletado`, `item-nao-retornado`, `item-nao-encontrado`,
 * `sem-nome`, `vinculo-inconsistente`, `taxonomia-em-conflito`,
 * `kit-sem-detalhe`, `kit-componente-nao-vinculado`, `kit-nao-importado`,
 * plus the two job-level `erro-shopee` / `erro-schema`.
 *
 * It is typed `z.string().min(1)` rather than an enum ON PURPOSE: the closed
 * vocabulary lives beside the error class that raises it, in the app
 * (`apps/shopee/lib/shopee/produtos/errosImportacao.ts`), and a second copy of
 * the member list here is exactly the drift shape root `CLAUDE.md` warns about.
 * A stored document must also still PARSE after a future slug is added, or the
 * job could not read its own checkpoint back.
 */
export const shopeeImportacaoFalhaSchema = z.object({
  /** The Shopee `item_id`, a NUMBER — a stringified id matches nothing on the link composite. */
  itemId: z.number().int(),
  motivo: z.string().min(1),
  /**
   * The operator-facing sentence. ⚠️ For a schema failure this is the FIELD
   * PATHS only, never a value from the body (#1015).
   */
  mensagem: z.string().default(''),
});
export type ShopeeImportacaoFalha = z.infer<typeof shopeeImportacaoFalhaSchema>;

export const importacaoShopeeSchema = z.object({
  /** The connected conta this job scans/imports for. */
  integracaoId: z.string().min(1),
  status: importacaoShopeeStatusSchema,
  /**
   * The SERVER's `next_offset`, echoed back verbatim — never `offset +
   * page_size`, which is what the legacy did and what makes a mutating
   * catalogue skip rows. `null` means "not scanned yet OR exhausted"; the two
   * collapse safely because a dispatch with empty queues always scans BEFORE
   * the completion test.
   *
   * ⚠️ The sandbox probe found the documented `next_offset (int64)` is sent
   * only on a FULL page — it was absent from a short page — while an
   * UNDOCUMENTED string field `next` is always present. So the scan reads
   * `next_offset` only while `has_next_page` is true, and treats
   * `has_next_page: true` with no usable cursor as a TERMINAL job error
   * (register item 66), never as silent exhaustion.
   */
  nextOffset: z.number().int().min(0).nullable().default(null),
  /**
   * Item ids still queued for import, drained a bounded batch per dispatch and
   * persisted after EVERY item so a retry resumes exactly where it stopped.
   *
   * ⚠️ NUMBERS. A stringified Shopee id matches nothing on the `prodshopee`
   * composite, silently — the legacy failure `produtoShopeeLinkCollection.ts`
   * already records.
   */
  fila: z.array(z.number().int().positive()).default(() => []),
  /**
   * Kit item ids, drained LAST — after `fila` is empty, so every component has
   * had its chance to be imported as an ordinary produto first.
   *
   * It is a SEPARATE queue because `tag.kit` is documented on `get_item_list`
   * and UNVERIFIED on `get_item_base_info`: carrying the flag in the checkpoint
   * makes the kit branch independent of that unknown.
   */
  filaKits: z.array(z.number().int().positive()).default(() => []),
  /** Rows seen across every scanned page (informational). */
  scanned: z.number().int().default(0),
  /** Items the per-item importer completed (create OR update). */
  imported: z.number().int().default(0),
  /** Of {@link importacaoShopeeSchema}'s `imported`, how many were first-time creates. */
  created: z.number().int().default(0),
  /**
   * Rows the scan did not import. TWO contributors, both deliberate: rows the
   * skip-filter dropped as already-linked (when `atualizarCadastrados` is off),
   * and rows Shopee returned carrying a DELETE status the options never asked
   * for.
   */
  skipped: z.number().int().default(0),
  /** Kit items imported as ERP kit produtos. */
  kits: z.number().int().default(0),
  /** Total per-item failures — UNCAPPED, so it may exceed `failures.length`. */
  failureCount: z.number().int().default(0),
  /**
   * The first N failures, for the UI. ⚠️ The schema deliberately does NOT
   * declare that cap: the ceiling is a budget the job module owns and tunes,
   * and a stored document that already exceeds it must still parse, or the job
   * could not read its own checkpoint back — let alone trim it.
   */
  failures: z.array(shopeeImportacaoFalhaSchema).default(() => []),
  /**
   * The run's toggles. Defaulted as a WHOLE as well as field by field: a job
   * doc that predates this field entirely still parses and keeps behaving the
   * way it was queued, which is the retrofit lesson at the container level.
   */
  options: importacaoShopeeOptionsSchema.default(() => ({
    ...OPCOES_IMPORTACAO_SHOPEE_PADRAO,
    statuses: [...OPCOES_IMPORTACAO_SHOPEE_PADRAO.statuses],
  })),
  /** ⚠️ MILLISECONDS — see the header. */
  startedAt: millisSinceEpoch(),
  /** Bumped on every persisted checkpoint (scan page, per item, burst pause, terminal). MS. */
  updatedAt: millisSinceEpoch(),
  finishedAt: millisSinceEpoch().nullable().default(null),
  /** Set only on `status: 'failed'` — never a body, never a credential. */
  erro: z.string().nullable().default(null),
});
export type ImportacaoShopee = z.infer<typeof importacaoShopeeSchema>;

export const importacaoShopeeMeta: CollectionMetadata = {
  collectionPath: 'importacoesShopee',
  // No client domain grants these bits — placeholder values. Deliberately NOT
  // registered in `ALL_DOMAINS`, so the rules generator emits no match block
  // and Firestore default-denies every client read/write. Only the authed
  // routes and the apps/shopee nested functions (Admin SDK) reach it. Mirrors
  // `backfillPedidosShopeeMeta`.
  permissions: {
    read: 0n,
    write: 0n,
    delete: 0n,
  },
};

// NOTE: intentionally exported as two BARE constants (`...Schema` + `...Meta`),
// NOT a single `{ schema, meta }` DomainSchema object, and NOT added to
// `ALL_DOMAINS` — `registry.test.ts`'s `isDomainSchema()` only flags a single
// export carrying both a `.schema` and a `.meta` property, so this shape never
// gets swept in by accident. The admin collection handle
// (`importacaoShopeeCollection`) consumes `importacaoShopeeMeta.collectionPath`
// directly.
//
// ⚠️ The collection name deliberately does not start with `notificacoes`:
// `notificationGuardrails`' checks B and C fire on every admin collection path
// with that prefix and would demand a pipeline consumer and a
// `(status, processedAt)` index this job doc has neither of.
