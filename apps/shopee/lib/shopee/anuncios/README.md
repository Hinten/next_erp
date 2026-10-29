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

## The twenty-nine modules, in five families

The families are the seam, not a filing convention.

- **The seam and the pure half** — `errosPublicacao.ts` (the two error classes,
  the `MOTIVO_PUBLICACAO_BLOQUEADA` vocabulary — step 11's 22 members plus step
  19's native-kit members and #1911's blocked members, whose count
  `errosPublicacao.test.ts` pins —,
  `ETAPA_PUBLICACAO` and `limitarMensagemProblema`), `constantesAnuncio.ts` (the ten app-level
  constants; every WIRE bound stays in `@delfrance/integrations-shopee`),
  `montagemAnuncio.ts` (the `add_item` / `update_item` bodies and nineteen
  pre-write refusals), `criacaoIncerta.ts`'s CLASSIFIER half (#1911: whether a
  FAILED create's `add_item` may have created the listing — the closed table of
  documented refusals, everything else `incerto` — plus `skuDaBuscaShopee`,
  the 202's sentence, ENSURE's problema builders and — #1911 P5b — the first
  create's (`problemasDoAnuncioExistente`); its IO half is under "The IO
  sequences"), `taxInfoPublicacao.ts` (the ten-member BR `tax_info`
  block), `tabelaMedidasPublicacao.ts` (step 18's `size_chart_info` decision),
  `logisticaPublicacao.ts` (`logistic_info`), `problemasPublicacao.ts`
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
  `reservaRascunho.ts` (#1911: a DRAFT's publish lock — the reservation and its
  second-listing scan, the pre-send re-read, the per-leg send gate, the
  write-back #1 claim and the token-guarded release), `criacaoIncerta.ts`'s
  `localizarAnuncioIncerto` (#1911 P5: ENSURE, reads only — `get_item_list`
  narrowed by `update_time_from`, one `get_item_base_info` batch through
  `../kits/componentesKit.ts`'s `lerBaseInfoDosItens`, and one
  `resolverLinkPorItemId` per surviving row; called only from
  `reservaRascunho.ts`, under the lock) and `verificarAnuncioExistenteShopee`
  (#1911 P5b: a `livre` draft's FIRST create looks for a listing the conta
  already holds with that SKU — `../kits/localizarKitPorSku.ts`'s same-SKU scan
  in its ordinary mode; called only from `aplicarPublicacao`, under the lock;
  both look-ups ride that file's ONE `get_item_list` walk), `rascunho.ts` (#1911:
  the draft route's create / edit / discard — the one `prodshopee` delete),
  `fotosPublicacao.ts` (the photo up-direction), `lerImpostoDoProduto.ts` (the
  memoised imposto reader over the promoted NF-e cascade),
  `lerTabelaMedidasDoProduto.ts` (step 18: the produto's `tabMedi`, one read,
  this conta's entries and the first photo) and `linkAnuncio.ts` (the link
  readers and the ONE child-link sync).
- **The lifecycle** — `pausarAnuncio.ts` (pause / re-list over a selection) and
  `reverificarAnuncio.ts` (what the listing really is, right now).
- **The push arm and the surfaces** — `pushAnuncio.ts` (the codes-16/27
  handlers), `avisoAnuncio.ts` (the `anuncioComViolacao` producer and its
  resolver), `corpoPublicacao.ts` (the three routes' body readers),
  `publicarShopee.ts` (step 19, PR 7: the ONE entry point the publish route and
  the CLI call — the dispatcher, then step 11's `publicarAnuncioShopee` or the
  kit arms, plus `ensaiarPublicacaoShopee`, the dry run's half, so the dry run
  and `--live` address ONE listing), `publicarAnuncioCli.ts` (the rehearsal
  CLI's allow-list renderer, the item AND the kit summaries),
  `reverificarAnuncioCli.ts` (step 19, PR 6: `reverificar:anuncio`'s pure half)
  and `integracoesComProdutoShopee.ts` (the link trigger's Shopee bindings of
  the promoted `integracoesComProduto` core).

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
A DRAFT's create — and since #1911 P5 every LIVE create, because one with no
link first mints its draft (`nomearCriacaoSemVinculo`) — leaves through the
"every way out" table of "A draft's first create runs under a LOCK" below:
`nao-criado` is stamped on the draft in the token-guarded release, then
rethrown; `incerto` is not stamped (lock kept, `criacaoIncertaDesde` recorded,
the 202); the token step is released unstamped. So a failed first create always
leaves a draft document behind, and no LIVE entry reaches `add_item` without a
link document — the stamp's "no link, nothing to stamp" branch is a defensive
guard reached only by calling `aplicarPublicacao` directly. The `etapa` is refined from the error's own `path` for the model
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

⚠️ **A child's price is its PARENT's when the parent propagates (D-9, #1521).**
Every model's `original_price` — and therefore that throwaway item price — comes
from `precoDoFilhoNaTabela` (`@delfrance/schemas`), Mercado Livre's rule and the
ONE copy step 13's price sync calls too: unless the PARENT's
`propagatePriceToChildren` is a stored literal `false`, every child is priced
from the parent's `precos` and the child's own map is never read, not even as a
fallback; a non-propagating parent leaves each child its own price and is never
read. The produto trigger copies the parent's map into the children only when
the parent's prices CHANGE, so a child created later, or imported by step 9,
can hold no price of its own under a priced family. A `null` on either arm is
still `filho-sem-preco`, on an update too.

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
statement that the marketplace resolves the composition. A DRAFT link takes the
first-publish arm (#1911 — see **A draft is never live** below). `false`, `null` and an
absent key all publish: a native kit's link carries the LITERAL `true` from the
link write that follows `add_kit_item` on (`../kits/vinculosKit.ts`), and no
native kit existed in this catalogue before step 19 created the first ones, so
an unstamped link is an ORDINARY listing.
The same predicate is called by BOTH producers of the refusal (the mapper and
`publicarAnuncio.ts`'s pre-write throw), which is what stops the two drifting.

⚠️ **Since step 19 (#1527, PR 7) `produto-e-kit` is a DEFENSIVE assertion,
never an answer.** The route and `publicar:anuncio` reach this folder only
through the dispatcher (`escolherArmaDePublicacao`, `../kits/armaDePublicacao.ts`,
called by `publicarShopee.ts`), which sends every native-kit link
(`kitNativo === true`) and every `ehKitVirtualEfetivo` produto with no live link
to the kit arms (`../kits/`) — and refuses `ehKitVirtual` without `ehKit`
(`kit-virtual-sem-kit`), since nothing in the stored data enforces
`ehKit === false ⇒ ehKitVirtual === false`. So this item planner never meets a
kit it should build; reaching the refusal means a kit slipped past the
dispatcher, and its sentence says it is a defect of the ERP. Two live ORDINARY
links still take step 11's lexically-first pick (`escolherLink`, L10(3)). ⚠️ One
exception (OP-27, PR #1869): `lerVinculosDaConta` matches the conta by
`idDoRef(contaProdutoShopeeOuterRef)`, so a legacy BARE-encoded link
(`integracao/<id>`) is now visible to publish, for a non-kit produto too — it
republishes onto that listing where step 11 created a second one. The pick's
ORDER did not change; the `item_id` lookups still compare exactly.

### A draft is never live (#1911, P1, D3)

A **draft** is a `prodshopee` document the ERP intends to publish and Shopee
never answered for: `ehRascunhoShopee` in `@delfrance/schemas`
(`shopeeLinkLeitura.ts`) — `item_id` null or ABSENT, and not `kitNativo: true`.
It is THE one predicate; no reader here tests `item_id == null` on its own
(#1369). ⚠️ Two near-misses are NOT drafts and keep their old reading: a CORRUPT
id (`item_id: 0`, `'123'` — neither vivo nor draft, a recorded residual) and an
item-less `kitNativo: true` link (a native-kit residue, the dispatcher's X).

**A draft is reachable only by a named `linkDocId`.** Before #1911 every reader
that picks a link on its own counted it as a listing, so a draft whose doc id
sorted first won the lexical pick over the LIVE listing: an unnamed publish sent
`add_item` (a second listing) instead of updating the live one, and a bulk pause
answered `pulado` for a produto whose listing was selling. Now:

- **The dispatcher** (`../kits/armaDePublicacao.ts`) classes it **R**, outside
  O ∪ RO, so the unnamed pick never sees it. An unnamed publish whose conta holds
  ONLY drafts refuses `rascunho-nao-nomeado` rather than handing step 11 `null`
  (`resolverLinkPorProduto` would then pick the draft lexically); a named draft
  on an `ehKitVirtualEfetivo` produto refuses `rascunho-em-kit-virtual`. Depth:
  `../kits/README.md`.
- **The tiered resolver** (`resolverLinkVivoPorProduto`, `linkAnuncio.ts`, for
  re-verify and pause) puts drafts in a fourth tier, last; a drafts-only produto
  still resolves (pause `sem-item-id`, re-verify 409), never a 404.
- **The stock and price planners** (`../estoque/planoEstoque.ts`,
  `../precos/planoPreco.ts`) drop drafts: no row beside a live link, `sem-link`
  for a drafts-only produto that reaches them (the denorm usually keeps it out
  of discovery already).
- **Step 11 itself, as defence in depth.** `linkListagemLido` stamps
  `LinkListagemLido.ehRascunho` from the RAW document — never from the projected
  `item_id`, which is already folded (`0` reads `null`) and would pass a corrupt
  link for a draft. `kitNativoDoAnuncio` then sends a draft to the FIRST-PUBLISH
  arm (`ehKitVirtual`): Shopee never answered for it, so nothing on it is a
  reading of a listing. A caller that bypassed the dispatcher with a draft on a
  kit-virtual produto therefore hears `produto-e-kit` ("defeito do ERP",
  `campo: 'ehKitVirtual'`) instead of sending the kit out as an ordinary
  `add_item`. `vinculoDecideKitNativo` is the one branch both producers read, so
  the `campo` label follows the arm the predicate took.

Unchanged on purpose: `anuncioShopeeVivo` and the `integracoesComProduto` denorm
(they already exclude drafts); `resolverLinkPorProduto` (the dispatcher hands it
the id it chose); every `item_id`-keyed lookup (a draft has no `item_id` to
match); the kit component reads (`ehKitNativoAtivo` needs an `item_id`); the web
readers (#1911's web PRs). Publishing a NAMED draft is step 11's first publish,
as before — it is the only way a draft is ever published. The proof is
`publicarShopee.test.ts`'s #1911 block: an unnamed publish beside a draft that
sorts first sends exactly ONE `update_item`, for the live item, zero `add_item`,
and leaves the draft byte-unchanged. No write, no schema shape, no index, no
ruleset regeneration.

### A draft's first create runs under a LOCK (#1911, P3, D4 + D15)

`add_item` is not idempotent, so a draft published twice at once — two tabs, two
operators, the CLI beside the tab, a request the platform froze and later woke —
is two listings. The lock (`publicacaoEmCurso: {desde, expiraEm, token}` on the
draft, ms, server-stamped; read ONLY through `estadoPublicacaoRascunhoShopee` in
`@delfrance/schemas`, `shopeeRascunho.ts`) makes "both send" impossible.
`reservaRascunho.ts` is the mechanism; `publicarAnuncioShopee` decides which way
out a failure is. A republish of a listing takes no lock and is byte-for-byte
step 11's; a LIVE create with no link mints a draft first and is then this
section's (P5, K1-5 — below), while its dry run mints nothing and locks
nothing.

1. **Reserve BEFORE `preparar`** reads what will be sent, so no edit can change
   it underneath. Rule 7 tier 1: `update({publicacaoEmCurso}, {lastUpdateTime})`
   against the snapshot that decided, ≤ 3 re-derives (a lost precondition
   re-reads and re-DECIDES, never re-applies). The reading decides: a live lock
   — or a STAMPED one (step 3) inside its **post-expiry grace**, from
   `expiraEm` until `AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS` (240 s) later — ⇒ 409
   `EM_ANDAMENTO` with `aguardarMs`; past the grace, an unreadable lock or a
   recorded `criacaoIncertaDesde` ⇒ 409 `CRIACAO_INCERTA` in P3, the ENSURE
   scan since P5; no longer a draft ⇒ 409
   `JA_PUBLICADO`; a third loss ⇒ 409 `CONTENCAO`. The token is a fresh
   `newDocId` (no IO, no clock).
   ⚠️ **An expired lock its run never STAMPED, on a draft with no
   `criacaoIncertaDesde`, reads `livre` the instant it expires** (batch-A
   review, Lucas 2026-10-28): the stamp is written before every `add_item`
   leg, so that run died before the send — the same-SKU walk ran past the
   request ceiling, the instance went away — and nothing was sent under it. It
   is simply replaced: NO record, NO ENSURE, and the publish is a FIRST
   create, whose same-SKU look-up walks the WHOLE shop. Read as an uncertain
   create (the rule before), ENSURE's window — "updated since the attempt" —
   never saw an OLD unlinked same-SKU listing, and the first-create check was
   skipped for the SKU ENSURE had searched: a duplicate `add_item`. A STAMPED
   lock keeps the grace and then `incerta` (its run passed the first-create
   check before stamping, so ENSURE's window covers what that check could not
   have seen), and so does ANY lock on a draft with a record — a takeover that
   died unstamped never erases an earlier REAL attempt. ONE rule
   (`estadoPublicacaoRascunhoShopee` + `janelaDaCriacaoIncertaShopee`), read
   by the reservation, the draft routes, the import and the web. It holds
   because batch A deploys as ONE: the lock (P3) never ships without the stamp
   (P6).
2. **Lock-THEN-scan (D15 at publish, K1-4).** With our lock written, the
   produto's other links of the conta are read (`lerVinculosDaConta`, one
   subcollection read, no index). Any of them not `livre` ⇒ release ours, 409
   `EM_ANDAMENTO {aguardarMs?, vinculos}` — even with the confirmation;
   `vinculosQueExigemConfirmacaoShopee` non-empty and no
   `confirmarSegundoAnuncio` ⇒ release ours, 409 `CONTA_JA_TEM_ANUNCIO` with
   `vinculos`. Each reservation WRITES before it READS, so of two concurrent
   ones the later scanner sees the earlier lock: they can both abort, never both
   pass.
3. **The pre-send re-read** (in `aplicarPublicacao`, right before `add_item`):
   the stored token must still be ours, else 409 `PUBLICACAO_EXPIRADA`, nothing
   sent, the foreign lock untouched. Since the batch-A review it also WRITES —
   one token-guarded update stamping the folded SKU the body sends on the lock
   (`publicacaoEmCurso.sku`), so an uncertain create is later looked up by what
   it SENT (P5's section); a third lost precondition is 409 `CONTENCAO`. That
   stamp is the ONLY writer of `sku` (the takeover writes a fresh lock without
   it, the `incerto` re-arm carries it), always a string (`''` for a SKU-less
   body) — which is what lets step 1 read an unstamped expired lock as "never
   sent".
   `aplicarPublicacao` also refuses (409 `CONTENCAO`) a create onto a draft it
   holds no lock of: a draft's `add_item` is sent only under its lock.
   **Both look-ups run under the gate's deadline** (batch-A review): ENSURE
   (step 1) and the first create's same-SKU scan (P5b, below) ask
   `dentroDoPrazoDeEnvio` — the gate's ONE condition (step 4), handed to the
   walks as a `podeContinuar` closure (`buscaNoPrazoDoEnvio`), so
   `criacaoIncerta.ts` and `kits/` stay clock-free — before EACH
   `get_item_list` page and EACH `get_item_base_info` chunk. A `false` stops
   the walk with NO decision on what it read (a definite hit in a finished
   chunk included) and answers 409 `PUBLICACAO_EXPIRADA` ("a busca não coube no
   tempo desta requisição — pelo CLI, que tem o tempo da trava, ela pode
   caber"), nothing sent, the lock handed back (ENSURE's record kept). Lucas's
   largest conta holds 2 000–10 000 listings: a walk the platform cut at 180 s
   used to leave the lock UNSTAMPED with its run gone.
4. **The per-leg send gate (K1-2).** Synchronously before EACH `client.addItem`
   — the C13 fiscal retry's second leg included: send only while
   `agora() + MARGEM_ENVIO_SHOPEE_MS < min(expiraEm, prazoDaRequisicao)`. `agora` is the
   route's clock read LIVE on every call (`deps.aoVivo.agora`, REQUIRED, no
   fallback to `deps.nowMs` — a constant would make the gate vacuous, K1-3);
   `prazoDaRequisicao` is the route's `nowMs + TETO_ROTA_SHOPEE_MS` (=
   `apphosting.yaml`'s `timeoutSeconds`, pinned by `publicar/route.test.ts`;
   `nowMs` is the handler's FIRST statement, before the token check and the
   body parse), `null` from the CLI. **Each leg first WARMS the credential**
   (`deps.aoVivo.aquecerCredencial`, REQUIRED — the context's own
   `getAccessToken`, the function the client signs with; the token never
   reaches `anuncios/`). `client.addItem` asks for the token before it builds
   the request, and a token inside `REFRESH_SKEW_MS` turns that ask into a
   provider refresh with NO deadline; warmed first, the refresh is paid before
   the gate reads the clock, and the ask left between the gate and the request
   is one credential read, which MARGEM covers. So no create's request STARTS
   at or after `expiraEm`, and none the request's own ceiling could cut off
   mid-send — which is what the 240 s grace is measured from (residual (vi)
   below names the one gap).
5. **Write-back #1 is a CLAIM**: still a draft ⇒ one guarded `update` writing
   the item AND `publicacaoEmCurso: null` on the SAME document; already our
   `item_id` ⇒ the plain merge (a replay); another item claimed it, or the draft
   was deleted ⇒ `add` a fresh link — two LINKED listings, never an orphan. The
   claim ignores the token on purpose: the listing exists, and clearing a foreign
   lock makes its holder's pre-send re-read refuse.
6. **Every way out**, tracked on `ReservaDeRascunhoShopee.fase`:

   | what happened                                                                                                                                                                     | lock                     | `falhaPublicacao`                                |
   | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------ |
   | a throw before any send (blocked plan, photo/taxonomy read, a look-up cut by the deadline, the credential warm — a Shopee error of its refresh included —, the gate, a lost lock) | released (token-guarded) | none                                             |
   | `add_item` refused for good — `nao-criado` (`criacaoIncerta.ts`)                                                                                                                  | released                 | stamped, in the SAME guarded update              |
   | the client's own token step inside `add_item` (the four credential classes, P5) — `nao-criado`                                                                                    | released                 | none — Shopee was never reached                  |
   | `add_item` `incerto` (network, edge, unparseable 2xx, an UNKNOWN code, a documented "maybe")                                                                                      | **KEPT**, re-armed (P5)  | none — a 202, never "Shopee refused" (P5, below) |
   | any non-Shopee error once a send began, or the claim lost three times                                                                                                             | **KEPT**                 | none                                             |
   | anything after the claim (the model leg, the re-list, the read-back)                                                                                                              | already null             | step 11's stamp, on the claimed link             |

   A guarded write whose stored token is NOT ours writes NOTHING — not the
   release and not the stamp (K1-14): a run never clears or stamps over the run
   that took over. A KEPT lock expires, serves its grace, then reads `incerta`.
   In P3 the next publish was refused with `CRIACAO_INCERTA`; since P5 it runs
   the search instead (ENSURE, **An uncertain first create is re-found, never
   re-sent** below) — at no point of the stack is a draft whose create could
   have happened re-sent unsearched (K1-15).

   ⚠️ **A release never replaces the error the run is reporting.** The three
   ways out that release and then rethrow — the D15 refusal (step 2), a throw
   before any send, and a `nao-criado` refusal with its stamp — release through
   `liberarTravaShopeeSemSubstituirErro`: a gRPC-coded Firestore failure of the
   release (`isGrpcStatusError`) is logged once (ids and the code) and
   swallowed, so the error the run was already reporting is the one that
   surfaces — the 409/422 the operator acts on, or a read failure's own 5xx —
   never the release's. The lock
   then stays and expires — into `incerta` like a KEPT one when it was
   stamped (a `nao-criado` create: its failure stamp is lost with it, the
   accepted residual; a gate refusal after the stamp), into `livre` when its
   run never reached the stamp (the D15 refusal, a throw before the pre-send
   re-read: nothing was sent). Any other error from the
   release (a `TypeError`, a bug) still surfaces. A run with no error to report
   — `preparar` finding nothing to publish (the 404) — releases with the plain
   `liberarTravaShopee`, whose failure is then the answer.

The 409s are `ConflitoDeRascunhoShopeeError` — an APP class, never a
`ShopeeError`, so no stamp is ever written for one; the route maps it with
`instanceof` BEFORE `isShopeeError`, and the CLI recognises it by its `code`
(its class's home holds the collection handles, which the `--help` path must not
load). Every code is `CODIGO_RASCUNHO_SHOPEE`'s, the one vocabulary the web
reads too. The publish body and the CLI gain `confirmarSegundoAnuncio` /
`--confirmar-segundo-anuncio`; the dry run never takes the lock
(`PrepararPublicacaoDeps` omits `aoVivo`).

`marca-nao-escolhida` (D10) refuses a draft whose `brand_id` is not a safe
non-negative integer (`null`, absent, `-1`, `'77'`, `1.5`… — fail-closed since
P5, `rascunhoSemMarcaShopee`) — "Sem marca" is the explicit `0`. `linkListagemLido` stamps
`LinkListagemLido.marcaNaoEscolhida` from the RAW document through
`rascunhoSemMarcaShopee`, because the projected `brand_id` already folds absent
and `null` together and an imported listing's `null` must never refuse.

Cost: every NAMED publish now reads its link once more (the reservation's first
read decides whether it is a draft at all), and a draft's publish reads the
produto's link subcollection once more (the scan) plus the pre-send re-read,
and one more credential read per `add_item` leg (the warm; the client's own ask
then reads it again), plus — since the batch-A review — ONE more write before
the first leg (the pre-send re-read stamps the SKU the body sends on the lock).
A publish of an `incerta` draft also pays ENSURE's reads (the narrowed
`get_item_list` pages, one base-info batch, one `resolverLinkPorItemId` per
surviving candidate — "An uncertain first create is re-found" below), and the
FIRST create of a `livre` draft whose body carries a SKU pays the UN-narrowed
same-SKU look-up: ⌈listings/100⌉ pages, ⌈non-kit listings/50⌉ base-info calls
(every ordinary listing is a candidate) and one link read per hit — "A first
create never duplicates a listing the conta holds" below. No
index, no ruleset, no multi-document atomic write — every guard is a single-document
precondition.

**Accepted residuals** (reconcile §5.1, recorded here as asked):

- **(i) A send that STARTED inside the window and whose Shopee processing
  outlives `expiraEm + 240 s`.** The transport has no fetch deadline
  (`apphosting.yaml`, `call.ts`), so a hung `add_item` can land after the grace;
  the claim then either converges (ours) or forks a linked second listing. A
  deadline mapped to `ShopeeNetworkError` (⇒ `incerto`) is #1094's to add — on
  the transport (`shopeeCall`, which the token refresh rides too, residual
  (vi)), not on `add_item` alone.
- **(ii) CLI clock skew (K1-10, deferred).** The CLI's own gate is skew-free
  (its `expiraEm` and `agora` share the laptop clock), but a laptop BEHIND the
  server by _d_ erodes the server-side grace by _d_ — absorbed while _d_ ≤ 30 s.
  Checking `writeTime` against `agora()` would need the shared FakeDb double to
  grow a wall clock; out of proportion for an operator-only tool.
- **(iii) Two concurrent reservations of one produto may BOTH abort** (liveness
  only — the operator retries).
- **(iv) An import's Shopee truth over a draft edited during `incerta`** (#1911's
  P5 adopts only with attempt evidence).
- **(v) A corrupt `item_id: 0` link stays neither vivo nor draft**: no lock, and a
  publish onto it is step 11's create-then-merge.
- **(vi) A warmed token that crosses its refresh skew before the client asks**
  (batch-A review). The warm makes the client's own token ask a fast path, but
  if the token's remaining life crosses `REFRESH_SKEW_MS` (60 s) in the
  instants between the warm and that ask — the synchronous gate plus
  `addItem`'s prelude, against a ~4 h token — the ask refreshes after the gate,
  with no deadline, exactly the send-starts-late case the warm exists to
  remove. A deadline on `add_item` alone would not bound it: #1094's deadline
  must sit on the transport (`shopeeCall`), which the refresh also rides.
- **(vii) ENSURE's window only WIDENS** (batch-A review). It opens at the
  attempt and stays there while the record stands; a refused look-up keeps the
  record. A late re-publish on a busy shop can hit the 20-page ceiling (2 000
  rows) — or Shopee's undocumented offset cap (`error_param` "get items offset
  over limit", which throws and hands the lock back) — on EVERY try, and waiting
  never helps. Nothing is duplicated; the draft is stranded, and while it reads
  `incerta` every other draft of the produto on the conta hears 409
  `EM_ANDAMENTO` with no `aguardarMs`. The exit, when Seller Centre holds no such
  listing: discard the draft with the attestation (`rascunho/descartar` +
  `confirmarCriacaoIncerta`) and create a new one — K1-11 stands, the attestation
  is NOT honoured for `busca-de-anuncio-incompleta`. What fills the window is
  every create and every `update_item` since the attempt — never a stock or
  price write, which does not move `update_time` (register 94). The new draft is
  still guarded: its first create runs the full same-SKU walk (P5b), so the
  manual exit cannot duplicate an older listing either. Follow-up #2061: fall
  back to that walk in the same run when the window walk hits its ceiling.
  `search_item` by SKU alone is no substitute (its index freshness after a
  create is unmeasured); #2064 pairs it with a recency walk for the first create.
- **(viii) `retomandoCriacao` lives in the adopting run's memory only.** ENSURE's
  adoption is written BEFORE the plan runs, so an adopting run that then fails,
  or an adoption by the product IMPORT (which never publishes), leaves a
  has-model listing the lost attempt created UNLIST — `pausado`, recoverable with
  re-activate — and the next publish is a plain update, which never lists. The
  durable fix (a `relistagemPendente` marker the plan reads) waits on Lucas.
- **(ix) A minted draft counts as a Shopee link for the produto delete guard**
  (`findProdutoReferences`: "vinculado(a) a anúncio(s): Shopee") until it is
  published with `--link` or discarded. Before P10's Descartar ships, discarding
  is `POST …/rascunho/descartar` with `{integracaoId, produtoId, linkDocId,
base}` (`base` required): do not run a no-link `publicar:anuncio --live`
  between batch A and P10's web deploy (#1998).
- **(x) A padded or shared SKU** (`' X'`, or two produtos with `'X'`) declines
  the import's SKU rung, which then MINTS a produto for the attempt's listing.
  ENSURE no longer ignores that link (it refuses `-ja-vinculada`, naming the
  other produto). Lucas decided the first-create half on 2026-10-26 (P5b): a
  FIRST create refuses when the conta already HOLDS a listing with the SKU —
  unlinked (`anuncio-existente-sem-vinculo`, "importe-o") or another
  produto's (`anuncio-existente-de-outro-produto`) — the kit arm's same-SKU
  SCAN mirrored, NOT its Firestore phase-A rows. What stays open: a padded or
  shared SKU with NO listing on the conta yet still publishes (the kit's
  `kit-sku-com-espacos` / `kit-sku-repetido` read `produtos` and are not
  mirrored), so an uncertain create's recovery import can still mint — which
  ENSURE then reports as `-ja-vinculada`; and the refusal's own "importe-o"
  binds to THIS produto only when its stored SKU is exact and unique, which
  the sentence says.
- **(xi) The first create's look-up is the WHOLE catalogue** (P5b). The kit
  scan's base-info batch covers the shop's few kits; the ordinary one covers
  every non-kit listing — ⌈n/100⌉ + ⌈n/50⌉ calls on every first create with a
  SKU, inside the route's 180 s ceiling (a slow walk STOPS at the deadline
  checkpoint before its next read — batch-A review — and ends in
  `PUBLICACAO_EXPIRADA`, nothing sent, the lock handed back;
  `publicar:anuncio --live` has no request ceiling, only the lock's
  `expiraEm`). A shop past the kit's 100 pages (10 000 listings) answers
  `busca-de-anuncio-existente-incompleta` on EVERY first create — the kit
  arm's own limit, and no flag overrides it; Shopee's undocumented offset cap
  (`error_param` "get items offset over limit", seen by the mass import) may
  bite first, and then the publish fails with that error, nothing sent
  (register **311**).
- **(xii) An `incerta` draft's retry runs ENSURE and NOT the first create's
  look-up** (Lucas: ENSURE already scans) — for the SKU fold ENSURE searched
  only: a body that sends any other fold (the SKU renamed between the
  reservation and `preparar`, or set on an attested SKU-less produto) runs the
  look-up on the body (batch-A review). ENSURE's window ignores a listing
  created before the attempt, so one that was unlinked between the first
  attempt's look-up and the retry is not seen; the first attempt of every
  draft since P5b ran the full look-up — and only an attempt that PASSED it
  is an attempt at all: ENSURE runs on a record or a STAMPED lock, and the
  stamp follows the look-up, so a run that died during it (the walk past the
  request ceiling) leaves an unstamped lock that reads `livre`, and the retry
  is a first create with the full look-up again (batch-A review, Lucas
  2026-10-28). And the dry run runs neither: both
  live under the lock, which only `--live` takes — its summary says so.

### An uncertain first create is re-found, never re-sent (#1911, P5, D5 + D15)

P3 split a failed create's `add_item` into `nao-criado` (the closed table of
documented refusals) and `incerto` (everything else), kept the lock on
`incerto` and refused every later publish of that draft. P5 replaces the
refusal with an answer and a search. The one rule behind all of it: **a second
`add_item` is sent only after Shopee's own listings prove the first created
nothing.**

**The `incerto` answer is a 202.** No `falhaPublicacao` (nothing was refused);
one token-guarded update RE-ARMS the lock for the wait —
`expiraEm = agora() + AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS` (240 s, the kit's one
copy) — and stamps `criacaoIncertaDesde: stored ?? lock.desde` (ms,
server-stamped, `shopeeLink.ts`): the START of the earliest attempt whose
outcome is unknown, so a second uncertain attempt never moves the window
forward past the first. The publish answers **202**
`respostaItemIncertoShopeeSchema` (`@delfrance/schemas`, `shopeeRascunho.ts`):
`{arma: 'item', desfecho: 'incerto', linkDocId, aguardarMs, reenvioVerificaSku,
recusa: {codigo, fraseShopee} | null}`, plus a `mensagem` for the CLI that the
schema never declares (the kit's precedent). `recusa` is Shopee's code and
sentence when Shopee answered one, so a deterministic refusal the closed table
does not hold is VISIBLE, never looped. `reenvioVerificaSku` is `false` when the
SKU the attempt SENT folds blank: the re-send cannot look the listing up and will
be refused `criacao-incerta-sem-sku`, whose sentence (and the 202's) never sends
the operator to `importar:anuncio` ALONE — the import binds a SKU-less listing to
a NEW produto (its SKU rung is the only one that reaches an existing produto),
so the listing first gets, in Seller Centre, the SKU the produto gets in the
ERP; then the import binds it to this produto and adopts the draft. Because the lock stays LIVE, every tab,
operator and the CLI hear 409 `EM_ANDAMENTO {aguardarMs}` until it lapses — the
server enforces the wait, the web's countdown is a nicety.

**ENSURE runs inside the reservation, under our lock, before `preparar`.** A
draft whose reading is `incerta` (a STAMPED lock past the grace, an unreadable
lock, or a recorded `criacaoIncertaDesde`) is reserved like any other — and the
window is read from the document (`janelaDaCriacaoIncertaShopee`:
`criacaoIncertaDesde`, else the old STAMPED lock's `desde` — an expired lock
never stamped is `livre`, no window, no ENSURE — and, from the SAME source, the SKU that attempt
sent: `criacaoIncertaSku`, else the old lock's `sku`) BEFORE our lock replaces
the old one, and written into the same update, so a released lock can never take
the record with it. No
window at all in `incerta` refuses; `null` never means "proceed". Then
`localizarAnuncioIncerto` (`criacaoIncerta.ts`):

1. **The SKU looked up is the one the attempt SENT** (batch-A review), never
   the produto's at re-publish time: the pre-send re-read stamps the body's
   folded `item_sku` on the lock (`publicacaoEmCurso.sku`, `''` = none) before
   the first `add_item` leg, so even a crash after the send leaves it there, and
   the `incerto` re-arm and a takeover carry it into `criacaoIncertaSku`. A SKU
   set, cleared or renamed between the attempt and the re-publish would
   otherwise skip the attempt's listing and create a second. Both sides go
   through the import's fold (`skuDoItemShopee`, `../produtos/resolveProduto.ts`,
   shared, trim-only, case KEPT: `' SKU-1 '` ≡ `'SKU-1'`, `'sku-1'` ≠ `'SKU-1'`;
   the file's `equivalence-fold-inventory.test.js` entry pins both). Recorded and
   ≠ the produto's current fold ⇒ `criacao-incerta-ambigua`, never scanned and
   NOT attestable (restore the sent SKU, or put one SKU on listing and produto
   and import). Recorded UNKNOWN (a lock that never stamped it, or two attempts
   that sent two SKUs) ⇒ the current fold is looked up and a REPORTED blank SKU
   is a doubt. A blank SKU to look up is refused `criacao-incerta-sem-sku` with
   ZERO `get_item_list` calls — a blank SKU would "hit" every SKU-less listing.
2. **`get_item_list`** (NORMAL / UNLIST / REVIEWING / BANNED) narrowed to what
   the attempt could have created: `update_time_from` =
   `inicioDaJanelaDaCriacaoShopeeS(desde)` (⌊desde/1000⌋ −
   `FOLGA_JANELA_CRIACAO_SHOPEE_S`, 300 s, floored at 1) and **no
   `update_time_to`**: a bound read off our clock at scan time sits above every
   write already made, so it could drop only a listing whose `update_time`
   Shopee stamps AFTER that reading — a Shopee clock ahead of ours, or a write
   racing the call — the fail-open direction; without it ENSURE reads no clock
   at all. (A stock or price write does NOT move `update_time` — register 94,
   probe P5, 2026-09-21, and `../precos/README.md` — so neither is a reason
   either way.) The trade-off is accepted: an unfrozen offset walk over more
   than one page can skip a row a write moves mid-walk (a frozen `[from, to]`
   would not help — its set shrinks as rows leave — and would bring back the
   drop above), and the window only widens (residual (vii)). Typically ONE page
   for a re-publish soon after the 202, where the kit's un-narrowed walk takes up
   to 100; whether Shopee honours a lone `update_time_from` at all is register
   **310**. A 20-page ceiling (`MAX_PAGINAS_BUSCA_ANUNCIO`) and the kit's cursor
   rules (a null or non-advancing `next_offset` stops the walk); a walk that
   stops early is `busca-de-anuncio-incompleta`.
3. **One base-info batch for the candidates, classified FAIL-CLOSED (K1-7)** by
   `criadoNaJanelaShopee(create_time, desde)` — `dentro` / `fora` /
   `desconhecido` (a `null`, `0` or unreadable `create_time` is `desconhecido`,
   never `fora`). `fora` and another REPORTED SKU are ignored — a REPORTED blank
   one (`''`) included when the attempt is known to have sent a non-blank SKU.
   Every other row is SKU-equal or a DOUBT (an UNREPORTED SKU — `null`, absent,
   no base-info row — or a reported blank one while the sent SKU is unknown).
   An UNLINKED row is a DEFINITE hit when its SKU is equal and it is `dentro`.
   A SKU-equal row ALREADY LINKED in the conta — to this produto, or (batch-A
   review) to ANOTHER, since the import matches more narrowly than this fold
   and may have minted a produto for the attempt's listing — is
   `criacao-incerta-ja-vinculada`, naming each link's produto (an older linked
   listing is excluded, as before). Everything else — a doubt, linked or not
   (an own-linked listing whose SKU Shopee did not report is never ignored), or
   SKU-equal unlinked `desconhecido` — is UNDECIDABLE.

The verdicts are decided in this order: ambiguity first (never overridable),
then an own linked listing (unless attested), then the adoption.

| what the scan proved                             | answer                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| exactly one definite hit, nothing undecidable    | **ADOPT** — token-guarded update `{item_id, conta ref, publicacaoEmCurso: null, criacaoIncertaDesde: null, criacaoIncertaSku: null, falhaPublicacao: null}`; the run continues as an UPDATE with `retomandoCriacao` (a has-model listing the lost attempt left UNLIST is re-listed — by THIS run only, residual (viii)), and edits made during `incerta` reach Shopee through that `update_item` |
| the SKU moved since the attempt                  | `criacao-incerta-ambigua` (no scan, no `acao`; never attestable)                                                                                                                                                                                                                                                                                                                                 |
| two or more definite, or anything undecidable    | `criacao-incerta-ambigua` (`acao` `importar{itemIds, vinculados}`)                                                                                                                                                                                                                                                                                                                               |
| a SKU-equal linked listing inside the window     | `criacao-incerta-ja-vinculada` (`acao` `importar{itemIds, vinculados}`, each with its produto); if it IS the attempt's listing, the exit is discarding THIS draft with the attestation — never publishing it again                                                                                                                                                                               |
| the walk stopped early                           | `busca-de-anuncio-incompleta` (repeating helps only a bad cursor — residual (vii))                                                                                                                                                                                                                                                                                                               |
| the request deadline cut the walk (batch-A)      | 409 `PUBLICACAO_EXPIRADA` — asked before every page and every base-info chunk; NO verdict on what was read (a definite hit included), the lock handed back, the record KEPT                                                                                                                                                                                                                      |
| the SKU sent folds blank                         | `criacao-incerta-sem-sku` (no scan)                                                                                                                                                                                                                                                                                                                                                              |
| a COMPLETE walk, zero definite, zero undecidable | token-guarded clear of `criacaoIncertaDesde` and `criacaoIncertaSku`, then `add_item`                                                                                                                                                                                                                                                                                                            |

The four refusals are `ShopeePublishBlockedError`s: nothing was sent, and they
are produced ONLY in `criacaoIncerta.ts`, through `MOTIVO_PUBLICACAO_BLOQUEADA`
(`errosPublicacao.test.ts` and `montagemAnuncio.test.ts` pin the file and the
spelling). **`confirmarCriacaoIncerta`** (publish body; CLI
`--confirmar-criacao-incerta`) is the operator's attestation that Seller Centre
holds no listing this draft must become, and it is honoured for EXACTLY two verdicts —
`criacao-incerta-sem-sku` and `criacao-incerta-ja-vinculada` (a deliberate
second listing created minutes before sits inside the −300 s window) — ignored
everywhere else, and it never skips the scan on a produto that has a SKU
(K1-11). On a SKU-less produto the attested run proceeds WITHOUT a scan and
KEEPS `criacaoIncertaDesde` (no scan proved anything): only the write-back #1
claim clears it. A complete zero-hit scan's clear MUST land before `add_item`
— a lost one is 409 `CONTENCAO` / `PUBLICACAO_EXPIRADA`, lock released, nothing
sent. ⚠️ The dry run does NOT run the scan yet: it takes no lock, so it prints
the plan only (a read-only ENSURE in the dry run is a follow-up).

**D15 runs BEFORE ENSURE.** The reservation's lock-then-scan of the conta's
other links happens first, so a sibling's create in flight is a 409, never a
listing this draft adopts. The consequence: re-publishing an `incerta` draft on
a conta that already holds another listing or draft of the produto needs
`confirmarSegundoAnuncio` again, exactly as the first attempt did.

**The token step is `nao-criado` and unstamped.** The app's four credential
classes (`ShopeeRefreshEmAndamentoError`, `ShopeeSemCredencialError`,
`ShopeeContaSemShopIdError`, `ShopeeCredencialInvalidaError`) are thrown by the
client BEFORE any request, so `add_item` never reached Shopee: the lock is
released and no `falhaPublicacao` is written — nothing was refused. Since the
batch-A review the token step normally happens EARLIER, in the per-leg
credential warm (step 4 above), where ANY error — those four classes, or a
Shopee error of the refresh itself — leaves the lock `travada`, so it is
released unstamped before the classifier is ever asked.

**A no-link live create MINTS a draft first (K1-5).** A live item-arm create
with no `linkDocId` — reachable only when the conta holds no link of the
produto — first `create()`s a draft through `rascunho.ts` at
`produtoShopeeLinkCollection.newDocId` (tier 0) carrying
`{brand_id: 0, original_brand_name: null}` (the old `?? 0` output, byte for
byte) and continues NAMED: the lock, the uncertainty memory and D15 apply as to
any draft, and the 202's `linkDocId` is never `null`. A refusal before the send
leaves that draft behind; the next unnamed run hears P1's `rascunho-nao-nomeado`
(`acao` `republicar{linkDocId}`) — and the draft counts as a link for the produto
delete guard (residual (ix)). **The mint race (batch-A review):** the dispatcher
hands `linkDocId: null` (flagged `despachoSemVinculo`) only after its read found
no link; the mint's own re-read finding one means another run minted or claimed
a draft, or the import added a link, in between — 409 `CONTENCAO`, nothing
written or sent, never a fall-back to step 11's lexical resolver (which would
pick that run's DRAFT and send `add_item` on it unlocked: two listings, and the
other run's lock stranded on a live link for ever). And `aplicarPublicacao`
refuses any create onto a draft it holds no lock of, so a draft's `add_item` is
sent ONLY under its lock.

**The import adopts a draft only on evidence (K1-8)** — the other reader of the
same window, through the SAME two functions in `@delfrance/schemas`
(`janelaDaCriacaoIncertaShopee`, `criadoNaJanelaShopee`), placed there so
`../produtos/` never imports this folder. A draft is adopted only with an
attempt window AND `create_time` `dentro`; its adoption clears
`publicacaoEmCurso`, `criacaoIncertaDesde` (with `criacaoIncertaSku`) and
`falhaPublicacao` with the `item_id` (`CAMPOS_LIMPOS_NA_ADOCAO_SHOPEE`), so the listing
never reads `em-andamento` / `incerta` afterwards. A draft without evidence —
every legacy draft, every never-sent one — is never touched. Detail:
`../produtos/README.md`.

**`error_repeated_mtsku` (D15)** — "A similar product has already been
uploaded", on `add_item` and `update_item` — is a row of
`problemasPublicacao.ts`: `item_sku`, wire-only `anuncio-semelhante-existente`,
matched by the CODE alone in the table's SECOND slot, so whatever sentence rides
with it the code decides. The create classifier reads the same code, alone, as
`nao-criado`, and a test holds the two readings of one error together. The
problema carries Shopee's prose; our sentence (import it if it is this
produto's; a second listing must differ, or Shopee may treat it as spam) is the
web's (P11) and the CLI's copy, keyed on the motivo.

Rule 7, the new writes: the pre-send SKU stamp, the `incerto` rewrite, the
zero-hit clear and the ENSURE adoption are token-guarded updates on the draft
(tier 1 — a foreign lock is never touched, a lost adoption re-derives); the mint
is a `create()` at a fresh id (tier 0); the import's adoption is
`update(…, {lastUpdateTime})` with no `...existente` spread (tier 1 — claimed
meanwhile ⇒ converge or fork, never a lost `item_id`). Still no multi-document
atomic write and no NEW index: the scan reads Shopee plus one
`resolverLinkPorItemId` per candidate that survives the SKU, window and
own-link filters — the `prodshopee (item_id, contaProdutoShopeeOuterRef)`
collection-group composite already declared in `firestore.indexes.json` — and
the import reads the produto's own link subcollection.

Three settle-live rows (never run by an agent; register **307**, **308** and
**310** below), none gating the build. **307 is a residual, not a fail-closed
case**: a listing Shopee's `get_item_list` shows only AFTER the 240 s wait is
invisible to the scan, which then reads "zero hits" and re-sends — the wait is
one constant, grown if the first BR measurement says so. **308 fails closed**: a
`create_time` Shopee does not populate reads `desconhecido` ⇒
`criacao-incerta-ambigua`, never a re-send.

### A first create never duplicates a listing the conta holds (#1911, P5b — Lucas, 2026-10-26)

Review finding F6 asked whether a FIRST create should refuse a padded or shared
SKU the way the kit arm does; Lucas answered **refuse + import**. So before a
`livre` draft's first `add_item` — still under its lock, after D15, after the
plan, immediately before the send (`aplicarPublicacao`) — the publish looks for
a listing of the conta with the SKU the planned body SENDS
(`criacaoIncerta.ts`, `verificarAnuncioExistenteShopee`):

- **The kit arm's scan, mirrored — ONE walk.** `../kits/localizarKitPorSku.ts`
  now hosts `localizarItensPorSku({kit})`: the kit scan is `kit: true`, this one
  `kit: false`; the walk underneath (`varrerListaDeItensShopee`) is the same one
  ENSURE rides. Un-narrowed `get_item_list` (NORMAL / UNLIST / REVIEWING /
  BANNED), the kit's 100-page ceiling, Shopee's own cursor; every row not
  EXPLICITLY tagged a kit is a candidate (a `null` tag is decided by its base
  row); one base-info batch; a hit is an ORDINARY listing
  (`ehKitDe(...) === false`, the import's reading) whose SKU folds equal under
  the import's fold (`skuDoItemShopee`: trim only — `' SKU-1 '` ≡ `'SKU-1'`,
  `'sku-1'` ≠ `'SKU-1'`); one `resolverLinkPorItemId` per hit. A native kit
  with the SKU is no hit, exactly as an ordinary listing is no hit for the kit
  scan.
- **The SKU looked up is the one the body sends** (`plano.item.criar.item_sku`,
  folded) — so a produto stored `' CAM-BR '` looks up `'CAM-BR'`, what Shopee
  will hold. A body with no SKU scans nothing (zero calls): there is nothing to
  compare, and a blank fold would hit every SKU-less listing.
- **Only where ENSURE did not already look this SKU up.** The reservation
  reports the fold ENSURE searched (`skuBuscadoNaReserva`, `null` when none
  was), and the publish skips this look-up ONLY when the body sends that very
  fold — an `incerta` draft whose SKU did not move (residual (xii)). A `livre`
  draft, an attested SKU-less one, and a SKU renamed between the reservation
  and `preparar` (which re-reads the produto) are all looked up on the body
  (batch-A review: the loser of that race must not skip the check). A
  republish never scans.

| what the scan found                                                                                                               | answer (a `ShopeePublishBlockedError`: nothing sent, the lock handed back unstamped)                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a hit NO link of the conta holds                                                                                                  | `anuncio-existente-sem-vinculo` (`acao` `importar{itemIds}`): import it instead of creating a second one, then discard this draft. The sentence adds that the import binds it to THIS produto only when the stored SKU is exact (no padding) and unique                                                                                                                      |
| a hit linked to ANOTHER produto                                                                                                   | `anuncio-existente-de-outro-produto` (`acao` `importar{itemIds, vinculados}`, each with its produto): two produtos share the SKU — give one of them its own                                                                                                                                                                                                                  |
| a hit linked to THIS produto                                                                                                      | excluded: D15's second listing, which the reservation already refused (`CONTA_JA_TEM_ANUNCIO`) or the operator confirmed                                                                                                                                                                                                                                                     |
| the walk stopped early (100 pages, or a stuck cursor)                                                                             | `busca-de-anuncio-existente-incompleta` (no `acao`) — the kit's `busca-de-kit-incompleta`                                                                                                                                                                                                                                                                                    |
| a LISTED candidate came back with NO base row (left out of the batch, the batch "none exists" verdict, or gone between the reads) | `busca-de-anuncio-existente-incompleta` (no `acao`), naming the ids: "a Shopee não devolveu os dados de N anúncio(s) listado(s) … tente de novo; se persistir, confira esses anúncios no Seller Centre". Never "not a hit": without its base row nothing says it is not this SKU (batch-A review — the kit scan skipped it since step 19; the ONE loop now refuses for both) |
| the request deadline cut the walk (batch-A review)                                                                                | 409 `PUBLICACAO_EXPIRADA` (`ConflitoDeRascunhoShopeeError`, not a blocked refusal) — asked before every page and every base-info chunk; NO verdict on what was read (a hit included), the lock handed back, no record written. The kit arm has no such checkpoint                                                                                                            |
| a Shopee or Firestore failure                                                                                                     | propagates untouched (rule 6) — the kit arm's answer: never classified as an `add_item` outcome, never stamped                                                                                                                                                                                                                                                               |
| a complete walk, no hit (or only this produto's)                                                                                  | `add_item`                                                                                                                                                                                                                                                                                                                                                                   |

Both kinds of hit are reported at once, one problema per kind (the kit's
aggregated refusal). **None is attestable**: neither `confirmarSegundoAnuncio`
nor `confirmarCriacaoIncerta` overrides them — the exit is the import, or a SKU
of its own. The three motivos are produced ONLY in `criacaoIncerta.ts`, through
`MOTIVO_PUBLICACAO_BLOQUEADA` (`errosPublicacao.test.ts` and
`montagemAnuncio.test.ts` pin the file and the spelling); the web's copy is
P11's (`TEXTO_MOTIVO_ANUNCIO_SHOPEE`). The scan's calls count into
`chamadasShopee`. Writes: none — rule 7 has nothing to add. Cost and limits:
residual (xi).

### A draft is created, edited and discarded through the draft route (#1911, P4, D1/D2/D18)

The browser never writes `prodshopee` (D1): three POST routes —
`rascunho`, `rascunho/atualizar`, `rascunho/descartar` (CORS admits only
`GET, POST, OPTIONS`, hence sub-paths, the `importar-todos/{cancelar,status}`
shape) — all `PERM.integracao.write`, write a draft through ONE module,
`rascunho.ts`. **Zero Shopee calls** on every path: the leaf gate, the bands and
the brand are publish's (`montagemAnuncio.ts`), never the draft's.

**The route owns four things and decides nothing else**: the caller check, the
JSON parse, the STRICT body parse (`corpo{Criar,Atualizar,Descartar}RascunhoShopeeSchema`
in `@delfrance/schemas`, `shopeeRascunho.ts` — an unknown key, `item_id`
included, is a 400, never dropped, so a web deployed before this app fails
loudly) and the CLOCK — one `Date.now()` per request, handed to `rascunho.ts` as
`nowMs`. No module in this folder reads a clock (the raw-text pin in
`statusAnuncio.test.ts`). Every answer body is built BY NAME, and its codes are
`CODIGO_RASCUNHO_SHOPEE`'s, the one vocabulary the web reads.

**Every value goes through `@delfrance/schemas`' ONE projection and its TWO
compares** (#1369): `camposDoRascunhoShopee` (absent ≡ `null`, verbatim — a
legacy `''` stays `''`); `mesmoValorDoRascunhoShopee`, the CONFLICT question
asked of a `base` (`undefined` ≡ `null`; `'Camiseta'` ≠ `'Camiseta '`, brand `0`
≠ `null`, `''` ≠ `null`; a brand pair by `brand_id` alone — the name follows the
id); and `mesmoValorGravadoDoRascunhoShopee`, the WRITE question asked by the
edit's "nothing to write" and the create retry — the same fold except that a
brand is its PAIR (`77`/`null` ≠ `77`/`'Acme'`), because every legacy draft
stores the id alone and re-picking the brand is how its name gets stored. The
web builds the `base` it sends from the same projection. A `base`
is parsed by the TOLERANT `baseRascunhoShopeeSchema` (what the operator SAW,
never normalised); only `patch` / `conteudo` go through the write whitelist.

`attributes` (P6, D9) is the one field read through a DECODER: the projection
passes a stored list through `atributosShopee.ts`'s `lerAtributosArmazenadosShopee`
into the REQUEST shape (the import's READ shape and the legacy no-`value_id`
value read as the values publish sends; not a list ⇒ `null`; nothing usable ⇒
`[]`), and the compare is `valuesEqual` (`@delfrance/core/equality`): key order
EQUAL; a reordered list, `value_unit` absent vs `''`, `[]` vs `null` DISTINCT.
The write schema refuses the READ shape (a 400) and normalises to exactly what
the decoder reads back, so an identical second save writes nothing — and a
stored legacy list that reads EQUAL is never rewritten (D9: no migration).

- **create** — tier 0, `create()` at the CLIENT-generated 20-character id.
  404 when the conta is absent or not Shopee, or the produto is absent · 422
  `PRODUTO_INVALIDO {motivo}` for a variation child or a virtual kit
  (`MOTIVO_RASCUNHO_INVALIDO_SHOPEE` — deliberately not the dispatcher's
  persisted slugs) · 409 `CONTA_JA_TEM_ANUNCIO {vinculos}` (D15: a live listing
  or another draft of the conta, `vinculosQueExigemConfirmacaoShopee`, without
  `confirmarSegundoAnuncio: true`; a `removido` one is no reason; the draft's
  own id never counts) · on `ALREADY_EXISTS` the stored document decides: the
  same conta's draft holding exactly what THIS create would write ⇒ **200**
  `criado: false` (a double click, a lost first answer); other content ⇒ 409
  `CONFLITO {conflitos}` (K1-9); anything else ⇒ 409 `ID_EM_USO`. "Exactly" is
  every projected field of the would-be document, so a key the retry OMITS is
  the `null` (or, for the title, the produto's `nome`) it would write — never a
  wildcard: a retry that drops a brand the lost first create stored is a 409,
  not a 200 over a brand the tab believes cleared. (Rev. 2 §3 P4 said "the
  retry's `conteudo` keys"; this tightens it in K1-9's direction.)
- **edit** — tier 3 + 1: the baseline compare, then `update(…, {lastUpdateTime})`,
  ≤ 3 re-derives. 404 `INEXISTENTE` (absent, or another conta's) · 409
  `JA_PUBLICADO` · 409 `EM_ANDAMENTO {aguardarMs}` (a live lock, its post-expiry
  grace included) · 409 `CATEGORIA_TRAVADA` (a patch that NAMES `category_id`
  while the reading is `incerta` — even with the stored value, and nothing
  beside it is written: the uncertain create may have used the stored one;
  DA-4 keys the lock on the patch, never on a value change) · 409
  `CONFLITO {conflitos}` (the stored projection ≠ `base` on a field
  `camposDaBaseDoRascunhoShopee` names — the PATCHED ones, plus `attributes`
  on a category change, below; a third lost precondition answers
  `conflitos: []`).
- **discard** — tier 3 + 1: the baseline compare over EVERY projected field,
  then `delete({lastUpdateTime})`, ≤ 3 re-derives. 404 · 409 `JA_PUBLICADO` ·
  409 `EM_ANDAMENTO` · 409 `CONFLITO` (stored ≠ `base`, K1-13: an edit made
  meanwhile is never discarded unseen) · 409 `CRIACAO_INCERTA` (`incerta`
  without `confirmarCriacaoIncerta: true`, K1-6: the draft is the only record
  of that attempt).

Answers: create **201** `{linkDocId, criado: true}` / **200** `{linkDocId,
criado: false}`; edit 200 `{linkDocId, gravados}` (`[]` = equal, NOTHING
written); discard 200 `{linkDocId, descartado: true, criacaoIncerta}`. A
refusal is `rascunho.ts`'s `RecusaDeRascunhoShopeeError` (an APP class, mapped
with `instanceof` BEFORE `isShopeeError`), its body built by
`corpoDaRecusaDeRascunhoShopee`: `error`, `code`, `linkDocId` and only the
detail key the code names — an absent key is "not applicable". The conta check
of a create throws `ShopeeContaNotConfiguredError` instead, so its 404 is
`shopeeErrorResponse`'s, like every conta-scoped route's. The 400 is the
route's own — Zod's rendering of the issues, paths and the schema's sentences,
never a value of the body — plus one of the module's: a create whose produto
has no usable name and no `item_name`.

Five rules a change must keep:

- **An edit never writes the lock.** An `incerta` lock survives every edit; only
  publish takes, claims and releases it (above).
- **The compare is over the fields the write touches** — the PATCHED ones, plus
  the `attributes` a category change clears; a field someone else edited that
  this request does not touch is not a conflict. On a discard it is over every
  field, because a discard throws all of them away.
- **`marca` is ONE field over two stored keys**: written whole (`brand_id` +
  `original_brand_name`; `null` ⇒ both `null`; `0` ⇒ the name `null`), compared
  by `brand_id` only for a CONFLICT (a `base`), and as the PAIR for a WRITE (the
  patch, the create retry) — the same brand re-picked with its name over a
  stored id-only brand writes the name.
- **A `category_id` write clears a stored `attributes`** in the same update
  (they belong to the old category) and reports `attributes` in `gravados` —
  unless the patch NAMES `attributes` itself (the operator chose them for the
  new category; an unchanged list is then kept, never wiped). ⚠️ **Only what
  the operator SAW is cleared (K1-12, P6):** beside such a patch the body
  REQUIRES `base.attributes` (else 400
  `MSG_BASE_SEM_ATRIBUTOS_NA_TROCA_DE_CATEGORIA_RASCUNHO_SHOPEE`) and the
  baseline compares it first, so an attribute save another operator landed
  meanwhile answers 409 `CONFLITO` naming `attributes` with nothing written.
- **The discard is this app's ONE `prodshopee` delete**, of a draft only, so
  `../produtos/links.ts`'s "never delete" gains exactly this exception. A publish
  whose create lands after the discard does not resurrect the draft: its
  write-back #1 `add`s a fresh link (the claim, above).

`rascunho.firestore.test.ts` runs the three real preconditions — `create()`'s
`ALREADY_EXISTS`, a stale `update(…, {lastUpdateTime})` and a stale
`delete({lastUpdateTime})` — on the emulator in `CI gate (shopee)`, so the
FakeDb double is never their only witness. It seeds DRAFTS only (the link
trigger's fast path answers zero reads and zero writes for a non-vivo
transition) on its own contas, `int-rasc-1` and `int-rasc-2` (never the round
trips' `int-1`…`int-4`), and never writes `integracao/{id}` (the create's conta
read is injected); every vivo case stays on FakeDb. `ID_EM_USO` is proved with
ANOTHER CONTA's draft at the id — a draft id is per produto subcollection, so
the same id under another produto is a different document and creates (201).

### `attribute_list`: ONE decoder and ONE validator, shared with the draft (#1911, P6, D9)

`atributosParaPublicar` decides nothing about attributes: it composes
`@delfrance/schemas`' `atributosShopee.ts` — `lerAtributosArmazenadosShopee` →
`atributosParaEnvioShopee` for the list, and the `obrigatorio-ausente` rows
of `validarAtributosShopee` for the missing names — the same module the draft
route projects with and the web's draft editor will render with (#1369). A
raw-text pin in `montagemAnuncio.test.ts` reds if `montagemAnuncio.ts` reads an
attribute value itself, names the legacy origin or converts a date itself. Its
signature is unchanged, because `publicarAnuncioCli.ts`'s dry run calls it too.

- **Three stored shapes, one request shape.** Write-back #1's REQUEST shape
  (`publicarAnuncio.ts` stores the `attribute_list` AS SENT, whenever a
  non-empty one is sent; the read-back, write-back #2, never touches
  `attributes`), the product import's READ shape and the legacy value with no
  `value_id` all decode to the request shape — `attribute_id` plus an
  `attribute_value_list` of `{value_id, original_value_name?, value_unit?}` —
  in stored order; the first entry of a repeated id that carries a usable value
  wins. An entry with no usable value is dropped, never sent empty (Shopee
  reads an empty list as a deletion).
- ⚠️ **A legacy custom value stored WITHOUT `value_id` is SENT** as
  `{value_id: 0, original_value_name}` (Lucas, #1911 Round 3 Q1 — the legacy app
  sent it too); a blank name is still dropped. Before #1911 it was dropped in
  silence, which on a mandatory attribute read only as "missing". A refusal of
  it is named by Shopee and routable to the attribute editor.
- **The mandatory check walks the tree by the values CHOSEN.** A root is named
  `name ?? '#<id>'` as before; new in #1911, a mandatory CHILD that a chosen
  value unlocks is checked too, named `"<filho> (em <pai>: <valor>)"` and listed
  right after its root. The child of an unchosen value is invisible and never
  missing; a mandatory root repeated in the tree is named once.
- **Every other finding of the validator reaches Shopee** — a custom value on a
  list-only attribute, a value outside the list, too many values, a unit, a
  value type, an orphan or another category's attribute: the editor shows them,
  publish refuses none of them and SENDS what is stored (a read-form date
  converted, below). Dropping invisible attributes (an unchosen parent's child,
  another category's) is the web draft EDITOR's job: it runs
  `atributosParaGravarShopee` over the operator's list before it posts the patch
  (P13, `AtributosRascunhoShopee.tsx`). The draft route (`rascunho.ts`) makes
  zero Shopee calls and has no tree, so it writes the patch's request-shape list
  as received, and publish sends what is stored. Until P13 nothing calls it, and
  the web never writes `attributes`.
- ⚠️ **A DATE stored in the READ form goes out in the WRITE form.** Guide 209
  §2.3 documents the write as a Unix timestamp in `original_value_name` and the
  read as `MM/YYYY` / `DD/MM/YYYY`; the product import stores the read
  verbatim, so an imported listing would otherwise send `06/2021` on every
  republish. `atributosParaEnvioShopee` converts a custom value whose tree node
  (anywhere in the tree) has `inputValidationType` 4 and whose name reads as a
  real read-form date, through `timestampDeDataShopee`. A timestamp is never
  re-encoded; an attribute the tree does not hold, another validation type and
  a text that is no real date (`31/06/2021`) go out as stored. The INSTANT —
  12:00 UTC, in SECONDS — is UNVERIFIED until the BR captures 1–3 (Q-DB2) and
  lives in ONE place in the shared module (`HORA_UTC_DA_DATA_SHOPEE` and the two
  functions beside it), so a capture amends one constant, not a caller.
  Write-back #1 stores what was sent, so the converted form reaches storage.

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
position in the union. **No link document is deleted on any publish path** —
the one `prodshopee` delete in this app is a DRAFT's discard (above).

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

### A grupo's tier: its binding entry, or a CUSTOM tier (#1911, D12)

Which `linksVariacoesShopee` element is a grupo's entry for the pair (conta,
LEAF category) is decided in ONE place: `resolverEntradaShopeeDoGrupo` and its
predicate `ehEntradaShopeeDaChave`, in `@delfrance/schemas`
(`produto/collection/shopeeLinkVariacoes.ts`). The import's merge
(`../produtos/taxonomiaShopeeCore.ts`) reads the same key. Before #1911 the two
spelled it twice and disagreed (the #1369 shape): the publisher folded the
stored conta to its last path segment while the import compared it byte-exact,
so a stored `documents/integracao/<id>` bound for the publisher and was twinned
by the import. The key folds only the STORED conta, through `idDoRef`:
`documents/integracao/int-1` ≡ `int-1`, `int-12` ≠ `int-1` in both directions,
and the category is compared exactly.

The resolver has three answers, and `montarTiers` authors one tier from each:

- `armazenada` — the FIRST element that parses and names the pair. The tier is
  built from it, as before #1911. An unreadable element BEFORE it does not hide
  it.
- `ilegivel` — no element naming the pair parses, but one the strict schema
  refuses names it on its raw fields. That is the operator's binding, stored
  broken. It refuses `variacao-sem-vinculo` ("existe mas não pôde ser lido —
  corrija-o em Variações") and NEVER falls back to a custom tier, which would
  silently swap a STANDARD variation for a custom one.
- `personalizada-implicita` — nothing names the pair. The tier is CUSTOM:
  `variation_id: 0`, `variation_name` = `grupo.nome`, and one option per used
  variante, `{0, variante.nome}` — both names through the NAME fold below. The
  50-option cap (O2, above) is unchanged.
  Outside Fashion every Shopee tier is custom, so this is the common case.
  Before #1911 it refused `variacao-sem-vinculo`, which is why the order test in
  `planoPublicacao.test.ts` was inverted ON PURPOSE.

⚠️ **Settle-live (Q3, register 309 below).** Whether Shopee BR accepts a custom
tier in a standardised (Fashion) leaf has not been measured. A refusal arrives
as a Shopee rejection, read by `problemasPublicacao.ts` like any other; the fix
is a STANDARD binding authored on `/variacoes` (#1911's binding editor).

**The NAME fold (#1911 batch-A).** Every tier and option name `montarTiers`
SENDS (`variation_name`, `variation_option_name` — the create, the init and the
update) and both sides of every name it PAIRS go through `nomeDeTierShopee`
(`../produtos/taxonomiaShopeeCore.ts`), the same fold `tiersDoItem` reads the
live tree with: the ENDS trimmed (an NBSP too), nothing else. So the string
sent, read back and compared is one. EQUAL: `'Cor '` ≡ `' Cor'` ≡ `'Cor'`,
`'Azul '` ≡ `'Azul'`. DISTINCT: case (`'Cor'` ≠ `'cor'`) and inner whitespace
(`'Azul Claro'` ≠ `'Azul  Claro'`). Before it, the reader trimmed while the
publisher sent and compared `grupo.nome` / `variante.nome` verbatim: a grupo
`'Cor '` was refused on every update of the listing its own create had made,
and a variante `'Azul '` never re-paired with the option it had created — the
live option was kept as a model-less orphan and a twin appended, on every
republish. The fold runs in the pure module, not the publisher's projection,
because `GrupoParaTier` is built by the plan, the model leg and the tests alike.
The option duplicate check keys on the folded name, so `'Azul'` and `'Azul '` in
one grupo refuse `combinacao-duplicada`. ⚠️ The IMPORT's grupo/variante rung 2
still compares the stored ERP name verbatim (step 9, untouched): importing a
listing created from a grupo `'Cor '` matches by `tipo` or creates a grupo
`'Cor'`.

**The name BANDS (#1911 batch-A).** `get_item_limit`'s
`tier_variation_name_length_limit` / `tier_variation_option_length_limit`
reach `montarTiers` (`bandaNomeDoTier` / `bandaNomeDaOpcao`). Every name the
publish AUTHORS — a custom `variation_name` no live tier holds, a custom option
name no live option of its tier holds — is checked with `textoNaFaixaShopee`
(the `item_name` check's function), measured AS SENT, and refused
`opcoes-demais` (the motivo Shopee's own `error_tier_*_too_long` maps to),
never truncated. On a CREATE the plan runs this, so the publish stops at
`[fotos]` BEFORE `add_item` — Shopee's own refusal arrives only at
`init_tier_variation`, after the listing exists, leaving it linked, UNLIST and
model-less. On an UPDATE the plan withholds the two bands (it holds no live
tree, so it cannot tell a name the listing already has from a new one) and the
model leg checks the new names against the fresh reading. A name the listing
already holds is never checked: Shopee accepted it, and refusing would block
every republish. A blank name is refused on both paths and whatever the band,
since our client's `assertTextoNaoVazio` would refuse it only after the create.
A `null` band checks no length — the behaviour before the review.

**The re-code refusal (Q2).** A custom tier has no identity but its NAME. On an
update it pairs with a live CUSTOM tier only when the names are equal through
the NAME fold above. A STANDARD live tier is claimed only
by a stored entry carrying its `variation_id`. An unpaired grupo used to be
rebuilt from the ERP alone while every live model kept its old `tier_index`, so
each model silently pointed at ANOTHER option, with the wrong stock and price
per variant and nothing to detect it afterwards. Now, when the model leg will
rewrite the tiers IN PLACE, a custom grupo that pairs with no live tier is
refused: "Importe o anúncio ou ajuste o nome do grupo". "In place" is
`reconciliarModelos`'s own predicate, shared and not copied
(`reconstroiAEstrutura`): some live model has a `model_id > 0` and the live
depth equals ours. The refusal covers the implicit fallback AND a STORED
`variation_id: 0` entry; the import writes those, and the legacy export named
its custom tiers by `tipo` (`Cor`, `Tamanho`), so a migrated listing can hit it
on its first republish. It fires in the model leg after `update_item`, where it
is stamped and recoverable. Neither of these is refused: a depth change
(1→2, 2→1), and a listing with no addressable model. Both are
`init_tier_variation`, which re-creates every model, so nothing can be re-coded.

- A grupo `'Cor '` facing a live `'Cor'` PAIRS (the NAME fold); `'cor'` or
  `'C or'` does not, and is refused like any renamed grupo. The batch-A review
  inverted the old `'Cor '` ≠ `'Cor'` near-miss on purpose: the reader trims, so
  a byte-exact pairing could never match a padded name.
- Addressable live models with NO readable tier (both trees absent, or every
  tier nameless and dropped by `tiersDoItem`) leave nothing to pair with. The
  live depth still comes from the models' `tier_index` (from the tree length
  only when every `tier_index` is empty). At OUR depth, or when no depth can be
  read at all, the leg would update in place and a custom grupo is refused; at
  any other depth it is `init_tier_variation`, so nothing is refused. The real
  wire always carries the tier tree with the models.
- **Not covered:** an unpaired grupo whose STORED entry is STANDARD
  (`variation_id ≠ 0`) is still rebuilt in place at the same depth, as before
  #1911 — Q2 decided the custom tiers only. Models bound by `model_id` or SKU
  follow their child; a child bound only by coordinate, or a live model with
  no child, can be re-coded. Reachable today only after a live standard tier
  was recreated or renamed in Seller Centre over an import-written entry; P14's
  binding editor makes it reachable on purpose. Refusing any grupo left
  unpaired at the same depth, whatever its `variation_id`, is the batch-A
  review's known item 2 — a follow-up, not #1911's. No test pins either
  behaviour yet.

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

### `size_chart_info` (step 18): the template first, else the tabela's first photo

Lucas, 2026-10-05 — the legacy order, re-verified in `.old/` (`exportar.dart`).
`add_item` AND `update_item` carry `size_chart_info` with EXACTLY one key: the
produto's tabela has an entry for THIS conta and the listing's RESOLVED category
⇒ `{ size_chart_id }` (the template WINS and the photo is never uploaded); else
the tabela's FIRST photo ⇒ `{ size_chart: <image_id> }`; else the KEY IS ABSENT —
never `size_chart_id: 0` nor `size_chart: ''`, Shopee's DETACH sentinels, so a
chart set in Seller Centre survives an update where nothing matched. ⚠️ Once
something matches, EVERY republish puts the ERP's pick back over a Seller-Centre
change (Q3); removing the entry in `/medidas` does NOT detach the live chart.

- **Read, decide, upload, build — in the existing split.** `preparar` reads the
  tabela (`lerTabelaMedidasDoProduto`, one `tabMedi` get, none without a ref);
  `tabelaMedidasPublicacao.ts` decides; the photo pass in
  `resolverFotosDaPublicacao` uploads the first photo through the SAME resolver
  (`resolver([foto], { cap: 1 })`, its allow-list and its `externalIds` cache —
  the dry run uploads it too); `montarAnuncio` builds both bodies.
- ⚠️ **ONE category resolution.** The photo pass decides BEFORE `montarAnuncio`
  runs, so both call `categoriaDoAnuncio` (`montagemAnuncio.ts`) — the stored
  link's `category_id`, else the request's — and `preparar` does too. A second
  copy of that cascade would upload against one category and build the body
  against another (a link in 200 with an entry only for the request's 100
  attaches NO TEMPLATE — the tabela's first photo when it has one, else nothing).
- **`size_chart_limit` is advice**, with ONE vetoable exception: an explicit
  `support_image_size_chart: false` withholds the photo. A matched template goes
  out even under `support_template_size_chart: false`; a mandatory category with
  nothing to send is a summary warning, never a refusal.
- **Refusals are 422s on `size_chart_info`, never retried without the key, and
  every one carries OUR sentence.** A stale template (`tabela-de-medidas-recusada`,
  "…escolha outra em /medidas") is a wire rejection at `add_item`/`update_item`,
  never falls back to the photo, and stamps an existing link's `falhaPublicacao`
  like any wire rejection. It is decided by the size-chart routes' OWN classifier
  (`classificarRecusaTabelaMedidas`, imported — the refusal table's FIRST row, a
  predicate over the error rather than a phrase), so publish and the routes call
  the same answers stale. The image validator's sentence and a failed upload of
  that photo are `tabela-de-medidas-foto-recusada` — the failed upload decided by
  the PLAN (`recusaTabelaDeMedidas`, `passos` stopping at the photo step) and
  thrown as a `ShopeePublishRejectedError` at etapa `fotos` BEFORE the link read
  and any listing write, so it stamps nothing. Its sentence and its headline
  follow ONE predicate, `fotoDaTabelaRecusadaPelaShopee`: Shopee's own
  `upload-recusado` reads "recusada pela Shopee — troque a primeira foto…";
  anything Shopee never judged (a download, a network blip, a skipped file, no
  `image_id`) reads "não foi possível enviar … — tente de novo" under the headline
  "Publicação interrompida em fotos". Both motivos are problema-only: the blocked
  vocabulary stays at 22. The C13 retry removes `tax_info` alone and keeps
  `size_chart_info`.
- **The echo is a diagnostic.** `ResultadoPublicacao.tabelaDeMedidas` carries
  the read-back's raw `size_chart_id` and whether a `size_chart` URL came back
  (never the URL; `http(s)://…` after a trim, so a `-` placeholder reads `false`)
  — the log line and the CLI print them; the route body carries the decision
  only.

The depth, the refusal table and register rows 262–269 are
`../tabelaMedidas/README.md` §6–§7.

### Photos up: the `externalIds` cache is the same one the import writes

`criarResolvedorDeImagens` reads `arquivos.externalIds` — the field step 9's
import already writes on a dedup hit and the field ML's own importer reads — and
calls `upload_image` only on a miss. **ONE resolver per publish**, carried on
the context, because the memo has to span the item pass AND every option pass
(and step 18's size-chart photo, a third pass at `cap: 1`); building a second
one pays for the same picture twice.

`image_id_list` is rendered POSITIONALLY by Shopee, so the list is never
re-ordered and never sliced by a caller. The download is guarded by an anchored
host allow-list and `redirect: 'manual'` (a fake fetch cannot show a redirect
being followed, so the test asserts the OPTION); every log line carries the HOST
and the `image_id` and never the URL. Ten `MotivoFotoPublicacao` members, none
persisted; a picture-level problem is SKIPPED and counted — except on the
tabela de medidas' photo, whose failure REFUSES the publish (Q1c; see
`size_chart_info` above) — while a rate limit, a reauth, any other Shopee error
and every Firestore error propagate and fail the publish. An empty `imageIds`
is **not** a throw here — it is the `sem-fotos` refusal one level up.

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

`ShopeePublishBlockedError` is OUR refusal: step 11's 22 motivos (54 today —
steps 19 and #1911 added theirs; `errosPublicacao.test.ts` pins the count),
raised before any Shopee WRITE for the produto, carrying `problemas` that is
**non-empty by TYPE** — the guard
`temProblemaDeBloqueio` is what turns a collected array into that argument, so
no path can construct the class with a fallback member nothing legitimately
produces. `ShopeePublishRejectedError` is SHOPEE's: an `etapa`, the provider
`shopeeCode` **verbatim (module prefix and all)** and the classifier's problemas,
which may be empty. ⚠️ ONE producer builds it with no Shopee answer to quote:
step 18's size-chart photo that did not upload (etapa `fotos`, `shopeeCode: ''`,
one `size_chart_info` problema naming the resolver's closed motivo) — Lucas's
Q1c makes that a refusal of the publish, and it lands before any listing write.
Its headline (`cabecalhoDaRecusa`, shared with the CLI) drops the empty `()` and,
when Shopee never judged the photo (`recusadaPelaShopee: false`), says
"Publicação interrompida em fotos" instead of "recusada pela Shopee".

`problemaDeErroShopee` strips ONE leading `<module>.` before lookup and never
rewrites the error's own code; the strip is a SECOND lookup, and it is
load-bearing rather than decorative — the probe measured `product.error_param`
on the live wire. An unmatched code is `{ campo: null, motivo: 'desconhecido' }`
with Shopee's prose, never a guess. A `ShopeeRateLimitError` is deliberately NOT
converted: it has its own mapping, and a 422 telling the operator to fix a
healthy listing would be a lie. Every `mensagem` is capped at 500 characters by
construction, at the builder. `error_repeated_mtsku` (#1911, P5, D15) is the
table's second row, code-only — `item_sku`, `anuncio-semelhante-existente`,
Shopee's prose (see **An uncertain first create is re-found** above).

`errosPublicacao.test.ts` carries the producer grep (ruling O7): every one of the
blocked motivos has a producer OUTSIDE the declaring file, and every one of
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

### Five writers of `item_status`, and why the overlap is safe

`item_status` / `estadoAnuncio` are written by FIVE writers, grouped the way
`shopeeLink.ts`'s own docblock enumerates them: step 9's product import, the
publisher's read-back, pause / re-list + `reverificarAnuncio` (`pausarAnuncio`,
`reverificarAnuncio`), the push handlers, and — since step 19 (#1527) — the
native-kit arms' write-back #2 (`kits/vinculosKit.ts`). `deboost` rides the same
reads for every writer but step 9's import, which never writes it. There is no ordering guard beyond "last
read wins", and that is deliberate — **all five write only what they just READ**,
so the field converges on the listing's real state instead of on whichever
request arrived last. The kit arms' reads: `get_item_base_info` of a kit they
just created, completed or republished; a linked kit a create-arm run reads GONE
(a batched status outside the live set, or no row) folds to `estadoAnuncio:
'removido'` alone, `item_status` untouched — the reverify's not-found shape; and
the recriar's read-back of the OLD kit after its `delete_item` (`SELLER_DELETE`
⇒ `removido`). ⚠️ One guard the other four do not have: kit #2 never moves a
link OUT of `removido` (a tier-1 `lastUpdateTime` precondition, R1-RT7-05), so
a slow republish read cannot revive the old kit a recriar just deleted.
`shopeeLink.ts`'s docblock names all five (it said TWO before step 11, FOUR
before step 19) so the count cannot silently rot.

What is NOT shared: `pausadoPeloErp` is the lifecycle's alone,
`ultimaPublicacao` the publisher's alone, `falhaPublicacao` the publisher's plus
the import's adoption of a draft (#1911), which only clears it to `null`, and
`violacoesLidasEm` means "when the stored violation reading last MOVED" — the
re-verify stamps it only with a CHANGED list, because stamping it on every
healthy button press makes `ignorado-sem-mudanca` unreachable and turns a
read-only diagnostic into a write.

### Two write mechanisms: `merge` for publish, `mergeIfExists` (FLAT) for lifecycle

The publish path writes through `aplicarLinkDaListagem` (merge/add), because a
first publish must CREATE the link document. ⚠️ A DRAFT's create (#1911) is the
one exception: its lock, its pre-send SKU stamp, its write-back #1 claim, its
release — and P5's `incerto` re-arm, zero-hit clear and ENSURE adoption — are
guarded `update(…, {lastUpdateTime})` writes ("Rule 7, the new writes" above
lists them; the no-link mint is a tier-0 `create()` through `rascunho.ts`) — `update()`
REPLACES a nested map such as `ultimaPublicacao` or `falhaPublicacao` whole, which
is what those complete values want. Every lifecycle path — pause,
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

`anuncioShopeeVivo(raw)` — in `@delfrance/schemas`'s `shopeeLinkLeitura.ts`
since step 21, re-exported here by `statusAnuncio.ts` — is total and
non-throwing, and reads an ABSENT `estadoAnuncio` as VIVO — the safe direction:
a link step 9 imported whose `estadoAnuncio` was never folded must not
un-badge a produto (a #1911 DRAFT — `item_id: null` — is not vivo at all).
`contaDoLinkShopee` reads `contaProdutoShopeeOuterRef` (⚠️ **not** ML's
`contaOuterRef`), with a near-miss test proving a `contaOuterRef`-shaped
document resolves to `null`.

⚠️ **Register 81 is open and is MIGRATION-WINDOW work** (root `CLAUDE.md` rule
8): whether a gen-2 Firestore trigger on this project needs Eventarc/Pub-Sub
enablement that no existing Shopee function needed. It is recorded in
`functions/DEPLOY.md`'s Cutover section, settled by the first deploy, never by
an agent.

⚠️ **A Firestore import fires no trigger.** A `prodshopee` document that arrives
in the cutover import — the legacy corpus carries them — therefore leaves its
produto's `integracoesComProduto` untouched until something WRITES that link
again. Surfaced here, not acted on and not a TODO: since the step-22 flip
(#1530) that array decides which Shopee contas the produtos table's pushes call
(`apps/web/lib/marketplace/push/run.ts`); its completeness on the imported
corpus is a migration-window question (#1910), never an agent's run.

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
A requested variation child is resolved to its anchor first
(`core/anchors.ts`), so pausing a child pauses the family's listing;
`produtosSemAnuncio` names the requested id.

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
caps row's `implementado` flipped at step 22 regardless; register 83 stays open
until a BR shop re-lists a pre-launch UNLIST.

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
- **Authoring a size chart, and detaching one.** Templates are authored in
  Seller Centre (no API), and the publish never sends a detach sentinel, so a
  `/medidas` entry that is removed leaves the live chart where it is.
  ⚠️ `size_chart` is an image id on write and a URL on read — never round-trip
  it (step 18 reads the URL's presence only).
- **Building a NATIVE kit — `../kits/`, never this folder (step 19).** The
  route and `publicar:anuncio` reach it through the dispatcher: a live
  native-kit link ⇒ `kit-atualizar` (or `--recriar` / `--converter-em-kit`), an
  `ehKitVirtualEfetivo` produto with no live link ⇒ `kit-criar`. The item
  planner here never builds a kit body; `produto-e-kit` is its defensive
  assertion (above). An ordinary ERP `ehKit` produto publishes like any other.
  The design is `../kits/README.md`.
- **`apps/web` (step 21)** — the produto tab, the `anuncioStatus` provider row
  and the registry rows. The three routes and the CLI land HERE.
- **`batch_add_item`**, and authoring `scheduled_publish_time` (it is READ, for
  the fold and for code 27).
- **`wholesale[]`** from the conta's `tabelasAtacado` — a recorded gap, and at
  Shopee mutually exclusive with per-model prices.
- **`description_type: 'extended'`, description images, `promotion_images` and
  video.** `description_type` is `'normal'` on both bodies.
- **`boost_item`**, `search_item`-based manual linking (an import IS the link),
  and `get_recommend_attribute` / `get_weight_recommendation` (not built by
  step 21; an open decision of listing authoring, #1911).
- **`delete_item` and `delete_model` have NO caller here.** Both exist in the
  package — `delete_item` for the probe's own cleanup, `delete_model` because
  `update_tier_variation` deletes by omission and a model is never deleted by
  this step. Recorded so a later reader does not read the absence as an
  oversight (registers 75 / 75's twin). Since step 19 `delete_item` has ONE
  production caller, outside this folder: the recriar's "ensure the old kit is
  gone" step (`../kits/recriarKit.ts`), sent only to an old KIT that reads live.
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

| #   | item                                                                                                                                                                                                                           | state                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 67  | which fields Shopee's BR all-or-nothing validator actually counts                                                                                                                                                              | ⏳ the SG shop accepted the block AND the block minus `cofins` — one `update_item` from a BR shop                                                                                                                                                                                                                           |
| 68  | whether `csosn` / `icms_cst` are alternatives, and whether the three unsent constants count toward the set                                                                                                                     | ⏳ same call. The one-shot retry is what makes this survivable                                                                                                                                                                                                                                                              |
| 69  | whether the SG sandbox exercises the BR `tax_info` path at all                                                                                                                                                                 | ✅ **no** — it ignores the block entirely and the read-back carries none                                                                                                                                                                                                                                                    |
| 70  | `upload_image`'s signing mode                                                                                                                                                                                                  | ✅ **Public**, accepted on a 600×600 PNG                                                                                                                                                                                                                                                                                    |
| 71  | the multipart field name (`image` vs `file`)                                                                                                                                                                                   | ✅ **`image`**, id at `response.image_info.image_id`                                                                                                                                                                                                                                                                        |
| 72  | options per tier: 20 or 50                                                                                                                                                                                                     | ✅ **50** — 21 options in one tier were accepted                                                                                                                                                                                                                                                                            |
| 73  | whether `get_item_violation_info`'s live body carries `error`                                                                                                                                                                  | ✅ **it does not** — hence the per-operation tolerance (O4)                                                                                                                                                                                                                                                                 |
| 74  | `brandshopee` is untyped (`passthrough`), has no handle and no reader                                                                                                                                                          | → 21-4 (#1911): typing it, its handle and the conta Marcas editor are listing authoring's (decision S)                                                                                                                                                                                                                      |
| 75  | `delete_model` / `delete_item` ship with no step-11 caller                                                                                                                                                                     | ⏳ nothing. Recorded so the absence is not read as an oversight                                                                                                                                                                                                                                                             |
| 76  | step 9's CLI prints `tax_info` KEYS only; this one prints keys AND values (C34)                                                                                                                                                | ⏳ a one-line docblock decision in a follow-up; step 9's file is untouched here                                                                                                                                                                                                                                             |
| 77  | `ACAO_STATUS_ANUNCIO` lives in `mercadoLivreLink.ts` and is now read by a Shopee route                                                                                                                                         | ⏳ a mechanical move later; the VALUE must not fork                                                                                                                                                                                                                                                                         |
| 78  | the promoted `trailingSegment` and `operacaoIdFromImpostoRef` are the same fold twice                                                                                                                                          | ⏳ a follow-up; collapsing them here would be a cascade change dressed as a cleanup                                                                                                                                                                                                                                         |
| 79  | `ex_tipi` is not sent, so the emitted key set is CONSTANT                                                                                                                                                                      | ⏳ the day a BR shop refuses a block without it                                                                                                                                                                                                                                                                             |
| 80  | no automated guard stops `packages/data` gaining an NF-e package dependency                                                                                                                                                    | ⏳ a PR-checklist clause; a boundary lint rule is out of scope here                                                                                                                                                                                                                                                         |
| 81  | Eventarc/Pub-Sub enablement for this codebase's first Firestore trigger                                                                                                                                                        | ⏳ **migration window** — `DEPLOY.md`'s Cutover, the first deploy, never an agent                                                                                                                                                                                                                                           |
| 82  | what `item_status` / `scheduled_publish_time` hold after a failed scheduled publish, and WHY it failed                                                                                                                         | ⏳ **nothing settles it** — push 27 carries three fields, none a reason, and there is no success push. The handler writes what it reads and the aviso says the cause is unknown                                                                                                                                             |
| 83  | whether `unlist_item {unlist: false}` really re-lists                                                                                                                                                                          | ⏳ **half open** — it re-listed a SELLER-created UNLIST. The Shopee pre-launch case is unmeasurable on that shop and the `update_item` door exists for it                                                                                                                                                                   |
| 84  | whether `attribute_list` / `image_id_list` replace wholesale on `update_item`                                                                                                                                                  | ⏳ the full lists are always sent, which is correct under either reading                                                                                                                                                                                                                                                    |
| 85  | whether an `image_id` expires or is reusable across items/shops, and whether `image_id_list[i]` ↔ `image_url_list[i]` is positional                                                                                            | ⏳ the per-integração `externalIds` scoping is the conservatism                                                                                                                                                                                                                                                             |
| 86  | whether a purged `image_id` is reported with a parseable per-id message                                                                                                                                                        | ⏳ recorded as a gap; no self-heal is built                                                                                                                                                                                                                                                                                 |
| 87  | whether a Storage-emulator host can ever appear in `arquivo.url`                                                                                                                                                               | ⏳ the allow-list's emulator entry is INERT today — a seeded emulator corpus                                                                                                                                                                                                                                                |
| 88  | whether a PUSH envelope may enter `fixtures/__wire__/` (which holds RESPONSE bodies)                                                                                                                                           | ✅ sidestepped — the push-16 body stays inline in its test, and no new fixture was committed                                                                                                                                                                                                                                |
| 89  | whether the conta's `operacaoOuterRef` is the right operação for a publish `tax_info`                                                                                                                                          | ✅ **yes** — the nota for an order from this listing resolves through that same operação                                                                                                                                                                                                                                    |
| 262 | `size_chart_info.size_chart_id` is accepted as a JSON NUMBER on add / update (announcement 1404 types it string)                                                                                                               | ⏳ the first BR publish with a matched template — the CLI's `lido de volta` line (step 18's register, home `../tabelaMedidas/README.md` §7)                                                                                                                                                                                 |
| 263 | `update_item` WITHOUT `size_chart_info` keeps a Seller-Centre chart                                                                                                                                                            | ⏳ sandbox / BR — the reason nothing here ever sends a detach                                                                                                                                                                                                                                                               |
| 264 | add / update answer a stale template id with the detail page's sentence; how a template of ANOTHER category is refused                                                                                                         | ⏳ BR — an unmatched sentence still surfaces as `desconhecido` with Shopee's prose                                                                                                                                                                                                                                          |
| 265 | `get_item_base_info.size_chart_id` echoes the sent id; its value with no template (`0` / absent / `null`)                                                                                                                      | ⏳ sandbox — `lidaDeVolta` reads it raw                                                                                                                                                                                                                                                                                     |
| 267 | `size_chart` accepts an `upload_image` id from the default scene                                                                                                                                                               | ⏳ BR shop: one photo-only publish                                                                                                                                                                                                                                                                                          |
| 268 | the image validator's exact sentence, per photo or per call                                                                                                                                                                    | ⏳ BR shop: one refused photo                                                                                                                                                                                                                                                                                               |
| 269 | whether `support_image_size_chart: false` is ever answered for a BR apparel leaf, and honoured                                                                                                                                 | ⏳ BR shop: `get_item_limit` + one publish — the explicit-`false` withhold is the vetoable ruling                                                                                                                                                                                                                           |
| 307 | a freshly created item appears in `get_item_list` (`update_time_from` inside the window) before the 240 s wait ends (#1911 P5)                                                                                                 | ⏳ BR shop: one create, then the scan at +240 s. A longer index lag is a RESIDUAL (the scan misses it and re-sends) — `AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS` grows                                                                                                                                                            |
| 308 | `create_time` is populated on a just-created item's `get_item_base_info` (#1911 P5)                                                                                                                                            | ⏳ BR shop: same call. Non-gating — a `null` reads `desconhecido` and ENSURE refuses `criacao-incerta-ambigua` (fails closed)                                                                                                                                                                                               |
| 309 | a CUSTOM tier (`variation_id: 0`, the D12 fallback) is accepted in a BR standardised (Fashion) leaf (#1911 P7, Q3)                                                                                                             | ⏳ BR shop: the first varied publish on a Fashion leaf with no binding entry. A refusal is a Shopee rejection; the fix is a STANDARD binding on `/variacoes`                                                                                                                                                                |
| 310 | `get_item_list` honours `update_time_from` with NO `update_time_to` (filters — neither refused nor ignored), and the widest window it takes (#1911 P5)                                                                         | ⏳ BR shop: the 307 probe, plus one from-only call compared with an unwindowed walk. Refused ⇒ ENSURE throws on every re-run (lock released, record kept); ignored ⇒ a shop past 2 000 live listings answers `busca-de-anuncio-incompleta` every time. Both fail closed. Overlaps register 58 (inclusivity, maximum window) |
| 311 | where Shopee's `get_item_list` offset cap ("get items offset over limit", `error_param`) sits for an UN-narrowed walk, against the 100-page / 10 000-row ceiling the kit scan and the first create's look-up share (#1911 P5b) | ⏳ BR shop: one un-narrowed walk to the end. A cap below 10 000 ⇒ every first create (and every kit create) on a shop past it throws that `error_param` — nothing sent, the lock released (fail closed); the fix would be a narrowed walk, the mass import's documented mitigation                                          |
| 312 | `get_item_base_info` returns every item `get_item_list` lists under `STATUS_BUSCA_KIT` (incl. `BANNED`, `REVIEWING`) (#1911 P6)                                                                                                | ⏳ BR shop: one page plus its base-info batch, compare the id sets. A systematic omission ⇒ every first create (and every kit create) on that conta refuses `busca-de-anuncio-existente-incompleta` / `busca-de-kit-incompleta` — fail closed; the fix would be to narrow the statuses                                      |
| 313 | a full first-create same-SKU walk (⌈n/100⌉ `get_item_list` + ⌈n/50⌉ `get_item_base_info`) of the largest conta (2 000–10 000 listings, Lucas) fits the route's 180 s less the 30 s margin (#1911 P6)                           | ⏳ BR shop: time one dry walk. Too slow ⇒ every route first create there answers 409 `PUBLICACAO_EXPIRADA` — nothing sent, the lock released — and the CLI (the lock's 300 s) is the path; #2064 narrows the walk                                                                                                           |

Also unmeasured, and not a register line: nothing in this folder has met a BR
shop. The `esperar` of 5 000 ms, the re-list door order, the daily-quota reset
instant and the four `failed_reason` families are doc-and-probe facts, and the
first real listing is the first time any of them is observed in production.
