# Survey C — catalogue, publishing, variations, stock, price

Provenance: compiled on 2026-10-07 from the current Loja Integrada (LI) OpenAPI spec (`info.version` "v2", server `https://api.awsli.com.br`, local copy of the public API docs), the older spec copies kept for comparison, and the LI help center (ajuda.lojaintegrada.com.br). The community thread 43468 requires a login and could not be read. The spec has **no `components.schemas`**; every body below comes from inline schemas and examples. Legacy-specific notes are kept in the operator's private notes and are not ported. Items marked "inference" are not stated by the provider.

## 0. Cross-cutting facts that shape the catalogue design
- **Throttling** (spec info): 3,000 req/min per application (`chave_aplicacao`, error 533). 100 req/min per store (`chave_api`, error 633). 1,200 req/min per IP (error 133). Going over any of them returns HTTP `429` with the code for that scope. The older spec says the same.
- **Auth** (spec info): send `Authorization: chave_api <k> aplicacao <app>` or `Authorization: Basic <Personal Token>`, never both. The spec says integrator credentials are IP-restricted: calls must come from the IP registered with LI. Inference: serverless egress would need a static egress IP.
- **Resource URIs, not ids.** References between resources are URI strings such as `"/api/v1/categoria/15246059/"`, `"/api/v1/marca/…"`, `"/api/v1/grades/8945"`, `"/api/v1/grade/8945/variacao/37078"` and `"/api/v1/produto/182904918"` (spec POST /v1/produto).
- **`id_externo`.** Products, categories, brands, prices and stock can be addressed by our own id, through the `?id_externo=1` flag or by passing `id_externo` in the body. The spec warns that if a product has `id_externo`, its category also needs one (spec POST /v1/produto, spec GET /v1/produto/{produto_id}).
- **Pagination.** Tastypie-style `meta {limit, next, offset, previous, total_count}` plus `objects[]`, with `limit`/`offset` query params. Default page is 20 (spec GET /v1/produto, spec GET /v1/produto_estoque). The docs give no maximum `limit`.
- The legacy client authenticates with the chave_api + aplicacao combination.

## 1. The produto model
**Fields on POST /v1/produto (request):** `id_externo`, `sku`, `mpn`, `ncm`, `nome`, `apelido`, `descricao_completa` (HTML), `ativo`, `destaque`, `peso` (number, e.g. 0.45), `altura`/`largura`/`profundidade` (integers), `tipo`, `usado`, `categorias` (array of URIs), `marca` (URI), `removido`. A parent also sends `grades` (array of grade URIs). A child also sends `pai` (URI) and `variacoes` (array of grade-variation URIs).
- Units are not written in the produto spec. The examples (0.45 weight, 2/12/6 dims) and the help center ("Pesos e Dimensões… cálculo do frete") point to **kg and cm** (inference).
- **Response and read-only fields** (spec GET /v1/produto/{produto_id}, spec POST /v1/produto 201):
  - Identity and state: `id`, `resource_uri`, `url`, `seo` (URI to /v1/seo/{id}), `bloqueado`, `data_criacao`, `data_modificacao`.
  - Images: `imagem_principal` (object), `imagens[]`, each with `id`, `imagem_id`, `caminho`, `grande` (800x800), `media` (380), `pequena` (210), `icone` (64), `mime`, `posicao` (a string), `principal`, `produto`, `id_anymarket`, `imagem_variacao`.
  - Family and codes: `filhos[]` (on a parent), `grades[]`, `variacoes[]`, `gtin`, `url_video_youtube`, `tags[]`.
  - **Read-only price and stock mirror:** `preco_cheio`, `preco_custo`, `preco_promocional`, `preco_sob_consulta`, `estoque_gerenciado`, `estoque_situacao_em_estoque`, `estoque_situacao_sem_estoque`, `estoque_quantidade`.
