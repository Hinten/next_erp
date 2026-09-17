# `lib/shopee/produtos/` — the product import (step 9, #1517)

The design notes for the step that turns a Shopee anúncio into an ERP produto.
`apps/shopee/CLAUDE.md` keeps only the rules a reader must not break and points
here for the reasoning; this file is where the detail lives, in the root
`CLAUDE.md`'s sense of "detail lives where it is cheaper". The reconciled design
and the wave reports that produced this folder are in the step-9 review
directory named by the PR that closed #1517.

## The twenty-one modules, in five families

The families are the seam, not a filing convention.

- **The seam** — `itemLido.ts` (the `ItemLido` record and every `Deps` type, the
  one-read-then-hand-down rule), `eixos.ts` (the ONE package-dimension axis
  map, asserted as a bijection), `produtoIds.ts` (the deterministic
  conta-scoped ids) and `errosImportacao.ts` (`ShopeeImportBlockedError` + the
  persisted `MOTIVO_IMPORT_BLOQUEADO` vocabulary, which is also `respond.ts`'s
  422 arm, and the mass-import scheduler's closed-valve error).
- **The pure half** — `mapeamento.ts` (listing → produto fields, the ML fill
  rule and carve-out verbatim), `taxonomiaShopeeCore.ts` (tiers, options, the
  `tipoDeVariacao` fold and the `linksVariacoesShopee` merge, all as data) and
  `planoImportacao.ts` (the ORDERED write plan). No clock, no Firestore, no wire
  call — which is what lets the CLI's dry run print exactly what a live run
  would write.
- **The IO half** — `resolveProduto.ts` (the import-direction cascade),
  `links.ts` (resolve-then-write, never delete), `taxonomiaShopee.ts` (the
  guarded grupo write and the per-dispatch memo), `categoriaShopee.ts` (the
  `shopee-<id>` chain off step 10's cached tree and the category-tree memo),
  `fotosShopee.ts` (the retriable picture unit), `estoquePrecos.ts` (the guarded
  price patch and the stock row), `variacoesShopee.ts` (the children and
  `filhoUnicoId`) and `importarAnuncio.ts` — the orchestrator, `preparar`
  (write-free) → `planejar` (pure) → `aplicar`.
- **The kit arm** — `kitShopee.ts`: `get_kit_item_info` read as a listing, every
  component resolved first, an ERP kit produto or a refusal.
- **The job and its surfaces** — `importacaoMassa.ts` (the resumable
  `importacoesShopee` job: `iniciar` / `processar` / `finalizar` / `cancelar`,
  the scan, the two queues, the dispositions) and `shopeeMassImportTasks.ts`
  (the SECOND Cloud Tasks scheduler in this app, onto `processShopeeMassImport`);
  `corpoImportacao.ts` (the app's first POST bodies), `lerAnuncio.ts` (the
  single-id read that ends on the same `montarItemLido` the job calls) and
  `importarAnuncioCli.ts` + the `scripts/importar-anuncio.ts` it backs.

## The design, clause by clause

The step is the first WRITER of the two link collections `prodshopee` /
`variashopee` — step 5 built them as readers, which is why every Shopee order
line on staging still resolves to no produto. Three callers, one code path: the
`importar` route (one item), the `importar-anuncio.ts` CLI (one item, dry-run by
default) and the resumable `importar-todos` job (the whole catálogo).

**One read, then hand it DOWN.** The importer never issues an item call. It
takes an `ItemLido { base, models | null, taxInfo | null, kit | null, itemId }`
assembled ONCE — by the job in a BATCH (`get_item_base_info` for up to ten ids
per dispatch, reconciled **by `item_id`**, never by position), or by
`lerAnuncio.ts` for a single id, both ending on the same `montarItemLido`. A
`tag.kit` listing asks for `get_kit_item_info` and **never** `get_model_list` —
though the single-item read pays for one `get_item_base_info` first, because
`tag.kit` is read off that row; only the job's `filaKits` drain skips it.
Otherwise `has_model === true` asks for `get_model_list`. What `get_model_list`
answers for a kit is UNVERIFIED, so nobody spends the call to find out.

**`preparar` → `planejar` → `aplicar`, and the split is structural.**
`prepararImportacaoShopee` is write-free — no bucket, no fetch, no writer
anywhere in its call graph, proved by a FakeDb that throws on every write verb,
not by a comment. `planejarImportacaoShopee` is pure, so the CLI's dry run
prints exactly what a live run would write. `aplicarImportacaoShopee` executes
that plan in ONE order: **taxonomia → categorias → the guarded price patch →
produto → extraData → estoque → the parent link → each child → `filhoUnicoId` →
photos.** Two placements are load-bearing rather than tidy. _Taxonomia first_,
because a lost grupo race refuses the whole ITEM and must do so before any
produto exists — proceeding with a partial taxonomy leaves children whose
combinations mismatch next time, and the combination rung then mints DUPLICATE
children, a permanent duplicate bought for a transient conflict. _The price
patch before the produto merge_, because the merge always writes (it carries
`ultimaModificacao`) and so bumps `updateTime`: merging first would make the
price precondition assert a stamp we had just invalidated ourselves, failing
every price-writing import.

**Links resolve, then write, and NEVER delete.** The parent cascade is
`prodshopee (item_id, conta)` → `produtos (sku == item_sku, paiId == null)` →
create at the deterministic id; the child cascade is
`variashopee (model_id, conta)` → `produtos (sku == model_sku, paiId == parent)`
→ the combination match → create. Every rung reads `limit(2)`, because the
second document is the whole signal: duplicate links are resolved by
lexically-first doc id with one log line, and nothing is ever deleted — a link
we did not write may be the only binding a legacy row has. Two inconsistencies
refuse the item BEFORE any write: a `prodshopee` found under a CHILD, and a
`variashopee` pointing at another family. `model_id: 0` still creates the child
and just skips the link (counted in `semLink`); a listing with no models writes
no `variashopee` at all.

**The grupo write is ADR 0011 tier 1.** `update(patch, { lastUpdateTime })`
naming only `variacoes` / `variacoesIds` / `linksVariacoesShopee` /
`ultimaModificacao`, `create()` for a new grupo. A lost precondition is answered
by re-reading and **RE-PLANNING the whole item exactly once**, against a FRESH
memo — never by re-applying the same patch, which would write the loser's values
over the winner's, the precise thing the precondition exists to stop. A second
loss is `taxonomia-em-conflito`, contained per item, with no PRODUTO written
because taxonomia is first — a grupo this item already created or patched DOES
survive the refusal, which is why the next pass re-plans against a fresh read
rather than assuming a clean slate, and why the CLI prints a different last line
for that one motivo. ⚠️ **The memo absorbs its own writes**: one
`MemoDeGrupos` per dispatch, a single full read of `grupoDeVariacoes` loaded
lazily on the first `has_model` item and updated in place by every grupo this
dispatch creates or patches — so ten items of the same shape do one read, not
ten, and the second item sees the grupo the first one minted instead of
creating a twin or spending its single re-plan against its own sibling.

**Estoque and preços.** Prices are the first BRL `price_info` entry —
`original_price ?? current_price` onto the conta's **normal** table only (a
non-positive `original_price` falls to `current_price`, because Shopee
zero-fills the field). The promotional table is never written: Mercado Livre's
#803 settled that it belongs to promotions the operator authors in the ERP, and
step 9 takes the same stance, so `tabelaPromocionalOuterRef` rides the deps as a
documented no-op. A no-model listing carries the parent's `precos`; a has-model
listing puts nothing on the parent and gives each child its own. Estoque is Σ
`seller_stock[].stock` (never `shopee_stock`) plus `reservaEfetiva`, and it is
**never written on a parent that has children** — gated on the payload's
`has_model` OR the ERP's own `paiJaTemFilho`, because a parent row and child
rows would double-count the same units. A missing `depositoOuterRef` skips the
leg with one log line.

**Photos are last, and retriable.** After the produto and link writes, paired
`image_url_list[i]` ↔ `image_id_list[i]`, skipping ids already cached on this
integração's arquivos; an SSRF host allow-list (`shopee.<tld>` with at most one
extra label, `susercontent.com`, https only — `shopee.com.evil.co` is refused),
non-`image/*` rejected, `sha512(bytes)` as the content address. A picture-level
failure skips and counts; infra propagates. The log carries the host and the
`image_id` and never the URL.

