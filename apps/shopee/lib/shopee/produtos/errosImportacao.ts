/**
 * The per-ITEM refusal of the Shopee product import (#1517, step 9), the two
 * PERSISTED reason vocabularies that go with it, and the mass-import
 * scheduler's closed-valve error ({@link ShopeeMassImportTasksDisabledError}) —
 * declared HERE so the job module (`importacaoMassa.ts`) can `instanceof` it
 * and the scheduler (`shopeeMassImportTasks.ts`) can throw it without either
 * importing the other.
 *
 * ⚠️ **Next-free by declaration.** The Cloud Functions bundle reaches every
 * module under `lib/shopee/produtos/`, and `core/respond.ts` — which imports
 * `next/server` — must stay out of it (`apps/shopee/CLAUDE.md`, the `core/`
 * bullet). The dependency therefore runs ONE way: `respond.ts` imports this
 * module to answer 422, and nothing here knows an HTTP response exists.
 *
 * ## Why this is a `ShopeeError` and not a bare `Error`
 *
 * The obvious-looking argument for `extends Error` is that
 * `core/containment.ts` must not treat a blocked ITEM as a per-CONTA outage: a
 * contained failure lands on the conta's cursor and the sweep moves on, which
 * is the wrong verdict for "this one listing cannot be imported". But
 * `erroContidoPorConta` names its classes EXPLICITLY and deliberately never
 * names the base — `containment.ts:46-52` spells out why (`ShopeeConfigError`
 * extends the base and must RETHROW). So extending `ShopeeError` costs nothing
 * there, and it buys the whole channel's `instanceof` discipline: one base for
 * every Shopee-shaped failure the app raises. `errosImportacao.test.ts` pins
 * both halves — the class IS a `ShopeeError`, and
 * `erroContidoPorConta(new ShopeeImportBlockedError(…))` is `false`.
 *
 * ## The two vocabularies, and why there are two
 *
 * {@link MOTIVO_IMPORT_BLOQUEADO} is what the IMPORTER can refuse with: eight
 * decisions it reaches by reading the listing, every one of them made BEFORE
 * any write for that item. {@link MOTIVO_FALHA_JOB} is what the mass-import job
 * can record in `importacoesShopee.failures[].motivo`: those same eight, plus
 * the two it contributes itself when a per-item wire leg fails
 * (`erro-shopee`, `erro-schema`). A job-level slug is never thrown by this
 * module — no `ShopeeImportBlockedError` carries one — because the errors
 * behind them already have classes (`ShopeeApiError`, `ShopeeSchemaError`).
 *
 * ⚠️ **Both vocabularies are PERSISTED and are not free to rename.** They are
 * stored in `importacoesShopee.failures[].motivo`, a stable slug a UI groups
 * by — the `SkuMatchKind` doctrine
 * (`packages/data/src/admin/produtos/resolveProdutoPorSku.ts:56-59`: "a MISS
 * kind is persisted … so these strings are not free to rename"). The schema's
 * own docblock (`packages/schemas/src/importacaoShopee.ts`,
 * `shopeeImportacaoFalhaSchema`) mirrors the member list in prose and types the
 * field `z.string().min(1)` on purpose, so a stored checkpoint still parses
 * after a slug is added here. Adding a member is cheap; renaming one orphans
 * every row already written.
 */
import { ShopeeError } from '@delfrance/integrations-shopee';

/**
 * Why the importer refused ONE listing, before writing anything for it.
 *
 * Each member is a mechanism, not a sentence — the sentence is
 * {@link ShopeeImportBlockedError.mensagem}.
 */
export type MotivoImportBloqueado =
  /** `item_status` came back `SELLER_DELETE` / `SHOPEE_DELETE`: the listing is gone. */
  | 'item-deletado'
  /**
   * The batched `get_item_base_info` answered without a row for an id we ASKED
   * for. Distinct from `item-nao-encontrado`: Shopee reported no error at all,
   * so the id simply vanished from a batch — reconciling BY `item_id` is what
   * makes that visible instead of shifting every later row by one position.
   */
  | 'item-nao-retornado'
  /** Shopee answered `error_item_not_found` for the batch this id was in. */
  | 'item-nao-encontrado'
  /** `item_name` is blank; a produto with no name is not a produto. */
  | 'sem-nome'
  /**
   * A link document would bind the WRONG produto — a `prodshopee` found under a
   * child, or a `variashopee` pointing into another family. Refused before any
   * write: writing it would make the next import read a consistent-looking lie.
   */
  | 'vinculo-inconsistente'
  /**
   * The `grupoDeVariacoes` write lost its bounded retries — another writer
   * changed the same grupo twice while this item was being planned. The item is
   * refused rather than re-applied over the winner (root `CLAUDE.md` rule 7,
   * tier 3: an edit that loses raises a conflict, never a silent drop).
   */
  | 'taxonomia-em-conflito'
  /** A `tag.kit` listing whose `get_kit_item_info` carried no component detail. */
  | 'kit-sem-detalhe'
  /**
   * A kit component does not resolve to any ERP produto yet. K1's whole
   * contract: a kit becomes an ERP kit only when EVERY component already
   * resolves, so this refusal is expected on a first full import and clears
   * itself once the components have been imported.
   */
  | 'kit-componente-nao-vinculado';

