# Loja Integrada: master plan for the marketplace integration

Date: 2026-10-07 · Method: `marketplace-integration` skill, Phases 0–2 · Tracker: **#1812**, opened together with this plan's PR #1811 (D14), with one issue per step (§4.25).
Evidence: the official OpenAPI 3.1 spec, served at `https://api-docs.lojaintegrada.com.br/openapi/API-Loja-Integrada.json` ("API Loja Integrada", `info.version` v2, server `https://api.awsli.com.br`, 76 paths / 108 operations, no login needed; read with `li-doc.mjs` from the evidence folder; provenance in §1.0). Also used: the help center (`ajuda.lojaintegrada.com.br`), 4 doc surveys (A auth/inbound · B orders/fulfilment · C catalogue/stock/price · D web/secondary), one old-vs-current spec diff, 27 adversarial per-field verdicts, 8 focused gap answers, a re-verification run on 2026-10-07 after the store owner reported the legacy integration working (§1.3), and the legacy surveys (kept private, see §3).
Citation conventions:
- `spec <METHOD> <path>`: an operation.
- `spec tag <Tag>`: a tag's prose.
- `spec info`: the info block (auth, throttling, novidades).
- `help NNNN`: a help-center article number. Full URLs are in the evidence files.
- Legacy facts are cited as "legacy code", never by file and line.
- Each source of a business rule is labelled **[spec]**, **[help]**, **[live-proven, legacy credential]** (exercised live today by the working legacy integration under the `chave_api` + `aplicacao` combination; not yet seen under the Personal Token, §1.3), **[legacy-observed, unverified]** (a wire value seen in legacy captures that no LI document confirms) or **[ERP rule]** (re-derived from operator intent, not from LI).

---

## 0. Executive summary

- **No official Loja Integrada MCP exists.** The MCP registry, a web search and the help center all came up empty. None is needed: the spec is a public JSON document, and `li-doc.mjs` prints its operations, tags and info block as plain text. It should be promoted into the skill as the Phase-3 reference tool, as `shopee-doc.mjs` was.
- **Legacy credential: resolved on 2026-10-07.**
  - **What happened:** LI announced that old-model application keys are refused from **05/10/2026** (help 931152), and the legacy key was most likely one of them. On 2026-10-07 the store owner moved the live legacy integration to **Personal Tokens on both stores**. They are sent as `Authorization: Basic <token>` with the raw token, and the legacy's order import, stock, price and tracking writes, and its web screens all run on them. The old-key risk is gone.
  - **Consequences for this plan:**
    - The new integration uses **its own** tokens, never the legacy's (D16).
    - The legacy's tokens are revoked once the legacy app is switched off (§5 item 10).
    - The token format and the absence of an IP binding are now settled live (§1.2 items 7–8, §1.3).
  - **Operational duty, outside this repo:** the legacy's tokens expire three months after generation, in early January 2027, unless the owner renews them in the painel. Renewing restarts the 3 months from the click.
- **The five architecture answers** (§1.1):
  1. Webhooks are *authenticated* by a static Bearer secret we choose, not signed. The receiver fails closed.
  2. Push exists but is unreliable and undocumented. The 5-minute poll is the guaranteed path; the order webhook only speeds it up.
  3. Stock goes out as one `PUT /v1/produto_estoque/{produto_id}` per CHILD produto, with no batch, bounded by **100 req/min per store**.
  4. A listing is a parent/child FAMILY of produtos: a parent `atributo` with `atributo_opcao` children.
  5. The buyer's fiscal identity is inline in `GET /v1/pedido/{numero}`.
- **Lifetime (D2):** Lucas plans to replace Loja Integrada with his own storefront in 2027. Until then the integration must be guaranteed. ⇒ **Parity, lean, robustness over features.** Nothing goes beyond the four daily flows (order import, stock, price, publish/edit/import-link) unless it fixes correctness. For that reason this revision drops the stale-pending re-check and the `pedido.marketplace` status echo that an earlier draft had added.
- **Credential (D3):** one Personal Token per store, sent as `Authorization: Basic <token>`.
  - The owner generates it. It expires every 3 months and is renewed in the painel; renewal keeps the same token.
  - No partner key is requested. That is a design choice: partner keys are IP-bound, and LI does not process partner-key requests from store owners (help 5360466). ⇒ no IP allow-list ⇒ **no static egress**. The live legacy already runs on Personal Tokens from dynamic cloud egress and from operators' browsers, so they are **not IP-bound** (§1.2 item 7). The connect route's validating GET re-confirms this under the new tokens.
  - The ERP stores an expiry date the operator types in, raises one aviso 30 days ahead, and parks the conta ("reconexão pendente") on a 401/403.
  - The token lives in an admin-only credential store.
- **Testing without a demo store (D4):** there is no sandbox, and a demo store costs money ⇒ **no live write before the cutover.**
  - **Captures (D17):** no code in this repository calls LI before the cutover. When a step needs real responses, the owner captures read-only production responses himself, by his own means, and keeps them outside every repository checkout. Each capture records which credential type it ran under. An offline sanitizer (step 2b) turns them into committed fixtures with personal and store-identifying values faked; a raw capture is never committed.
  - **Fixtures:** tests use wire fixtures built from the official OpenAPI examples (redacted) plus redacted read-only captures.
  - **Valves:** every write flow ships behind an OFF valve with a DRY-RUN mode. The dry-run logs the exact payload and diffs it, read-only, against LI's current GET.
  - **Canary allow-list:** the valves carry one, so that each write kind's first real write goes to one canary produto or pedido (§4.26).
  - **Logging and read-back:** an **allow-list** structured logger records every call, and a read-back GET follows every real write.
  - **Window:** the valves flip ON inside the cutover window (§5).
- **The corpus constrains three deterministic ids** (§3), reproduced byte for byte and pinned by test vectors:
  - pedido: `sha256("lojaIntegrada"+contaId+"-"+numero)`
  - pagamento: `sha256("integracao/"+contaId+"-"+pagamentoId)`
  - item: `ensureUniqueId = String(item.id)`

  **The legacy corpus has no order mirror, and none is invented.**
- **Dropped or deferred:**
  - NF-e upload to LI (D8) and Enviali labels (D6).
  - Chat / Q&A / claims (`'nao'`).
  - Native size charts and kits (`'nao'`; parity workarounds in steps 11/12).
  - The product webhook (orchestrator call) and per-variation images (parity).
  - The product side of LI's hub (D5).
  - Sweep tiering (D12) and the partner key + static egress (D3).
  - The template's stuck-reservation release: LI cancels stale orders itself, and the poll carries the change (§4.i).

---

## 1. Phase 0: capability survey (the caps row)

This is the proposed `MARKETPLACE_TIPO_CAPS[INTEGRACAO_TIPO.lojaIntegrada]` in `packages/schemas/src/shared/marketplace.ts`. It replaces today's `{ ...NAO_INVESTIGADO, channel: null, implementado: false }`. `implementado` stays `false` until step 22.

```ts
[INTEGRACAO_TIPO.lojaIntegrada]: {
  channel: 'loja-integrada',          // apps/loja-integrada, :3010 (next free port)
  implementado: false,                // flips at step 22
  // Static header credential; no OAuth, token or refresh endpoint anywhere (spec info §Autenticação;
  // components.securitySchemes: both apiKey/header Authorization; no per-operation override in 108 ops).
  // Two unmixable modes: `Basic <Personal Token>` — store-owner generated, expires every 3 months,
  // renewed by hand in the painel (help 931152) — THE MODE WE USE (D3; live on both stores since 2026-10-07, §1.3);
  // `chave_api <k> aplicacao <k>`
  // — the integrator combination, IP-bound for current integrator keys (help 5360466) — not used.
  auth: 'api-key',
  pkce: 'nao',                        // no authorize/token endpoint exists (spec scan: 0 oauth/pkce hits)
  // PUT /webhooks/v1/{pedido,produto} {notifyUrl, token}; repeats are documented, retries/timeout/ordering
  // are not (spec tag Webhook Pedidos). Whether a Personal-Token store may register is unconfirmed
  // (§1.2 item 4) — 'push' records that the provider HAS push; the guaranteed path is the 5-min poll of
  // GET /v1/pedido/search?since_atualizado= (prose-only param); the order hook only accelerates it (D13).
  notificacoes: 'push',
  // AUTHENTICATED, NOT SIGNED. 'sim' here means "the provider authenticates its deliveries and the
  // receiver fails closed", NOT "verify a body signature": LI echoes the static secret WE choose at
  // registration as `Authorization: Bearer <token>` (spec tag Webhook Pedidos) — no HMAC, timestamp or
  // nonce. Fail CLOSED: secret unset ⇒ 503, mismatch ⇒ 401, constant-time compare. Never write an HMAC
  // verifier. (marketplace.test.ts pins this comment-backed meaning for lojaIntegrada.)
  assinaWebhook: 'sim',
  // The PRODUCT is the listing: POST /v1/produto (tipo normal | atributo | atributo_opcao) and
  // PUT /v1/produto/{id}, which asks for every field ("é necessário enviar todos os campos do produto").
  // Price, stock and images are separate calls (spec POST /v1/produto, PUT /v1/produto/{produto_id},
  // GET /v1/produto/{produto_id}, POST /v1/produto_imagem).
  publicarAnuncio: 'sim',
  // GET /v1/produto (Tastypie meta.next paging; DECLARED filters are only sku / ativo /
  // data_modificacao__gte / data_modificacao__lte — removido, data_criacao and __lt/__gt are prose-only;
  // no tipo or pai filter; the default listing may include removido=true, so removido is always passed
  // explicitly) + GET /v1/produto/{id}?descricao_completa=1; parents list their children in `filhos`
  // (examples only) (spec GET /v1/produto, spec GET /v1/produto/{produto_id}).
  importarAnuncio: 'sim',
  // Parent/child FAMILY: parent tipo 'atributo' + grades ['/api/v1/grades/{g}'] (plural); each child tipo
  // 'atributo_opcao' + pai + variacoes ['/api/v1/grade/{g}/variacao/{v}'] (singular), each with its own
  // price and stock (spec POST /v1/produto examples cadastrar_produto_pai / _filho). "≤ 50 variations per
  // product" and "grades cannot be removed once linked" are help-center panel guidance (help 5195150),
  // enforced client-side, not API contracts. Grades/options are STORE-level and create-only
  // (POST /v1/grades, POST /v1/grade/{grade_id}/variacao; no PUT/DELETE).
  variacoes: 'sim',
  // The store's OWN category tree + brand list (spec GET/POST /v1/categoria, GET/POST /v1/marca; categorias[]
  // and marca are URIs on the produto). NO marketplace taxonomy, NO attribute schema: grades are variation
  // axes, not attributes.
  categoriasEAtributos: 'sim',
  tabelaDeMedidas: 'nao',             // no size-chart resource in 76 paths; parity workaround in step 11
  // Products are only tipo normal | atributo | atributo_opcao and no composition resource exists;
  // "Compre Junto" is a cart promotion (help 5899457). ERP kits go out as ordinary products whose
  // quantity the ERP computes (step 12).
  kitVirtual: 'nao',
  // `ativo` on the full-body PUT /v1/produto/{produto_id}; "Produto ativado? = Não" hides without deleting
  // (help 5195150). removido=true is the API's only soft-delete lever (probably the panel lixeira; unproven,
  // §1.2 item 24). No PATCH and no DELETE on produto. Parent→child ativo cascade is undocumented (§1.2 item 17).
  pausarAnuncio: 'sim',
  estoque: {
    // PUT /v1/produto_estoque/{produto_id} {gerenciado, quantidade, situacao_em_estoque, situacao_sem_estoque}
    // (spec PUT /v1/produto_estoque/{produto_id}, spec tag Estoque). Not writable through /v1/produto.
    suporte: 'sim',
    // One PUT per LI produto — per CHILD for a family; no batch write and no id_externo addressing on estoque.
    protocolo: 'por-anuncio',
    loteMax: null,                    // no batch exists; the real bound is 100 req/min per store (spec info, 633)
    multiDeposito: 'nao',             // one pooled quantidade per produto; no warehouse key anywhere in the spec
  },
  // PUT /v1/produto_preco/{produto_id} {cheio, custo, promocional, sob_consulta}, per child; no promotion
  // dates; no batch write (spec GET /v1/produto_preco/set/{produto_id} — semicolon-separated ids — is GET-only)
  // (spec PUT /v1/produto_preco/{produto_id}).
  enviarPreco: 'sim',
  // GET /v1/pedido/search?since_atualizado= (documented limit ≤ 50; rows are summaries) then GET /v1/pedido/{numero}.
  // The path key is the order NUMERO: example "165" ⇔ resource_uri /api/v1/pedido/165 (spec GET
  // /v1/pedido/{pedido_id}); the webhook's internal `id` is never a REST key. Search + detail by numero are
  // live-proven by the working legacy under the chave_api + aplicacao combination (§1.3).
  importarPedido: 'sim',
  // Inline pagamentos[] on GET /v1/pedido/{numero} (spec GET /v1/pedido/{pedido_id}); no per-payment status,
  // fee, net or settlement field — status comes from the order's situação codigo. /v1/pagamento is the
  // store's payment-METHOD catalogue, not transactions.
  importarPagamento: 'sim',
  consolidaPacote: 'nao',             // one pedido → envios[]; no multi-order shipment concept
  // cliente.cpf/cnpj/razao_social and endereco_entrega.{tipo, cpf, cnpj, ie, rg, razao_social} arrive inline
  // in GET /v1/pedido/{numero} — no second, gated call.
  dadosFiscaisSeparados: 'nao',
  // LI mints NO label when an order is created (envios[] carries forma_envio + objeto only). We emit through
  // the carrier int_frete.mapa routes to (Melhor Envio / generic label). Enviali (POST
  // /enviali/v2/postage/bill, prepaid wallet) is an optional paid LI freight service — not used (D6).
  etiqueta: 'emit',
  // INBOUND only: envios[].objeto read on GET /v1/pedido/{numero}. The OUTBOUND write-back
  // (PUT /v1/pedido_envio/{envios[i].id} + PUT /v1/situacao/pedido/{numero}) has no caps field — step 7.
  rastreio: 'pull',
  // POST/PUT /v1/integration/pedido/nf: metadata + DANFE/XML URLs, multipart (spec tag Nota Fiscal).
  // A provider FACT; deliberately not built (D8).
  enviarNfe: 'sim',
  perguntas: 'nao',                   // no Q&A resource (0 hits across 76 paths)
  mensagensPosVenda: 'nao',           // no buyer–seller messaging resource
  reclamacoes: 'nao',                 // no claims/returns API; refunds/disputes arrive only as situação codes (step 5)
  origensConversa: [],
},
```

The row lands with a whole-row assertion in `marketplace.test.ts`, following the Shopee precedent. That test also asserts the `assinaWebhook` comment's meaning for LI: authenticated, not signed. The three web registry tests that hand-write `[lojaIntegrada, 'canal-nao-pesquisado']` change to `'canal-nao-implementado'` in the same commit (step 1a).

### 1.0 Documentation provenance (verified 2026-10-07)

- **The host is LI's own.** `api-docs.lojaintegrada.com.br` is a subdomain of LI's own `lojaintegrada.com.br` and is served with LI's own response headers (`x-li-app: scalar-public`).
- **LI's help center points to it.** The official help center links it as the API documentation (help 12500189 and 5360466). Help 12500189 itself was last updated 2025-10-02; the September 2026 date below belongs to the spec file, not to the article.
- **The copy in use is the live file.** The spec's HTTP `last-modified` is 2026-09-29. The copy every agent used is byte-identical to the live file (same sha256, recorded in the evidence files).
- **It describes the API the working legacy calls.** Its server, `https://api.awsli.com.br`, is the base URL of the working legacy client, and the spec paths carry the same `/v1/...` prefix.
- **The Apiary site is the old version.** LI's older Apiary document is titled "Versão descontinuada". This plan uses it only where noted (the reservation formula; §1.2 item 3, step 12).
- **The spec's own help links are crossed.** In `spec info`, the "Personal Token" link opens the integrator article (5360466), while the Personal Token is described in 931152. This plan cites help articles by number, not by the spec's link labels.
- **Limits of the source.** The spec is hand-maintained prose plus examples. Some parameters exist only in prose (`since_atualizado`, `offset`, several `GET /v1/produto` filters), and some examples are stale (`resource_uri` uses `/api/v1`). It is authoritative for names and shapes, not proof of live behaviour. §1.3 records what is live-proven.

### 1.1 The facts that change the architecture (Phase 0 questions 1–5)

| # | Question | Answer | Source |
|---|---|---|---|
| 1 | Signs its notifications? | **Authenticates, does not sign.** We register `{notifyUrl, token}` with `PUT /webhooks/v1/{pedido,produto}`, and every order hook carries `Authorization: Bearer <token>`. There is no HMAC, timestamp, nonce or event id. The product tag never states the header; this is inferred from the identical body and moot, because the product hook is not used. Registrations cannot be listed (no GET). `DELETE` needs the exact `{notifyUrl, token}` pair, so we persist both. The body field `token` is undocumented: we never authenticate or route on it, and the conta comes from the URL path. | `spec tag Webhook Pedidos`, `spec PUT/DELETE /webhooks/v1/pedido` |
| 2 | Push or poll? | **Both; poll is the guarantee.** Repeats are documented; retries, timeout, ack code and ordering are not. Whether a Personal-Token store may register a hook is undocumented: help 9655071 is from 2024 and predates the Personal Token. The poll uses `GET /v1/pedido/search?since_atualizado=` (a prose-only parameter, inclusive "a partir de", documented `limit` ≤ 50, Tastypie offset paging) plus one `GET /v1/pedido/{numero}` per changed order, because list rows carry no itens/pagamentos/envios. **Search-then-detail with `since_atualizado` and `meta.next` paging is live-proven by the working legacy** under the `chave_api` + `aplicacao` combination. What the legacy shows about the wire: `meta.next` is an `/api/v1/...` URI (rebuild from its query string, never follow it verbatim), response order is not relied on, and only `limit` 20 has ever been used live (50 is documentation-only until `meta.limit` is read back) (§1.2 items 10, 11, 13). The webhook body shape differs from the GET shape (numbers vs decimal strings, `codigo` vs `code`, `produto_id` vs a `produto` object) ⇒ **always re-fetch, never map the body**. The spec tells integrators to consider only hooks with `situacao.situacao_alterada: true`. **D13 deliberately overrides that advice:** a hook is only a trigger to re-fetch, so a false flag costs one GET. The guess that tracking/payment/address edits arrive with the flag false is an **unverified inference**. | `spec GET /v1/pedido/search`, `spec tag Webhook Pedidos`, help 9655071, **[live-proven, legacy credential]** |
| 3 | How does stock go out? | **One call per child produto.** `PUT /v1/produto_estoque/{produto_id}` with all four fields; no batch, no `id_externo` addressing (the old `/set` and `?id_externo=1` estoque variants are gone). Throttles, all HTTP 429: 100/min per store (633), 3,000/min per application (533), 1,200/min per IP (133). `Retry-After` and window semantics are undocumented. `GET /v1/produto_estoque` has no filters ⇒ there is no delta poll, and the reconcile is a paged full read. | `spec PUT /v1/produto_estoque/{produto_id}`, `spec tag Estoque`, `spec info` |
| 4 | Listing = one resource or a family? | **Family.** A parent `atributo` holds the descriptive data, categories, brand and photos. Each variation is an `atributo_opcao` child with its own sku, price, stock and grade-option links. Grades/options are store-level and create-only. The help center says a product has ≤ 50 variations and grades are permanent once linked; that is panel guidance, enforced client-side, not an API contract. `PUT /v1/produto/{id}` asks for every field ⇒ GET-merge-PUT, serialised. Publishing is non-atomic and must be resumable. Orders reference the CHILD (`itens[].produto`, `produto_pai`). | `spec POST /v1/produto`, `spec PUT /v1/produto/{produto_id}`, help 5195150 |
| 5 | Buyer fiscal identity inline or gated? | **Inline.** `endereco_entrega` is the NF-e destinatário source (tipo PF/PJ, cpf, cnpj, ie, rg, razao_social, address); `cliente` adds cpf/cnpj/razao_social. There is no IBGE code (resolve it from the CEP), values are free text (`ie: "isento"`), and LGPD-anonymised customers exist. The legacy import reads these same fields from `GET /v1/pedido/{numero}` today. | `spec GET /v1/pedido/{pedido_id}`, `spec GET /v1/cliente/search`, **[live-proven, legacy credential]** |

### 1.2 Contradictions and unknowns only a live call settles

Under D4 the items fall into three kinds:
- **READ-ONLY-CAPTURABLE:** settled by a read-only production response that the owner captures himself and the step-2b sanitizer turns into a fixture, before the code that depends on it is merged. No code in this repository makes the call (D17).
- **WRITE-ONLY:** settled *defensively* in code now, then *confirmed* in the window. The first real write of each kind goes to a canary (§4.26), its read-back is reviewed, and only then is the flow widened.
- **GATE:** stops the plan if the answer is unfavourable.

A few facts are already **live-proven by the working legacy, under the `chave_api` + `aplicacao` combination** (§1.3): order search with `since_atualizado` + `meta.next` paging, and order detail by numero. They are still re-confirmed under the Personal Token by the owner's captures (D17). **Every capture records which credential type it ran under**, and a fact proven under one credential is never assumed under the other.

1. **Partial vs full PUT on `/v1/produto`, `/v1/produto_estoque`, `/v1/produto_preco`.** WRITE-ONLY. Defence: always send a FULL body built from a fresh GET. For produto, that is the PUT request-schema field set (step 11). For estoque, the four fields per D9. For preço, `cheio`/`custo`/`promocional`/`sob_consulta` merged over the GET. The pre-write GET is logged as the restore point.
2. **Does `PUT /v1/produto` persist `descricao_completa` and `variacoes`?** WRITE-ONLY. Both are missing from the PUT request schema and from both PUT request examples (`alterar_produto`, `alterar_produto_com_id_externo`). They appear only in POST examples and in GET/PUT responses. `grades` appears in the `alterar_produto_com_id_externo` request example, and `pai` appears in both. PUT also declares a `descricao_completa` **query parameter** (spec PUT /v1/produto/{produto_id}). Defence: send them, and let the step-11 plan decide whether to use the query parameter. The read-back compares all three.
3. **Reservation math.**
   - **Sources:** the formula `quantidade_disponivel = quantidade − quantidade_reservada` and the "gross on-hand" meaning of `quantidade` come from LI's older official Apiary document. Every current-spec stock example has `quantidade_reservada = 0`, and neither help article states the formula.
   - **What the help articles disagree on:** help 924633 reserves on Pedido Efetuado, Aguardando Pagamento and Pagamento em Análise. Help 912137 limits reservation to the "neutral" statuses Aguardando Pagamento and Pagamento em Análise.
   - **Kinds:** the arithmetic, and whether Pedido Efetuado reserves, are READ-ONLY-CAPTURABLE: a captured GET of a SKU with a pending LI order (ideally one in Pedido Efetuado). What LI does when `quantidade` is rewritten while reservations are pending is WRITE-ONLY.
   - Decided in the step-12 plan (§7 q5); drift is logged by the read-back.