**Two memos a caller must pass, and they fail differently.** `deps.grupos`
absent ⇒ the taxonomy module builds its own (correct, just one read per item
instead of per dispatch). `deps.categorias` absent ⇒ **the categoria leg is
SKIPPED entirely**, with one `console.warn` — no failure, no partial chain. That
asymmetry is deliberate: a category tree is step 10's cached read and an import
must not block on it, but a silently unlinked categoria must still say so once.
The job, the route and the CLI all pass both.

**Deterministic produto ids, scoped to the CONTA.** Parent =
`sha256("shopee|<integracaoId>|<item_id>")`, child =
`sha256("<parentProdutoId>|<model_id>")`. Conta-scoped, not shop-scoped, because
every other Shopee identity here already is — the pedido id digest, both link
documents' `conta*OuterRef`, and the `arquivos.externalIds[].integracaoPath`. A
second integração over the same shop therefore forks consistently instead of
converging one thing while everything around it stays forked. The legacy Flutter
id was `sha256(now µs + 20 random chars)`, non-deterministic, so there is no
preimage to inherit and no reason to try.

**Kits (K1).** A `tag.kit` listing reaches `kitShopee.ts` and never
`importarAnuncioShopee`, which refuses it outright rather than minting a simple
produto for something that is not one. The kit page is a DIFFERENT page —
`attributes` / `brand_info` / `pre_order_info` / `tier_variation_list`, a
`category_id` that is an array in the docs and a scalar in the sample — so
`anuncioDerivadoDoKit` translates it ONCE into a listing-shaped record through
the package's own row schema, and everything downstream is the same code an
ordinary import runs. The parent produto is `ehKit: true`, one child per kit
model with its own `componentesKit` keyed by component produto id (duplicates
SUMMED), and **no estoque row** — a kit's stock is its components'. The kit
page carries no currency, so its price is assumed BRL unless a `price_info`
entry declares otherwise (kits exist only for BR sellers, `announcement 1310`).
⚠️ **Chicken and egg, and the refusal is the answer.** Every component is
resolved first, and if ANY of them is not yet linked to an ERP produto the whole
kit is refused with `kit-componente-nao-vinculado` **before a single write** —
so a kit imported into a fresh catálogo fails, and the same command succeeds
once its components have been imported. Run it twice; that is the design, not a
retry loop. Kits are drained LAST by the job (`filaKits`), which is what makes
"twice" usually unnecessary in a full catalogue walk. Creating a kit ON Shopee
is step 19's, and the free availability probe for it is the shipped
`taxonomia/limites/kit` route.

