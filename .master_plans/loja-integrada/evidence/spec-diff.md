# Spec diff — the deprecated Apiary spec vs the current OpenAPI v2

**Provenance.** Compiled on 2026-10-07. Sources: (a) the current "API Loja Integrada" v2 OpenAPI 3.1 document (server `https://api.awsli.com.br`, 76 paths), cited below as `spec <METHOD> <path>`, `spec tag <Tag>` and `spec info`; (b) the deprecated "Loja Integrada API - VERSAO BETA" 1.0.0 description (OpenAPI 3.0.3 and API Blueprint exports, host `https://api.awsli.com.br/v1/`), cited as "deprecated spec". The public Apiary site (`https://lojaintegrada.docs.apiary.io/`, title "Loja Integrada API - Versao descontinuada") returned only its title and intermittent 502 errors, so the deprecated content was NOT diffed against the live Apiary page; the exported files are assumed (inference) to mirror it. Findings about the legacy application code are catalogued in the operator's private notes and are not ported here.

## 1. Cross-cutting changes (deprecated -> current)

| Aspect | Deprecated spec | Current spec (`spec info` / tags) |
|---|---|---|
| Title / version | "Loja Integrada API - VERSAO BETA" 1.0.0 | "API Loja Integrada" v2 |
| Base | `https://api.awsli.com.br/v1/` (paths carry no `/v1`) | `https://api.awsli.com.br`; paths carry `/v1`, plus `/enviali/v2`, `/webhooks/v1`, `/v3/marketing` |
| Auth | `chave_api` + `chave_aplicacao` via query/body, or header `Authorization: chave_api <k> aplicacao <k>`; keys obtained from support | Header `Authorization` only, two mutually exclusive schemes: `Basic <Personal Token>` (identifies the merchant, unique per store) OR `chave_api <k> aplicacao <k>`. One combination per request. Integrator credentials are IP-restricted (wrong IP returns an error). securitySchemes: `chave_api_aplicacao`, `personal_token` (both apiKey/header/Authorization) |
| Throttling | per application 3000/min (err 533), per store 100/min (err 633), per IP 1200/min (err 133); HTTP 429 | Identical numbers and codes |
| Pedido search page size | `limit` max 100 | `limit` max 50 (`spec GET /v1/pedido/search` description) |
| Pedido search filters | prose: since_numero, since_atualizado, cliente_id, pagamento_id, situacao_id, since_criado, until_criado, limit, offset | Same prose list, but the declared query parameters are only since_numero, situacao_id, pagamento_id, limit (spec/prose mismatch) |
| Situacoes | 14 codes | `spec tag Situacoes do pedido` lists 16 codes (adds `cancelamento_solicitado` id 1019 and `faturado` id 1018) |
| Spec quality | examples only, no response schemas | response schemas and examples for most operations; some path typos remain (section 4) |
| New surfaces | none | Webhooks (pedido, produto), Enviali v2 (labels, wallet, tracking), NF/DCE endpoints, Newsletter, `/v3/marketing/*`, `/v1/cliente/search`, cliente grupo, marca_imagem, produto alias, grade_variacao image links |

## 2. Endpoint diff

Compared as METHOD + path, ignoring the `/v1` prefix and parameter names. 57 operations are unchanged in path and method.

**Removed from the current spec (present in the deprecated one):**
- `GET /produto_estoque/set/{ids}` (bulk stock read, including the `?id_externo=1` variant)
- `GET /produto_preco` (list); the current spec only has the typo path `GET /v1/{produto_preco}` (a templated variable named `produto_preco`, clearly meant as `/v1/produto_preco`)
- `GET /seo` (list)
- `GET /banco`, `GET /banco/{id}`
- `GET /situacao_historico` (list); only `/situacao_historico/search` remains
- The `?id_externo=1` flag variants are now an `id_externo` integer query parameter on the base paths rather than separate paths (cosmetic).

