# Survey A — authentication, account model, limits, inbound events

Provenance: research dated 2026-10-07 for the Loja Integrada (LI) marketplace integration. Sources: the current OpenAPI 3.1 spec "API Loja Integrada" (info.version "v2", server `https://api.awsli.com.br`), the legacy Apiary spec copies (`.apib` and `.json`) used for old-vs-new comparison, and LI help-center articles. Citations use `spec info`, `spec tag <Tag>`, `spec <METHOD> <path>`, and article numbers or URLs. Defects found in the legacy code are catalogued in the operator's private notes and are not ported here. The legacy client authenticates with the chave_api + aplicacao combination. Personal data in spec examples is redacted. Items marked "inference" are not documented and must be confirmed with a live call.

---

## 1. Capability fields

| field | value | confidence | basis |
|---|---|---|---|
| auth | `api-key` | high | `spec info`: two static header credentials, `Basic <Personal Token>` or `chave_api <key> aplicacao <app key>`. No OAuth anywhere in the spec (securitySchemes `chave_api_aplicacao` and `personal_token` are both `type: apiKey, in: header, name: Authorization`). The personal token expires every 3 months and only a manual click in the painel renews it (see §2). |
| pkce | `nao` | high | There is no OAuth flow, so PKCE does not apply (`spec info`, `components.securitySchemes`). |
| notificacoes | `push` | high | `spec PUT /webhooks/v1/pedido` and `spec PUT /webhooks/v1/produto` register a `notifyUrl`. Help article 9655071 lists the events: products "criado e editado", orders "criado e editado [alteração de situação (status)]". Polling is possible as a backstop through `since_atualizado` (§5). |
| assinaWebhook | `sim` (static shared bearer secret, **not** an HMAC signature) | high | `spec tag Webhook Pedidos`: the `token` given at registration "será enviado no header de cada hook enviado" as `"Authorization": "Bearer token_que_sera_enviado_no_header"`. We choose that token (`spec PUT /webhooks/v1/pedido` requestBody `{notifyUrl, token}`). The body is not signed, so integrity and replay are not protected; only knowledge of the secret is proven. The receiver should fail closed (secret unset => 503) and use a constant-time compare (design recommendation). |
| dadosFiscaisSeparados | `nao` | high | `spec GET /v1/pedido/{pedido_id}` 200 example has `cliente.cpf/cnpj/razao_social` and `endereco_entrega.{tipo:"PF", cpf, cnpj, ie, rg, razao_social, endereco, numero, bairro, cidade, estado, cep}` inline (values redacted here). The webhook order example (`spec tag Webhook Pedidos`) carries the same fields. |

---

## 2. Credentials and account model

### 2.1 What the spec says (`spec info`)
- Credentials go in the `Authorization` header in one of "duas combinações fixas — não é possível misturar os tipos":
  - `Basic` + Personal Token. "o Personal Token identifica o lojista — é único e exclusivo por loja."
  - `chave_api` + `aplicacao`. "a Chave de API identifica a loja, e a chave de aplicação identifica o integrador."
- "Apenas uma dessas combinações deve ser usada por requisição."
- "Credenciais para integradores possuem restrição por IP. Qualquer tentativa de acesso diferente do que fora definido anteriormente no registro de parceiros, retornará ERRO."
- Literal header examples use placeholders: `Authorization: chave_api <key> aplicacao <app-key>` and `Authorization: Basic <token>`. The token goes after `Basic` as-is. The docs never say to base64-encode it, and the example value is the raw token (inference: do not base64 it; confirm with a live call).
- Note: the spec's "Como gerar o Personal Token?" link points to article 5360466, which is the partner app-key article. The personal-token procedure is in article 931152.

