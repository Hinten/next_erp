# Survey D — secondary sources and conversational surfaces

Provenance: research dated 2026-10-07. Sources are the local Loja Integrada (LI) OpenAPI spec (queried read-only, cited as `spec <METHOD> <path>`, `spec tag <Tag>`, `spec info`), the LI help center, LI marketing and hub pages, and third-party integrator documentation (LinkAPI, L2Maker, Kondado, Base.com, Nemu). Most web fetches returned summaries produced by a small model, so treat them as secondary evidence. No LI endpoint was called, and no browser fallback was used. Findings about the legacy code are catalogued in the operator's private notes and are not ported here. No credentials or personal data appear in this file.

## 1. Credentials, partner program, cost, IP restriction

**Auth modes.**
- `spec info` says the credentials go in the `Authorization` header in one of two fixed combinations, never mixed.
- Combination one is `Basic <Personal Token>`. It identifies the lojista, and the token is unique per store.
- Combination two is `chave_api <key> aplicacao <uuid>`. The chave_api identifies the store and the chave de aplicacao identifies the integrator.
- `spec info` also says integrator credentials are IP-restricted ("Credenciais para integradores possuem restrição por IP"). Access from an unregistered IP returns an error.
- The legacy client authenticates with the chave_api + aplicacao combination.