**The job's dispositions, in one paragraph.** A `running` job scans one page
when both queues are empty, drains up to ten items per dispatch (forty with
`importarFotos: false`) and checkpoints after EVERY item. A **burst** rate limit
stops the drain, checkpoints and re-enqueues with
`scheduleDelaySeconds = retryAfterSeconds ?? 60` — it is never a per-item
failure row and never an attempt. The **daily** quota, and the first-attempt
classes (reauth, missing credential, a conta not configured or of the wrong
tipo, no shop id, an invalid credential, `ShopeeConfigError`, the Tasks valve
closed), stamp the job `failed` immediately — retrying them buys nothing and the
ladder would only delay the truth. Transient API / network / HTTP / Firestore /
`TypeError` are thrown into the 3-attempt ladder, and the final attempt stamps
`failed`. An item-level block, API error or schema error is CONTAINED as one
`failures[]` row. ⚠️ **The cursor is the SERVER's** (register item 66): the scan
reads `next_offset` only while `has_next_page`, treats a non-advancing offset as
exhausted, and treats `has_next_page: true` with NO usable `next_offset` as a
TERMINAL failure — never as silent exhaustion. The sandbox probe measured
`next_offset` ABSENT on a page that still had room, so its presence is not
guaranteed and its absence must not be read as "done".

**`finalizarImportacaoShopee` is the ONE transaction under `produtos/`**, class
B, and the transaction inventory carries the whole race analysis: `status` has
two uncoordinated writers (the dispatch stamping a terminal state and the
`cancelar` route stamping `cancelled` mid-drain), so both `status` and
`integracaoId` are re-derived from the `tx.get` snapshot and a concurrent winner
turns the call into a `not-running` no-op instead of a clobber. Every per-item
checkpoint is deliberately OUTSIDE it — they write no `status`, so they cannot
bury a terminal state.

**No ruleset regeneration.** Step 9 touches no `*Meta` permission or path, no
`PERM` and no validator whitelist: `importacaoShopee.ts` and
`shopeeLinkVariacoes.ts` are bare consts rather than `DomainSchema`s, and the
widened `item_status` enum is a field's value set, not a rule input. So
`gen:rules` / `gen:rules:e2e` are **not** run and the two snapshots do not move.

**Out of scope, on purpose**, so nobody reads a gap as a bug: publishing,
updating or pausing a listing (step 11), pushing stock (12) or price (13), size
charts (18 — `size_chart` is a URL, read and ignored), creating a kit ON Shopee
(19), and `integracoesComProduto` / any Shopee link trigger, which is why
`/produtos` shows no Shopee badge yet. Per-option and description images are a
recorded gap at Mercado Livre parity.
