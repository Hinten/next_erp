/**
 * **How a stored Shopee link is READ** (step 21, #1529) — the read-side rules
 * of a `prodshopee` / `variashopee` document that more than one surface needs:
 * when a stored refusal is still worth showing, whether the stock sync is
 * currently skipping the listing, whether the listing is still "vivo", and
 * whether the link is a DRAFT that was never a listing at all (#1911).
 *
 * ⚠️ ONE module (#1369). `apps/shopee` decides with these (the stock gate, the
 * `integracoesComProduto` trigger, the stock sweep) and the produto's Shopee tab
 * in `apps/web` RENDERS with them; `apps/web` has no dependency edge to
 * `apps/shopee`, so the alternative was a browser copy that drifts toward
 * plausible while both read correct. Two of these were MOVED here verbatim —
 * {@link pularPorRecusaAnterior} from `apps/shopee/lib/shopee/estoque/podeEnviarEstoque.ts`
 * and {@link anuncioShopeeVivo} from `apps/shopee/lib/shopee/anuncios/statusAnuncio.ts`,
 * both of which re-export them so no importer changed.
 *
 * ⚠️ **Pure and total over `unknown`.** A soft-read hands over the RAW document
 * when the schema does not parse it (a migrated Flutter row, a half-written
 * one), so every field is `unknown` and every read is a `typeof` narrow; none of
 * these throws, and none reads a clock — {@link pularPorRecusaAnterior} takes
 * its instant as a parameter.
 *
 * ## The refusal reader (register 177, settled in step 21 — Lucas, Q3)
 *
 * A stored refusal is a DIAGNOSTIC that self-expires by comparison: it is shown
 * while no success stamp is NEWER than it. {@link recusaShopeeLegivel} is that
 * comparison, once; the four wrappers only say WHICH stamps count:
 *
 * | reader | refusal | success stamps it must be at or after |
 * |---|---|---|
 * | {@link recusaPrecoDoAnuncioShopeeLegivel} | item `precoRecusaEm` | the item's `precoEnviadoEm` |
 * | {@link recusaPrecoDoModeloShopeeLegivel} | model `precoRecusaEm` | the model's own `precoEnviadoEm` AND the item's |
 * | {@link recusaEstoqueDoAnuncioShopeeLegivel} | item `estoqueRecusaEm` | the item's `estoqueEnviadoEm` |
 * | {@link recusaEstoqueDoModeloShopeeLegivel} | model `estoqueRecusaEm` | the item's `estoqueEnviadoEm` only (a model has no stock success stamp) |
 *
 * - **A tie SHOWS the refusal** (`>=`): a refusal and a success stamped in the
 *   same millisecond leave the operator a refusal to read rather than none.
 * - **A model's price refusal also anchors on the ITEM**: the item's
 *   `precoEnviadoEm` is stamped only by a CLEAN send, which by definition left
 *   no refused model — so a model refused in a partial send that later reads
 *   `preco-igual` (and is therefore never re-stamped) stops showing once the
 *   item syncs cleanly.
 * - **The item-level stock refusal follows the same rule** against
 *   `estoqueEnviadoEm`: the clean send's `null` clear can lose the race to a
 *   late refusal write, and the stamp comparison is what hides that one.
 * - A success stamp that is not a number (absent, `null`, a legacy string) is
 *   NOT newer than anything; a refusal stamp that is not a finite number is no
 *   refusal at all.
 *
 * The rule is the reader's alone: nothing here decides a SEND (the stock skip
 * set below is a different question, answered by its own fingerprint).
 */
import { ESTADO_ANUNCIO_SHOPEE } from './shopeeLink';

/* -------------------------------------------------------------------------- */
/*                         The refusal reader (register 177)                   */
/* -------------------------------------------------------------------------- */

/**
 * The ONE comparison: a finite numeric refusal, shown while NO numeric success
 * stamp is newer (a tie SHOWS it — Q3).
 *
 * @param recusaEm the refusal stamp, MILLISECONDS, unvalidated
 * @param sucessosEm every success stamp that hides it once newer, unvalidated;
 *   a non-number entry hides nothing
 */
export function recusaShopeeLegivel(recusaEm: unknown, sucessosEm: readonly unknown[]): boolean {
  if (typeof recusaEm !== 'number' || !Number.isFinite(recusaEm)) return false;
  return sucessosEm.every((s) => typeof s !== 'number' || recusaEm >= s);
}

/** The price fields a reader needs off a `prodshopee` or a `variashopee` — raw. */
export interface LeituraPrecoShopee {
  readonly precoRecusaEm?: unknown;
  readonly precoEnviadoEm?: unknown;
}

