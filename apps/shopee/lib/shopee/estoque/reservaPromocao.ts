/**
 * **The reserved floor** (#1520, step 12) — Shopee holds units back for a
 * promotion, and `update_stock` REFUSES a quantity that would leave fewer units
 * than the promotion reserved. This module turns one `get_item_promotion`
 * payload into a per-model floor, raises a quantity to it, recognises the
 * refusal that asks for it, and answers whether a floor is simply impossible.
 *
 * ## ⚠️ Shopee's reserve is NOT this ERP's reserve
 *
 * Shopee's `total_reserved_stock` is a PROMOTION reserve that sets a FLOOR we
 * clamp **UP** to, whereas this ERP's `quantidadeReservada` is the held
 * reservation that is **SUBTRACTED** to get availability
 * (`disponivel = quantidade − reservaEfetiva(...)`, ADR 0014 §7) — two numbers
 * with the same name in two different languages, pulling in OPPOSITE
 * directions. They must never be summed, compared or folded into one another,
 * and nothing in this file reads, writes or floors the ERP counter: the
 * quantity arrives already computed from it (`./quantidadeEstoque`) and this
 * module only ever raises that number.
 *
 * ## PURE — and that is the whole point
 *
 * No Firestore, no clock, no Shopee call, no writes. The sender
 * (`./enviarEstoque`) makes the ONE `get_item_promotion` request and hands over
 * its payload; everything here is a function of that payload plus numbers. It
 * is what makes the floor testable against a wire body nobody can produce on
 * demand — the sandbox carries no Discount/Marketing module, so a non-zero
 * reserve is not rehearsable there (E1 §15).
 *
 * ## ⚠️ The floor is read LAZILY, on a refusal (C-e)
 *
 * The sender does **not** read promotions up front. An eager read costs 2N
 * Shopee calls per tick against a daily quota that is per APP — shared by every
 * Shopee call this monorepo makes — to learn `null` for every listing with no
 * promotion. The lazy read fires exactly when the clamp would have mattered,
 * and the refusal IS the evidence a promotion exists, which no cheap read
 * gives: `has_promotion` on `get_item_base_info` is ONGOING-only and so cannot
 * rule out an `upcoming` promotion anyway.
 *
 * The cost is one refused call per listing per promotion, visible in the logs.
 *
 * ## The exact inequality, and the term this module does NOT carry
 *
 * `faq 59`: `Σ seller_stock ≥ total_reserved_stock − Σ shopee_stock`. The
 * `shopee_stock` term is FBS stock this integration can never write, and it
 * RELIEVES the floor — which is why the floor can legitimately be negative, in
 * which case any value passes.
 *
 * ⚠️ **`Σ shopee_stock` is deliberately NOT subtracted here.** It is proven to
 * be `0` once per conta, not once per item: the conta gate reads
 * `shop_fulfillment_flag`, and every value except `Pure - FBS Shop` means the
 * shop holds no Shopee-warehouse stock — while `Pure - FBS Shop` can never take
 * a seller-stock write at all and never reaches this module. Subtracting it per
 * item would cost one `get_model_list` per listing to learn a constant the
 * conta already proved.
 *
 * ## ⚠️ MAX over promotions, never a SUM
 *
 * `update_stock`'s own definition is singular and per promotion: *"whenever
 * there is a promotion ongoing or upcoming, the total stock must be larger than
 * or equal to real-time reserved_stock"*. A quantity satisfying the LARGEST
 * reservation satisfies every one of them, so the maximum is the smallest
 * correct answer; a sum would publish stock the ERP does not hold.
 *
 * Whether Shopee itself sums concurrent reservations is UNVERIFIED — no page
 * says. If it does, the clamped retry earns a SECOND refusal and the sender
 * records it as terminal, carrying the raw code: **the refusal is the sensor**,
 * and it is a loud one. Summing here to pre-empt a case nobody has measured
 * would over-publish on every shop where Shopee does not sum, which is the one
 * direction that oversells.
 *
 * ## ⚠️ `upcoming` COUNTS
 *
 * `promotion_staging` is documented as `ongoing` | `upcoming` and nothing else
 * — the list arrives pre-filtered to the two stagings that can block a write —
 * and the definition above names both. Nothing in this module filters on it.
 * Dropping `upcoming` rows would under-clamp at exactly the moment a promotion
 * is about to start, which is when the reservation is newest and the ERP's
 * number is most likely to be below it.
 *
 * ## ⚠️ BOTH field positions, through ONE reader
 *
 * `get_item_promotion`'s response table declares `total_reserved_stock` as a
 * SIBLING of `summary_info`; its own JSON sample NESTS it inside `summary_info`.
 * Both are declared on the schema and `reservadoDaPromocao`
 * (`@delfrance/integrations-shopee`) is the single reader that decides which
 * wins — nested first, then the sibling, else `null`. This file must never
 * reach into either position itself: a second reader is a second answer to a
 * contradiction the page has not settled.
 *
 * `null` there means *"the page said nothing"*, never zero. A missing value
 * read as `0` would compute a floor of zero and conclude every write is safe.
 *
 * ## The tolerant no-promotion parse
 *
 * An item with no promotion is the ORDINARY case, and its exact wire shape is
 * measured only in part (the probe saw `success_list: [{item_id, promotion: []}]`
 * — zero rows, no failure). So: an absent / `null` / empty `promotion`, a row
 * for a different `item_id`, our item sitting in `failure_list`, our item in
 * NEITHER list, or a promotion row with neither field position — every one of
 * them yields **no floor for that model**, and none of them throws.
 *
 * ⚠️ "No floor" is an ABSENT map entry, never a `0` entry. A zero floor is a
 * statement ("Shopee reserves nothing"); an absent one is the absence of a
 * statement, and only the sender can decide what to do with it — which it does,
 * by going terminal instead of retrying a call it has no new information for.
 *
 * ## ⚠️ `model_id` absent ⇒ model `0`, the no-model item
 *
 * A simple listing with no variations is addressed as `model_id: 0` on the
 * write side, and `0` is a legitimate key — never a falsy one. A promotion row
 * that omits `model_id` is a promotion on that same no-model item, so it is
 * keyed there rather than dropped.
 *
 * ⚠️ The narrow is `typeof === 'number'`, so on an UNPARSED body a STRINGIFIED
 * `model_id` reads as absent and lands on `0` rather than on its own model.
 * That cannot happen on the real path — the package's own tolerance turns a
 * numeric string into a number before this module ever sees it — and on a
 * hand-made body it takes the FALSE-NEGATIVE direction: the sender looks up a
 * model id it does not find, gets no floor, and goes terminal. The alternative,
 * coercing here, would be a second tolerance free to disagree with the one in
 * the schema. Recorded rather than guessed around, exactly as the send gate
 * records the same choice for `item_id`.
 *
 * ## The folds this module applies, and where they STOP (#1372)
 *
 * Three, all named by a PAIR and a NEAR-MISS in this module's suite:
 *
 *  1. **`model_id`**: `0`, `null` and an absent key are ONE model. DISTINCT:
 *     every actual model id, `0` included — model `0` and model `2000458802`
 *     never merge.
 *  2. **the two field positions**: the nested and the sibling readings of one
 *     number are the SAME fact (folded by `reservadoDaPromocao`, not here).
 *     DISTINCT: a row carrying neither, which yields no floor rather than zero.
 *  3. **the refusal message** ({@link ehRecusaDePiso}): case is folded and the
 *     two documented spellings `reserved stock` / `reserve stock` are the same
 *     needle. DISTINCT: every other refusal on the page — a location refusal
 *     and a holiday refusal both mention stock and neither is this one.
 *
 * None of them routes through an inventoried equivalence helper (the match is a
 * hand-rolled lowercase substring test), so no `equivalence-fold-inventory`
 * entry is owed; the obligation is discharged by the named pairs.
 */
