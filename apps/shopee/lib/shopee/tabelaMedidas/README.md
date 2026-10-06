# `lib/shopee/tabelaMedidas/` — size charts (step 18, #1526)

The design notes for the step that lets an operator pick, per Shopee conta and per
LEAF category, one of the shop's size-chart templates for an ERP tabela de medidas
(`tabMedi`). `apps/shopee/CLAUDE.md` keeps only the rules a reader must not break and
points here for the reasoning. The reconciled design, the explorations and the wave
reports that produced this folder are in the step-18 review directory named by the PRs
that close #1526.

Step 18 was built as six stacked PRs: (1) `esquemas` — the stored entry, its read slice,
THE selection rule, the chart projector and the two route envelopes in `packages/schemas`;
(2) `pacote` — the two package reads, the attach's one-key union and the four doc-sample
fixtures; (3) `rotas` — this folder and its two routes; (4) `web` — the `/medidas/[id]`
Shopee tab; (5) `anexo` — publish sends the pick (step 18's attach, §6); (6) `docs`.

Everything here is **offline-verified**. Shopee's two pages are the only wire evidence,
the SG sandbox may hold no templates at all (register 260), and everything only a
Brazilian shop can settle is a register row (§7).

## 1. What and why

**Read + record.** Shopee has no API to AUTHOR a size-chart template — templates are
made in Seller Centre — so this step reads the templates a shop already has and records
the operator's pick. Two Shop-signed reads, both GET with query parameters (the pages'
`method: 2`; the issue's POST body was a misreading):

- `v2.product.get_size_chart_list` — the template IDS for one leaf category, cursor-paged;
- `v2.product.get_size_chart_detail` — one template: a name and a COLUMN-oriented table.

The pick is stored on the tabela, `tabMedi.tabelasMedidasShopee[<integracaoId>]`, as a
list of `{ categoryId, size_chart_id, name }` (§5). It is written by the browser (the
`/medidas/[id]` Shopee tab, staged in the tabela's own save) and READ by publish (step
18's attach, §6).
**This app never writes `tabMedi`**, and nothing records which listing carries which
chart — there is no reverse index, so "used by N listings" is not a question this step
can answer.

| module                                                               | what it is                                                                                                                                                                                                       |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recusaTabelaMedidas.ts`                                             | the ONE spelling of Shopee's two refusal sentences and the pure classifier (§4), which publish's stale-template row calls (§6). Next-free: `anuncios/` imports it, and the functions bundle reaches `anuncios/`. |
| `listarTabelasMedidas.ts`                                            | the cursor walk and the detail fan-out (§3) — pure orchestration over a client: no Firestore, no clock.                                                                                                          |
| `lerTabelaMedidas.ts`                                                | one detail through `projetarTabelaShopee` (`@delfrance/schemas`).                                                                                                                                                |
| `dto.ts`                                                             | re-exports the two answer envelopes from `@delfrance/schemas` (`tabelaDeMedidasShopeeDto.ts`) — the SAME objects `apps/web` parses with; the route tests PARSE every 200 with them.                              |
| `app/api/marketplace/shopee/tabela-medidas/{lista,detalhe}/route.ts` | the two routes (§2).                                                                                                                                                                                             |

`taxonomia/params.ts` gained ONE exported reader, `lerIdPositivoObrigatorio(params, nome)`
— the `categoryId` rule under any parameter name; `lerCategoryIdObrigatorio` is now that
reader called with `'categoryId'`, so there is one copy of the rule, not two.

## 2. The two routes

Both are `PERM.integracao.read`, `integracaoId`-scoped, write nothing, and set
`Cache-Control: no-store` on EVERY answer — errors included (§3 says why there is no
cache). Both wrap one `responder()` and stamp the header once in `GET`, the
`reclamacao/estado` shape.

**`GET /api/marketplace/shopee/tabela-medidas/lista?integracaoId=&categoryId=`** — the
`taxonomia/variacoes` ladder, in that order:

1. `verifyCaller` → 401 / 403;
2. `integracaoId` (400) → `categoryId` (400: digits only, a positive safe integer, NOT
   trimmed);
3. the conta (`loadShopeeContext` → `taxonomiaCtx`; another `tipo` ⇒ 404);
4. the three-valued leaf gate over this conta's cached tree (`ehFolha`):
   - `desconhecida` ⇒ **404 `SHOPEE_CATEGORIA_DESCONHECIDA`**, the `variacoes` body;
   - `nao-folha` ⇒ **200** `leaf: false`, an empty `tabelas`, `totalCount: null`,
     `truncado: false` and both counters `0`, with ZERO list calls — the picker only
     offers leaves; a legacy non-leaf entry is DISPLAYED off the stored entry and the
     detail route, never listed;
   - `folha` ⇒ **200** `{ leaf: true, …listarTabelasDaCategoria(…) }`, built by NAME.

`tabelas` rows are `{ sizeChartId, sizeChartName, legivel }`, in Shopee's order.

**`GET /api/marketplace/shopee/tabela-medidas/detalhe?integracaoId=&sizeChartId=`** —
`verifyCaller` → `integracaoId` → `lerIdPositivoObrigatorio(params, 'sizeChartId')` (400:
`0` is the add/update DETACH sentinel and never a template; `' 7'`, `1e5`, an unsafe
integer are refused as sent, never rewritten; leading zeros are the same decimal number,
so `007` reads `7` — the `categoryId` rule, pinned in `params.test.ts`) → the shop
client → **200 `{ tabela }`**. No category in the query, so no leaf gate: a stored legacy
entry is still previewed.

`tabela` is `projetarTabelaShopee`'s output passed WHOLE. Its schema
(`tabelaShopeeProjetadaSchema`) lives in `@delfrance/schemas` and is the one this route's
test and `apps/web` both parse with — the web never re-projects a chart (#1369). So do
both ENVELOPES (`tabelaDeMedidasShopeeDto.ts`, beside it): the routes build their 200s
against those types, their tests parse the bodies with those schemas, and the browser
parses the same bytes with the same objects — a renamed key is a compile error on both
sides, never a deploy-time parse failure. Its `sizeChartId` is the REQUESTED id, never
Shopee's echo: a differing echo is one `id-divergente` problema inside the 200, not an
error. The rule is `ecoDivergenteTabelaShopee` (an echo present AND different; an absent
one proves nothing), which the list's fan-out reads too (§3). ⚠️ Shopee's own two doc
samples are different charts (the detail sample echoes `700024639`, none of the list
sample's ids), so the detail sample requested by a list id projects with exactly that one
problema — and lists unnamed.

## 3. Paging and fan-out (`listarTabelasMedidas.ts`)

The cursor NEVER crosses our HTTP boundary: the route walks it, so the browser never holds
an opaque Shopee value and no query parameter of ours has to carry one verbatim.

- Page size `TAMANHO_DA_PAGINA_TABELAS` = the package's
  `SHOPEE_SIZE_CHART_LIST_MAX_PAGE_SIZE` (50) — never a second literal. Page 1 sends NO
  `cursor` key; every later page sends the previous `next_cursor` byte for byte (a
  whitespace cursor included — never trimmed).
- Each page is read by the package's `lerPaginaDeTabelasDeMedidas`, whose continuation is
  THREE-valued: `fim` (`next_cursor === ''`) stops, `truncado: false`; `seguinte` walks on;
  `sem-cursor` (absent / `null` — register 249) stops, and is `truncado` UNLESS the first
  page's `total_count` is known and the distinct ids reach it — an absent cursor is not a
  proof of exhaustion.
- A `seguinte` cursor identical to the one just sent — byte for byte, so `'mesmo'` then
  `'mesmo '` is an advance — stops with `truncado: true` and one warn (a non-advancing
  cursor would otherwise burn the cap silently). After
  `MAX_PAGINAS_TABELAS` (2) pages still `seguinte` ⇒ `truncado: true`. So at most **100
  ids** and **2 list calls** per request.
- Ids are deduplicated by NUMBER, first position kept; `total_count` (FIRST page's) is
  reported as `totalCount` — a diagnostic, never a terminator. A row whose id the package
  could not read counts in `idsIlegiveis` (the row, never the page).
- Names come from a fan-out: one `get_size_chart_detail` per id through `executarEmPool`,
  width `LARGURA_DOS_DETALHES` (4), with a local abort flag checked first. Per id: success ⇒
  `{ sizeChartId, sizeChartName: size_chart_name, legivel: true }` at the id's index;
  success, but the answer echoes ANOTHER `size_chart_id` ⇒
  `{ sizeChartId, sizeChartName: null, legivel: false }`, counted as `divergentes` in the
  log line and one warn of the two ids — never another chart's name on a listed id, which
  the operator would pick X by. The echo is judged by `ecoDivergenteTabelaShopee`, the
  rule the projector turns into the detail route's `id-divergente` (§2), so the list and
  "Ver" cannot disagree; an ABSENT echo names the row, exactly as there;
  "Size chart id not exist" (deleted between list and detail) ⇒ dropped, `removidas += 1`;
  `ShopeeSchemaError` ⇒ `{ sizeChartId, sizeChartName: null, legivel: false }` + one warn —
  one malformed template never hides the other 99 and stays pickable by id; anything else
  (rate limit, dead grant, network, an unclassified refusal) aborts the walk and reaches the
  route's catch. One `console.info` per request, counts only.
- **No cache.** The taxonomy reads cache for 15 minutes because the tree is reference data;
  templates are shop-AUTHORED and an operator who just made one in Seller Centre clicks
  "Recarregar lista" expecting to see it. Worst case is 2 list calls + 100 details at width
  4; the typical shop is 1 + a handful.

## 4. Errors

`classificarRecusaTabelaMedidas(err: ShopeeApiError)` answers `tabela-inexistente`,
`categoria-invalida` or `null`. Rule: `codigoCanonicoShopee(err.code) === 'error_param'`
AND `fraseCanonicaShopee(err.providerMessage)` contains the canonical form of
`FRASE_TABELA_MEDIDAS_INEXISTENTE` (`'Size chart id not exist'`) or
`FRASE_CATEGORIA_INVALIDA_TABELA` (`'Category id is invalid'`). The code alone decides
nothing — both pages document the SAME `product.error_param` for both sentences — and the
haystack is `providerMessage`, never `.message` (the package formats the path and the code
into `.message`, so a needle matched there proves nothing).

| what Shopee answers                                       | `lista`                                                             | `detalhe`                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| `error_param` + "Category id is invalid" (kind `other`)   | **404 `SHOPEE_TABELA_MEDIDAS_CATEGORIA_INVALIDA`** + `categoryId`   | 502 (not this route's answer)                               |
| `error_param` + "Size chart id not exist…" (kind `other`) | 502 (not this route's answer); inside the fan-out it is `removidas` | **404 `SHOPEE_TABELA_MEDIDAS_INEXISTENTE`** + `sizeChartId` |
| the same sentence under another code (`error_data`)       | 502                                                                 | 502                                                         |
| a dead grant                                              | 409 `SHOPEE_REAUTH_REQUIRED`                                        | 409                                                         |
| a rate limit (burst / daily)                              | 502 `SHOPEE_HTTP_ERROR` + `kind`                                    | same                                                        |
| a schema drift                                            | 502 `SHOPEE_BAD_RESPONSE`                                           | same (in the fan-out: a `legivel: false` row)               |
| the network                                               | 503                                                                 | 503                                                         |
| anything that is not a Shopee error                       | rethrown (rule 6)                                                   | rethrown                                                    |

- ⚠️ **Kind `other` only.** The route's catch classifies a `ShopeeApiError` ONLY when
  `kind === other`: a dead grant and a rate limit are `ShopeeApiError`s too, and a dead
  grant read as "escolha outra" would never tell the operator to reconnect.
- "Category id is invalid" is DISTINCT from `SHOPEE_CATEGORIA_DESCONHECIDA`: the latter is
  our tree not knowing the id; the former is Shopee refusing an id our (up to
  15-minute-stale) tree calls a leaf (register 258).
- Both 404 bodies carry OUR pt-BR sentence, which says what to do; Shopee's sentence
  reaches neither the body nor a log. Each 404 logs one warn with the ids, the motivo and
  the code through `codigoSeguro`.
- **Rate limits: status quo.** `core/respond.ts` is unchanged — 502 `SHOPEE_HTTP_ERROR` with
  `kind` and `shopeeCode`, like every other Shopee route; no in-band retry, no
  route-local 429. The web reads `kind` for its copy and never auto-retries a 502. A global 429 +
  `Retry-After` arm would change every Shopee route at once, so it is a follow-up of its
  own (#1779), not this step's.

## 5. The stored pick

- **The corpus shape, exactly three keys:** `{ categoryId, size_chart_id, name }` per entry,
  a list per conta (`entradaTabelaShopeeSchema`, strict). Both ids are Firestore integers;
  `size_chart_id: 0` is refused everywhere (it is the add/update DETACH sentinel). ⚠️
  `name` is the CATEGORY's display name at pick time (the legacy picker stored it so), NOT
  the chart's name — a label, never identity.
- **The read slice** `lerEntradasShopeeDaConta(campo, integracaoId)` is pure and total and
  never throws: a missing map, a missing key or a per-key `null` reads `sem-lista`; a map
  that is not a plain object reads `campo-invalido`; a value that is not an array reads
  `lista-invalida`; otherwise one `linha` per RAW element, keeping its raw `indice`, with an
  unreadable element marked by a `motivo` and never dropped. A digit-string id is
  unreadable (no fold): the legacy model refused anything but a number on save.
- **An oddity never blocks a save — with one exception.** The base schema
  (`tabelaDeMedidas.ts`) types each conta's value `unknown`, the Mercado Livre map's
  shape, and judges no Shopee value itself: the read slice does. So any legacy per-conta
  shape that is not a list — `'x'`, `{}`, `42`, `true` — parses, is shown read-only as
  `lista-invalida` and rides every save of the tabela VERBATIM, beside a pick on another
  conta (a list's unreadable ELEMENTS already did). A stricter per-key type made ONE such
  value fail the whole base parse: every reader of the doc (the ML publish and sync
  included) got the raw doc with defaults unapplied, and ObjectView's resolver refused
  every `/medidas` save of that tabela for an edit the tab cannot make. Never tighten it
  in place. ⚠️ The exception is the MAP itself: a field that is not a plain object
  (`campo-invalido` — a list, a string) still fails the base parse, so it still blocks
  every save, and the tab says so in red ("Peça a correção do documento"); widening the
  outer field too is Lucas's call, pinned as a near-miss so it is a deliberate change.
- **ONE selection rule** — `indiceDaEntradaShopee` / `resolverEntradaShopee` in
  `@delfrance/schemas`: the FIRST readable entry whose `categoryId ===` the listing's
  category. Publish and the `/medidas` panel both call it; there is no second copy anywhere
  (#1369 shipped a "line-for-line mirror" that had already drifted in two places).
- **Staged, not immediate.** The tab edits the field inside the tabela's own form;
  "Salvar alterações" writes it through `ObjectView`'s existing save transaction, whose
  tier-3 guard (#1757) raises a conflict when the stored map changed since load. No
  transaction of this step's own, so no `firestore-transaction-inventory` row. Sibling
  contas, unreadable elements and the Mercado Livre map ride through every write verbatim
  — `apps/web/app/(app)/medidas/[id]/page.test.tsx` drives the real page, `ObjectView` and
  save over an OCC fake and pins the write, the three conflict paths and their disjoint
  near-misses.
- **Leaf-only pick, legacy tolerated.** The picker offers only leaves; a stored legacy
  non-leaf, duplicate or unreadable entry is shown and preserved, never silently dropped.
  "Adicionar" on a category that already has a pick REPLACES it (a second entry would be
  dead under first-match-wins).

## 6. The attach (`size_chart_info` on publish)

Step 18's attach. Publish READS the pick and sends it; nothing here writes `tabMedi`, and
nothing records which listing carries which chart.

**The rule (Lucas, 2026-10-05: template first, else the photo — the legacy order).** `add_item`
AND `update_item` carry `size_chart_info` with EXACTLY one key:

1. the produto's tabela has an entry for THIS conta and the listing's RESOLVED category (the
   stored link's `category_id` first, the request's otherwise — the one resolution
   `montarAnuncio` makes) ⇒ `{ size_chart_id }`, the entry's id verbatim. The selection is
   `resolverEntradaShopee` (§5) — the panel's function, never a copy. ⚠️ The template WINS:
   the photo is then never uploaded;
2. no entry matched ⇒ the tabela's FIRST photo (`fotos[0]`, the legacy `fotos.first`),
   uploaded through step 11's resolver (`resolver([foto], { cap: 1 })` — its SSRF allow-list
   and its `externalIds` cache, so a republish reuses the `image_id`; the dry run uploads it
   too, step 11's documented exception) ⇒ `{ size_chart: <image_id> }`. An unreadable first
   photo is NOT replaced by the second: the photos after the first may be of the garment;
3. otherwise the KEY IS ABSENT. Never `size_chart_id: 0`, never `size_chart: ''` — those are
   Shopee's DETACH sentinels, so a chart set in Seller Centre survives an update where
   nothing matched.

⚠️ Once something matches, EVERY republish puts the ERP's pick back over a Seller-Centre
change (legacy parity, Lucas's Q3); removing the entry in `/medidas` does NOT detach the live
chart.

| module                                              | what it is                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `anuncios/lerTabelaMedidasDoProduto.ts`             | the I/O half: ≤ 1 document read (none without a usable `tabMedi` ref), RAW through the collection handle; THIS conta's entries through `lerEntradasShopeeDaConta` and the first photo through `fotoSchema`. A legacy oddity in another field (the ML map, a date) never costs the entries. |
| `anuncios/tabelaMedidasPublicacao.ts`               | the pure decision `resolverTabelaDeMedidasDoAnuncio` → `fonte` (`modelo` / `foto` / `nenhuma`), `motivo` (why no template), the bands, `fotoOmitida` and `avisoObrigatoria`.                                                                                                               |
| `anuncios/{errosPublicacao,problemasPublicacao}.ts` | the two problema-only motivos and their two rows on `size_chart_info`.                                                                                                                                                                                                                     |
| package `tabelasDeMedidas.ts`                       | `ShopeeSizeChartInfoRequest` — a one-key union (`?: never` on each arm, so "both" and "neither" do not compile) — and its guard, run by both write guards before the token.                                                                                                                |

**`size_chart_limit` stays advice — with one vetoable exception.** `support_template_size_chart:
false` with a matching entry still sends the template (the operator picked it; L7).
`size_chart_mandatory: true` with nothing to send is `avisoObrigatoria`, a summary warning,
never a refusal. ⚠️ `support_image_size_chart: false` EXPLICITLY withholds the PHOTO
(`fotoOmitida: 'categoria-sem-foto'`): a refused photo refuses the publish (below), so sending
one to a category that says it takes none would refuse every produto of that category for a
fallback nobody picked. `null` (unknown — register 253) sends it. This is the orchestrator's
ruling, for Lucas to veto; it is one comparison in `tabelaMedidasPublicacao.ts`.

**Refusals — a 422 on `size_chart_info`, never retried without the chart.** The two
photo-UPLOAD rows are decided by the plan and thrown before the link read and before any
listing write, so they write no listing and no link stamp (only the photo pass's own
`externalIds` cache, as on every publish) — and never land on `image`. The two WIRE
refusals land like any other `add_item` / `update_item` rejection: nothing to stamp on a
create with no link yet, the usual `falhaPublicacao` stamp (the etapa and the problema) on
an existing link.

| what Shopee (or the upload) answers                                                                                           | problema — every row on `size_chart_info`, every sentence OURS                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the template id we sent: the detail page's stale-id sentence                                                                  | `tabela-de-medidas-recusada`, `MENSAGEM_TABELA_MEDIDAS_RECUSADA` ("tabela de medidas recusada pela Shopee — escolha outra em /medidas", Lucas's Q4). Decided by §4's classifier itself, never a phrase of publish's table. ⚠️ Never falls back to the photo (Q4). |
| the image chart: `please upload a more standard size chart image` (announcement 1337's validator, on both write pages)        | `tabela-de-medidas-foto-recusada`, `MENSAGEM_TABELA_MEDIDAS_FOTO_RECUSADA` ("…troque a primeira foto da tabela ou escolha um modelo") — Shopee's "Upload failed" would read as the listing's pictures.                                                            |
| the `upload_image` of that photo: Shopee refused it (`upload-recusado`)                                                       | `tabela-de-medidas-foto-recusada`, the validator's sentence + `(envio da foto: <motivo>, tabela <id>)`; headline "Publicação recusada pela Shopee em fotos".                                                                                                      |
| the photo never reached Shopee's judgement: a failed download (a network blip too), a skipped file, no arquivo, no `image_id` | `tabela-de-medidas-foto-recusada`, `MENSAGEM_TABELA_MEDIDAS_FOTO_NAO_ENVIADA` ("não foi possível enviar a foto … — tente de novo; se repetir, troque…") + the same suffix; headline "Publicação interrompida em fotos" — never "pela Shopee".                     |

- **ONE stale-template rule for the routes and for publish.** The template row is a
  predicate over the error — `classificarRecusaTabelaMedidas(err) === tabela-inexistente`
  (`error_param` + the folded sentence on `providerMessage`, §4) — and it is the refusal
  table's FIRST row, ahead of every phrase row, so publish says "stale template" exactly
  when the routes do: an earlier row's phrase (`Image not exist.`, `Invalid logistic info`)
  can never claim it. The string form `problemaDeErroShopee(code, msg)` has no error and
  never yields it — its only caller is the re-list door, which sends no chart.
- **Only the photo validator is a phrase of the table** — an EXACT, case-sensitive
  substring, the table's discipline; an unmatched sentence still reaches the operator as
  `desconhecido` with Shopee's prose.
- **Who failed the photo is ONE predicate**, `fotoDaTabelaRecusadaPelaShopee`
  (`planoPublicacao.ts`): only `upload-recusado` is Shopee's verdict. It picks the
  problema's sentence AND the 422's headline (`cabecalhoDaRecusa`, which the CLI's line
  calls too — no empty `()` when there is no code), so the two cannot tell different
  stories; "recusada pela Shopee — troque a foto" for a network blip would send the
  operator to fix a photo that is fine.
- Both motivos are problema-only (the blocked vocabulary stays at 22). Step 11's one-shot
  tax retry (the C13 shape) keeps whichever key was sent.

**Cost.** One extra Firestore read per publish of a produto that names a tabela; at most one
`upload_image` (zero on a cache hit, zero when a template matched); no Shopee read —
`size_chart_limit` is already in hand from step 10's `get_item_limit`.

**The echo.** The read-back's `size_chart_id` (raw) and whether a `size_chart` URL came back
(never the URL) are logged and reported as a diagnostic — the only reader of those two fields;
nothing derives the pick from them. A URL means `http(s)://` plus at least one more
character after trimming (`urlDeImagemLida`): a `-` placeholder, a blank, a bare `https://`,
`ftp://` or a relative path reads `false`, never "a photo came back".

## 7. What is UNVERIFIED, and what settles it

Step 18's settle-live register starts at **row 248**; this README is its home. All rows are
open, and no agent runs any of them (no Shopee call with a shop token). The cheapest single
session — on a BR apparel leaf, `taxonomia/limites` + `tabela-medidas/lista` +
`tabela-medidas/detalhe` on one id and on a bogus id — answers rows 248–258; one dry run and
one live publish of a produto whose tabela has a matching entry answer 262 and 264–265, and
one of a produto whose tabela has only a photo answers 267–269.

| #   | claim (the assumption the code makes)                                                                                                        | settles it                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 248 | list `size_chart_id` / `total_count` arrive as JSON numbers (the page's table says string) — the reader takes both                           | BR shop, one list call with ≥ 1 template       |
| 249 | the last list page has `next_cursor: ""` — absent / `null` is read `sem-cursor` (stop; `truncado` unless `total_count` is met)               | BR shop, a paged call                          |
| 250 | the cursor is opaque text with no edge whitespace and never a JSON number                                                                    | BR shop                                        |
| 251 | a NON-leaf `category_id` on the list → error / `[]` / union (the route never sends one)                                                      | sandbox or BR                                  |
| 252 | an empty list means "no templates" vs "shop not whitelisted" vs "category takes none"                                                        | BR: list + `get_item_limit` + Seller Centre    |
| 253 | BR `get_item_limit.size_chart_limit` is populated for an apparel leaf (vs absent / `null`); announcement 1010's logic tables                 | BR shop / docs (1010's images, not downloaded) |
| 254 | detail cells: one value per cell or zero-filled siblings (the type-first rule handles both)                                                  | a real BR chart                                |
| 255 | detail columns are rectangular in practice                                                                                                   | a real BR chart                                |
| 256 | `input_type` has only the three spellings                                                                                                    | a real BR chart                                |
| 257 | `display_name` / `size_chart_name` language for a BR shop                                                                                    | a real BR chart                                |
| 258 | stale id = `product.error_param` + "Size chart id not exist in this shop" verbatim; when "Category id is invalid" hits a leaf our tree knows | sandbox / BR, a bogus id                       |
| 259 | list / detail rate limits and the burst behaviour of a width-4 fan-out                                                                       | live 429s only                                 |
| 260 | the sandbox Seller Centre can author a template and the list answers there                                                                   | a sandbox session                              |
| 261 | corpus census: per-key `null`, extra keys, string / `0` ids, non-leaf / retired / duplicate `categoryId` per conta                           | read-only census of the legacy project (Lucas) |
| 262 | `size_chart_info.size_chart_id` is accepted as a JSON NUMBER on add / update (announcement 1404 types it string)                             | the first BR publish (the read-back echo)      |
| 263 | `update_item` WITHOUT `size_chart_info` keeps a Seller-Centre chart                                                                          | sandbox / BR                                   |
| 264 | add / update answer a stale template id with the detail page's sentence; whether a template of ANOTHER category is refused, and how          | BR                                             |
| 265 | `get_item_base_info.size_chart_id` echoes the sent id; its value with no template (`0` / absent / `null`)                                    | sandbox                                        |
| 266 | a BR mandate (`size_chart_mandatory: true` blocks `add_item`) and its error string                                                           | BR announcement watch / BR                     |
| 267 | `size_chart` accepts an `upload_image` id from the DEFAULT (square) scene — no size-chart scene is documented                                | BR shop: one upload + one `update_item`        |
| 268 | the image validator's exact sentence, and whether it is per photo or per call                                                                | BR shop: one refused photo                     |
| 269 | `support_image_size_chart: false` is ever answered for a BR apparel leaf — and whether Shopee honours it (a refusal) or it is advisory       | BR shop: `get_item_limit` + one publish        |

**Window items: none.** No index (`tabMedi` reads are document GETs), no ruleset (`tabMedi`
is off the validator whitelist and no `*Meta` changed), no TTL, no migration — the corpus is
read as-is and starts attaching at the cutover with no backfill. Deploy `apps/shopee` (the
routes) BEFORE `apps/web` (the tab that calls them); no functions deploy is required.
