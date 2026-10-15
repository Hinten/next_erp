/**
 * The 11 `as unknown as` casts in the order pipeline, pinned against bodies ML
 * actually sent.
 *
 * ## What is being protected
 * `no-unvalidated-response` bans asserting a type onto an HTTP response body,
 * but these casts are not that rule's shape: they re-read an ALREADY-parsed
 * `MlOrder` to reach fields the Zod schema does not name. The schema is
 * `.passthrough()`, so the data is genuinely there — and genuinely unchecked.
 * Nothing in the suite has ever compared the field names in these interfaces
 * against the field names ML sends.
 *
 * That gap has already cost us once: `orderMLWire.ts:267` writes
 * `date_last_updated: null` on every payment, while ML sends the field as
 * `date_last_modified`. The corpus proves the ML half — `/orders/{id}` carries
 * `date_last_modified: string` and no `date_last_updated`.
 *
 * ⚠️ An earlier version of this file went further and claimed the two ORDER
 * ENDPOINTS disagree on the name. That was wrong. It rested on
 * `order-single.json` / `order-pack.json`, which were not captures but
 * `buildOrderMLWire`'s Firestore mirror — so the `date_last_updated` there was
 * our own output read back as ML's. Both files are gone (#1419) and the claim is
 * retracted; the corpus holds no `/orders/search` capture, so that question is
 * open rather than answered.
 *
 * ## Why this is an INVENTORY and not a pile of `toBeDefined()`
 * Most of these fields are legitimately optional. `coupon`, `pickup_id` and
 * `expiration_date` are simply absent from all three captured orders, and
 * asserting their presence would fail against correct behaviour. So the census
 * below records what the corpus SAYS — including `ABSENT` — and the test compares
 * the whole table. Any movement reds, and a human decides whether ML changed or
 * the corpus grew.
 *
 * ⚠️ When this fails after a fixture refresh, the fix is to update the table
 * **after** checking which direction moved. A field going `string` → `ABSENT` is
 * ML dropping it; `ABSENT` → `string` is usually just a richer capture.
 */
import { describe, expect, it } from 'vitest';

import { listWireFixtures, readWireFixture } from './wireCorpus';
import {
  type WireShape,
  hasPathOrDescendants,
  mergeShapes,
  typesAt,
  wireShape,
} from './wireDigest';

/** `GET /orders/{id}` detail bodies — the three the run captured. */
const ORDER_DETAIL = /^orders-\d+\.json$/;

function shapeOf(pattern: RegExp): WireShape {
  const files = listWireFixtures().filter((f) => pattern.test(f));
  // ⚠️ A pattern that matches nothing would make every assertion below vacuous.
  expect(files.length, `nenhuma fixture casou com ${pattern}`).toBeGreaterThan(0);
  return mergeShapes(files.map((f) => wireShape(readWireFixture(f))));
}

function census(shape: WireShape, path: string): string {
  const types = [...typesAt(shape, path)].sort();
  if (types.length > 0) return types.join('|');
  return hasPathOrDescendants(shape, path) ? 'container' : 'ABSENT';
}

/**
 * Every path the order pipeline's casts assume, and what the captured orders
 * actually carry. Measured, not transcribed from the interfaces.
 */