### 2.2 Personal Token (help article 931152, https://ajuda.lojaintegrada.com.br/pt-BR/articles/931152-como-gerar-chaves-de-api-e-o-personal-token-chave-de-aplicacao-da-minha-loja)
- **Issued by:** the store, in Configurações > Chave para API > Personal token > "Gerar personal token". "apenas o usuário proprietário da loja consegue gerar o personal token". Administrador and Membro profiles cannot.
- **Requirement:** "Ter um plano pago ativo na Loja Integrada".
- **Self-sufficient:** it "autentica por conta própria, sem precisar de Chave API" and is sent as `Authorization: Basic <token>`.
- **Shown once:** it is "exibido uma única vez". Support cannot recover it; the only option is "Trocar token".
- **Cardinality:** "até 5 personal tokens ativos por vez".
- **Lifetime:** 3 months. One month before expiry a "Renovar" button and a painel alert appear. Renewal keeps the **same token** and grants 3 more months counted from the click (not cumulative). If it is not renewed, "o token é revogado automaticamente" and cannot be reactivated.
- **Revocation:** "Remover" in the painel takes effect immediately.
- **Model change:** the old store-level "chave de aplicação" model "será descontinuada em **05/10/2026**". After that date "requisições feitas com a chave antiga passam a ser recusadas". As of 2026-10-07 that cut-over happened two days earlier.
- Article 12542786 (https://ajuda.lojaintegrada.com.br/pt-BR/articles/12542786-como-usar-make-n8n-ou-zapier-com-a-loja-integrada): "o formato com chave_api aplicacao no mesmo Header é usado apenas por aplicativos de parceiros. Se sua automação foi configurada nesse formato, substitua pelo personal token."

### 2.3 Chave de API (store key; articles 931152 and 5360466)
- **Issued by:** the store, in Configurações > Chave para API > "Cadastrar nova chave" with an "Identificação da Chave" label.
- **Format and cardinality:** a 20-character credential. Several can exist ("Você pode criar múltiplas chaves para diferentes serviços").
- **Lifetime:** "As Chaves API não expiram". The key stays visible in the painel and is removable individually. It needs a paid plan.
- **Use:** "sozinha ela não autentica uma requisição"; it must be paired with an integrator's chave de aplicação.

### 2.4 Chave de aplicação (integrator key; article 5360466, https://ajuda.lojaintegrada.com.br/pt-BR/articles/5360466-como-obter-a-chave-de-aplicacao-para-integrar-com-a-loja-integrada)
- **Issued by:** "a equipe técnica da Loja Integrada, quando o solicitante é um provedor de solução". Requested through a form linked from the article (https://f.nativeforms.com/solicitaco-atualizacao-chave-aplicacao). The form is free and covers both the original request and IP-list updates.
- **Timing:** "5 a 10 dias úteis".
- **Prerequisites:** be a solution provider, and have "acesso a uma loja ativa na Loja Integrada para testes (pode ser uma loja de demonstração)". "Solicitações enviadas por lojistas não são processadas."
- **Contacts:** follow-up at the partnerships address given in the article; technical support at the integrator-support address given in the article (3 to 5 business days, only after the key is issued).
- **Partner programme:** the commercial partnership form (https://forms.gle/DV3aQ67kTHnJGE958) is separate and "não substitui a solicitação de Chave de Aplicação".

### 2.5 IP restriction
- **What is restricted:** the integrator **chave de aplicação**. "As Chaves de Aplicação são vinculadas aos endereços IP informados na solicitação. Requisições vindas de qualquer origem fora dessa lista são rejeitadas." (article 5360466)
- **How IPs are declared:** in the request form. The article says to list "todos os IPs utilizados pela integração, incluindo servidores de produção, workers, filas e jobs agendados". Infrastructure changes require re-filing the update form before requests start failing. No maximum count is stated.
- **Error returned:** the spec says only that it "retornará ERRO". No status code or body is documented.
- **Personal token:** no source mentions an IP restriction (inference: personal-token auth does **not** need a static egress IP; only a live call from a varying Cloud Run egress settles it).
- **Architectural consequence (inference):**
  - If this ERP integrates its own stores, use the personal token: no form, no IP whitelist, no static-egress cost. The cost is a 3-month manual renewal by the store **owner**; missing it is a silent outage risk, so plan an expiry reminder and a 401 alarm.
  - If the ERP will be offered to third-party LI stores, it needs a partner chave de aplicação, which is IP-bound and needs static egress (see `.master_plans/shopee` §2.2, where the egress-proxy cost was already studied).

### 2.6 Legacy context
The legacy client used the `chave_api` + `aplicacao` header model and also an older query-string mechanism documented only in the deprecated Apiary docs; the current spec documents only the header. Whether the legacy application key is an old-model store-level key (discontinued 05/10/2026) or a partner key bound to an IP list is an open question (§9). (re-verified 2026-10-07: The store owner confirmed on 2026-10-07 that the legacy integration still works; a re-verification found its key is most likely an old-model application key, which LI's help 931152 says is refused from 05/10/2026 — so it may be refused at any time (a risk for the live system until the cutover).) Defects found in the legacy code are catalogued in the operator's private notes and are not ported.

---

## 3. Throttling

- **Documented limits** (`spec info`, same table in the legacy Apiary spec copy):
  - per application (`chave_aplicacao`): 3,000 req/min, error code 533
  - per store (`chave_api`): 100 req/min, code 633
  - per IP: 1,200 req/min, code 133
- **Status:** exceeding any limit returns HTTP `429` "acompanhado do código de erro correspondente".
- **Not documented:** a `Retry-After` header, window semantics (fixed vs sliding, burst allowance), the 429 body shape, and which bucket a Personal-Token request counts against.
  - Inference: the per-store 100/min bucket applies to the store either way.
  - No "Retry" or "retry" string appears anywhere in the spec (searched).
- **Practical bound (inference):** at about 1.67 req/s per store, a per-SKU stock or price push for 1,000 SKUs takes at least 10 minutes. A client needs a per-store token bucket (about 90/min), backoff on 429, and should keep codes 533/633/133 for diagnostics.

## 4. Error envelope and status codes

- **v1 resources:** no generic error schema. The status codes documented across all 76 paths are only 200, 201, 204, 400, 404 and 409. 401, 403 and 429 are absent.
  - The single v1 error example is `spec PUT /v1/produto/{produto_id}/alias` 409, with a bare JSON string body `"Slug already in use."`.
- **Enviali v2:** a problem-details-like object `{"title":"PostageExpired","detail":null,"id":"","code":4,"status":400}` (`spec GET /enviali/v2/postage/doc`, `/pdf` 400).
  - `spec tag Enviali` says to send a UUID in the `x-correlation-id` header; on errors it is echoed in the `id` field.
- **Marketing v3:** documented only by descriptions, e.g. 404 "Campanha não encontrada" and 400 "Formato de e-mail inválido".
- **Old freight response** (legacy Apiary spec): `"erros": []`, with per-item `"erro":"0","msg_erro":null`.
- **Conclusion (design recommendation):** the client must parse defensively (string, object, or empty body) and treat the 401/403/IP-rejection shape as unknown until a live call.

## 5. Pagination, polling cursors, ids, dates, money

### 5.1 Pagination
- Tastypie style: request `limit` and `offset`. The response is `{meta:{limit, next, offset, previous, total_count}, objects:[...]}` (e.g. `spec GET /v1/pedido/search`, `spec GET /v1/produto_estoque`, `spec GET /v1/categoria`).
- `meta.next` is a **relative URI with an `/api/v1` prefix**, e.g. `"/api/v1/produto_estoque?limit=20&offset=20"`, while the spec paths use `/v1/...`. `resource_uri`s also use `/api/v1/...`, and one spec path is `/api/v1/marca/{marca_id}`. Inference: both prefixes resolve on api.awsli.com.br; verify before following `next` verbatim.
- **Default page size** is 20 in the examples.
- **Max for `pedido/search`:** "o máximo aceito é 50" (`spec GET /v1/pedido/search`). The old Apiary spec said 100.
- No maximum is documented for other lists. (re-verified 2026-10-07: the spec states a max of 50 only for pedido, not for produto.)
- `/v3/marketing/*` uses `page`/`pageSize` instead (`spec GET /v3/marketing/awaiting/list`).

### 5.2 Date filters usable as cursors

`GET /v1/pedido/search` (`spec GET /v1/pedido/search`):
- Prose filters:
  - `since_numero`: "número igual ou maior"
  - `since_atualizado`: "atualizados a partir da data e hora especificada"
  - `since_criado`: "a partir da"
  - `until_criado`: "criados antes da"
  - plus `cliente_id`, `pagamento_id`, `situacao_id`
- Format: `AAAA-MM-DDTHH:MM:SS`, "onde a hora é opcional", e.g. `?since_atualizado=2023-06-01T08:30:22`.
- Only `since_numero`, `situacao_id`, `pagamento_id` and `limit` are declared as OpenAPI parameters; the rest exist only in prose.
- There is no `until_atualizado` for pedidos.
- Inclusive or exclusive: "a partir de" reads inclusive and "antes da" reads exclusive (inference).
- Result ordering is undocumented. Order items by `data_modificacao` on the client if ordering matters (design recommendation).

`GET /v1/produto` (`spec GET /v1/produto`):
- `(campo)__lt`, `__lte`, `__gt`, `__gte` or exact `(campo)=` on `data_modificacao` and `data_criacao`.
- Format `2022-01-01 10:20:00` (space separator, hour optional).
- Also `sku`, `ativo`, `removido`, and `description_html=1` to include the description. (re-verified 2026-10-07: the declared query parameters are only `sku`, `ativo`, `data_modificacao__gte` and `data_modificacao__lte`; `removido`, the other date operators and `data_criacao` appear only in the operation prose; no filter by `tipo` or `pai` is documented.)
- The doc example `data_criacao_gt` (single underscore) appears to be a typo for `__gt`.

`GET /v1/produto_estoque`: no filters documented at all. A stock-change delta cannot be polled; it is a full scan only (`spec GET /v1/produto_estoque`).

`GET /v1/situacao_historico/search`: only `numero` or `id_externo`, with no date filter. The response items carry `data`, `situacao`, `situacao_anterior`, `alterado_por`, `alterado_por_nome` (`spec GET /v1/situacao_historico/search`).

`GET /v1/cliente/search`: `since_criado`/`until_criado`, `since_atualizado`/`until_atualizado`, `cliente_email`. Results are "ordenado por ordem de modificação mais recente".

### 5.3 Timezone
- REST dates are naive, with no offset, e.g. `"data_modificacao":"2022-10-31T12:28:12.653648"` (`spec GET /v1/pedido/{pedido_id}`).
- In the webhook order example the top-level `data_criacao` is `"2024-12-11T21:09:38.888Z"`, while nested `envios[].data_criacao` is `"2024-12-11T18:09:39.352574-03:00"`. 21:09Z equals 18:09-03:00.
- Inference: naive REST dates are America/Sao_Paulo wall-clock and webhook top-level dates are UTC. Cursor values should be sent as São Paulo-local naive strings, without fractional seconds or a `Z` suffix (the documented format is `AAAA-MM-DDTHH:MM:SS`). Confirm live.

### 5.4 Ids
- Integers throughout: pedido `id` (e.g. 102866325) and `numero` (e.g. 401) in the webhook; produto `id`; cliente `id`.
- `GET /v1/pedido/{pedido_id}` takes the order **numero** (example `"165"`, `resource_uri:"/api/v1/pedido/165"`), not the internal id.
- External ids are supported with `?id_externo=1` on produto, categoria, marca and pedido URIs.

### 5.5 Money and number formats
- **REST v1:** decimal **strings**, e.g. `"valor_total":"106.38"`, `"quantidade":"1.00"`, `"peso":"0.450"`. `parcelamento.valor_parcela` is a number (32.48).
- **Webhook payload:** JSON **numbers**, e.g. `valor_total: 258.37`, `quantidade: 1`, `peso_real: 0.3` (`spec tag Webhook Pedidos`).
- **Enviali:** "Os valores numéricos são sempre números inteiros ... centavos, centímetros e gramas" (`spec tag Enviali`).
- The schema must accept both strings and numbers for money and quantities.

## 6. Webhooks

### 6.1 Registration
- `PUT /webhooks/v1/pedido` and `PUT /webhooks/v1/produto`, body `{"notifyUrl": string, "token": string}`, response 200 `{"message":"Registros afetados: 1"}`.
- `DELETE` on the same paths with the same body `{notifyUrl, token}` removes it.
- **No GET or list endpoint** exists. The current registration cannot be read back.
- Per store vs many URLs, overwrite vs add: undocumented. "Registros afetados: 1" hints at an upsert of one row (inference).
- **Painel:** help article 9655071 (https://ajuda.lojaintegrada.com.br/pt-BR/articles/9655071-como-configurar-webhook, modified 2024-07-29) says to request a chave de aplicação through the form and then "siga as instruções ... da documentação da API ... para registrar o webhook". So registration is **API only**; no painel UI is mentioned.
- Whether a Personal-Token-authenticated call may register a webhook is undocumented. The article predates the personal-token model. (re-verified 2026-10-07: the spec's global security accepts either scheme on all 108 operations and none overrides it, so the spec implies Basic is accepted on `/webhooks/v1/*`; this is not proven live.)

### 6.2 Authentication of deliveries
- The header is `Authorization: Bearer <token chosen at registration>` (`spec tag Webhook Pedidos`). It is a static secret: no HMAC, no timestamp, no nonce.
- The Webhook Produtos tag does not repeat the header sentence. Inference: the same mechanism applies, since the PUT body is identical. Verify live.

### 6.3 Payload
- **Order:** a fat, full order object. Fields:
  - `token`, `tipo:"pedido_venda"`, `id`, `id_externo`, `numero`, `valor_*`, `peso_real`, `id_anymarket`
  - `data_criacao`, `data_modificacao`, `data_expiracao`
  - `cliente{... cpf, cnpj ...}`, `cupom_desconto`, `endereco_entrega{tipo, ie, cnpj, cpf, rg, razao_social, ...}`, `endereco_pagamento`
  - `envios[]{objeto, forma_envio}`, `pagamentos[]{forma_pagamento, transacao_id, ...}`
  - `situacao{id, codigo, nome, aprovado, cancelado, final, notificar_comprador, padrao, situacao_alterada}`
  - `marketplace_info{integrador, marketplace, id_externo_unico}`
  - `itens[]{linha, id, produto_id, produto_id_pai, sku, tipo, quantidade, preco_*}`
- The meaning of the top-level `token` field in the example is undocumented. It is not the bearer secret's example value; it might be a store or app identifier (inference).
- **Product:** a JSON **array** of full product objects. Fields include `id`, `pai`, `sku`, `ativo`, `removido`, `preco_cheio`, `preco_promocional`, `preco_venda`, `estoque_gerenciado`, `estoque_quantidade`, `estoque_quantidade_reservada`, `estoque_situacao_em_estoque`, `estoque_situacao_sem_estoque`, `grades`, `grades_customizadas`, `tipo`, `data_modificacao`, `imagens`, `categorias`, `marca`, `seo` (`spec tag Webhook Produtos`).

### 6.4 Events
- Products: "criado e editado". Orders: "criado e editado [alteração de situação (status)]" (help 9655071).
- Whether a pure stock change, or a stock decrement caused by a sale, fires the product webhook is undocumented.

### 6.5 Duplicates, delivery and dedup
- The spec says "o integrador pode receber diversos webhooks repetidos, para eliminar esta situação considere apenas os webhooks que estão como `situacao.situacao_alterada: true`" (`spec tag Webhook Pedidos`).
  - Inference: filtering on that flag would drop non-status edits such as a tracking `objeto` being filled. An ERP should instead dedup on `(id, situacao.codigo, data_modificacao)` and re-GET.
- There is no event id. Dedup candidates are `id`/`numero` + `data_modificacao` (orders) and `id` + `data_modificacao` (products).
- Undocumented: the retry policy, timeout, required ack status, ordering guarantees, HTTP method (POST inferred) and source IPs.
- **Backstop (design recommendation):** the inbound pipeline should keep a polling sweep using `pedido/search?since_atualizado=`.

## 7. Sandbox, versioning, deprecations, MCP

- **Sandbox:** none documented. The partner prerequisite is "uma loja ativa ... para testes (pode ser uma loja de demonstração)" (article 5360466). Article 931152 suggests separate API keys for "Testes de desenvolvimento separados da produção". The old Apiary docs offered a mock server, which belongs to the deprecated docs.
- **Versioning:** the spec is info.version "v2", but core resources are `/v1/*`.
  - `/api/v1/...` URIs appear in `resource_uri` and `meta.next`, and in one path (`/api/v1/marca/{marca_id}`).
  - Enviali is `/enviali/v2/*` and Marketing is `/v3/marketing/*`.
  - Nothing in the spec is flagged `deprecated` (searched).
  - The Apiary site https://lojaintegrada.docs.apiary.io/ is titled "Versão descontinuada", and its README says "VERSÃO BETA".
  - Deprecated mechanisms: query-string credentials (Apiary only) and the old store-level chave de aplicação (refused after 05/10/2026).
- **Limitation (help 924660):** "As soluções de frete e meios de pagamento não estão disponíveis para integração externa."
- **MCP:** no official Loja Integrada MCP server found. The web search for "Loja Integrada" MCP returned nothing relevant, and the help-center search for "MCP" returned no article. Absence is not proof.

## 8. Legacy code

Defects found in the legacy code are catalogued in the operator's private notes and are not ported. Facts to re-derive from the provider documentation instead: credentials per store held in Secret Manager and sent only in the header (§2); a documented 50-row page cap on `pedido/search` (§5.1); cursor format and timezone to confirm live (§5.2, §5.3); 429 handling per §3.

## 9. Open questions

1. Is the Personal Token IP-restricted in practice? A call from a non-static Cloud Run egress settles it.
2. Is the Basic credential the raw token (as the example suggests) or base64? Is it rejected if base64-encoded?
3. Which throttle bucket does a Personal-Token request consume, and does a 429 carry Retry-After? What is the 429 body shape (JSON with code 533/633/133?) and the window (fixed vs sliding)?
4. What status and body does an IP-rejected or invalid credential return (401 vs 403 vs other)?
5. Can webhooks be registered with a Personal Token, or only with chave_api+aplicacao?
6. Does PUT /webhooks/v1/pedido overwrite the single registration or add another URL? How do you read back the current registration (no GET exists)?
7. Webhook delivery: HTTP method, timeout, retry schedule, required ack status, source IPs, ordering, and whether the Bearer header is also sent for the product webhook.
8. What is the top-level `token` field in the order webhook payload?
9. Does a stock-only change (manual or sale decrement) fire the product webhook? Does a tracking or payment edit without a status change fire the order webhook, and with `situacao_alterada` false?
10. Timezone of naive REST datetimes and of `since_atualizado` input (assumed America/Sao_Paulo). Is `since_atualizado` inclusive? What order does `pedido/search` return under `since_atualizado`?
11. Do both `/v1/...` and `/api/v1/...` prefixes resolve, so that `meta.next` can be followed verbatim?
12. Is the max page size on `/v1/produto` and `/v1/produto_estoque` also 50, or higher?
13. Which credential model do the two LI stores use today (old store-level application key, partner key with IP list, or neither), given the 05/10/2026 cut-over? (re-verified 2026-10-07: most likely an old-model application key; see §2.6.)

### Questions for the operator
1. Is this LI integration only for the company's own stores, or will the ERP be offered to other LI merchants? Own stores means a Personal Token (no IP whitelist, no static egress). Third-party stores mean applying as a solution provider for an IP-bound chave de aplicação (5-10 business days) plus static egress.
2. Who is the store's "proprietário" user in the LI painel for each of the two LI stores? Only that user can generate the Personal Token and must click "Renovar" every 3 months or the integration stops. Should the ERP alert before expiry (e.g., at 60 days)?
3. Are both LI stores on a paid plan (required for API keys)?
4. Is there a test or demo LI store available? LI has no sandbox.
5. Is a static Bearer secret (no HMAC) acceptable for webhook authentication, with a mandatory polling backstop?

## 10. Blocked or unreachable
- The community forum search (https://comunidade.lojaintegrada.com.br/search.json) returns 403 `not_logged_in`; the Discourse search needs login.
- https://api-docs.lojaintegrada.com.br/ is a Scalar SPA; a local copy of the spec was used instead.

---

## Claims

| field | value | confidence | citations |
|---|---|---|---|
| auth | api-key (two fixed header combinations; no OAuth; personal token renewed manually every 3 months) | high | spec info; help 931152 |
| pkce | nao (no OAuth flow) | high | spec info |
| notificacoes | push (PUT /webhooks/v1/pedido and /produto; events per help 9655071; polling backstop via since_atualizado) | high | spec PUT /webhooks/v1/pedido; spec PUT /webhooks/v1/produto; help 9655071 |
| assinaWebhook | sim, static shared Bearer secret chosen by us at registration; not an HMAC; no timestamp or nonce; product webhook header inferred identical | high | spec tag Webhook Pedidos; spec PUT /webhooks/v1/pedido; spec PUT /webhooks/v1/produto |
| dadosFiscaisSeparados | nao (cpf/cnpj/ie/rg/razao_social inline in order detail and webhook payload) | high | spec GET /v1/pedido/{pedido_id}; spec tag Webhook Pedidos |
| other:credentials-personal-token | Owner-only, painel-generated, shown once, max 5 active per store, 3-month validity renewed manually (same token), auto-revoked if not renewed; sent as `Basic <token>` alone; needs a paid plan | high | help 931152; help 12542786 |
| other:credentials-chave-api | 20-char store key generated in painel, multiple allowed, never expires, removable individually; does not authenticate alone | high | help 931152 |
| other:credentials-chave-aplicacao | Integrator key issued by the LI technical team via a request form, 5-10 business days, solution providers only, IP-bound | high | help 5360466 |
| other:old-store-app-key-discontinued | The old store-level application-key model is refused after 05/10/2026 | high | help 931152 |
| other:which-credential-for-erp | Own stores: Personal Token (Basic). Multi-tenant product for third-party stores: partner chave de aplicação + each store's chave_api. Depends on business model (operator question 1) | medium | help 5360466; help 12542786 |
| other:ip-restriction | Integrator chave de aplicação bound to IPs declared in the request form (all prod servers, workers, queues, cron jobs; no stated max); other origins rejected with an undocumented "ERRO"; no source mentions an IP restriction on the Personal Token (inference: none) | medium | spec info; help 5360466 |
| other:throttling | 3000/min per application (533), 100/min per store (633), 1200/min per IP (133); HTTP 429 with the scope code; no Retry-After, window or burst semantics documented | high | spec info; legacy Apiary spec copy |
| other:error-envelope | No generic v1 error schema; documented codes only 200/201/204/400/404/409; v1 409 body is a bare string; Enviali uses {title, detail, id, code, status} with x-correlation-id echoed in id | high | spec PUT /v1/produto/{produto_id}/alias; spec GET /enviali/v2/postage/doc; spec tag Enviali |
| other:pagination | limit/offset; response {meta:{limit,next,offset,previous,total_count},objects}; meta.next is a relative `/api/v1/...` URI; default 20; pedido/search max 50 (old docs said 100); v3 marketing uses page/pageSize | high | spec GET /v1/pedido/search; spec GET /v1/produto_estoque; spec GET /v3/marketing/awaiting/list; legacy Apiary spec copy |
| other:polling-cursors | pedido/search: since_atualizado / since_criado / until_criado (AAAA-MM-DDTHH:MM:SS, hour optional), since_numero (>=), no until_atualizado. produto: data_modificacao or data_criacao with __gt/__gte/__lt/__lte/exact (space-separated datetime) (re-verified 2026-10-07: only sku, ativo, data_modificacao__gte/__lte are declared parameters; the rest is prose-only). produto_estoque: no filters. situacao_historico/search: numero or id_externo only. Most filters are prose-only, not declared parameters | high | spec GET /v1/pedido/search; spec GET /v1/produto; spec GET /v1/produto_estoque; spec GET /v1/situacao_historico/search; spec GET /v1/cliente/search |
| other:date-timezone | REST dates are naive (no offset, microseconds); webhook top-level dates use Z (UTC) while nested ones carry -03:00; naive = America/Sao_Paulo is an inference | medium | spec GET /v1/pedido/{pedido_id}; spec tag Webhook Pedidos |
| other:ids | Integer ids; GET /v1/pedido/{pedido_id} is keyed by the order numero; the webhook carries both id and numero; ?id_externo=1 addresses by external id | high | spec GET /v1/pedido/{pedido_id}; spec tag Webhook Pedidos |
| other:money-format | REST v1 uses decimal strings; the webhook uses JSON numbers; Enviali uses integers in cents/cm/grams | high | spec GET /v1/pedido/search; spec GET /v1/pedido/{pedido_id}; spec tag Webhook Pedidos; spec tag Enviali |
| other:webhook-registration | PUT /webhooks/v1/{pedido or produto} with {notifyUrl, token} returns {message:"Registros afetados: 1"}; DELETE with the same body; no GET/list; API only (no painel UI documented); multiplicity undocumented | high | spec PUT /webhooks/v1/pedido; spec DELETE /webhooks/v1/pedido; spec PUT /webhooks/v1/produto; help 9655071 |
| other:webhook-payload | Order: the full order object (cliente, addresses with fiscal ids, envios, pagamentos, situacao incl. situacao_alterada, marketplace_info, itens, top-level token and tipo "pedido_venda"). Product: a JSON array of full product objects with price and estoque_* fields. Meaning of top-level token undocumented | high | spec tag Webhook Pedidos; spec tag Webhook Produtos |
| other:webhook-duplicates-dedup | Duplicates are explicitly expected; LI advises acting only on situacao.situacao_alterada == true; no event id; retry, timeout, ack, ordering and HTTP method undocumented; recommended dedup on (id, situacao.codigo, data_modificacao) plus since_atualizado backstop (inference) | high | spec tag Webhook Pedidos |
| other:webhook-events | Produtos: created and edited. Pedidos: created and edited (status change). Stock-only changes undocumented | medium | help 9655071 |
| other:sandbox | No sandbox; testing uses a real or demo store; the old Apiary mock is deprecated | medium | help 5360466; spec info |
| other:api-versioning | Spec info.version "v2" but resources are /v1/* (resource_uri and meta.next use /api/v1/*); /enviali/v2/*; /v3/marketing/*; nothing marked deprecated; the Apiary docs are titled "Versão descontinuada"; query-string auth is Apiary-only | high | spec info; https://lojaintegrada.docs.apiary.io/; legacy Apiary spec copy |
| other:official-mcp | None found | medium | https://ajuda.lojaintegrada.com.br/pt-BR/?q=MCP |
| other:freight-payment-not-integrable | LI states freight solutions and payment methods are not available for external integration | medium | https://ajuda.lojaintegrada.com.br/pt-BR/articles/924660-como-integrar-um-novo-aplicativo-a-loja |
