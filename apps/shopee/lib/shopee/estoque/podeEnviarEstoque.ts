/**
 * **The per-link stock gate** (#1520, step 12) — one stored `prodshopee`
 * document plus one instant ⇒ may this ERP write a QUANTITY onto that listing
 * right now?
 *
 * The discovery pass, the planner, the queue's sender and the manual push all
 * ask this one function, so a listing skipped in one place is skipped for the
 * SAME reason everywhere and the operator reads ONE `MotivoEstoqueShopee` slug
 * for it. The vocabulary lives in `./errosEstoque`; only the DECISION lives
 * here.
 *
 * ## ⚠️ Total and NON-THROWING over an UNVALIDATED document
 *
 * Every field of {@link LinkParaEstoque} is `unknown` and every read is a
 * `typeof` narrow. A discovery row arrives straight off a pipeline stage and
 * the sender arrives with a raw snapshot body — a migrated Flutter link, a
 * half-written one, a row whose `item_id` came back as a string — and this
 * function has to answer a verdict for every one of them. It is
 * `anuncioShopeeVivo`'s rule verbatim (`../anuncios/statusAnuncio.ts`), and it
 * is why nothing is parsed here.
 *
 * ## ⚠️ The clock is a PARAMETER
 *
 * `opcoes.nowMs` is the logical instant of the tick, in **MILLISECONDS** — the
 * unit every stamp on a produto link doc carries. Nothing under
 * `lib/shopee/estoque/` reaches for the ambient clock, and the time half of
 * the skip set is why: an expiry compared against an instant this module chose
 * for itself would be untestable at exactly the instant that matters.
 *
 * ## The rungs, in order
 *
 * | # | condition | verdict |
 * |---|---|---|
 * | 1 | `item_id` absent, non-numeric, non-finite or ≤ 0 | `sem-item-id` |
 * | 2 | `estadoAnuncio` is `removido` / `banido` / `em_revisao` | the matching slug |
 * | 3 | `kitNativo === true` | `kit-derivado` |
 * | 4 | the skip set says "already refused in this exact state" | `recusa-anterior` |
 * | 5 | otherwise | **SEND** |
 *
 * ⚠️ The ORDER is load-bearing, not cosmetic. A `removido` listing carrying a
 * live refusal stamp answers `anuncio-removido`, never `recusa-anterior`: the
 * operator must read the terminal cause, not the latch that happens to sit on
 * top of it. And `ignorarRecusa` bypasses rung 4 **and only rung 4** — forcing
 * a re-send can never talk this gate past a deleted listing.
 *
 * ## Which `estadoAnuncio` values SEND, and why
 *
 * | estado | verdict | reasoning |
 * |---|---|---|
 * | `ativo` | **SEND** | — |
 * | `pausado` (an UNLIST, including the pre-launch one) | **SEND** | `update_stock`'s own error list carries no "item is unlisted" refusal; the guide names DELETION, not unlisting. A paused listing is one the seller means to re-list, and a stale number on re-list OVERSELLS — which is unrecoverable, unlike a refused call. If Shopee does refuse, the refusal arms the fingerprint and the cost is one call per listing per state change, not one per tick. |
 * | `agendado` | **SEND** | Stronger still: the listing goes live at a known instant carrying whatever quantity it holds. Sending is how it goes live correct. |
 * | `desconhecido` | **SEND** | An explicitly folded unknown is a READING, not a state (`statusAnuncio.ts`). A status Shopee invents tomorrow must cost one refused call, never a catalogue-wide outage. |
 * | `null` / absent | **SEND** | NEVER FOLDED — every link step 9 imported is one. Refusing would make the whole imported corpus unsendable. |
 * | `banido` | refuse | Down, and only Seller Centre lifts it. |
 * | `em_revisao` | refuse | A write during review may itself reset the review (UNVERIFIED), and the review ENDING moves `item_status` — which is precisely the skip set's clearing signal, so the listing is picked up on the very next sweep after it clears. That is what makes refusing safe *here* and not elsewhere. |
 * | `removido` | refuse | Terminal: a deleted item cannot have its stock modified. |
 *
 * ## ⚠️ The kit rung reads the LINK, never the produto
 *
 * `kitNativo` is what SHOPEE reported for this listing (`tag.kit`), stamped by
 * step 9's import. It is **not** the produto's own `ehKit` flag, and the two
 * must never be conflated: this ERP holds thousands of `ehKit` produtos that
 * are ORDINARY Shopee listings whose stock is sent at the component-derived
 * quantity, so reading the produto's flag here would be a total, silent stock
 * outage for the entire legacy kit catalogue. Three-valued on purpose — `null`
 * is a link imported before step 12 and it SENDS, which is the safe direction
 * because no native Shopee kit exists in this catalogue today. Only `true`
 * refuses.
 *
 * ⚠️ And with a link in hand, `kitNativo` is the ONLY thing that decides.
 * `produto` is carried for symmetry with the publish-side predicate
 * (`kitNativoDoAnuncio`, whose CREATE arm has no link to read and falls back to
 * `ehKitVirtual`); here a link always exists, so there is nothing to fall back
 * to and a fallback would re-open the same outage through a second door.
 *
 * ## The skip set — TWO mechanisms, one fold
 *
 * See {@link pularPorRecusaAnterior}. `||` between the mechanisms, `&&`
 * between the two fingerprint halves: **either half moving LIFTS the skip.**
 *
 * ⚠️ **Nobody writes a clear.** The four `item_status` writers (the publish
 * read-back, the pause, the re-verify and both push handlers) lift the skip by
 * doing their job, so a refusal expires against the very reading that caused
 * it rather than against a clock or a second writer free to disagree. The ONE
 * deliberate bypass is `opcoes.ignorarRecusa`, set from the route's and the
 * CLI's `reenviarComErro` — without it an operator who has just fixed the
 * listing in Seller Centre could not make a manual push try again until the
 * fingerprint moved on its own.
 *
 * ## ⚠️ Deliberately DIVERGES from `podeMoverAnuncioShopee`
 *
 * That one (`packages/schemas/src/produto/collection/shopeeLink.ts`) answers
 * *"may we change this listing's STATUS"*; this one answers *"will Shopee take
 * a QUANTITY"*. `banido`, `em_revisao` and `removido` refuse in both, but
 * `pausado` refuses there (`ja-pausado`) and **SENDS** here, and `agendado`
 * refuses there on `reativar` and sends here. They are two vocabularies free
 * to drift apart; a shared implementation would have to fuse them. The
 * divergence is stated in BOTH docblocks, and neither is the other's shortcut.
 *
 * No inventoried equivalence helper is reachable from here: the fingerprint is
 * a hand-rolled identity comparison after one absence normalisation, so the
 * #1372 obligation is discharged by the pair and the near-miss named in this
 * module's suite.
 */
