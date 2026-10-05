/**
 * Reader for the committed `__wire__/` corpus — Shopee response bodies, redacted
 * by `redact.ts` before they were written.
 *
 * ⚠️ **Two provenances, and they are not equally strong.** SIX of these bodies
 * are what SHOPEE SENT — the SG sandbox order in `READY_TO_SHIP` (pasted
 * 2026-09-09), its `get_escrow_detail` twin and the same order re-read after
 * arrange-shipment (both pasted 2026-09-10), and step 15b's three
 * `search_package_list` answers (a read-only probe, 2026-10-01); the other NINE
 * are the samples Shopee's own documentation PRINTS — six of them step 17's
 * returns pages, because the SG sandbox has no Returns module at all
 * (`guide 644`). Both beat a hand-written
 * fixture, which agrees with our belief about the wire rather than with the
 * wire — but a doc sample can still be wrong about the live API, and two of them
 * demonstrably are (see `__wire__/README.md`: the kit ids, and the package
 * search's `sort` echo). The file names say which is which.
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
  type ShopeeReturnDetailEnvelope,
  type ShopeeReturnListEnvelope,
  type ShopeeSearchPackageListResponse,
  shopeeEscrowDetailSchema,
  shopeeOrderDetailSchema,
  shopeeReturnDetailSchema,
  shopeeReturnListSchema,
  shopeeSearchPackageListSchema,
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

/**
 * Shopee's own `search_package_list` sample — a VN channel (50021), one row,
 * `more: true` with the composite cursor. ⚠️ Its `sort` echo (`is_asc`) is NOT
 * what the wire sends; see {@link FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_DA_LOJA}.
 */
export const FIXTURE_SEARCH_PACKAGE_LIST_DOC = 'search_package_list.doc.json';
/**
 * The SG sandbox shop's `search_package_list` over its OWN two channels,
 * `invoice_pending: false` — ONE row, the step-14 `READY_TO_SHIP` order, not yet
 * arranged. Shopee SENT it (2026-10-01).
 *
 * ⚠️ **Its ids are FIXTURE ids, not the wire's.** The probe overwrote every
 * `order_sn` with `260910KJBHUJDM` and every `package_number` with
 * `OFG000000000001` before writing the body. So this row is NOT the quantity-2
 * order the other SG bodies carry under the same `order_sn` — that one has been
 * `PROCESSED` since 2026-09-10 and cannot be ToProcess. Never join two corpus
 * bodies on an id.
 *
 * ⚠️ It is the body that corrects the page: the response `sort` echoes
 * `{sort_type, ascending}` — the REQUEST's key — where the page's response
 * table and sample document `is_asc`. The row keys are the page's six, exactly.
 */
export const FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_DA_LOJA =
  'search_package_list.sg-canais-da-loja.json';
/**
 * The same call with `invoice_pending: true` — ZERO rows. Shopee SENT it.
 *
 * ⚠️ It proves `true` FILTERS (the shop's non-pending package is excluded); it
 * cannot tell what `false` means (register 222), because the SG shop has no
 * pending package to show either way.
 */
export const FIXTURE_SEARCH_PACKAGE_LIST_SG_INVOICE_PENDING_TRUE =
  'search_package_list.sg-invoice-pending-true.json';
/**
 * The sweep's own channel set `[90011, 90012, 90026]` — channels the SG shop
 * does not have — `invoice_pending: false`: ZERO rows. Shopee SENT it.
 *
 * ⚠️ The empty answer's SHAPE (register 223): `packages_list: []`, never `null`
 * or absent, WITH `pagination {total_count: 0, more: false, next_cursor: ""}`.
 * And the channel filter is honoured SERVER-side (register 224): the shop's own
 * package, listed by {@link FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_DA_LOJA}, is
 * not here.
 */
export const FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_TURBO =
  'search_package_list.sg-canais-turbo.json';