const CAST_CENSUS: readonly (readonly [site: string, path: string, observed: string])[] = [
  // orderPedidoTx.ts:251 — MlOrderWithEmbeddedPayments
  ['orderPedidoTx:251', 'payments', 'container'],

  // orderImport.ts:324 — MlOrderSellerPassthrough
  ['orderImport:324', 'seller.id', 'number'],

  // orderMapping.ts:126 — MlOrderPassthroughFields. It reads BOTH fields; the
  // `payments` row is what keeps this site from being pinned by an absence alone.
  ['orderMapping:126', 'payments', 'container'],
  ['orderMapping:126', 'comment', 'ABSENT'],

  // orderMapping.ts:139 — MlOrderItemPassthroughFields
  ['orderMapping:139', 'order_items[].discounts[].amounts.full', 'ABSENT'],

  // orderMLWire.ts:75 — MlOrderWireExtras
  ['orderMLWire:75', 'status_detail', 'null'],
  ['orderMLWire:75', 'date_closed', 'string'],
  ['orderMLWire:75', 'expiration_date', 'ABSENT'],
  ['orderMLWire:75', 'manufacturing_ending_date', 'null'],
  ['orderMLWire:75', 'pickup_id', 'ABSENT'],
  ['orderMLWire:75', 'buying_mode', 'string'],
  ['orderMLWire:75', 'shipping_cost', 'null'],
  ['orderMLWire:75', 'paid_amount', 'number'],
  ['orderMLWire:75', 'coupon', 'ABSENT'],

  // orderMLWire.ts:85 — MlOrderBuyerExtras
  ['orderMLWire:85', 'buyer.nickname', 'string'],
  ['orderMLWire:85', 'buyer.first_name', 'string'],
  ['orderMLWire:85', 'buyer.last_name', 'string'],

  // orderMLWire.ts:113 — MlOrderItemLineExtras
  ['orderMLWire:113', 'order_items[].item.category_id', 'string'],
  ['orderMLWire:113', 'order_items[].item.seller_custom_field', 'null|string'],
  ['orderMLWire:113', 'order_items[].item.variation_attributes', '[]'],
  ['orderMLWire:113', 'order_items[].item.warranty', 'null|string'],
  ['orderMLWire:113', 'order_items[].item.condition', 'string'],
  ['orderMLWire:113', 'order_items[].item.global_price', 'null'],
  ['orderMLWire:113', 'order_items[].item.net_weight', 'null'],
  ['orderMLWire:113', 'order_items[].requested_quantity.value', 'number'],
  ['orderMLWire:113', 'order_items[].requested_quantity.measure', 'string'],
  ['orderMLWire:113', 'order_items[].picked_quantity', 'null'],
  ['orderMLWire:113', 'order_items[].manufacturing_days', 'null'],
  ['orderMLWire:113', 'order_items[].sale_fee', 'number'],
  ['orderMLWire:113', 'order_items[].listing_type_id', 'string'],
];

/**
 * Cast sites this corpus **cannot** verify, each with the reason.
 *
 * ⚠️ This list is a coverage gap stated out loud, not an exemption granted. §9
 * of `LIVE-TEST.md` named `payments[]` and `discounts[]` as the two order fields
 * read through unchecked casts; the corpus settles `payments[]` and leaves
 * `discounts[]` exactly where it was, because none of the three captured orders
 * carried a discount. Coupons could not be exercised on a test seller during
 * #1087 (§6.3/6.4), so this is a consequence of that deferral rather than an
 * oversight here.
 *
 * ⚠️ It is asserted as an EQUALITY, so a site that quietly loses its evidence
 * joins this list only by someone editing this constant. A silent cap that reads
 * as "covered everything" is the failure mode being prevented.
 *
 * To close it: capture one order that used a coupon, promote it, and the census
 * row plus this entry both change.
 */
const SITES_SEM_EVIDENCIA: readonly string[] = [
  // MlOrderItemPassthroughFields — reads only `discounts[].amounts.full`.
  'orderMapping:139',
];

describe('order-pipeline casts vs real ML bodies', () => {
  const orders = shapeOf(ORDER_DETAIL);

  it('every cast-asserted path still carries the type the corpus recorded', () => {
    const atual = CAST_CENSUS.map(([site, path]) => `${site}  ${path}: ${census(orders, path)}`);
    const esperado = CAST_CENSUS.map(([site, path, observed]) => `${site}  ${path}: ${observed}`);
    expect(atual).toEqual(esperado);
  });

  it('names at least one populated field per cast site, so no site is pinned only by absences', () => {
    // ⚠️ A site whose every path is ABSENT or null is inventoried but not
    // actually tested — the row would keep passing if ML deleted the whole
    // structure. This asserts each site has real evidence behind it, and the
    // exemptions below have to be declared rather than discovered.
    const sites = [...new Set(CAST_CENSUS.map(([site]) => site))];
    const semEvidencia = sites.filter(
      (site) =>
        CAST_CENSUS.filter(
          ([s, , observed]) => s === site && observed !== 'ABSENT' && observed !== 'null',
        ).length === 0,
    );

    expect(semEvidencia).toEqual([...SITES_SEM_EVIDENCIA]);
  });
});