/** The stock fields a reader needs off a `prodshopee` or a `variashopee` — raw. */
export interface LeituraEstoqueShopee {
  readonly estoqueRecusaEm?: unknown;
  readonly estoqueEnviadoEm?: unknown;
}

/** Is the ITEM's stored price refusal still worth showing? Against the item's own clean-send stamp. */
export function recusaPrecoDoAnuncioShopeeLegivel(link: LeituraPrecoShopee): boolean {
  return recusaShopeeLegivel(link.precoRecusaEm, [link.precoEnviadoEm]);
}

/**
 * Is a MODEL's stored price refusal still worth showing? Against its OWN success
 * stamp (every accepted send of the model stamps one) AND the item's clean-send
 * stamp — whichever is newer hides it.
 */
export function recusaPrecoDoModeloShopeeLegivel(
  modelo: LeituraPrecoShopee,
  anuncio: Pick<LeituraPrecoShopee, 'precoEnviadoEm'>,
): boolean {
  return recusaShopeeLegivel(modelo.precoRecusaEm, [modelo.precoEnviadoEm, anuncio.precoEnviadoEm]);
}

/** Is the ITEM's stored stock refusal still worth showing? Against the item's clean-send stamp. */
export function recusaEstoqueDoAnuncioShopeeLegivel(link: LeituraEstoqueShopee): boolean {
  return recusaShopeeLegivel(link.estoqueRecusaEm, [link.estoqueEnviadoEm]);
}

/**
 * Is a MODEL's stored stock refusal still worth showing? Against the ITEM's
 * clean-send stamp only: a `variashopee` carries no stock success stamp of its
 * own, so the parent's is the one thing that can hide it.
 */
export function recusaEstoqueDoModeloShopeeLegivel(
  modelo: Pick<LeituraEstoqueShopee, 'estoqueRecusaEm'>,
  anuncio: Pick<LeituraEstoqueShopee, 'estoqueEnviadoEm'>,
): boolean {
  return recusaShopeeLegivel(modelo.estoqueRecusaEm, [anuncio.estoqueEnviadoEm]);
}

/* -------------------------------------------------------------------------- */
/*            The stock skip set (MOVED from podeEnviarEstoque.ts)             */
/* -------------------------------------------------------------------------- */

/**
 * A stored `prodshopee` link, as read — never as parsed: the eight fields the
 * step-12 stock gate reads (`podeEnviarEstoqueShopee`, whose `LinkParaEstoque`
 * extends this). The index signature is what lets a caller hand over the whole
 * document (or a discovery row carrying twenty more columns) without shaping it
 * first.
 */
export interface LeituraRecusaEstoqueShopee {
  /** The Shopee listing id. A positive finite NUMBER, or there is no listing to address. */
  item_id?: unknown;
  /** This app's folded reading of the listing — `EstadoAnuncioShopee`, or `null` when never folded. */
  estadoAnuncio?: unknown;
  /** Shopee's RAW `item_status` string — the other half of the refusal fingerprint. */
  item_status?: unknown;
  /** Whether SHOPEE reports this listing as a kit item. Three-valued; only `true` refuses. */
  kitNativo?: unknown;
  /** MILLISECONDS — when the last refusal landed. The STATE mechanism's trigger. */
  estoqueRecusaEm?: unknown;
  /** MILLISECONDS — an expiry the sender stamps for a refusal no reading will ever lift. */
  estoqueRecusaAte?: unknown;
  /** The folded `estadoAnuncio` at refusal time. */
  estoqueRecusaEstado?: unknown;
  /** The raw `item_status` at refusal time. */
  estoqueRecusaItemStatus?: unknown;
  [k: string]: unknown;
}