import {
  type ShopeeItemPromotionPayload,
  reservadoDaPromocao,
} from '@delfrance/integrations-shopee';

/**
 * The key a promotion row without a `model_id` is filed under — the same id the
 * write side uses for a listing with no variations.
 *
 * ⚠️ A legitimate key, never a falsy placeholder. Nothing may test it for
 * truthiness on the way back out.
 */
const MODELO_SEM_VARIACAO = 0;

/**
 * The two documented spellings of the reserved-stock refusal, lowercased.
 *
 * `reserve` is NOT a prefix of `reserved` followed by a space, so the two
 * needles are independent and both are required: Shopee's own error list
 * carries `… less than reserved stock` and `… less than reserve stock` on the
 * same page.
 */
const AGULHAS_DE_PISO = ['reserved stock', 'reserve stock'] as const;

/**
 * The floor per `model_id` for ONE listing — the MAXIMUM over that model's
 * promotion rows.
 *
 * Rows for any other `item_id` are ignored, so the caller may hand over a
 * multi-item payload unsliced. A model with no usable row gets NO entry.
 *
 * @param payload the body `get_item_promotion` answered, already parsed
 * @param itemId the listing whose rows to read
 * @returns model id → floor. Empty when the listing has no promotion, when it
 *   came back in `failure_list`, or when it is in neither list.
 */
