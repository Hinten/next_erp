# fixtures — capturing what Mercado Livre actually sent

The endpoint table and the capture loop behind `pnpm capture:fixtures` (#1342).
The IO half — arguments, channel context, writing files — is
`scripts/capture-fixtures.ts`; this folder is the part that can be driven from a
stubbed `fetch`, which is the only way it can be verified at all: no CI lane may
ever hold a real ML credential.

- `fixtureCapture.ts` — `buildCapturePlan` (pure) and `captureOne`/`captureAll`.
- `redact.ts` — path-suffix redaction, type-preserving and idempotent.
- `piiScan.ts` — the independent two-layer check on the committed corpus.
- `wireCorpus.ts` — the READER for `__wire__/`.
- `__wire__/` — 30 **committed**, redacted bodies from the #1087 run.

## The two directories, and why the redaction sits between them

```
capture:fixtures  →  out/fixtures/   (gitignored, RAW, byte-faithful)
promote:fixtures  →  __wire__/       (committed, REDACTED)
```

⚠️ **The exposure is the commit, not the capture.** `out/fixtures/` is gitignored,
so raw bodies there are exactly as exposed as before any of this existed — and
they must stay raw, because a body that cannot distinguish "ML sent null" from
"ML omitted it" is worthless for diagnosing a live incident. `__wire__/` is
public, so `promote-fixtures.ts` is the single path that crosses that line and it
is where redaction and the PII scan both run. A scan finding is **fatal and
writes nothing** — a partial promote cannot be half-applied out of git history.

⚠️ Today's corpus is ML test-user placeholders (`APRO`, CPF `12345678909`). After
the migration the same capture points at REAL orders, which is the run this guard
exists for.

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

⚠️ **Only a `200` body takes the bare `<slug>.json` name.** The rule keys on the
status, never on `res.ok`, which is true across the whole 2xx range: ML answers
`206 Partial Content` for an order it can only partly materialise, and a partial
body **omits** fields rather than nulling them (`api.ts:226-230`) — omissions
indistinguishable from ML's real ones, which is the single distinction this module
exists to preserve. A 206 is filed as `<slug>.206.json`, a 204 as `<slug>.204.json`,
a 404 as `<slug>.404.json`.

⚠️ **A 404 is data; everything else is a failure.** A missing claim is expected on
the test account, so a 404 is recorded and the run continues — a partial capture
is useful. A transient 5xx (or a 401 on a dead grant, or a 429) **throws**:
recorded as an empty body it would later read as "ML returns this", which is
strictly worse than having no fixture.

⚠️ **This folder imports nothing from the other themes, and no channel RUNTIME
imports it.** It is a diagnostic plus a test corpus, never part of a request path
— keep it that way.

ⓘ That sentence used to end "…and nothing imports it", which stopped being true
when `__wire__/` landed: the offline suite now reads this corpus through
`wireCorpus.ts`, which is the entire point of committing it. The rule being
protected was never "nothing may import this" — it was "this must not become
channel runtime", and that still holds. A `lib/marketplace/*` module importing
from here would be the violation; a `*.test.ts` doing so is the design.
