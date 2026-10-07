# Survey B — orders, payments, shipping, labels, tracking, NF-e, returns

> Provenance: compiled 2026-10-07 from the current Loja Integrada (LI) OpenAPI spec (info.version "v2", server https://api.awsli.com.br; cited as `spec <METHOD> <path>`, `spec tag <Tag>`, `spec info`), the older Apiary/apib documentation (cited as "old apib"; the Apiary page is titled "Versão descontinuada" and only its header could be fetched because it is a JS SPA), and LI help-center articles (cited by URL). Facts observed in the legacy code are cited only as "legacy code". Findings about defects of the legacy code are catalogued in the operator's private notes and are not ported. The legacy client authenticates with the chave_api + aplicacao combination. All examples below have personal data redacted. No LI endpoint was called; everything is documentation-derived, and inferences are marked as such.

---
## 0. Capability fields in scope

| field | value | confidence | one-line why |
|---|---|---|---|
| importarPedido | **sim** | alta | `GET /v1/pedido/search` + `GET /v1/pedido/{pedido_id}` + Webhook Pedidos |
| importarPagamento | **sim** (no settlement or fee data) | alta | `pagamentos[]` comes inline in the order |
| consolidaPacote | **nao** | media | no multi-order shipment concept anywhere. Enviali `bill` batches labels but each postage is one order |
| dadosFiscaisSeparados | **nao** | alta | `cliente` (cpf/cnpj/razao_social) and `endereco_entrega` (tipo PF/PJ, cpf, cnpj, ie, rg, razao_social, full address) are inline and unmasked |
| etiqueta | **emit** (recommended), with an optional per-order Enviali path that behaves like `fetch` | media | LI does not mint labels for ordinary orders. Enviali mints only when someone buys it (`POST /enviali/v2/postage/bill`, prepaid wallet) |
| rastreio | **pull** (recommended), with nuance | media | no tracking push. Enviali tracking is a GET. Our tracking goes OUT via `PUT /v1/pedido_envio/{id}` |
| enviarNfe | **sim** | alta | `POST/PUT /v1/integration/pedido/nf` (metadata + URLs, no XML upload) |
| reclamacoes | **nao** | alta | no claims/returns API. Only the situação codes `cancelamento_solicitado`, `pagamento_devolvido*`, `pedido_chargeback`, `pagamento_em_disputa` |

Answers to the architecture questions this survey touches:
- (1) Webhooks are authenticated with a shared static Bearer token that we pick when registering. They are not HMAC-signed. See §6.
- (2) Both push (Webhook Pedidos) and poll (`since_atualizado`).
- (5) The buyer's fiscal identity is inline.

---
## 1. Order list — `GET /v1/pedido/search` (spec GET /v1/pedido/search)

**Filters** (all from the operation description):
- `since_numero`: numero >= value.
- `since_atualizado`: updated "a partir da" data/hora, format `AAAA-MM-DDTHH:MM:SS`, hour optional.
- `cliente_id`, `pagamento_id`, `situacao_id`.
- `since_criado`, `until_criado`: same format.
- Only `since_numero`, `situacao_id`, `pagamento_id` and `limit` are declared as formal `parameters`. The rest exist only in the prose.

**Paging**: `limit` (spec: "o máximo aceito é 50") and `offset`. Responses have `meta {limit, next, offset, previous, total_count}`.
- Discrepancy: the old apib says max 100 (old apib "Buscar pedidos"). The current spec wins, so use 50.
- No ordering parameter is documented for pedidos. `order_by=data_modificacao|-data_modificacao` is documented only for `GET /v1/cliente` (spec GET /v1/cliente). Default sort order is therefore unknown.

**Change cursor**: `since_atualizado` against each object's `data_modificacao`. Inference: "a partir da" means the bound is inclusive, so re-processing the boundary order is expected, and the importer must be idempotent.

**List object shape** (summary only): `cliente` (URI string, e.g. "/api/v1/cliente/<id>"), `data_criacao`, `data_expiracao`, `data_modificacao`, `id_anymarket`, `id_externo`, `numero`, `peso_real` ("0.170"), `resource_uri` ("/api/v1/pedido/164"), `situacao{aprovado,cancelado,codigo,final,id,nome,notificar_comprador,padrao,resource_uri}`, `utm_campaign`, `valor_desconto|valor_envio|valor_subtotal|valor_total`. All money values are decimal STRINGS ("106.38").
- No itens, payments or address. Polling therefore needs one `GET /v1/pedido/{id}` per changed order (N+1).

**Throttling**: 100 req/min per loja (`chave_api`, error code 633), 3,000/min per aplicação (533), 1,200/min per IP (133). All three return HTTP 429 (spec info). A store with heavy order traffic plus the N+1 detail reads can hit 100/min.

## 2. Order detail — `GET /v1/pedido/{pedido_id}` (spec GET /v1/pedido/{pedido_id})

**Identity**
- The `pedido_id` path param in the example is "165", which equals `numero` 165, and `resource_uri` is "/api/v1/pedido/165". Inference: the path takes the store-facing **numero** (legacy code also addresses detail reads by numero).
- The internal `id` (a large integer) only appears in the webhook payload (spec tag Webhook Pedidos).
- `id_externo` is an integer we can write (§9). `id_anymarket` exists for orders that arrived from the AnyMarket hub.
- Webhook-only field `marketplace_info{integrador, marketplace, id_externo_unico}`.

**Top level**: `cliente`, `cliente_obs`, `cupom_desconto`, `data_criacao`, `data_expiracao`, `data_modificacao`, `endereco_entrega`, `envios[]`, `id_anymarket`, `id_externo`, `integration_data` (PUT response), `itens[]`, `numero`, `pagamentos[]`, `peso_real`, `resource_uri`, `situacao{...}`, `utm_campaign`, `valor_desconto`, `valor_envio`, `valor_subtotal`, `valor_total`.

**cliente (inline)**: `id`, `nome`, `email`, `cpf` (full, unmasked in the example; value redacted here), `cnpj`, `razao_social`, `data_nascimento`, `sexo`, `telefone_celular`, `telefone_principal`, `resource_uri`.
- The webhook form adds `telefone_comercial`, `situacao` ("aprovado"), `data_criacao` and `data_modificacao`.
- There is no `ie` or `tipo` on cliente. They live on the address, and also on `GET /v1/cliente/{id}`, which returns `tipo`, `ie`, `rg`, `razao_social`, `enderecos[]` and `grupo` (spec GET /v1/cliente/{cliente_id}).

**endereco_entrega (inline)**: `id`, `tipo` ("PF"/"PJ"), `cpf`, `cnpj`, `ie` ("isento" in the example), `rg`, `nome`, `razao_social`, `endereco`, `numero`, `complemento`, `referencia`, `bairro`, `cidade`, `estado` (UF), `cep` (8 digits, string), `pais` ("Brasil").
- The webhook also carries `endereco_pagamento` with the same keys (spec tag Webhook Pedidos). The GET example does not show it.

**itens[] (GET)**:
- Dimensions: `altura`, `largura`, `profundidade` (int), `peso` ("0.450"). Also `disponibilidade`, `id`, `linha`, `nome`, `pedido` (URI).
- Prices: `preco_cheio`, `preco_custo`, `preco_promocional`, `preco_subtotal`, `preco_venda`, all strings.
- `produto`: in the spec example this is an OBJECT `{id_externo, resource_uri: "/api/v1/produto/<id>?id_externo=1"}`, not a URI string. Treat the shape as variable and parse defensively (open question).
- `produto_pai` (URI of the parent product), `quantidade` ("1.00", a decimal string), `sku`.
- `tipo`: "atributo_opcao" for a variation child. The webhook shows "normal".

**itens[] (webhook)**: `linha`, `id`, `produto_id`, `produto_id_pai`, `id_externo`, `sku`, `nome`, `tipo`, `quantidade` (number), `preco_cheio`, `preco_custo`, `preco_venda`, `preco_subtotal`, `preco_promocional` (numbers).

**Number format**: GET returns money and quantity as decimal STRINGS ("32.48", "1.00"), while the webhook returns JSON numbers (258.37, 1). Parse both into integer cents.

**Timestamps**:
- GET returns naive ISO strings with microseconds and no offset ("2022-10-31T12:28:05.704751").
- The webhook's top-level `data_*` fields are UTC with Z ("2024-12-11T21:09:38.888Z"), while its nested cliente and envios timestamps carry -03:00 ("2024-12-11T18:09:39.352574-03:00").
- Inference: 21:09Z equals 18:09-03:00, so naive GET timestamps are America/Sao_Paulo local time. Parsing them as UTC would shift them by 3 hours. A live call should confirm this. The `since_atualizado` query parameter is likewise naive and its timezone must be confirmed.

## 3. Situações (spec tag "Situações do pedido", spec GET /v1/situacao)

The tag lists 16 codes. The `/v1/situacao` example lists 15 of them with flags:

| id | codigo | aprovado | cancelado | final | notificar | meaning |
|---|---|---|---|---|---|---|
| 9 | pedido_efetuado | F | F | F | F | default (`padrao: true`), placed, unpaid |
| 2 | aguardando_pagamento | F | F | F | T | awaiting payment |
| 3 | pagamento_em_analise | F | F | F | T | payment under analysis |
| 4 | pedido_pago | T | F | F | T | **paid** |
| 6 | pagamento_em_disputa | **T** | F | F | F | **in dispute** (still `aprovado`) |
| 16 | pedido_chargeback | **T** | F | **T** | F | **chargeback** (still `aprovado`, and final) |
| 7 | pagamento_devolvido | F | T | T | T | **refunded** |
| 8 | pedido_cancelado | F | T | T | T | **cancelled** |
| 1019 | cancelamento_solicitado | F | **T** | **F** | F | **cancellation REQUESTED**, not final |
| 1018 | faturado | T | F | F | F | invoiced (NF issued) |
| 17 | em_producao | T | F | F | T | in production |
| 15 | pedido_em_separacao | T | F | F | T | picking |
| 11 | pedido_enviado | T | F | T | T | shipped |
| 13 | pronto_para_retirada | T | F | T | T | ready for pickup |
| 14 | pedido_entregue | T | F | T | T | delivered |
| — | pagamento_devolvido_sem_retorno | ? | ? | ? | ? | refunded, item not returned. **Missing from the spec example.** Legacy code carries id 1020 with aprovado:true, cancelado:false, final:true for it, unverified against the spec (re-verified 2026-10-07: no single primary source lists all 16 codes with ids; the id 1020 and its flags come only from legacy code; LI help 924633 says the order in this status "is considered cancelled" and the buyer receives a "Pagamento devolvido" e-mail, so the flags must be confirmed against a live GET /v1/situacao before the mapping table is frozen) |

(re-verified 2026-10-07: the mapping must be keyed by `codigo` or id and must cover all 16 codes, including faturado 1018 and cancelamento_solicitado 1019; an unknown codigo should be recorded as unmapped rather than rejected.)

**Consequences**
- `aprovado` alone does NOT mean "paid and good": chargeback and disputa are `aprovado:true`.
- `cancelado` alone does NOT mean cancelled: cancelamento_solicitado is `cancelado:true, final:false`.
- Map by `codigo`, never by flags.
- **Terminal** (`final:true`): 7, 8, 11, 13, 14, 16, and (unverified) 1020.

**Writing a situação**: `PUT /v1/situacao/pedido/{pedido_id}` with body `{"codigo":"pedido_enviado"}` (spec PUT /v1/situacao/pedido/{pedido_id}).
- The response echoes the new situação. The old apib documents 202, the current spec 200.
- No transition rules are documented. The history example shows an API change from `pedido_cancelado` (final) to `pedido_enviado` (`alterado_por: "API"`), so inference: `final` is not enforced on API writes and we must guard transitions ourselves (re-verified 2026-10-07: this is strong evidence from the example, not a documented rule).
- Buyer e-mail on API writes (re-verified 2026-10-07: the spec does not define `notificar_comprador` and the PUT body has no notify switch; LI help 924633 says LI e-mails the buyer on every status change, with a template per status; neither the spec nor the help center says whether an API PUT fires the same mailer as the panel. Treat every PUT to 11, 13 or 14 as possibly e-mailing the buyer, whatever the `notificar_comprador` flag says; the flag is a hint, not a guarantee).

**History**: `GET /v1/situacao_historico/search?numero=` or `?id_externo=` (spec GET /v1/situacao_historico/search).
- Per-order only. Objects carry `alterado_por` ("gateway"/"API"), `alterado_por_nome`, `data`, `id`, `numero`, `obs`, `situacao{}`, `situacao_anterior{}`, paginated by meta.
- It is NOT a store-wide change feed. It is useful for approval and cancellation timestamps.

## 4. Payments (spec GET /v1/pedido/{pedido_id}, spec GET /v1/pagamento)

**`pagamentos[]` on the order**:
- `id`, `forma_pagamento{codigo ("pagsegurov2"), id, nome, imagem, configuracoes{ativo,disponivel}, resource_uri}`, `pagamento_tipo` ("creditCard").
- `parcelamento{numero_parcelas, valor_parcela (number)}`, `valor`, `valor_pago` (strings).
- `bandeira`, `authorization_code`, `transacao_id`, `identificador_id`, `codigo_retorno_gateway`, `mensagem_gateway`, `banco`.
- `boleto_url`, `pix_code`, `pix_qrcode` (PUT-response example).
- The webhook uses a flat `numero_parcelas` instead of `parcelamento`.
- There are NO fee, net-amount or settlement/escrow fields. Inference: a `valor_pago - valor` difference may represent interest charged to the buyer; confirm live.

**`GET /v1/pagamento`** is the store's catalogue of payment METHODS (codigo, configuracoes.ativo/disponivel; paginated, total_count 27 in the example). It is not transactions.
- Hub orders show `forma_pagamento {id:19, codigo:"PAGAMENTOEXTERNO", nome:"Pagamento Externo"}` (webhook example).
- The payment status must be derived from the order situação. There is no per-payment status field.

## 5. Shipping, labels, tracking

**Store methods**: `GET /v1/envio` returns `{codigo, configuracoes, id, imagem, nome, resource_uri, tipo}`.
- Example tipos: `enviali`, `correios_api` (sedex/pac), `mercadoenvios_api`, `faixa_cep` (motoboy, transportadora, retirar_pessoalmente), `frenet_api`, `kangu_api`, `mandabem_api`, `melhorenvio_api` (spec GET /v1/envio).

**Order `envios[]`**: `id` (the pedido_envio id), `objeto` (tracking code or null), `prazo` (days), `valor` (string), `data_criacao`, `data_modificacao`, `forma_envio`.
- The `forma_envio` key differs by source. GET uses `{code:"PAC", id, nome:"Enviali", tipo:"PAC "}`, note **`code`** and the trailing space. The webhook uses `{id, codigo:"CORREIOS - PAC", nome:"Envio Externo", tipo}`, note **`codigo`**.
- The array allows several envios per order; whether split shipments occur in practice is an open question.

**Tracking write-back**: `PUT /v1/pedido_envio/{pedido_envio_id}` with body `{"objeto":"<tracking-code>"}`. The id is `pedido.envios[i].id`, NOT the pedido id (spec PUT /v1/pedido_envio/{pedido_envio_id}).
- Whether this also moves the situação to `pedido_enviado` is undocumented. Set the situação explicitly.

**Enviali** (spec tag Enviali; LI's own label service):
- **Headers and units**: the header `x-correlation-id` (a UUID) is required on every Enviali operation and is echoed as `id` in error responses. All numbers are integers: cents, cm, grams.
  - Contradiction: the tracking endpoint's prose says volume height/width/length are in **mm**.
- **Quote** — `POST /enviali/v2/postage/estimate`:
  - Body: `zipcode`, `merchandise_value`, `products[]{id, sku, name, quantity, price, volume{height,width,length,weight}, categories, parent_id}`, `order_date`, `options{delivery_receipt, personal_delivery, insurance_coverage}`, and an optional `volume`.
  - Minimum volume 1x10x15 cm and 300 g. Per product, the minimum is 1x1x1 and 100 g.
  - Returns `volume` and `estimates[]{price, eta "D.HH:MM:SS", name, slug, competitor_price, options}`.
- **Buy** — `POST /enviali/v2/postage/bill`:
  - Body: `postage[]` (batch), each `{order{id, code, merchandise_value, date_time, products[], invoice{access_key}}, recipient{federal_document, name, email, cellphone, phone_number, address{zipcode,state,city,district,street,number,complement,directions}}, volume, estimate}`. `volume` and `estimate` must be exactly as returned by the quote; prices are re-quoted and the call fails on mismatch.
  - Validation errors fail the whole batch. Generation errors fail per item.
  - Response: `{id, success[{id, order_code}], errors[]}`.
  - 33 error codes, including 14 "Invoice is required for business accounts", 25 "Wallet not found", 26 "Insufficient balance", 28 "Insufficient order limit" and 32 "Order already billed".
- **Download** — `GET /enviali/v2/postage/pdf?ids=&paperType=`: paperType is PdfA4, PdfZpl or Zpl (example "A4"); the response is application/pdf. `GET /enviali/v2/postage/doc?ids=` returns shipping documents as PDF. Neither returns anything once the postage is expired, cancelling or cancelled (postages carry `expires_at`, about 15 days in the examples).
- **List** — `GET /enviali/v2/postage`:
  - Filters: `id[]`, `status[]` (created, billed, cancelling, cancelled, posted), `trackingStatus[]` (posted, transit, delayed, returned, lost, delivered, pickup, delivering, damaged, seized, disposed, returning), `slug`, `search` (customer name, order number or tracking code), `before` (a date cursor, newest first) and `limit`.
  - `GET /enviali/v2/postage/{postage_id}` returns a single postage.
- **Tracking** — `GET /enviali/v2/postage/tracking/{tracking_codigo}` returns `postage.tracking_status` and `tracking_history[]{timestamp, description, location, status, received_at}`, plus order, recipient, estimate and `incidents[]`.
- **Wallet** — `GET /enviali/v2/wallets` returns `{balance, open_orders, pending_balance, tier{max_balance, max_deposit, max_concurrent_orders}}`, which is prepaid.
- **Cancel** — `DELETE /enviali/v2/postage?id=`: cancellation is scheduled and takes up to 2 business days; the refund happens at the real cancellation. LI says the order's tracking code on the e-commerce platform is updated to an empty string when cancellation is requested. Inference: a billed Enviali label writes its tracking code onto the LI order automatically.
- **Carriers and availability** (help center):
  - Correios PAC/SEDEX for all accounts. Jadlog only on paid plans (https://lojaintegrada.com.br/enviali).
  - J&T Express needs a paid plan with Enviali enabled. CNPJ sellers need the NF-e key (44 digits) and CFOP, and one NF-e may not be reused across labels. For CPF sellers a DCe is generated automatically (https://intercom.help/loja-integrada/pt-BR/articles/14601164-como-gerar-etiquetas-e-postar-envios-pela-j-t-express-no-enviali).
  - Labels are paid from the wallet balance (https://lojaintegrada.com.br/enviali).

**etiqueta decision (nuance)**
- LI is a storefront. For every `forma_envio` except Enviali, LI mints nothing. The merchant or our freight stack (Melhor Envio, motoboy, own Correios contract, etc.) mints the label, which is `emit`.
- For orders whose `forma_envio` is Enviali, LI can mint it, but only when someone actively BUYS it via `bill` (wallet-charged, re-quoted, needs recipient, volume and invoice/DCe data we supply). We then download the PDF.
- That is functionally a freight-provider purchase, like Melhor Envio's cart/checkout, not a marketplace-owned label.
- Recommendation: set caps `etiqueta: 'emit'`, and model Enviali as an optional freight tipo (int_frete), resolving the label mode per order from `envios[0].forma_envio`. If the product decision is "always buy Enviali for Enviali-quoted orders", then those orders behave as `fetch`.

**rastreio decision (nuance)**
- Nothing pushes tracking events to us. Webhook Pedidos fires on order updates; LI advises using only those with `situacao.situacao_alterada: true`. It carries `envios[].objeto` but no tracking events.
- Enviali tracking is pull-only (the GET tracking and list `trackingStatus` filters).
- In the other direction, we push our tracking code into LI (`PUT /v1/pedido_envio`) and set the situação.
- Recommendation: `rastreio: 'pull'`. If our own carrier minted the label, tracking comes from that carrier's integration instead.

## 6. Webhook Pedidos (spec tag Webhook Pedidos, spec PUT/DELETE /webhooks/v1/pedido)

- Register with `PUT /webhooks/v1/pedido {notifyUrl, token}`, which answers "Registros afetados: 1". Delete with the same body.
- Every hook carries the header `Authorization: Bearer <token>`. This is a static shared secret, not a signature; the receiver must fail closed when the secret is unset.
- Duplicates are expected. LI says to consider only payloads with `"situacao"."situacao_alterada": true`.
  - Inference: a hook fires on any order update. Changes that are not status changes (tracking, NF) may arrive with `situacao_alterada:false`, and filtering on it would drop them. This needs a live check.
- The payload is a full order of a different shape from GET: numbers instead of strings, `id` + `numero`, `endereco_pagamento`, `marketplace_info`, `tipo:"pedido_venda"`, and a body field `token` whose meaning is undocumented.
- Retries, timeout, source IPs and ordering are undocumented.

## 7. NF-e (spec tag Nota Fiscal, spec POST/PUT /v1/integration/pedido/nf, spec GET /v1/pedido_nf/{nf_id})

- **Write (POST to insert, PUT to update)**, `multipart/form-data` fields:
  - `account_key` (the store's chave API, in the BODY)
  - `sale_number` (pedido numero)
  - `date` ("2022-10-18 03:44:21")
  - `invoice_number` ("00003")
  - `serie` ("1")
  - `access_key` (44-digit chave)
  - `url` (DANFE view URL)
  - `url_xml` (XML download URL)
  - Response: `{status:200, msg:"Invoice successfully inserted."|"...updated."}`.
- No XML or file upload: LI stores URLs, so we must host the DANFE and XML. There is no valor field.
- **Read**: `GET /v1/pedido_nf/{nf_id}` returns `access_key`, `numero` (int), `serie` (int), `data`, `url`, `url_xml`, `enviada` (bool: sent to the customer) and `resource_uri`. No documented field on the order exposes `nf_id`.
- **Prerequisites**: the docs do NOT say an NF is required before marking an order shipped. Enviali `bill` does require `order.invoice.access_key` for business (CNPJ) accounts (error 14).

**DCe** (spec tag DCE): this is for externally generated DCe.
- `POST /v1/integration/pedido/dce`, multipart: `order_number` (required), `access_key` (44 digits, required), `url_xml` (optional).
- `DELETE /v1/integration/pedido/dce?order_number=` only unlinks; it does not cancel the DCe.
- `GET /v1/pedido_dce/{pedido_numero}` returns `{access_key}`.
- The DCe is mandatory nationally from 2026-04-06, for CPF sellers and for CNPJ sellers shipping without an invoice. It is generated automatically by Enviali (https://ajuda.lojaintegrada.com.br/pt-BR/articles/12384787-o-que-e-a-dce-declaracao-de-conteudo-eletronica).

## 8. Returns, cancellations, disputes

- There is no claims, returns or cancellation-request API; the 25 spec tags contain none.
- Everything arrives as situação codes: `cancelamento_solicitado` (1019, a request, not final), `pedido_cancelado` (8), `pagamento_devolvido` (7), `pagamento_devolvido_sem_retorno`, `pedido_chargeback` (16), `pagamento_em_disputa` (6).
- Our side can only answer by PUTting a situação.

## 9. Write-backs and hub endpoints

- **`PUT /v1/pedido/{pedido_id}`** with body `{"id_externo": 667}` (integer) "Altera o id_externo do pedido".
  - Our Firestore pedido ids are strings, so only a numeric surrogate can be written.
  - `?id_externo=1` then allows lookups by it (`resource_uri:"?id_externo=1"`, situacao_historico `?id_externo=`).
- **`POST /v1/integration/sales`** (201 `{id, number}`) and **`PUT /v1/integration/sales/{sale_id}`** create or update orders INTO LI from marketplaces/hubs (spec tag Integrações de pedido).
  - Body: `buyer`, `shipping{address, option}`, `amount{discount, freight, fees, total, gross}`, `items[]{product_id, quantity, unit_value, line_value}`, `info{status, marketPlaceId, reference, comment}`, `integration_data{integrator, marketplace, external_id, unique_id}`.
  - The old apib lists the accepted `info.status` ids: 2, 3, 4, 6, 7, 8, 9, 11, 13, 14.
  - These are NOT needed for importing. **Dedup risk:** orders injected into LI by hubs (`marketplace_info`, `id_anymarket`, `PAGAMENTOEXTERNO`) would be imported twice if the same marketplace is also integrated directly. Filter or flag them.

## 10. Documentation drift to account for

- Page size: old apib says 100, current spec says 50 (use 50).
- Situação write response: old apib 202, current spec 200.
- Situação catalogue: `faturado` (1018) and `cancelamento_solicitado` (1019) exist in the current spec; the mapping table must cover all 16 codes.
- Defects found in the legacy code are catalogued in the operator's private notes and are not ported.

---
## Open questions

1. Is GET /v1/pedido/{pedido_id} keyed by numero (as the examples suggest) or by the internal id? Does the internal id ever work?
2. Timezone of naive timestamps in GET responses (data_criacao/data_modificacao): America/Sao_Paulo or UTC? Same for the since_atualizado query parameter.
3. Is since_atualizado inclusive, and what is the default sort order of /v1/pedido/search? Is it stable under offset paging while orders keep changing?
4. Does Webhook Pedidos fire for changes that are not situação changes (tracking written, NF linked, payment updated), and with situacao_alterada=false? Retry policy, timeout, source IPs, and the meaning of the body field `token`.
5. Is one webhook registration per store or per application? What happens with two integrators on the same store?
6. Does PUT /v1/pedido_envio automatically move the situação to pedido_enviado? Does POST /v1/integration/pedido/nf automatically set `faturado` (1018)?
7. How do we obtain nf_id for GET /v1/pedido_nf/{nf_id}? Does the order payload expose an NF link not shown in the examples?
8. Does POST /v1/integration/pedido/nf work with Personal Token auth, given that account_key (the chave_api) is required in the body?
9. Exact id and flags of pagamento_devolvido_sem_retorno, and whether stores can have custom situações.
10. itens[].produto shape: an object {id_externo, resource_uri} as in the spec example, or a URI string? Does it change with an id_externo flag?
11. Does PUT /v1/situacao/pedido reject illegal transitions (e.g. out of final states)? What error shape does it return?
12. Enviali: can bill be called for an order whose forma_envio is not Enviali? What is order.id (the LI internal id or numero)? Does bill write the tracking code onto the LI order automatically? Volume unit in tracking responses (cm vs mm)?
13. Enviali paperType accepted values (spec says PdfA4|PdfZpl|Zpl, example uses "A4"), and what /enviali/v2/postage/doc returns (DCe/declaração PDF?).
14. Is CPF/CNPJ ever masked in API or webhook payloads (LGPD)? The examples show full values.
15. Can an order have more than one envios[] entry in practice (split shipments)?

## Questions for the operator

1. Should orders injected into LI by hubs (marketplace_info / id_anymarket / PAGAMENTOEXTERNO) be skipped, given that we may integrate the same marketplaces directly? Otherwise they would be imported twice.
2. Do the two LI stores use Enviali? If so, should the ERP buy Enviali labels (wallet-charged) for Enviali-quoted orders, or keep minting labels through Melhor Envio / our own freight stack and only write the tracking code back to LI?
3. Should the ERP drive LI order statuses (pedido_em_separacao, faturado, pedido_enviado, pedido_entregue, pronto_para_retirada)? Each change can trigger a buyer e-mail when notificar_comprador=true (re-verified 2026-10-07: LI help 924633 says the buyer is e-mailed on every status change; whether an API write fires the same e-mail is not documented, so assume any write to 11, 13 or 14 may e-mail the buyer regardless of the flag).
4. Which auth mode will be used: a Personal Token per store, or chave_api + chave de aplicação (integrator, IP-restricted)? The NF endpoint requires the store chave_api in the body.
5. Should we publish the NF-e to LI (it needs publicly reachable DANFE and XML URLs that we host), and should a CPF-seller store link DCe documents?
6. How should chargeback and dispute situações map in the ERP? Should cancelamento_solicitado block shipping?
7. Do you want to write our pedido id back to LI via id_externo? It must be an integer.

## Claims

| field | value | confidence | citations |
|---|---|---|---|
| importarPedido | sim. Search lists orders with filters since_numero/since_atualizado/situacao_id/pagamento_id/cliente_id/since_criado/until_criado, limit max 50 + offset; detail returns the full order; webhook pushes full order payloads | alta | spec GET /v1/pedido/search; spec GET /v1/pedido/{pedido_id}; spec tag Webhook Pedidos |
| importarPagamento | sim. Order carries pagamentos[] inline (forma_pagamento, pagamento_tipo, parcelamento, valor, valor_pago, bandeira, authorization_code, transacao_id, gateway code/message, banco, boleto_url, pix_code, pix_qrcode). No fee/net/settlement fields (inference: settlement unavailable) | alta | spec GET /v1/pedido/{pedido_id}; spec PUT /v1/pedido/{pedido_id}; spec tag Webhook Pedidos |
| consolidaPacote | nao. No endpoint or field groups several orders into one shipment; envios[] is per order; Enviali bill accepts a postage[] batch but each postage has its own order (inference from absence) | media | spec GET /v1/pedido/{pedido_id}; spec POST /enviali/v2/postage/bill |
| dadosFiscaisSeparados | nao. cliente and endereco_entrega are inline with cpf/cnpj/ie/rg/razao_social and full address; webhook also has endereco_pagamento; examples show unmasked documents; extra data via GET /v1/cliente/{id}, which is not gated | alta | spec GET /v1/pedido/{pedido_id}; spec tag Webhook Pedidos; spec GET /v1/cliente/{cliente_id} |
| etiqueta | emit. LI mints no label for ordinary orders; Enviali is an optional service (quote, buy from prepaid wallet with re-quote, download PDF/ZPL). Treat Enviali as a freight tipo with a per-order label mode; behaves like fetch only if we buy the label (inference) | media | spec GET /v1/envio; spec POST /enviali/v2/postage/bill; spec GET /enviali/v2/postage/pdf; spec tag Enviali; https://lojaintegrada.com.br/enviali |
| rastreio | pull. No tracking push; webhook is order-level; Enviali tracking is pulled; outbound we write tracking via PUT /v1/pedido_envio | media | spec GET /enviali/v2/postage/tracking/{tracking_codigo}; spec GET /enviali/v2/postage; spec PUT /v1/pedido_envio/{pedido_envio_id}; spec tag Webhook Pedidos |
| enviarNfe | sim. POST (insert) and PUT (update) take multipart account_key, sale_number, date, invoice_number, serie, access_key, url, url_xml; metadata plus URLs, no XML upload; GET /v1/pedido_nf/{nf_id} returns the stored NF | alta | spec POST /v1/integration/pedido/nf; spec PUT /v1/integration/pedido/nf; spec GET /v1/pedido_nf/{nf_id} |
| reclamacoes | nao. No claims/returns/disputes endpoint among the 25 tags and 76 paths; only situação codes (1019, 7, pagamento_devolvido_sem_retorno, 16, 6) | alta | spec tag Situações do pedido; spec GET /v1/situacao |
| assinaWebhook | sim, as a static shared-secret Bearer token (Authorization: Bearer <token>) chosen at registration; not an HMAC signature; receiver should fail closed when unset | alta | spec tag Webhook Pedidos; spec PUT /webhooks/v1/pedido |
| notificacoes | push. Webhook Pedidos pushes full order payloads; duplicates expected; LI says to filter situacao.situacao_alterada=true; polling via since_atualizado remains available as a backstop | alta | spec tag Webhook Pedidos; spec GET /v1/pedido/search |
| other:order-ids | GET /v1/pedido/{pedido_id} takes numero (inference from examples); internal id appears only in the webhook; id_externo is a writable integer | media | spec GET /v1/pedido/{pedido_id}; spec PUT /v1/pedido/{pedido_id}; spec tag Webhook Pedidos; legacy code |
| other:number-and-date-format | GET money/qty are decimal strings and dates are naive (likely -03:00, inference); webhook uses JSON numbers and Z/-03:00 timestamps | media | spec GET /v1/pedido/{pedido_id}; spec tag Webhook Pedidos |
| other:situacoes | 16 codes; flags aprovado/cancelado/final are unreliable as paid/cancelled signals (chargeback and dispute are aprovado:true; cancelamento_solicitado is cancelado:true, final:false); faturado is 1018; pagamento_devolvido_sem_retorno absent from the /v1/situacao example; terminal codes 7, 8, 11, 13, 14, 16 (re-verified 2026-10-07: id and flags of pagamento_devolvido_sem_retorno (1020) come only from legacy code and must be confirmed live; LI help 924633 treats that status as cancelled) | alta | spec tag Situações do pedido; spec GET /v1/situacao; legacy code (id 1020, unverified); https://ajuda.lojaintegrada.com.br/pt-BR/articles/924633 |
| other:situacao-write | PUT /v1/situacao/pedido/{pedido_id} {codigo}; transitions apparently not enforced (inference from history example), so we must enforce our own (re-verified 2026-10-07: strong evidence, not a documented rule; buyer e-mail behaviour on API writes is undocumented) | media | spec PUT /v1/situacao/pedido/{pedido_id}; spec GET /v1/situacao_historico/search; https://ajuda.lojaintegrada.com.br/pt-BR/articles/924633 |
| other:situacao-historico | per-order only (numero or id_externo); not a store-wide change feed | alta | spec GET /v1/situacao_historico/search |
| other:pedido-search-paging | limit max 50, offset paging, no documented ordering; cursor = since_atualizado | alta | spec GET /v1/pedido/search; old apib "Buscar pedidos"; spec GET /v1/cliente |
| other:throttling | 100 req/min per loja (633), 3000/min per aplicação (533), 1200/min per IP (133); HTTP 429 | alta | spec info |
| other:tracking-writeback | PUT /v1/pedido_envio/{envios[i].id} {objeto}; the order id must not be used | alta | spec PUT /v1/pedido_envio/{pedido_envio_id} |
| other:forma_envio-key-mismatch | GET uses forma_envio.code; webhook uses forma_envio.codigo | alta | spec GET /v1/pedido/{pedido_id}; spec tag Webhook Pedidos |
| other:enviali | prepaid-wallet label service; PAC/SEDEX for all, Jadlog/J&T on paid plans; x-correlation-id required; integer cents/cm/g; bill error codes (14 invoice required for business, 26 insufficient balance, 32 already billed); cancel scheduled up to 2 business days; tracking doc says volume in mm (contradiction) | alta | spec tag Enviali; spec POST /enviali/v2/postage/bill; spec GET /enviali/v2/wallets; spec DELETE /enviali/v2/postage; spec GET /enviali/v2/postage/tracking/{tracking_codigo}; https://lojaintegrada.com.br/enviali; https://intercom.help/loja-integrada/pt-BR/articles/14601164-como-gerar-etiquetas-e-postar-envios-pela-j-t-express-no-enviali |
| other:dce | link/unlink/read an external DCe by order numero; DCe mandatory from 2026-04-06; auto-generated by Enviali | alta | spec tag DCE; spec POST /v1/integration/pedido/dce; spec GET /v1/pedido_dce/{pedido_id}; https://ajuda.lojaintegrada.com.br/pt-BR/articles/12384787-o-que-e-a-dce-declaracao-de-conteudo-eletronica |
| other:integration-sales | for hubs creating orders INTO LI; not needed for import, but implies a dedup risk (hub orders surface as marketplace_info, id_anymarket and PAGAMENTOEXTERNO) | alta | spec tag Integrações de pedido; spec POST /v1/integration/sales; spec PUT /v1/integration/sales/{sale_id}; spec tag Webhook Pedidos |
