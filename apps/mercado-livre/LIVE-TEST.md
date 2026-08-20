# Mercado Livre — live end-to-end test run

The protocol for **#1087**: the first run of this integration against the real Mercado
Livre API, using two ML **test users** (seller + buyer).

Fill the **Result** column of every table as you go. A run whose evidence is not written
down has to be repeated, and repeating it costs test-user slots that are capped forever.

> **Read `apps/mercado-livre/CLAUDE.md` first.** It is the authoritative description of
> the channel; this file only says what to _do_ and what to _assert_.

---

## 0. The constraint that shapes everything

**Mercado Livre has no sandbox.** From ML's own
[Realização de testes](https://developers.mercadolivre.com.br/pt_br/realizacao-de-testes)
page: «O Mercado Livre não tem um ambiente para teste ou sandbox.»

Therefore:

| Fact                                                                 | Consequence for this run                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------- |
| A test user is a **real production account**                         | A test listing is a real listing on the real marketplace      |
| **10 test users per real account, forever**                          | A wasted mint is permanently gone                             |
| **No endpoint lists them**, and the password is shown **once**       | A mint whose result is not persisted spent a slot for nothing |
| Deleted after **60 days idle**                                       | Do the run in one stretch, not spread over months             |
| Test users transact **only** with other test users' listings         | The buyer must be a test user too                             |
| E-mail verification code = **the last 4 or 6 digits of the user id** | There is no inbox                                             |

Listing rules ML imposes, all already encoded in
[`lib/marketplace/anuncioTeste.ts`](lib/marketplace/anuncioTeste.ts):

- title exactly `Item de Teste – Por favor, NÃO OFERTAR!`
- category `Outros` «na medida do possível» (on MLB it is a **leaf** under
  `Mais Categorias`, not a root)
- never `gold` / `gold_premium` / `gold_pro`

⚠️ `isContaDeTeste` **warns, it never blocks.** A mis-selected conta publishes for real.

---

## 1. Prerequisites

Tick every box before step 2.1. Most failures in this run trace back to a missed line here.

### 1.1 Application and endpoints

- [ ] A **staging** ML application, never production. The production application's
      callback is still shared with the live Flutter connect screen.
- [ ] ⚠️ **Cutover hazard.** A seller's callback URL is ONE registration. Pointing
      it at this backend without disabling the legacy Flutter notification
      functions gets the same notification ingested by **both** systems.
- [ ] Redirect URI → `<staging backend>/api/oauth/mercado-livre/callback`
- [ ] Notification callback → `<staging backend>/api/webhooks/mercado-livre`
- [ ] Every topic in `KNOWN_TOPICS` subscribed (`lib/marketplace/notificacao.ts`):
      `orders_v2`, `orders`, `items`, `shipments`, `payments`, `items_prices`, `claims`,
      `orders_feedback`, `questions`, `messages`, `stock-location`

### 1.2 Environment

| Var                                               | Requirement                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `MERCADO_LIVRE_PUBLIC_URL`                        | **Exactly** the registered redirect URI's origin                                                       |
| `MERCADO_LIVRE_CLIENT_ID` / `_CLIENT_SECRET`      | The staging application's pair                                                                         |
| `MERCADO_LIVRE_STATE_SECRET`                      | Set — unset ⇒ 500 / `reason=config`                                                                    |
| `MERCADO_LIVRE_PKCE_ENABLED`                      | Must **match the DevCenter toggle**; once ML's toggle is on the parameters are mandatory               |
| `ALLOWED_ADMIN_ORIGINS`                           | Required in production (#821/T5) — unset leaves the allow-list empty and every browser call CORS-fails |
| `NEXT_PUBLIC_MERCADO_LIVRE_URL`                   | Points apps/web at this backend. ⚠️ apps/web calls the **deployed** backend even in local dev          |
| `MERCADO_LIVRE_TEST_USERS_ENABLED`                | `1`, or `/usuarios-teste` 404s **before auth**                                                         |
| `MERCADO_LIVRE_TASKS_REGION` / `FUNCTIONS_REGION` | Must match, or tasks are silently dropped                                                              |

Sweep flags default **OFF**. Turn on only what a phase needs:
`MERCADO_LIVRE_STOCK_SYNC_ENABLED`, `MERCADO_LIVRE_STOCK_RECONCILIACAO_ENABLED`,
`MERCADO_LIVRE_ORDER_BACKFILL_ENABLED`, `MERCADO_LIVRE_MISSED_FEEDS_ENABLED`.

⚠️ `MERCADO_LIVRE_STOCK_SYNC_ENABLED` gates the sweeps **and** the send task. With it off,
the live-test path for stock is the synchronous `/enviar-estoque` route.

### 1.3 IAM

- [ ] App Hosting runtime SA has `roles/cloudtasks.enqueuer` **and**
      `roles/iam.serviceAccountUser` (`functions/DEPLOY.md`). Without them every enqueue
      fails and the whole channel silently degrades to sweep-only mode.
- [ ] `gcloud tasks queues describe processMercadoLivreNotification --location=<region>`
      returns a queue.

### 1.4 Seller integração

- [ ] `depositoOuterRef` set — otherwise every stock path refuses `ML_CONTA_SEM_DEPOSITO`
- [ ] `tabelaNormalOuterRef` set — otherwise price paths refuse `ML_CONTA_SEM_TABELA_NORMAL`
- [ ] `operacaoOuterRef`, `listaDePrecosOuterRef`, `modalidadeFreteImportacao` reviewed

### 1.5 Mint the test users

Use the **Criar usuários de teste** button on `/canais/mercado-livre/[id]`
(`UsuariosTesteDevPanel`).

⚠️ `POST /usuarios-teste` **deletes every `tokenDuravel` doc on the conta it used** — that
account ends the call disconnected, by design. Use a **throwaway** conta, never a live
seller.

| Check                                                                 | Result |
| --------------------------------------------------------------------- | ------ |
| Two records under `integracao/{id}/usuariosTeste` (doc id = the role) |        |
| `tokenDuravel` on the bootstrap conta is empty                        |        |
| Both users can sign in on mercadolivre.com.br                         |        |
| E-mail verification accepted with the last 4/6 digits of the user id  |        |

---

## 2. Phase 0 — offline, before spending anything

Run the round-trip contract test. It costs nothing and finds structural losses without a
single ML call.

```bash
pnpm --filter @delfrance/integrations-mercado-livre test
```

| Check                                                       | Result |
| ----------------------------------------------------------- | ------ |
| `roundTrip.test.ts` green                                   |        |
| Every allow-list entry still justified (no new silent loss) |        |

---

## 3. Phase 2 — connection

| #   | Step                                      | Assert                                                                                                                                                 | Result |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 2.1 | OAuth connect as the **seller** test user | token in `tokenDuravel`; `user_id` on the integração; conta panel green                                                                                |        |
| 2.2 | Replay the same `state`                   | rejected, `reason=bad_state` (#821/T3)                                                                                                                 |        |
| 2.3 | `GET /users/me` — check `tags`            | ⚠️ if it carries `warehouse_management`, the conta is **multiorigin**: `/enviar-estoque` will 409 `ML_CONTA_MULTIORIGEM` and Phase 5 is blocked (#706) |        |
| 2.4 | `nickname`                                | `isContaDeTeste` should recognise it — ML mints `TETE…`, not only `TEST…`                                                                              |        |

---

## 4. Phase 3 — catalogue: publish, attributes, size chart

**Two listings**, because size charts and variation grids exist only in **fashion**
domains, so ML's "publish in Outros" guidance cannot cover them:

- **L1 — generic**, in `Outros`: publish, edit, stock, price, order, claim, cancel.
- **L2 — fashion**: size chart + variation grid only.

The **Preencher dados de teste** button in the produto's Mercado Livre tab fills the
mandated title, description and category.

| #   | Step                                   | Surface                     | Assert                                                                                                                            | Result |
| --- | -------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 3.1 | Create the size chart                  | `size-charts/sync`          | chart id returned; visible on ML                                                                                                  |        |
| 3.2 | Publish a simple produto → **L1**      | Produto → ML tab → Publicar | `POST /items`; link doc written; listing live                                                                                     |        |
| 3.3 | Edit and republish                     | ML tab → Salvar             | `PUT /items/{id}`; description replaced                                                                                           |        |
| 3.4 | Publish **L2** with variations + chart | ML tab                      | `attribute_combinations` correct; chart associated; `SIZE_GRID_ROW_ID` per child                                                  |        |
| 3.5 | Reverificar anúncio                    | ML tab                      | real `status`/`sub_status` written; `errors` cleared                                                                              |        |
| 3.6 | A **kit** produto                      | ML tab                      | publishes with the component-min quantity (`quantidadeParaPublicar` deliberately diverges from the sweep's `quantidadeParaEnvio`) |        |

Two known gaps — confirm the blast radius rather than discover it later:

| Gap                                                                                                          | What to record                                   | Result |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | ------ |
| **No `shipping` object is ever sent** — `free_shipping`/logistic mode is read back from ML but never written | does the listing get the intended shipping mode? |        |
| **No `sale_terms` at all** — warranty (`WARRANTY_TYPE`/`WARRANTY_TIME`) is never sent                        | which categories 400 because of it?              |        |

⚠️ A failed publish latches the link to `estado: 'E'`, which **freezes the stock sender**
until an `items` webhook or a manual **Reverificar anúncio**.

---

## 5. Phase 4 — the round-trip (the core question)

> Do the attributes and their values match what we sent, and does importing the listing
> back give the same produto?

There is today **no code that compares what we published against what ML returns** — that
is what `scripts/inspect-anuncio.ts` is for.

```bash
pnpm --filter @delfrance/mercado-livre-app inspect:anuncio --project <project-id> --integracaoId <id> --itemId MLB000000000
```

For **each** of L1 and L2:

| #   | Step                                                                                  | Assert                                                                                                    | Result |
| --- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------ |
| 4.1 | `GET /items/{id}` + description vs the ERP produto and its `produtoMercadoLivre` link | every attribute id present with the value we sent                                                         |        |
| 4.2 | Import the same listing into a **scratch produto** (`/importar`)                      | the scratch produto equals the original                                                                   |        |
| 4.3 | Create a listing **directly on ML** as the seller, then import it                     | produto created with photos, attributes, variations. Without this, import only re-reads what we published |        |
| 4.4 | Mass import ("Importar todos os anúncios")                                            | scan pagination works; job doc completes; **no duplicates**                                               |        |

Classify **every** divergence into exactly one bucket:

- **Expected** — on the Phase 0 allow-list (variation `ordem`, root `price` on update,
  root price/quantity when variations exist, parent `SELLER_SKU` with variations,
  `descricao`, derived attribute ids).
- **ML normalisation** — ML filled `value_id`, rewrote `value_name`/`unit_id`, returned a
  `value_struct`, or rehosted a picture. **Write down the exact transform** — this is the
  part no offline test can predict.
- **Bug** — anything else. One issue each, linked from #1087.

Pay particular attention to units: publish sends dimensions as `"55 cm"` and package weight
in **grams**, and import parses the unit back out (a legacy 10× bug already lives in that
history). If ML rewrites the unit, the parse must still be correct.

| Divergence | Field | Bucket | Note | Result |
| ---------- | ----- | ------ | ---- | ------ |
|            |       |        |      |        |

---

## 6. Phase 5 — stock and price

| #   | Step                      | Surface                                | Assert                                                                | Result |
| --- | ------------------------- | -------------------------------------- | --------------------------------------------------------------------- | ------ |
| 5.1 | Push stock, one produto   | `enviar-estoque`                       | `available_quantity` on ML matches                                    |        |
| 5.2 | Push stock, bulk          | produtos table → `EnviarEstoqueDialog` | per-listing outcomes returned as data                                 |        |
| 5.3 | Push prices, selected     | `enviar-precos`                        | ML price matches                                                      |        |
| 5.4 | Push prices, account-wide | `atualizar-precos`                     | job doc completes; check for the three classes #1072 says are dropped |        |

### 5.5 — Settle #831 (a potential silent data-loss bug)

On **L2** (2+ variations), send a `variations` array containing **only one** of them with
an `available_quantity`, then `GET` the item back.

| Question                           | Result |
| ---------------------------------- | ------ |
| Did the omitted variation survive? |        |

If ML **deletes** it, every routine stock sync can silently destroy variations on a live
listing, because `buildSendTasks` deliberately excludes unmatched / id-less / kit-virtual
children. That would outrank #781 and must be fixed before any stock sweep is enabled in
production.

---

## 7. Phase 6 — order lifecycle

Buy as the **buyer** test user with a
[Mercado Pago test card](https://www.mercadopago.com.br/developers/pt/docs/salesforce-commerce-cloud/additional-content/your-integrations/test/cards);
the cardholder name drives the outcome — `APRO APRO` ⇒ approved.

```bash
pnpm --filter @delfrance/mercado-livre-app inspect:pedido --project <project-id> --pedidoId <pedido-id>
```

| #    | Step                                     | Assert                                                                   | Result |
| ---- | ---------------------------------------- | ------------------------------------------------------------------------ | ------ |
| 6.1  | Buy L1                                   | `orders_v2` → pedido; cliente matched; `payments` → pagamento            |        |
| 6.2  | Buy **two** items in one cart            | pack path (`GET /packs/{id}`): **one** pedido, two lines                 |        |
| 6.3  | Buy with an ML **coupon**                | see the money map below                                                  |        |
| 6.4  | Buy with a seller **promotion/discount** | see the money map below                                                  |        |
| 6.5  | Shipment progresses                      | `shipments` → `freteInicial`, prazo de despacho                          |        |
| 6.6  | Etiqueta                                 | **PDF and ZPL**; ZPL DANFE stripped                                      |        |
| 6.7  | NF-e XML upload                          | `POST /shipments/{id}/invoice_data` accepted; unblocks `invoice_pending` |        |
| 6.8  | Buyer opens a claim                      | `claims` → incidente + conversa + mensagens visible in `/chat`           |        |
| 6.9  | Cancel — **buyer** side                  | `cancel_purchase`; pedido → cancelado                                    |        |
| 6.10 | Cancel — **seller** side (2nd order)     | `cancel_sale`; distinct resolution                                       |        |
| 6.11 | Buyer leaves feedback                    | `orders_feedback` acks, persists nothing                                 |        |
| 6.12 | Pause / reactivate / close L1            | `items` → status sync onto the link                                      |        |

⚠️ **Ordering is not arbitrary:** messaging is blocked on cancelled orders _and_ during an
open mediation, and a size chart in use cannot be deleted. So message → claim → cancel, and
delete charts last.

### 7.1 The money map — assert every row

The mapping lives in [`orderMapping.ts`](lib/marketplace/orderMapping.ts) and
[`orderPaymentMapping.ts`](lib/marketplace/orderPaymentMapping.ts). Both were ported
verbatim from the Flutter app and **have never been checked against a real order**.

| Field                      | Formula in code                                                                 | What to verify                                                                                                                                                                                     | Result |
| -------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `quantidade`               | `order_item.quantity`                                                           | trivial                                                                                                                                                                                            |        |
| `precoDeVenda`             | `unit_price + Σ discounts[].amounts.full` — a **plus**                          | reconstructs the _gross_ unit price. Confirm ML returns `amounts.full` **positive**; a negative flips the sign                                                                                     |        |
| `descontoUnitario`         | `Σ discounts[].amounts.full`                                                    | line-level discount                                                                                                                                                                                |        |
| `descontoTotal`            | `Σ payments[].coupon_amount`                                                    | order-level **coupon** — a different source from the line discount. Confirm one discount is not counted in both                                                                                    |        |
| **`valorCobrado`**         | `Σ transaction_amount + Σ shipping_cost − Σ coupon_amount`                      | **the highest-value assertion in this run.** If ML's `transaction_amount` already includes shipping and is already net of coupon, this double-counts. Compare against what the buyer actually paid |        |
| `valorFreteInicial`        | `Σ payments[].shipping_cost`                                                    | vs the checkout freight                                                                                                                                                                            |        |
| `tarifas` (ML fee)         | `max(0, marketplace_fee + Σ fee_details[].amount + Σ collector→mp charges)`     | vs ML's own sale-fee report                                                                                                                                                                        |        |
| `numero`                   | `packId ?? order.id`                                                            | a pack collapses siblings onto one pedido                                                                                                                                                          |        |
| `sku` / `mktplaceId`       | `item.seller_sku` / `variation_id ?? item.id`                                   | binds the line to the ERP produto                                                                                                                                                                  |        |
| `gtin`, `custo`, `imposto` | always `null`                                                                   | legacy parity — confirm that is still wanted                                                                                                                                                       |        |
| cliente                    | `GET /orders/{id}/billing_info`                                                 | ⚠️ a non-CPF/CNPJ `identification.type` **throws and is swallowed**, so the pedido never reaches `pago`. Test users are the likeliest place to hit this                                            |        |
| endereço                   | billing first, `shipment.receiver_address` fallback                             | ⚠️ if ViaCEP recovery fails the code stores UF **`AC`** with only a warn; `sem-cep` ⇒ no endereço ⇒ never `pago`                                                                                   |        |
| `estado`                   | `estadoPedidoFromOrderStatus`                                                   | default is `iniciado` (tolerant)                                                                                                                                                                   |        |
| payment status             | `statusPagamentoFromMlPaymentStatus`                                            | ⚠️ **throws** on an unknown ML status — a new status poisons the import into a retry loop                                                                                                          |        |
| `pago` advance             | needs `emProcessamento` **and** cliente **and** endereço **and** `freteInicial` | if the pedido stalls, this is why                                                                                                                                                                  |        |

⚠️ `payments[]` and `discounts[]` are read through `as unknown as` passthrough casts — Zod
never validates them, so a shape change is **silent**. Capture the real bodies (§9).

### 7.2 — Settle #758 (the PDF label branch)

| Question                                                                 | Result |
| ------------------------------------------------------------------------ | ------ |
| Does ML return a raw PDF? (the route byte-sniffs `%PDF` vs `PK`)         |        |
| Which one actually arrived, per the response headers / logs?             |        |
| Does ML embed the simplified DANFE in **PDF** labels, as it does in ZPL? |        |

---

## 8. Phase 7 — resilience signals

There is **no UI over `notificacoesMercadoLivre`**. Read it with:

```bash
pnpm --filter @delfrance/mercado-livre-app dump:notificacoes --project <project-id> --status failed
```

| Signal                                       | Assert                                                                                                                                                        | Result |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Every subscribed topic arrives               | acks 200, dispatches to the right handler                                                                                                                     |        |
| `items_prices`                               | **parks nothing** — #803, a permanent ack-only no-op                                                                                                          |        |
| A notification for an **unconnected** seller | lands in the **deferred** lane; `redriveDeferredForUserId` pulls it back on connect (#808)                                                                    |        |
| A **replayed** notification                  | dedups via `docIdOf` / ALREADY_EXISTS (#807)                                                                                                                  |        |
| `missed_feeds` backstop (#812)               | make the backend return non-200 for a few minutes; the 05:00 sweep replays. ⚠️ `MERCADO_LIVRE_TASKS_DISABLED=1` is **not** a usable lever — it still acks 200 |        |
| `questions` / `messages`                     | **deferred to a later run** — they `park` until #532/#533 ship                                                                                                |        |

---

## 9. Phase 8 — capture fixtures, clean up, decide on CI

**The most durable output of this run is real ML response bodies.** Every offline test in
this repo currently runs on hand-written fixtures.

| Capture                                                                         | Where it helps                                                                              | Result |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ |
| Item — simple and with variations                                               | the round-trip test                                                                         |        |
| Order (+ the `pedidos/{id}/orderML/{orderId}` mirror the import already stores) | the money map                                                                               |        |
| Payment                                                                         | `orderPaymentMapping`                                                                       |        |
| **Shipment with `x-format-new: true`**                                          | **#957** — its own text says this single call is worth more than the whole written analysis |        |
| Claim                                                                           | `claimImport`                                                                               |        |

### Cleanup

- [ ] Delete both test listings
- [ ] Delete the size charts (**only after** the listings are closed — a chart in use
      cannot be deleted)

### The CI question (#1087 §7)

Answer it with what the run showed, not with speculation. The known blockers:

- ML has **no sandbox** — a lane writes to production.
- The `refresh_token` is **single-use and rotating**: a CI run invalidates the token the
  deployed backend is holding. Any lane needs its **own** test-user integração.
- A runner has **no public callback URL**, so signals must be polled or read from
  `missed_feeds`.
- **10 test users per account**, unrecoverable credentials, 60-day idle deletion.
- The rotating credential would have to be written back into GitHub secrets every run.

If it goes ahead, the shape already exists: a `workflow_dispatch`-only lane behind an
enable flag, mirroring `nfe-live` — never on `pull_request`, and per root `CLAUDE.md`
rule 5 its scope guard must degrade to **`run=false`**, never `true`.

---

## 10. Findings

One row per bug. Open an issue for each and link it from #1087. **Do not fix anything
inside this run** — the run's job is evidence.

| #   | Phase | What happened | Expected | Issue |
| --- | ----- | ------------- | -------- | ----- |
|     |       |               |          |       |

## 11. Issues this run settles

| Issue                           | Outcome                         | Result |
| ------------------------------- | ------------------------------- | ------ |
| #1087                           | closed by completing the run    |        |
| #831 — partial `variations` PUT | closable — §5.5                 |        |
| #758 — PDF label branch         | closable — §7.2                 |        |
| #957 — shipments `x-format-new` | evidence captured — §9          |        |
| #706 — multiorigin contas       | determined at §2.3              |        |
| #898, #1083, #1072, #707        | observed only — record evidence |        |

---

## 12. Appendix — deployment blockers hit on the first production deploy

Recorded 2026-08-19, on `veste-france-debug`. Every one of these was hit for real, in this
order, before a single ML API call was made. **Work through them before starting §1** —
and re-check them after the Firebase project migration (ADR 0013), because three of the
four are project-level configuration that does not travel with the code.

### 12.1 — 11 of 15 functions fail to deploy

```
Functions deploy had errors with the following functions:
        mercado-livre:importMercadoLivreOrders(us-east5)
        … 10 more
```

**Cause: Cloud Tasks and Cloud Scheduler do not exist in `us-east5`.** The failing set is
exactly the 5 `onTaskDispatched` + 6 `onSchedule` functions; the 4 `onDocumentWritten`
Firestore triggers deploy cleanly, and that asymmetry **is** the diagnosis.

**Fix:** the two-region split — queues and schedules in `us-east1`, Firestore triggers in
the data region. See `functions/DEPLOY.md`.

### 12.2 — the container will not start, and the browser calls it a CORS error

Symptom: `apps/web` on localhost reports a CORS failure against the deployed backend.

**Do not start debugging CORS.** Check `/api/health` first:

```bash
curl -s -o /dev/null -w "%{http_code}
" "https://<backend>.hosted.app/api/health"
```

That route imports nothing but `NextResponse` and returns a static object — it cannot fail
on its own. A `500` there means the **container is not serving at all**, and the body will
be Google's `envoy` error page rather than a Next.js one. A 500 carries no
`Access-Control-Allow-Origin` header, and a missing ACAO is what the browser reports as
CORS. The real error is upstream of CORS every time.

**Cause:** App Hosting could not resolve the Secret Manager references in
`apphosting.yaml`:

```
Error resolving secret version with name=projects/<project>/secrets/MERCADO_LIVRE_CLIENT_ID/versions/latest
```

The secrets existed and were `ENABLED` — **existence is not access.** The backend's service
account had no `secretmanager.secretAccessor`.

**Fix:**

```bash
firebase apphosting:secrets:grantaccess MERCADO_LIVRE_CLIENT_ID,MERCADO_LIVRE_CLIENT_SECRET,MERCADO_LIVRE_STATE_SECRET --backend mercado-livre --project <project-id>
```

Then roll out again — a failed rollout does not retry itself. ⚠️ Re-run `grantaccess` for
every secret added later, and once per backend: the grant is per-secret, per-service-account.

### 12.3 — CORS, for real this time

Once the container is healthy, the preflight still fails.

**Cause:** `ALLOWED_ADMIN_ORIGINS` is **not** in `apphosting.yaml`'s `env:` block — only the
three secrets are — so it is unset on the deployed backend. On a deployed backend
`NODE_ENV === 'production'`, and `proxy.ts` then makes the allow-list **exactly**
`ALLOWED_ADMIN_ORIGINS`; localhost is not implicitly allowed (#821/T5). Unset allows _no_
origin at all.

**Fix:** set it in Firebase console → App Hosting → Environment variables, then roll out
(env changes need a rollout):

```
ALLOWED_ADMIN_ORIGINS=http://localhost:3000
```

⚠️ That exclusion is deliberate — "a page served from a developer machine has no business
making credentialed cross-origin calls to a production backend". Allowing localhost is
acceptable on a debug project; **do not carry the value to real production.**

Verify with the preflight:

```bash
curl -s -i -X OPTIONS "https://<backend>.hosted.app/api/marketplace/mercado-livre/conta" -H "Origin: http://localhost:3000" -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: authorization"
```

`204` + `access-control-allow-origin` = good. `204` with no ACAO = the variable is still
missing. `500` = back to §12.2.

### 12.4 — `cloudtasks.tasks.create` denied

```
The principal lacks IAM permission "cloudtasks.tasks.create" for the resource
"projects/<project>/locations/us-east5/queues/processMercadoLivreMassImport"
(or the resource may not exist).
```

**Read the region in that path.** It is the _second_ half of the message that matters —
Cloud Tasks does not exist in `us-east5`, so the queue **cannot** exist. Granting IAM fixes
nothing. Each queue is auto-provisioned by its function's deploy, and those deploys failed
in §12.1.

**Fix, in order:** deploy the functions to a region that has Cloud Tasks → redeploy the App
Hosting backend (the enqueuer `mlTasks.ts` lives there) or set `MERCADO_LIVRE_TASKS_REGION`
to match → **then** grant the one-time IAM from `functions/DEPLOY.md`:

```bash
gcloud projects add-iam-policy-binding <project-id> --member="serviceAccount:<apphosting-runtime-sa>" --role="roles/cloudtasks.enqueuer"
```

```bash
gcloud iam service-accounts add-iam-policy-binding <functions-runtime-sa> --member="serviceAccount:<apphosting-runtime-sa>" --role="roles/iam.serviceAccountUser"
```

Verify: `gcloud tasks queues list --location=<region> --project=<project-id>` should list
`processMercadoLivreMassImport`, `processMercadoLivreNotification`, `sendMercadoLivreStock`,
`processMercadoLivrePriceSync` and `processMercadoLivreNfeUpload`.

⚠️ Notifications fail **soft** here — a failed enqueue is persisted as `failed`, the sweep
drains it, and the receiver still acks 200. So a missing grant is invisible on the webhook
path and surfaces first on a button with no fallback, like "Importar todos os anúncios".

### 12.5 — ⚠️ For the migration: only two Americas regions have every service

This is the finding that outlives the run. **The region is effectively permanent**, and the
platform's own availability tables rule out most candidates:

| Service                                                                       | Americas availability                                                                                                 | `us-east5`?   | `us-east1`?   |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------- | ------------- |
| [App Hosting](https://firebase.google.com/docs/app-hosting/about-app-hosting) | **only 6 regions worldwide** — `us-central1`, `us-east4`, `us-east5`, `asia-east1`, `asia-southeast1`, `europe-west4` | ✅            | ❌ **absent** |
| [Cloud Tasks](https://cloud.google.com/tasks/docs/locations)                  | `us-central1`, `us-east1`, `us-east4`, `us-west1…4`, `northamerica-northeast1`, `southamerica-east1`                  | ❌ **absent** | ✅            |
| [Cloud Scheduler](https://cloud.google.com/scheduler/docs/locations)          | same, plus `us-south1`                                                                                                | ❌ **absent** | ✅            |

**The intersection in the Americas is exactly two regions: `us-central1` and `us-east4`.**

- `us-east5` — no Tasks, no Scheduler. The trap this appendix documents.
- `us-east1` — no App Hosting, and 7 apps deploy there.
- `southamerica-east1` — no App Hosting, despite being latency-optimal for Brazil.

⚠️ Storage triggers add one more hard constraint: a gen2 storage trigger runs through
Eventarc and **must** sit in the bucket's region, so the bucket has to be created in the
chosen region too. (Firestore triggers are only a latency consideration, not a hard match.)

Picking one of those two regions for the new project removes the cross-region split
entirely.
