---
name: marketplace-integration
description: >-
  How to build a NEW marketplace sales-channel integration in this monorepo
  (Shopee, Magalu, Amazon SP-API, Loja Integrada, Facebook/Instagram Shops), and
  how to change an existing one. Docs-first and master-plan driven: read the
  provider's own documentation, fill the channel's `MARKETPLACE_TIPO_CAPS` row,
  generate a master plan of the ~20 capabilities from that row, then plan each
  step at implementation time. Carries the Mercado Livre capability catalogue as
  the reference implementation, and an explicit list of ML decisions that are
  EVIDENCE, not a template — the pedido `orderML` mirror, User Products,
  `tokenDuravel`, the unsigned webhook, virtual kits. Use when implementing,
  debugging or reviewing a marketplace channel: canal de venda, marketplace,
  anúncio, listing, publicar, importar pedido, enviar estoque, enviar preço,
  etiqueta, grade/tabela de medidas, kit virtual, reclamação, novo canal. Triggers
  on work in `apps/<channel>` or `packages/integrations/<channel>`, and on terms
  like MARKETPLACE_TIPO_CAPS, marketplaceCapsFor, MarketplaceCapabilities,
  EstoqueProtocolo, INTEGRACAO_TIPO, integracoesComProduto, ChannelContext,
  defineNotificationPipeline, ADR 0015, and #815.
---

# Building a marketplace integration

**One App Hosting backend per channel.** `apps/<channel>` holds every stateful
flow; `packages/integrations/<channel>` holds the platform-neutral half (fetch-only:
OAuth, the REST client, wire schemas, pure mappers). Mercado Livre is the only
implemented channel and the reference for both halves.

⚠️ **There is no `MarketplaceChannel` interface, and you must not create one.** It
existed, one channel was built against it, and that channel implemented three of its
four required members as `throw` because they needed Firestore in a package that may
not import it. Read **ADR 0015** before proposing any shared channel abstraction.
What replaced it:

| Question | Answered by |
| --- | --- |
| *What does this channel support?* | `MARKETPLACE_TIPO_CAPS` (`@delfrance/schemas`) |
| *What shapes cross between channels?* | `@delfrance/core/marketplace` (incidents; the order model is research, unimplemented) |
| *How does it behave?* | `apps/<channel>` + the shared seams below |
| *How do I build it?* | this skill |

## The four phases

Do them in order. Phases 0 and 1 are cheap and they decide the rest.

### Phase 0 — read the provider's documentation. Before anything.

**Never infer a wire shape from Mercado Livre's.** Fetch the provider's own
reference and record which pages you read.

- Mercado Livre has a **docs MCP** — `search_documentation` / `get_documentation_page`
  are authoritative; do not guess and do not wait for a failing response to learn a
  contract.
- Every other provider: check whether they have a docs MCP too and ask the user to install it, or else, fetch the official reference (WebFetch). Prefer the MCP if available, if not, prefer the provider's page over a blog or an SDK's README.

**Output: a capability survey** answering every field of `MarketplaceCapabilities`
with a citation per answer, and an explicit *unknown* wherever the docs do not say.
The questions worth answering first, because they change the architecture rather
than the code:

1. **Does it sign its notifications?** ML does **not** (its receiver falls back to an
   `application_id` comparison that fails OPEN, because ML disables a topic after
   ~1h of non-200). Shopee, Mercado Pago and Meta all sign. **A signed channel must
   fail CLOSED** — secret unset ⇒ 503, never skipped.
2. **Push or poll?** A polling channel has no receiver and no Cloud Tasks queue; it
   has a cursor and a schedule. Amazon and Loja Integrada were poll-based in the
   legacy app.
3. **How does stock go out?** One call per listing, a batch, or an async feed? See
   *The stock chapter* — this is the single biggest cost decision.
4. **Is a listing one resource or a family?** Parent/child (Amazon ASINs, Shopee
   item/model, ML User Products) changes publish, status folding and stock.
5. **Is the buyer's fiscal identity inline or behind a second gated call?**

### Phase 1 — write the caps row first

`MARKETPLACE_TIPO_CAPS` is a `Record<MarketplaceTipo, …>`, so a tipo without a row
is a **compile error**. Fill the row from the Phase 0 survey.

⚠️ **Capability fields are three-valued: `'sim' | 'nao' | 'desconhecido'`.** Never
guess a `'sim'`/`'nao'` to make something compile — `'desconhecido'` exists so you do
not have to. A `false` where nobody checked is an unverified claim inside a type,
which is the exact failure #815 undid.

⚠️ **The row may not reach `implementado: true` while any `'desconhecido'` survives**
(`marketplace.test.ts` enforces this). Converting them is what Phase 0 is for.