**Added in the current spec:**
- Webhooks: `PUT`/`DELETE /webhooks/v1/pedido`, `PUT`/`DELETE /webhooks/v1/produto`
- Enviali: `GET /enviali/v2/postage`, `DELETE /enviali/v2/postage`, `POST /enviali/v2/postage/bill`, `GET /enviali/v2/postage/doc`, `POST /enviali/v2/postage/estimate`, `GET /enviali/v2/postage/pdf`, `GET /enviali/v2/postage/tracking/{tracking_codigo}`, `GET /enviali/v2/postage/{postage_id}`, `GET /enviali/v2/wallets`
- NF/DCE: `PUT /v1/integration/pedido/nf`, `POST`+`DELETE /v1/integration/pedido/dce`, `GET /v1/pedido_nf/{nf_id}`, `GET /v1/pedido_dce/{pedido_id}`
- Clientes: `GET /v1/cliente/search` (cliente_email, since_criado/until_criado, since_atualizado, ...), `PUT /v1/cliente/{id}/grupo` (body `{"grupo": "VIPS"}`), `POST`/`GET /v1/newsletter`
- Produto: `PUT /v1/produto/{id}/alias` (absolute_path, replace_main), `DELETE /v1/produto_imagem/{id}` (204), `GET`/`PUT`/`DELETE /v1/produto_imagem/{id}/grade_variacao/{grade_variacao_id}` (imagens_ids)
- Marca: `DELETE /api/v1/marca/{marca_id}` (note the odd `/api/v1` prefix), `PATCH`/`DELETE /v1/marca_imagem/{id}`, `PATCH /v1/marca_imagem/{id}/arquivo`
- Marketing v3: about 16 operations under `/v3/marketing` (automations, rules, campaign, newsletter, awaiting/list); not relevant to a marketplace channel.

Note: `DELETE /v1/produto_imagem/{id}` did not appear in the deprecated spec and is documented only now.

## 3. Field-level changes on the core resources

