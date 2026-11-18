/**
 * **How a stored Shopee link is READ** (step 21, #1529) — the read-side rules
 * of a `prodshopee` / `variashopee` document that more than one surface needs:
 * when a stored refusal is still worth showing, whether the stock sync is
 * currently skipping the listing, whether the listing is still "vivo" and
 * which conta it counts for in `integracoesComProduto`, whether the link is a
 * DRAFT that was never a listing at all (#1911), whether its stored
 * `logistic_info` is one THIS app wrote and may re-send (#2015,
 * {@link logisticaGravadaPeloErpShopee} — the stamp alone decides), and how
 * each entry of a stored `logistic_info` is read
 * ({@link lerLogisticaArmazenadaShopee}, #1911 P15, MOVED from
 * `apps/shopee/lib/shopee/anuncios/logisticaPublicacao.ts`, which now imports
 * it — its helpers were private there, so there is nothing to re-export).
 *
 * ⚠️ ONE module (#1369). `apps/shopee` decides with these (the stock gate, the
 * `integracoesComProduto` trigger, the stock sweep) and the produto's Shopee tab
 * in `apps/web` RENDERS with them; `apps/web` has no dependency edge to
 * `apps/shopee`, so the alternative was a browser copy that drifts toward
 * plausible while both read correct. Three of these were MOVED here verbatim —
 * {@link pularPorRecusaAnterior} from `apps/shopee/lib/shopee/estoque/podeEnviarEstoque.ts`,
 * {@link anuncioShopeeVivo} from `apps/shopee/lib/shopee/anuncios/statusAnuncio.ts`
 * and {@link contaDoLinkShopee} from
 * `apps/shopee/lib/shopee/anuncios/integracoesComProdutoShopee.ts` (a
 * `tools/migrations` script needs it, and cannot import an app) — and each of
 * those files re-exports its own, so no importer changed.
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
import { contaIdFromRef } from '../../shared/outerRef';
import { ESTADO_ANUNCIO_SHOPEE, ehVinculoSubstituido } from './shopeeLink';

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
/*              ERP edits of a PUBLISHED listing (pending-edit guard)          */
/* -------------------------------------------------------------------------- */

/**
 * The link keys an operator's ERP edit owns: the content the product import and
 * the publish write-backs would otherwise rewrite from Shopee's read or from the
 * publish body. While an edit is pending (`edicaoErpPendenteEm`) these are
 * written only by the edit itself or by the discard. ⚠️ `logisticaGravadaEm` is
 * listed because it rides the SAME patch as `logistic_info` (#2015) — dropping
 * one without the other would vouch for a list this app did not write. `apps/shopee`
 * must go through this constant (and the two helpers below), never spell that
 * stamp: its writer-site backstop pins the literal.
 */
export const CAMPOS_DE_EDICAO_ERP_SHOPEE = [
  'item_name',
  'description',
  'description_type',
  'description_info',
  'category_id',
  'attributes',
  'brand_id',
  'original_brand_name',
  'logistic_info',
  'logisticaGravadaEm',
] as const;
export type CampoDeEdicaoErpShopee = (typeof CAMPOS_DE_EDICAO_ERP_SHOPEE)[number];

/**
 * The stored edit revision, or `null` when the link was never edited: a safe
 * positive integer only. `0`, negatives, fractions, `2**53`, strings and `null`
 * all read "never edited" — the stamp is a counter this app writes, so anything
 * else is not evidence of an edit.
 */
export function revisaoDeEdicaoErpShopee(link: Record<string, unknown> | null): number | null {
  if (link === null) return null;
  const v = link.edicaoErpRevisao;
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;
}

/**
 * Whether an ERP edit is saved and not yet sent: `edicaoErpPendenteEm` is a
 * finite number > 0 (a ms stamp). `0`, negatives, `NaN`, `Infinity`, strings and
 * `null` are "nothing pending".
 *
 * ⚠️ Looser on purpose than {@link revisaoDeEdicaoErpShopee}: a malformed stamp
 * that is still a positive finite number counts as PENDING, because a false
 * "pending" costs one skipped content refresh while a false "none" silently
 * discards an operator's edit.
 */