4. **Webhook registration with a Personal Token.** WRITE-ONLY, because registration is a write. Settled at the window (§5). A refusal costs latency only, because the poll is the guaranteed path.
5. *(Withdrawn: product-hook triggers are moot, because the product webhook is not used.)*
6. **429 body, `Retry-After`, fixed vs sliding window, and which bucket a Personal Token consumes.** These are observable only when throttled, and we never provoke throttling on purpose. Defence: the classifier keys on HTTP 429 and searches any body for `533|633|133`; the logger records the first real occurrence verbatim (redacted).
7. **GATE: is the Personal Token IP-bound? Settled live on 2026-10-07: no.** The legacy integration runs on Personal Tokens from dynamic cloud egress (no static IP) and from operators' browsers on arbitrary networks, and all its calls succeed **[live-proven, Personal Token]**. D3's "no static egress" premise holds. The new integration's first validating GET (step 1) re-confirms it under the new tokens from the new runtime. An unexpected 401/403 there, while another network gets 2xx, still stops the plan for a replan.
8. **Personal Token wire format: settled live on 2026-10-07.** The token goes raw after `Basic `, with no base64 and no user:pass, exactly as help 931152 documents. Both stores' legacy integrations run this way **[live-proven, Personal Token]**.
9. **401 vs 403, and the body of a bad or expired token.** READ-ONLY. One GET with a deliberately wrong token (Step 0).
10. **Max `limit`** on `/v1/produto`, `/v1/produto_estoque`, `/v1/{produto_preco}`, `/v1/categoria` and `/v1/grades`, plus the max number of ids per `GET /v1/produto_preco/set/{produto_id}` (semicolon-separated). Also `GET /v1/pedido/search`: its documented max of 50 is **documentation-only** until `meta.limit` is read back, because the legacy has only ever used 20 live. READ-ONLY: request 50/100/500/1000 and read `meta.limit` back. The client never assumes the requested limit was honoured.
11. **Timezone of naive REST dates**, `since_atualizado` inclusivity at second resolution, and whether `offset` is honoured. READ-ONLY. The timezone is inferred as America/Sao_Paulo, because webhook `21:09Z` matches nested `18:09-03:00`. The poller sends `since_atualizado` in the documented `AAAA-MM-DDTHH:MM:SS` form only: seconds, no fraction, no offset. The capture uses that exact form.
12. **`GET /v1/pedido/{numero}` vs the webhook's internal `id`.** **Moot.** The design never feeds the webhook `id` to REST, and there is no internal id of our own stores to probe with before the window. Nothing depends on the answer.
13. **`meta.next` form and the trailing slash.**
    - **Known from the working legacy:** `meta.next` is an `/api/v1/...` URI, while spec paths are `/v1/...`. Design: rebuild each next request from `meta.next`'s query string against the operation's own `/v1` path (e.g. `/v1/pedido/search`); never follow the URI verbatim.
    - **READ-ONLY:** whether the trailing slash matters. The legacy sends `/pedido/search/`; the spec path has none. Step 1 sends the slash form (the spec's own curl example and the legacy's live calls) and never follows a redirect, so a wrong form shows as a visible 3xx instead of doubling the calls. Only the slash form is captured: no decision depends on the other one.
14. **Situação 1020 (`pagamento_devolvido_sem_retorno`).**
    - **Sources:** its id and flags come only from the legacy enum. The spec's `GET /v1/situacao` example has 15 rows and omits it, and the tag lists the codigo without an id.
    - **What LI says:** help 924633 treats it as cancelled, with the item not returned to stock, and e-mails the buyer. Step 5 maps it as refunded, per the help center.
    - **READ-ONLY:** `GET /v1/situacao` on each store confirms its id and flags, and whether a store can define custom situações, **before step 5's estado table is frozen**.
15. **Does an API situação PUT e-mail the buyer?** Undocumented.
    - The PUT body is only `{codigo}`, so the caller has no notify switch, and the spec never defines `notificar_comprador`.
    - Help 924633 says LI e-mails the buyer on every status change, with one template per status. It does not say whether an API PUT fires the same mailer as the painel.
    - WRITE-ONLY. Defence: **assume every write to 11, 13 or 14 may e-mail the buyer**; `notificar_comprador` is a hint, not a guarantee. ⇒ D7's never-write-onto set, skip when LI already shows the target, serialised writes (step 7).
16. **How LI represents "no promotion", and how to clear `promocional`.** The spec shows both `null` and `"0.00"` as no-promotion states: the `GET /v1/{produto_preco}` list example has a row with `promocional: "0.00"` next to `cheio: "259.90"`, and many rows with `promocional: null`. The PUT request schema types `promocional` as integer and never documents `null`. The reading part is **READ-ONLY-CAPTURABLE, before the step-13 merge**: a captured GET of the preço of products with no promotion on each store and record which representation LI uses. The wire value for clearing is picked from that result. Whether the PUT accepts it stays WRITE-ONLY. On read-back, both `null` and `0.00` count as cleared. A failed clear raises an aviso and is retried with the other representation only on the canary, by a human decision. That fallback is chosen in the window, not automated.
17. **Parent `ativo` cascading to children.** Undocumented. The panel has a per-variation "Variação ativa?" toggle, so children carry their own `ativo`. WRITE-ONLY. Defence: pause/resume writes every family member, so a family pause may cost 1 + N GET-merge-PUTs.
18. **`valor_pago` filling, and `boleto_url`/`pix_code` on GET.** READ-ONLY. The spec GET example has `valor_pago: "32.48"`, and only the webhook example shows `null` on an approved order. `boleto_url`/`pix_code` appear only on the `PUT /v1/pedido` echo. The schema treats all three as optional.
19. **Family discovery on import.** `filhos` on parents is documented **in examples only** (spec GET /v1/produto, spec GET /v1/produto/{produto_id}); it is not in the list-item schema. `GET /v1/produto` has no `tipo` or `pai` filter. Whether children appear as rows in `GET /v1/produto` pages, and whether list rows carry `pai`, is **READ-ONLY-CAPTURABLE**: the spec list example has 20 rows, none with `pai`, and `pai` is not among the list-item keys. The importer discovers children through `filhos` plus per-child GETs and never depends on children appearing in the list.
20. **The `/v1/produto_estoque/{produto_id}` path id is the produto id, not the estoque row id** (the example `id` ≠ path). READ-ONLY with a child id.
21. **Duplicate-SKU error shape.** The legacy-observed response is a `400` with an "integridade" message **[legacy-observed, unverified]**. WRITE-ONLY. Defence: a tolerant match (400 + "integridade"), then `GET /v1/produto?sku=` and adopt.
22. **Payment method codes for pix and card on our stores.** READ-ONLY. Run `GET /v1/pagamento` on each store, plus one real pix order `GET /v1/pedido/{numero}` (redacted), before step 6 merges. The spec catalogue has no pix gateway, and `pagamento_tipo` appears only as `creditCard`.
23. **Does `/v1` accept an unknown `x-correlation-id` request header?** (It is documented only for Enviali.) READ-ONLY, from an optional capture the owner makes with the header (D17). If any rejection is seen, the header is dropped on `/v1`; without that capture it stays off. Until then the step-1 validating GET sends no such header: a gateway that refused it with a 403 would make a valid new token read as refused.
24. **`GET /v1/produto` filters and `removido`.**
    - **Declared vs prose:** the declared parameters are only `sku`, `ativo`, `data_modificacao__gte` and `data_modificacao__lte`. `removido`, `data_criacao` and the `__lt`/`__gt` operators appear only in prose. There is no `tipo` or `pai` filter.
    - **Default listing:** the unfiltered list examples include `removido: true` rows, so the default listing may include trashed products ⇒ **always pass `removido` explicitly**.
    - **READ-ONLY:** whether the prose-only filters are honoured; compare counts with and without them.
    - **Meaning:** "`removido` = trash" is an inference. `removido=true` is the API's only soft-delete lever and is probably the panel lixeira (help 931878), but that is unproven.

### 1.3 Verification record (2026-10-07)

Every caps field was handed to an independent skeptic, with the spec, the help center and the surveys, and instructions to refute it. That is 27 fields, counting the four `estoque.*` members. **25 held and 2 were corrected:**
- `kitVirtual`: `'desconhecido'` → `'nao'`. The spec's closed `tipo` set, plus the absence of any composition resource, is positive evidence.
- `rastreio`: the 3-of-4 survey majority `'push'` → `'pull'`. In this repo `rastreio` describes how tracking reaches US; the outbound `PUT /v1/pedido_envio` is a separate step.

A completeness critic then reconciled the verdicts. Each contradiction was settled as follows:

