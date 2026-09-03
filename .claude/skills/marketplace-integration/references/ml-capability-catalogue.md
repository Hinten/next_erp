# Mercado Livre — the reference implementation, capability by capability

The only implemented channel. Read it for **what problems exist**, not for what to
write — see the "EVIDENCE, not a template" section of `SKILL.md` before copying
anything.

Layout: `packages/integrations/mercado-livre/src/**` is fetch-only (OAuth, the
62-operation REST client `api.ts`, wire schemas `types.ts`, the error taxonomy, pure
mappers, AI prompt builders). `apps/mercado-livre/lib/marketplace/**` holds every
stateful flow in 15 themed folders, each with its own `README.md` and **no barrel
`index.ts`** — importers reach concrete files so the cross-theme edges stay visible.
`apps/mercado-livre/functions/src/**` holds 5 Cloud Tasks queues, 4 Firestore
triggers and 8 scheduled sweeps.

Fastest map of what the channel does: `notificacoes/notificacao.ts` — the topic
dispatcher names every inbound flow in one place.

---

## 1. OAuth connect + token refresh · `conta/`, `core/`

`core/mercadoLivre.ts` (`loadMercadoLivreContext`, `buildMercadoLivreContext`),
`core/tokenStore.ts`, `core/contaCache.ts`, `conta/oauthState.ts`.

Flow: `/oauth/start` verifies `PERM.integracao.write`, mints a signed HMAC state,
**persists the attempt before handing out the URL** (a consent completed against a
record that was never written must fail closed), then returns the consent URL. The
public `/oauth/…/callback` has no Bearer — the signed state is the only trust anchor:
verify HMAC → **redeem single-use inside a transaction** → exchange → persist →
denormalize the seller id onto the `integracao` doc.

**GENERIC**: authorize-URL → exchange → refresh → persist; optional PKCE; signed
single-use state; a per-account token store; a connect-completed trigger that
re-drives a deferred backlog; a read-cached account doc; a "connection status" route.

**ML-SPECIFIC**: the consent host differs from the API host; `tokenDuravel`'s legacy
wire shape (a new channel uses `integracao/{id}/credenciais`); **single-use rotating
refresh tokens**, which make the rotation itself the concurrency arbiter — hence the
deliberate *absence* of a transaction (OCC would re-fire a non-idempotent grant) and
the loser's double re-read; one registered app serving every account, so `client_id`
doubles as the `application_id` the webhook origin check compares.

## 2. Account context + read cache · `core/contaCache.ts`

Collapses three reads of the same `integracao` doc per notification behind a 15-min
TTL. ⚠️ **Never caches the token** — that turns a survivable race into `invalid_grant`.

## 3. Webhook receiver + topic dispatch · `notificacoes/`

Receiver validates, enqueues onto Cloud Tasks, acks 200 **with no Firestore write**.
If the enqueue fails it falls back to persisting a failure doc rather than 5xx-ing
(ML disables a topic after ~1h of non-200).

`TOPIC_DISPOSITION` maps each topic to one of four dispositions, and they differ in
**cost**: `handled`/`ack` persist nothing on success, `park` writes one doc per
delivery, `ignore` is refused at the receiver so it never becomes a task. A topic
**absent** from the table parks — deliberately, as the only signal a new topic
appeared. `ack` vs `ignore` matters: `ack` reports `done`, indistinguishable from
work performed.

Topics: `orders_v2`/`orders`, `items`, `payments`, `shipments`,
`post_purchase`/`claims`, `questions`, `messages` (handled); `items_prices`,
`orders_feedback`, `stock-location`/`stock-locations` (ack); `public_offers`,
`public_candidates`, `user-products-families` (ignore).