- The spec says price and stock are **GET-only on produto**: *"Não é possível criar/alterar estoque e valores no endpoint de produto, sendo necessário fazer um PUT no /v1/produto_estoque e um PUT no /v1/produto_preco"* (spec GET /v1/produto/{produto_id}).
- `peso` comes back as a **string**, sometimes with float noise (e.g. `"0.450000000000000011102230246251565404236316680908203125"`, spec POST /v1/produto 201 example). Parse it defensively.
- The **Webhook Produtos payload** adds fields not in the REST schema: `marca` as an object, `seo` as an object (`title`, `description`, `keyword`), and `categorias[]` as objects with `principal` and `nivel_1`…`nivel_5`. It also carries `canonical_path`, `comprimento` (not `profundidade`), `preco_venda`, `estoque_quantidade_reservada`, `grades_customizadas`, `disponivel`, `removido` and `tipo` (spec tag Webhook Produtos).
- **`tipo` enum:** `normal` (simple), `atributo` (parent with variations), `atributo_opcao` (child/variation) (spec POST /v1/produto).

## 2. Publishing
**Create.** POST /v1/produto ("Cadastrar produto simples") covers three cases: simple (`tipo:"normal"`), parent (`tipo:"atributo"` + `grades:[…]`) and child (`tipo:"atributo_opcao"` + `pai:"/api/v1/produto/{paiId}"` + `variacoes:["/api/v1/grade/{g}/variacao/{v}", …]`). The spec: *"Após criar o produto pai, é preciso criar os produtos filhos vinculando-os ao pai"*. Children do not need `destaque`, `descricao_completa` or `usado`.
- **A listing is a parent/child family. Each variation is its own `produto`** with its own `id`, `sku`, URL, stock and price. Publishing an N-variation product costs at least 1 + N POSTs, plus price and stock PUTs per child, plus images.

**Grades (variation axes).**
- POST /v1/grades `{nome, nome_visivel}` and GET /v1/grades. The list includes system default grades such as "Produto com uma cor" and "Gênero".
- GET /v1/grades/{grade_id} lists `variacoes[]`.
- POST /v1/grade/{grade_id}/variacao `{nome}`.
- The API has **no PUT or DELETE for grades or variation options** (spec paths).

**Help-center limits:** at most **50 variations per product**, with no limit on the number of grades. *"Uma vez que as grades foram vinculadas ao produto, não é possível excluí-las"*: to change them, create a new product. GTIN goes on the variations, not the parent (help article 5195150). (re-verified 2026-10-07: the 50-variation cap and the no-unlinking rule come only from the help center / panel; they are not API-documented, so treat them as client-side guards and probe before relying on API enforcement.)

**Update.** PUT /v1/produto/{produto_id} (`?id_externo=1` is supported). The spec: *"Para fazer a atualização é necessário enviar todos os campos do produto"*. It is a **full replacement**, so the safe flow is GET, merge, PUT.

**URL.** PUT /v1/produto/{id}/alias with `{absolute_path}` and `?replace_main`. Without `replace_main=true` the old URL **404s**. With it, the old URL stays as a 301 alias. A slug collision returns 409 "Slug already in use."

**SEO.** PUT /v1/seo/{seo_id} with `{title, description}`. The tag also mentions `keyword`.

**Delete.** **The spec has no DELETE on /v1/produto.** `removido` (boolean) is accepted on POST and PUT and can be filtered on GET. In the panel, "excluir" moves the product to a recoverable lixeira (trash). Permanent deletion is blocked for products with sales or less than one hour in the trash (help article 931878). Inference: `removido:true` is the API-side trash. (re-verified 2026-10-07: `removido` as the trash is an inference, not documented; `removido:true` is the only soft-delete the API offers and is probably the panel trash, but that is unproven.)

**Pause.** `ativo` (boolean) on PUT /v1/produto. Help article 5195150: *"Caso você mude a opção Produto ativado? para Não, o produto não será excluído do seu catálogo, mas ficará oculto na loja"*. It can be set back to true, so pause is reversible (`pausarAnuncio = sim`). The panel also has "Visível?" and "À venda?" flags (same article) that the API schema **does not expose**.