/**
 * The skip set — *"have we already been refused with this listing in exactly
 * this state?"*. Exported because the sweep asks it directly and because a
 * fold this consequential is pinned by its own tests.
 *
 * ```
 * pular = (typeof estoqueRecusaAte === 'number' && nowMs < estoqueRecusaAte)   // TIME
 *      || (typeof estoqueRecusaEm  === 'number'                                // STATE
 *          && (estoqueRecusaEstado !== null || estoqueRecusaItemStatus !== null)
 *          && estoqueRecusaEstado      === estadoAnuncio
 *          && estoqueRecusaItemStatus  === item_status)
 * ```
 *
 * ⚠️ **`||` between the two mechanisms, `&&` between the two fingerprint
 * halves.** Either half moving lifts the skip — that is the whole design, and
 * an `||` there would latch a listing until BOTH halves moved, which for a
 * refusal caused by the state itself is "for ever".
 *
 * ⚠️ **A fingerprint whose two RECORDED halves are BOTH null arms nothing.**
 * That clause is not a tidy-up: without it the STATE mechanism fires on a
 * comparison nobody made. `estoqueRecusaEm` alone is stamped by writers that
 * record no reading at all (`registrarEnvioParcial`), and `undefined` folds to
 * `null` on both sides — so on a link whose `estadoAnuncio` and `item_status`
 * are both absent (every link a clean send has just cleared, and every step-9
 * import that folded an unknown status) `null === null` twice over and the
 * listing would latch INDEFINITELY, because neither half can ever move to lift
 * it. Requiring one recorded reading makes the mechanism mean what its name
 * says: *this* listing was refused in *this* observed state. The cost is the
 * FALSE-NEGATIVE direction — a terminal refusal taken on a link with no
 * readings at all re-sends once per tick until a reading appears — which is one
 * call per listing per tick, visible in the per-motivo counters, against a
 * silent permanent stop.
 *
 * ⚠️ **Strictly `<` on the TIME half.** At exactly `estoqueRecusaAte` the wait
 * is over; `<=` would hold the listing for one more tick at the only instant
 * anyone ever tests.
 *
 * The TIME mechanism exists because a promotion ENDING moves no `item_status`
 * and no `estadoAnuncio` — so a promotion refusal fingerprinted against the
 * state would latch for ever. It is stamped only by the arm that knows the
 * refusal will outlive the reading.
 *
 * ## ⚠️ The absence normalisation, and what it treats as EQUAL
 *
 * `undefined` is folded to `null` on BOTH sides before either half is
 * compared. **EQUAL:** a link whose `estadoAnuncio` key was never written and a
 * stamp recorded as `null` — they are the same state, and a document that
 * simply omits a nullable field is what every `.nullable().default(null)`
 * column looks like before its first write. **DISTINCT:** everything else,
 * including `null` vs the string `'null'`, `null` vs `''`, and two different
 * readings such as `pausado` vs `ativo`. Nothing is trimmed, lower-cased or
 * coerced: these are two RECORDED READINGS being compared for identity, not
 * two spellings of one value.
 *
 * ⚠️ The fold is what makes absence comparable; the non-null clause above is
 * what stops it comparing TWO absences. Both are needed and neither implies the
 * other: a recorded `('ativo', null)` against a link reading `('ativo',
 * absent)` still skips, because one recorded reading is real.
 */
export function pularPorRecusaAnterior(link: LeituraRecusaEstoqueShopee, nowMs: number): boolean {
  const { tempo, estado } = mecanismosDaRecusaAnterior(link, nowMs);
  return tempo || estado;
}

/**
 * WHICH of {@link pularPorRecusaAnterior}'s two mechanisms is armed — the same
 * two halves, unjoined, so a surface that has to SAY why a listing is skipped
 * (the produto's Shopee tab) never re-derives either one. `tempo || estado` is
 * `pularPorRecusaAnterior`, by construction.
 *
 * - `tempo` — `nowMs < estoqueRecusaAte`: lifts at that instant, whatever the
 *   listing does meanwhile.
 * - `estado` — the recorded fingerprint matches the listing's reading: lifts
 *   when the listing's reading moves. ⚠️ Both can be armed at once (a promotion
 *   refusal records the fingerprint beside its `ate`), and then the STATE half
 *   still holds after the deadline until the reading moves.
 */
export function mecanismosDaRecusaAnterior(
  link: LeituraRecusaEstoqueShopee,
  nowMs: number,
): { readonly tempo: boolean; readonly estado: boolean } {
  // ⚠️ No `Number.isFinite` guard, deliberately: a `NaN` expiry falls out of
  // the comparison itself (`nowMs < NaN` is `false`), and a redundant guard
  // would read as though the comparison needed help.
  const ate = link.estoqueRecusaAte;
  const tempo = typeof ate === 'number' && nowMs < ate;
  return { tempo, estado: mecanismoDeEstado(link) };
}

/** The STATE half of {@link pularPorRecusaAnterior} — see its docblock. */
function mecanismoDeEstado(link: LeituraRecusaEstoqueShopee): boolean {
  if (typeof link.estoqueRecusaEm !== 'number') return false;

  // ⚠️ At least ONE reading must actually have been recorded. A stamp with two
  // null halves is a refusal whose state nobody wrote down — see the docblock:
  // comparing it would latch on `null === null` and nothing could ever lift it.
  const estadoGravado = ouNulo(link.estoqueRecusaEstado);
  const statusGravado = ouNulo(link.estoqueRecusaItemStatus);
  if (estadoGravado === null && statusGravado === null) return false;

  return estadoGravado === ouNulo(link.estadoAnuncio) && statusGravado === ouNulo(link.item_status);
}

