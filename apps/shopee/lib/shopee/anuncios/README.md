# `lib/shopee/anuncios/` — publish and the listing lifecycle (step 11, #1519)

The design notes for the step that makes this app the first **WRITER** of a
Shopee listing. `apps/shopee/CLAUDE.md` keeps only the rules a reader must not
break and points here for the reasoning; this file is where the detail lives, in
the root `CLAUDE.md`'s sense of "detail lives where it is cheaper". The
reconciled design, the sandbox WRITE probe of 2026-09-17 and the wave reports
that produced this folder are in the step-11 review directory named by the PR
that closed #1519.

Everything here is **offline-verified only**. The probe measured the wire
through the package's own operations against the **SG sandbox** shop; no module
in this folder has ever run against a BR shop, staging or production.

## The twenty-two modules, in five families

The families are the seam, not a filing convention.

- **The seam and the pure half** — `errosPublicacao.ts` (the two error classes,
  the 22-member `MOTIVO_PUBLICACAO_BLOQUEADA` vocabulary, `ETAPA_PUBLICACAO`
  and `limitarMensagemProblema`), `constantesAnuncio.ts` (the ten app-level
  constants; every WIRE bound stays in `@delfrance/integrations-shopee`),
  `montagemAnuncio.ts` (the `add_item` / `update_item` bodies and eighteen
  pre-write refusals), `taxInfoPublicacao.ts` (the ten-member BR `tax_info`
  block), `logisticaPublicacao.ts` (`logistic_info`), `problemasPublicacao.ts`
  (Shopee's own rejection codes → a `problema` on a field),
  `statusAnuncio.ts` (the `estadoAnuncio` fold), `violacoesAnuncio.ts` (the ONE
  violation-detail builder) and `planoPublicacao.ts` (the plan as DATA, plus
  `ContextoPublicacao` and the step list). No clock, no network, no Firestore —
  which is what lets the CLI's dry run print what a live run would send.
- **The tier/model reconciler** — `tiersPublicacao.ts` (the inverse tier
  authoring, the live-option union, `mesmoModelo`) and `modelosPublicacao.ts`
  (the five model-leg calls and the three child-link passes).
- **The IO sequences** — `publicarAnuncio.ts` (`preparar` → `planejar` →
  `aplicar`, both write-backs, the re-list dance and the failure stamp),
  `fotosPublicacao.ts` (the photo up-direction), `lerImpostoDoProduto.ts` (the
  memoised imposto reader over the promoted NF-e cascade) and `linkAnuncio.ts`
  (the link readers and the ONE child-link sync).
- **The lifecycle** — `pausarAnuncio.ts` (pause / re-list over a selection) and
  `reverificarAnuncio.ts` (what the listing really is, right now).
- **The push arm and the surfaces** — `pushAnuncio.ts` (the codes-16/27
  handlers), `avisoAnuncio.ts` (the `anuncioComViolacao` producer and its
  resolver), `corpoPublicacao.ts` (the three routes' body readers),
  `publicarAnuncioCli.ts` (the rehearsal CLI's allow-list renderer) and
  `integracoesComProdutoShopee.ts` (the link trigger's Shopee bindings of the
  promoted `integracoesComProduto` core).

## The design, clause by clause

### One graph, read once, handed DOWN

`prepararPublicacao` assembles a `ContextoPublicacao` **once** — the produto and
its children, the grupos, the stored parent link and every child link, step 10's
item bands and attribute projection, the leaf verdict, the resolved marca, the
shop's logistics channels, the imposto reading and the photo resolver — and
every pure mapper downstream reads only that record. Nothing under `anuncios/`
issues a second opinion on any of it, and `deps.nowMs` / `deps.esperar` arrive
as parameters because the functions bundle reaches this folder.
`avisos/autorizacao.test.ts` reads every `.ts` file here as RAW TEXT — comments
included, since naming a converter in a comment sends a reader looking for a
site that does not exist — and asserts that none of them reads the ambient clock
or names either microsecond converter. ⚠️ **The timer is NOT covered by that
test**: there is no timer here because `esperar` is a parameter, which is
structural rather than asserted — and the same holds for the absence of the Next
server entrypoint, which only the wave gate's own grep checks.

The attribute tree is read only for a LEAF category — `get_attribute_tree`
answers nothing usable otherwise and `montarAnuncio` refuses a non-leaf with
`categoria-invalida` regardless — while the shop-wide item bands are read
either way, because that read is documented rather than degraded.
`get_channel_list` is paid ONCE per publish and is deliberately **uncached**
(`preparar` is where it lives; step 10's caches are for taxonomy reads).

### `preparar` → `planejar` → `aplicar`, and the split is structural

`prepararPublicacao` writes **nothing**: proved by a FakeDb that throws on every
write verb, not by a comment (`publicarAnuncio.test.ts`). `planejarPublicacao`
is pure and never throws — a refusal is a `problemas[]` entry on the plan, not
an exception. `aplicarPublicacao(deps, plano)` takes the plan and **no second
context**: everything the applier needs is on the plan, which is the point of
"the plan as data", and dropping the parameter makes that a compile-time fact.

⚠️ **The photos are resolved BEFORE the plan**, not at apply time.
`montarAnuncio` cannot build a body without the real `image_id[]` (an empty list
IS the `sem-fotos` refusal), and the `arquivos.externalIds` cache is read inside
the resolver's async call, so nothing pure can know the reuse/upload split.
Consequence, stated in `planoPublicacao.ts`'s header and in the CLI's caveats: a
**dry run uploads its pictures**. That cost is paid ONCE, because every
`image_id` lands in `arquivos.externalIds` and the next pass reuses it.

### The eleven steps, and why each write-back lands immediately

`aplicar` runs ONE order, asserted over the double's op log in
`publicarAnuncio.test.ts`:

1. `upload_image` ×N through the resolver (`fotosPublicacao.ts`)
2. `add_item` | `update_item` (+ the one-shot tax retry)
3. **parent write-back #1**, the instant Shopee confirms
4. `esperar(ESPERA_APOS_ADD_ITEM_MS)` — **5 000 ms, create-with-children only**
5. the FRESH `get_model_list` (update path) → `init_tier_variation` |
   `update_tier_variation`
6. `add_model`, then `update_model`
7. the reconciliation `get_model_list`
8. the child links and the vanished-model MARK
   (`sincronizarLinksDeVariacao`)
9. the re-list
10. the read-back through `lerAnuncioShopee`
11. **parent write-back #2**, from the read-back alone

Write-back #1 stores what was **SENT** (`item_id`, `category_id`, `item_name`,
`description`, `condition`, `attributes`, `logistic_info`, `brand_id`,
`taxInfoOmitido`, `publicadoEm` on the first success, `ultimaPublicacao`);
write-back #2 stores what was **READ** (`item_status`, `estadoAnuncio`,
`deboost`, `original_brand_name`, the refreshed `logistic_info`, and
`falhaPublicacao: null`). Both go through `aplicarLinkDaListagem` (merge/add —
a first publish must CREATE the link).

**Landing each write-back the instant its call confirms is what makes a
half-failed publish RESUME.** A link document holding an `item_id` and no models
makes the next publish an UPDATE that runs the tier leg; a failure at step ≥ 2
stamps `falhaPublicacao {em, etapa, erro, mensagem, problemas}` and **rethrows**.
On a CREATE that failed at `add_item` with no pre-existing link there is nothing
to stamp and the error simply propagates — a link that does not exist cannot
become a ghost. The `etapa` is refined from the error's own `path` for the model
leg alone, because that leg owns five calls and answers one result.

⚠️ **The read-back degrades, never fails the publish.** Step 10 narrows only
`ShopeeImportBlockedError`; `leituraDeVolta: false` says write-back #2 did not
happen and `avisoShopee` names the mechanism. Turning a landed publish into a
failure because the confirmation read refused would be the worse lie.

### The create sequence, and why the parent's price and stock are throwaway

A produto with children is created `item_status: 'UNLIST'`, because
`init_tier_variation` needs an item to attach to and a listing with one model
and no tiers is visible to buyers. The parent's `original_price` and
`seller_stock` on that create are the first child's values and are **replaced
inside the same sequence** — once models exist, Shopee ignores the item-level
pair entirely.

⚠️ **O3 (probe-measured).** The throwaway stock cannot be the design's `0`:
the sandbox shop answered `Stock should be within 2-1000000 for model`, so its
`stock_limit.min_limit` is **2**. The item-level value is therefore
`max(stock_limit.min_limit, the first child's available stock)`, and a produto
whose available stock sits **below** the band is refused before any write with
the blocked motivo `estoque-abaixo-do-minimo`, naming the band. Mercado Livre
accepts `0` here; Shopee does not, and that asymmetry is measured rather than
assumed. Pinned in `montagemAnuncio.test.ts`; the refusal is CREATE-only,
because `seller_stock` is absent from `update_item`'s table and a republish
sends no stock at all.

The quantity itself comes from `quantidadeParaPublicarShopee`, which CLAMPS DOWN
at `stockLimit.max` and **never UP** to `min` — clamping up would publish a
number the ERP does not have.

⚠️ **An ERP kit is an ordinary Shopee listing, and it publishes.** `ehKit` means
"assembled from `componentesKit`, availability derived from the components"; the
ERP holds thousands of them and the legacy app published them to Shopee as plain
listings. All `ehKit` does here is send the component-derived quantity. What
`produto-e-kit` refuses is a **native Shopee kit** (`add_kit_item`, step 19),
decided by `kitNativoDoAnuncio` in `montagemAnuncio.ts`: on a republish the
stored link's `kitNativo` — what Shopee itself reported about the live listing
(`tag.kit`) — and on a first publish the produto's `ehKitVirtual`, the ERP's own
statement that the marketplace resolves the composition. `false`, `null` and an
absent key all publish, because no native kit exists in this catalogue today.
The same predicate is called by BOTH producers of the refusal (the mapper and
`publicarAnuncio.ts`'s pre-write throw), which is what stops the two drifting.

### The update sequence: full lists, and `item_status` is never sent

`update_item` is a **field-wise merge and a list-wise replace**, so every list
goes out whole: `attribute_list`, `image.image_id_list`, `logistic_info`. The
update body carries **no** `item_status`, `original_price`, `seller_stock` or
`pre_order` — status is the lifecycle's business (and comes from a read, never
from a request), price and stock are steps 13 and 12.

Keys whose value is unknown are **ABSENT**, never `''` and never `null`. That is
why `gtin_code` is omitted rather than sent as `'00'`: `update_item` is
field-wise, so a placeholder would OVERWRITE a GTIN the operator set in Seller
Centre. `sem-gtin` still fires when the category's
`gtin_limit.gtin_validation_rule` is `Mandatory`. Same rule for `brand`,
`dimension`, `item_sku`, `attribute_list` and `tax_info` — `'tax_info' in body`
is `false` under the omit arm, pinned by a test, because a key present holding
`undefined` is invisible to a structural comparison.

### `model_list` is built from a FRESH read; a model with no ERP child is KEPT

Every `update_tier_variation.model_list` is derived from a `get_model_list` read
taken **inside** `aplicar` — never from the stored child links and never from
the plan. The plan's own `modelos` field is reconciled against `viva: null` and
is therefore PROVISIONAL; `aplicarModelos` re-runs both pure mappers from
`plano.modelosEntrada` against its own fresh tree, and a test pins that it reads
`plano.modelos` nowhere. An omitted model is a DELETED model at Shopee (the #831
shape one channel over), so a model whose `model_id` binds no ERP child is
carried in `modelosSemFilho` and kept in the list, and its tier option keeps its
position in the union. **No link document is deleted on any path.**

A live model whose `model_id` is `0` is in neither counter and in no list: `0` is
Shopee's "this item has no variation" sentinel and a link carrying it would bind
any line of any listing. It is counted in `ignorados` and logged.

⚠️ **O2 (probe-measured).** Both tier pages carry BOTH bounds for options per
tier, 20 and 50. A raw signed `update_tier_variation` with **21 options in one
tier was ACCEPTED**, so `SHOPEE_TIER_MAX_OPTIONS = 50` is now a measurement and
no longer a choice; `opcoes-demais` fires above it. Two tests pin the literal
(`tiersPublicacao.test.ts` and the package's own bound guard).

`mesmoModelo`'s three rungs are HIT tests, not vetoes — a stored non-zero
`model_id` that does not match the live one still falls through to the sku and
the tier-index rungs, which is what recovers a child whose id an earlier
`init_tier_variation` invalidated. Its PAIR and NEAR-MISS are named in the test
titles and in the docblock (rung 1 dominates; rung 2 is exact, empty-skip and
order-sensitive).

### A depth change invalidates every `model_id` — rewrite in place, never delete

`init_tier_variation` on an existing item replaces the whole tier structure and
**every `model_id` with it**. Reconciling by `model_id` after that would mark
every child as missing and then mint a SECOND link document beside it, so
`aplicarModelos` RE-POINTS each existing child link (merge, in place) on the
`init` arm **before** the sync runs. That is not a second sync:
`sincronizarLinksDeVariacao` is imported from `linkAnuncio.ts`, called exactly
once, and a raw-text test asserts no local `sincronizar*` exists in this folder
(C10 — the function has one home).

### Logistics: the stored list first, `get_channel_list` on a first publish

`construirLogistica` re-validates the link's stored `logistic_info` entry by
entry. If at least ONE entry survives, the stored list wins and the full build
never runs; only when it validates to EMPTY does the channel list become the
source. `pulados` always describes the pass that actually produced
`logistic_info`, so the two can never disagree.

A stored `size_id` that is not a safe positive integer **refuses** rather than
coercing (C32): the package's own `wireInt()` would coerce, and a coerced size
is a parcel dimension nobody chose. An unknown unit answers `null` from `paraCm`
and never a factor of `1`. `canaisHabilitados` is REPORTING — it unions the live
`related_enabled_channels` — and a channel can legitimately appear both there
and in `pulados`: the first says "on anyway", the second says "not sent by us".
Seven `MotivoCanalPulado` members, all producible, all pinned in
`logisticaPublicacao.test.ts`. An empty `logistic_info`, or a compulsory channel
we cannot satisfy, is the blocked motivo `logistica-sem-canal`.

⚠️ `update_item`'s request table omits `logistic_info` while every code sample,
its own error list and `announcement 1395` carry it. It is sent, and write-back
#1 stores it **as sent**; channel state is never read back from a write echo.

### `tax_info` is whole or nothing

The block is derived from the produto's **operação fiscal**, never hardcoded.
`criarLeitorDeImpostoShopee` resolves it through the five-tier NF-e cascade
promoted to `@delfrance/data/admin/imposto`, memoising the bundle as a PROMISE
(so two concurrent reads share one read, pinned by a test); `montarTaxInfo` is
pure and answers `{ taxInfo, omitido }` — a value XOR a reason, never both.
ONE leitor per publish, built at the composition root.

The emitted set is exactly **TEN keys**, every value a string: `ncm`, `cest`,
`origin`, `csosn` **XOR** `icms_cst` (by the operação's CRT — the seller is
Simples Nacional, so the ICMS side is normally a `csosn`), `pis`, `cofins`,
`pis_cofins_cst`, `same_state_cfop`, `diff_state_cfop` and `measure_unit`
(`'UN'`, `announcement 1260`). Anything else is **absent from the TYPE**, so
adding a field is a compile error rather than a forgotten rule.

⚠️ **The three seller constants are NOT sent** — `operation_type`,
`export_cfop` and `federal_state_taxes` — and no code path can emit them. They
belong to the operação's cadastro, not to a hardcoded literal, and that work is
tracked as **#1610**. A test reads this module as raw text to prove no code path
spells any of the three.

**The operação is the conta's `operacaoOuterRef`, and that is the RIGHT one**
(register 89, closed). It is documented as the PEDIDO operação, which reads like
a mismatch until you follow it: the NF-e this shop will issue for an order from
this very listing resolves through exactly that operação, so Shopee's
informational copy agreeing with the nota is the desirable property, not an
accident. A dedicated publish operação is a new `integracao` field and step 21's.

**The all-or-nothing rule and the ONE-SHOT retry.** Shopee refuses a partial BR
block with `error_param: all BR tax field should be empty or be filled at same
time`. On exactly that refusal the publisher retries the SAME
`add_item`/`update_item` **once**, with the whole `tax_info` key removed, and
records `taxInfoOmitido: 'recusado-incompleto'`. The bound is **structural, not
a counter**: the retry body has no `tax_info` key, so the same refusal cannot
recur. `FRASE_TAX_INFO_INCOMPLETO` is the one spelling of that sentence in the
app. Eleven `MotivoTaxInfoOmitido` members, and the reader and the mapper answer
the SAME vocabulary on purpose, so the link document carries ONE field
(`taxInfoOmitido = motivo ?? omitido`) and no caller branches on which half
refused. `imposto-incompleto` deliberately LEFT the blocked vocabulary (C14):
under the omit arm nothing can produce it.

⚠️ **What the probe could NOT settle (registers 67/68).** The SG sandbox
accepted the ten-member block AND the same block minus `cofins`, and the
read-back carried no `tax_info` at all — so that shop does **not** validate the
BR set. Which fields the validator counts, and whether the three unsent
constants count toward it, are still open; the one-shot retry is what makes that
survivable rather than blocking (register 69 is closed as "this shop does not
exercise it").

**Three legacy traps, each measured at `exportar.dart:1059-1079` and none
re-applied.** The legacy `pis` was DYNAMIC — `vAliqProd`, a per-unit VALUE where
the wire wants a percentage; `cofins` was **always null**, so the legacy shipped
a permanently partial block and apparently published; and `operation_type '1'`
(retailer) contradicts `export_cfop '7101'` (self-produced). The percentage
formatter here rounds through the shared money helper and pads to a fixed width,
with a PAIR (`1.65` ≡ `1.6500001`) and a NEAR-MISS (`1.654` ≠ `1.655`) pinning
that the rounding did not move; `cstConcordante` refuses a PIS/COFINS CST pair
that disagrees (`'01'` vs `'02'`) instead of picking one.

### Photos up: the `externalIds` cache is the same one the import writes

`criarResolvedorDeImagens` reads `arquivos.externalIds` — the field step 9's
import already writes on a dedup hit and the field ML's own importer reads — and
calls `upload_image` only on a miss. **ONE resolver per publish**, carried on
the context, because the memo has to span the item pass AND every option pass;
building a second one pays for the same picture twice.

`image_id_list` is rendered POSITIONALLY by Shopee, so the list is never
re-ordered and never sliced by a caller. The download is guarded by an anchored
host allow-list and `redirect: 'manual'` (a fake fetch cannot show a redirect
being followed, so the test asserts the OPTION); every log line carries the HOST
and the `image_id` and never the URL. Ten `MotivoFotoPublicacao` members, none
persisted; a picture-level problem is SKIPPED and counted, while a rate limit, a
reauth, any other Shopee error and every Firestore error propagate and fail the
publish. An empty `imageIds` is **not** a throw here — it is the `sem-fotos`
refusal one level up.

The option pass is **ALL-OR-NONE**: if any tier-1 option has no picture, no
option image is sent at all, and `montarTiers` re-applies that defensively.
⚠️ On a REPUBLISH the tier-1 grupo is chosen from the CREATE order, because
`preparar` reads no live tree; if the live tree puts another grupo first the
uploaded ids go unused. The cost is one upload, paid once.

⚠️ **O6 / O8 (probe-measured).** An **undocumented minimum image size** exists:
a 16×16 PNG was refused as `product.error_param: image is invalid or not
supported` under BOTH signing modes, while a 600×600 PNG was accepted. ERP
product photos are far above it, and the `upload-recusado` skip covers it either
way — no code changed. That case is also the evidence for O8: an image-CONTENT
refusal (kind `other`, stripped code `error_param` or `error_image*`) is a
**per-picture skip**, and every other code propagates. The same run settled the
transport: `upload_image` is **Public**-signed with the multipart field `image`
and answers the id at `response.image_info.image_id` (registers 70/71 closed),
so `SHOPEE_UPLOAD_IMAGE_SIGNING` is the one literal that would flip it and
production passes no per-call override.

### A refusal is thrown BEFORE any Shopee write; a rejection is a problema on a field

Two classes, two moments, and both **PERSIST**.

`ShopeePublishBlockedError` is OUR refusal: 22 motivos, raised before a single
Shopee call, carrying `problemas` that is **non-empty by TYPE** — the guard
`temProblemaDeBloqueio` is what turns a collected array into that argument, so
no path can construct the class with a fallback member nothing legitimately
produces. `ShopeePublishRejectedError` is SHOPEE's: an `etapa`, the provider
`shopeeCode` **verbatim (module prefix and all)** and the classifier's problemas,
which may be empty.

`problemaDeErroShopee` strips ONE leading `<module>.` before lookup and never
rewrites the error's own code; the strip is a SECOND lookup, and it is
load-bearing rather than decorative — the probe measured `product.error_param`
on the live wire. An unmatched code is `{ campo: null, motivo: 'desconhecido' }`
with Shopee's prose, never a guess. A `ShopeeRateLimitError` is deliberately NOT
converted: it has its own mapping, and a 422 telling the operator to fix a
healthy listing would be a lie. Every `mensagem` is capped at 500 characters by
construction, at the builder.

`errosPublicacao.test.ts` carries the producer grep (ruling O7): every one of the
22 blocked motivos has a producer OUTSIDE the declaring file, and every one of
the eleven `tax_info` motivos is written through its companion constant
somewhere under `anuncios/` or in the three routes. ⚠️ **A wave that adds or
renames a route file must update that test's route list**, and adding a motivo
with no producer reds CI by design.

### The status fold, and what `UNLIST` cannot tell you

`estadoDoAnuncio(leitura, agoraMs)` folds a reading into one
`EstadoAnuncioShopee` plus a `deboost` boolean. Its PAIR and NEAR-MISS are named
in the test titles (two readings that must fold the same; row 10's deboost, and
`>` vs `>=` on the schedule bound), and `deboostDeWire` has its own (`"FALSE"`
is false; `"0"`, `1` and `"sim"` are not the same answer).

⚠️ **A seller pause and a Shopee pre-launch UNLIST are indistinguishable on the
wire.** There is no field that tells them apart, which is why `pausadoPeloErp`
is a link FIELD the caller writes rather than a fold parameter: a parameter no
arm can read would be a false promise, and its near-miss test would be vacuous
(C19). The pre-2024 `DELETED` spelling folds to `removido`, because a migrated
document may still hold it.

⚠️ **O5 (probe-measured): never read listing state from a write echo.** The
probe sent `update_item {item_status: 'NORMAL'}`; the ECHO answered `UNLIST`
while the read-back one call later answered `NORMAL`. That was already the rule
(`announcement 1394` warns about it); it is now a measurement. The only thing
this folder ever takes from a write echo is `add_item`'s `item_id`, because that
is an identifier — and it is validated as a positive safe integer, a violation
being a provider anomaly rather than a publish refusal.

### Four writers of `item_status`, and why the overlap is safe

`item_status` / `estadoAnuncio` / `deboost` are written by FOUR paths: the
publisher's read-back, `pausarAnuncio`, `reverificarAnuncio` and the push
handlers. There is no ordering guard beyond "last read wins", and that is
deliberate — **all four write only what they just READ from
`get_item_base_info`**, so the field converges on the listing's real state
instead of on whichever request arrived last. `shopeeLink.ts`'s own docblock
names all four (it said TWO before this step) so the count cannot silently rot.

What is NOT shared: `pausadoPeloErp` is the lifecycle's alone,
`ultimaPublicacao` / `falhaPublicacao` the publisher's alone, and
`violacoesLidasEm` means "when the stored violation reading last MOVED" — the
re-verify stamps it only with a CHANGED list, because stamping it on every
healthy button press makes `ignorado-sem-mudanca` unreachable and turns a
read-only diagnostic into a write.

### Two write mechanisms: `merge` for publish, `mergeIfExists` (FLAT) for lifecycle

The publish path writes through `aplicarLinkDaListagem` (merge/add), because a
first publish must CREATE the link document. Every lifecycle path — pause,
re-list, re-verify, the push handlers, the child-link sync — writes through the
handle's `mergeIfExists` with a **FLAT** patch, so a listing that vanished is
never resurrected by a status write.

⚠️ The two are **not interchangeable**: `mergeIfExists` rejects a nested object,
so adding `ultimaPublicacao` or `falhaPublicacao` to a lifecycle patch is a
runtime TypeError, not a silent success. A test in each suite pins the shape.

### The link trigger: the zero-read fast path and why the survivor scan needs no index

`onProdutoShopeeLinkChanged` (`functions/src/`) is the **first Firestore trigger
in this functions codebase** and the tenth function: `onDocumentWritten` on
`produtos/{produtoId}/prodshopee/{linkId}`, `retry: true`, **no secrets**, it
enqueues nothing, and its `database` is the literal **`default`** inlined at
build time — never the `(default)` sentinel, which would fail every operation
with `5 NOT_FOUND`. It declares no per-function region: it inherits the
codebase's global options, like the nine functions before it.

`planejarMudancaDeLinkShopee(antes, depois)` is pure and answers
`{ add: [], check: [] }` on the **overwhelming majority** of invocations — a
status-only merge changes no affiliation, so the handler never opens a database
handle at all. A test pins that zero-read path directly, because it is what
keeps a trigger on every link write affordable.

⚠️ **The survivor scan is UNFILTERED on purpose.** When a link stops being live,
`sobrevivemAnunciosDoProduto` reads the produto's WHOLE `prodshopee`
subcollection and filters the conta and the liveness **in memory**. A `where`
would need a sixth Shopee composite; on Enterprise an undeclared index does not
throw, it silently full-scans and bills the scan, so the honest trade is the
in-memory filter over a subcollection that holds one document per conta. Step 11
therefore declares **no index at all** and `firestore.indexes.json` is
byte-unchanged. Adding a `where` reds three tests, and the reason is that file,
not style.

`anuncioShopeeVivo(raw)` is total and non-throwing, and reads an ABSENT
`estadoAnuncio` as VIVO — the safe direction: a draft link that has not been
published yet must not un-badge a produto. `contaDoLinkShopee` reads
`contaProdutoShopeeOuterRef` (⚠️ **not** ML's `contaOuterRef`), with a near-miss
test proving a `contaOuterRef`-shaped document resolves to `null`.

⚠️ **Register 81 is open and is MIGRATION-WINDOW work** (root `CLAUDE.md` rule
8): whether a gen-2 Firestore trigger on this project needs Eventarc/Pub-Sub
enablement that no existing Shopee function needed. It is recorded in
`functions/DEPLOY.md`'s Cutover section, settled by the first deploy, never by
an agent.

⚠️ **A Firestore import fires no trigger.** A `prodshopee` document that arrives
in the cutover import — the legacy corpus carries them — therefore leaves its
produto's `integracoesComProduto` untouched until something WRITES that link
again. Surfaced here, not acted on and not a TODO: the Shopee row is not
rendered until step 21/22, so nothing is owed before then, and the decision of
whether the badge needs a backfill belongs to the window.

### The push arm: codes 16 and 27

Step 3 parked both codes for this step; they now route to the **seventh**
`DestinoPush`, `anuncio`, and both `MOTIVO_PARADO` rows are deleted.
`tratarPushDeAnuncio` is reached through a **dynamic** import, deliberately: a
static one would drag `@delfrance/schemas` and the Admin collection handles into
the receiver route's own bundle, and a test bans it.

The handler re-reads `get_item_base_info` and **never writes a status from the
push body** — the body is a POINTER. Call budget: code 16 spends 2 calls (1 with
no link, 1 when the listing is gone), code 27 spends 1. `violacao` WINS over
`deboost` when a delivery carries both, because the motivo picks the operator's
REMEDY and labelling a takedown "rebaixamento na busca" sends them to the wrong
screen. An unmapped shop **DEFERS** (C25) with the shared unprefixed
`sem-conta` template — never an ack, because acking a delivery for a shop we
cannot resolve discards it; `ignorado-sem-vinculo` PARKS, naming the item.

`violacoesDeDetalhes` lives in its own pure module and is read by BOTH the
re-verify and the push handler, so the two can never drift (ruling O9). It reads
the deboost rows under **either** documented spelling, copies only the eight
modelled keys — an unenumerated prose key Shopee adds would otherwise reach
Firestore and every log line — and returns `{ violacoes, descartadas }` so the
discard count cannot be recovered wrongly later. `fix_deadline_time` and
`update_time` come out in MILLISECONDS, already floored at 2020-01-01.

The aviso `anuncioComViolacao` has ONE producer and FOUR resolvers (the code-16
handler, the re-verify, the publish read-back, and the `removido` arm), all
computing the same key through `chaveAnuncioComViolacao`. `params` never carries
`violation_reason` or `suggestion` — both are in `redact.ts`'s denylist, with
`violation_type` and `fail_error` the safe fields — and `params.prazo` is
OMITTED because the deadline rides the microsecond FIELD instead. The resolver
answers a TRANSITION, which is what an `avisoResolvido` counter counts.

⚠️ **O4 (probe-measured).** `get_item_violation_info`'s live SUCCESS body has
**no `error` key** at all, so a strict envelope parse failed the whole call
(register 73 closed: real). The transport gained a per-operation tolerance for
that ONE op, and every caller stays best-effort — a violation pull that refuses
keeps the STORED rows and says so through `violacoesLidas: false`, rather than
emptying them.

### The lifecycle surfaces

`pausarAnuncio` takes a SELECTION and makes **one** `unlist_item` call, answering
200 even when every entry was refused — a per-listing refusal is DATA. It
reconciles the response **by `item_id`, never by position**, writes nothing for
an accepted id absent from the read-back, classifies all three promotion-lock
spellings plus a `product.`-prefixed code, and orders its two doors from the one
literal `RELIST_PRIMEIRO` (so neither arm is dead code). Shopee's DAILY quota
comes back as `pausadoAte` — the next 00:00 UTC+8, pure arithmetic on
`deps.nowMs`, never an ambient timezone — while a BURST limit propagates.
⚠️ The bound and the single-produto rule are refused by the ROUTE, because the
orchestrator's assertion is a `ShopeeConfigError` and that class maps to 500.

`reverificarAnuncio` answers what the listing really is: it keeps the stored
`violations` when the pull refuses, marks a vanished model and never deletes one,
and writes an **empty patch (no write at all)** on an identical reading. Its
patch key set is exported as one list so a route or a test compares against a
single source.

⚠️ **Register 83 is only half closed.** The probe measured `unlist_item
{unlist: false}` re-listing a **seller-created** UNLIST item, so
`RELIST_PRIMEIRO = 'unlist'` stands. The Shopee **pre-launch** UNLIST — the
`error_set_normal_unlisted_item` case — is not reachable on that shop, and the
`update_item {item_status: 'NORMAL'}` fallback door exists for exactly it. The
caps row's `implementado` stays `false` regardless (step 22 flips it).

## Out of scope, on purpose

So nobody reads a gap as a bug:

- **Stock (step 12) and price (step 13).** `update_model` cannot carry either
  anyway. `quantidadeParaPublicarShopee` and step 12's sender must agree **on
  the fold** — both run the shared core's kit arithmetic through Shopee's two
  bindings in `estoque/quantidadeEstoque.ts`, never a second copy (the #1087
  lesson) — and deliberately NOT on every number. The kit own-stock knob
  `SHOPEE_STOCK_KIT_INCLUI_PROPRIO` is SYNC-only: `opcoesPublicacaoShopee` pins
  it off at create, so with it ON the sender adds a kit's own stock on top of
  the number the listing was created with. (The category band's maximum is the
  other parameter the two do not share: publish clamps down to it, and the
  sync reads no band.)
- **`size_chart_info` (step 18).** Never sent. A chart set in Seller Centre
  survives a republish because `update_item` is field-wise. ⚠️ `size_chart` is
  an image id on write and a URL on read — never round-trip it.
- **Publishing a kit ON Shopee (step 19).** A NATIVE Shopee kit is refused as
  `produto-e-kit` — `kitNativo` on the stored link, or `ehKitVirtual` on a first
  publish. An ordinary ERP `ehKit` produto publishes like any other.
- **`apps/web` (step 21)** — the produto tab, the `anuncioStatus` provider row
  and the registry rows. The three routes and the CLI land HERE.
- **`batch_add_item`**, and authoring `scheduled_publish_time` (it is READ, for
  the fold and for code 27).
- **`wholesale[]`** from the conta's `tabelasAtacado` — a recorded gap, and at
  Shopee mutually exclusive with per-model prices.
- **`description_type: 'extended'`, description images, `promotion_images` and
  video.** `description_type` is `'normal'` on both bodies.
- **`boost_item`**, `search_item`-based manual linking (an import IS the link),
  and `get_recommend_attribute` / `get_weight_recommendation` (step 21).
- **`delete_item` and `delete_model` have NO caller here.** Both exist in the
  package — `delete_item` for the probe's own cleanup, `delete_model` because
  `update_tier_variation` deletes by omission and a model is never deleted by
  this step. Recorded so a later reader does not read the absence as an
  oversight (registers 75 / 75's twin).
- **A dead-picture self-heal.** Shopee reports no parseable per-id message for a
  purged `image_id`; `error_param: Image not exist.` classifies to `sem-fotos`
  and the operator re-uploads. Recorded gap.
- **`brandshopee`.** Step 11 does not read the operator-curated shortlist: the
  marca cascade is `brand_id 0` ⇒ "No Brand", else the link's
  `original_brand_name`, else a BOUNDED `get_brand_list` paging loop, else
  `marca-sem-nome` on a create and `brand` omitted on an update.
- **No ruleset regeneration, no new env var, no new index, no
  tasks-invoker entry.** Every schema addition is on a bare const, so both
  generated rulesets and both snapshots stay byte-identical.

## What is UNVERIFIED and what settles it

The step-11 continuation of the master plan's settle-live register. ✅ = closed
by the 2026-09-17 sandbox probe; ⏳ = open, with what would settle it.

⚠️ **Correction (step 12, 2026-09-21).** The step-11 `produto-e-kit` refusal
keyed on `ehKit` alone and blocked the legacy kit catalogue from ever being
re-published; it is narrowed to the native-kit predicate (`kitNativoDoAnuncio`),
at both producers. The first republish after that change can create listings for
produtos that were previously unpublishable — it is a deliberate correction, not
a regression.

| #   | item                                                                                                                                | state                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 67  | which fields Shopee's BR all-or-nothing validator actually counts                                                                   | ⏳ the SG shop accepted the block AND the block minus `cofins` — one `update_item` from a BR shop                                                                               |
| 68  | whether `csosn` / `icms_cst` are alternatives, and whether the three unsent constants count toward the set                          | ⏳ same call. The one-shot retry is what makes this survivable                                                                                                                  |
| 69  | whether the SG sandbox exercises the BR `tax_info` path at all                                                                      | ✅ **no** — it ignores the block entirely and the read-back carries none                                                                                                        |
| 70  | `upload_image`'s signing mode                                                                                                       | ✅ **Public**, accepted on a 600×600 PNG                                                                                                                                        |
| 71  | the multipart field name (`image` vs `file`)                                                                                        | ✅ **`image`**, id at `response.image_info.image_id`                                                                                                                            |
| 72  | options per tier: 20 or 50                                                                                                          | ✅ **50** — 21 options in one tier were accepted                                                                                                                                |
| 73  | whether `get_item_violation_info`'s live body carries `error`                                                                       | ✅ **it does not** — hence the per-operation tolerance (O4)                                                                                                                     |
| 74  | `brandshopee` is untyped (`passthrough`), has no handle and no reader                                                               | ⏳ a step-21 decision: type it, or delete the meta                                                                                                                              |
| 75  | `delete_model` / `delete_item` ship with no step-11 caller                                                                          | ⏳ nothing. Recorded so the absence is not read as an oversight                                                                                                                 |
| 76  | step 9's CLI prints `tax_info` KEYS only; this one prints keys AND values (C34)                                                     | ⏳ a one-line docblock decision in a follow-up; step 9's file is untouched here                                                                                                 |
| 77  | `ACAO_STATUS_ANUNCIO` lives in `mercadoLivreLink.ts` and is now read by a Shopee route                                              | ⏳ a mechanical move later; the VALUE must not fork                                                                                                                             |
| 78  | the promoted `trailingSegment` and `operacaoIdFromImpostoRef` are the same fold twice                                               | ⏳ a follow-up; collapsing them here would be a cascade change dressed as a cleanup                                                                                             |
| 79  | `ex_tipi` is not sent, so the emitted key set is CONSTANT                                                                           | ⏳ the day a BR shop refuses a block without it                                                                                                                                 |
| 80  | no automated guard stops `packages/data` gaining an NF-e package dependency                                                         | ⏳ a PR-checklist clause; a boundary lint rule is out of scope here                                                                                                             |
| 81  | Eventarc/Pub-Sub enablement for this codebase's first Firestore trigger                                                             | ⏳ **migration window** — `DEPLOY.md`'s Cutover, the first deploy, never an agent                                                                                               |
| 82  | what `item_status` / `scheduled_publish_time` hold after a failed scheduled publish, and WHY it failed                              | ⏳ **nothing settles it** — push 27 carries three fields, none a reason, and there is no success push. The handler writes what it reads and the aviso says the cause is unknown |
| 83  | whether `unlist_item {unlist: false}` really re-lists                                                                               | ✅ **partly** — it re-listed a SELLER-created UNLIST. The Shopee pre-launch case is unmeasurable on that shop and the `update_item` door exists for it                          |
| 84  | whether `attribute_list` / `image_id_list` replace wholesale on `update_item`                                                       | ⏳ the full lists are always sent, which is correct under either reading                                                                                                        |
| 85  | whether an `image_id` expires or is reusable across items/shops, and whether `image_id_list[i]` ↔ `image_url_list[i]` is positional | ⏳ the per-integração `externalIds` scoping is the conservatism                                                                                                                 |
| 86  | whether a purged `image_id` is reported with a parseable per-id message                                                             | ⏳ recorded as a gap; no self-heal is built                                                                                                                                     |
| 87  | whether a Storage-emulator host can ever appear in `arquivo.url`                                                                    | ⏳ the allow-list's emulator entry is INERT today — a seeded emulator corpus                                                                                                    |
| 88  | whether a PUSH envelope may enter `fixtures/__wire__/` (which holds RESPONSE bodies)                                                | ✅ sidestepped — the push-16 body stays inline in its test, and no new fixture was committed                                                                                    |
| 89  | whether the conta's `operacaoOuterRef` is the right operação for a publish `tax_info`                                               | ✅ **yes** — the nota for an order from this listing resolves through that same operação                                                                                        |

Also unmeasured, and not a register line: nothing in this folder has met a BR
shop. The `esperar` of 5 000 ms, the re-list door order, the daily-quota reset
instant and the four `failed_reason` families are doc-and-probe facts, and the
first real listing is the first time any of them is observed in production.