## 3. Import
- **GET /v1/produto**: filters `sku`, `ativo`, `removido`, and `data_criacao`/`data_modificacao` with `__lt`, `__lte`, `__gt`, `__gte` or an exact date (format `2022-01-01 10:20:00`). (re-verified 2026-10-07: only `sku`, `ativo`, `data_modificacao__gte` and `data_modificacao__lte` are declared query parameters; `removido`, `data_criacao` and the `__lt`/`__gt` operators appear only in the operation prose. There is no documented filter by `tipo` or `pai`. The default list includes `removido:true` items, so pass `removido` explicitly. The spec's own `data_criacao_gt` example has a single underscore, an apparent typo for `__gt`.)
  - Add `description_html=1` to get descriptions in the list. Use `descricao_completa=1` on the detail endpoint.
  - The list mixes parents (`filhos[]`) and children (`variacoes[]`, often with `nome:null`).
  - **The list carries no price or stock.** Those come only from the detail GET or the dedicated endpoints.
- **GET /v1/produto/{id}**: one call gives full data including price, stock and images.
- **GET /v1/produto_estoque** lists every stock record. **GET /v1/produto_preco** lists every price; the spec mislabels this path as `/v1/{produto_preco}`, and the real path in the examples is `/api/v1/produto_preco`.
- **GET /v1/produto_preco/set/{ids}** takes `;`-separated ids and supports `id_externo=1`.
- **GET /v1/categoria/set/{ids}** and **GET /v1/marca/set/{ids}** do the same for categories and brands.

## 4. Images
- **POST /v1/produto_imagem** is JSON **by URL**: `{imagem_url, produto:"/api/v1/produto/{id}", principal, posicao, mime}`. With `principal:true`, `posicao:0` is mandatory. The spec documents no multipart file upload for product images; the multipart endpoints are only for brand images, NF and DCE.
- **GET /v1/produto_imagem?produto={id}** lists images. **GET** and **DELETE** /v1/produto_imagem/{id} (DELETE returns 204). There is no PUT for reordering or changing the main image.
- **Variation images:** GET, PUT `{imagens_ids:[…]}` and DELETE on `/v1/produto_imagem/{produto_imagem_id}/grade_variacao/{grade_variacao_id}`. The first path parameter's example (366565583) does not look like an image id, while `imagens_ids` holds image ids (216642377). Inference: the first segment is really the **parent product id**. Needs a live check.
- **Help-center limits:** up to **50 images per product**, **one image per variation**, linked only through the **first grade column** when the product has two grades (article 4543275). Files up to 4 MB, up to 2500x2500 px, JPG recommended; PNG/JPG are converted to WebP (article 911229). (re-verified 2026-10-07: the 50-image limit is help-center guidance only, not in the API spec, so API enforcement is undocumented.)
- Variation images are supported by the platform (article 4543275) and by the API endpoints above.

## 5. Categories, brands and attributes
- **Categories:** POST, GET, PUT and set on /v1/categoria, with fields `nome` (required), `descricao`, `categoria_pai` (URI) and `id_externo`. There is **no category DELETE**.
- **Brands:** POST, GET, PUT and set on /v1/marca, plus **DELETE /api/v1/marca/{id}** (204) and brand-image PATCH/DELETE.
- The store owns its category tree; it is not a marketplace taxonomy. The API has **no attribute or specification model**: the only structured axes are grades and variations, plus gtin/mpn/ncm.

## 6. Size charts
The spec has **no size-chart resource**. A spec-wide search for "medidas" only hits a store grade named "Medidas" and an HTML code snippet. A help-center search for "tabela de medidas" only finds the Sizebay app and the Mercado Livre grade de tamanhos, nothing LI-native. So `tabelaDeMedidas = nao`; the only option is a workaround: append the size-chart description to `descricao_completa` and add its image to the product gallery (design decision pending, see questions).

## 7. Kits and bundles
Searching the spec for kit, combo, composto and "compre junto" finds nothing except a category named "Kits".

The help center's **"Compre Junto"** is a *promotion*: 2 to 5 products, an optional % discount, at most 500 rules, paid plans only (article 5899457). It is not a bundle SKU with stock derived from its components. So `kitVirtual = nao`: our ERP must compute a kit's stock and push it as a normal product's quantity.

## 8. Stock
- **GET** and **PUT /v1/produto_estoque/{produto_id}**. Body: `{gerenciado: bool, quantidade: int, situacao_em_estoque: int, situacao_sem_estoque: int}`. Response adds `id`, `produto`, `quantidade_reservada`, `quantidade_disponivel` and `resource_uri`. The current spec documents 200 (the older spec documents 202).
- **One product per call. The current spec has no batch write** (the older spec had none either).
- **Field semantics** (spec tag Estoque):
  - `gerenciado`: if false, *"os quatro campos retornarão 0"*. The older spec instead says quantity is ignored and `situacao_em_estoque` rules. The help center says unmanaged means unlimited quantity.
  - `situacao_em_estoque`: dispatch lead time, 0 = immediate, N = N days.
  - `situacao_sem_estoque`: only used when managed. **-1 = unavailable**, 0 = keep selling immediately, N = N extra days. Help: 1–90 business days, added on top of the base lead time.
  - These three policy fields are part of the same PUT body as `quantidade`; whether omitting them preserves the merchant's panel settings is undocumented (open question).
- `quantidade` **can be negative** (list examples show -2 and -4).
- **Reservations:** orders in "Aguardando Pagamento" or "Pagamento em análise" reserve stock (help article 912137). (re-verified 2026-10-07: the formula `quantidade_disponivel = quantidade - quantidade_reservada`, with `quantidade` as gross on-hand stock, comes from LI's older Apiary document, not from the current spec, whose examples all show `quantidade_reservada` = 0. Help articles 924633 and 912137 disagree on whether "Pedido Efetuado" reserves; 924633 also lists the statuses that take stock out: Pedido Pago, Entregue, Em Produção, Em Separação, Pronto para Retirada. Reservation needs `gerenciado` = true.)
- **Variation stock lives on the child produto id.** Help: stock *"já foi preenchida individualmente em cada variação… essa seção fica inativa em produtos com variações"* (article 5195150).
- **No multi-warehouse:** each produto has a single `quantidade`, and no depósito/warehouse concept exists anywhere in the spec.
- **Cost of a full push:** 2,000 SKUs at 100 req/min per store means at least **20 minutes** of wall-clock time, and it uses the **whole** per-store budget. Order polling, price writes and catalogue edits would starve, or everything hits 429/633. At a 60–70 rpm stock budget, a full push takes about 29–33 minutes.
- **Sweep design (inference):**
  - Push only changed SKUs, event-driven, through a per-store rate-limited Cloud Tasks queue (e.g. maxDispatchesPerSecond about 1).
  - Reconcile by **reading** GET /v1/produto_estoque in pages (2,000/20 is about 100 GETs, or fewer if larger `limit` values work) and writing only the differences.
  - Back off on 429 and tell 633 (store) apart from 533 (app) and 133 (IP).
  - The store budget is probably shared with any other integrator using the same `chave_api`; not confirmed.

## 9. Price
- **GET** and **PUT /v1/produto_preco/{produto_id}** (`?id_externo=1` is supported). Body: `{cheio: number, custo: number, promocional: number (the schema says integer, the example is 20), sob_consulta: bool}`. The response returns **strings** ("32.84").
- **No promo start/end dates** in the API. No batch write; only the GET set endpoint.
- Price is per child: each variation has its own required "Preço de venda", and the storefront shows the lowest one (help article 5195150).
- Whether sending `promocional:null` clears a promotion is not documented.

## 10. Webhook Produtos
- Register with PUT /webhooks/v1/produto `{notifyUrl, token}`; remove with DELETE /webhooks/v1/produto (same body).
- **The payload is a JSON ARRAY of produto objects** (spec tag Webhook Produtos).
- **Triggers:** the help center says *"Produtos: criado e editado"* (article 9655071). Whether stock or price changes, including sale-driven stock decrements, fire it is **not documented**. The payload does carry `estoque_*` and `preco_*` fields.
- **Auth:** documented under the Webhook Pedidos tag as `Authorization: Bearer <token chosen at registration>`. It is a static shared secret, not an HMAC signature. Inference: the same applies to products, because the registration body has the same `token` field.
- The help center says the webhook is set up after requesting an application key, and that LI only does a feasibility check.

## 11. Spec comparison (old spec vs current spec) relevant to this survey
- Removed in the current spec: GET /produto_estoque/set/{ids} (batch read of stock). It may be dead (open question).
- Changed: PUT /v1/produto_estoque/{produto_id} documents 200 instead of 202.
- Unchanged: throttling table, no batch write for stock or price, no PUT/DELETE for grades.

## 12. Open questions
1. Does Webhook Produtos fire on stock/price changes (including sale-driven decrements and PUT /v1/produto_estoque), or only on catalogue edits? Does the product webhook carry the same `Authorization: Bearer <token>` header as orders?
2. Is GET /v1/produto_estoque/set/{ids} (present in the old spec, absent from the current one) still live? It would make reconcile reads cheaper.
3. What is the maximum accepted `limit` on paginated list endpoints (produto, produto_estoque, produto_preco)?
4. Does sending `promocional: null` on PUT /v1/produto_preco clear an active promo price? Is parent (tipo atributo) price/stock meaningful or ignored?
5. Is the first path segment of `/v1/produto_imagem/{produto_imagem_id}/grade_variacao/{grade_variacao_id}` actually the parent produto id?
6. Does `removido: true` via PUT behave as the panel "lixeira" (recoverable via `removido:false`)? Does PUT with a different `apelido` change the URL and 404 the old one like the /alias endpoint without `replace_main`?
7. Does the 100 rpm per-store limit apply when authenticating with a Personal Token (Basic), and is it shared across all integrators of the same store?
8. Does `data_modificacao` on produto change when only stock or price changes (needed for incremental import)?
9. Exact error body/codes for a duplicate SKU on POST /v1/produto (a 400 with "Erro de integridade, verifique se o SKU ou ID Externo estão duplicados." has been observed).
10. Help-center conflict: article 5195150 says GTIN goes on variations, not the parent, while the bulk-spreadsheet article 11777866 says GTIN can be changed only on the parent. Which does the API enforce?
11. When a stock PUT omits or changes `gerenciado`/`situacao_*`, is the merchant's panel configuration overwritten?

## 13. Decisions needed from the operator
- Size charts: LI has no size-chart API. Use the description/gallery workaround, or drop it?
- Kits: is it acceptable for the ERP to compute kit stock (minimum of components) and push it as a normal product's quantity?
- Stock writes: should the ERP own `gerenciado`/`situacao_em_estoque`/`situacao_sem_estoque` per product, or preserve the merchant's panel settings and only write `quantidade`?
- Price: when the ERP has no promotional price, should the integration clear LI's `promocional`? Should a "never lower the price unless allowed" rule be kept?
- Should the ERP product id be used as LI `id_externo` (idempotent creates, but every category then also needs an `id_externo`)?
- Pausing: should ERP "pause listing" map to `ativo:false`, and "delete" to `removido:true` (trash)?
- Is there a static egress IP registered with LI as a partner (integrator credentials are IP-restricted), or will each of the two LI stores use a Personal Token?
- How many SKUs per store are expected? At 100 req/min per store, a full stock push of 2,000 SKUs takes at least 20 minutes, which decides how stock sync is scheduled.

## 14. Claims

| field | value | confidence | citations |
|---|---|---|---|
| publicarAnuncio | sim (POST creates simple/parent/child; PUT updates, all fields required) | alta | spec POST /v1/produto; spec PUT /v1/produto/{produto_id} |
| importarAnuncio | sim (paginated GET with sku/ativo/removido/date filters; detail GET has price, stock, images) (re-verified 2026-10-07: only sku, ativo and data_modificacao__gte/__lte are declared parameters; the rest are prose-only) | alta | spec GET /v1/produto; spec GET /v1/produto/{produto_id} |
| variacoes | sim (parent `atributo` + child `atributo_opcao` products; max 50 variations; grades cannot be removed once linked) (re-verified 2026-10-07: the 50 cap and no-unlink rule are help-center only) | alta | spec POST /v1/produto; spec POST /v1/grades; spec POST /v1/grade/{grade_id}/variacao; help 5195150 |
| categoriasEAtributos | sim, with caveat: store-owned category tree and brands; no attribute/specification model, only grades plus gtin/mpn/ncm | media | spec POST /v1/categoria; spec PUT /v1/categoria/{categoria_id}; spec POST /v1/marca; spec DELETE /api/v1/marca/{marca_id} |
| tabelaDeMedidas | nao (no resource; workaround via description and gallery) | media | spec GET /v1/grades; help search "tabela de medidas" |
| kitVirtual | nao (Compre Junto is a promotion, not a bundle SKU) | media | spec info; help 5899457 |
| pausarAnuncio | sim (`ativo` writable via full-body PUT; reversible; distinct from `removido`) | media | spec PUT /v1/produto/{produto_id}; help 5195150 |
| estoque.suporte | sim | alta | spec PUT /v1/produto_estoque/{produto_id}; spec tag Estoque |
| estoque.protocolo | por-anuncio (no batch write; variations written per child produto id) | alta | spec PUT /v1/produto_estoque/{produto_id}; help 5195150 |
| estoque.loteMax | null (one product per call) | alta | spec PUT /v1/produto_estoque/{produto_id} |
| estoque.multiDeposito | nao (single `quantidade`; no warehouse concept) | media | spec GET /v1/produto_estoque/{produto_id}; spec tag Estoque |
| enviarPreco | sim (per product/child; no batch; no promo dates; string values in response) | alta | spec PUT /v1/produto_preco/{produto_id}; help 5195150 |
| other:throttling | 3000 rpm per app (533), 100 rpm per store (633), 1200 rpm per IP (133); 429 on breach | alta | spec info |
| other:ip-restriction | integrator credentials are IP-restricted (static egress IP needed, inference) | alta | spec info |
| other:produto-put-full-replacement | PUT /v1/produto/{id} requires all fields; price/stock not writable there | alta | spec PUT /v1/produto/{produto_id}; spec GET /v1/produto/{produto_id} |
| other:delete-produto | no DELETE endpoint; `removido` boolean writable; mapping to lixeira (trash) is inference, unproven (re-verified 2026-10-07) | media | spec POST /v1/produto; spec GET /v1/produto; help 931878 |
| other:images | by URL (JSON), max 50 per product (help-center only, re-verified 2026-10-07), 1 image per variation, variation link endpoint exists | media | spec POST /v1/produto_imagem; spec PUT /v1/produto_imagem/{produto_imagem_id}/grade_variacao/{grade_variacao_id}; help 4543275; help 911229 |
| other:webhook-produtos | push of an ARRAY of produtos on create/edit; static Bearer token chosen by integrator; not HMAC; stock/price triggers undocumented | media | spec PUT /webhooks/v1/produto; spec tag Webhook Produtos; spec tag Webhook Pedidos; help 9655071 |
| other:estoque-semantics | `situacao_sem_estoque` -1 = unavailable, 0 = sell immediately, N = N extra days; `quantidade` may be negative | alta | spec tag Estoque; spec GET /v1/produto_estoque; help 5990288; help 912137 |
| other:grades-immutable | no PUT/DELETE for grades or variation options via API | alta | spec POST /v1/grades; spec POST /v1/grade/{grade_id}/variacao |

Help-center articles are under `https://ajuda.lojaintegrada.com.br/pt-BR/articles/<number>`; the community thread (login required, unread) is `https://comunidade.lojaintegrada.com.br/t/integracao-api-documentacao-dos-campos-para-envio-de-produtos-com-variacoes/43468`.
