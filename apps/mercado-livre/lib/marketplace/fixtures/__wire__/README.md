# `__wire__` — response bodies Mercado Livre actually sent

32 real ML responses, captured during the **#1087 live run** (2026-08-19 → 2026-09-01)
against a seller test user on `veste-france-debug`, then redacted and committed by
`pnpm --filter @delfrance/mercado-livre-app promote:fixtures`.

⚠️ **These are the only ML bodies in this repository that ML produced.** Every other
fixture in the offline suite is hand-written, so it agrees with our _belief_ about the
wire rather than with the wire itself. That gap is not hypothetical:
`pedidos/orderMLWire.ts:267` hardcodes `date_last_updated: null` for a field ML sends as
`date_last_modified`, and no hand-written fixture caught it — because each was written
from the same wrong belief.

## Rules

- **Read them; never rewrite them.** A test that edits a body to make an assertion pass
  has turned the suite's only evidence back into a hand-written fixture. If a body looks
  wrong, the finding is about our code or about ML.
- **Never hand-add a file here.** Capture with `capture:fixtures` (raw, into the
  gitignored `out/fixtures/`), then `promote:fixtures`. That is the only path that
  applies redaction, and `wireCorpus.test.ts` fails if a committed body is not a
  redaction fixpoint.
- **A non-200 filename is data.** `…​.404.json` and `…​.206.json` record real ML
  behaviour. ⚠️ A **206** omits fields rather than nulling them, so asserting full shape
  against one reproduces exactly the omitted-vs-null confusion this corpus prevents —
  use `listCompleteWireFixtures()`.

## Redaction

`promote:fixtures` scrubs personal data by **path suffix**
(`REDACTED_PATH_SUFFIXES` in `../redact.ts`): names, documents, contacts and
street-level location. It is type-preserving (a number redacts to a number) so the
structural digests stay accurate, and idempotent, which is what lets
`wireCorpus.test.ts` use "is this a redaction fixpoint?" as its strongest check.

⚠️ **Numeric ML account ids are deliberately KEPT** (`buyer.id`, `seller_id`,
`players[].user_id`) — they are pseudonymous handles, structurally load-bearing, and the
contract assertions key on them. `cust_id` is redacted. That asymmetry is a decision;
revisit it before the first capture against real production orders.

## Provenance

The capture manifest is **not** committed — it names the Firebase project and the
`integracao` document id, neither of which has test value.

| Family                        | Files | Notes                                                                                   |
| ----------------------------- | ----- | --------------------------------------------------------------------------------------- |
| `item-…` / `items-…`          | 5     | includes a User-Products family member (`variations: []`)                               |
| `orders-…`                    | 8     | with `billing_info` under `x-version: 2`                                                |
| `shipments-…`                 | 10    | `x-format-new: true`, plus `…/sla` which deliberately carries **no** such header (#957) |
| `packs-…`                     | 2     | one 404 — a pack id and an order id are indistinguishable from outside                  |
| `collections-…`               | 3     | payments                                                                                |
| `post-purchase-…`             | 2     | a claim and its (empty) message list                                                    |
| `order-single` / `order-pack` | 2     | `/orders/search` result shapes                                                          |