⚠️ Two lessons that generalize: **post-sale arrived under two topic names** and
claims reached nothing for months under one of them while the pedido looked healthy
(#1322) — a provider migrates per-account, so its published reference is not a
reliable guide to what your application receives today. And `docIdOf` must fall back
to a **derived** id when the provider gives none, or `create`'s ALREADY_EXISTS dedup
never fires (#807).

## 4. Delivery backstops · `notificacoes/missedFeedsSweep.ts`, `orderBackfill.ts`

`missed_feeds` (daily 05:00) asks ML what it failed to deliver and replays it. ⚠️
Keeps **no cursor** deliberately — the feed has no time filter and an entry is filed
~1h after ML gives up, so a `sent`-based cursor advanced at 05:00 would permanently
skip one sent at 04:55. Coverage rests on `period × 2 ≤ retention` instead, so
stretching the cron silently deletes the backstop.

`orderBackfill` (15-min) pages `/orders/search` from a durable cursor and enqueues a
**synthetic** notification per order, so the normal import path stays the only writer.

**GENERIC**: a provider-side missed-delivery feed if one exists; a forward backfill
with a durable cursor + overlap; synthesising an event rather than forking the import.

## 5. Orders → pedido · `pedidos/` (the largest theme)

`orderImport.ts` orchestrates; `orderPedidoTx.ts` discovers-or-creates the target
pedido covering every order of a **pack**; `orderMapping`/`orderStatusMaps`/`orderIds`
are pure. Cliente + endereço resolve through the shared `findOrCreateCliente`.

- **Completeness**: `assertOrderItemsComplete` throws `OrderItemsIncompleteError`
  naming every missing `(item.id, variation_id, seller_sku, element_id)` tuple. ML
  answers **206 Partial Content** for a still-materialising order, *omitting* fields.
- **Estado ladder, both directions.** Promotion up the pre-payment ladder stops at
  `emProcessamento` — beyond that `estado` belongs to the business. Release on death
  is the half that leaks stock if missed, and its terminal set is **enumerated**.
- `pedidoTravadoSweep` (weekly) is the only *time-based* release, and it is mostly a
  re-driver: it asks the provider and enqueues a synthetic event so the existing arms
  decide. ⚠️ It ENDS SALES, so it is doubly flag-gated with a dry-run mode and never
  acts on an unverifiable read.

**ML-SPECIFIC**: packs; `orders_v2` firing only for confirmed sales while
`/orders/search` filters `hidden_for_seller` (which is why a `payments` event has to
bootstrap the missing pedido); the `orderML` mirror (see `SKILL.md`).

## 6. Payments → pagamento · `pedidos/orderPaymentImport.ts`

`GET /collections/{id}` → skip if not a marketplace payment (zero Firestore ops) →
resolve the pedido via the mirror → staleness gate → upsert at a deterministic id →
advance to `pago` when fully paid → **release the reservation on a terminal status**
(the reliable arm: a never-seller-visible order fires no order event even to say it
was cancelled).

⚠️ Provider numbers arrive **quoted**; read them with `parseWireDecimal`
(`@delfrance/core/wire`). Mercado Pago hit the identical exposure on the same
resource, which is why the coercer is shared and not per-channel.

## 7. Shipments → `freteInicial` · `pedidos/orderShipment*.ts`

Map → resolve the pedido → **state-preserving** merge under a freshness policy
(`POLITICA_FRESCOR_*` — the policy is data, not code). `orderShipmentConference`
compares what will ship against what the pedido stores, **both ways**; a blocking
divergence **persists `estado: error` and then throws** (a throw alone rolls back the
transaction and strands the pedido with no operator-visible reason).

## 8. Product import · `importacao/`, and the mass-import job · `mass-import/`

Fetch → map → resolve-or-create → fill-null upsert, plus the category ancestor chain,
photo download into `Arquivo`s, and the variation taxonomy. Fresh produtos get a
**deterministic hashed id**, never the provider's seller SKU field.

The mass import is the *job* pattern worth reusing: one durable job doc as the single
checkpoint for a self-re-enqueuing Cloud Tasks chain, a keyset/scroll cursor, a
per-item checkpoint (a crash loses at most one), capped failure detail behind
uncapped counters, and cancellation racing finalisation (a class-B transaction).

## 9. Categories / attributes · `categorias/`

Pure projection of the provider's category attributes into the listing-editor shape,
behind process-scoped TTL caches. ⚠️ Category **suggestions are offered, never
auto-applied** — publish used to apply the top hit with no human in the loop (#799).

## 10. Publish / listing lifecycle · `anuncios/` (14 files)

Load graph → upload pictures (cached per integração on the `Arquivo`, so a re-publish
never re-uploads) → build payload → create/update → write back the link doc.
Validation problems throw **before any provider call**; a provider rejection is
parsed into the **form control that can fix it** (`core/publishFalhas.ts`).

⚠️ The family rules here are ML's User Products migration, not a general model — but
two properties do generalize: **a family's status is a FOLD of its members** (close
the family only when *every observed* member is closed, or a sweep silently drops a
produto whose siblings are still selling), and **an operator "re-verify" escape
hatch** must re-read member by member rather than asking about the family id.

## 11-12. Stock · `estoque/` — see the stock chapter in `SKILL.md`

## 13. Price · `preco/`

**Manual-only by owner decision** — prices change in deliberate batches and an
automated sweep could fight a seller's own promotions. Orchestration clones the
mass-import job, not the stock pipeline.

The reusable part is the **eight-gate ladder** in `precoDraftSend.ts`, shared verbatim
by the bulk job and the manual push: fresh read → skip-if-equal (which is also what
makes a replay idempotent) → status gate → decrease guard → build body → PUT →
**verify the echoed value** → write back.

⚠️ Gate 5 is a live-provider trap worth generalizing the *habit* from: a price-ONLY
body fails loudly on an item with price automation, but a price **bundled with any
other field returns 200 with the price silently ignored**. Gate 7 re-verifies anyway.

⚠️ **The backend owns the operator-facing wording** (`precoMotivos.ts`); a persisted
report row stores the *code* and renders the message at read time, so fixing a message
applies retroactively.

## 14. NF-e upload · `nfe/`

Firestore trigger on approval → cheap doc guards → one pedido read → enqueue → upload.

⚠️ **The zero-write model**: the happy path writes nothing, and idempotency is the
**live provider state** (the shipment leaves `invoice_pending` once an invoice
lands), not a local marker. The only write in the whole flow is a failure stamp under
a monotonic watermark.

## 15. Labels · `app/api/.../etiqueta`

A user is waiting for bytes, so every gap is a hard 409 rather than a queue retry.
⚠️ The provider returns **ZIP bytes** for both formats — `LabelResult.data: string`
in the deleted contract could not carry it. Content-Type is **byte-sniffed**; the
requested format only breaks the tie. A **2xx with an empty body is a failed label**,
thrown as a typed error rather than returned as a printable one.

## 16. Chat · `chat/`

Pre-sale questions and post-sale threads land in the unified inbox as
`chat/{conversaId}` + `mensagem`, with the two halves deliberately symmetric.

⚠️ **Outbound is HTTP, not a Firestore trigger, and that is a failure-mode decision**:
WhatsApp writes-then-transmits because its failures are transient; ML's refusals are
terminal and operator-actionable, so the send is synchronous and a refusal is a 409
the composer renders verbatim. ⚠️ **Send first, write second** — a message written
before the call leaves a phantom reply when the provider refuses.

⚠️ **Capability is re-derived live on every call.** The stored `respostaBloqueada` is
a UI hint, stale by construction; the send path re-reads and *that* read is the
authority (it is also where the live max-length comes from, so nothing hardcodes it).

## 17. Claims / returns / mediations · `claims/`

One claim → an Incidente on the pedido, plus a Conversa and its Mensagens.

⚠️ **The Incidente and the Conversa are gated differently, and the asymmetry is the
design**: the incidente is pedido business history and is written for every claim; the
conversa is a surface someone must answer in, so it is created and kept answerable
only while a reply action survives. It **closes, never deletes**.

⚠️ `claimResolve.ts` deliberately holds **no `db` handle**, and that absence *is* the
enforcement: the importer stays the single writer of incidente state, so the race is
made impossible (rule 7 tier 0) rather than guarded.

⚠️ **Partial refund is a percentage off an allow-list, never an amount** — and the
provider **defaults a missing percentage to 50%**, so an amount with no exact offer is
refused with the real ones listed rather than rounded. `refundAmount` is **reais**
(#815); the `/reclamacao/acao` wire still carries centavos and `claimResolve.ts` is
the one place that converts.

## 18. Tabela de medidas · `size-charts/`

Index-diffed CRUD against the provider catalog; every response is a full chart.
⚠️ Provider validation errors are **data, not failures** — collected per chart so one
bad chart never blocks the others. ⚠️ Deletion is **request-then-verify**: a 200 means
the request was accepted, not that anything was removed.

## 19. Kits virtuais — **ML has none**

See `SKILL.md`. `produto.ehKitVirtual` is channel-neutral and its docstring is the
authority; ML sends the component-min quantity on both publish and sweep.

## 20. `int_frete` sync · `frete/intFreteSync.ts`

Connecting an account materialises its marketplace-owned freight config; deleting it
deactivates, after a "is it really gone" re-check. ⚠️ An Eventarc redelivery replays
the **original** event, so the write is watermarked against the event time.
