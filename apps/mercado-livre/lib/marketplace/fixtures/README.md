# fixtures — capturing what Mercado Livre actually sent

The endpoint table and the capture loop behind `pnpm capture:fixtures` (#1342).
The IO half — arguments, channel context, writing files — is
`scripts/capture-fixtures.ts`; this folder is the part that can be driven from a
stubbed `fetch`, which is the only way it can be verified at all: no CI lane may
ever hold a real ML credential.

- `fixtureCapture.ts` — `buildCapturePlan` (pure) and `captureOne`/`captureAll`.

⚠️ **Nothing here may go through `createMercadoLivreApi`.** Every typed method
runs its response through `parseOk(res, schema)` — Zod, `api.ts:784` — so a field
declared `.nullable().default(null)` comes back materialised as an explicit `null`
whether or not ML sent the key. A fixture built that way cannot tell "ML sent
null" from "ML omitted it", which is the entire point of a wire fixture and
exactly the loss #1342 Finding 1 documents about the `orderML` mirror. The capture
is a plain `fetch` and `await res.text()`, written to disk verbatim.

⚠️ **The headers are the load-bearing half of the table.** `/shipments/{id}`,
`…/costs` and `…/payments` carry `x-format-new: true`; `…/orders` carries
`X-New-Domain: true`; `/orders/{id}/billing_info` carries `x-version: 2`; and
`…/sla` deliberately carries **none** (#957) — it is a distinct fixture, not a
duplicate of the shipment body. `fixtureCapture.test.ts` pins all four so the SLA
exception cannot be tidied into the shipment group.

⚠️ **A 404 is data; everything else is a failure.** A missing claim is expected on
the test account, so a 404 is recorded and the run continues — a partial capture
is useful. A transient 5xx (or a 401 on a dead grant, or a 429) **throws**:
recorded as an empty body it would later read as "ML returns this", which is
strictly worse than having no fixture.

⚠️ **This folder imports nothing from the other themes and nothing imports it.**
It is a diagnostic, not part of the channel runtime — keep it that way.