/*
 * The RETURNS (step 17, #1525) — six doc samples, one per v1 operation, and
 * NOTHING Shopee sent: returns are not in the SG sandbox (`guide 644`), so every
 * one of them is ❌ unverified for BR until register 231–247 is read off a BR
 * shop.
 *
 * ⚠️ **Their ids are FIXTURE ids, never the page's** — `order_sn`
 * `260910KJBHUJDM`, item `2500139861`, model/variation `2000458802`, and the
 * `return_sn`s `260910ABCDE0001` (the detail: ALPHANUMERIC, as the page's own
 * sample is — a digits-only guard must meet one), `2609100000000001` (the list
 * row and `confirm`) and `2609100000000002` (`get_available_solutions`, `offer`,
 * `accept_offer`). Never join two bodies on one of them.
 *
 * ⚠️ **Their `error` is the page's, verbatim, and it is not `''`**: `"-"` on the
 * two reads, one SPACE on the other four. That is exactly what
 * `SHOPEE_RETURNS_ERROR_ALIASES` tolerates per call site, so these bodies are
 * the alias's evidence — served through a fake `fetch`, each resolves only
 * because its op carries the alias.
 */

/**
 * Shopee's own `get_return_detail` sample — EVERY buyer block present before
 * redaction (`user`, the pickup address, `image`, `buyer_videos`, `text_reason`,
 * the reverse `tracking_number`), plus the three spellings the page contradicts
 * itself on: `reverse_logistic_status` (no `s`; the table has one),
 * `dispute_reason: 2` (a NUMBER; the table says `string[]`) and
 * `dispute_text_reason` as a STRING (the table says `string[]`).
 */
export const FIXTURE_RETURN_DETAIL_DOC = 'get_return_detail.doc.json';
/**
 * Shopee's own `get_return_list` sample — one row, `more: true`, the three
 * sub-statuses FLAT, `dispute_reason: ["UNKNOWN"]`, `refund_amount: 1409`.
 */
export const FIXTURE_RETURN_LIST_DOC = 'get_return_list.doc.json';
/** Shopee's own `get_available_solutions` sample — both offers, min and max, `"error": " "`. */
export const FIXTURE_RETURN_AVAILABLE_SOLUTIONS_DOC = 'get_available_solutions.doc.json';
/** Shopee's own `confirm` sample — `{return_sn}` under `"error": " "`. */
export const FIXTURE_RETURN_CONFIRM_DOC = 'confirm.doc.json';
/** Shopee's own `offer` sample — `{return_sn}` under `"error": " "`. */
export const FIXTURE_RETURN_OFFER_DOC = 'offer.doc.json';
/** Shopee's own `accept_offer` sample — `{return_sn}` under `"error": " "`. */
export const FIXTURE_RETURN_ACCEPT_OFFER_DOC = 'accept_offer.doc.json';

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

/**
 * One `search_package_list` body through the package schema. Throws, same
 * reason — and here it matters twice: a page whose rows went `null` would PARSE,
 * so a test must also look at the rows it got, never only at "no throw".
 */
export function lerBuscaDePacotes(file: string): ShopeeSearchPackageListResponse {
  return shopeeSearchPackageListSchema.parse(lerFixture(file));
}

/**
 * One `get_return_detail` body through the package schema — the WHOLE envelope,
 * as the client returns it (#1525 R-17). Throws, same reason.
 *
 * ⚠️ The schema is a STRIP object: the redacted buyer blocks still in the file
 * do not survive this parse, which is what a key walk over its output pins.
 */
export function lerDevolucaoDetalhe(file: string): ShopeeReturnDetailEnvelope {
  return shopeeReturnDetailSchema.parse(lerFixture(file));
}

/**
 * One `get_return_list` page through the package schema — the WHOLE envelope.
 * Throws, same reason — and, like {@link lerBuscaDePacotes}, a row that went
 * `null` PARSES, so a test must look at the rows it got.
 */
export function lerListaDeDevolucoes(file: string): ShopeeReturnListEnvelope {
  return shopeeReturnListSchema.parse(lerFixture(file));
}