export function pisoPorModelo(
  payload: ShopeeItemPromotionPayload,
  itemId: number,
): ReadonlyMap<number, number> {
  const pisos = new Map<number, number>();

  // ⚠️ The guards below cover shapes the parsed type already excludes. They are
  // deliberate: this function is also the one a caller reaches for with a body
  // it read from a log or a fixture, and answering an empty map for a shape we
  // do not recognise is the whole contract. Nothing here may throw.
  const linhas = payload.success_list;
  if (!Array.isArray(linhas)) return pisos;

  for (const linha of linhas) {
    if (linha == null) continue;
    // The listing filter. Strict identity — the ids are numbers on both sides
    // and a string id is a different reading, not the same listing.
    if (linha.item_id !== itemId) continue;

    const promocoes = linha.promotion;
    if (!Array.isArray(promocoes)) continue;

    for (const promocao of promocoes) {
      if (promocao == null) continue;

      // ⚠️ ONE reader for the two documented positions. Never reach into
      // `promotion_stock_info_v2` here.
      const reservado = reservadoDaPromocao(promocao);
      if (typeof reservado !== 'number' || !Number.isFinite(reservado)) continue;

      const modelo: unknown = promocao.model_id;
      const chave =
        typeof modelo === 'number' && Number.isFinite(modelo) ? modelo : MODELO_SEM_VARIACAO;

      // ⚠️ MAX, never `+`. See the module docblock: a quantity satisfying the
      // largest reservation satisfies all of them.
      const anterior = pisos.get(chave);
      pisos.set(chave, anterior === undefined ? reservado : Math.max(anterior, reservado));
    }
  }

  return pisos;
}

/** What {@link aplicarPiso} answers: the value to send, and whether it MOVED. */
export interface PisoAplicado {
  /** The quantity to send — the original one, or the floor when the floor is higher. */
  readonly valor: number;
  /** `true` only when the floor actually raised the value. Equal is NOT a clamp. */
  readonly clampado: boolean;
}

/**
 * Raise a quantity to its floor. **UP only, never down.**
 *
 * ⚠️ `Math.max`, never an assignment and never `Math.min`. A floor BELOW the
 * quantity is satisfied already and must change nothing — lowering the number
 * to the reservation would publish less stock than the ERP holds every time a
 * promotion exists, turning a safety rail into a sales cap.
 *
 * ⚠️ A floor that is `null`, non-finite, negative or zero changes nothing
 * either. `faq 59`'s floor is `total_reserved_stock − Σ shopee_stock` and is
 * documented to go negative ("any value greater than 0 is fine"); a negative
 * ceiling-of-a-floor is not an instruction to lower anything.
 *
 * ⚠️ `clampado` is true only when the value MOVED. At `quantidade === piso` the
 * request already satisfies the inequality, so nothing was clamped, nothing is
 * being published above what the ERP holds, and no aviso is owed.
 */
export function aplicarPiso(quantidade: number, piso: number | null): PisoAplicado {
  if (typeof piso !== 'number' || !Number.isFinite(piso)) {
    return { valor: quantidade, clampado: false };
  }
  const valor = Math.max(quantidade, piso);
  return { valor, clampado: valor > quantidade };
}

/**
 * Arm A's needle — *"is this refusal the reserved floor asking to be read?"*.
 *
 * ⚠️ **Message-matched, and code-BLIND on purpose.** Shopee spells this refusal
 * under at least three different codes on one page, and one of them is
 * `error.param` — with a DOT, which the module-prefix stripper reduces to the
 * bare word `param`. A code-keyed arm would therefore have to enumerate a
 * spelling that is indistinguishable from a generic parameter error, and would
 * miss the next code Shopee files the same sentence under. The SENTENCE is the
 * stable part here; the code is not.
 *
 * This is why arm A sits FIRST in the sender's ladder: it is the only arm that
 * ignores the code entirely, so every later arm may safely assume the refusal
 * is not about the floor.
 *
 * The fold: case is folded, and the two documented spellings `reserved stock`
 * and `reserve stock` are one needle. It stops there — nothing is trimmed of
 * punctuation, stemmed or matched by word. A location refusal and a holiday
 * refusal both mention stock and neither is this one.
 */
export function ehRecusaDePiso(mensagem: string): boolean {
  const texto = mensagem.toLowerCase();
  return AGULHAS_DE_PISO.some((agulha) => texto.includes(agulha));
}

/**
 * *"Would the clamped request be impossible?"* — the floor is above the highest
 * quantity this listing's category accepts, so Shopee must refuse it and the
 * sender records the outcome WITHOUT spending a call.
 *
 * ⚠️ This is a REFUSAL predicate, never a second clamp. The value is never
 * lowered to the band: only the promotion can be reduced, and an ERP that
 * quietly published the band's maximum would be reporting a number it does not
 * hold AND still failing the floor.
 *
 * ⚠️ Strictly `>`. A floor exactly equal to the band's maximum is a request the
 * category accepts.
 *
 * ⚠️ An unresolved band is `null` — and the sweep's own binding spells "no band
 * resolved" as a POSITIVE INFINITY ceiling, which no finite floor can exceed.
 * Both readings answer `false`, which is the safe direction: an unknown band
 * must never manufacture a refusal. The probe measured a live category whose
 * `stock_limit` came back with both bounds `null`, so this is the common case,
 * not the corner.
 */
export function pisoAcimaDaBanda(piso: number | null, bandaMax: number | null): boolean {
  if (typeof piso !== 'number' || !Number.isFinite(piso)) return false;
  if (typeof bandaMax !== 'number' || !Number.isFinite(bandaMax)) return false;
  return piso > bandaMax;
}