/**
 * `undefined` ⇒ `null`; every other value is returned untouched. The one
 * normalisation the fingerprint applies — see {@link pularPorRecusaAnterior}.
 */
function ouNulo(valor: unknown): unknown {
  return valor === undefined ? null : valor;
}

/* -------------------------------------------------------------------------- */
/*             The "vivo" predicate (MOVED from statusAnuncio.ts)              */
/* -------------------------------------------------------------------------- */

/**
 * Is this stored `prodshopee` document a listing the ERP should still treat as
 * ALIVE? The predicate the `onProdutoShopeeLinkChanged` trigger scans survivors
 * with (S12).
 *
 * ⚠️ **Total and non-throwing over an UNVALIDATED document.** It is handed a
 * raw Firestore snapshot body — a migrated Flutter row, a half-written one, a
 * `null` — and it must answer a boolean for every one of them. A throw here
 * would abort a trigger whose whole job is to keep `integracoesComProduto`
 * honest.
 *
 * ⚠️ **An absent or `null` `estadoAnuncio` reads as VIVO.** `null` means NEVER
 * FOLDED — every link step 9 imported is one — and it is not evidence of
 * anything. The asymmetry is `integracoesComProduto.ts`'s verbatim: a false
 * positive costs one skipped sweep row, a false negative is a silent stock and
 * price outage. When in doubt, over-include.
 *
 * The `item_id` test is `typeof === 'number'` and `> 0`, so a link that has
 * never been published (`item_id: null`) is not a survivor. ⚠️ A STRINGIFIED id
 * therefore reads as NOT alive; the field is a typed `z.number().int()` and
 * nothing in this repo writes it as a string, but a corpus row that did would
 * take the false-negative direction — recorded rather than guessed around.
 */
export function anuncioShopeeVivo(link: Record<string, unknown> | null): boolean {
  if (link === null) return false;
  const itemId = link.item_id;
  if (typeof itemId !== 'number' || !Number.isFinite(itemId) || itemId <= 0) return false;
  return link.estadoAnuncio !== ESTADO_ANUNCIO_SHOPEE.removido;
}

/* -------------------------------------------------------------------------- */
/*                     The draft predicate (#1911, D3)                         */
/* -------------------------------------------------------------------------- */

/**
 * Is this stored `prodshopee` document a DRAFT — a listing the ERP intends to
 * create and that Shopee never answered for? THE one predicate (D3):
 * `apps/shopee`'s publish dispatcher, status/re-verify resolver, stock and
 * price planners and listing assembly decide with it, and a browser surface
 * that needs the same answer imports it rather than testing `item_id == null`
 * locally (#1369).
 *
 * A draft is NEVER live: it is reachable only by a named `linkDocId`, and every
 * resolver that picks a link on its own skips it.
 *
 * - **EQUAL (a draft):** `item_id: null`; `item_id` ABSENT (a pipeline /
 *   `select()` projection that omits the key reads the same); whatever
 *   `estadoAnuncio` says — a never-created listing has no state Shopee gave it.
 * - **DISTINCT (not a draft):** an `item_id` that is present but not a usable
 *   id — `0`, `-1`, `NaN`, `''`, `'123'`. That is a CORRUPT link, not an
 *   intention to publish: it stays out of this class (and `0` / `'123'` are not
 *   {@link anuncioShopeeVivo} either — a recorded residual, never guessed
 *   around). A positive `item_id` is a listing whatever its `estadoAnuncio`, a
 *   `removido` one included.
 * - **DISTINCT:** `kitNativo: true` with no `item_id` — a native-kit residue
 *   (no item-less native link exists, L9), the dispatcher's X class, never a
 *   draft. Only `true` excludes: `false`, `null` or a stray `'true'` leave the
 *   draft a draft (the stock gate's three-valued direction).
 * - **DISTINCT:** `null` (no document).
 *
 * Disjoint from {@link anuncioShopeeVivo} by construction — a vivo link has a
 * positive numeric `item_id`, a draft has none — and the test file pins it over
 * one shared table.
 *
 * Pure, total over `unknown`, no clock.
 */
export function ehRascunhoShopee(
  link: { readonly item_id?: unknown; readonly kitNativo?: unknown } | null,
): boolean {
  if (link === null || link.kitNativo === true) return false;
  return link.item_id === null || link.item_id === undefined;
}
