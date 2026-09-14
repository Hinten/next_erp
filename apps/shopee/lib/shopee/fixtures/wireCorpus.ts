/**
 * Reader for the committed `__wire__/` corpus — Shopee response bodies, redacted
 * by `redact.ts` before they were written.
 *
 * ⚠️ **Two provenances, and they are not equally strong.** THREE of these bodies
 * are what SHOPEE SENT — the SG sandbox order in `READY_TO_SHIP` (pasted
 * 2026-09-09), its `get_escrow_detail` twin and the same order re-read after
 * arrange-shipment (both pasted 2026-09-10); the other two are the samples
 * Shopee's own documentation PRINTS. Both beat a hand-written fixture, which
 * agrees with our belief about the wire rather than with the wire — but a doc
 * sample can still be wrong about the live API, and one of them demonstrably is
 * (see `__wire__/README.md`, the kit ids). The file names say which is which.
 *
 * ⚠️ **Read them, never rewrite them.** A test that edits a body to make an
 * assertion pass has converted the only evidence in the suite back into a
 * hand-written fixture. If a body looks wrong, the finding is about our code or
 * about Shopee — not about the file.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  type ShopeeEscrowDetailResponse,
  type ShopeeOrderDetailResponse,
  shopeeEscrowDetailSchema,
  shopeeOrderDetailSchema,
} from '@delfrance/integrations-shopee';

import type { WireValue } from './redact';

export const WIRE_DIR = join(import.meta.dirname, '__wire__');

/** The SG sandbox `get_order_detail`, quantity 2, `READY_TO_SHIP` — Shopee SENT it. */
export const FIXTURE_ORDER_DETAIL_QTY2_SG = 'get_order_detail.qty2-sg.json';
/**
 * The SAME SG sandbox order re-read after arrange-shipment — `PROCESSED`,
 * `LOGISTICS_REQUEST_CREATED`, an advanced `update_time`. Shopee SENT it.
 *
 * ⚠️ The pair with {@link FIXTURE_ORDER_DETAIL_QTY2_SG} is what makes it worth
 * committing: one order at two points in its lifecycle is the only body that can
 * say which fields MOVE (status, logistics, `update_time`) and which do not
 * (the recipient is still `"****"`, `actual_shipping_fee` still `0`).
 */
export const FIXTURE_ORDER_DETAIL_QTY2_SG_PROCESSED = 'get_order_detail.qty2-sg-processed.json';
/** Shopee's own `get_order_detail` sample — a VN order, masked recipient. */
export const FIXTURE_ORDER_DETAIL_DOC_MASKED_VN = 'get_order_detail.doc-masked-vn.json';
/** Shopee's own `get_escrow_detail` sample — carries `is_kit` + `kit_items`. */
export const FIXTURE_ESCROW_DETAIL_DOC_KIT = 'get_escrow_detail.doc-kit.json';
/**
 * The SG sandbox order's escrow twin — Shopee SENT it (pasted 2026-09-10).
 *
 * ✅ It settled the two questions the empty slot was named for:
 * `SHOPEE_ESCROW_DETAIL_TRANSPORT` (the console test tool sent a **GET** with
 * `order_sn` in the QUERY STRING and an empty body) and the escrow reading of a
 * quantity-2 line — `discounted_price: 30` beside `quantity_purchased: 2` while
 * the detail says `model_discounted_price: 15`, so **the escrow figure is a LINE
 * TOTAL and the detail's is PER UNIT**, exactly as the page's "subtotal if
 * quantity exceeds 1" sentence claims.
 */
export const FIXTURE_ESCROW_DETAIL_QTY2_SG = 'get_escrow_detail.qty2-sg.json';

/** Every committed body, sorted. Excludes the README and any dotfile. */
export function listarFixtures(): string[] {
  if (!existsSync(WIRE_DIR)) return [];
  return readdirSync(WIRE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

/** Parse one committed body as plain JSON. Throws — a corpus file must parse. */
export function lerFixture(file: string): WireValue {
  return JSON.parse(readFileSync(join(WIRE_DIR, file), 'utf8')) as WireValue;
}

/**
 * One `get_order_detail` body through the package schema.
 *
 * ⚠️ It THROWS on a schema failure rather than returning a result: a fixture that
 * no longer parses is a finding about the schema or about the corpus, and
 * swallowing it would let a test assert over a silently empty order list.
 */
export function lerPedidoDetalhe(file: string): ShopeeOrderDetailResponse {
  return shopeeOrderDetailSchema.parse(lerFixture(file));
}

/** One `get_escrow_detail` body through the package schema. Throws, same reason. */
export function lerEscrowDetalhe(file: string): ShopeeEscrowDetailResponse {
  return shopeeEscrowDetailSchema.parse(lerFixture(file));
}