The row is also what the master plan is generated **from**:

- `'nao'` on a capability ⇒ that step does not exist.
- `etiqueta: 'fetch'` vs `'emit'` ⇒ which label step you get, and whether the freight
  domain delegates to you.
- `kitVirtual: 'sim'` ⇒ a publish/stock step **Mercado Livre never wrote**.
- `estoque.protocolo` ⇒ the entire stock fan-out design.

### Phase 2 — the master plan

Filter the capability catalogue (`references/master-plan-template.md`) through the
caps row and produce an ordered plan: one issue per step plus a tracker, each naming
its trigger type (HTTP route / Cloud Task / Firestore trigger / `onSchedule`), the
Firestore collections it touches, and the shared seam it reuses.

- **Steps 1-4 are non-negotiable prerequisites** (OAuth, account context, the
  receiver or poller, the delivery backstop). Nothing else works without them.
- A step dropped because its capability is `'nao'` gets **a line saying so**. A
  silently absent step reads as forgotten.
- ⚠️ Ask before opening GitHub issues (root `CLAUDE.md`) — the tracker is curated.

### Phase 3 — plan each step at implementation time, not up front

Before each step: re-read that endpoint's documentation, decide the per-channel
nuances, write the step plan, then build. A master plan that pre-decides step 12 will
be wrong by the time you reach it — ML's stock design changed three times as its real
constraints surfaced.

## ⚠️ Mercado Livre decisions are EVIDENCE, not a template

Read the ML implementation for *what problems exist*, not for *what to write*. These
are the ones most likely to be copied wrongly, each with the reason it is ML-only:

- **`pedidos/{id}/orderML`** — a byte-faithful mirror of ML's order payload, keyed by
  order id with a collectionGroup index. It exists because the **migrated corpus** is
  stored in exactly that shape. The legacy Flutter app had **one mirror per channel**
  (`orderML`, `pedshopee`, `linkPgtoMercadoPago`), so a channel legacy never had has
  **no corpus to be compatible with**. Do not invent a mirror by analogy. Ask what
  the collection-group resolver is actually *for* — "which pedido owns this provider
  order/pack id?" — and whether a field on the pedido plus an index answers it.
- **User Products / `family_name` / the UPtin migration** — an ML platform migration
  in flight. Its whole apparatus (per-link `isUserProductModel`, the family status
  fold, `family_name` being create-only) describes ML's transition, not a general
  parent/child listing model.
- **`tokenDuravel` / `token6h`** — legacy Flutter subcollections, kept so the migrated
  credential resolves natively. **A new channel uses the generic
  `integracao/{id}/credenciais` store**, which exists for exactly this and whose
  docstring says so.
- **The single-use rotating refresh token** and its loser-fallback double re-read —
  ML's rotation *is* the concurrency arbiter, which is why the refresh deliberately
  runs outside a transaction. Most providers' refresh tokens are not single-use, and
  copying the fallback there is cargo cult.
- **`application_id`-only origin check, failing OPEN** — see Phase 0, question 1.
- **`missed_feeds`, `TOPIC_DISPOSITION`, the deferred lane, ML test users, the `-ITM`
  moderation reference, byte-exact legacy digest doc ids.**

⚠️ **A capability Mercado Livre LACKS is not a capability the domain lacks.** The
worked example is the virtual kit. `produto.ehKitVirtual`'s docstring states it
outright — ML's inability *"was a per-channel limitation, **not** a property of
virtual kits, and it must not be generalized into one"* — and #1087 is the oversell
that came from reading it the other way: the stock sweep refused to send a virtual
kit's quantity as though that were a rule, so the listing advertised its publish-time
number for ever. On a channel with `kitVirtual: 'sim'` you must implement the bundle
upload shape ML has no code for. Same shape for `tabelaDeMedidas`: `tabMedi` already
carries a `tabelasMedidasShopee` map with **migrated rows no ML code path knows
exists**.

## Shared seams — reuse, never re-roll

These were extracted *because a second consumer needed them*. Using them is not
optional; each replaces a defect someone already paid for.