- **Order key = `numero`** (gap 1). Every `resource_uri` is `/api/v1/pedido/<numero>`, and `GET /v1/pedido/{pedido_id}` has no top-level `id` at all. `spec GET /v1/pedido_dce/{pedido_id}` says outright "o valor informado na URL é o número do pedido" (its tag only says "através do número do pedido"). NF `sale_number` is "o número do pedido". The working legacy fetches order detail by numero live. The one verdict that said "key on the LI id" had confused it with the SHIPMENT id: `PUT /v1/pedido_envio/{id}` takes `envios[i].id` ("Não utilize o ID do pedido nesta chamada").
- **`filhos` is documented in examples only** (spec GET /v1/produto, spec GET /v1/produto/{produto_id}, POST/PUT examples), not in the list-item schema. The importer discovers families through it. Children as list rows is a probe (§1.2 item 19).
- **`boleto_url` / `pix_code` appear in the spec only on the `PUT /v1/pedido/{pedido_id}` echo.** They are optional, never required.
- **The 05/10/2026 discontinuation** (help 931152, modified 2026-09-22) reads as: the store's own credential is now the Personal Token, and the "chave de aplicação" now identifies only integrators/partner apps (help 5360466). D3 picks the Personal Token. The live legacy integration moved to Personal Tokens on 2026-10-07, so the announcement no longer threatens it (§0).
- **Freight model:** `etiqueta: 'emit'`. `FREIGHT_TIPO_CAPS.lojaIntegrada` (`marketplaceOwned: true`, `labelMode: 'fetch'`) is a placeholder that contradicts the evidence; it changes in step 15.
- **`forma_envio` key mismatch** (`code` on GET, `codigo` on the webhook). This reinforces "re-fetch, never map the body"; the `int_frete.mapa` key is built from the GET shape.
- **Stock arithmetic** is not settled by the docs (gap 5). It is decided in the step-12 plan.
- **Enviali units** (cm per the tag, "mm" in one prose table) are moot under D6.
- **`situacao_alterada`:** one rule applies. Hooks are triggers to re-fetch, and none is dropped on that flag (D13, overriding the tag's advice; see §1.1 row 2).
- **429 vs other transient statuses:** the classifier treats 429 (any code), 5xx and network errors as transient.

**Re-verification after the owner's report (2026-10-07).** The store owner reported that the legacy LI integration is working. Six independent re-verifiers then re-checked the architecture facts against the spec, the help center and the legacy code.
- **Documentation provenance** was confirmed (§1.0).
- **Live-proven, under the `chave_api` + `aplicacao` combination:** `GET /v1/pedido/search` with `since_atualizado` and `meta.next` paging, and `GET /v1/pedido/{numero}`, i.e. numero keying and the detail field set the import reads. These are labelled **[live-proven, legacy credential]**.
- **Spec/code evidence only, at the time of that re-verification:** everything else. That covered every write (situação, `pedido_envio`, stock, price, produto, images), webhooks, and all Personal Token behaviour. Part of it is superseded by the Personal Token record below.
- **Captures record their credential type** (step 2b's sanitizer refuses one that does not), so live evidence under one credential is never mistaken for the other.
- **Corrections it produced, applied in this revision:**
  - the legacy-credential risk note (§0);
  - documentation provenance (§1.0);
  - poll wire details (§1.2 items 10, 11, 13; step 3);
  - situação 1020 and situação e-mails (items 14, 15; steps 5, 7);
  - reservation sources (item 3; step 12);
  - catalogue filters and help-center limits (items 17, 19, 24; step 11);
  - mixed link-doc ids (§3);
  - freight resolution (steps 5, 15);
  - the restored corpus field name `arakene_variation_id` (§3, step 10).

**Live-proven under the Personal Token (2026-10-07).** The same day, the store owner moved the live legacy integration to Personal Tokens on both stores. These facts are now labelled **[live-proven, Personal Token]**:
- **Credential format:** `Authorization: Basic <token>` with the raw token, alone, with no `chave_api` or `aplicacao` (§1.2 item 8).
- **No IP binding:** calls succeed from dynamic cloud egress and from operators' browsers (§1.2 item 7).
- **Reads the legacy makes:** order search with `since_atualizado` and order detail by numero, the situação history, and the catalogue reads behind its web screens (produto, categoria, marca, grades).
- **Writes the legacy makes are accepted:** the stock PUT, the price PUT, the tracking PUT (`pedido_envio`) and the situação PUT.
- **Browsers:** the operators' browsers send the `Authorization` header cross-origin. This does not matter to the new integration, which calls LI only from its server.

What this does **not** settle: the legacy's writes use its own payloads, so partial-vs-full PUT semantics, the reservation math, how to clear a promotion, the buyer e-mail on a situação PUT, webhook registration, and the 429 bucket and body stay open as listed in §1.2 (items 1–4, 6, 15–17). None of this is evidence about the new code. Its own end-to-end proof is still the window's canaries and intake smoke (§5 items 8–9).

---

## 2. Prerequisites and decisions

| # | Prerequisite (human) | What it unblocks | Why it is load-bearing |
|---|---|---|---|
| P1 | **A Personal Token per store for the NEW integration, generated by the store OWNER** (Configurações > Chave para API > Personal token; paid plan; at most 5 active; shown once; help 931152). These are separate from the tokens the live legacy has used since 2026-10-07 (D16). Generated for production at the window; none is needed before it (D17). | The connect route's validating GET, production. | Only the owner can generate it; Administrador/Membro cannot. |
| P2 | **The token's expiry date entered in the ERP together with the token.** The token expires every 3 months (help 931152). The operator copies the expiry date shown in the painel; the ERP never computes it. | The expiry aviso (step 2). | No API exposes the expiry, so the ERP otherwise learns of an expired token only from a 401. Renewal keeps the SAME token and restarts 3 months from the click. A token that is not renewed is revoked and cannot be recovered. |
| P3 | **Legacy credential: resolved on 2026-10-07** (§0). The live legacy runs on its own Personal Tokens. The remaining duty, outside this repo, is for the owner to renew those tokens before they expire (early January 2027) if the legacy is still running then. | Keeps the live system up until the cutover. | A token that is not renewed is revoked and cannot be recovered. This repo never touches the live system or reuses the legacy's tokens (D16). |
| P4 | **No demo store** ⇒ no live write before the cutover (D4). | The valve/dry-run/canary/read-back design. | Every write flow's first real write happens in the window. |
| P5 | **Webhook registration at window time** (a write). | Step 4's accelerator. | Registering earlier would point a production store at a non-production URL. |
| P6 | **The IP-binding answer: settled live on 2026-10-07, not bound** (§1.2 item 7). The new integration's first validating GET re-confirms it. | Steps 3, 4 and every write step. | D3's "no static egress" depends on it. |

### 2.1 Decisions taken by Lucas on 2026-10-07 (binding)

| # | Decision | Consequence in the plan |
|---|---|---|
| D1 | **Scope:** the four daily legacy flows (order import, stock sync, price sync, publish/edit products, incl. importing/linking existing LI products) reach parity BEFORE the cutover. LI is a **blocker** at cutover. | §4.25 orders the steps to reach those four flows first. Label routing (15) and the status write-back (7) ride along because daily operation needs them. |
| D2 | **Lifetime:** LI is replaced by Lucas's own storefront (expected 2027); until then the integration must be guaranteed. | Parity, lean, robustness over features. Nothing beyond parity unless it is a correctness fix. This revision drops the stale-pending re-check and the `pedido.marketplace` echo. |
| D3 | **Credential:** Personal Token per store, `Authorization: Basic <token>`. No partner key is requested (a design choice; partner keys are IP-bound and LI does not process store-owner requests for them, help 5360466) ⇒ no IP allow-list ⇒ no static egress. Expiry entered by the operator, aviso ahead, park on 401/403 ("reconexão pendente"). Token in an admin-only credential store. **The new integration never reuses the legacy client's key.** | Steps 0–2. No VPC/NAT/proxy work, subject to the Step-0 gate. |
| D4 | **Testing:** no demo store ⇒ no live writes before cutover. Read-only redacted probes; mock fixtures from the official examples plus redacted captures; a strong structured logger; every write flow behind an OFF valve with a DRY-RUN diff; valves flip ON in the window; read-back GET after every real write. | Step 2b (logger, valves, canary allow-list); §4.26 write inventory; every write step's "Dry-run/valve" bullet; §5 items 3 and 8. |
| D5 | **Hub:** LI is only the storefront; no marketplace orders are injected via LI's hub. A cheap skip-and-flag guard for `marketplace_info` / `id_anymarket` stays as a safety net. | Step 5's hub guard. |
| D6 | **Labels:** Melhor Envio through the ERP, routed by `int_frete.mapa` (LI shipping method → target carrier) plus a per-pedido override `integracaoTargetOuterRef`. Enviali is NOT used. | Steps 15 and 20. |
| D7 | **Status write-back:** tracking code (`PUT /v1/pedido_envio/{envios[i].id}`) plus situação `pedido_enviado` / `pedido_entregue` / `pronto_para_retirada`. `pedido_enviado` is set on posting whether or not a tracking code exists. Never write a situação onto an order whose current LI situação is refunded/cancelled/chargeback/dispute (7, 8, 16, 6, 1020): the API enforces no transitions, and any write to 11/13/14 may e-mail the buyer (§1.2 item 15). | Step 7. The orchestrator adds `cancelamento_solicitado` (1019) to the guard, giving the never-write-onto set {6, 7, 8, 16, 1019, 1020} (vetoable; see the orchestrator calls below). |
| D8 | **NF-e upload to LI: NO.** `enviarNfe` stays `'sim'` as a provider fact. | Step 14 dropped. |
| D9 | **Stock flags:** keep sending `gerenciado=true`, `situacao_em_estoque=0`, `situacao_sem_estoque=-1` (parity; the products are configured that way). Reviewer's caution: this overwrites per-product lead-time settings in LI by design. | Step 12 sends the full 4-field body. |
| D10 | **Promotional price:** if the conta has no promotional list, or no positive promo value ⇒ **clear** the promotion on LI. | Step 13; the clear wire value comes from the §1.2 item 16 capture. |
| D11 | **Stores:** both legacy LI stores work at cutover ⇒ multi-conta from day one (one credential and one 100 req/min budget per store). | Every step is keyed by `integracaoId`. |
| D12 | **Volume:** small, ≤ ~500 SKUs (variations counted) and ~20 LI orders/day per store ⇒ **no sweep tiering**; event-driven stock/price deltas plus one daily full reconcile per conta. | Steps 12–13; §4.23. |
| D13 | **Intake:** webhook + poll. The 5-minute poll (durable per-conta cursor) is the guaranteed path; the order webhook is an accelerator registered at the cutover. Both feed ONE notification pipeline, and the task ALWAYS re-fetches `GET /v1/pedido/{numero}`. Never drop a hook on `situacao_alterada=false`. The receiver fails CLOSED (per-conta secret in the credential store; constant-time Bearer compare; unset ⇒ 503; mismatch ⇒ 401), and the conta is identified by the URL path, never the body. | Steps 3–4. |
| D14 | **Issues:** one tracker + one issue per step, opened when this plan's PR is approved. Migration-window issues (§5) need a **separate** yes. | — |
| D15 | **Execution:** ask before each build. Every step gets a Phase-3 step plan that Lucas approves before code is written; stacked draft PRs. | §4.25. |
| D16 | **Separate tokens** (decided 2026-10-07, after the legacy moved to Personal Tokens). The new integration uses its own Personal Token per store, generated for it, and never the legacy's. The legacy's tokens are revoked after the legacy app is switched off. | P1; step 1's connect route; §5 items 1 and 10. |
| D17 | **Mock only** (decided 2026-10-09). No live call from this repository's code before the cutover. No probe CLI, and no token handled by step 2b. No token, real or invented, is saved or renewed through the step-2 credential routes before the window, because every save makes a live validating GET. When a step needs real responses, the owner captures read-only production responses himself and keeps them outside the repository, and an offline sanitizer turns them into committed fixtures. Widening a canary list needs `*`. Fixtures keep SKUs, order numbers, dates, quantities and prices, and fake everything else that identifies a person or a store. The write engine moves to step 7. | Step 2b (logger and redaction, capture sanitizer, valves); §1.2 "READ-ONLY-CAPTURABLE"; Step 0; §4.25 "Captures, per step"; §7 q4 closed. |

**Orchestrator calls (vetoable, one line each):**
- **Size-chart parity:** the chart's text is appended to `descricao_completa` between stable markers, so a re-publish is idempotent, and the chart's first photo is sent as the last image (step 11).
- **Per-variation images are not sent** (parity), although `PUT /v1/produto_imagem/{id}/grade_variacao/{gv}` now supports them (help 4543275: one image per variation). Those endpoints' path-id semantics are also undocumented.
- **The product webhook is not used.** The ERP is the catalogue master, and LI-side drift is caught by the daily reconcile.
- **`custo` keeps being sent on price PUTs** (parity), to be confirmed in the step-13 plan (§7 q1).
- **Poll bootstrap is a configurable look-back** (idempotent by deterministic ids) instead of copying the legacy `pedManager` history. The window sizes it from the newest legacy `lastTimeStamp` (§5 item 7).
- **`cancelamento_solicitado` (1019) joins D7's never-write-onto set**, making it {6, 7, 8, 16, 1019, 1020}. The spec flags 1019 `cancelado: true`, and step 15 already refuses a label for it. Without it, a posting could write `pedido_enviado` over a buyer's cancellation request and e-mail the buyer (step 7).

**Design under D4 (part of the plan, not an optional extra; Lucas may still veto at PR review):** the write valves carry a canary allow-list, and each write kind's first real write targets a canary (§4.26). Without it, "canary-first" is impossible with one env valve per flow. If vetoed, §5 item 8 becomes "first write is fleet-wide", and that must be stated in the window runbook.

---

## 3. Legacy (`.old`): what constrains the port, what to keep, what NOT to port

**Corpus that exists. It survives the cutover with its ids, so read-tolerance is mandatory:**
- `integracao/{contaId}` with `tipo = 3`:
  - Generic integracao fields: `nome`, `ativo`, `padrao`, `cor`, `operacaoOuterRef`, `operacaoDevolucaoOuterRef`, `tabelaNormalOuterRef`, `tabelaPromocionalOuterRef`, `depositoOuterRef`, `filialIntegracaoPedidoOuterRef`, `dataCadastro`.
  - `modalidadeFreteImportacao`: default FOB-destinatário when empty.
  - `cpf_cnpj` + `idCadIntTran`: the NF-e intermediador, used only when the operation has `indIntermed == 1`.
  - A credential field `token_id`. It is dropped at migration; the new credential lives in the admin-only store (step 2, §5 item 2).
- `integracao/{contaId}/pedManager/{autoId}` is the legacy order-poll cursor (`lastPedidoId`, `lastTimeStamp`): one auto-id doc per poll, read newest-first.
- `int_frete/{id}` of `tipo 'lojaIntegrada'` (`EnviosLojaIntegrada`):
  - Plain fields: `nome`, `ativo`, `filialIntegracaoFreteOuterRef`, `faixaCep[]`, `horarioDeCorte[]`, `enderecoDeOrigem`, `dataCadastro`.
  - `contaLojaIntegradaEnviosOuterRef` holds `'documents/integracao/<id>'`.
  - `mapa[]` entries are `{nomeOriginal: '<nome> - <tipo>', idOriginal: '<forma_envio.id>---<forma_envio.code>', observacao: 'Origem: Pedido N', integracaoUid, targetTipoIntegracao, targetData}`. Entries auto-appended at import carry `integracaoUid: null` until the operator maps them.
- `categorias/{id}/categorialojaintegrada/{autoId}` holds `id` (the LI category id as a string) and `nome`. The legacy docs have no conta field. New docs gain `contaLojaIntegrada`, and legacy docs without it are read tolerantly.
- `produtos/{id}/produtolojaintegrada/{docId}`, typed today by `lojaIntegradaLink.ts`.
  - The stored `contaLojaIntegrada` is always the string `'documents/integracao/<contaId>'`; every legacy writer serialises it that way. Readers also accept bare `integracao/<id>` and native reference values, as a harmless defence.
  - **Doc ids are MIXED.** Import-created links use `String(<LI produto id>)` as the doc id; export-created links use auto ids; updates keep the existing doc id. ⇒ Readers query by fields (`contaLojaIntegrada` + `id`) and never compute the doc id. The link-doc `id` field is an integer.
  - `estadoPublicacao` wire codes: `r` rascunho, `a` aguardando, `ep` em processamento, `v` em revisão, `p` publicado, `pa` pausado, `c` cancelado, `E` erro. Unknown/null reads as `r`.
- `produtos/{id}` denorms written by LI code: `marketplace[] {integracaoUid, externalId}`, `marketplaceIds[]` (bare LI ids), `integracoesComProduto[]` (bare contaId), and `statusProdutosMarketplace{'<contaId>_<externalId>': {error?, enviarEstoque (default true), retries?, autoImport?, deleted?}}`.
- `grupoDeVariacoes/{id}.linksVariacoesli[]` holds `{name, grade_id: int, integracaoLiId: <bare contaId>, variationOptions: [{li_option_id: int, li_option_name, arakene_variation_id: string[]}]}`.
  - `arakene_variation_id` is the corpus's own per-variante id array. The name is already public in this repo (`packages/schemas/src/produto/collection/shopeeLinkVariacoes.ts`), and that file's typing is the precedent.
  - Today the field is typed as `z.array(z.json())` in `grupoDeVariacoes.ts`; step 10 types it.
- `produtos/{id}/estoques/{autoId}` (`depositoOuterRef`, `quantidade`, `quantidadeReservada`, …) is already modelled by `estoque.ts`.
- Orders: `pedidos/{digest}` + `pedidos/{digest}/pagamentos/{digest}` + `clientes/{id}/enderecos/{id}`.
  - On the pedido, `freteInicial.externalId` = the LI envio id and `externalOptionData` = the raw `forma_envio` JSON (GET shape).
  - **Where `freteInicial` points:** a migrated pedido whose shipping method was already mapped at import points `freteInicial` at the TARGET `int_frete` (e.g. `melhorEnvios`, with `externalOptionId = targetData.id`). It goes through that provider and needs no change. Only unmapped pedidos carry the `lojaIntegrada` `int_frete` and need step 15's resolver.

**The three deterministic ids.** Reproduce them byte for byte, and pin them in an `orderIds.test.ts` that asserts near-misses unequal. Both preimage numbers are spec example values: numero `165` (spec GET /v1/pedido/{pedido_id}) and pagamento id `69291176` (`pagamentos[].id` in the same example).

| Id | Preimage (UTF-8, sha256, lowercase hex) | Vector (`contaId = 'CONTA1'`) |
|---|---|---|
| pedido | `"lojaIntegrada" + contaId + "-" + numero` (numero as a plain decimal) | `('CONTA1', 165)` → `60fe37ac35667bf3d56a8cb3a015114133ce02dad6d7338ac5db4f421413e532` |
| pagamento | `"integracao/" + contaId + "-" + pagamentoId`: bare `integracao/`, no `documents/`, no leading slash; `pagamentoId` = `pagamentos[].id` | `('CONTA1', 69291176)` → `39d4d6a7a8bbe3ec98fa3c0564f3c2974228ee2cc306a03ad6e6ef091b115178` |
| item | `ensureUniqueId = String(itens[].id)`, **not hashed** (ML and Shopee hash theirs) | — |

Near-misses that must stay distinct:
- `'/documents/integracao/CONTA1-69291176'` (the ML spelling) → `4d70fa6a3875ae722644b147143cdef061411406114f9e28ddab15123435560d`
- `'CONTA1-165'` (the Shopee spelling, no prefix) → `02d33e497ceebc8dbbc25f818c8f8c6ed56492d26ce84c57c4d295b201725c6f`

A missing payment id is an error in the new code. **Never** normalise the pagamento preimage through `toOuterRef`. No `-desconto` sibling exists for LI.

**Corpus that does NOT exist:** no LI order mirror (no `orderML`-like blob, no `pedlojaintegrada`), no webhook registration or secret doc (the legacy integration was poll-only), no token subcollection. ⇒ **Do not invent a mirror.** The question "which pedido owns LI order N of conta C" is answered by the deterministic id. No status echo on the pedido either (D2).

**What the shared seams replace:**
- The legacy credential field on the conta doc → an admin-only credential store (`integracao/{id}/credenciaisLojaIntegrada/current`, step 2). The field is removed from the migrated docs in the window (§5 item 2).
- The `pedManager` auto-id series → ONE cursor doc per conta (step 3), seeded by look-back, never by copying history.
- Per-flow retries → `defineNotificationPipeline`.
- The `produtos.marketplace[]`/`marketplaceIds` denorms → link-doc queries plus the server-maintained `integracoesComProduto` anchor. The denorms are read tolerantly, not written.

**Legacy surfaces replaced, not ported:** the legacy scheduled services and UI-driven flows are replaced by the pipeline below.

**Business rules to re-derive.** Each carries its source class:
- **Order estado by situação `codigo`, never by the `aprovado`/`cancelado` flags** **[spec]**. The spec's own flags make `pagamento_em_disputa` (6) and `pedido_chargeback` (16) `aprovado: true`, and `cancelamento_solicitado` (1019) `cancelado: true, final: false`. The full enumerated table is in step 5. An unknown codigo is `error`, never a default.
- **Paid = the first situação-history entry that reached an approved codigo** **[spec]**. That entry comes from `GET /v1/situacao_historico/search?numero=`, which also yields the approval and cancellation dates. Cancelled after approval ⇒ refund (`estornadoIntegralmente`); cancelled before approval ⇒ `cancelado` **[ERP rule]**.
- **Payment form by `pagamento_tipo` + `forma_pagamento.codigo`:**
  - Boleto family `boleto`/`wcboleto`/`pmboleto`/`pmboletov2`/`psboleto`/`pagali-boleto`/`mpboleto` → boleto **[spec]**.
  - `deposito` → depósito **[spec]**.
  - `creditCard` → cartão **[spec]**.
  - `PAGAMENTOEXTERNO` → hub guard **[spec]**.
  - Pix (`instantPayment`, `pagali-pix`) and the old `pagamento_banco` key beside `banco` **[legacy-observed, unverified]**: pinned by the §1.2 item 22 captures before step 6 merges.
  - Anything else → `outros`, keeping the raw codigo/nome.
  - Parcelas come from `parcelamento.numero_parcelas`, defaulting to 1 only when absent **[spec]**.
- **Unit discount spreading** **[ERP rule]**: `descontoUnitario = (quantidade × preco_venda − preco_subtotal) / quantidade` when positive. When `preco_subtotal` exceeds `quantidade × preco_venda`, the unit price becomes `preco_subtotal / quantidade`.
- **Freight `mapa` auto-registration and matching** **[ERP rule]**:
  - Every unseen `forma_envio` is appended to the conta's `EnviosLojaIntegrada.mapa` the first time an order uses it, with `integracaoUid` unset.
  - An unmapped method is visible to the operator and never fails the import.
  - **Import-time matching uses the full `'<id>---<code>'`** and requires `integracaoUid` set. Melhor Envio, motoboy and retirada targets are accepted:
    - a Melhor Envio target sets `externalOptionId = targetData.id` and points `freteInicial` at the target `int_frete`;
    - motoboy/retirada set the target without an option.
  - Any other target degrades gracefully: an aviso, no failure.
  - **Label-time resolution** (step 15) matches on the id part only and lets the per-pedido `integracaoTargetOuterRef` override the mapa.
- **Dispatch deadline** **[ERP rule]**: from the freight doc's `horarioDeCorte` when present. Otherwise a business-day noon cutoff in America/Sao_Paulo: before 12:00 on a weekday → same day; otherwise the next business day; Friday afternoon and weekends → Monday.
- **Price/stock rules:**
  - The normal price list → `cheio`; the promotional list (> 0) → `promocional`, else clear (D10) **[ERP rule]**.
  - A "never lower" mode for account-wide pushes **[ERP rule]**.
  - Skip `removido`/`bloqueado` listings **[spec fields, ERP rule]**.
  - Stock = the conta depósito's available quantity, integer, clamped at 0 **[ERP rule]**.
  - Kit quantity is ERP-computed: the min over limiting components of ⌊disponível/qtd⌋ **[ERP rule, ADR 0014]**.
  - One ERP parent ↔ exactly one LI parent per conta **[ERP rule]**.
  - Publishing requires every variante of every child to be linked to an LI grade option **[ERP rule]**.
- **Checkout paid re-check** **[ERP rule]**: before a label is bought for an LI pedido, a live read of the LI situação must show a paid codigo that has not been reverted (step 15).

**Other legacy-code findings are kept in the operator's private notes; only the rules above are ported.**

---

## 4. Phase 2: the master plan

Every step gets a Phase-3 step plan that Lucas approves before code is written (D15). Each step carries the same bullets: **Gate · Trigger · Docs · Wire · Firestore (incl. Indexes + Rulesets + Env) · Seam · Rule 7 · Dry-run/valve · Verification · Timing · Does NOT**. A bullet reads "none" where that is true.

### 4.i Template → LI step mapping

The template (`references/master-plan-template.md`) has steps 1–21. The LI numbering keeps the template numbers where the content matches. Lettered sub-steps (1a, 2b) and step 22 are LI's own.

| Template step | LI step(s) | Note |
|---|---|---|
| 1 Scaffold + OAuth connect | 1a (caps row) + 1 | Connect = credential capture (no OAuth). |
| 2 Context + credential store + cache | 2 + 2b | 2b = logger, valves, canary list, capture sanitizer (D4, D17). |
| 3 Receiver + queue, or poller | 3 (poller, primary) + 4 (receiver, accelerator) | LI step **4 is the receiver**, not the template's backstop. |
| 4 Delivery backstop | folded into 3 | LI has no replay feed. The durable cursor with a 120 s overlap is the backstop; a parked conta's cursor does not advance, so the gap is re-read on reconnect. |
| 5 Order → pedido | 5 | Also does inbound tracking (template 7's inbound half). |
| 6 Payment | 6 | Inline, same task as 5. |
| 7 Shipment → `freteInicial` + conference | inbound in **5**; LI step **7** = OUTBOUND status write-back (D7) | |
| 8 Stuck-reservation release | **none (dropped)** | LI cancels unpaid orders itself (boleto after 7 days, manual after 14; help 912137). That situação change reaches step 5 through the poll cursor, and step 5's codigo table releases any ERP reservation. Under reservation model B (§7 q5) the ERP holds no reservation for unpaid LI orders at all. |
| 9–13 | 9–13 | |
| 14 NF-e | dropped (D8) | |
| 15 Labels | 15 | |
| 16–19 | dropped (§4.24) | |
| 20 `int_frete` sync | 20 | |
| 21 `apps/web` | 21 | |
| — | 22 | Not in the template: deploy isolation, guard rosters, flip `implementado`. |

### 4.ii Conventions every step obeys

- **No generic `catch`** (rule 6). Narrow on the in-repo classes (`LiAuthError`, `LiThrottleError`, `LiNotFoundError`, `ZodError`, …) and `throw err` otherwise; `err instanceof Error` does not count. This applies especially to the logger, the probe CLI, the error classifier and the `onChamada` observer.
- **Every optional Firestore field is `.nullable().default(null)`**, never bare `.optional()` and never a bare `X | null`.
- **Money via `roundReais`.** Provider responses are read via `lerRespostaJson`, and numbers are read string-or-number tolerant (`integration-response-numbers-tolerant`).
- **Watermark units are written beside every field** (µs vs ms). Comparisons go through `coerceToMicros`.
- **Task payloads and failure docs carry ids only, no PII.**
- **Live end-to-end verification of any LI read or write happens first at the window.** There is no staging rehearsal (§7 q4, closed by D17). Every step's Verification says what is fixture-only. A behaviour live-proven by the legacy (§1.3) is still re-confirmed under the Personal Token.

### 4.iii Definition of done, per step

1. Tests, including a **near-miss** wherever something decides that two values are "the same" (a pair that must be equal and a pair that must stay distinct).
2. Every new query has its composite declared in `firestore.indexes.json` in the same PR, or names the existing index it reuses. `delfrance/default-query-needs-index` and `defaultQuery.indexes.test.ts` stay green.
3. If any `*Meta`, PERM, validator whitelist, enum, cascade or new admin-only collection changed: **both** rulesets regenerated (`gen:rules` **and** `gen:rules:e2e`) plus both snapshots refreshed. Agents never deploy rules; the deploy is a window step.
4. New env vars appear in the root `.env.example` **and** the app's `apphosting.yaml` (and the functions env) **in the step that introduces them**.
5. The CI lane runs the new tests. `ci-loja-integrada.yml` lands in step 3, together with the first emulator test (the tasks round trip). Step 2's tests are all offline, against an in-memory fake, so a lane there would have nothing to run. A lane that skips runs the tests nowhere.
6. New `runTransaction` sites are classified in `firestore-transaction-inventory.test.js`, and a new HTTP client that exports a `{ curto, longo }` timeout constant is registered in `http-client-timeout-ceiling.test.js`. A GET-only client with one budget (step 1) has no row.
7. Anything that must run against production data or infrastructure is surfaced as a §5 item. It is never done by the agent and never left as a TODO.

### Step 0: Prerequisites (P1–P6). Human, not code

- **Outcome:**
  - **No probe token** (D17): no code in this repository calls LI before the cutover. The new integration's own tokens (D16) are generated for production at the window. A token is never committed and never pasted into chat.
  - The legacy credential is resolved: since 2026-10-07 the live legacy runs on its own Personal Tokens (§0).
  - This plan approved.
  - **The IP-binding gate and the token format were answered live** on 2026-10-07 (§1.2 items 7–8): not bound, and raw after `Basic `. An optional quick re-check stays the owner's own read-only curl, by his own means and outside this repository:
    `read -s LI_TOKEN; curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Basic $LI_TOKEN" 'https://api.awsli.com.br/v1/categoria?limit=1'`
    The same call with a deliberately wrong token shows the 401/403 shape (§1.2 item 9). Only status codes are recorded.
  - The `GET /v1/situacao` read (§1.2 item 14) becomes capture C3 on both stores, made by the owner (D17), before step 5's estado table is frozen.
- **Timing:** P6 is answered. If a later check under the new tokens ever shows an IP binding, the plan stops and is replanned.

### Step 1a: Caps row

- **Gate:** none (it IS the gate). **Trigger:** none. **Docs:** §1.
- **Wire:** none.
- **Firestore:** none. **Rulesets:** none expected (caps are not a Meta); the `gen:rules` diff is checked. **Env:** none.
- **Seam / change:**
  - The row in §1 replaces `NAO_INVESTIGADO` for `lojaIntegrada`.
  - `marketplace.test.ts` gains a whole-row assertion, plus the `assinaWebhook` meaning for LI.
  - `apps/web/lib/marketplace/{estoque,preco,anuncioStatus}/registry.test.ts` flip `[lojaIntegrada, 'canal-nao-pesquisado']` → `'canal-nao-implementado'`.
  - `CanalCapsPanel` renders the row unchanged. `registriesAlinhadas.test.ts` stays green because `implementado` is false.
- **Rule 7:** none. **Dry-run/valve:** none.
- **Verification:** `pnpm --filter @delfrance/schemas test` and the three registry suites.
- **Timing:** first, because every later gate reads this row.
- **Does NOT:** touch `FREIGHT_TIPO_CAPS` (step 15) or create any app.

### Step 1: `packages/integrations/loja-integrada` + `apps/loja-integrada` scaffold

- **Gate:** `auth: 'api-key'`, `pkce: 'nao'`. **Trigger:** HTTP. **Docs:** `spec info`, help 931152.
- **Two stacked PRs** (the approved step plan, 2026-10-07):
  - **PR a:** the package, the guard change and the package docs.
  - **PR b:** the bare app scaffold, plus the rosters and counts that become false once a tenth Next app exists.
- **Package** `@delfrance/integrations-loja-integrada` is fetch-only and **GET-only**: no Firestore, no `process.env`, no logging; its deps are `@delfrance/core` + zod. It has no `build` script.
  - **`client.ts`:**
    - Base URL `https://api.awsli.com.br` is a constant, not an option: LI has no sandbox, and a fixed origin rules out a class of misconfiguration (the spec's server and the working legacy client's base URL, §1.0).
    - Header `Authorization: Basic <token>`: the raw token, not base64, not `Bearer`, never in the URL.
    - The token is passed as a **function**, called on every request, and never stored. It must be visible ASCII; anything else throws `LiConfigError` before a request is made.
    - The credential also carries an opaque, non-secret `ref` label. The package echoes it on every result and error so step 2's parking guard can tell which credential got a 401.
    - There is **no write method and no body parameter**: every request is a GET by construction (D4).
    - `x-correlation-id: <uuid>` is sent on every call by default, and returned to the caller for logging. Whether `/v1` accepts it is an **assumption checked by an optional owner capture** (§1.2 item 23, D17). **The validating GET sends no such header until that is settled**, and the header is dropped on `/v1` if it is rejected.
    - **Redirects are never followed.** A 3xx is an error, so the token cannot be carried to another host.
    - **One per-call deadline, `PRAZO_LI_MS`, in the package** (`prazos.ts`), in the Melhor Envio shape. There is **no row** in `http-client-timeout-ceiling.test.js`: that table is for clients with a `{ curto, longo }` pair, and a GET-only client has no `longo`. The test that "the calls in one request fit under the ceiling" arrives with the first route in step 2.
    - An `onChamada` observer hook, so the app logs without the package reading env.
  - **`errors.ts`:** a typed hierarchy. 5xx (including any non-standard 52x) is transient.
    - `LiConfigError`: a bad token, `ref`, path or page cap, raised before any request.
    - `LiHttpError` (status, `transitorio`). **No error carries any part of the response body**, so there is no excerpt. The step-2b logger already gets the scrubbed body through `onChamada`, and its allow-list redaction fails closed; an excerpt kept on the error would bypass it.
    - `LiThrottleError`: 429; `escopo: 'loja' | 'aplicacao' | 'ip' | 'desconhecido'` from 633/533/133 found anywhere in the body; `retryAfterS` when the header exists.
    - `LiAuthError`: 401/403, the parking signal.
    - `LiNotFoundError` (404).
    - `LiSchemaError`, `LiPaginacaoError`, `LiNetworkError`, `LiTimeoutError`.
    - **Deferred to the first write steps (11, 12):** `LiConflictError` (409, e.g. "Slug already in use.") and `LiIntegridadeError` (400 + "integridade").
  - **`paginacao.ts`:** Tastypie offset paging driven by `meta.next`, with caller cancellation.
    - It **rebuilds** each next request from `meta.next`'s query string against the caller's own `/v1` path, and never follows the `/api/v1/...` URI verbatim (§1.2 item 13).
    - It stops on `next === null`, reads `meta.limit` back, and never assumes response ordering.
    - It throws at the page cap instead of silently truncating, and throws if the offset does not advance.
  - **`types.ts`:** only the paging envelope and `categoria` (`liMetaSchema`, `liEnvelopeSchema`, `liCategoriaSchema`), written from the spec examples with `.passthrough()`. Numbers use `wireInt()` / `wireNumber()` from `@delfrance/core/wire`; there is no per-channel copy.
  - **`api.ts`:** `validarPersonalToken`, the validating GET (see Connect below).
  - **Deferred to the first consumer.** Captures arrive per step, from step 3 on (D17), so schemas written now from spec examples would be rewritten against them.
    - Resource schemas: pedido search row and detail, including **both `itens[].produto` shapes** (steps 3 and 5); situação and histórico (5); pagamento (6); produto list/detail (9); marca and grades (10); imagem (11); estoque (12); preço (13); envio (5, 7 and 20).
    - **Naive São Paulo dates** → µs epoch (`dataLiParaMicros`, tz-aware, not a fixed −03:00) and the cursor formatter, which emits exactly the documented `AAAA-MM-DDTHH:MM:SS` (seconds-truncated, no fraction, no offset). They land in step 3 as two generic helpers in `@delfrance/core/datetime`, not in this package.
    - Webhook `Z`/offset dates are parsed by their own offset (step 4).
- **App** `apps/loja-integrada` (`@delfrance/loja-integrada-app`, Next 16.2.6, API-only, `:3010`) is a **bare scaffold** in PR b:
  - `app/api/health`, `apphosting.yaml` (`minInstances: 0`) and `CLAUDE.md`.
  - No `proxy.ts`, no `verifyCaller` and no `lib/firebase/admin.ts` yet. They move to step 2 PR a with the connect route.
  - The same PR fixes the rosters and count text the app makes false: the Next-app and pin counts in root `CLAUDE.md`, `KNOWN_APPHOSTING_APPS` and `KNOWN_NEXT_APPS`, `SERVER_PATHS` in `no-ambient-timezone`, and the `pnpm-workspace.yaml` comments. They are **struck from step 22**.
- **Connect** is credential capture, not OAuth. **Step 1 ships the validator; the route moves to step 2 PR a (#1829):**
  - **Step 1:** `validarPersonalToken` runs `GET /v1/categoria/?limit=1` (the slash form) with a candidate token and returns a four-way verdict: `aceito`, `recusado`, `invalido` (the token is malformed and was never sent) or `inconclusivo`. It is fully unit-tested.
  - **Step 2:** `PUT /api/marketplace/loja-integrada/conta/[id]/credencial` (`PERM.integracao.write`, body `{token, expiraEm}`) calls it unchanged and maps the verdict to the HTTP response. Only on `aceito` does it write `integracao/{id}/credenciaisLojaIntegrada/current`; a `recusado` answers 422 "token recusado". The token is never echoed, logged or put in a URL. `DELETE` takes the conta id only.
  - **Why it moved:**
    - The route writes the credential doc, whose schema, Admin handle and store belong to step 2, and its `save` must also clear `reconexaoPendente` in the same write.
    - Its only caller is the credential form (step 2 PR a, with step 21's conta CRUD).
    - `cors-proxy-covers-routes.test.js` fails any `proxy.ts` with no route under its matcher, so the proxy must land with its first `/api/marketplace` route.
    - Step 2 edits `integracao.ts` anyway, and that file is on the nfe-live path list. A step-1 schema there would fire a real SEFAZ homologação run twice instead of once.
- **Guard change (PR a):** `packages/config-eslint/rules/removed-plugin-contracts.test.js` drops `loja-integrada` from the must-not-exist list and gains an LI shape assertion: no `MarketplaceChannel` declared, re-exported or registered (the Shopee precedent). It moves to PR a because that guard checks that the package file does **not** exist, so PR a's own `CI test` would otherwise go red, and a stacked PR b cannot fix PR a's head. `integration-response-numbers-tolerant.test.js` also gains the package's `src/` and a non-vacuity anchor. The prose that says the LI scaffold "stays deleted" (ADR 0015, root `CLAUDE.md`, `packages/integrations/README.md`, the integration-authoring guide) is updated in the same PR, and the provider list in the root `README.md` gains Loja Integrada.
- **Firestore:** none. **Indexes:** none. **Rulesets:** none. **Env:** none. `ALLOWED_ADMIN_ORIGINS` lands in step 2 with `proxy.ts`, and `LOJA_INTEGRADA_TASKS_REGION` in step 3, its first reader (§4.iii item 4).
- **Seam:** `lerRespostaJson`, `abrirPrazo`, `wireInt` / `wireNumber` (all `@delfrance/core/wire`).
- **Rule 7:** not applicable; step 1 writes nothing.
- **Dry-run/valve:** none; the only LI call is a GET, and the client has no write method.
- **Verification:** package unit tests with a mocked `fetch` against redacted spec-example fixtures. They cover:
  - paging, including `/api/v1` next-links rebuilt against `/v1` from their query string, a non-advancing offset, the page cap and caller cancellation;
  - 429 bodies carrying each code, and none;
  - the token character check, and that no error or event carries the token or a body excerpt;
  - that a redirect is not followed;
  - each validator verdict.

  The live validating GET is first exercised at the window, §5 item 1 (D17).
- **Timing:** after Step 0's gate. The package is the only place LI is called from.
- **Does NOT:** OAuth, refresh, oauth-state or PKCE; the `chave_api + aplicacao` mode; query-string credentials; reuse the legacy client's key; the connect route, proxy, credential schema or store (step 2); any LI write method; retry, backoff or pacing; a CI lane (step 3).

### Step 2: Credential store + context + read cache + expiry aviso + 401 parking

- **Gate:** always. **Trigger:** library + the credential routes; the daily `onSchedule` wrapper ships in step 3. **Docs:** help 931152.
- **Re-cut at implementation** (the approved step plan, 2026-10-08). Where a bullet below disagrees with this list, this list wins:
  1. The expiry sweep is split. Its body (`lib/lojaIntegrada/conta/expiracaoSweep.ts`) ships in step 2 and is tested offline. Its `onSchedule` trigger ships in step 3, in the nested functions codebase, because a codebase created for one schedule could not show in CI that the schedule fires.
  2. There is no CI lane in step 2. It lands in step 3 with the first emulator test. The park is proven offline against a fake that models `lastUpdateTime` and `NOT_FOUND`.
  3. Parking is a tier-1 precondition write, not a class-B transaction: read, decide, `update(patch, { lastUpdateTime })`, re-read on `FAILED_PRECONDITION` and on `NOT_FOUND`, at most 3 attempts. No Loja Integrada source file may contain the transaction API's call name, because the inventory test greps every non-test source file for it.
  4. The park guard compares a versioned ref (`fingerprint of the stored personalToken` + `.` + `tokenAtualizadoEmMs`) with the ref of the token that got the 401. It is never the stored `tokenFingerprint` field, so a hand-edited field cannot disable parking, and re-saving the same token cannot be re-parked by a request already in flight. The nested field is `refCredencial`, not `fingerprint`.
  5. Everything that needs a pipeline or a queue moves out: the deferred lane, the re-drive on save, the poller skip and the intake outcome "conta parada" go to step 3; the step-7 deferral goes to step 7. The deferred cap is the shared `MAX_TENTATIVAS_DEFERRED = 7`, so the "14 days" below cannot be met as written and is settled in the step-3 and step-7 plans.
  6. A renewal route is added: `PUT …/conta/[id]/credencial/validade`, body `{expiraEm, versaoEsperada}`. The Personal Token is shown once and renewing it in the painel keeps the same token, so without this route a renewed token's expiry could never be updated. It doubles as a revalidate action after a false park.
  7. `CANAL_AVISO` gains `lojaIntegrada`. The rulesets do not change: the generator reads no cascade, and `avisos` is server-owned and deny-all.
  8. Step 2 does not edit `packages/schemas/src/integracao.ts`, and the declarative cascade line is dropped. Nothing at runtime reads `meta.cascade`: the conta delete trigger walks `listCollections()`. The credential schema lives in a new file, `packages/schemas/src/credenciaisLojaIntegrada.ts`, so no step-2 PR touches a path that fires the live SEFAZ suite.
  9. Step 2 ships as five stacked PRs: W1 (the conta CRUD in `apps/web`, first, because the aviso route needs its `[id]` page), a (schemas), b (backend), c (the credential panel), and d (the migration script, a sibling).
  10. The connect, renewal and status routes read the conta uncached and require only `tipo === 3`, bypassing the refusing context loader. Otherwise a parked or inactive conta could never be fixed.
  11. The park aviso is clocked by the credential document's own commit time in µs, not by a wall clock. Commit times on one document are strictly ordered, so a late park raise can never reopen a row that a newer save closed.
  12. Web corrections: no `CAMPOS_POR_CANAL.lojaIntegrada` entry (its totality test fails only when `integracaoSchema.shape` gains a key); the e2e spec is a staging `.vendas.` spec, not an emulator one; and `call<T>()` already validates its response.
  13. The context's client sends no `x-correlation-id` until §1.2 item 23 is settled. If `/v1` answers that header with a 403, an enabled header would park a conta on its first call.
  14. The connect route re-checks the conta after writing. If the conta was deleted while the token was being validated, it deletes the credential it just wrote and answers 404, because the cascade walk runs on the conta delete only.
  15. Credential writes from the panel carry the version the operator saw (rule 7, tier 3). The status route returns `versaoCredencialUs`, the µs of the credential document's `updateTime`; save and renewal send it back and write under `lastUpdateTime`; a loss is a 409. This reverses the "tier 0, last write wins" line below. DELETE stays unconditional.
  16. The expiry check covers every tipo-3 conta that has a credential, active or not. Deactivating a conta in the ERP does not stop the token's 3-month clock, and an unrenewed token is revoked for good. Removing the token silences the warning.
  - **Known limit of the sweep's second pass:** the pass that closes avisos of deleted contas reads open avisos newest-first, 200 per page and at most 5 pages. The rows it exists to close are the oldest, so beyond 1,000 open avisos across the whole repo they are never reached. This is Shopee's registered limit too. The cure is a composite index on canal, tipo, resolvidoEm and criadoEm, which is an index deploy for the window, surfaced in the step plan and not opened as an issue.
- **Why a bespoke store, not the generic `integracao/{id}/credenciais`:**
  - The generic schema is OAuth-token-shaped.
  - The `integracao.ts` docstring already says LI's static key must be introduced "directly in admin-only storage".
  - LI needs fields the generic store has no place for: an operator-entered expiry, the webhook secret pair, and the parking state.
  - The store is **deny-all** to clients, with no ML-style client grant (#829), and it is modelled on `credenciaisWhatsapp`.
- **Connect route and app plumbing (moved from step 1):**
  - The `PUT`/`DELETE` credential route (step 1 lists its contract), calling `validarPersonalToken` unchanged.
  - `proxy.ts`: CORS for `/api/marketplace/*` only (`ALLOWED_ADMIN_ORIGINS`); `verifyCaller` copied per #1431; `lib/firebase/admin.ts`.
  - **Rule 7 for the route:** tier 1, losing to tier 3 (re-cut item 15). Two operators and two tabs are plausible, so the save carries the version the operator saw: `create` when the credential is absent, otherwise `update` under `lastUpdateTime`, and a lost race is a 409 `LI_CREDENCIAL_ALTERADA`. The save also clears `reconexaoPendente` in the same write and never mentions `webhookPedido`.
  - **A token already stored on another LI conta is refused (409 `LI_TOKEN_DE_OUTRA_CONTA`),** active or inactive, which catches pasting the same token into both contas. It cannot catch two tokens swapped between contas: no LI endpoint identifies the store.
  - **Renewal and removal:** `PUT …/credencial/validade` re-validates the stored token and saves a new expiry under the same version check; `DELETE …/credencial` is idempotent and unconditional.
- **Firestore:**
  - **`integracao/{id}/credenciaisLojaIntegrada/current`** is strict and admin-only, outside `ALL_DOMAINS`. Fields:
    - `personalToken`.
    - `tokenFingerprint`: a sha256 prefix with a domain prefix, diagnostic only (logs and support). It is never the guard input.
    - `tokenExpiraEmMs` (ms) and `tokenAtualizadoEmMs` (ms).
    - `webhookPedido: {notifyUrl, token}`, `.nullable().default(null)` (step 4).
    - `reconexaoPendente: {desdeMs (ms), status, refCredencial}`, `.nullable().default(null)`. `desdeMs` is for display only and is never compared.
  - **Cascade:** none declared (re-cut item 8). The conta delete trigger's `listCollections()` walk reclaims the subcollection, as it already does for `brandshopee`, and the connect route's post-write re-check closes the one race the walk leaves.
  - **New avisos:** `TIPO_AVISO` gains `lojaIntegradaTokenExpirando` and `lojaIntegradaReconexaoPendente`, plus `CANAL_AVISO.lojaIntegrada` and `ROTAS_AVISO.canalLojaIntegrada`. Both are in-app only: the expiry reminder has no e-mail or WhatsApp delivery.
  - **Indexes:** none new. Doc reads are by id; the expiry sweep and the wrong-store guard enumerate contas through the existing `integracao (tipo ASC, nome ASC)` (every tipo-3 conta, active or not, so `ativo` is not in the query); the sweep's second pass reuses `avisos (resolvidoEm ASC, criadoEm DESC)`.
  - **Rulesets:** unchanged, verified rather than regenerated. The new subcollection is default-denied because no rule matches it, the new enums do not reach the generator, and `avisos` is server-owned. `gen:rules:check` and `gen:rules:e2e:check` must show no diff; a diff means something was registered by mistake.
  - **Env:** `ALLOWED_ADMIN_ORIGINS`, in `.env.example` + `apphosting.yaml`, because `proxy.ts` is its only reader.
- **Seam:**
  - **`core/contexto.ts`:** `loadLojaIntegradaContext(db, integracaoId, deps)` reads the `integracao` doc through `createCachedDocReader` (15-min TTL; an inactive conta is never served from the cache, so reactivation takes effect at once). The **credential read is uncached**, and the client re-reads it on every request: it carries the parking state, a new token is picked up mid-batch, and one read per call is cheap at D12 volume. The order is conta missing or wrong tipo ⇒ 404, `ativo === false` ⇒ `LiContaInativaError`, credential absent, corrupt or parked ⇒ its own refusal, so the conta stops importing, stock and price. The app errors do not extend the package's `LiError`, so a step-3 `catch (err instanceof LiError)` cannot swallow a parked-conta refusal. The client is built with the correlation-id header off (re-cut item 13). `lib/lojaIntegrada/**` takes `db` as a parameter and is Next-free, because step 3's functions bundle imports it.
- **Expiry (one threshold):**
  - `sweepLojaIntegradaTokenExpiry(db, deps)` (step 2) is wrapped in a daily `onSchedule` in step 3 → `escreverAviso` `lojaIntegradaTokenExpirando` at ≤ 30 days, which is when LI starts showing "Renovar". The save and renewal routes refresh it at once: they resolve it when the new expiry is more than 30 days away and re-raise it with fresh params otherwise. The aviso is keyed on the conta alone, so a new expiry date never mints a new row. Within the sweep, one conta's corrupt credential is contained and recorded without costing the other conta its warning.
  - The 401 park is the backstop; there is no second escalation tier.
  - The conta status route `GET /api/marketplace/loja-integrada/conta/[id]` reports `{configurado, expiraEm, diasParaExpirar, situacaoValidade, atualizadoEmMs, versaoCredencialUs, reconexaoPendente}`, never the token and never the park's ref. It is an explicit projection, never a spread of the document.
- **Parking on 401/403:**
  - Any `LiAuthError` marks `reconexaoPendente` and raises `lojaIntegradaReconexaoPendente` (`critico`).
  - **Intake while parked (step 3, not step 2):** the poller skips the conta without advancing its cursor, and intake tasks for a parked conta return a deterministic "conta parada" outcome (no retry). Both are safe because the un-advanced cursor re-reads every change once the token is restored. Step 3 also decides drop versus defer for tasks already enqueued when the token dies; the research recommends defer.
  - **Re-drive:** tasks that cannot be re-derived (step-7 write-backs, step-11 publish jobs) take the **deferred** disposition (#808 lane). In LI terms the lane exists because an expired token is a human-scale outage of hours to days, which retries cannot fix and which must not burn the retry budget. Saving a validated token clears the park and enqueues the conta's deferred docs (steps 3 and 7; the re-drive needs `notificacoesLojaIntegrada (status ASC, contaId ASC)`, which this plan did not declare). The shared deferred cap is 7 attempts (`MAX_TENTATIVAS_DEFERRED`), so the 14-day age cannot be met as written; the step-3 and step-7 plans settle it.
- **Rule 7:** parking is a **tier-1 precondition write** with a named guard (re-cut items 3 and 4), not a transaction, so it has no line in `firestore-transaction-inventory.test.js`. The ref derived from the stored token must equal the ref of the token that got the 401; otherwise a 401 from a token the operator has just replaced would park a healthy conta. The reconexão aviso is clocked by the credential document's commit time in µs (item 11); the one module that converts to µs is `lib/lojaIntegrada/avisos/avisos.ts`.
- **CI lane:** moved to step 3 (re-cut item 2), because step 2 has no emulator test. `ci-loja-integrada.yml` will follow the `changes`/`gate` pattern with `CI gate (loja-integrada)` / `CI scope (loja-integrada)`, and it is registered in `ci-lane-gates.test.js` `LANES` and `main-red-alert.yml`. The "lanes"/"pinnable checks" counts in root `CLAUDE.md` are updated. Pinning it in `protect-main` is a manual follow-up for Lucas. Firestore emulator ports come from the inventory (proposed 8085; the step plan checks).
- **Dry-run/valve:** none (no LI write).
- **Verification:**
  - The sweep warns at 29 days and stays silent at 31.
  - A 401 from a stale ref parks nothing, while one from the current ref does; a save or a delete landing between the park's read and write ends in no write.
  - Moved out: a parked conta's step-7 task is deferred and re-driven after a save (step 7), and its intake task returns without retry (step 3).
- **Timing:** before any LI-calling flow, which all read the context and can trigger a park. It lands with step 21's conta CRUD and credential form, so the connect route and its only caller land together. No token is saved before the window (D17).
- **Does NOT:** renew the token (no API exists; the renewal route only re-validates it and records the new expiry date); cache the credential; store the expiry on the `integracao` doc; edit `integracao.ts`; create the daily trigger, a queue, a pipeline or a CI lane (step 3).

### Step 2b: Structured logger + write valves + canary allow-list + dry-run diff + read-only probe CLI

- **Gate:** always. **Trigger:** library + CLI. **Docs:** D4.
- **Logger** (`core/log.ts`): one JSON line per LI call, with a Cloud Logging severity. Fields:
  - `conta`, `operacao`, `metodo`, `status`, `tentativa`.
  - `credencial`: the credential type the call ran under (always `'personal-token'` in this code). It is recorded so that evidence from this code is never mixed with the legacy's live proof under the other combination (§1.3).
  - `caminho`: ids kept, query values replaced by `<redacted>` unless allow-listed.
  - `codigoLimite` (533/633/133/null) and `latenciaMs`.
  - `correlationId`: the `x-correlation-id` we sent, plus the task/notification id.
  - `trechoCorpo`: ≤ 2 KB.
- **Redaction is an ALLOW-LIST, so it fails closed:**
  - For **pedido/cliente/envio/pagamento bodies**, only structural keys are kept: ids, `numero`, `codigo`, `situacao.*` codes, `status`, counts, `quantidade*`, prices and `valor*`, dates, `forma_envio.{id,code,codigo,tipo}`, `objeto`, sku. Every other value becomes `<redacted>`, including unknown keys, nested addresses and free text such as `observacao`.
  - **Catalogue bodies** (produto, preço, estoque, categoria, marca, grades) carry no personal data and are logged whole. They serve as the pre-write restore snapshot.
  - As a second layer, CPF/CNPJ/e-mail/phone/CEP regexes run over everything that survives.
  - The `Authorization` header is never logged.
- **Re-cut at implementation (PR 2b-a, logger and redaction; the step plan holds the detail):**
  - Step 2b ships as three stacked PRs: 2b-a logger and redaction, 2b-b capture sanitizer, 2b-c valves (§4.25, D17).
  - The logger adds `conta`, `fluxo`, `tentativa`, `idTarefa` and `idNotificacao` itself, because the package event has none of them. `correlationId` is logged together with `enviouCorrelationId`: today no call sends the header.
  - The credential is labelled `versaoCredencial`, the version suffix of its ref (one owner of the format: `core/refCredencial.ts`), never the ref and never its fingerprint.
  - The observer cannot be bypassed inside the app. The context loader always builds it itself (callers pass only `registro`), both credential routes pass it to the validating GET (`validarPersonalToken` gained an optional `onChamada`), and two `estrutura.test.ts` guards stop any other code from receiving the raw event and keep the logger's import closure away from the Admin SDK, the admin data layer and Next.
  - Four body classes, chosen from the path segment by segment: `estrutural` (spelled-out allow-list with a predicate per leaf; also the default for an unknown path), `configuracao` (`/v1/situacao`, `/v1/pagamento[/{id}]`, `/v1/envio[/{id}]`, keep-lists), `catalogo` (logged whole behind the regex layer) and `webhook` (never excerpted). Non-2xx bodies get an error walk that keeps only short, code-shaped values; mask first, cut to 2 KB second.
  - The excerpt fails closed where the token may echo back. A 401/403 is never excerpted on any path, and neither is any answer to the validating GET (a candidate credential): the package scrubs only the exact token sent, so a partial or escaped echo would otherwise reach the log. A `configuracao` 2xx that is not JSON is not excerpted either, because its keep-list exists for a reason.
  - Two profiles: `log`, and `fixture` for anything that reaches disk or git, which turns every refused value into a fake of the same JSON type and also fakes tracking codes, the pedido's external ids, configuration labels and cost (D17).
  - Bare 11- and 14-digit runs are masked only when their check digits are valid, and never on a value that passed an id, date or price predicate, because LI ids look the same.
  - The sink writes the JSON line itself (`process.stdout.write`): no new dependency, no lockfile change.
  - Spec coverage runs against a committed leaf inventory (paths and JSON types only, never values), generated by `li-doc.mjs folhas` from the public document's schemas and examples.
- **Valves:**
  - There is one env valve per write flow: `LOJA_INTEGRADA_MODO_ESTOQUE`, `_PRECO`, `_ANUNCIO` (publish/edit/pause/alias/images), `_RASTREIO` (tracking + situação) and `_WEBHOOK_REGISTRO`. Each is `off | dry-run | on`.
  - **Only the exact string `on` writes and `dry-run` diffs; anything else (unset, typo) is `off`.** That is the polarity that fails safe.
  - Valves are read at the use site, as the first statement.
- **Canary allow-list:**
  - `LOJA_INTEGRADA_CANARIO_<FLUXO>` is a comma-separated list of `<contaId>:<LI produto id | numero>`.
  - When it is set, `on` writes only to listed targets, and every other target behaves as `dry-run`. When it is unset, `on` applies to every target.
  - It is used only in the window (§5 item 8). Its tests: listed target writes; unlisted target dry-runs; malformed entry = not listed.
- **Dry-run:** build the exact payload, perform the read-only GET of LI's current state, and log `{payload, atual, diff}` per field. It writes nothing to LI **and nothing to the "sent" stamps in Firestore**, so turning `on` later still sends.
- **Read-back** after every real write: GET the resource, compare the fields written, and log `deriva` with both values. Persistent drift is left to the daily reconcile (steps 12–13).
- **Restore snapshot:** for catalogue writes, the pre-write GET body is logged at INFO level before the PUT. Rollback = re-PUT that body, by a person.
- **Probe CLI** `scripts/sondar.ts` (`pnpm --filter @delfrance/loja-integrada-app sondar --conta <id> GET /v1/...`):
  - It receives the read-only client type, so a non-GET cannot compile.
  - It reads the token from env (`.env.local` only) and never prints it. Output is redacted JSON.
  - Every capture records the credential type it ran under (`credencial: 'personal-token'`) beside the request line.
  - `--salvar` writes to a gitignored `.capturas/`.
  - `fixture` converts a capture into `lib/lojaIntegrada/fixtures/__wire__/`. The conversion runs through the **same allow-list** (non-allow-listed strings are replaced with obviously fake values such as `000.000.000-00`) plus a two-layer `piiScan.ts` (the Shopee precedent).
  - It is run by Lucas, or by an agent only with his explicit go for that session.
- **Firestore:** none. **Indexes:** none. **Rulesets:** none. **Env:** the five valves and five canary lists, in `.env.example`, `apphosting.yaml` and the functions env, all defaulting to unset ⇒ off.
- **Seam:** the `onChamada` hook from step 1.
- **Rule 7:** none (no Firestore write).
- **Verification:**
  - A redaction snapshot over the spec's own PII-bearing examples **plus a synthetic payload with unknown PII-bearing keys** (`destinatario`, `obs`, nested `endereco`), all of which must come out `<redacted>`.
  - A valve parsing table: `'on'`, `'ON'`, `' on'`, `'true'`, unset.
  - A canary table.
  - A dry-run produces zero LI writes; a fake transport asserts only GETs.
- **Timing:** before any write step, since each write step's code calls the valve. It also comes before probe round 1, which needs the CLI.
- **Does NOT:** send any write; commit any capture; keep the token anywhere but env and the credential store.

### Step 3: Poller (primary) + notification pipeline + Cloud Tasks queues

- **Gate:** `importarPedido`, `notificacoes`, P6. **Trigger:** `onSchedule` every 5 min → Cloud Task. **Docs:** `spec GET /v1/pedido/search`.
- **Wire:** `GET /v1/pedido/search?since_atualizado=<cursor − 120 s>&limit=50` (+ `offset` via `meta.next`). The search-then-detail pattern is **[live-proven, legacy credential]**; the details below are what the legacy does not prove:
  - `since_atualizado` is sent in the documented `AAAA-MM-DDTHH:MM:SS` form: seconds, no fraction, no offset.
  - `limit=50` is requested, but the page size actually used is the `meta.limit` read back. 50 is documentation-only until then; the legacy has only ever used 20 live (§1.2 item 10).
  - Next pages are rebuilt from `meta.next`'s query string against `/v1/pedido/search`, never followed verbatim. The trailing-slash form is the one the step-1 client already sends; `meta.next`'s form comes from capture C1 (§1.2 item 13, D17).
  - The overlap absorbs same-second ties and inclusive bounds.
  - Ordering is undocumented and never assumed, so the cursor advances only to `max(data_modificacao)` of a **fully drained** window.
  - **One drain loop with a time budget and no persisted continuation.** The poller only enqueues, so a 2-week backlog (~300 orders, ~6 pages at 50, ~15 at 20) drains in one run. If the budget or page cap (40 pages) is hit, the cursor does not advance, the next tick re-drains (idempotent), and an aviso is raised.
- **Synthetic notifications:** each row → `{contaId, numero, dataModificacaoUs, origem: 'poll'}`, enqueued onto the same queue the webhook uses. The cursor is written only after every row is enqueued or persisted (the Shopee lost-push ordering rule).
- **Firestore:**
  - **`pollPedidosLojaIntegrada/{integracaoId}`** is a bare const outside `ALL_DOMAINS` (`perms 0n`, no Meta ⇒ no `defaultQuery`). Fields:
    - `cursor`: a string, LI's naive São Paulo `AAAA-MM-DDTHH:MM:SS`, the value the API takes. Fixed width ⇒ lexicographic order = time order.
    - `emExecucaoAteMs` (ms), the single-flight lease.
    - `ultimaVarreduraEmMs` (ms).
    - `ultimoErro`, `.nullable().default(null)`.
  - **`notificacoesLojaIntegrada`** is failures-only (`notificationResilienceFields()`). `docIdOf = <contaId>:<numero>:<dataModificacaoUs | ->` goes through the doc-id guard.
    - **No collapse is claimed**: the webhook's `data_modificacao` is UTC with ms precision, while REST's is naive with µs precision.
    - Duplicates are harmless because the import is idempotent.
  - **Indexes:** `notificacoesLojaIntegrada (status ASC, processedAt ASC)` (new, for the reprocess sweep); the conta enumeration reuses `integracao (tipo ASC, ativo ASC)`.
  - **Rulesets:** regenerate both + snapshots (two new bare collections).
  - **Env:** `LOJA_INTEGRADA_POLL_LOOKBACK_H` (default 72), `LOJA_INTEGRADA_TASKS_DISABLED`, `LOJA_INTEGRADA_TASKS_REGION` (real value), in `.env.example`, `apphosting.yaml` and the functions env.
- **Seam:**
  - `defineNotificationPipeline` (enqueue-first; "deterministic outcomes RETURN, transient failures THROW"), `requireRegion`, and `tasksInvoker.ts` copied verbatim.
  - The nested `apps/loja-integrada/functions` codebase holds `processLojaIntegradaNotification`, `reprocessLojaIntegradaNotifications` (every 30 min), the poller and the daily `onSchedule` wrapper of the expiry sweep, whose body ships in step 2. Queue export names equal the queue constants.
  - `firebase.loja-integrada.tasks.json` (tasks emulator; ports from the inventory, proposed 5004/9501) and the `*.tasks.test.ts` suite run in the step-3 lane, which also adds the rule-4 carve-out line and the lane and pinnable-check count edits to root `CLAUDE.md`.
- **Bootstrap** (orchestrator call): if there is no cursor ⇒ `now − LOJA_INTEGRADA_POLL_LOOKBACK_H`. It is idempotent by the deterministic pedido id. The window sets it from the legacy gap (§5 item 7).
- **Dispositions:**
  - imported/unchanged → ack;
  - hub order → ack + flag (step 5);
  - conta parked → "conta parada" (no retry; step 2);
  - 404 → park the notification;
  - unknown codigo → imported as `error` + aviso;
  - `LiThrottleError`/5xx/network → throw (Cloud Tasks backoff).
- **Rule 7:** the cursor doc has **several possible writers**: an overlapping tick, a Cloud Task retry, a late older run.
  - **Single-flight:** a run takes the lease by `update({emExecucaoAteMs}, {lastUpdateTime})` only if the lease has expired.
  - **Advance-only:** the cursor is re-read and moved only forward, with `update(…, {lastUpdateTime: snap.updateTime})`. FAILED_PRECONDITION ⇒ re-read and retry once.
  - Both are **tier 1 (native precondition)**; no transaction, so there is no inventory line.
- **Queues and rates:** §4.23. **Dry-run/valve:** none (read-only).
- **Verification:**
  - Fixture-driven sweep tests: empty page, one page, page cap hit ⇒ cursor unchanged, a boundary order re-seen, cursor never moved backwards by a stale run, lease held ⇒ second run exits, rows out of `data_modificacao` order, a `meta.limit` smaller than requested, an `/api/v1` `meta.next` rebuilt against `/v1`.
  - §1.2 items 10, 11 and 13 are settled by the owner's capture C1 (under the Personal Token, D17) before merge.
  - **Live end-to-end (poll → task → import → pedido) is deferred to the window** (§5 smoke). There is no staging rehearsal (§7 q4, closed by D17).
- **Timing:** after P6 and step 2, since it reads the context and can park. It comes before step 5, which consumes its notifications.
- **Does NOT:** map anything (the task re-fetches); filter by situação (every changed order is imported); persist a continuation; follow `meta.next` verbatim.

### Step 4: Webhook receiver (accelerator) + registration route (used only at the window)

- **Gate:** `notificacoes: 'push'`, `assinaWebhook: 'sim'`, P6. **Trigger:** HTTP → Cloud Task. **Docs:** `spec tag Webhook Pedidos`, `spec PUT/DELETE /webhooks/v1/pedido`.
- **Receiver** `app/api/webhooks/loja-integrada/[contaId]/pedido/route.ts`:
  1. The conta comes from the **URL path**, followed by one uncached credential read.
  2. **Secret unset ⇒ 503. Header missing, or not `Bearer <secret>` ⇒ 401.** The compare is `timingSafeEqual` on equal-length buffers, and a length mismatch counts as a mismatch.
  3. The body is bounded (e.g. 256 KB). Only `numero`, `data_modificacao` and a boolean `hubHint` (`marketplace_info`/`id_anymarket` present) are parsed.
  4. Enqueue `{contaId, numero, dataModificacaoUs, origem: 'webhook', hubHint}` and answer 200 (LI's expected ack is undocumented).
  5. If the enqueue fails → `persistNotificationFailure` → still 200.

  **It never drops on `situacao_alterada=false`** (D13, overriding the tag's advice). The body is never mapped and never persisted.
- **Registration** `POST /api/marketplace/loja-integrada/conta/[id]/webhook` (`PERM.integracao.write`):
  - Mints ≥ 32 random bytes (base64url) and stores `{notifyUrl, token}` first.
  - Then calls `PUT /webhooks/v1/pedido` behind `LOJA_INTEGRADA_MODO_WEBHOOK_REGISTRO`.
  - Accepts https URLs only (`LOJA_INTEGRADA_PUBLIC_URL`, which is the custom domain if ADR 0013 Phase 0 step 7 landed).
  - `DELETE` re-sends the stored pair. Rotation = DELETE old, PUT new.
- **Firestore:** `credenciaisLojaIntegrada/current.webhookPedido` (step 2 schema). **Indexes:** none. **Rulesets:** none beyond step 2. **Env:** `LOJA_INTEGRADA_PUBLIC_URL`.
- **Seam:** `defineNotificationPipeline` (same queue as step 3).
- **Rule 7:** **tier 0**. The receiver writes nothing on the happy path, and the import is idempotent by the deterministic id. The secret write is operator-driven, last-write-wins.
- **Dry-run/valve:** `_WEBHOOK_REGISTRO`. Dry-run logs the PUT body with the token redacted. **There is no read-back**, because LI has no GET for registrations; verification is the first authenticated delivery (§5 smoke).
- **Verification:**
  - A 503/401/200 table.
  - A body with `situacao_alterada: false` is enqueued.
  - A spoofed conta path presented with the other store's secret gets 401.
  - Live delivery is first seen at the window. The legacy integration never used webhooks, so nothing about them is live-proven.
- **Timing:** last before step 22, since it is only an accelerator. Registration is a window step (P5).
- **Does NOT:** register the product webhook; trust the body field `token`; act as the only intake.

### Step 5: Order → pedido import (incl. inbound tracking)

- **Gate:** `importarPedido: 'sim'`, `consolidaPacote: 'nao'`, `dadosFiscaisSeparados: 'nao'`, `rastreio: 'pull'`. **Trigger:** Cloud Task (poll or webhook notification).
- **Docs:** `spec GET /v1/pedido/{pedido_id}`, `spec GET /v1/situacao_historico/search`, `spec tag Situações do pedido`, help 924633, help 912137.
- **Wire:** `GET /v1/pedido/{numero}` (always; **[live-proven, legacy credential]**) + `GET /v1/situacao_historico/search?numero=` (approval/cancellation dates; paginated).
- **Pedido fields:**
  - id = the deterministic digest (§3); `numero = String(numero)`.
  - `integracaoPedidoOuterRef = 'documents/integracao/<contaId>'`.
  - operação/filial/modalidade come from the conta.
  - `valorCobrado = valor_total`, `descontoTotal = valor_desconto`, `timestamp` = `data_criacao` (µs).
- **Watermark:**
  - Field `lastMarketplaceUpdate`, **µs**; the incoming `data_modificacao` (naive São Paulo, µs resolution) is converted by `dataLiParaMicros`.
  - **Null direction: a missing stored value ⇒ proceed** (no evidence; a first import or a migrated pedido without the stamp).
  - A stored value in another unit (the corpus may hold ms or s) goes through `coerceToMicros` before the compare.
  - Equal ⇒ `ignorado-sem-mudanca`; newer by 1 µs ⇒ apply.
  - The watermark advances on the write that wins.
- **Estado ladder (enumerated, by codigo):**

  | Codigo(s) | ERP estado |
  |---|---|
  | `pedido_efetuado` (9) | carrinho |
  | `aguardando_pagamento` (2), `pagamento_em_analise` (3) | aguardando confirmação de pagamento |
  | `pedido_pago` (4), `faturado` (1018), `em_producao` (17), `pedido_em_separacao` (15), `pedido_enviado` (11), `pronto_para_retirada` (13), `pedido_entregue` (14) | **pago** (the ceiling for every marketplace path) |
  | `pagamento_em_disputa` (6), `pedido_chargeback` (16) | stays `pago`; flagged contested + aviso; no auto-cancel, no restock |
  | `cancelamento_solicitado` (1019) | processando cancelamento (not terminal) |
  | `pedido_cancelado` (8) | `cancelado`, or `estornadoIntegralmente` if the history shows a prior approval |
  | `pagamento_devolvido` (7) | `estornadoIntegralmente` |
  | `pagamento_devolvido_sem_retorno` (1020) | `estornadoIntegralmente`, i.e. refunded per the help center: LI treats it as cancelled, the item does NOT return to LI stock, and the buyer is e-mailed (help 924633). Its id and flags come only from the legacy enum (§1.2 item 14) |
  | **any other codigo** | **`error` + aviso `lojaIntegradaSituacaoDesconhecida`** |

  The Phase-3 plan confirms the exact ERP estado names and the reservation release per row. **The table is frozen only after the `GET /v1/situacao` capture C3** (§1.2 item 14, D17) has confirmed 1020's id and flags on both stores. This table is also where a stale order that LI auto-cancels releases its reservation (§4.i, template 8).
- **Hub guard (D5):** if `id_anymarket` is non-null, any `pagamentos[].forma_pagamento.codigo === 'PAGAMENTOEXTERNO'`, or the receiver set `hubHint` ⇒ do not create a pedido; ack + aviso `lojaIntegradaPedidoHub`.
- **Cliente/endereço:**
  - documento = `endereco_entrega.cnpj ?? endereco_entrega.cpf ?? cliente.cnpj ?? cliente.cpf` (digits only, check-digit validated).
  - `ie`/`tipo` come from `endereco_entrega`; `isento` in any case → IE isento.
  - `findOrCreateCliente`.
  - An LGPD-anonymised name ("Alterado pela LGPD") never overwrites a captured identity.
  - Empty documents are tolerated: they raise a fiscal review flag, not a failure.
  - `makeEnderecoId`/`ensureEndereco` from `packages/data/src/admin/enderecos`; cMun from the CEP via `packages/data/src/admin/cmun.ts`.
- **Items:** `ensureUniqueId = String(item.id)`. The produto is resolved through **two distinct keys**:
  - (a) A URI string **without** `?id_externo` gives the **LI produto id**. It is converted to a number and looked up in the link docs by fields, never by a computed doc id (§3): collection group `produtolojaintegrada` where `contaLojaIntegrada == 'documents/integracao/<id>'` and `id == <number>`.
  - (b) The **object form** `{id_externo, resource_uri}`, or any URI carrying `?id_externo=1`, gives an **id_externo**, not the LI id. It is resolved by `itens[].sku`, scoped to the conta, through the promoted SKU cascade in `packages/data/src/admin/produtos`. If that fails, a read-only `GET /v1/produto/{id}?id_externo=1` yields the LI id, which then goes through (a).
  - `produto_pai` is tried next, then SKU.
  - An unmatched line keeps `produtoUid: null` and is surfaced, never dropped.
  - Prices follow the discount-spreading rule (§3), and money goes through `roundReais`.
- **Freight and inbound tracking:**
  - **Mapa auto-registration** goes through step 20's helper.
  - **Target matching at import uses the full `'<id>---<code>'`** and requires the mapa entry's `integracaoUid` to be set (parity; §3).
    - Target `melhorEnvios`: `freteInicial` points at the TARGET `int_frete`, with `externalOptionId = targetData.id`.
    - Target `motoboy` / `retiradaNaLoja`: the target is set without an option.
    - Any other target: aviso, no failure. `freteInicial` stays on the conta's `lojaIntegrada` `int_frete`, and label time resolves it (step 15).
  - **Unmapped:** `freteInicial` is built from the per-conta `EnviosLojaIntegrada` (step 20), with `externalOptionIntegracao: 'lojaIntegrada'`.
  - **In every case:** `externalId = envios[i].id`, `externalOptionData = forma_envio` (GET shape), `valorCobrado = envio.valor`, `dataPrevisaoEntrega = data_criacao + prazo` days.
  - `codRastreio = objeto`, with `''` → null.
  - Estado is `aguardandoPostagem` if a code exists, else `iniciado`; it is promoted to `despachoAutorizado` once `pago`.
  - `prazoDespacho` comes from `horarioDeCorte` (`getPrazoDespachoNoFuso`), else the noon rule.
  - **Multiple `envios[]`:** the first one drives `freteInicial`, and the rest are logged and raise an aviso (§7 q6).
- **Firestore:**
  - `pedidos`, `pagamentos` (step 6), `clientes`, `enderecos`, `int_frete.mapa` (via step 20).
  - **Indexes:** collection group `produtolojaintegrada (contaLojaIntegrada ASC, id ASC)` (new); `int_frete (tipo ASC, contaLojaIntegradaEnviosOuterRef ASC, ativo ASC)` (new); SKU fallback reuses `produtos (sku ASC)` / `(sku ASC, paiId ASC)`.
  - **Rulesets:** regenerate both + snapshots (new `TIPO_AVISO` values: `lojaIntegradaSituacaoDesconhecida`, `lojaIntegradaPedidoHub`, `lojaIntegradaPedidoContestado`, `lojaIntegradaMultiEnvio`, plus one for an unsupported freight target, named in the step plan).
  - **Env:** none.
- **Seam:** `findOrCreateCliente`, `@delfrance/core/wire`, the promoted SKU cascade, `getPrazoDespachoNoFuso`.
- **Rule 7:** a **class-B transaction**. The GETs run outside it. Inside, the watermark is re-derived from `tx.get`, every written value is derived from that snapshot, and the watermark advances on the winning write. Inventoried.
- **Dry-run/valve:** none (no LI write).
- **Verification:**
  - Mapper tests over redacted spec-example fixtures and captures:
    - **both `produto` shapes**, including the id_externo case resolved by SKU and the URI case converted to a number;
    - multi-pagamento and hub orders;
    - every codigo, including 1020 and an unknown one;
    - `objeto: ''`.
  - Freight near-misses: a full `'<id>---<code>'` match with `integracaoUid` set routes to the target; the same id with a different code is not matched at import; a matched entry with `integracaoUid` unset is treated as unmapped; an unsupported target raises an aviso and does not fail.
  - Watermark near-misses: equal stamp ignored; one µs newer wins; null stored ⇒ proceeds; ms-unit stored value compared correctly.
  - The `orderIds.test.ts` vectors.
  - §1.2 item 14 is settled by capture C3 before merge (D17).
  - **Live import is first seen at the window.**
- **Timing:** after step 3 (its producer) and step 20 (the mapa helper and the int_frete doc it reads).
- **Does NOT:** map the webhook body; write any order-level field back to LI; consolidate orders; keep a status echo on the pedido (D2).

### Step 6: Payments (inline)

- **Gate:** `importarPagamento: 'sim'`. **Trigger:** the same Cloud Task as step 5 (no extra LI call). **Docs:** `spec GET /v1/pedido/{pedido_id}`, `spec GET /v1/pagamento`.
- **Wire:** none beyond step 5's GETs.
- **Mapping:** one `pedidos/{id}/pagamentos/{sha256("integracao/<contaId>-<pagamentos[].id>")}` per `pagamentos[]` entry; iterate, never take `[0]`.
  - `valor` = `valor`.
  - Forma by `pagamento_tipo` + `forma_pagamento.codigo` (§3; the pix and `pagamento_banco` handling is **[legacy-observed, unverified]**, pinned by §1.2 item 22 before merge).
  - Parcelas, and card `{bandeira, cAut = authorization_code}` when present.
  - **Status comes from the order codigo** (pending / em análise / aprovado / contested / cancelado / devolvido; the table is fixed in the step plan). Dates come from the situação history.
  - The spec has no fee, net, interest or settlement field, so none is derived.
  - `valor_pago` may be null (the webhook example shows null on an approved order) and is never the paid signal.
- **Firestore:** `pedidos/{id}/pagamentos/{digest}`. **Indexes:** none (writes by id). **Rulesets:** none. **Env:** none.
- **Seam:** `@delfrance/core/wire`, `roundReais`.
- **Rule 7:** class-B, in the same transaction family as step 5.
  - The per-pagamento watermark is `ultimaModificacao` in **µs**.
  - **Null direction: missing stored ⇒ proceed**, the payments convention. It is consistent with the pedido.
  - A legacy-unit value goes through `coerceToMicros`.
  - Equal ⇒ no write.
- **Dry-run/valve:** none.
- **Verification:**
  - Fixtures: a pix order with `parcelamento: {}` (a **[legacy-observed]** shape, replaced by the redacted real capture from §1.2 item 22 once available), a card with installments, and a null `valor_pago` on an approved order.
  - Watermark near-misses as in step 5.
- **Timing:** with step 5 (the same transaction).
- **Does NOT:** call `/v1/pagamento*` for transactions (it is the method catalogue); build a settlement sweep.

### Step 7: OUTBOUND status write-back (D7). Inbound tracking is in step 5

- **Gate:** D7 (the outbound direction has no caps field). **Trigger:** Firestore `onDocumentCreated` on `pedidos/{id}/historicoFtIni/{h}` for LI pedidos → a Cloud Task **named by `h`**, which dedups.
- **Docs:** `spec PUT /v1/pedido_envio/{pedido_envio_id}`, `spec PUT /v1/situacao/pedido/{pedido_id}`, `spec GET /v1/pedido/{pedido_id}`, help 924633.
- **Mapping (freight estado → LI):**
  - `postado` with a code → `PUT /v1/pedido_envio/{envios[i].id} {objeto}` **and** `PUT /v1/situacao/pedido/{numero} {codigo: 'pedido_enviado'}`.
  - `postado` without a code → `pedido_enviado`.
  - `entregue` → `pedido_entregue`.
  - `aguardandoRetirada` → `pronto_para_retirada`.
  - anything else → no write (logged, never thrown).
- **E-mail assumption:** every write to 11, 13 or 14 may e-mail the buyer. Whether an API PUT fires LI's mailer is undocumented, and `notificar_comprador` is only a hint (§1.2 item 15). The guards below exist to keep that to one e-mail per real transition.
- **Guard read:** a single **`GET /v1/pedido/{numero}`**, which carries both `situacao.codigo` and `envios[].id`/`envios[].objeto`. The guards it feeds:
  - **Never-write-onto set:** the current codigo ∈ {6, 7, 8, 16, 1019, 1020} ⇒ no write + aviso. D7's binding list is {6, 7, 8, 16, 1020}; adding 1019 is an orchestrator call (vetoable, §2.1).
  - current == target ⇒ skip (no duplicate buyer e-mail).
  - Never regress `pedido_entregue` to `pedido_enviado`.
  - LI `objeto` already non-empty and different from ours ⇒ do not overwrite; log + aviso.
  - `envios[i].id` comes from `freteInicial.externalId`, stored at import.
- **Read-back:** `GET /v1/pedido/{numero}` → compare `objeto` and situação, and log any drift.
- **Firestore:** reads `pedidos/{id}` and the history doc; writes nothing. **Indexes:** none. **Rulesets:** none. **Env:** `LOJA_INTEGRADA_MODO_RASTREIO`, `LOJA_INTEGRADA_CANARIO_RASTREIO` (step 2b).
- **Seam:** the step-2 deferred lane for a parked conta (these events cannot be re-derived).
- **Rule 7:** **serialised** (§4.23). All LI writes run on the writes queue with `maxConcurrentDispatches: 1`, so no two write-back tasks run their check-then-act at the same time. The task name = the history doc id dedups redelivery.
  - Two history docs racing (e.g. `postado` and `entregue` created close together, executed in either order): whichever runs second reads LI's state after the first one's write. If `entregue` ran first, the `postado` task skips the situação by the no-regress guard and still writes the tracking code if `objeto` is empty.
  - The residual risk is a painel edit landing between the guard GET and the PUT. That is **tier 3 (tell the human)**: the read-back logs the drift and raises an aviso.
- **Dry-run/valve:** `_RASTREIO`. Dry-run logs the two payloads beside the current LI situação/objeto. **Rollback:** a situação write cannot be undone silently, since it may e-mail the buyer; a mistaken one is corrected by hand in the painel. A tracking code is restored by re-PUTting the logged prior `objeto`.
- **Verification:**
  - The transition table, including every codigo in the never-write-onto set (1019 included).
  - A retried task after success performs zero PUTs.
  - Out-of-order `entregue`/`postado` produces no regression.
  - **The live write is first done on a canary pedido at the window** (§5 item 8); fixtures cannot confirm the e-mail behaviour (§1.2 item 15).
- **Timing:** after step 15, whose postings create the history docs, and after step 2b's valves.
- **Does NOT:** write `faturado`, paid or cancelled situações; upload NF-e (D8); use Enviali tracking.

### Step 8: DROPPED (template stuck-reservation release; see §4.i)

An earlier draft had a daily stale-pending re-check here. It is dropped under D2:
- The durable poll cursor (with overlap, not advanced while parked) already carries LI's own auto-cancellation of stale orders to step 5.
- No concrete failure the cursor misses was found.

### Step 9: Product import + link (existing LI products → ERP)

- **Gate:** `importarAnuncio: 'sim'`. **Trigger:** HTTP (start) + a resumable Cloud Task job. **Docs:** `spec GET /v1/produto`, `spec GET /v1/produto/{produto_id}`, `spec GET /v1/{produto_preco}`, `spec GET /v1/produto_estoque`.
- **Wire:**
  - `GET /v1/produto` pages give the parents (with `filhos`, which is documented in examples only).
    - **`removido` is always passed explicitly**, because the default listing may include trashed products (§1.2 item 24). The step plan decides whether trashed products are also listed, to flag them.
    - The declared filters are only `sku`, `ativo`, `data_modificacao__gte` and `data_modificacao__lte`. `removido`, `data_criacao` and `__lt`/`__gt` are prose-only. There is no `tipo` or `pai` filter, so parents are told from children by the rows' `tipo`.
  - `GET /v1/produto/{id}?descricao_completa=1` is called per parent **and per child listed in `filhos`**. The importer never relies on children appearing as list rows (§1.2 item 19); if a capture shows they do, the per-child GETs are skipped for rows already seen.
  - Prices and stock come in bulk from `GET /v1/{produto_preco}` and `GET /v1/produto_estoque` pages, not per child.
  - `GET /v1/marca/{id}` / `/v1/categoria/{id}` (or the `/set/` GETs) are cached per job.
- **Modes** (parity subset; the final list is §7 q2):
  - **link only**: writes link docs and touches no ERP field.
  - **completar**: fills empty ERP fields.
  - Optional photo import and price/stock import.
  - Each row gets a SKU match proposal. Kits never get LI stock written into an ERP estoque.
- **Firestore:**
  - **`importacoesLojaIntegrada/{jobId}`** is a bare const, admin-only, with a continuation. A task handles ≤ N families, then re-enqueues itself with a delay (the Shopee mass-import precedent). There is one job per conta.
  - **Link docs** `produtos/{id}/produtolojaintegrada/{LI id}`: import-created links keep the legacy convention (doc id = `String(LI produto id)`). Because export-created links use auto ids (§3), every reader still finds links by field query (`contaLojaIntegrada` + `id`), never by that doc id. `contaLojaIntegrada` is written as `'documents/integracao/<contaId>'`. `lojaIntegradaLink.ts` is typed, with `estadoPublicacao` limited to the eight codes.
  - **Photos** go through `@delfrance/storage/admin` (create-first `Arquivo`, `https://cdn.awsli.com.br/{caminho}`).
  - **Category links** under `categorias/{id}/categorialojaintegrada` now carry `contaLojaIntegrada`, and legacy docs without it are read tolerantly.
  - The `produtos.marketplace[]`/`marketplaceIds` denorms are not written.
  - **The `integracoesComProduto` anchor trigger** (step 12's `onProdutoLojaIntegradaLinkChanged`) **ships in this step**, with the first link writer.
  - **Indexes:** `importacoesLojaIntegrada (integracaoId ASC, status ASC)` (new); collection group `categorialojaintegrada (contaLojaIntegrada ASC, id ASC)` (new); collection group `produtolojaintegrada (contaLojaIntegrada ASC, id ASC)` (from step 5).
  - **Rulesets:** regenerate both + snapshots (new collection, typed link schema, `categorialojaintegrada.contaLojaIntegrada`).
  - **Env:** none.
- **Seam:** `@delfrance/storage/admin`, `contaJobs` (web), `packages/data/src/admin/produtos/integracoesComProduto.ts`.
- **Rule 7:** link-doc writes are **class-B**, guarded by the stored LI `id`: null → set; a different non-null id → conflict, never overwrite. Inventoried.
- **Dry-run/valve:** none toward LI (read-only). A `--simular` mode lists what would be linked or created in the ERP.
- **Verification:**
  - Fixtures with a family, a simple product, a removed product, and a child with `nome: null`.
  - Near-miss: the same SKU on two contas links separately.
  - A link-lookup test over a corpus with both doc-id kinds (an import-created `String(id)` doc and an export-created auto-id doc) finds both by field query.
  - §1.2 items 10, 19 and 24 are settled by the owner's captures before merge (D17).
  - Live import is first run at or after the window. There is no staging rehearsal (§7 q4, closed by D17).
- **Timing:** after step 10 (the category and grade reads it maps against). It comes before 12/13/11, which need link docs and the anchor.
- **Does NOT:** create ERP categories automatically unless the mode asks; import `bloqueado` products as publishable; compute a link doc id.

### Step 10: Categories, brands, grades + the variation-linker data

- **Gate:** `categoriasEAtributos: 'sim'`, `variacoes: 'sim'`. **Trigger:** HTTP (cached). **Docs:** `spec GET /v1/categoria`, `spec GET /v1/marca`, `spec GET /v1/grades`, `spec GET /v1/grades/{grade_id}`.
- **Wire (read-only):**
  - `GET /v1/categoria` (tree via `categoria_pai`).
  - `GET /v1/marca`.
  - `GET /v1/grades` (store + system grades).
  - `GET /v1/grades/{grade_id}` (options with `/api/v1/grade/{g}/variacao/{v}` URIs).
- **Firestore:**
  - `grupoDeVariacoes.linksVariacoesli` is typed: `name`, `grade_id: int`, `integracaoLiId: string`, `variationOptions[{li_option_id: int, li_option_name, arakene_variation_id: string[]}]`, `.passthrough()`. The field name is the corpus's own and is already public in `packages/schemas/src/produto/collection/shopeeLinkVariacoes.ts`, whose typing is the precedent.
  - A uniqueness rule (one option per variante per link) is enforced by the linker UI and validated at publish.
  - **Indexes:** none; reads by doc id from the web linker.
  - **Rulesets:** regenerate both + snapshots (the typed `grupoDeVariacoes` field).
  - **Env:** none.
- **Seam:** routes `GET /api/marketplace/loja-integrada/conta/[id]/{categorias,marcas,grades}` behind `createReadCache` (with a TTL; a transactional read is never cached).
- **Rule 7:** the linker writes `grupoDeVariacoes` from an interactive form ⇒ **tier 3 (tell the human)**. A save conflicts on `lastUpdateTime`, and the conflict is surfaced, never dropped silently.
- **Dry-run/valve:** none (read-only toward LI).
- **Verification:** schema tests over legacy-shaped docs (ints as numbers, `arakene_variation_id` as a list, extra keys kept); a uniqueness near-miss (same option on two variantes rejected, two options on two variantes accepted); the routes over spec-example fixtures.
- **Timing:** before step 9 (import maps categories) and step 11 (publish needs the links).
- **Does NOT (parity, D2):** create categories, brands, grades or options through the API; the operator creates them in the LI painel and maps them. There is no attribute schema to model.

### Step 11: Publish / edit / pause (parent + children)

- **Gate:** `publicarAnuncio`, `variacoes`, `pausarAnuncio`, `tabelaDeMedidas: 'nao'` (workaround). **Trigger:** HTTP ("Enviar") → Cloud Task on the writes queue.
- **Docs:** `spec POST /v1/produto`, `spec PUT /v1/produto/{produto_id}`, `spec PUT /v1/produto/{produto_id}/alias`, `spec POST /v1/produto_imagem`, `spec DELETE /v1/produto_imagem/{produto_imagem_id}`, help 5195150.
- **Wire, in order:**
  1. The parent: `POST /v1/produto` (tipo `normal`, or `atributo` + `grades`), or GET-merge-PUT if it exists.
  2. Each child: `atributo_opcao`, `pai`, `variacoes` from `linksVariacoesli`.
  3. Per child, the **publish-time price and stock through the SAME functions steps 12 and 13 use** (one function each, never a second copy).
  4. Images.
  5. Read-back.

  The job is resumable: every created LI id is written to its link doc immediately.
- **GET-merge-PUT:**
  - Start from `GET /v1/produto/{id}?descricao_completa=1`.
  - The PUT body is built from the **PUT request-schema field set**, echoed from the GET: `altura, apelido, ativo, bloqueado, categorias, data_criacao, data_modificacao, destaque, imagem_principal, imagens, largura, marca, nome, pai, peso, profundidade, ncm, gtin, mpn, removido, sku, tipo, url_video_youtube, usado`.
  - ERP-owned fields are overlaid on that echo, plus `grades` (parent), `variacoes` (child) and `descricao_completa` (§1.2 item 2).
  - Only keys absent from that schema are stripped: `id`, `resource_uri`, `url`, `seo`, `filhos`, `tags`, `preco_*`, `estoque_*`, and body `id_externo` (whether to send it is a step-11 plan decision). Any other departure from the schema set is a step-11 plan decision verified by the read-back.
  - **NCM/GTIN/MPN** are preserved from the GET unless the ERP has a value (GTIN on children).
  - `apelido` is echoed from the GET, never regenerated. The URL changes only via `PUT /v1/produto/{id}/alias {absolute_path}` with `replace_main=true` (409 "Slug already in use." is surfaced). On create, the slug is transliterated or omitted (step plan).
- **Dimensions are validated, not defaulted:** a missing peso/altura/largura/profundidade (kg/cm) refuses the publish with a clear message.
- **Duplicate-SKU adoption:** `LiIntegridadeError` on POST ⇒ `GET /v1/produto?sku=` ⇒ adopt the existing product into the link doc ⇒ PUT.
- **Client-side limits (help-center panel guidance, not API contracts):** ≤ 50 variations per product, ≤ 50 images per product, and grades that cannot be removed once linked (help 5195150). API enforcement is undocumented, so the publisher enforces them before any call. Adding a grade to an already-published parent is refused with a clear message.
- **Images (sync only when the ERP photo set changed):**
  - The link doc keeps a hash of the last sent photo list. If it is unchanged, there are no image calls.
  - When it changed: `POST /v1/produto_imagem {imagem_url, produto, principal, posicao, mime}` for the missing ones, from public storage URLs. The first image is `principal: true` with `posicao: 0`.
  - `DELETE` is called **only** for images the ERP no longer has, or as needed to stay within the client-side **50-image cap**. Each deleted image's URL is logged so it can be restored.
  - Order: the first photo of each child, then the parent's photos, then the size chart's first photo last (parity). There are no per-variation image links. The variation-image endpoints exist, but their path-id semantics are undocumented, so nothing is built on them.
- **Size-chart parity** (orchestrator call): the chart text is appended to `descricao_completa` between stable markers. A missing chart publishes without it and logs.
- **Pause/resume:** GET-merge-PUT with `ativo` flipped on the parent **and every child**, because the parent→child cascade is undocumented (§1.2 item 17). A family pause therefore costs 1 + N GET-merge-PUTs (≈ 2 + 2N calls), serialised on the writes queue.
  - `removido` is echoed, never set. `removido=true` is the API's only soft-delete lever, probably the panel lixeira, but that is unproven (§1.2 item 24).
  - `bloqueado` is echoed, never set, and a `bloqueado: true` read is surfaced as a provider state.
- **Firestore:**
  - Link docs (LI ids, `estadoPublicacao`, the photo-list hash), found by field query (§3).
  - **Indexes:** collection group `produtolojaintegrada (contaLojaIntegrada ASC, id ASC)` (step 5).
  - **Rulesets:** none beyond step 9.
  - **Env:** `_ANUNCIO` valve and canary (step 2b).
- **Seam:** steps 12/13's quantity and price functions; `@delfrance/storage/admin` URLs.
- **Rule 7:**
  - Every produto-body write runs on the **writes queue with `maxConcurrentDispatches: 1`**, so the GET-merge-PUTs are serialised.
  - Link docs are class-B on the stored LI id.
  - **A painel edit between our GET and our PUT is overwritten:** **tier 3 (tell the human)**. The window is the in-task merge time. The pre-write GET body is logged as the restore point, and the read-back logs drift on fields the ERP does not own.
- **Dry-run/valve:** `_ANUNCIO`. Dry-run runs the GETs and logs each body plus the field diff, including images to add and delete; it writes nothing. **Rollback:** re-PUT the logged pre-write body; re-POST logged image URLs.
- **Verification:**
  - Payload builders are tested against the `cadastrar_produto_pai`/`_filho` examples and the `alterar_produto*` field set.
  - The client-side 50-variation and 50-image caps are validated before any call.
  - A pause of a family with N children issues 1 + N PUTs.
  - **Not checkable read-only:** full-replace semantics, persistence of `descricao_completa`/`variacoes`/`grades`, the parent `ativo` cascade, and the duplicate-SKU shape (§1.2 items 1, 2, 17, 21). None of the catalogue writes is live-proven. The first real write is an **edit of a canary product that is inactive, or freshly created with `ativo=false`**, and its read-back is reviewed before the flow widens (§5 item 8).
- **Timing:** after steps 9, 10, 12 and 13, whose links and functions it uses.
- **Does NOT:** create grades/categories; delete products (no DELETE exists); set `removido`; send per-variation images.

### Step 12: Stock sync (event-driven deltas + daily reconcile)

- **Gate:** `estoque.suporte: 'sim'`, `protocolo: 'por-anuncio'`, `loteMax: null`, `multiDeposito: 'nao'`, `kitVirtual: 'nao'`. **Trigger:** change-driven Cloud Tasks + one daily `onSchedule` reconcile per conta + HTTP (manual push, row action).
- **Docs:** `spec PUT /v1/produto_estoque/{produto_id}`, `spec GET /v1/produto_estoque`, `spec tag Estoque`, help 924633, help 912137, LI's older Apiary document (reservation formula only).
- **Wire:**
  - `PUT /v1/produto_estoque/{child produto_id} {gerenciado: true, quantidade, situacao_em_estoque: 0, situacao_sem_estoque: -1}` (D9; `quantidade` integer ≥ 0). **D9 is binding.** Reviewer's caution: the forced `situacao_em_estoque`/`situacao_sem_estoque` overwrite any per-product lead-time settings in LI by design.
  - Event-driven writes are read back with `GET /v1/produto_estoque/{produto_id}`.
  - The reconcile reads `GET /v1/produto_estoque` pages (no filters exist), enqueues PUTs for differing rows only, then reads the pages again as its bulk read-back.
- **The plan core is IO-free.** The quantity and diff logic is pure. It reuses the promoted core in `packages/data/src/admin/estoque` (`quantidades.ts`, `politica.ts`, the `ledger.ts` contract) **without forking it**: LI injects its own `FetchMovimentosDaJanela` beside its query, as ML does.
- **Change detection (D12, no tiers):** only SKUs whose ERP sellable quantity changed. The step plan picks one of two shapes **by measured scan cost (#785)**:
  - (i) The ledger change window on a short tick: a pipeline aggregate over `historicoEstoque`, reusing the existing collection group index `historicoEstoque (timestamp ASC, parentId ASC, depositoOuterRef ASC)`, with the anchor pre-filter reusing `produtos (paiId ASC, integracoesComProduto ASC, __name__ ASC)`.
  - (ii) A Firestore trigger on the estoque write, which needs no query index.

  Either way, the anchor `produtos.integracoesComProduto array-contains <contaId>` keeps non-LI produtos out. If the measured shape needs a composite not listed here, the step plan declares it before merge.
- **Durable cursor + continuation:**
  - `sincEstoqueLojaIntegrada/{integracaoId}` (bare const, admin-only) holds:
    - `janelaDesdeMs` (ms; the frozen window start) and `janelaAteMs` (ms);
    - `continuacao: {ultimoProdutoId}`, `.nullable().default(null)` (keyset);
    - `reconcile: {offset, iniciadoEmMs (ms)}`, `.nullable().default(null)`.
  - A truncated window, or a reconcile of 25+ pages, **resumes** from the stored continuation and never restarts.
  - Cursor writes are **tier 1** (`update` with `lastUpdateTime`), advance-only.
- **Quantity:** ONE function shared with publish (step 11), computed **at send time**, not baked into the task.
  - The base is the conta depósito's available quantity, clamped at 0.
  - ERP kits = the min over limiting components of ⌊disponível/qtd⌋ (ADR 0014; kits are ordinary LI products).
- **Reservation decision (in the step plan; §1.2 item 3, §7 q5).** What LI documents, by source:
  - **Formula:** `quantidade_disponivel = quantidade − quantidade_reservada`, with `quantidade` meaning gross on-hand. Both come from LI's older official Apiary document. Every current-spec stock example has `quantidade_reservada = 0`.
  - **Which statuses reserve:** help 924633 reserves on Pedido Efetuado, Aguardando Pagamento and Pagamento em Análise. Help 912137 limits reservation to Aguardando Pagamento and Pagamento em Análise. Both require `gerenciado = true`. Per 912137's example, a reservation is lost if an order moves out of a pending status and back.
  - **When stock leaves and returns (help 924633):** it LEAVES on Pedido Pago, Pedido Entregue, Em Produção, Em Separação and Pronto para Retirada. It RETURNS on Pedido Cancelado, and on Pagamento Devolvido only when that status is set manually. `pagamento_devolvido_sem_retorno` (1020) does not return it.

  Pick one model and never mix them:
  - (A) Send `quantidade = ERP sellable + LI quantidade_reservada`, read just before the PUT. This is serialised by the writes queue, and drift is logged by the read-back.
  - (B) Send on-hand and let LI do the reserving, with the ERP not reserving LI orders still awaiting payment.
- **The anchor:** `onProdutoLojaIntegradaLinkChanged` (a Firestore trigger on `produtos/{id}/produtolojaintegrada/{doc}`) maintains `produtos.integracoesComProduto` through `integracoesComProduto.ts` (`contaDoLink` reads the tolerant ref forms). It **ships with step 9**. A false negative here is a silent stock outage.
- **Parity skip:** `statusProdutosMarketplace['<contaId>_<id>'].enviarEstoque === false` is honoured read-only (the step plan confirms).
- **Firestore:**
  - The cursor doc above.
  - **Indexes:** as listed under change detection; the reconcile has no Firestore query beyond the anchor.
  - **Rulesets:** regenerate both + snapshots (new bare collection).
  - **Env:** `_ESTOQUE` valve and canary.
- **Seam:** the promoted estoque core; `integracoesComProduto.ts`.
- **Rule 7:**
  - The send path is **serialised**: one writes queue with `maxConcurrentDispatches: 1`, and the value is derived at send time. A later-running task therefore always reads ERP state at least as fresh as an earlier one, and two PUTs for the same produto can never interleave.
  - A guard test pins the queue's concurrency at 1.
  - **Residual:** an ERP change that produces no task (a trigger miss) is bounded by the **daily reconcile: ≤ 24 h**.
- **Deliberately NOT sent, with the number:** a component movement is **not** eagerly propagated to the kits that contain it. ADR 0014 measured ~2000 writes per sale for that propagation on ML and rejected it. The daily reconcile is the backstop ⇒ **an LI kit's quantity may be stale by up to ~24 h** after a component moves on another channel. Whether that is acceptable is §7 q7. A scoped alternative (only LI-linked kits containing the moved component, via the existing `produtos (componentesKitKeys CONTAINS)` index) would be costed in the step plan only if Lucas asks.
- **Dry-run/valve:** `_ESTOQUE`. Dry-run logs the body plus LI's current row (incl. `quantidade_reservada`/`disponivel`). **Rollback:** re-PUT the logged prior `quantidade`, or flip the valve off and let the reconcile restore it.
- **Verification:**
  - Core quantity tests reuse the promoted suites, byte-unedited.
  - Reconcile diffing with negative LI stock and with `gerenciado: false` rows, which read back as all zeros and are not "zero stock".
  - A continuation resume test (truncated at page 13 of 25 ⇒ resumes at 13).
  - A cursor advance-only test.
  - **Merge gate:** the scan cost is measured per #785 and recorded in the step's PR.
  - **Not checkable read-only:** LI's behaviour when `quantidade` is rewritten with pending reservations. Stock writes are not live-proven under either credential. The first real write is a canary SKU (§5 item 8).
- **Timing:** after step 9 (links + anchor) and step 2b.
- **Does NOT:** tier sweeps; batch (none exists); send to a parent `atributo`; read the product webhook; propagate kit components eagerly.

### Step 13: Price sync

- **Gate:** `enviarPreco: 'sim'`. **Trigger:** change-driven Cloud Tasks (price-list changes) + daily reconcile + HTTP (a manual push, or an account-wide "Atualizar preços" in no-lower mode).
- **Docs:** `spec PUT /v1/produto_preco/{produto_id}`, `spec GET /v1/{produto_preco}`, `spec GET /v1/produto_preco/set/{produto_id}`, `spec GET /v1/produto/{produto_id}`.
- **Wire, event-driven (per child; 3 calls):**
  1. `GET /v1/produto/{child id}`: one read gives `removido`/`bloqueado` AND `preco_*`.
  2. Skip `removido`/`bloqueado`.
  3. `PUT /v1/produto_preco/{child id} {cheio, custo, promocional, sob_consulta}`, a full body:
     - `cheio` = the normal list.
     - `promocional` = the promotional list value when > 0; **else the "cleared" wire value chosen from the §1.2 item 16 capture** (D10).
     - `custo` = the ERP cost (parity, orchestrator call, §7 q1).
     - `sob_consulta` echoed from LI, never set.
  4. The PUT echo AND a read-back GET are compared with normalised decimals. **Both `null` and `0.00` count as a cleared promotion.**
- **Wire, bulk pushes and the reconcile (no per-child GETs):** the guard and the merge base come from `GET /v1/produto` pages (list rows carry `removido`/`bloqueado`; `removido` is passed explicitly, §1.2 item 24) and `GET /v1/{produto_preco}` pages, or `/v1/produto_preco/set/{produto_id}` once its max is probed. The read-back is the same list read again.
- **No-lower mode** **[ERP rule]**: refuse a `cheio`/`promocional` lower than LI's current value unless the caller allows lowering. A manual per-product push allows it; an account-wide push does not.
- **Price function:** one function shared with publish (step 11), computed at send time per child.
- **Firestore:**
  - The reconcile state shares the `sincEstoqueLojaIntegrada`-style cursor doc. The step plan decides between one doc with two sub-objects and a sibling `sincPrecoLojaIntegrada/{integracaoId}` (fields in ms, tier 1 updates).
  - **Indexes:** the price-list change detection reuses the queries the promoted preço code already declares; the step plan names them before merge.
  - **Rulesets:** regenerate both + snapshots if a new collection is added.
  - **Env:** `_PRECO` valve and canary.
- **Seam:** the ERP price-list readers.
- **Rule 7:** **serialised**, like step 12: writes queue at concurrency 1, value derived at send time. The residual is bounded by the daily reconcile (≤ 24 h).
- **Dry-run/valve:** `_PRECO`. **Rollback:** re-PUT the logged prior `cheio`/`promocional`/`custo`.
- **Verification:**
  - Decimals as strings and as numbers.
  - The promo-clear path accepts both cleared representations on read-back.
  - No-lower refusal.
  - Near-miss: `"10.00"` equals `10`; `"10.01"` is different.
  - **Not checkable read-only:** whether the chosen clear value is accepted. Price writes are not live-proven under either credential. The first real write is a canary SKU, including one promo clear (§5 item 8).
- **Timing:** after step 9; before step 11, which reuses its function.
- **Does NOT:** schedule time-boxed promotions (LI has no promo dates); touch LI store-level promotions or coupons.

### Step 14: NF-e upload. **DROPPED by D8**

`enviarNfe: 'sim'` is a provider fact (`spec POST/PUT /v1/integration/pedido/nf`: metadata + URLs, `sale_number` = numero, `account_key` in the multipart body). Nothing is built.

### Step 15: Labels: `int_frete.mapa` routing + checkout paid re-check + `FREIGHT_TIPO_CAPS.lojaIntegrada`

- **Gate:** `etiqueta: 'emit'` + D6. **Trigger:** HTTP (the `/pedidos` etiqueta row action and checkout). **Docs:** `spec GET /v1/situacao/pedido/{pedido_id}`; the `freight-integrations` skill, step 5.
- **Which pedidos this touches:**
  - A pedido whose `freteInicial` resolves to a non-`lojaIntegrada` `int_frete` (e.g. `melhorEnvios`) uses that provider directly. That covers every migrated pedido whose method was already mapped at import, and new pedidos mapped at import (step 5). They need no change.
  - Only pedidos whose `freteInicial` carries tipo `lojaIntegrada` (unmapped at import) go through the resolver below.
  - Today the repo has no mapa / `integracaoTargetOuterRef` resolution in the etiqueta path; `integracaoTargetOuterRef` appears only in `packages/data/src/pedido/duplicar.ts` and a seed fixture. This step builds it.
- **Target resolution at label time** (`apps/web/lib/checkout/etiqueta`), in order:
  1. `freteInicial.integracaoTargetOuterRef` (the per-pedido override).
  2. Otherwise, the conta's `int_frete.mapa` entry whose `idOriginal` id part (before `---`) equals `String(externalOptionData.id)` **and** whose `integracaoUid` is set. The code part is ignored at label time (parity). Import-time matching, by contrast, uses the full `'<id>---<code>'` (step 5).
  3. Otherwise, abort with "sem mapeamento" ("Este frete não possui mapeamento com transportadora.").
  - The resolved target dispatches exactly like a first-class carrier: Melhor Envio buy/print with `externalOptionId` from `targetData.id`, or the generic label for motoboy/retirada/outros.
- **`FREIGHT_TIPO_CAPS.lojaIntegrada` must change.** Today it has `marketplaceOwned: true`, all `can*` false and `labelMode: 'fetch'`, which makes the Frete tab read-only and routes the etiqueta to `unsupportedMarketplace`. That is wrong for LI: LI mints nothing, the operator must be able to pick or override the target carrier, and the row state must come from the **resolved target's** caps. What changes, in one change:
  - `marketplaceOwned` → false.
  - `labelMode` → a non-`'fetch'` value. The exact value, or an explicit "router" notion in `etiquetaRowState`, is the step-15 plan's call.
  - `lojaIntegrada` leaves `unsupportedMarketplace.ts` in the same change, and a routing provider is registered.
  - `frete.test.ts` (which pins LI among the five marketplace-owned tipos) and `registry.test.ts` change together.
  - **The freight-integrations skill's step 5 checklist governs the change:** caps flip, provider + registry row, client threading, UI capability, row-action branch and drift guard, all landed together.
- **Checkout paid re-check:** `GET /api/marketplace/loja-integrada/pedidos/[numero]/situacao?conta=` → `GET /v1/situacao/pedido/{numero}`.
  - Paid ⇔ codigo ∈ {pedido_pago, faturado, em_producao, pedido_em_separacao, pedido_enviado, pronto_para_retirada, pedido_entregue}.
  - Contested, refunded (incl. 1020), cancelled or 1019 ⇒ refuse.
  - An LI error lets the operator continue only after an explicit confirmation (parity).
- **Firestore:** reads `pedidos`, `int_frete`. **Indexes:** `int_frete (tipo ASC, contaLojaIntegradaEnviosOuterRef ASC, ativo ASC)` (step 5). **Rulesets:** none (`FREIGHT_TIPO_CAPS` is not a Meta; checked). **Env:** none.
- **Seam:** `lib/checkout/etiqueta/types.ts` (injected clients and UI capabilities), `resolverIntFrete`.
- **Rule 7:** none new; the ME purchase follows the freight domain's own guards.
- **Dry-run/valve:** none toward LI (read-only).
- **Verification:**
  - Routing table: a non-`lojaIntegrada` `int_frete` is used directly; override wins; mapa match on the id part with `integracaoUid` set; the same id with a different code still matches at label time; an entry with `integracaoUid` unset does not match; no match aborts with "sem mapeamento".
  - Paid re-check table, including 1019, 1020 and an LI error.
  - Live re-check at the window.
- **Timing:** after step 5 (the `freteInicial` it routes) and step 20 (the mapa); before step 7 (its postings feed the write-back).
- **Does NOT:** Enviali (D6); fetch any LI label (none exists); rewrite migrated pedidos that already point at a target `int_frete`.

### Steps 16–19: DROPPED (see §4.24)

- 16 chat (`perguntas`/`mensagensPosVenda: 'nao'`).
- 17 claims (`reclamacoes: 'nao'`; step 5's codigo table handles them).
- 18 size charts (`'nao'`; parity workaround in step 11).
- 19 kits (`'nao'`; ERP-computed in step 12).

### Step 20: `int_frete` sync (the per-conta `EnviosLojaIntegrada` doc + mapa)

- **Gate:** `etiqueta !== 'nenhuma'` + D6. **Trigger:** the Firestore trigger `onIntegracaoLojaIntegradaChanged` (integracao create/update/delete, tipo 3), in the ML `intFreteSync.ts` shape. **Docs:** the `freight-integrations` skill.
- **Wire:** none (no LI call).
- **Behaviour:**
  - Materialise or deactivate the `int_frete` doc of tipo `lojaIntegrada`.
  - **Adopt** the migrated legacy doc by its `contaLojaIntegradaEnviosOuterRef` back-reference instead of creating a second one.
  - **Mapa auto-registration helper** (called by step 5): append `{nomeOriginal: '<nome> - <tipo trimmed>', idOriginal: '<id>---<code>', observacao: 'Origem: Pedido <numero>', integracaoUid: null}` **only when the id part is absent**; zero writes when it is present. Consequence: an order whose code differs from the mapped entry's is imported unmapped (step 5 matches the full `'<id>---<code>'`), and step 15 still resolves it at label time by the id part.
- **Firestore:**
  - `int_frete`. `intFreteSchema` gains `contaLojaIntegradaEnviosOuterRef` (`.nullable().default(null)`, server-owned, like ML's).
  - **Indexes:** `int_frete (tipo ASC, contaLojaIntegradaEnviosOuterRef ASC, ativo ASC)` (new; ML's has an extra `dataCadastro DESC` and is not reused).
  - **Rulesets:** regenerate both + snapshots (`intFreteSchema`).
  - **Env:** none.
- **Seam:** the ML `intFreteSync.ts` pattern.
- **Rule 7:**
  - The trigger is watermarked against the event time (**tier 2**). The unit (the trigger event's time, converted to µs) is stated beside the field in the step plan, with a near-miss test (an equal event is ignored, a later one applies, an ms-unit stored value compares correctly).
  - The mapa helper is a **class-B transaction** that re-reads `mapa` inside `tx.get`. Inventoried.
- **Dry-run/valve:** none.
- **Verification:**
  - An adopt-vs-create test (legacy doc adopted, no duplicate).
  - Mapa append idempotence (same id twice ⇒ one entry; a different code with the same id ⇒ no new entry).
  - Out-of-order trigger events.
- **Web** (with step 21):
  - **The "Mapeamento do Frete" editor is NEW work.** Each row maps one LI shipping method to a target integration plus, for Melhor Envio, a service. No mapa editor exists in `apps/web` today: `apps/web/app/(app)/logistica/_components/slices.ts` deliberately excludes `mapa` from every screen.
  - **The "Horário de Corte" editor reuses** the existing `apps/web/app/(app)/logistica/_components/HorarioCorteEditor.tsx`.
  - **Placement is decided (§7 q8, 2026-10-07):** both editors are tabs of the LI conta screen `/canais/loja-integrada/[id]`, "Mapeamento do Frete" and "Horário de Corte", as in the legacy.
  - **Targets:** import routes only melhorEnvios, motoboy and retiradaNaLoja targets (step 5). fob and outros remain selectable for label-time routing; at import they raise the step-5 aviso without failing.
- **Timing:** before step 5, which reads the doc and calls the helper.
- **Does NOT:** register anything at LI.

### Step 21: `apps/web`: register, do not copy

- **Gate:** derived from the caps row (row actions are gated off `estoque.suporte`, `enviarPreco` and `pausarAnuncio` via `apps/web/lib/marketplace/caps/`, never off "a provider file exists"). **Trigger:** the UI surfaces below, landing with the step whose backend they call. **Docs:** the skill's "`apps/web` half".
- **Conta CRUD `/canais/loja-integrada`** (lands with step 2: PR W1 the screens, PR c the credential panel):
  - Replace `CanalCapsPanel` with `TableView`/`ObjectView` on `integracaoSchema` (`queryParams: { tipo: 3 }`).
  - No `CAMPOS_POR_CANAL.lojaIntegrada` entry: its totality test fails only when `integracaoSchema.shape` gains a key, which step 2 does not do.
  - The **credential form** (token + expiry; write-only, never displayed).
  - A status panel (expiry, days left, reconexão pendente) via `useLojaIntegradaClient` (`NEXT_PUBLIC_LOJA_INTEGRADA_URL`).
- **Produto LI tab + "Enviar"** (step 11): **no `MercadoLivreTab` fork.** The LI tab is a thin LI-specific component over shared primitives. Whether anything is extracted is decided in the step-21 plan, with the second channel's needs in hand.
- **The variation linker** on `grupoDeVariacoes` (step 10) and **the import screen** (step 9) are new LI-specific surfaces, with their job cards via `contaJobs` (`useContaJobFan`, a `describe<Job>StartError` beside the client).
- **Row/bulk actions:** one provider file plus one `PROVIDERS` row in `lib/marketplace/{estoque,preco,anuncioStatus}/registry.ts`. `caps/registriesAlinhadas.test.ts` requires them before `implementado` flips.
- **Frete tab:** the target selector (`integracaoTargetOuterRef`) for LI pedidos (step 15).
- ⚠️ **`apps/web` calls the DEPLOYED backend, even in local dev.** `call<T>()` already validates its response against a schema (the earlier note that it casts is stale), but each web PR still names the backend version it needs, and the UI tolerates an older backend: it feature-probes, never assumes. The Loja Integrada client also refuses to send from an `https:` page to a plain `http:` base URL, because the PUT body carries the store's token.
- **Firestore:** `integracao` via the existing Meta.
  - **Indexes:** the TableView update-monitor query on `integracao` with `tipo == 3` reuses `integracao (tipo ASC, nome ASC)` / `(tipo ASC, dataCadastro DESC)`, whichever the meta's `defaultQuery` orders by. This is verified by `defaultQuery.indexes.test.ts` in the step-21 PR.
  - The new LI collections have no Meta, hence no `defaultQuery`.
  - **Rulesets:** none beyond the backend steps.
  - **Env:** `NEXT_PUBLIC_LOJA_INTEGRADA_URL` in `apps/web` `.env.example` + `apphosting.yaml`.
- **Seam:** `TableView`/`ObjectView`, the `PROVIDERS` registries, `contaJobs`, `lib/checkout/etiqueta/types.ts`.
- **Rule 7:** the credential form is operator-driven and last-write-wins. The linker is tier 3 (step 10).
- **Dry-run/valve:** none in the UI. Valve state is server-side, and the UI shows a "modo" badge read from the status route.
- **Verification:**
  - Unit tests per provider (gating off caps).
  - `registriesAlinhadas` stays green.
  - e2e: `canais-loja-integrada.vendas.e2e.spec.ts` on the `canais-shopee` model, a staging `.vendas.` spec (not an emulator one), with the backend stubbed by `page.route` where the cases need it.
  - Live UI first at the window.
- **Timing:** each surface lands with its backend step.
- **Does NOT:** fork ML/Shopee tabs; add an `OrigemConversa`; gate any action on a provider file's existence.

### Step 22: Deploy isolation, guard rosters, flip `implementado`

- **Gate:** every `'sim'` built. **Trigger:** none.
- **Firestore:** none. **Indexes:** none new. **Rulesets:** none. **Env:** the functions env file completed.
- **Deploy configs:**
  - `firebase.loja-integrada.deploy.json`: functions block only, codebase `loja-integrada`, predeploy preflight + `prepare-deploy.mjs`, no firestore/storage keys. It is inert until a human runs it.
  - The `tools/deploy-env/preflight.mjs` row.
- **Guard rosters:**
  - `apphosting-next-pinned` (`KNOWN_APPHOSTING_APPS`) and `next-firestore-external` (`KNOWN_NEXT_APPS`) were done in step 1 PR b, with the app.
  - `runtime-deps-pinned` (the functions `package.json` with exact `firebase-admin`/`firebase-functions`).
  - `tasks-invoker-inventory`.
  - `functions-region-supplied` (`REGION_COMMANDS`, `KNOWN_BUILDERS`).
  - `firestore-transaction-inventory` (final check). `integration-response-numbers-tolerant` was extended in step 1 PR a; `http-client-timeout-ceiling` has no row for the package-only client.
- **Docs and layout:** `apps/loja-integrada/functions/DEPLOY.md` (IAM: enqueuer + invoker for both the App Hosting and the functions runtime identities). The root `CLAUDE.md` layout lines (":3000–:3010", the app bullet) and the app counts landed with the app in step 1 PR b.
- **Flip `implementado: true`** once every `'sim'` that is built has its web provider (`registriesAlinhadas`), and `enviarNfe` is documented as dropped by decision.
- **Verification:** all guard suites green; `registriesAlinhadas` green with `implementado: true`.
- **Timing:** last code step, before the window.
- **Does NOT:** deploy anything (window steps, §5); create the CI lane (step 3 did).

### 4.23 Request budget and queues (D12 volumes, per store, 100 req/min = 6,000 req/h)

| Flow | Calls | Per day (per store) |
|---|---|---|
| Poll, idle | 1 list call / 5 min | 288 |
| Order intake | ~3 observed changes × 20 orders × (detail GET + history GET); webhook duplicates may double the detail GETs | 120–240 |
| Status write-back | posting (guard `GET /v1/pedido` + tracking PUT + situação PUT + read-back GET = 4) + delivery (GET + PUT + GET = 3) | ~140 |
| Stock deltas | per changed SKU: PUT + read-back GET (+1 GET under reservation model A); assumes ≤ 200 SKU movements/day across all channels, to be measured | 400–600 |
| Price deltas | per child: GET + PUT + read-back GET (3); rare | ≤ 50 |
| Daily reconcile | estoque + preço list pages (500 rows: 25 + 25 at `limit` 20, 5 + 5 at 100), diff PUTs, list read-back | 60–110 |
| **Steady total** | | **≈ 1,000–1,400/day ≈ 45–60/h ≈ 1 % of the bucket** |

**Queues (decided; numeric values are starting points the step-3 plan confirms):** two Cloud Tasks queues, shared by both stores, **each with `maxConcurrentDispatches: 1`**.
- **Pacing:** an in-task pacer spaces LI calls. Because each queue runs one task at a time, the pacer is global per queue.
- **Reads queue** (`filaLeituraLojaIntegrada`): intake tasks, import-job tasks and reconcile reads, at **≤ 30 calls/min**.
- **Writes queue** (`filaEscritaLojaIntegrada`): every LI write and its guard/read-back GETs (steps 7, 11, 12, 13, 4-registration), at **≤ 60 calls/min**. Concurrency 1 here is what makes the stock/price/status writes **serialised** (Rule 7 in steps 7, 11, 12, 13).
- **Combined budget:** ≤ 90 calls/min **even if every call hits one store**, under that store's 100/min. The per-IP (1,200/min) and per-application (3,000/min) buckets are unreachable.
- **Retries:** `minBackoff 10 s`, `maxBackoff 300 s`. `LiThrottleError` THROWS, so Cloud Tasks backs off, and the log line carries the code.
- **Guard test:** a test pins both queues' concurrency at 1.

**Bursts:**

| Burst | Calls | Duration at the queue's pace |
|---|---|---|
| Full stock push (500 SKUs; bulk mode reads back by list, not per SKU) | 500 PUTs + 25 list pages ≈ 525 | ≈ 9 min (writes queue) |
| Full price push (bulk mode: list reads as guard/merge base and as read-back) | 500 PUTs + ~50 list pages ≈ 550 | ≈ 9–10 min. A per-child event-driven push would be 3 calls/child ≈ 1,500 calls ≈ 25 min, so bulk pushes always use list mode |
| Whole-catalogue import | ≈ 25 list pages + ≤ 650 detail GETs (parents + per-child via `filhos`) + 50 price/stock pages ≈ 725 | ≈ 24 min (reads queue). Order intake interleaves, because each job task is bounded and re-enqueues |
| Publishing one family of 6 children with 8 photos | ≈ 35–45 calls | |
| Pausing one family of N children | ≈ 2 + 2N calls (GET-merge-PUT per member) | |

### 4.24 Dropped steps, with the `'nao'` or decision that dropped them

| Step | Dropped by | Note |
|---|---|---|
| Pack consolidation (template step 5's `consolidaPacote`) | `'nao'` | One pedido → N envios; never merge orders. |
| Template 4 delivery backstop / missed-feed replay | no replay feed exists in LI; D13 | The durable poll cursor (step 3) is the guarantee. |
| Template 8 stuck-reservation release | D2 + help 912137 | LI auto-cancels stale orders; the poll carries the change to step 5 (§4.i). |
| 14 NF-e upload | D8 | `enviarNfe: 'sim'` stays as a fact. |
| 16 Chat / Q&A / post-sale | `perguntas: 'nao'`, `mensagensPosVenda: 'nao'` | `origensConversa: []`; no `OrigemConversa` value. |
| 17 Claims / returns | `reclamacoes: 'nao'` | Refunds/disputes/cancel requests are situação codes handled by step 5. |
| 18 Tabela de medidas | `tabelaDeMedidas: 'nao'` | Description + last-image workaround in step 11. |
| 19 Kits virtuais | `kitVirtual: 'nao'` | ERP-computed quantity in step 12. |
| Sweep tiering | D12 | Deltas + one daily reconcile. |
| Static egress / partner key | D3 (subject to the Step-0 gate) | Personal Token only; the legacy client's key is never reused. |
| `pedido.marketplace` status echo | D2 | No reader; step 7 reads LI live. |

**Deferred by decision:**
- the product webhook (orchestrator call);
- Enviali quote/bill/print/tracking (D6);
- NF-e and DC-e links (D8);
- per-variation images (parity; the endpoints' path-id semantics are also undocumented);
- the product side of LI's hub and `POST /v1/integration/sales` (D5, the reverse direction);
- creating grades/categories/brands through the API (parity);
- `PUT /v1/pedido/{numero} {id_externo}` (not needed).

### 4.25 Execution order to reach cutover parity (stacked draft PRs; each step's Phase-3 plan approved first, D15)

1. **PR 0:** this master plan + evidence (#1811), opened together with the tracker #1812 and the step issues (D14).
2. **Step 0:** P1–P6. The IP-binding gate and the token format were settled live on 2026-10-07, when the legacy moved to Personal Tokens. No probe token is needed (D17); what remains is the owner's `GET /v1/situacao` capture C3.
3. **Step 1a** (#1813): caps row + registry test flips.
4. **Step 1** (#1814): package + guard change + package docs (PR a); bare app scaffold + rosters and counts (PR b).
5. **Steps 2 + 2b** (#1829, #1815):
   - Five stacked PRs (re-cut item 9): W1 the step-21 conta CRUD; a the schemas, enums and admin handle; b the backend (`proxy.ts`, `verifyCaller` and Admin init moved from step 1, the credential routes, store, context, park, avisos and the sweep body); c the credential panel; d the migration script, as a sibling. The CI lane is **not** in step 2 (it is step 3's).
   - Step 2b (#1815) is three stacked PRs on step 2's PR b: **2b-a** logger and redaction, **2b-b** capture sanitizer, **2b-c** valves and canary lists (D17).

   ⇒ **Captures, per step** (D17): the owner captures the listed read-only production responses himself, under the Personal Token, each recording its credential type, and keeps them outside the repository; the step-2b sanitizer converts them into committed fixtures. They settle §1.2 items 3 (read part, if a pending order exists), 10, 11, 13, 14, 16 (read part), 18, 19, 20, 22, 23 and 24, each before the step that depends on it.
6. **Step 3** (#1830): poller + pipeline + queues (+ tasks emulator config).
7. **Step 20** (#1826): int_frete sync + mapa helper (step 5's freight mapping depends on it).
8. **Steps 5 + 6** (#1817, #1818): order/payment import (PR a: ids, mappers, fixtures; PR b: wiring). The estado table is frozen only after the §1.2 item 14 capture (C3).
9. **Step 15** (#1825): label routing + checkout re-check + `FREIGHT_TIPO_CAPS`.
10. **Step 7** (#1819): status write-back (valve OFF).
11. **Step 10** (#1821): categories/brands/grades reads + typed linker data (+ the web linker), typing `arakene_variation_id` on the `shopeeLinkVariacoes.ts` precedent.
12. **Step 9** (#1820): product import + link + the link-doc anchor trigger (+ the web import screen).
13. **Step 12** (#1823): stock (valve OFF) (+ the estoque row action).
14. **Step 13** (#1824): price (valve OFF) (+ the preço row action).
15. **Step 11** (#1822): publish/edit/pause (valve OFF) (+ the produto LI tab and the anuncioStatus row action).
16. **Step 4** (#1816): webhook receiver + registration route (registration only at the window).
17. **Step 22** (#1828): deploy isolation, guard rosters, flip `implementado`.
18. **The window** (§5), with the legacy app OFF. Step 21 (#1827) ships piecewise with steps 2, 9, 10, 11, 12, 13 and 15.

### 4.26 LI write inventory (every write → valve → dry-run → read-back)

None of these writes is live-proven under the Personal Token (§1.3); each one's first real write is a canary in the window.

| LI write | Step | Valve (+ canary list) | Dry-run diff against | Read-back | Restore |
|---|---|---|---|---|---|
| `PUT /v1/produto_estoque/{id}` | 12 (+11) | `_ESTOQUE` | `GET /v1/produto_estoque/{id}` | same GET (bulk: list pages) | re-PUT the logged prior quantity |
| `PUT /v1/produto_preco/{id}` | 13 (+11) | `_PRECO` | `GET /v1/produto/{id}` `preco_*` (bulk: list pages) | `GET /v1/produto/{id}` (bulk: list) | re-PUT the logged prior preço |
| `POST /v1/produto` | 11 | `_ANUNCIO` | duplicate-SKU `GET /v1/produto?sku=` | `GET /v1/produto/{id}?descricao_completa=1` | set `ativo=false` (no DELETE exists) |
| `PUT /v1/produto/{id}` | 11 | `_ANUNCIO` | `GET /v1/produto/{id}?descricao_completa=1` | same GET | re-PUT the logged pre-write body |
| `PUT /v1/produto/{id}/alias` | 11 | `_ANUNCIO` | current `apelido`/`url` from the GET | same GET | re-PUT the logged prior path |
| `POST /v1/produto_imagem` | 11 | `_ANUNCIO` | `GET /v1/produto_imagem?produto=` | same GET | `DELETE` the new image |
| `DELETE /v1/produto_imagem/{id}` | 11 | `_ANUNCIO` | lists the images to delete, with URLs | `GET /v1/produto_imagem?produto=` | re-POST the logged URL |
| `PUT /v1/pedido_envio/{envio id}` | 7 | `_RASTREIO` | `GET /v1/pedido/{numero}` `envios[]` | same GET | re-PUT the logged prior `objeto` |
| `PUT /v1/situacao/pedido/{numero}` | 7 | `_RASTREIO` | `GET /v1/pedido/{numero}` `situacao` | same GET | manual correction in the painel (the buyer may be e-mailed) |
| `PUT /webhooks/v1/pedido` | 4 | `_WEBHOOK_REGISTRO` | payload only (no GET exists) | none possible; the first authenticated delivery (§5 smoke) | `DELETE` with the stored pair |
| `DELETE /webhooks/v1/pedido` | 4 | `_WEBHOOK_REGISTRO` | payload only | none possible | re-`PUT` the stored pair |

The connect route's `GET /v1/categoria?limit=1` is not a write. No other LI write exists in the plan.

---

## 5. Migration-window items (rule 8: surfaced, NOT done)

Each item below becomes an issue **only after Lucas says yes to opening it**. That is a separate yes from approving this plan's PR (D14 covers only the tracker and the step issues). Each issue is labelled `needs-migration-window` + `task:ops-deploy` and linked from **#1208**, in ADR 0013 phase order. Agents never run any of these.

1. **Production Personal Tokens + expiry entered in production.**
   - **Phase:** generated in ADR 0013 Phase 0, by the owner in each store's painel. These are **new tokens for the new integration** (D16), never the legacy's. They are entered in Phase 3, after the `apps/loja-integrada` backend is live.
   - **Action:** the owner generates the token. A person with `PERM.integracao.write` saves token + painel-shown expiry through `/canais/loja-integrada` (which calls `PUT …/conta/[id]/credencial`).
   - **Verify:** the status route shows `configurado: true` and the right `diasParaExpirar`; the validating GET is logged 2xx.
   - **Why the timing:** tokens are per store and owner-only, the 3-month clock starts at generation, and the production project only exists at the window.
2. **Remove the legacy credential field from the migrated LI `integracao` docs.**
   - **Phase:** Phase 2, right after the Firestore import and before Phase 3 traffic.
   - **Action:** a one-shot `tools/migrations` script (written in step 2's PR, following that package's contract) applies `FieldValue.delete()` to that field on every `integracao` doc that carries it, whatever its tipo (the field is not modelled and nothing reads it, so any presence is an exposed credential), in dry-run first, then for real. Each row logs the tipo and the doc id, never the value, and a second pass reports zero.
   - **Verify:** a census query returns 0 docs carrying the field.
   - **Why the timing:** the new code never reads it, and the credential lives in the admin-only store. The legacy app reads the legacy project, not the migrated copy, so nothing in the new project needs it. Since 2026-10-07 that field carries the legacy's Personal Token, so the migrated copy holds a live credential until item 10 revokes it.
3. **Valves: `dry-run` first, then `on`, only after the legacy app is OFF.**
   - **Phase:** Phase 4.
   - **Action:** per flow, set `LOJA_INTEGRADA_MODO_<FLUXO>=dry-run` in the functions env + App Hosting env and redeploy/rollout; review a day of dry-run diffs in Cloud Logging. Then set the canary list (item 8), then `on`, then clear the canary list.
   - **Verify:** the log query `jsonPayload.operacao=<fluxo>` shows `dry-run` diffs, then real writes, each with a clean `deriva`.
   - **Why the timing:** there must be no dual writer to the LI store. Two writers of stock, price and situação flap the storefront and send duplicate buyer e-mails.
4. **Register each store's order webhook.**
   - **Phase:** Phase 3 step 4 (re-register provider URLs), after the receiver holds the secret.
   - **Action:** with `_WEBHOOK_REGISTRO=on`, call `POST …/conta/[id]/webhook` per conta (fresh ≥ 32-byte secret; `LOJA_INTEGRADA_PUBLIC_URL` = the custom domain if Phase 0 step 7 landed).
   - **Verify:** the next LI order change produces an authenticated delivery (log `origem: 'webhook'`, status 200). If LI refuses the registration for a Personal-Token store, the integration runs poll-only and that is recorded.
   - **Why the timing:** registration is a write, and the production URL exists only after the deploy.
5. **Deploy in order.**
   - **Phases:** indexes (Phase 0 step 3) → `firestore.rules` (Phase 0 step 4) → the `loja-integrada` functions codebase (Phase 3 step 1; it provisions queues, schedules and triggers) → `apps/loja-integrada` App Hosting with the real `LOJA_INTEGRADA_TASKS_REGION` (Phase 3 step 2) → `apps/web` (Phase 3 step 2).
   - **Commands:** `firebase deploy --only firestore:indexes --project <new>`; `firebase deploy --only firestore:rules --project <new>`; `firebase deploy --config firebase.loja-integrada.deploy.json --project <new>`; App Hosting rollouts for `loja-integrada` and `web`.
   - **Verify:** indexes READY in the console; the queues are listed in Cloud Tasks; `/api/health` answers 200.
   - **Why the timing:** on Enterprise a missing index full-scans and bills instead of failing; an enqueue against a queue that does not exist yet is dropped while the route answers 200; `apps/web` calls the deployed backend.
   - **Rulesets deployed:** those regenerated by steps 3, 5, 9, 10, 12, 13 (if a collection was added) and 20. Step 2 regenerates none: its credential subcollection is default-denied.
  - **Env at rollout (step 2):** the `apps/loja-integrada` rollout must set `ALLOWED_ADMIN_ORIGINS` (without it the backend allows no origin and every browser call fails CORS), and the `apps/web` rollout must set `NEXT_PUBLIC_LOJA_INTEGRADA_URL` to an `https:` origin (without it the credential panel stays disabled and says the backend is not configured).
   - **Indexes declared by this plan:**
     - `notificacoesLojaIntegrada (status, processedAt)`;
     - collection group `produtolojaintegrada (contaLojaIntegrada, id)`;
     - `int_frete (tipo, contaLojaIntegradaEnviosOuterRef, ativo)`;
     - `importacoesLojaIntegrada (integracaoId, status)`;
     - collection group `categorialojaintegrada (contaLojaIntegrada, id)`;
     - plus any composite the step-12/13 plans add after measurement. The reused existing ones are named in those steps.
6. **Verify the `integracoesComProduto` anchor for migrated LI links.**
   - **Phase:** Phase 4, before item 3's `on`.
   - **Action:** a one-shot read-only census script (`tools/migrations`) lists produtos whose LI link doc exists but whose anchor lacks the conta; a backfill only for the gaps, run by a person. The census finds link docs by field query, since their doc ids are mixed (§3).
   - **Verify:** the census re-run returns 0.
   - **Why:** an import fires no triggers. A gap is invisible to stock and price discovery, which is a silent outage.
7. **Seed the poll cursor by look-back.**
   - **Phase:** Phase 3 step 1 (set before the functions deploy).
   - **Action:** read the newest legacy `integracao/{contaId}/pedManager` `lastTimeStamp` per conta (from the export or the legacy console). Set `LOJA_INTEGRADA_POLL_LOOKBACK_H` = hours since the **older** of the two, + 24 h margin. If the legacy import stops early for any reason, for example an unrenewed legacy token (§0), this look-back covers the gap the same way.
   - **Verify:** the first poll run logs a `since_atualizado` at or before that timestamp, and every LI order in the painel since then has a pedido.
   - **Why:** the look-back is idempotent by the deterministic ids, and it runs after the legacy app is off so no later legacy write supersedes it.
8. **First live writes, one flow at a time, on canaries.**
   - **Phase:** Phase 4, inside item 3.
   - **Action:** set `LOJA_INTEGRADA_CANARIO_<FLUXO>` to one target per conta:
     - stock: one SKU;
     - price: one SKU, **including one promo clear**;
     - anúncio: one product that is **inactive or freshly created with `ativo=false`**;
     - rastreio: one pedido already posted.
   - **Verify:** each read-back is reviewed (full-replace semantics, `descricao_completa`/`variacoes`/`grades` persisted, promo cleared, buyer e-mail behaviour) before the canary list is cleared.
   - **Why:** there is no demo store, so these are the first writes this code ever makes, and several semantics (§1.2 items 1, 2, 15, 16, 17, 21) cannot be checked any other way.
9. **Intake smoke (read-only).**
   - **Phase:** Phase 4.
   - **Action:** watch one real LI order flow poll → task → pedido (and webhook → task once item 4 is done).
   - **Verify:** the pedido id equals the deterministic digest, items are linked, the payment is mapped, and `freteInicial` is routed.
   - **Why:** fixtures cannot prove the NEW code's live read path. The legacy's live use of Personal Tokens (§1.3) proves the endpoints and the credential, not this code.
10. **Revoke the legacy app's Personal Tokens.**
   - **Phase:** Phase 4, after the legacy app is switched off **and** after the new integration's first calls succeed with its own tokens (item 1).
   - **Action:** the owner opens each store's painel (Configurações > Chave para API) and uses **Remover** on the legacy's tokens only, identified by the label they were created with. The new integration's tokens stay.
   - **Verify:** the new integration's next poll still answers 2xx, and nothing else in the operation depends on the removed tokens.
   - **Why the timing:** removing them earlier stops the live legacy while it is still the sole writer of the LI store. Keeping them after the window leaves a live credential in the legacy project and in the migrated copy of the legacy credential field (item 2). Revocation makes both inert.

---

## 6. Definition of ready: checklist

- [x] Caps row with no `'desconhecido'`; every `'sim'` cites a spec operation/tag or help article (§1).
- [x] Documentation provenance verified (§1.0), and the live-proven vs spec/code-only split recorded (§1.3).
- [x] Template → LI step mapping explicit (§4.i); every dropped step listed with the `'nao'` or decision that dropped it (§4.24).
- [x] `estoque.protocolo` decided: `'por-anuncio'` (one PUT per child), not `'feed-assincrono'`, so no submission record is needed.
- [x] `assinaWebhook: 'sim'` with its LI meaning written in the row, and the receiver fails closed (step 4).
- [x] Legacy checked: `produtolojaintegrada` (mixed doc ids), `categorialojaintegrada`, `pedManager`, `EnviosLojaIntegrada`, `linksVariacoesli` (`arakene_variation_id`), `statusProdutosMarketplace` and the three deterministic ids constrain the port. **No order mirror exists** and none is invented (§3).
- [x] Decisions D1–D16 recorded; vetoable orchestrator calls listed, including 1019 in the D7 guard (§2.1).
- [x] Every LI write has a valve, a canary, a dry-run and a read-back or a stated substitute (§4.26).
- [x] Every step names its indexes, ruleset regeneration and env vars (§4.iii).
- [x] The CI lane lands with the first emulator test (step 3).
- [ ] This plan approved by Lucas (PR review).
- [x] Tracker #1812 + per-step issues #1813–#1830 opened together with this plan's PR #1811 (D14).
- [x] The §0 legacy credential is resolved: the live legacy has run on Personal Tokens on both stores since 2026-10-07.
- [x] A probe Personal Token per store for the NEW integration: not needed before the window (D17). The production tokens (P1, D16) are generated at the window.
- [x] The IP-binding gate answered "not bound" (P6): settled live on 2026-10-07 (§1.2 item 7).
- [ ] The owner's `GET /v1/situacao` capture C3 (1020's id and flags, §1.2 item 14, D17) done before step 5's estado table is frozen.

---

## 7. Questions still open for Lucas (not decided above)

1. **`custo` on price PUTs:** keep sending the ERP cost to LI (parity; anyone with store-admin access can see it), or omit it? Default: keep; confirmed in the step-13 plan.
2. **Product-import modes needed after the cutover:** the legacy screen offered targets × actions × SKU/category/variation/photo/price/stock options. Proposal: link-only + completar, with optional photo and price/stock import. Drop "sobrescrever" unless you use it.
3. **Expiry reminder delivery:** in-app aviso only (one, at 30 days, with the 401 park as backstop), or also e-mail/WhatsApp to the store owner? Who should receive it?
4. **Read-only staging rehearsal (a verification gap and a PII decision).** **Closed by D17 (2026-10-09): no.** No token is saved in staging before the window, so nothing below runs; the text stays as the record of what was declined.
   - Without a rehearsal, the live read path (poll → task → import → pedido, plus the import job) is first exercised at the window.
   - A rehearsal against ONE real store before the cutover would copy real buyer data into staging Firestore. If you allow it, the proposed rule is:
     - only the poller and the import run (valves stay off);
     - staging access is limited to admins;
     - the rehearsal data is purged by a script within 7 days and never exported;
     - captures stay out of git.
   - Yes or no?
5. **Stock reservation:** should LI orders awaiting payment hold ERP stock (then the stock push adds LI's `quantidade_reservada`, model A), or should LI alone reserve them (model B)? This decides step 12's quantity. Note that LI's own help articles disagree on whether Pedido Efetuado reserves (§1.2 item 3).
6. **Multi-envio orders:** do the stores ever split one order into several shipments? If never, the first `envios[]` entry plus an aviso is enough.
7. **Kit staleness:** a component sold on another channel reaches an LI kit's quantity only at the daily reconcile (≤ ~24 h). Acceptable, or should the step-12 plan cost a scoped propagation for LI-linked kits?
8. ~~**Where the freight-mapping editor lives** (step 20/21).~~ **Decided on 2026-10-07** (Lucas delegated the choice): a "Mapeamento do Frete" tab plus a "Horário de Corte" tab on the LI conta screen `/canais/loja-integrada/[id]`, as in the legacy, because the operator maps methods where the conta is configured. The rejected option was a `/logistica/loja-integrada` page beside the other freight editors.

---

## Appendix: evidence files

All of them live under `.master_plans/loja-integrada/evidence/`, and every one is derived from Loja Integrada's public documentation (the spec JSON and the help center):
- `survey-a-auth-inbound.md`: credentials, throttling, errors, paging, dates, webhooks.
- `survey-b-orders-fulfilment.md`: orders, situações, payments, shipping, Enviali, NF-e, returns.
- `survey-c-catalogue-stock-price.md`: produto model, publishing, variations, images, categories, stock, price.
- `survey-d-web-secondary.md`: partner program, help-center and third-party sources, conversational surfaces.
- `spec-diff.md`: old vs current spec, endpoint by endpoint.
- `caps-verify-result.md`: the 27-field adversarial verification plus the critic's reconciliation.
- `li-doc.mjs`: reads the public spec JSON and prints an operation, a tag or the info block. It caches the raw document under an ignored `./cache/`.
- The spec file's sha256 and HTTP `last-modified`, as recorded on 2026-10-07 (§1.0).

Operator decisions, the legacy surveys, the re-verification's legacy-code findings and every other legacy-code finding live in the gitignored `.private/loja-integrada/`.

### Critical files for implementation
- `packages/schemas/src/shared/marketplace.ts` (caps row) + `marketplace.test.ts`
- `packages/schemas/src/integracao.ts` (credential store, `integracaoMeta.cascade`) + `apps/whatsapp/lib/whatsapp/credentialStore.ts` (precedent)
- `packages/data/src/admin/notifications/pipeline.ts` (`defineNotificationPipeline`) + `apps/shopee/lib/shopee/notificacoes/orderBackfill.ts` (poll-cursor precedent)
- `packages/data/src/admin/estoque/` (IO-free core, `ledger.ts` contract) + `packages/data/src/admin/produtos/integracoesComProduto.ts`
- `packages/schemas/src/shared/frete.ts` (`FREIGHT_TIPO_CAPS.lojaIntegrada`) + `apps/web/lib/checkout/etiqueta/` + `apps/web/lib/checkout/etiqueta/providers/unsupportedMarketplace.ts`
- `packages/schemas/src/produto/collection/shopeeLinkVariacoes.ts` (the `arakene_variation_id` typing precedent for step 10)