import { ESTADO_ANUNCIO_SHOPEE } from '@delfrance/schemas';

import { MOTIVO_ESTOQUE_SHOPEE, type MotivoEstoqueShopee } from './errosEstoque';

/**
 * A stored `prodshopee` link, as read — never as parsed.
 *
 * Only the eight fields this gate reads are named; the index signature is what
 * lets a caller hand over the whole document (or a discovery row carrying
 * twenty more columns) without shaping it first.
 */
export interface LinkParaEstoque {
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

/** The verdict. A discriminated union so a caller cannot read a motivo off a send. */
export type VereditoEnvioEstoque =
  | { readonly enviar: true }
  | { readonly enviar: false; readonly motivo: MotivoEstoqueShopee };

/** What the gate needs beyond the two documents. */
export interface OpcoesDeEnvioEstoque {
  /** The tick's logical instant, in MILLISECONDS. */
  readonly nowMs: number;
  /**
   * Bypass the skip set — and NOTHING else. Set from the route's and the CLI's
   * `reenviarComErro`; a `removido` listing still refuses.
   */
  readonly ignorarRecusa?: boolean;
}

/**
 * The gate. Pure, total, non-throwing.
 *
 * @param link the stored link document, unvalidated
 * @param produto carried for symmetry with the publish-side predicate and
 *   deliberately NOT consulted: with a link resolved, only `link.kitNativo`
 *   decides whether this listing is a kit
 * @param opcoes the tick's instant, plus the one bypass
 */
export function podeEnviarEstoqueShopee(
  link: LinkParaEstoque,
  produto: { ehKitVirtual?: unknown },
  opcoes: OpcoesDeEnvioEstoque,
): VereditoEnvioEstoque {
  // 1 — never published. ⚠️ `typeof === 'number'`, so a STRINGIFIED id reads as
  // absent: the field is a typed `z.number().int()` and nothing in this repo
  // writes it as a string, but a corpus row that did takes the false-negative
  // direction — recorded rather than guessed around, exactly as
  // `anuncioShopeeVivo` records it.
  const itemId = link.item_id;
  if (typeof itemId !== 'number' || !Number.isFinite(itemId) || itemId <= 0) {
    return { enviar: false, motivo: MOTIVO_ESTOQUE_SHOPEE.semItemId };
  }

  // 2 — the three lifecycle states that refuse. Everything else sends; see the
  // module docblock's table for why each one does.
  const estado = link.estadoAnuncio;
  if (estado === ESTADO_ANUNCIO_SHOPEE.removido) {
    return { enviar: false, motivo: MOTIVO_ESTOQUE_SHOPEE.anuncioRemovido };
  }
  if (estado === ESTADO_ANUNCIO_SHOPEE.banido) {
    return { enviar: false, motivo: MOTIVO_ESTOQUE_SHOPEE.anuncioBanido };
  }
  if (estado === ESTADO_ANUNCIO_SHOPEE.emRevisao) {
    return { enviar: false, motivo: MOTIVO_ESTOQUE_SHOPEE.anuncioEmRevisao };
  }

  // 3 — ⚠️ the LINK's flag, and an EXACT `=== true`. `false`, `null` and absent
  // all SEND. The produto is not consulted at all; see the docblock.
  if (link.kitNativo === true) {
    return { enviar: false, motivo: MOTIVO_ESTOQUE_SHOPEE.kitDerivado };
  }

  // 4 — the skip set, unless the operator explicitly asked to force a re-send.
  if (opcoes.ignorarRecusa !== true && pularPorRecusaAnterior(link, opcoes.nowMs)) {
    return { enviar: false, motivo: MOTIVO_ESTOQUE_SHOPEE.recusaAnterior };
  }

  // 5 — worth asking Shopee. ⚠️ Never "Shopee will accept it": the provider's
  // own `failure_list` is the authority and it refuses things this function
  // cannot see (a promotion locking the listing, above all).
  return { enviar: true };
}

/**
 * The skip set — *"have we already been refused with this listing in exactly
 * this state?"*. Exported because the sweep asks it directly and because a
 * fold this consequential is pinned by its own tests.
 *
 * ```
 * pular = (typeof estoqueRecusaAte === 'number' && nowMs < estoqueRecusaAte)   // TIME
 *      || (typeof estoqueRecusaEm  === 'number'                                // STATE
 *          && estoqueRecusaEstado      === estadoAnuncio
 *          && estoqueRecusaItemStatus  === item_status)
 * ```
 *
 * ⚠️ **`||` between the two mechanisms, `&&` between the two fingerprint
 * halves.** Either half moving lifts the skip — that is the whole design, and
 * an `||` there would latch a listing until BOTH halves moved, which for a
 * refusal caused by the state itself is "for ever".
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
 */
export function pularPorRecusaAnterior(link: LinkParaEstoque, nowMs: number): boolean {
  // ⚠️ No `Number.isFinite` guard, deliberately: a `NaN` expiry falls out of
  // the comparison itself (`nowMs < NaN` is `false`), and a redundant guard
  // would read as though the comparison needed help.
  const ate = link.estoqueRecusaAte;
  if (typeof ate === 'number' && nowMs < ate) return true;

  if (typeof link.estoqueRecusaEm !== 'number') return false;
  return (
    ouNulo(link.estoqueRecusaEstado) === ouNulo(link.estadoAnuncio) &&
    ouNulo(link.estoqueRecusaItemStatus) === ouNulo(link.item_status)
  );
}

/**
 * `undefined` ⇒ `null`; every other value is returned untouched. The one
 * normalisation the fingerprint applies — see {@link pularPorRecusaAnterior}.
 */
function ouNulo(valor: unknown): unknown {
  return valor === undefined ? null : valor;
}