| Seam | Import | Replaces |
| --- | --- | --- |
| Notification pipeline | `@delfrance/data/admin/notifications` | Per-channel retry/dedup/dead-letter. Legacy Shopee auto-ID'd its push docs and **double-processed every redelivery**. See the `webhook-notifications` skill |
| OAuth state | `@delfrance/data/admin/oauth-state` | HMAC state + single-use transactional redeem. A verified-but-replayable state let a second callback **overwrite the account's credential** (#821) |
| Read cache | `@delfrance/data/admin/cache` | Re-reading the same config doc per request. TTL is mandatory and IS the staleness bound. See `firestore-read-cache` |
| Cliente resolution | `@delfrance/data/admin/clientes` (`findOrCreateCliente`) | A 4-leg cascade that merged a new buyer into **a stranger's row** via a recycled phone, then rewrote their CPF (#786) |
| Media upload | `@delfrance/storage/admin` | Create-first `Arquivo` upload. See the `arquivos` skill |
| Wire reading | `@delfrance/core/wire` (`lerRespostaJson`) | `return parsed as T` — banned by `no-unvalidated-response`; six copies of it reported a credential wipe as success (#1295) |
| Money | `@delfrance/core/money` (`roundReais`) | Ad-hoc rounding; lint-enforced |
| Resilience fields | `notificationResilienceFields()` (`@delfrance/schemas`) | The 4 local fields every notification schema spreads |
| Region | `@delfrance/core/region` (`requireRegion`) | A hardcoded region. An enqueue against the wrong one is **dropped while the route returns 200** (#1108) |

`findOrCreateCliente` is also the model for *when* to extract: it was promoted out of
`apps/mercado-livre` only once a second caller existed and its defect was understood.
Extracting before that point is how the deleted contract was created.

## ⚠️ The stock chapter — this is the cost centre

The sweep runs **96×/day per conta** plus daily and monthly tiers, and Firestore
**Enterprise bills data scanned** (root `CLAUDE.md` rule 1) — an unindexed predicate
does not fail, it silently full-scans and lands on the invoice. Two independent axes,
and ML sits at one corner of each.

### Axis 1 — the read (generic; the expensive half)

Mandatory before shipping any sweep:

- **Declare the indexes.** Every `meta.defaultQuery`, every TableView update-monitor
  query and every sweep predicate. Enterprise auto-creates none.
- **Open with an anchor pre-filter.** `produtos.integracoesComProduto` is
  server-maintained by two Firestore triggers precisely so the sweep never scans
  produtos with no live listing. Reuse it — it is already channel-neutral.
- **Keep the plan core IO-free.** `bulkEstoquePlan.ts` is 2,300 lines with no
  Firestore call, which is what makes its cost testable at all.
- **Bound it by a change window**, from a lazily-computed, tick-shared ledger
  aggregate. An idle tick must cost ~nothing.
- **Carry a durable cursor plus a continuation** (frozen window + mode + keyset), so
  a truncated page makes forward progress instead of restarting.
- **Measure the scan, not the syntax.** #785 is the worked example: the "obvious"
  two-inequality query scans half the table where the single-inequality shape reads
  **one document**. A second inequality is a post-filter — Firestore's own docs say it
  "does not reduce the number of index entries scanned".
- **Write down what the tiers deliberately do NOT send, with the number.** ADR 0014
  records ~2000 writes per sale to propagate a component movement to every kit
  containing it — built, measured, rejected.

### Axis 2 — the write (per-channel; where ML is unrepresentative)

Pick the fan-out from `estoque.protocolo`:

| | `'por-anuncio'` (ML) | `'lote'` | `'feed-assincrono'` |
| --- | --- | --- | --- |
| Fan-out | one Cloud Task per listing | one task per `loteMax` SKUs | one task per submission |
| Outcome | synchronous, per listing | per-entry result array | **deferred** — poll a report |
| Failure attribution | the listing that 4xx'd | per entry, must be unpacked | per row in the report |
| Extra state | none | none | a submission record + a poll sweep |
| Tiering pressure | **high** — every write costs | lower | lowest |

⚠️ **An async feed is not a variant of the other two.** The notification pipeline's
contract is *"deterministic outcomes RETURN, transient failures THROW"*, and it has
no state for **"submitted, result unknown"**. That protocol needs a submission record
plus a poll sweep no channel here has written — say so loudly in the step plan.

⚠️ **ML's three-tier under-sending exists because per-write cost is high.** On a
channel with cheap bulk writes the tiering may be unnecessary complexity — but the
*read* cost is unchanged, so the tiers may still be justified by scan cost alone.
Decide it from measurement, per channel.

⚠️ **One function for publish and sweep.** ML's `quantidadeParaPublicar` is
`quantidadeParaEnvio` with an escape hatch pinned off, and it is one function because
when they were two agreeing only by comment, a virtual kit published a real number
and then never updated again — advertising it for ever, which oversells (#1087).

## Traps carried over, with their evidence

- **Every write can lose a race** (root `CLAUDE.md` rule 7). Pick the cheapest tier
  that holds: make it impossible (`FieldValue.increment`, a deterministic doc id from
  the event id) → native precondition → event-clock watermark → tell the human. Any
  `runTransaction` you add must be classified in
  `firestore-transaction-inventory.test.js` or CI reds.
- ⚠️ **Watermark UNITS are not interchangeable.** `ultimaModificacao` is µs on
  pedido/pagamento/produto but **ms** on the ML links; `historicoFtIni.data` is ms
  while `historicoEstadoPedido.data` is µs. A cross-unit comparison is a guard that
  never fires. **Always advance the watermark on the write that wins.**
- ⚠️ **The null-tolerance direction is a decision, and payments and shipments chose
  opposite ones in the same channel.** A missing stored watermark means "no evidence,
  proceed" for payments and "the stored value wins, do nothing" for shipments. Write
  down which you picked and why.
- **Enumerate terminal states; never derive them as "not on the ladder."** ML's
  status mapper returns a default for anything unrecognised, so the shortcut drops a
  live pedido's stock reservation the first time the provider invents a status.
- **Never trust one 4xx.** Providers return them for transient reasons. Rethrow until
  the last attempt, then make one verification read and record the real state.
- **Enqueue-first, never persist-first.** A notification that processes cleanly
  writes nothing.
- **No generic `catch`** — narrow on a specific class and `throw err` otherwise.
  `err instanceof Error` does not count.
- **Optional Firestore fields are `.nullable().default(null)`**, never bare
  `.optional()`.
- **A three-valued provider verdict** (`[]` = asked-none, a list = asked-found,
  `null` = never asked) beats two values whenever a read can fail: persisting `[]`
  after a failed read records "clean" and is indistinguishable from healthy.

## The `apps/web` half — register, do not copy

**The failure mode is not a missing UI. It is a new channel forking
`MercadoLivreTab` into `ShopeeTab`.** Three of the six web surfaces are already
channel-agnostic:

| Surface | What a new channel adds |
| --- | --- |
| Conta CRUD (`/canais/<channel>`) | A route + `fieldOverrides`. `TableView`/`ObjectView` already run off `integracaoSchema` with `queryParams: { tipo }` — one meta, N screens |
| Row / bulk actions (estoque, preço, etiqueta) | **One provider file + one `PROVIDERS` row** in `apps/web/lib/marketplace/{estoque,preco}/registry.ts` and `lib/checkout/etiqueta/registry.ts` |
| Chat inbox | An `OrigemConversa` value + an `ORIGEM_RULES` row (`conversaOrigem.ts`) |
| Conta panel + job cards | Per-channel, but model on `useContaJobFan` / `startJobsForContas` |
| Produto listing tab | Per-channel today (18 ML components). Generalize only with a second channel in hand |
| AI autocomplete | Per-channel schema (built from the provider's attribute metadata); the **suggest-don't-apply** contract is generic |

- Model new provider contracts on `lib/checkout/etiqueta/types.ts` — the most mature
  in the repo: UI capabilities (`confirmRisk`, `notify`, `openUrl`) and clients are
  **injected**, so a provider stays pure and testable with fakes.
- **Gate a row action off the caps row** (`estoque.suporte`, `enviarPreco`,
  `etiqueta`), never off "does a provider file exist".
- ⚠️ **`apps/web` calls the DEPLOYED channel backend even in local dev**, and its
  `call<T>()` casts rather than validates. A UI that looks right against an older
  backend is a known, shipped failure (#1087's capability probe).

## Definition of done, per step

- Tests, including a **near-miss** wherever something decides that two values are
  "the same" — a pair that must be equal *and* a pair that must stay distinct.
- Composite indexes declared in `firestore.indexes.json`.
- Both rulesets regenerated (`gen:rules` **and** `gen:rules:e2e`) plus the two
  snapshots refreshed, if any `*Meta`, PERM or validator whitelist changed.
- New env vars in the root `.env.example` and the app's `apphosting.yaml`.
- The CI lane wired (`ci-lanes` skill) — a lane that skips runs the tests **nowhere**.
- ⚠️ Anything that must be *run* against production data or infrastructure is not
  yours to do and is not a TODO: surface it and stop (root `CLAUDE.md` rule 8).

## References

- `references/ml-capability-catalogue.md` — the reference implementation, capability
  by capability, with what is generic vs ML-specific.
- `references/master-plan-template.md` — the ordered steps and the issue shape.
- ADR 0015 (why there is no contract), ADR 0014 (kit stock + sweep tiers), ADR 0011
  (write-path concurrency), ADR 0012 (read cache), ADR 0013 (the migration window).
- Skills: `webhook-notifications`, `firestore-read-cache`, `firestore-pipelines`,
  `arquivos`, `schema-driven-crud`, `freight-integrations`, `ci-lanes`.