export function edicaoErpPendenteShopee(link: Record<string, unknown> | null): boolean {
  if (link === null) return false;
  const v = link.edicaoErpPendenteEm;
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Whether the link is a PUBLISHED listing an operator may edit in the ERP: a
 * positive safe-integer `item_id` (stricter than {@link anuncioShopeeVivo}, which
 * lets `1.5` through), alive, not superseded (L8), and not a native kit — a kit's
 * content is owned by its own arms.
 */
export function anuncioShopeeEditavel(link: Record<string, unknown> | null): boolean {
  if (link === null) return false;
  const itemId = link.item_id;
  return (
    typeof itemId === 'number' &&
    Number.isSafeInteger(itemId) &&
    itemId > 0 &&
    anuncioShopeeVivo(link) &&
    !ehVinculoSubstituido(link) &&
    link.kitNativo !== true
  );
}

/** A shallow copy of `dados` WITHOUT the {@link CAMPOS_DE_EDICAO_ERP_SHOPEE} keys. */
export function semCamposDeEdicaoErpShopee(
  dados: Record<string, unknown>,
): Record<string, unknown> {
  const fora = new Set<string>(CAMPOS_DE_EDICAO_ERP_SHOPEE);
  return Object.fromEntries(Object.entries(dados).filter(([k]) => !fora.has(k)));
}

/**
 * A shallow copy of `dados` holding ONLY the {@link CAMPOS_DE_EDICAO_ERP_SHOPEE}
 * keys it OWNS — an absent key stays absent (never invented as `undefined`/`null`).
 */
export function soCamposDeEdicaoErpShopee(dados: Record<string, unknown>): Record<string, unknown> {
  const dentro = new Set<string>(CAMPOS_DE_EDICAO_ERP_SHOPEE);
  return Object.fromEntries(Object.entries(dados).filter(([k]) => dentro.has(k)));
}

/* -------------------------------------------------------------------------- */
/*   The anchor's conta reader (MOVED from integracoesComProdutoShopee.ts)    */
/* -------------------------------------------------------------------------- */

/**
 * The integração doc id a stored `prodshopee` link belongs to, or `null`: the
 * `integracoesComProduto` anchor's CONTA reader, {@link contaIdFromRef} over
 * `contaProdutoShopeeOuterRef`, always paired with {@link anuncioShopeeVivo}.
 *
 * ⚠️ **`contaProdutoShopeeOuterRef`, NOT `contaOuterRef`.** That is Mercado
 * Livre's field name, one identifier apart. A copy-paste of the Mercado Livre
 * reader compiles, resolves `null` on every Shopee link, makes both sides of
 * the anchor plan's comparison `null`, takes the zero-cost fast path — and the
 * trigger becomes a no-op that logs nothing.
 *
 * Total and non-throwing over a raw document, because `contaIdFromRef` is.
 *
 * Equal (⇒ `'C1'`): `'documents/integracao/C1'` ≡ `'integracao/C1'` ≡
 * `'/documents/integracao/C1'` — the migrated corpus carries both stored forms.
 * Distinct: another conta's ref reads as THAT conta; another collection's ref,
 * the ref inside an array, and a doc carrying ONLY another channel's conta
 * field (`contaOuterRef`, `contaLojaIntegrada`) ⇒ `null`.
 */
export function contaDoLinkShopee(link: Record<string, unknown>): string | null {
  return contaIdFromRef(link.contaProdutoShopeeOuterRef);
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

/* -------------------------------------------------------------------------- */
/*            The logistics provenance predicate (#2015, Lucas D1)             */
/* -------------------------------------------------------------------------- */

/**
 * Did THIS app write the stored `logistic_info` of this `prodshopee` document —
 * a list a publish sent or one Shopee answered, or the one the operator chose
 * on a draft (#1911 P15) — so a publish may re-send it?
 * THE one reading of `logisticaGravadaEm` (#1369): the item plan's projection
 * and the kit plan decide with it, and since #1911 P15 the draft projection
 * (`./shopeeRascunho.ts`) too; nothing reads the stamp raw.
 *
 * - **EQUAL (trusted):** a stamp that is a safe integer `>= 0`, `0` included —
 *   the signal is PRESENCE, never a clock, so no value is "too old".
 * - **DISTINCT (distrusted):** an absent key (every migrated row: the legacy
 *   app never wrote it), `null`, a numeric STRING, a fraction, a negative,
 *   `NaN`, `±Infinity`, an unsafe integer — and a `null` link (no document).
 * - ⚠️ **The stamp ALONE decides (D1).** It never looks at `item_id`,
 *   `ehRascunhoShopee`, `estadoAnuncio` or `ultimaPublicacao`: ENSURE's
 *   adoption turns a legacy draft into a listing that keeps its legacy list,
 *   and `ultimaPublicacao` is written whether or not the publish carried a
 *   list — so neither proves who wrote the list. A stamped draft is trusted;
 *   an unstamped listing is not.
 *
 * Pure, total over `unknown`, no clock. In memory only — never a Firestore
 * `where`.
 */
export function logisticaGravadaPeloErpShopee(
  link: { readonly logisticaGravadaEm?: unknown } | null,
): boolean {
  if (link === null) return false;
  const v = link.logisticaGravadaEm;
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/* -------------------------------------------------------------------------- */
/*            The stored logistics list reader (#1911 P15, #1369)              */
/* -------------------------------------------------------------------------- */

/**
 * One entry of a stored `logistic_info`, as read — exactly these five keys,
 * whatever else the stored entry carries.
 */
export interface EntradaLogisticaArmazenadaShopee {
  /** A positive safe integer, from a number or a digits-only string (`'090003'` ⇒ `90003`, main's rule). */
  readonly logisticId: number;
  /** `enabled !== false` — ONLY a boolean `false` is off (D-12); absent, `null`, `'false'` and `0` read ON. */
  readonly ligado: boolean;
  /** A boolean `is_free`, else `null`. Never coerced. */
  readonly isFree: boolean | null;
  /** `size_id` through the same id reader as `logisticId` — `0`, `'0'`, `''` and `'12.5'` read `null` (C32). */
  readonly sizeId: number | null;
  /** `shipping_fee`: a finite number, or a `/^\d+(\.\d+)?$/` string; anything else `null`. */
  readonly shippingFee: number | null;
}

/**
 * THE one reading of a stored `logistic_info` (#1369). The publisher's stored
 * pass and its import remedy (`logisticaPublicacao.ts`, where these readers
 * lived until #1911 P15) and the draft projection (`./shopeeRascunho.ts`) all
 * read the list through it, so a `logistic_id` the publisher re-sends and the
 * one the draft editor shows can never be read two ways.
 *
 * - `null` ⇔ the value is not an array (a legacy `null`, an absent key, an
 *   object). `[]` reads `[]`.
 * - An entry without a readable `logistic_id` is DROPPED, and so is an entry
 *   that is not an object (`null`, a number, a string, an array); its readable
 *   neighbours stay.
 * - The STORED order and duplicates are kept: deduplicating or sorting is a
 *   decision each caller makes (the draft projection sorts; the publisher sends
 *   in stored order), never the reader's.
 * - It reads `logistic_id`, `enabled`, `is_free`, `size_id` and `shipping_fee`,
 *   and nothing else — never `logistic_name`, `include_pickup` or
 *   `estimated_shipping_fee`, which ride a read-back and are not a seller's
 *   choice.
 *
 * ## Why it is not a Zod parse
 *
 * The stored array is OUR persisted copy, not a Shopee response body. The
 * package's `shopeeLogisticInfoSchema` reads `size_id` through `wireInt()`,
 * which COERCES where C32 requires a refusal, and a whole-object parse failure
 * would throw away the `logistic_id` of an entry whose only defect is one
 * unreadable field. Each field is read explicitly and refused rather than
 * coerced — see {@link paraInteiroWire}.
 *
 * ## ⚠️ The fold, and what it treats as EQUAL
 *
 * **EQUAL (one entry):** `logistic_id` `90003` ≡ `'90003'` ≡ `'090003'` (the
 * leading zero is main's digits-only rule, kept); `shipping_fee` `12.9` ≡
 * `'12.90'`; `enabled` `true` ≡ `null` ≡ absent ≡ `'false'` ≡ `0` — all ON,
 * because only a boolean `false` is an off.
 *
 * **DISTINCT / dropped:** a `logistic_id` of `''`, `' 90003'`, `'90003.0'`,
 * `'+90003'`, `'1e5'`, `0`, `'0'`, `-1`, `1.5` or an unsafe integer drops the
 * entry; a `shipping_fee` of `'12,90'`, `'-5'`, `NaN` or `Infinity` reads
 * `null`; an `estimated_shipping_fee` in place of `shipping_fee` reads `null`
 * — an estimate is never the seller's fee.
 *
 * **RESIDUAL:** the fee's NUMBER branch keeps main's acceptance of `0` and of a
 * negative number — stated, pinned, not changed.
 *
 * Pure, total over `unknown`, no clock. In memory only — never a Firestore
 * `where`.
 */
export function lerLogisticaArmazenadaShopee(
  bruto: unknown,
): readonly EntradaLogisticaArmazenadaShopee[] | null {
  if (!Array.isArray(bruto)) return null;
  const lidas: EntradaLogisticaArmazenadaShopee[] = [];
  for (const entrada of bruto as readonly unknown[]) {
    const logisticId = paraInteiroWire(campo(entrada, 'logistic_id'));
    if (logisticId === null) continue;
    const isFree = campo(entrada, 'is_free');
    lidas.push({
      logisticId,
      ligado: campo(entrada, 'enabled') !== false,
      isFree: typeof isFree === 'boolean' ? isFree : null,
      sizeId: paraInteiroWire(campo(entrada, 'size_id')),
      shippingFee: paraNumeroWire(campo(entrada, 'shipping_fee')),
    });
  }
  return lidas;
}

/**
 * The stored `logistic_info` of a link, but ONLY when the ERP wrote it: the
 * array when `link.logistic_info` is one AND {@link logisticaGravadaPeloErpShopee}
 * trusts the link, else `null`. It applies the ONE predicate the publisher
 * (`publicarAnuncio.ts`, `kits/planoKit.ts`) and
 * {@link mesclarLogisticaGravadaShopee} also call, so a list the publisher
 * withholds (#2015: a legacy list is never re-sent without an import) is never
 * read as trusted by the canais verdict either.
 *
 * Pure, total over `unknown`, no clock.
 */
export function logisticaArmazenadaConfiavelShopee(
  link: Record<string, unknown> | null,
): readonly unknown[] | null {
  if (link === null || !logisticaGravadaPeloErpShopee(link)) return null;
  const lista = link.logistic_info;
  return Array.isArray(lista) ? (lista as readonly unknown[]) : null;
}

/**
 * Whether the logistics of a PUBLISHED link may be EDITED in the ERP: only
 * while its stored list is one the ERP wrote ({@link logisticaGravadaPeloErpShopee}).
 *
 * ⚠️ An edit is saved WITH the provenance stamp, and since the publisher sends a
 * trusted list's offs on an update, an edit made over a DISTRUSTED (legacy, or
 * absent) list would vouch for offs nobody chose — the channel editor, with no
 * trusted size or fee to show, pre-fills every SIZE_SELECTION / CUSTOM_PRICE
 * channel OFF, and «Republicar» would switch those live channels off at Shopee.
 * Importing the listing first records what Shopee holds, stamped, and the edit
 * then starts from it. The edit route refuses the rest (422).
 *
 * Pure, total over `unknown`, no clock.
 */
export function logisticaDoAnuncioEditavelShopee(link: Record<string, unknown> | null): boolean {
  return link !== null && logisticaGravadaPeloErpShopee(link);
}

/**
 * The operator's channel choice for a link's `logistic_info`, MERGED with what
 * the link already stores (edit of a PUBLISHED listing). The write whitelist
 * carries only `{logistic_id, enabled, is_free}` (strict — the draft chooses
 * channels), but a published listing's stored entry may also hold the
 * `size_id` / `shipping_fee` a Seller-Centre-configured channel needs; writing
 * the bare choice back would drop them and the next «Republicar» would refuse
 * that channel. So each new entry inherits those two keys, VERBATIM, from the
 * FIRST stored entry that reads (through {@link paraInteiroWire}) as the SAME
 * `logistic_id` — **only when the link's list is TRUSTED**
 * ({@link logisticaGravadaPeloErpShopee}). ⚠️ The caller stamps
 * `logisticaGravadaEm` on the same write, so carrying a DISTRUSTED legacy list's
 * size/fee would launder it into a trusted one and the publisher would send
 * values the ERP never chose (#2015). A distrusted or absent list ⇒ bare
 * triples, nothing appended.
 *
 * - `null` ⇒ `null` («Automática» — nothing to merge).
 * - Output order is `novos` order; each entry is `{logistic_id, enabled,
 *   is_free}` (`is_free` verbatim, `null` included) plus the inherited keys. A
 *   key is carried only when present and neither `null` nor `undefined` in the
 *   stored entry; never invented.
 * - `desligarOmitidos` (a published edit): EVERY trusted stored entry whose id
 *   is not among `novos` is appended, in stored order, once per id, as
 *   `{logistic_id, enabled: false, is_free: <its isFree ?? false>}` — an ON one
 *   because the edit dropped the channel and Shopee must be told (the publisher
 *   sends an off only from a stored `enabled: false`), an OFF one because it
 *   may be an earlier edit's off not yet sent, and dropping it would leave the
 *   channel ON at Shopee. Re-sending an off Shopee already applied is
 *   idempotent. The appended off keeps that entry's `size_id` / `shipping_fee`
 *   (the same carry as above), so switching the channel back on before a
 *   republish still finds them.
 * - **EQUAL (same channel):** `7` ≡ `'7'` ≡ `'07'` (the reader's digits-only
 *   rule). **DISTINCT:** another id inherits nothing; `' 7'`, `'7.0'` and `0`
 *   are not ids at all, so they match nothing.
 * - Duplicate stored ids take the first.
 *
 * Pure, total over `unknown`, no clock.
 */
export function mesclarLogisticaGravadaShopee(
  novos:
    | readonly {
        readonly logistic_id: number;
        readonly enabled: boolean;
        readonly is_free: boolean | null;
      }[]
    | null,
  link: Record<string, unknown> | null,
  opcoes: { readonly desligarOmitidos: boolean },
): readonly Record<string, unknown>[] | null {
  if (novos === null) return null;
  const confiavel = link !== null && logisticaGravadaPeloErpShopee(link);
  const bruto = confiavel ? link?.logistic_info : null;
  const guardadas: { readonly id: number; readonly entrada: unknown }[] = [];
  if (Array.isArray(bruto)) {
    for (const entrada of bruto as readonly unknown[]) {
      const id = paraInteiroWire(campo(entrada, 'logistic_id'));
      if (id !== null) guardadas.push({ id, entrada });
    }
  }
  // The stored `size_id` / `shipping_fee` of the FIRST trusted entry with that id.
  const herdados = (id: number | null): Record<string, unknown> => {
    const guardada = id === null ? undefined : guardadas.find((g) => g.id === id);
    if (guardada === undefined) return {};
    const saida: Record<string, unknown> = {};
    for (const chave of ['size_id', 'shipping_fee'] as const) {
      const valor = campo(guardada.entrada, chave);
      if (valor !== null && valor !== undefined) saida[chave] = valor;
    }
    return saida;
  };
  const saidas = novos.map((novo) => ({
    logistic_id: novo.logistic_id,
    enabled: novo.enabled,
    is_free: novo.is_free,
    ...herdados(paraInteiroWire(novo.logistic_id)),
  }));
  if (!confiavel || !opcoes.desligarOmitidos) return saidas;
  const vistos = new Set<number>();
  for (const novo of novos) {
    const id = paraInteiroWire(novo.logistic_id);
    if (id !== null) vistos.add(id);
  }
  for (const lida of lerLogisticaArmazenadaShopee(bruto) ?? []) {
    if (vistos.has(lida.logisticId)) continue;
    vistos.add(lida.logisticId);
    // The off KEEPS its stored size / fee, like an explicit off does: switching
    // the channel back on before a republish must still find them (the edit
    // whitelist cannot supply either). The wire's disable request is bare
    // anyway (`construirLogistica` sends `{logistic_id, enabled: false}`).
    saidas.push({
      logistic_id: lida.logisticId,
      enabled: false,
      is_free: lida.isFree ?? false,
      ...herdados(lida.logisticId),
    });
  }
  return saidas;
}

/**
 * A wire integer that is safe to send as an `int32` id, or `null`.
 *
 * ⚠️ `Number()` is reached ONLY behind a digits-only test, and that is the whole
 * point of the function: `Number('')` is `0`, `Number(' 12 ')` is `12` and
 * `Number('12.5')` is `12.5`, so a bare coercion invents ids. `0` is refused
 * here as well — no Shopee channel or size id is `0`, and a `'0'` that
 * round-tripped would send a size the seller did not pick (C32).
 */
function paraInteiroWire(bruto: unknown): number | null {
  if (typeof bruto === 'number') {
    return Number.isSafeInteger(bruto) && bruto > 0 ? bruto : null;
  }
  if (typeof bruto !== 'string' || !/^\d+$/.test(bruto)) return null;
  const n = Number(bruto);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** A finite wire number (a shipping fee), or `null`. Same refuse-don't-coerce rule. */
function paraNumeroWire(bruto: unknown): number | null {
  if (typeof bruto === 'number') return Number.isFinite(bruto) ? bruto : null;
  if (typeof bruto !== 'string' || !/^\d+(\.\d+)?$/.test(bruto)) return null;
  const n = Number(bruto);
  return Number.isFinite(n) ? n : null;
}

/** Read one field off an unvalidated stored entry. */
function campo(bruto: unknown, nome: string): unknown {
  if (bruto == null || typeof bruto !== 'object' || Array.isArray(bruto)) return undefined;
  return (bruto as Record<string, unknown>)[nome];
}