/**
 * The closed set, for iteration and for the route's own validation.
 *
 * ⚠️ `kit-nao-importado` is deliberately ABSENT. It belonged to arm K2 (drop
 * every kit, count it, never import one); Lucas chose **K1** — a kit IS
 * imported once its components resolve — so that slug names a decision this
 * build never takes, and a vocabulary member nothing can produce is a value a
 * UI would render a filter for and never fill.
 */
export const MOTIVO_IMPORT_BLOQUEADO = {
  itemDeletado: 'item-deletado',
  itemNaoRetornado: 'item-nao-retornado',
  itemNaoEncontrado: 'item-nao-encontrado',
  semNome: 'sem-nome',
  vinculoInconsistente: 'vinculo-inconsistente',
  taxonomiaEmConflito: 'taxonomia-em-conflito',
  kitSemDetalhe: 'kit-sem-detalhe',
  kitComponenteNaoVinculado: 'kit-componente-nao-vinculado',
} as const satisfies Record<string, MotivoImportBloqueado>;

/**
 * Everything the job may write to `importacoesShopee.failures[].motivo`: every
 * blocked reason, plus the two the job itself contributes.
 */
export type MotivoFalhaJob =
  | MotivoImportBloqueado
  /**
   * An item-scoped Shopee failure (`error_item_not_found` on a per-item leg,
   * `error_data`, an `error_param` from `get_model_list` / `get_kit_item_info`)
   * — contained, so the drain continues with the next item.
   *
   * ⚠️ NEVER a rate limit. A burst `ShopeeRateLimitError` pauses and re-enqueues
   * the job; recording it here would burn the remaining `fila` as "failures"
   * during a throttle and hand the operator a catalogue of broken listings that
   * are all perfectly fine.
   */
  | 'erro-shopee'
  /**
   * One item's body did not match its schema. The accompanying `mensagem` is
   * the FIELD PATHS only, never a value from the body (#1015).
   */
  | 'erro-schema';

/**
 * The job-level superset of {@link MOTIVO_IMPORT_BLOQUEADO}. Same persistence
 * rule: these strings are stored and are not free to rename.
 */
export const MOTIVO_FALHA_JOB = {
  ...MOTIVO_IMPORT_BLOQUEADO,
  erroShopee: 'erro-shopee',
  erroSchema: 'erro-schema',
} as const satisfies Record<string, MotivoFalhaJob>;

/**
 * ONE listing refused, with the reason a UI can group by.
 *
 * ⚠️ It is raised BEFORE any PRODUTO write for that item — that is the contract
 * the job relies on to contain it: a blocked item leaves no half-written
 * produto, no half-written link and no half-written estoque behind, so the next
 * dispatch may retry the same id from a clean state.
 *
 * ⚠️ The one thing it does NOT promise is an untouched `grupoDeVariacoes`.
 * `taxonomia-em-conflito` is raised by the taxonomy step, which walks the
 * planned grupos in order and lands each write before attempting the next — so a
 * grupo THIS item created or patched survives its own refusal. That is why the
 * retry re-plans against a fresh read instead of assuming a clean slate, and why
 * the CLI prints a different last line for that motivo.
 *
 * ⚠️ **No PII, and no payload, in `mensagem`.** It is a MECHANISM sentence — what
 * the importer could not decide and why. Never a listing name, never a seller
 * name, never a description, never a URL, never a raw response body, never a
 * `tax_info` value. The one field that legitimately identifies the listing is
 * {@link itemId}, a number. For a schema failure the sentence is field PATHS
 * only (#1015). It is persisted in `failures[].mensagem` and it reaches the
 * operator through a 422 body, so anything put here is published twice.
 */
export class ShopeeImportBlockedError extends ShopeeError {
  readonly motivo: MotivoImportBloqueado;
  /** The Shopee `item_id`, a NUMBER — a stringified id matches no link composite. */
  readonly itemId: number;
  /** The mechanism detail, or `''` when the motivo says everything there is. */
  readonly mensagem: string;

  constructor(motivo: MotivoImportBloqueado, itemId: number, mensagem?: string) {
    const detalhe = mensagem !== undefined && mensagem !== '' ? `: ${mensagem}` : '';
    super(`Importação bloqueada (${motivo}) no item ${String(itemId)}${detalhe}`);
    this.name = 'ShopeeImportBlockedError';
    this.motivo = motivo;
    this.itemId = itemId;
    this.mensagem = mensagem ?? '';
  }
}

/**
 * Thrown by the mass-import scheduler (`shopeeMassImportTasks.ts`) when the
 * `SHOPEE_TASKS_DISABLED=1` valve is closed.
 *
 * The route maps it to a 503 **before** creating a job; the task handler stamps
 * the job `failed` on the FIRST attempt, because a retry cannot open a valve and
 * there is no sweep to drain the work later.
 *
 * ⚠️ A separate class from `ShopeeTasksDisabledError` on purpose: that one is
 * inside `core/containment.ts`'s `erroContidoPorConta`, so a mass import that
 * raised it would be CONTAINED as one conta's `lastError` instead of stamping
 * the job `failed`. This class is in no containment list, and it is a bare
 * `Error` — not a `ShopeeError` — because nothing Shopee-shaped went wrong.
 */
export class ShopeeMassImportTasksDisabledError extends Error {
  constructor() {
    super(
      'SHOPEE_TASKS_DISABLED=1 — enfileiramento da importação em massa desabilitado; ' +
        'não há sweep por trás deste caminho, então o job é encerrado como failed.',
    );
    this.name = 'ShopeeMassImportTasksDisabledError';
  }
}