describe('the payment date-field mismatch (#1087)', () => {
  const orders = shapeOf(ORDER_DETAIL);

  it('ML sends date_last_modified — and never date_last_updated', () => {
    // `orderMLWire.ts:267` hardcodes `date_last_updated: null` on every payment
    // and its comment says why. This is that comment turned into evidence: the
    // field our builder emits does not exist on the wire, and the one ML sends
    // is dropped.
    expect([...typesAt(orders, 'payments[].date_last_modified')]).toEqual(['string']);
    expect(typesAt(orders, 'payments[].date_last_updated').size).toBe(0);
  });

  it('the sibling payment dates our builder DOES read are really there', () => {
    // The control for the assertion above: if the whole payments[] block were
    // missing, "date_last_updated is absent" would pass for the wrong reason.
    expect([...typesAt(orders, 'payments[].date_created')]).toEqual(['string']);
    expect([...typesAt(orders, 'payments[].date_approved')]).toEqual(['string']);
  });

  it('⚠️ RETRACTED — there is no evidence of an endpoint disagreement', () => {
    // This slot used to assert that `/orders/search` sends `date_last_updated`
    // while `/orders/{id}` sends `date_last_modified` — "the two endpoints
    // disagree". That was WRONG, and the mistake is worth keeping visible.
    //
    // The evidence was `order-single.json` / `order-pack.json`, which turned out
    // not to be captures at all: they were `buildOrderMLWire`'s Firestore mirror,
    // carrying an ERP-only field, ms-epoch dates, and all three of
    // `buildPaymentWire`'s hardcodes. So `date_last_updated: null` there was OUR
    // OWN output being read back as if it were ML's. Both files are gone (#1419).
    //
    // What survives is the simpler claim the code already documented, asserted
    // just above: ML sends `date_last_modified`, our builder emits
    // `date_last_updated: null`, and the populated field is dropped.
    //
    // The corpus has no `/orders/search` capture, so the question is OPEN, not
    // answered. This assertion pins that absence so a future reader does not
    // mistake "we removed the bad evidence" for "we checked and it agrees".
    expect(listWireFixtures().filter((f) => /^order-(single|pack)\.json$/.test(f))).toEqual([]);
    expect(listWireFixtures().some((f) => f.includes('search'))).toBe(false);
  });
});

describe('facts the live run established, pinned so they cannot rot silently', () => {
  it('a User-Products item returns an EMPTY variations array', () => {
    // Not "no variations key" — an empty one. The whole UP publish path turns on
    // this, and it was established by reading real items during #1087.
    const itens = shapeOf(/^items?-MLB\d+\.json$/);
    expect([...typesAt(itens, 'variations')]).toEqual(['[]']);
  });

  it('the money map reads a payments array that is present and populated', () => {
    const orders = shapeOf(ORDER_DETAIL);
    expect(hasPathOrDescendants(orders, 'payments')).toBe(true);
    expect([...typesAt(orders, 'payments[].transaction_amount')]).toEqual(['number']);
    expect([...typesAt(orders, 'payments[].marketplace_fee')]).toEqual(['number']);
    expect([...typesAt(orders, 'payments[].shipping_cost')]).toEqual(['number']);
  });

  it('an order carries seller.id as a NUMBER, which orderSellerId widens to string|number', () => {
    // `MlOrderSellerPassthrough` declares `number | string | null`. The corpus
    // only ever shows `number`; the widening is defensive, and this records that
    // the string arm has never been observed rather than letting it look proven.
    expect([...typesAt(shapeOf(ORDER_DETAIL), 'seller.id')]).toEqual(['number']);
  });
});