- **`PUT /v1/produto_estoque/{produto_id}`**: body keeps the same four fields (`gerenciado`, `quantidade`, `situacao_em_estoque`, `situacao_sem_estoque`); types tightened from number to integer. The response now has a schema: gerenciado, id, produto (URI), quantidade, quantidade_disponivel, quantidade_reservada, resource_uri, situacao_em_estoque, situacao_sem_estoque. The path parameter is the PRODUCT id (`resource_uri` uses the product id; `id` is the stock row id, a different number).
- **`PUT /v1/produto_preco/{produto_id}`**: deprecated body `{cheio, custo, promocional}`; current adds `sob_consulta` (boolean). `promocional` is typed `integer` while `cheio`/`custo` are `number` (very likely a spec typo; see open questions). Response prices are strings in the schema.
- **`GET /v1/produto/{id}`**: adds read-only inline `preco_cheio`, `preco_custo`, `preco_promocional`, `preco_sob_consulta`, `estoque_gerenciado`, `estoque_situacao_em_estoque`, `estoque_situacao_sem_estoque`, `estoque_quantidade`, `tags`, `ncm`/`gtin`/`mpn` (non-null strings), `imagem_principal` (object with CDN URLs) and `imagens[]` (caminho, grande, icone, media, pequena, mime, posicao, principal, imagem_id, id_anymarket). Prose: price/stock fields are GET-only; changing them requires `PUT /v1/produto_estoque` and `PUT /v1/produto_preco`. `peso` is a string in responses ("0.500") and a number in requests.
- **`POST /v1/produto` body schema (current)**: id_externo, sku, mpn, ncm, nome, apelido, descricao_completa, ativo, destaque, peso, altura, largura, profundidade, tipo, usado, categorias[], marca, removido. The deprecated example additionally had `pai` and `variacoes[]` (the parent/child "atributo" / "atributo_opcao" model). The current POST schema DROPS them although the prose still says the child must carry `pai` (a parent-product URI) with tipo `atributo_opcao`. `PUT` body keeps `pai`. This is a documentation regression that must be settled by a live call.
- **Product types** (prose, both versions): `normal` (simple), `atributo` (parent with grades), `atributo_opcao` (child). A listing with variations is a parent produto plus one produto per variation, each with its own stock and price row.
- **`GET /v1/produto` filters (current)**: sku, data_modificacao__gte/__lte, ativo declared; prose adds removido, `<campo>__lt/lte/gt/gte`, `data_criacao`. The description is omitted unless `?description_html=1` (list prose) / `descricao_completa=1` (detail prose); two different flag names across the prose. (re-verified 2026-10-07: only sku, ativo, data_modificacao__gte and data_modificacao__lte are declared query parameters; `removido` is in the operation prose only; no documented filter by tipo or pai; the spec's own example `?data_criacao_gt=` uses a single underscore, an apparent typo for `__gt`, so prefer the double-underscore form; pagination is limit/offset with a `meta` block, default limit 20, and the spec states a max of 50 only for pedido, not for produto.)
- **`GET /v1/pedido/{id}`**: 91 fields identical; added `id_anymarket`, `id_externo`, `cliente_obs`, `envios[].forma_envio.code/tipo`, `pagamentos[].banco`, `pagamentos[].parcelamento{numero_parcelas, valor_parcela}`, `itens[].produto{resource_uri, id_externo}` (now an object; it was a string URI in the deprecated example); removed `pagamentos[].pagamento_banco`. Nullability changes: cliente.data_nascimento, endereco_entrega.complemento/referencia/rg, itens[].altura/largura/profundidade.
- **`PUT /v1/pedido/{id}`** (id_externo): body `id_externo` number -> integer; response 202 -> 200.
- **`PUT /v1/pedido_envio/{id}`**: body `{objeto}`; response 202 -> 200; same semantics. The id is that of `envios[0]`, NOT the pedido id.
- **`PUT /v1/situacao/pedido/{pedido_id}`**: body `{codigo}`; 202 -> 200. `GET /v1/situacao/pedido/{id}` unchanged.
- **`GET /v1/situacao`**: the current example has 15 objects (total_count 15) while the tag prose lists 16 codes; `pagamento_devolvido_sem_retorno` (id 1020) is missing from the example. (re-verified 2026-10-07: that codigo appears only as a string in the tag prose, with no id and no flags in the spec; its id and flags must be confirmed against a live `GET /v1/situacao`. LI help article 924633 says this status is treated as cancelled, so do not rely on the `aprovado`/`cancelado` flags for it; map by codigo or id, not by the flags.)
- **`GET /v1/situacao_historico/search`**: adds `?id_externo=`; items gain `obs`.
- **produto_imagem**: POST body `{imagem_url, produto (URI), principal, posicao, mime}` unchanged; NEW rule: if `principal: true`, `posicao: 0` is mandatory. The response `posicao` is a string.
- **Grades / variacoes**: `POST /grades {nome, nome_visivel}`; `POST /grade/{id}/variacao {nome}`; GET adds `id_externo`. Essentially unchanged.
- **cliente GET**: `newsletter` removed. **seo GET**: `keyword` removed from the example (the SEO tag prose still lists title/keyword/description).
- **`POST /v1/integration/sales`**: same envelope (buyer, shipping.address, shipping.option, amount, items[product_id, quantity, unit_value, line_value], info{status, marketPlaceId, reference, comment}, integration_data{integrator, marketplace, external_id, unique_id}); `shipping.address.street` dropped; the Authorization header parameter was removed from the operation (global now); `PUT /v1/integration/sales/{sale_id}` now takes the same body as POST (the deprecated one had a different, incompatible shape with account_id/contract_id); responses 202 -> 200.
- **NF**: `POST /v1/integration/pedido/nf` is now multipart/form-data with account_key, sale_number, date, invoice_number, serie, access_key, url, url_xml (`url_xml` new); `PUT` added. **DCE** (multipart): order_number, access_key (44 digits), url_xml.
- **Webhook payload** (`spec tag Webhook Pedidos`): header `Authorization: Bearer <registered token>`; consider only `situacao.situacao_alterada == true` (duplicates are expected); the body includes numero, valor_*, cliente{cpf, cnpj}, endereco_entrega/pagamento{cpf, cnpj, ie, rg, ...}, envios, pagamentos, situacao{id, codigo, aprovado, cancelado, final, situacao_alterada}, marketplace_info, itens[]. Fiscal identity is inline in the pedido (webhook and `GET /v1/pedido/{id}`). Registration: `PUT /webhooks/v1/pedido {notifyUrl, token}` -> `{message: "Registros afetados: N"}`; `DELETE` takes the same body. The Webhook Produtos payload is an ARRAY of full product objects including preco_*, estoque_*, `disponivel`, `comprimento`. (Example values in the spec are personal data and are deliberately not reproduced; use `<redacted>` or obviously fake values such as 000.000.000-00.)

## 4. Spec quality issues to keep in mind

- Typo path `GET /v1/{produto_preco}` instead of `/v1/produto_preco`.
- `promocional` typed integer in the price body.
- Pedido search: declared parameters differ from the prose filter list (`since_atualizado` is prose only).
- Two different flag names for including the product description (`description_html`, `descricao_completa`).
- `GET /v1/situacao` example has 15 of the 16 documented codes.
- `POST /v1/produto` schema omits `pai` / `variacoes` that the prose still requires.
- `DELETE /api/v1/marca/{marca_id}` carries an anomalous `/api/v1` prefix.

## 5. Open questions (to settle with live calls, never from the spec alone)

1. Does `POST /v1/produto` still accept `pai`, `variacoes[]` and `grades[]` for creating atributo / atributo_opcao products? (The current POST schema omits them; PUT keeps `pai`.)
2. Do endpoints accept the trailing-slash path forms used in the deprecated spec (`/produto/`, `/pedido/search/`, `/produto_imagem/`)?
3. Is `since_atualizado` inclusive or exclusive, and is `/pedido/search` ordered by data_modificacao? Is `offset` still honored with limit <= 50?
4. Is `limit` max really 50 on `/pedido/search`, and what are the default and max on `/produto` and `/produto_imagem`?
5. Does Webhook Pedidos retry on non-2xx, with what timeout, and is event order guaranteed? Is the payload `token` field equal to the Bearer token?
6. Is there any HMAC signature on webhooks beyond the static Bearer token?
7. Does a webhook fire for orders created through `POST /v1/integration/sales` (our own writes) and for `marketplace_info` orders?
8. Is `promocional` of `PUT /v1/produto_preco` truly integer, or does it accept decimals?
9. What do `description_html=1` and `descricao_completa=1` actually control on `GET /v1/produto`?
10. Is id 1020 `pagamento_devolvido_sem_retorno` returned by `GET /v1/situacao`?
11. Are Personal Token and integrator `chave_aplicacao` rate-limited per store identically, and how are IP restrictions enforced for a Cloud Functions egress IP?
12. Does `PUT /v1/produto_estoque` with `gerenciado=false` zero the four fields on read-back (Estoque tag prose)?
13. Can image-to-variation linking (`PUT /v1/produto_imagem/{id}/grade_variacao/{id}`) support per-variation images?

Decisions for the operator (not answerable from the spec): webhook-first with polling as a backstop vs polling only; whether the channel creates/updates products in LI (parent/child model) or is limited to order import plus stock/price/tracking sync; whether credentials are an IP-restricted integrator key or per-merchant Personal Tokens; how the two new situacoes (`cancelamento_solicitado`, `faturado`) map to ERP states.

## 6. Claims

| field | value | confidence | citations |
|---|---|---|---|
| auth | Static header credentials: `Basic <Personal Token>` OR `chave_api <key> aplicacao <key>`; no OAuth. Integrator credentials are IP-restricted. | alta | spec info; spec components.securitySchemes |
| pkce | nao (no OAuth in the spec; inference from absence) | alta | spec info |
| notificacoes | push (webhooks pedido and produto) plus poll via `GET /v1/pedido/search?since_atualizado` | alta | spec tag Webhook Pedidos; spec PUT /webhooks/v1/pedido; spec GET /v1/pedido/search |
| assinaWebhook | Authenticated by the static bearer token registered with the URL, sent as `Authorization: Bearer <token>`; no payload signature documented; the example body also carries a `token` field. Inference: treat as an authenticated channel and fail closed when the secret is unset. | media | spec tag Webhook Pedidos |
| estoque.protocolo | por-anuncio: one PUT per produto, no batch; the deprecated bulk read `/produto_estoque/set` was removed | alta | spec PUT /v1/produto_estoque/{produto_id}; deprecated spec /produto_estoque/set/{estoques_id} |
| estoque.loteMax | null (no batch stock endpoint among the 76 paths; inference from absence) | media | spec paths |
| variacoes | sim: parent/child product family (tipo atributo / atributo_opcao; the child carries a `pai` URI and grade-variacao URIs) | alta | spec POST /v1/produto; spec tag Grades |
| dadosFiscaisSeparados | nao: cpf/cnpj/ie/rg inline in cliente and endereco_entrega of the pedido | alta | spec tag Webhook Pedidos; spec GET /v1/pedido/{pedido_id} |
| rastreio | push via `PUT /v1/pedido_envio/{envio_id} {objeto}` | alta | spec PUT /v1/pedido_envio/{pedido_envio_id} |
| enviarNfe | sim: `POST`/`PUT /v1/integration/pedido/nf` (multipart); DCE link `POST`/`DELETE /v1/integration/pedido/dce` | alta | spec POST /v1/integration/pedido/nf; spec POST /v1/integration/pedido/dce |
| enviarPreco | sim: `PUT /v1/produto_preco/{produto_id} {cheio, custo, promocional, sob_consulta}` | alta | spec PUT /v1/produto_preco/{produto_id} |
| importarPedido | sim: webhook push or `GET /v1/pedido/search` + `GET /v1/pedido/{id}`; `POST /v1/integration/sales` creates orders in LI for marketplace-origin orders | alta | spec GET /v1/pedido/search; spec POST /v1/integration/sales |
| other:throttling | 3000/min per application (err 533), 100/min per store / chave_api (err 633), 1200/min per IP (err 133); HTTP 429; identical in the deprecated spec | alta | spec info; deprecated spec Limites (Throttling) |
| other:pedido-search-page-size | `limit` max 50 (deprecated spec said 100) | alta | spec GET /v1/pedido/search; deprecated spec |
| other:situacoes | 16 codes in the current prose (adds `faturado` 1018 and `cancelamento_solicitado` 1019); the deprecated spec had 14 (re-verified 2026-10-07: no single spec source lists all 16 with ids; the `GET /v1/situacao` example has 15 objects and the 16th codigo, `pagamento_devolvido_sem_retorno`, appears only as a string in the tag prose; map by codigo or id, not by the aprovado/cancelado flags) | alta | spec tag Situacoes do pedido; spec GET /v1/situacao |
| other:GET /pedido/search | Exists as `GET /v1/pedido/search`; limit max 50; `since_atualizado` only in prose | alta | spec GET /v1/pedido/search |
| other:GET /pedido/{id} | Exists, additive changes (id_externo, id_anymarket, cliente_obs, parcelamento, itens[].produto object) | alta | spec GET /v1/pedido/{pedido_id} |
| other:GET /situacao_historico/search | Exists (+ id_externo filter, obs field) | alta | spec GET /v1/situacao_historico/search |
| other:PUT /situacao/pedido/{pedido_id} | Exists, body `{codigo}`; 202 -> 200 | alta | spec PUT /v1/situacao/pedido/{pedido_id} |
| other:PUT /pedido_envio/{envio_id} | Exists, body `{objeto}`; id is `envios[0].id` | alta | spec PUT /v1/pedido_envio/{pedido_envio_id} |
| other:GET /produto | Exists (list + filters sku / ativo / data_modificacao__gte / __lte; removido in prose only); paginated via `meta.next` (re-verified 2026-10-07: default limit 20; no documented filter by tipo or pai) | alta | spec GET /v1/produto |
| other:GET /produto/{id} | Exists; response gained inline preco_* and estoque_* read-only fields, ncm/gtin/mpn, tags | alta | spec GET /v1/produto/{produto_id} |
| other:POST /produto | Exists, but the current request schema dropped pai / variacoes / grades; verify live | media | spec POST /v1/produto |
| other:PUT /produto/{id} | Exists; requires the FULL product; supports `pai` and `?id_externo=1` | alta | spec PUT /v1/produto/{produto_id} |
| other:PUT /produto_estoque/{id} | Exists (integer types); path id is the product id | alta | spec PUT /v1/produto_estoque/{produto_id} |
| other:GET /produto_estoque | List and by-id exist; `GET /produto_estoque/set/{ids}` REMOVED | alta | spec GET /v1/produto_estoque |
| other:PUT /produto_preco/{id} | Exists; adds sob_consulta; promocional typed integer (likely typo) | alta | spec PUT /v1/produto_preco/{produto_id} |
| other:GET /produto_preco/{id} | Exists; the list endpoint exists only under the typo path `/v1/{produto_preco}` | alta | spec GET /v1/{produto_preco}; spec GET /v1/produto_preco/{produto_id} |
| other:GET /produto_imagem | Exists (query `produto=ID`) | alta | spec GET /v1/produto_imagem |
| other:POST /produto_imagem | Exists; new rule principal=true requires posicao=0 | alta | spec POST /v1/produto_imagem |
| other:DELETE /produto_imagem/{id} | Documented now (204); absent from the deprecated spec | alta | spec DELETE /v1/produto_imagem/{produto_imagem_id}; deprecated spec |
| other:GET /marca/{id} | Exists (adds ativo) | alta | spec GET /v1/marca/{marca_id} |
| other:GET /categoria/{id} | Exists (adds url) | alta | spec GET /v1/categoria/{categoria_id} |
| other:grades endpoints | `GET`/`POST /grades`, `POST /grade/{id}/variacao` exist unchanged | alta | spec POST /v1/grades |
| other:removed endpoints | `GET /produto_estoque/set`, `GET /banco`, `GET /seo`, `GET /situacao_historico`, `GET /produto_preco` removed from the current spec | alta | deprecated spec; spec paths |
| other:new surfaces | `/webhooks/v1/{pedido,produto}`, `/enviali/v2/*`, `/v1/integration/pedido/{nf,dce}`, `/v1/pedido_nf`, `/v1/pedido_dce`, `/v1/cliente/search`, `/v1/cliente/{id}/grupo`, `/v1/newsletter`, `/v3/marketing/*` | alta | spec paths; spec info (Novidades) |
| other:deprecated-apiary | The Apiary site is titled "Loja Integrada API - Versao descontinuada"; its body was not retrievable (502; only the title returned) | media | https://lojaintegrada.docs.apiary.io/ |