**Chave de aplicacao** (help center https://ajuda.lojaintegrada.com.br/pt-BR/articles/5360466-como-obter-a-chave-de-aplicacao-para-integrar-com-a-loja-integrada, summarized by WebFetch).
- The integrator fills in a request form with company, application and purpose details, plus ALL egress IPs.
- Delivery is by email in 5 to 10 business days.
- It is free.
- The key is bound to the registered IPs. This covers production servers, workers, queues and scheduled jobs. Changing infrastructure requires submitting the new IPs through the same form before requests fail.
- A separate partnership form exists for companies offering services. It does not replace the key request.
- The requester must be a solution provider and needs an active LI store for testing.
- Architectural implication (inference): the ERP, a single multi-tenant app, probably needs ONE application key and a static egress IP for all Cloud Functions or Cloud Run traffic. Serverless dynamic egress is a real risk and needs a NAT with a static IP.

**Chave API and Personal Token** (help center https://ajuda.lojaintegrada.com.br/pt-BR/articles/931152-como-gerar-a-chave-api-da-minha-loja).
- Path in the painel: Configuracoes > Chave para API > "Cadastrar nova chave".
- The chave API is 20 characters, never expires, is always visible, and a store may have several.
- The Personal Token is shown once and cannot be recovered. It is generated only by the store Owner, not by Admin or Member users. At most 5 per store. It "expires every 3 months from creation date". There is a "Personal token" button, then "Gerar personal token".
- A paid plan is required to generate keys. Base.com (https://base.com/pt-BR/ajuda/knowledgebase/integracao-com-loja-integrada/) says generating a chave API is available only on the PRO plan. Kondado (https://kondado.com.br/blog/wiki/2025/04/09/loja-integrada/) says a paid plan plus an administrator user are needed. Treat this as a plan gate that ERP onboarding must explain.
- Architectural implication (inference): the Personal Token expires every 3 months, so a long-lived-token auth style would need an expiry warning and a re-entry UX. The chave_api plus aplicacao pair does not expire. The ERP should prefer the pair once it holds the aplicacao key, with the Personal Token as a fallback or dev path.

**Throttling** (`spec info`):

| Scope | Limit | Error code |
|---|---|---|
| Per aplicacao | 3000 requests per minute | 533 |
| Per loja (chave_api) | 100 requests per minute | 633 |
| Per IP | 1200 requests per minute | 133 |

- HTTP 429 is returned with the code for the exceeded scope.
- The per-store limit of 100 per minute is the binding one for stock fan-out.
- The spec does not document `Retry-After` or any rate-limit headers.
- The L2Maker and Kondado docs state no limits. Nothing found documents real-world behaviour (open question).

**Test and sandbox stores.** No sandbox environment was found. The spec has no sandbox host, and the help center only says an "active LI store for testing" is needed. Treat a real test loja as the only option (inference; absence of evidence is not proof).

## 2. Webhooks

From `spec tag Webhook Pedidos`, `spec PUT /webhooks/v1/pedido` and `spec DELETE /webhooks/v1/pedido`:
- Registration is by API, not by the painel. PUT body `{notifyUrl, token}` returns `{message: "Registros afetados: 1"}`. DELETE takes the same body. `/webhooks/v1/produto` exists likewise.
- Authentication: the registered token is sent in the header `Authorization: Bearer <token>` on each hook. This is a shared static secret, not an HMAC. Because it is an authenticated channel, the receiver should FAIL CLOSED with 503 when the secret is unset (design recommendation).
- The spec states duplicates are normal: the integrator "pode receber diversos webhooks repetidos". The dedupe rule it gives is to process only payloads with `situacao.situacao_alterada: true`.
- The payload is the full order object: `id`, `numero`, `id_externo`, `valor_*`, `cliente`, `endereco_entrega`, `pagamentos[]`, `situacao{codigo, aprovado, cancelado, final, situacao_alterada}`, `marketplace_info{integrador, marketplace, id_externo_unico}`, `itens[]` and others. `cliente.cpf`, `cliente.cnpj` and the delivery address (with `ie`, `cpf`, `cnpj`, `rg`) arrive INLINE. So fiscal data is inline (one call, not a second gated call), at least in the documented example. The example shows a placeholder-like `cpf` value ("123") in one place, so validate and mask on receipt. This does not contradict Survey A.
- NOT documented in any source found: retry policy, backoff, timeout, delivery guarantees, and a signature. No secondary source describes them (Nemu, L2Maker, LinkAPI and Kondado are all silent). Open question; only a live test can settle it.
- Where a lojista configures webhooks in the painel: not found. The search surfaced no help article. It looks API-only (inference). A third-party doc (Nemu, https://docs.nemu.com.br/en/onboarding/integrations/loja-integrada) says only to create an API key in Settings > API Key and paste it into Nemu, with no webhook step.

## 3. Conversational surfaces (caps fields)

- `perguntas` (pre-sale Q&A): NO endpoint. A full-text search of the spec for "pergunta" gives 0 hits, and no path or tag covers Q&A. The only Q&A found is the Lily Reviews third-party app (https://empreender.com.br/avaliacoes-na-loja-integrada), which is not LI's API. Recommended value: `nao` (no API in the spec; an in-painel feature cannot be excluded).
- `mensagensPosVenda`: NO endpoint. "mensagem" appears in the spec only as `mensagem_gateway` (payment gateway message) and as shipping-rule text. Recommended value: `nao`. Buyer messaging is by email or third-party tools (Responso via Base.com).
- `reclamacoes` (claims, returns, disputes): NO claims endpoint. Search for "devolu" and "reclama" gives 0 hits. Only order situacoes exist: `pagamento_devolvido`, `pagamento_devolvido_sem_retorno`, `pedido_chargeback`, `pagamento_em_disputa`, `cancelamento_solicitado` (`spec tag Situacoes do pedido`). Recommended value: `nao`. These are payment and order-state signals, not a claims API.
- Reviews/avaliacoes: 0 hits in the spec. Reviews are third-party apps only.
- `origensConversa`: `[]`, since there is no chat or Q&A surface.
- Confidence note: a spec-based `nao` means the PUBLIC API has none. Whether the painel has these features was not verified (open question).

## 4. Enviali (shipping product)

- `spec tag Enviali` and `/enviali/v2/postage*` and `/enviali/v2/wallets`: this is LI's own shipping and intermediation API (postage, bill, doc, estimate, pdf, tracking, wallets). Values are integer cents, centimeters and grams. The header `x-correlation-id` must be a valid UUID, and it is echoed back as `id` in error responses.
- Carriers per LI marketing (https://lojaintegrada.com.br/enviali; also intercom.help): Correios PAC and SEDEX with Platinum-equivalent rates and no contract needed, Jadlog (paid plans only), and J&T Express (intercom.help article 14601133, per search snippet).
- It is prepaid: the lojista buys credits and pays per printed etiqueta, with no monthly fee. This matches `/enviali/v2/wallets` (inference). Any store can activate it from the painel.
- Fit for the caps: LI is a store-front platform, not a marketplace that mints labels for orders. `etiqueta` is likely "emit" (via Enviali) or "nenhuma", and the ERP already has Melhor Envio (freight-integrations skill). Whether to use Enviali is a product decision for the operator.
- `rastreio`: the Enviali tracking GET `/enviali/v2/postage/tracking/{tracking_codigo}` exists, and order-side tracking is `/v1/pedido_envio` (details in other surveys).

## 5. LI own payment gateway

- Pagali is LI's official payment solution (https://lojaintegrada.com.br/hub/como-funciona-o-pagali/, https://lojaintegrada.com.br/hub/solucao-de-pagamento/; mercadoeconsumo article of 2022-03-18).
- Methods: boleto, credit card, Pix, and payment links. Pix requires the Growth plan or higher. Fees start around 0.99%, 0.90% and 0.70% by plan (press article).
- Funds sit in the LI account and are withdrawn free, manually or automatically.
- Acquirer: NOT stated in any source fetched, so "Pagar.me" is unconfirmed. Mercado Pago is documented separately as the processor for free-plan stores (https://www.mercadopago.com.br/developers/pt/docs/loja-integrada/introduction). PagBank also had a 2021 partnership (mercadoeconsumo).
- API exposure: there is NO Pagali API in the spec. `spec GET /v1/pagamento` lists the store's available payment methods (`codigo`, `configuracoes.ativo` and `disponivel`, `nome`; for example `wcboleto`). Order payments come inline: `pagamentos[]` with `forma_pagamento{id, codigo, nome}`, `transacao_id`, `numero_parcelas`, `valor`, `valor_pago`, `mensagem_gateway`, `codigo_retorno_gateway`. External orders use `PAGAMENTOEXTERNO` (id 19). So `importarPagamento` is "sim" only for what the order carries. There is no settlement or fee detail from LI (inference).

## 6. Third-party integrators (for undocumented behaviour)

- LinkAPI (https://developers.linkapi.solutions/docs/lojaintegrada) lists the old v1 endpoints (categoria, marca, grade, produto, produto_estoque, pedido, integration, produto_preco). It says no rate limits and no webhooks are documented, and uses base `https://api.awsli.com.br/v1`.
- L2Maker (https://l2maker.com.br/documentacao/api-loja-integrada/) uses chave_api and chave_aplicacao. It lists only version numbers (1.5.0, 1.4.0, 1.0.0) with no changelog detail. The content of the 05/02/2024 v1.4.0 entry was NOT retrievable. No webhook, perguntas or mensagens documentation.
- Kondado: 18 entities (orders with items, payments and shipments; products with stock, prices, images and variations; customers; categories; brands; coupons; payment and shipping methods; order status history; invoices). It admits some field descriptions are AI-written because the API docs lack them.
- Base.com: documents only key setup. It says nothing on sync intervals or polling.
- The whera/LojaIntegrada repo (PHP) was archived 2021-09-17. The li-apiclient package on PyPI could not be read (page error). No known-bug list was found anywhere.
- The community forum (comunidade.lojaintegrada.com.br) returned nothing useful through search.

## 7. Caveats for other caps fields

- `notificacoes`: push exists (webhooks by API registration), but with no documented retry or signature. A poll backstop via `/v1/pedido/search` and `/v1/situacao_historico/search` is warranted (inference).
- `assinaWebhook`: "sim" in the sense of a static Bearer token (authenticated), not an HMAC.
- `dadosFiscaisSeparados`: "nao" (cpf and cnpj inline in the webhook and order payload), citing the `spec tag Webhook Pedidos` example.
- Throttle: 100 requests per minute per store makes per-listing stock pushes expensive. Check the batch endpoint `GET/PUT /v1/produto_estoque` in Survey B.
- `spec tag Situacoes do pedido` lists the 16 situacoes (aguardando_pagamento ... pronto_para_retirada).
- Trial-version limits mentioned by L2Maker (order and item value caps) concern their own product only.

## Open questions

1. Webhook retry policy, backoff, per-delivery timeout and max attempts: undocumented; needs a live test.
2. Does the product webhook (`/webhooks/v1/produto`) fire on stock changes the ERP itself pushes, creating echo loops?
3. Is the chave de aplicacao tied to one set of static IPs for all lojistas, and can IPs be added later without re-approval?
4. Real-world behaviour of 429 (Retry-After, and whether the 633 per-store limit counts webhook-triggered reads).
5. Is order cpf/cnpj always populated inline for every order type (the example shows a placeholder-like value once)?
6. Does the painel expose webhook configuration, product Q&A, buyer messages, or returns that the API lacks?
7. Who is the acquirer behind Pagali (Pagar.me unconfirmed)?
8. Content of the L2Maker changelog entry "API Loja Integrada versao 1.4.0 publicada em 05/02/2024" (only version numbers were visible).
9. The help article says the chave API has no expiry (so the 3-month expiry should not affect the chave_api pair), but this is not verified live.
10. The li-apiclient PyPI page failed to load, so quirks of that client are unreviewed.

## Decisions needed from the operator

- Require the integrator application key (free, 5 to 10 business days, static egress IPs) from day one, or start with each lojista's Personal Token (expires every 3 months, Owner-only)? This decides auth and the IP infrastructure (static NAT egress for Cloud Functions).
- Is it acceptable to ship with perguntas, mensagensPosVenda and reclamacoes as `nao` for LI (no API surface)?
- Should shipping labels for LI orders go through Enviali (LI's prepaid wallet) or keep using the existing Melhor Envio flow?
- Should the ERP register the order and product webhooks automatically via `PUT /webhooks/v1/*` at onboarding (the only documented way), with the token generated and stored by us?
- Can the operator apply for the chave de aplicacao now (needs company data and the egress IPs), and is a PRO-plan LI test store available for live verification?

## Sources not retrievable

- https://pypi.org/project/li-apiclient/ (page error).
- L2Maker changelog entry for v1.4.0 (only version numbers visible).
- comunidade.lojaintegrada.com.br (no useful search results; not fetched directly).
- A help-center article on webhook configuration in the painel (none found via search).

## Claims

| Field | Value | Confidence | Citations |
|---|---|---|---|
| auth | Two modes: `Basic <Personal Token>` or `chave_api <key> aplicacao <uuid>`; not mixable | alta | spec info; https://ajuda.lojaintegrada.com.br/pt-BR/articles/931152-como-gerar-a-chave-api-da-minha-loja |
| other:application key program | Free; 5-10 business days; request form with all egress IPs; key bound to registered IPs; active LI test store needed | alta | https://ajuda.lojaintegrada.com.br/pt-BR/articles/5360466-como-obter-a-chave-de-aplicacao-para-integrar-com-a-loja-integrada; spec info |
| other:personal token | Owner-only, shown once, max 5 per store, expires every 3 months; chave API is 20 chars, no expiry; paid plan required | media | https://ajuda.lojaintegrada.com.br/pt-BR/articles/931152-como-gerar-a-chave-api-da-minha-loja; https://base.com/pt-BR/ajuda/knowledgebase/integracao-com-loja-integrada/; https://kondado.com.br/blog/wiki/2025/04/09/loja-integrada/ |
| other:rate limits | Per aplicacao 3000/min (533), per loja 100/min (633), per IP 1200/min (133); HTTP 429; no Retry-After documented | alta | spec info |
| assinaWebhook | sim (static Bearer token in Authorization header, not HMAC); receiver should fail closed with 503 when secret unset | alta | spec tag Webhook Pedidos; spec PUT /webhooks/v1/pedido |
| notificacoes | push (webhook registered via API; duplicates expected; dedupe on situacao.situacao_alterada true); retry policy undocumented | media | spec tag Webhook Pedidos |
| dadosFiscaisSeparados | nao (cpf/cnpj/ie and address inline in order/webhook payload); completeness unverified | media | spec tag Webhook Pedidos |
| perguntas | nao | media | spec (full-text search); https://empreender.com.br/avaliacoes-na-loja-integrada |
| mensagensPosVenda | nao | media | spec (full-text search) |
| reclamacoes | nao | media | spec tag Situacoes do pedido; spec (full-text search) |
| origensConversa | [] | media | spec (full-text search) |
| other:Enviali | LI shipping intermediation API with prepaid wallet; Correios PAC/SEDEX, Jadlog (paid plans), J&T; integer cents/cm/g; x-correlation-id UUID header | media | spec tag Enviali; https://lojaintegrada.com.br/enviali; https://intercom.help/loja-integrada/pt-BR/articles/14601133-como-funciona-a-integracao-com-a-j-t-express-no-enviali |
| other:Pagali | LI payment solution (boleto, card, Pix, links); no Pagali API in spec; GET /v1/pagamento lists store payment methods and orders carry pagamentos[] inline; acquirer unconfirmed | media | https://lojaintegrada.com.br/hub/como-funciona-o-pagali/; https://mercadoeconsumo.com.br/2022/03/18/loja-integrada-lanca-meio-de-pagamento-para-pequenas-e-medias-empresas/; spec GET /v1/pagamento |
| other:webhook registration | Registered by API (PUT/DELETE /webhooks/v1/pedido and /webhooks/v1/produto); no painel location found | media | spec PUT /webhooks/v1/pedido; spec DELETE /webhooks/v1/pedido |
| other:sandbox | No sandbox found; real test loja required (absence is not proof) | baixa | spec info; https://ajuda.lojaintegrada.com.br/pt-BR/articles/5360466-como-obter-a-chave-de-aplicacao-para-integrar-com-a-loja-integrada |
