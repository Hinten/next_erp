# `lib/shopee/precos/` — the price sync (step 13, #1521)

The design notes for the step that makes this app the first **SENDER of a
price** to Shopee. `apps/shopee/CLAUDE.md` keeps only the rules a reader must
not break and points here for the reasoning; this file is where the detail
lives, in the root `CLAUDE.md`'s sense of "detail lives where it is cheaper".
The reconciled design, the sandbox probe of 2026-09-24 and the wave reports that
produced this folder are in the step-13 review directory named by the PR that
closes #1521.

Step 13 ships in two stacked PRs. The first — fourteen of this folder's
modules, the manual push and the CLI — is what sections 1–12 below describe.
The second adds the account-wide job (`atualizarPrecos.ts`, its scheduler and
queue, its routes; the folder's sixteen modules in all) and sections 13–17: the
job, push 22, the folder discipline, what is out of scope on purpose, and what
is UNVERIFIED.

Everything here was **offline-verified**, and the wire was measured ONCE, by
the probe of 2026-09-24: the SHIPPED `updatePrice` plus raw signed calls
against the **SG sandbox** shop, on two throwaway unlisted items that were
deleted afterwards. No module in this folder has run against a BR shop, in
reais or on production, and no staging rehearsal of the manual push or of the
job has run yet. Every "measured" below means that probe, on an SGD shop; a
fact that only a BR shop can settle says so where it appears.

## 1. The sixteen modules, in six families

The families are the seam, not a filing convention.

- **Constants and vocabulary** — `constantesPreco.ts` (the three
  probe-settled wire decisions, the ERP-side bounds, the job's queue name and
  ceilings, and four lazy `envInt` knobs — the manual push's two and the job's
  two; the folder's ONE `process.env` reader family, and NOT path-bound to the
  deploy preflight, because no price queue rate is env-driven) and
  `errosPreco.ts` (the 46-member `MotivoPrecoShopee` union with its TOTAL pt-BR
  table rendered at READ time, `MOTIVOS_QUE_CARIMBAM`, the manual push's
  `ShopeeEnvioPrecoGuardError` with its three codes, and the job's two start
  refusals — `ShopeeEnvioPrecoEmAndamentoError`, 409, and
  `ShopeePriceSyncTasksDisabledError`, 503).
- **The conta and the code table** — `regiaoPreco.ts` (the conta verdict:
  six rungs from a missing `shop_id` to the region, and the one sandbox
  override) and `classificarPreco.ts` (Shopee's answer → skip, refuse, end the
  run, or retry). Neither writes anything.
- **The reads** — `descobertaPreco.ts` (CLASSIC queries on purpose, and ONE
  private join per anchor behind two family readers:
  `lerFamiliasDePrecoPorIds`, the manual push's read by anchor ids — one batch
  key read plus one join per anchor — and `lerPaginaDeFamiliasDePreco`, the
  job's PAGED walk over every anchor of the conta — one keyset query per page,
  `paiId == null` and `integracoesComProduto array-contains` the conta, ordered
  by document id, projected to `precos`, resumed from a cursor that is an id
  VALUE, never a snapshot, so an anchor that left the conta between two
  dispatches does not break the walk; plus `lerPrecosDosProdutos`, the
  SEND-time `precos` read of named produtos that both surfaces price from),
  `leitorDeBase.ts` (the BATCHED `get_item_base_info`, one lazy call per chunk
  of up to 50 ids, reconciled by `item_id`) and `leituraPreco.ts` (the fresh
  read of one listing — `get_model_list` only when `has_model === true` — and
  its pure projection).
- **The pure half** — `planoPreco.ts` (WHICH listings and models are addressed,
  and separately WHERE each price comes from — `produtosQuePrecificam`, the ONE
  rule for which produtos price a listing, is shared by the manual push and the
  job since the second PR), `decisaoPreco.ts` (gates G2–G8:
  send, skip or refuse, plus the exact `price_list`) and `verificacaoPreco.ts`
  (does the accepted write show the price we sent, and `modeloDoEco`, the ONE
  matcher from an echo row back to a model). No clock, no network, no
  Firestore in any of the three.
- **The sender, its write-backs and the surfaces** — `enviarPreco.ts` (the IO
  ladder around the decision: at most ONE `update_price` per listing),
  `linkPreco.ts` (the four write-backs and the ONE clearer),
  `enviarPrecoManual.ts` (the in-process manual run and its envelope) and
  `enviarPrecoCli.ts` (the pure half of the `enviar:precos` rehearsal). Their
  I/O halves live outside this folder:
  `app/api/marketplace/shopee/enviar-precos/route.ts` and
  `scripts/enviar-precos.ts`.
- **The job (second PR)** — `atualizarPrecos.ts` (the account-wide job: the
  start with its one-active guard, one dispatch that plans a page or drains a
  slice, the per-item batch checkpoint, the pause and the park, the cancel, and
  the folder's ONE transaction, the class-B finalize) and
  `shopeePriceSyncTasks.ts` (the scheduler: the region-qualified
  `processShopeePriceSync` queue path, and the `SHOPEE_TASKS_DISABLED` valve
  decided at construction). Their I/O halves live outside this folder too:
  `functions/src/processPriceSync.ts` (the codebase's FOURTH
  `onTaskDispatched`, and the dispatch's one clock read) and the five routes
  under `app/api/marketplace/shopee/atualizar-precos/` — the start, `cancelar`,
  `status`, `historico` and `relatorio` (§13).

Four helpers were **promoted** out of other folders rather than copied, each
with its source module's tests byte-unedited as the proof nothing moved:
`core/pool.ts` (`executarEmPool`), `core/vinculosShopee.ts` (`idDoRef`,
`varLinksDoAnuncio`, `modelosUtilizaveis` — the three folds that say which
models belong to which listing), `produtos/mapeamento.ts`'s
`precoDePrateleiraDe` (§4) and `estoque/contaEstoque.ts`'s
`lerInfoDaLojaShopee` (§5). Two more live in `@delfrance/schemas` so a second
channel can bind them: `precoDaTabela` and `mesmoPrecoEmReais` (§3).

**The manual push, end to end.** `POST /api/marketplace/shopee/enviar-precos`
(`PERM.integracao.write`) takes `{ integracaoId, produtoIds, baixarPreco? }`
and validates in a fixed order: the body, the ids, the DEDUPED count (over 50
is a 400 carrying `limite` and `solicitados`, never a truncation), then
`baixarPreco` as a real boolean or absent. Then ONE clock read, the context
(404), a blank normal tabela (400 `SHOPEE_CONTA_SEM_TABELA_NORMAL`), the stock
sync's quota pause (409 `SHOPEE_CONTA_PAUSADA` with `pausadoAte`, before any
Shopee call) and the conta verdict (422 `SHOPEE_PRECO_CONTA_RECUSADA`, whose
only call is the cached `get_shop_info`). Only then the run: every child id
resolves to its anchor (deduplicated after resolution), the plan fixes
IDENTITIES only, ONE batched base reader serves every first attempt, a pool at
`concorrenciaEnvioPrecoManual()` prices and sends, and the deadline is measured
on ELAPSED time. The answer is **200 whenever the run ran**, even when every
row failed: a per-listing refusal is data. A pause or a conta-wide `fatal`
mid-run ends the rest as `nao-tentado` rows and still answers 200, so the rows
that already landed are reported rather than lost to a 500.
The envelope says `canal: 'shopee'`; its rows are per MODEL, carry Shopee's
`codigo` verbatim, and their `mensagem` is always `mensagemDoMotivoDePreco`'s
sentence.

⚠️ **The price is read at SEND time, never at plan time** (reconcile C-d — the
job's drain-time rule, applied to this surface). Inside each item's pool task,
immediately before the sender, ONE masked key read (`lerPrecosDosProdutos`)
fetches the `precos` of exactly the produtos that price the item — the anchor
of a no-model listing, each model's own child otherwise — and the pure
`precificarItem` prices it. An item late in the pool is sent up to the deadline
after the request started, and pricing every item up front made a tabela edited
inside that window (a second operator, another tab, the job) a lost update ON
THE WIRE: the older value overwrote the newer one at Shopee. A produto deleted
after the plan is absent from that read and answers `preco-nao-encontrado`,
never a throw. Every ladder attempt re-reads the prices, and a retry reads its
listing through a FRESH one-id base reader instead of the request's memo, so an
attempt that landed its `update_price` and then threw (a write-back blip)
replays as `preco-igual` (S4) rather than sending again. ⚠️ The CLI's dry run
(`ensaiarEnvioDePreco`) still prices at PLAN time from the family, so a
rehearsal and a live run agree only while nobody edits the tabela in between.

⚠️ **ACCEPTED, not fixed — the no-model comparand's window** (reconcile C-c,
register 148). The TARGET is fresh; the CURRENT price a no-model listing is
compared with is its row of the batched base read, which the chunk's first
item fetches for the whole chunk, so it is up to one request old when a later
item is decided. A Seller-Centre edit landing inside that window is judged
against the older shelf price: the equality check can re-send a value Shopee
already holds, and the decrease guard can let a send LOWER a price the seller
has just raised there, with the guard ON. A has-model listing reads its model
list per item and has no such window.

## 2. The whole item is the unit; the body is the diff

`update_price` takes one `item_id` and a `price_list` of that item's models, so
the fan-out is per LISTING and the attribution is per MODEL — step 12's shape.
But the listing is also the unit of **reading, deciding and the ratio**: the
sender reads the listing once, decides every model of it together, and checks
the max/min ratio between variations over the whole of it before anything
leaves.

⚠️ **The body carries only the models whose price changes** — and that is
safe only because of probe **P8**: a partial `price_list` on a two-model item
left the UNSENT sibling's price intact, and the echo equalled the request. It
was the first PR's pre-merge blocker (`PRICE_LIST_SO_A_DIFERENCA`, now `true`);
had Shopee reset an omitted sibling, the diff would have wiped every unchanged
model on the first send. The flip is that one constant and one branch in
`decisaoPreco.ts`, and flipped, an unchanged model rides at its CURRENT price,
never at its target.

⚠️ **The diff narrows what is WRITTEN, never what is JUDGED.** Probe **P11b**
sent one model at 5.5× its sibling's current price and Shopee refused it with
the generic `error_update_price_fail`, applying nothing: the ratio is judged
against the siblings we do NOT send, at their current prices. So the pre-wire
ratio check reads every model of the fresh read — linked or not, available or
not — with the sent ones at their target and every other one at its current
price (§8 says why it is the only place the operator learns the reason).

Two plan-time consequences of the listing being the unit:

- **More models than one call takes** (`SHOPEE_UPDATE_PRICE_MAX_MODELS`, the
  package's 50) is refused at plan time as `modelos-excedem-limite`, one row
  per refused model. Unlike step 12's stock chunker the price plan never
  splits a listing: the item is the unit of the ratio (above), and since a
  listing cannot legally hold more than 50 models, only drifted link data
  reaches this rung.
- **A child carrying more than one usable model of one listing** is refused as
  `forma-de-modelo-divergente` (remedy: re-import). The shared report row is
  keyed by the CHILD produto, so two models under one child would share a key
  and the second would overwrite the first. Neither the import nor the publish
  produces that shape.

⚠️ `modelId: 0` IS the no-model listing (`SHOPEE_PRECO_MODEL_ID_SEM_MODELO`;
probes **P4/P6** accepted both `0` and an omitted key). Never a truthiness test
on a model id anywhere between the plan and the wire.

## 3. The ONE tabela reader, and the ONE equality fold

`precoDaTabela(precos, tabelaId)` in
`packages/schemas/src/produto/pureLogic/precoCalculo.ts` is the one reader of
"the price of this produto in that tabela" for every channel that SENDS it. It
has three binders:

- **Mercado Livre's price plan**, whose private copy was DELETED rather than
  aliased (an alias is a second name). ⚠️ That is a behaviour change for ML on
  a sub-centavo stored price (register 137): see the next paragraph.
- **Step 11's publish** (commit `3256b213`), which now reads every price through
  it — rounded to the centavo — and refuses a zero variation price instead of
  sending it (register 138).
- **This folder**, through `precificarItem`, reading the conta's
  `tabelaNormal` for the anchor and each model child.

⚠️ **Rounding BEFORE positivity.** The value is `roundReais`'d first and only a
result above zero is a price: a stored `0.004` rounds to `0` and reads as "no
price" (`preco-nao-encontrado`), never as a zero price that every downstream
reader would treat as real and that Shopee's own validator refuses. `0.005`
rounds to `0.01` and is a price. An inherited key never counts, so a tabela id
of `__proto__` reads `null`.

**Open item (D-9, a question for Lucas):** step 11's tier mapper refuses a child
with a zero, negative or sub-centavo price as `filho-sem-preco`, and since the
promotion that refusal also blocks an UPDATE of a listing whose already-live
model would receive no price on that path at all. Whether an update should be
refused for a price it does not send is the open question.

`mesmoPrecoEmReais(atual, alvo)` is THE skip-if-equal fold, and it joined the
fold inventory with this step. Two prices are EQUAL when they land on the same
centavo (`10.004 ≡ 10`; float residue is not an edit), DISTINCT one centavo
apart (`49.99 ≠ 50`, and `49.991 ≠ 50` — a `< 0.01` tolerance would equate
those two), and a `null` current price never equals anything, so an unreadable
listing is never "already correct". A `true` SKIPS a send, so a fold that
equates too much drops a real price edit silently.

## 4. The comparand is step 9's shelf reader

The price a push compares against — the "current" price the decision reads — is
`precoDePrateleiraDe(entrada)` from `produtos/mapeamento.ts`: `original_price`
when it is finite and above zero, else `current_price` when that is, else
`null`. It is the SAME function step 9's import uses (`precoBrlDe` calls it and
then applies its own BRL pick and minimum), extracted rather than
re-implemented, so the import and the push can never disagree about which
field is the shelf price. `leituraPreco.ts` never spells either wire field; the
folder's discipline grep forbids one of them outright.

**Why `current_price` is read only when `original_price` is zero-filled.**
During a promotion `original_price` stays positive while `current_price` is the
promotional price, so the fallback can never reach a promotion price — the
legacy's comparand was the promotional one, and it is deliberately not
transcribed. faq 140 adds the sharper reason: an UPCOMING promotion already
locks the price while `current == original`, so a comparand that tracked the
promotional value would compare against a number the listing is not yet
showing. The fallback exists for Shopee's zero-fill house style; probe **P2**
measured NO zero-fill on a fresh listing, so on the sandbox it is dormant, not
wrong.

The projection reads the FIRST `price_info` entry only, carries its `currency`
VERBATIM (the decision judges it, §5), and rounds the shelf price with
`roundReais`: a result that is not above zero is `null`. A `null` comparand is
what the decrease guard reads as `preco-atual-ilegivel` (§12). On the manual
push a no-model listing's comparand is its row of the request's batched base
read, up to one request old — an ACCEPTED window (§1, register 148).

⚠️ **`has_promotion` is never read.** Probe **P2** measured it `true` on a
fresh listing with no promotion at all; it is not evidence of anything (§6).

## 5. The region gate, and its one override

`avaliarContaParaPreco` runs ONCE per conta before any item, and its rungs are
the cost model:

| #   | rung                                                | motivo                     | cost           |
| --- | --------------------------------------------------- | -------------------------- | -------------- |
| 1   | no `shop_id`                                        | `sem-shop-id`              | zero           |
| 2   | no normal tabela                                    | `sem-tabela-normal`        | zero           |
| 3   | the client + `get_shop_info` (the SHARED cache)     | `conta-nao-configurada`    | one cached GET |
| 4   | shop `status !== NORMAL`                            | `loja-banida-ou-congelada` | the same read  |
| 5   | `is_cb === true`                                    | `loja-cross-border`        | the same read  |
| 6   | not `BR`, and not a rowed region under the override | `regiao-nao-suportada`     | the same read  |

The shop read is `lerInfoDaLojaShopee`, the ONE shop-info cache step 12's stock
gate already fills: one conta in one cache window costs one `get_shop_info`
whichever sync asked first (register 140 — its metric name still says
`stock`). The four conta classes (a missing conta, main-account consent, no
stored token pair, an unparseable pair) are a VERDICT, never a throw; the last
two fire lazily at that first shop-signed call.

⚠️ **Cross-border is refused before the region, on a BR shop too** (register
135, unverified live): a CB listing's `original_price` is in the seller's own
currency, so a figure in reais would be read as another currency, and no
region row can say which.

**Only reais.** `MOEDA_E_MULTIPLO_POR_REGIAO` has two rows — `BR` → `BRL`, 4×
and `SG` → `SGD`, 5× (keys upper case, the spelling probe **P0** read). A BR
shop takes the ERP's tabela as BRL; any other region would take the same NUMBER
in its own currency, a wrong price Shopee accepts with a 200.

**The one override, and why it keys on the host.** The only sandbox shop is
Singaporean, and a price sync that cannot be rehearsed end to end before
production is one first exercised on real listings. So a non-BR region WITH a
row is accepted only when BOTH hold:

- the config's `sandbox` flag, AND
- the RESOLVED `hosts.apiHost` equals `SHOPEE_SANDBOX_API_HOST`.

The flag alone is not a production guard: host precedence is override > flag >
default, so the flag ON beside an explicit API host pointing at production
talks to REAL shops with the flag still on. Keyed on the resolved host, a
process that can reach a production shop cannot have the override on. An
unknown region (`MY`, say) refuses even with the override: a multiple or a
currency is never guessed. The config arrives as a parameter (default
`shopeeConfig()`), so this folder never reads the sandbox variable itself.
This is `apps/shopee/CLAUDE.md` rule 6's ONE named exception (register 150).

⚠️ **What the SG rehearsal is evidence about.** The API: the op, the envelope,
the attribution, the ratio's input set, SG's 5× (measured: 4.5× accepted, 5.5×
refused). NEVER about BR: BRL, BR's 4×, BR's `price_limit` bands and every
promotion lock are unmeasured.

A refusal answers the manual push **422 `SHOPEE_PRECO_CONTA_RECUSADA`** with
`{ motivo, mensagem, regiao? }` — one code for "the ERP will not price this
shop", and a 422 rather than a 400 because no change to the request body can
help. The verdict's own `sem-tabela-normal` answers the route's 400 instead.

## 6. Promotions: send and classify, never pre-skip

faq 140's lock table says **most promotion types lock `original_price` from
the moment the promotion is SCHEDULED**, not only while it runs — product and
platform promotions, Seller Discount, flash and brand sales, group buy,
Bundle Deal, add-on SUB items, exclusive price, welcome package, synced
promotions. The exceptions that do NOT lock: wholesale, the permanent selling
price, the add-on MAIN item, purchase-with-purchase (main and sub) and the
gift of a gift-with-purchase. The two streaming-price rows disagree between the
item table (locked) and the model table (not); which one `update_price`
honours is unverified. ⚠️ Seller Discount and Bundle Deal — the two a BR seller
most plausibly runs — both lock.

**Why no `get_item_promotion` on the send path.** `has_promotion` is
ONGOING-only on both reads, so it cannot see an upcoming lock, and probe **P2**
showed it `true` on a listing with no promotion at all. `get_item_promotion`
can see an upcoming one, but its promotion types do not map one to one onto
faq 140's rows, it costs a call per chunk on the quota every conta shares, and
it would still be a guess about what `update_price` will do. The refusal is the
correctness either way, so the sender SENDS and classifies what comes back.

A lock is **`pulado bloqueado-por-promocao` with NO link stamp**: the listing is
healthy and the lock ends on its own, and stamping it would mark a listing
broken for the length of a promotion. The four codes that mean it (T1) are
`error_cannt_edit_price_in_promotion`, `error_in_item_promotion_item_price_lock`,
`error_cannot_update_price_in_promotion` and
`error_related_product_in_promotion`, plus the free-text needle `promotion` in
a per-model reason (and a generic per-model reason under one of those four
top-level codes reads as the lock too, §8); which promotion produces which
code is not documented anywhere (register 134, needs a BR shop with a live
Seller Discount).

Two neighbours that are not promotions:

- **The slash price** (`error_slash_price_not_lowest`,
  `error_slash_price_models_diff`) is `pulado preco-riscado`, also unstamped. A
  slash sale is the struck-through price, NOT a flash sale (`relâmpago`); the
  docs define it nowhere (register 168), so it is classified from the code text
  alone.
- **Wholesale** does not lock, yet `update_price` refuses a price below a
  tier's unit price, a tier under the minimum percentage of the new price, and
  models with different prices while wholesale is set — so a DECREASE, or any
  per-model divergence, can fail on a wholesale listing without anyone touching
  wholesale. That is `falha conflito-com-atacado`, stamped, and the remedy is on
  Shopee. This step never sends `wholesale` (§16).

## 7. The code table: both spellings, and the dot

`classificarCodigoDePreco(codigo, mensagem, kind)` is ONE table with TWO
consumers — the envelope's top-level `error` and each `failure_list` row's
`failed_reason` — so the per-model half can never drift into a second copy.

- **Lookups use the STRIPPED code, storage keeps the VERBATIM one.** Shopee
  prints the same code with and without its module prefix
  (`product.error_param` / `error_param`), so every key is matched against
  `shopeeCodeSemPrefixoDeModulo(codigo) ?? codigo` from the package. The table
  never returns the code: the sender stores what it received, beside the
  motivo.
- **Every lookup is a `Map` or a `Set`.** The keys arrive from a provider; on
  an object literal a code of `constructor` answers a prototype member and
  takes a real row.
- **`failed_reason` is free text that arrives AS the code** (probe **P9**:
  `"model ID not exist in sku"`), so the two code-blind needles — T1's
  `promotion` and T4's `model id not exist` — are matched lower-cased on the
  code AND the message.

The rows, in the declared order (the order is load-bearing):

| #    | code / needle                                                                        | action  | motivo                                         |
| ---- | ------------------------------------------------------------------------------------ | ------- | ---------------------------------------------- |
| T1   | the four promotion codes; needle `promotion`                                         | skip    | `bloqueado-por-promocao`                       |
| T2   | the two slash-price codes                                                            | skip    | `preco-riscado`                                |
| T3   | `error_edit_item_price_for_item_has_model`                                           | refuse  | `forma-de-modelo-divergente`                   |
| T4   | `error_param` with `repeat model_id` / `wrong model_id`; needle `model id not exist` | refuse  | `modelo-invalido`                              |
| T5   | `error_item_not_belong_shop`; `error_item_not_found`, `error_nil_shopid_or_itemid`   | refuse  | `anuncio-de-outra-loja`; `anuncio-inexistente` |
| T6   | the two `exceed_*_limitt` codes, `error_price_out_of_range`                          | refuse  | `preco-fora-da-faixa`                          |
| T7   | `error_invalid_price`                                                                | refuse  | `preco-invalido`                               |
| T8   | `error_invalid_price_for_logistic`                                                   | refuse  | `preco-acima-do-limite-do-frete`               |
| T9   | the three wholesale codes                                                            | refuse  | `conflito-com-atacado`                         |
| T10  | `error_busi_cannot_edit_vsku`                                                        | refuse  | `loja-vsku`                                    |
| T11  | `error_item_uneditable`                                                              | refuse  | `anuncio-nao-editavel`                         |
| T12  | `error_seller_under_penalty`; `error_perm_non_admin`                                 | end run | `loja-com-penalidade`; `sem-permissao`         |
| T12b | `error_update_price_fail`                                                            | refuse  | `preco-recusado`                               |
| T13  | kind `transient`; `error_system_busy`; `error_inner` with a retry sentence           | rethrow | —                                              |
| T14  | anything else                                                                        | refuse  | `recusa-desconhecida` (the raw code kept)      |

⚠️ **T12b is the probe's finding, and it overturned the page.**
`error_update_price_fail` says "please try later", and that is FALSE for every
cause the sandbox produced: a ratio violation (against unsent siblings too,
P11/P11b), a deleted listing (P15 — not `error_item_not_found`), a has-model
listing addressed without a model (P12 — not T3's code, which was never
observed) and an all-invalid model list (P10). Read as transient it would retry
forever a write that can never land, so it is a stamped refusal with a message
naming the measured causes, and the bare "please try later" needle is gone
from T13. The near-miss is pinned: `error_system_busy` still rethrows.

Order constraints: T1 before T4/T14 (a promotion lock can arrive under
`error_param`, and read as T4 it would stamp a healthy listing); T12 before
T12b and T13 (a conta-wide refusal read as transient retries a run against a
shop that cannot accept it); T13's `error_inner` needles before T14
(`error_inner` carries both a retry sentence and a permanent one).

The rate limit and a dead authorization never reach the table: they are
CLASSES the sender narrows first (§8). `fatal` ends the run for the conta
without a conta pause (register 143).

## 8. `error === ''` proves nothing

Two measured shapes say the same thing from opposite ends:

- **P9** — one valid and one bogus model: **HTTP 200, `error: ''`**, one
  `success_list` row and one `failure_list` row, the valid model applied and
  the sibling intact. A clean envelope is not a clean write.
- **P4c-bogus** — a bogus model on a no-model item: the top-level
  `product.error_update_price_fail` **AND** a populated `failure_list`. The
  envelope error COEXISTS with the lists. (P10 — every model bogus on a
  HAS-model item — recorded only the top-level code; the coexistence is
  P4c-bogus's alone.)

So `updatePrice` became the SECOND operation in the package to carry
`payloadNoErro: true` (the source-count pin went from 1 to 2): an error envelope
whose body re-parses arrives as `ShopeeApiPartialError` with the lists
attached, instead of the plain error that would throw them away. ⚠️ The
transport builds the partial INSTEAD of whichever subclass the envelope would
have produced, and copies its `kind` — so a rate limit or a dead authorization
that arrives with lists is a partial of kind `burst` / `daily` / `reauth`.

Hence the sender's ONE narrowing order, at every call:

1. `ShopeeRateLimitError` ⇒ `pausa` (§11);
2. `ShopeeReauthRequiredError` ⇒ `fatal reauth`;
3. `ShopeeApiPartialError` ⇒ read `err.kind` FIRST (a pause or a fatal), and
   only then re-parse the lists with `shopeeUpdatePriceSchema.safeParse` (never
   a cast) and attribute per model;
4. `ShopeeApiError` ⇒ the code table for every sent model;
5. the four conta classes ⇒ `fatal conta-nao-configurada`;
6. `ShopeeSchemaError`, and anything else ⇒ rethrow.

⚠️ The first three EXTEND `ShopeeApiError`, so each is narrowed before it; a
base-class arm placed above them swallows all three.

**Attribution is per model, by id, never by position.** A sent model named in
`failure_list` reads its `failed_reason` through the table (a per-model reason
the table calls `fatal` or transient becomes an UNSTAMPED refusal row — the
call already landed its other models, and a pause would drop their
write-backs); one answered in `success_list` is accepted, pending §9; one named
in neither takes the top-level code's classification when the call threw, else
`modelo-sem-resposta`. ⚠️ A per-model reason the table does NOT know (T14 — a
generic `"fail"`, or an empty reason) says nothing about WHY, so when the call
also threw a top-level code the table DOES know, the row takes that top-level
reading instead: a promotion lock stays an unstamped `bloqueado-por-promocao`
skip, and the catch-all stays `preco-recusado` stamped under Shopee's top-level
code verbatim. The free text survives as the row's code only when the
top-level reading carries none, and a KNOWN per-model reason (T4's
`model ID not exist in sku`) still wins over any top-level code — it names THIS
model, the top-level code names the call. A model Shopee both echoed and
refused is never recorded as sent. The item: any `falha` row ⇒ `falha`
(`envio-parcial` when at least one model was accepted); no `falha` and nothing
accepted ⇒ `pulado`; otherwise `enviado`.

⚠️ **The pre-wire checks are the operator's only reason.** Because
`error_update_price_fail` is Shopee's single answer for several causes, the
decision's ratio gate (`razao-de-precos-excedida`) and structure gate (fresh
`has_model` vs the plan's shape, `forma-de-modelo-divergente`) are PRIMARY: they
name the cause before the call, where Shopee would only say "refused".

## 9. Echo vs read-back

`FONTE_DE_VERIFICACAO_PRECO` picks the source that confirms an accepted write:
the `update_price` ECHO (`'eco'`, zero calls) or a fresh read-back
(`'releitura'`, one read per item on the shared quota). Probes **P4/P8**
measured echo == request == read-back on every accepted write, so it is the
echo. What the echo cannot prove — that the STORED value equals the echoed one
on a shop where the two would differ — is why the read-back seam exists; the
flip is that one literal.

⚠️ **A no-model echo carries NO `model_id`** (probe **P4c**, with `model_id: 0`
sent and with it omitted). The package reads it as `null`, and `modeloDoEco`
matches the one no-model entry by that ABSENCE (a `0` is accepted too — the
price page's own sample prints it — because reporting a landed write as
unanswered is the worse error). On a listing WITH models a `null` echo answers
nothing: it is never guessed onto the one model it could plausibly be.

A divergence is a sent model whose echo carries a number that is not the same
price in reais (`mesmoPrecoEmReais`, never `===`, never a tolerance). It
becomes `falha preco-nao-atualizado` and is **never stamped**: the write was
accepted and the listing is fine, only the value is uncertified.

Two more measured facts nothing may lean on:

- **A price write does NOT move `update_time`** (probe **P5**). That clock
  confirms nothing about a price, from either source.
- **Shopee rounds a third decimal half-up** (probe **P7**) while
  `roundReais(15.555)` gives `15.55` (binary float). Harmless: the package's
  validator refuses more than two decimals, so nothing we send has a third,
  and the echo is compared against what we sent.

## 10. The write-backs: ten fields, ONE writer, ONE clearer

| document      | fields                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `prodshopee`  | `precoEnviado`, `precoEnviadoEm`, `precoRecusaEm`, `precoRecusaCodigo`, `precoRecusaMotivo`, `precoRecusaMensagem` (+ `ultimaModificacao`) |
| `variashopee` | `precoEnviado`, `precoEnviadoEm`, `precoRecusaEm`, `precoRecusaCodigo` (+ `ultimaModificacao`)                                             |

Every stamp is MILLISECONDS; every patch is FLAT and goes through
`mergeIfExists`, which is not an upsert — a link deleted between the plan and
the write answers `false`, stays deleted and costs one `console.warn`. The
writes are sequential and per document, the children first and the item LAST,
so a crash midway never leaves the parent claiming more than its children show.
`linkPreco.ts` is the only module that writes these fields and the sender its
only caller; nothing here writes `item_status` or `estadoAnuncio`.

- **The ONE clearer is the clean send.** `registrarPrecoLimpo` writes `null`
  to all four `precoRecusa*` fields of the item, and its patch is TOTAL over
  `CAMPOS_DO_PATCH_DE_PRECO` by the compiler. "Clean" means the WHOLE item is
  in sync: at least one model accepted and verified, no `falha` row, and every
  other row `preco-igual` or `preco-nao-encontrado`. An accepted model beside a
  guard-held, unreadable, absent or locked sibling writes only the children's
  success pairs. `precoEnviado` lands on the item only for a no-model listing; a
  has-model listing's prices live per model.
- **A refusal does not touch the success pair, and a partial does not clear.**
  The item is stamped only for a motivo in `MOTIVOS_QUE_CARIMBAM` — Shopee's code
  VERBATIM, or the ERP's own `erp:<motivo>` when the refusal is ours — and the
  previous `precoEnviado` stays the honest answer to "what did this ERP last get
  accepted". A child is stamped iff its own row is a stamping `falha`, whatever
  produced it.
- **A child's refusal self-expires.** A reader shows it only while
  `precoRecusaEm >= (precoEnviadoEm ?? 0)` on the SAME `variashopee` doc, so the
  model's next accepted send hides it, and no child write ever carries a
  `null`. ⚠️ **Open item (D-7, step 21):** a model refused in a partial send
  that later reads `preco-igual` keeps its refusal legible while the item reads
  clean; whether the reader should also anchor on the parent's `precoEnviadoEm`
  is the web step's call.
- **Written by NOTHING:** `preco-igual`, a promotion or slash-price lock, an
  echo mismatch, a skip, a pause, a fatal, a rethrow. ⚠️ Above all
  `preco-igual`: `precoEnviado` means "the price THIS ERP sent", and an equal
  reading may be a Seller Centre edit that happens to match. Stamping it would
  attribute the seller's price to us.

**Rule 7: tier 0, by design.** None of the ten fields is ever read to DECIDE a
send — the sender decides from Shopee's own reading of the listing, taken for
that send (a no-model listing's base row is the request's batch, §1) — so no
transaction, no precondition, no inventory row. What a lost race (the manual
push and the job on one item, two operators, a retry) CAN leave is a stale
diagnostic, and it stays stale until the next send that CHANGES the price: a
`preco-igual` send writes nothing, so a late success pair (15 landing after a
newer send of 12 already did) stands for as long as the price holds. ⚠️ The
item's refusal fields are cleared by a `null` write, not expired by a stamp, so
a refusal that lands after a newer clean clear stands beside the newer
`precoEnviadoEm`: step 21's reader must show the item's refusal only while
`precoRecusaEm >= (precoEnviadoEm ?? 0)` — the child rows' rule above, which
survives this race where the `null` clear does not. The accepted residual
(register 147): a crash between an accepted write and its write-back replays as
`preco-igual`, writes no success stamp for it, and under-reports at most that
one item.

`ultimaModificacao` rides every write in ms; on these docs it is an UNDECLARED
pass-through with mixed legacy shapes (register 141).

**Push 22 stays `ack`.** Shopee's `item_price_update_push` fires on OUR
`update_price` AND on Seller Centre edits, with no actor field, so it cannot
tell the two apart and nothing consumes it yet. A future consumer would
correlate against these fields — `(item_id, model_id)` to the doc, `new_value`
against `precoEnviado`, the push's `update_time` in SECONDS against
`precoEnviadoEm` in MILLISECONDS — and must re-decide the race tier above,
because it would be the first reader to DECIDE from them (register 142; §14).

## 11. Burst is a pause; daily is a clock

Shopee's rate limit is per APPLICATION: every conta's stock queue, every
manual stock push and every price send spend one quota (register 97). Price
therefore adds no pause of its own:

- **It READS the stock sync's quota pause and never writes it.** The route
  reads `estoqueShopeeSync/{integracaoId}` and answers 409
  `SHOPEE_CONTA_PAUSADA` with `pausadoAte` before any Shopee call — but only for
  the two QUOTA motives, `burst` and `cota-diaria` (the imported
  `MOTIVOS_DE_PAUSA` constants). A holiday or blocked-shop pause is a stock
  condition, not a price one. Price does not write the doc because its header
  names five writers and a sixth would be refused; the stock sweep discovers a
  daily exhaustion itself at its next call (register 162).
- **A burst mid-run** ends the rest of the manual run as `nao-tentado
conta-pausada` and answers 200 with `pausadoAte = nowMs + (retryAfterSeconds
?? ratePauseMin() × 60) × 1000`. `ratePauseMin()` is
  `SHOPEE_STOCK_RATE_PAUSE_MIN`, REUSED: two numbers for one limiter would make
  one surface resume while the other still waits, so there is no price pause
  knob.
- **The daily quota** pauses until the next 00:00 UTC+8,
  `proximaViradaDaCotaMs(nowMs)` — arithmetic on the logical instant, never a
  `Retry-After`.

A `pausa` carries no rows and writes nothing, even when it arrives after a write
that landed: the surface reports the item `nao-tentado`, and the next run reads
the landed price back as already equal. How the job re-enqueues a burst and
parks a daily exhaustion is §13.

## 12. The decrease guard: two defaults, one legacy asymmetry

Without `baixarPreco`, a model whose target is BELOW its current price is
`pulado preco-menor-bloqueado` (compared in integer centavos,
`centavosDeReais`), and a model whose current price is unreadable is `pulado
preco-atual-ilegivel` — a decrease cannot be ruled out without a comparand.
When nothing is left to send, the item's motivo is the dominant one:
`preco-menor-bloqueado` over `preco-atual-ilegivel`. With `baixarPreco` both
send.

| surface                     | default                                               |
| --------------------------- | ----------------------------------------------------- |
| the manual route            | OFF — absent is `false`; the string `"true"` is a 400 |
| the CLI                     | OFF — `--baixar-preco` turns it on                    |
| the account-wide job (PR 2) | OFF                                                   |
| the web button (step 21)    | ON — an operator who picked produtos asked for it     |

The legacy had the same asymmetry: its account-wide "update prices" action never
lowered a price, while the per-produto "send prices" action from the produtos
table lowered freely. The split is kept on purpose — a bulk run over every
listing of a conta must not quietly lower prices an operator never looked at,
and a push the operator aimed at named produtos is exactly that look.

## 13. The job: identities at plan, prices at drain, one checkpoint per item

`POST /api/marketplace/shopee/atualizar-precos` (`PERM.integracao.write`)
takes `{ integracaoId, baixarPreco? }` and answers **202 `{ jobId }`** once the
job document exists and its first dispatch is enqueued. The ladder, in order:
the body (400; `baixarPreco` a real boolean or absent, absent is OFF, §12); the
Tasks valve, `SHOPEE_TASKS_DISABLED` (503 `SHOPEE_PRICE_SYNC_ENQUEUE_FAILED`,
before any document is written or any conta read); ONE clock read; the context
(404); a blank normal tabela (400); the stock sync's quota pause (409
`SHOPEE_CONTA_PAUSADA`); the conta verdict (422 `SHOPEE_PRECO_CONTA_RECUSADA`,
§5); then the start itself (409 `SHOPEE_PRICE_SYNC_RUNNING` while a live job
holds the conta) and the enqueue. Those conta rungs are the manual push's own,
DUPLICATED in the two routes rather than shared — both copies are pinned by
their tests, and promoting them into one helper here needs a ruling, because
the module list was frozen (register 183). An enqueue that fails after the job
exists stamps it `failed` with one `job-interrompido` row before answering 503
(an enqueue class it knows) or rethrowing (anything else), so no `running`
document is left for nothing to drain.

**One dispatch** of `processShopeePriceSync` runs `processarEnvioPrecoShopee`
once:

1. Read the job; anything but `running` answers `noop`.
2. Load the conta context — Firestore and the environment only. A conta of the
   wrong `tipo` fails the job on the FIRST attempt, before any Shopee call.
3. PLAN one page, only while `fila` is empty and the walk is not done:
   `lerPaginaDeFamiliasDePreco` hands up to `pageLimitPreco()` anchors (default
   25, clamped to [1, 50]) in id order plus the next cursor; each family goes
   through the SAME pure planner the manual push uses; its listings join `fila`
   as IDENTITIES (item, link and model ids — no price, no category) and the
   planner's refusals become report rows, committed with the page's job patch
   in ONE batch. A walk whose anchor count is an exact multiple of the page
   costs one more, EMPTY, page before the cursor reads `null`.
4. DRAIN at most `itensPorDespachoPreco()` listings (default 10, which is also
   the ceiling), only while `fila` holds any. Lazily, and in this order: the
   stock quota pause is READ, then the conta verdict runs — the only place a
   Shopee client is built and the shop read spent — then ONE batched base
   reader serves the whole lote. Per listing: read its `precos` NOW, price it,
   send it through the manual push's own per-item sender, checkpoint.
5. Re-enqueue itself, or finish: `completed` with `relatorioCompleto: true`,
   through the one transaction below.

A plan-only dispatch builds no client and calls no Shopee operation, which is
what lets the emulator round trip (`atualizarPrecos.tasks.test.ts`, in
`ci-shopee.yml`) drive three whole shapes with zero Shopee calls, by call
order: plan-time refusals across two pages to `completed`, a job cancelled
before its first dispatch answering `noop`, and a wrong-`tipo` conta stamped
`failed` on attempt 0.

⚠️ **The price is read at DRAIN time, never at plan time** (reconcile C-d) —
deliberately unlike Mercado Livre, whose queue freezes each price when it is
planned. A planned page here can PARK across a daily-quota rollover, up to a
day, and a frozen price would then send a day-old tabela value. So `fila` holds
identities only, and each listing's `precos` are read through
`lerPrecosDosProdutos`, over exactly `produtosQuePrecificam`, the moment before
`precificarItem` and the sender run — the manual push's send-time read (§1). A
produto deleted between plan and drain reads `preco-nao-encontrado`.

⚠️ **The checkpoint is PER ITEM, and it is ONE batch** (reconcile C-p). After
every drained listing the job patch — the consumed head of `fila`, the
counters, the capped samples, the cursor — and that listing's report rows
commit in ONE `db.batch()`. Written apart there are two windows and both lose:
row-then-consume duplicates the listing on a retry, consume-then-row drops its
rows. Per item rather than per dispatch, because a crash then replays AT MOST
ONE landed send, which the sender's skip-if-equal reads back as `pulado
preco-igual`: the price is right and the report under-reports one row set per
crash (register 147). It is a batch and not a transaction because nothing in
it is read-modify-write — a shard index derives from `relatorioLinhas`, which
only moves on a committed checkpoint — and it never writes `status`, so it
cannot clobber a terminal stamp.

**The report.** One row per planned MODEL (a no-model listing has one), keyed
by `relatorioEnvioPrecoRowKey`, which is identity only. The row SET is a
function of the queue entry and never of the outcome: a listing skipped whole
still writes one row per model, so a replay overwrites the same keys instead
of leaving two truths for one listing. The rows reuse Mercado Livre's
channel-neutral `relatorioEnvioPrecoSchema`, 500 to a shard under
`enviosPrecoShopee/{id}/relatorios`; the job document keeps EXACT counters
beside capped samples (`skips` 200, `failures` 100).

**Burst, park, fail.** A BURST — Shopee's, or the stock sync's quota pause with
motive `burst` — checkpoints WITHOUT consuming the head and re-enqueues itself
with a delay (`Retry-After`, else `ratePauseMin()` × 60, or the time the stock
pause has left), consuming no Cloud Tasks attempt; the 51st pause of one run
fails it. The DAILY quota — Shopee's, or the stock pause's `cota-diaria` —
PARKS the job: `retomarEm` is the next 00:00 UTC+8 plus up to 30 s of jitter,
`status` stays `running`, the resumed dispatch clears `retomarEm`, and the
fourth park fails the run. A holiday or blocked-shop stock pause is a stock
condition and pauses nothing here. A conta refused mid-run, a sender `fatal`
and the first-attempt classes fail the job at once; anything else rethrows
into the queue's three-attempt ladder and stamps `failed` on the LAST attempt,
because nothing re-drives a task the queue has dropped. The failure's `erro`
is the motivo and its pt-BR sentence, never the provider's text.

**The one-active guard, and the race it ACCEPTS** (reconcile C-q). A start is
refused while a `running` job of the conta exists — one query,
`integracaoId ==` and `status == running`, limit 1, on its own declared
composite. A job silent for six hours is an ORPHAN and the next start reclaims
it (`failed`, one `job-interrompido` row); a PARKED job is exempt while its
`retomarEm` is ahead or less than an hour behind, since its `updatedAt`
legitimately stops for up to a day. The guard is a query and then a write,
NOT a transaction, so two concurrent starts both pass and produce two `running`
jobs. Accepted, for three reasons: the loser is a duplicate job sending the
SAME drain-time values, never a wrong price; the queue runs one dispatch at a
time, so the second job's skip-if-equal reads the first's writes back as
`preco-igual` and the cost is bounded by one catalogue pass; and closing it
would rest on query-range locking inside a server transaction, which is
unverified on Enterprise. A test PINS the race — two interleaved starts, two
documents — so closing it later is a deliberate edit, not a drift (register
156). A parked job holds the slot for at most three rollovers; cancel is the
exit (register 161).

**The ONE transaction, class B.** `finalizarEnvioPrecoShopee` is the sole
writer of a terminal `status`, which has six writers that do not coordinate:
the orphan reclaim, a dispatch's terminal failure, the `completed` flip, the
final-attempt stamp, the start route's enqueue-failure fallback and the
operator's cancel. It re-derives "still `running`?" — and, on a cancel, the
conta — from the `tx.get` snapshot, and derives the synthetic row's shard and
`filaRestante` INSIDE the callback, so an OCC retry recomputes them rather
than re-applying a captured count. It is inventoried in
`firestore-transaction-inventory.test.js`, and it is the only place in this
folder that names that API (§15).

**Cancel and the three readers.** `POST …/atualizar-precos/cancelar`
`{ integracaoId, jobId }` stamps `cancelled` with `filaRestante` and one
`job-cancelado` row; a job already terminal answers 409
`SHOPEE_PRICE_SYNC_NOT_RUNNING`, and a missing job and another conta's job
answer the SAME 404. A cancel that lands while a listing is being sent lets
that listing finish, and the dispatch's later `completed` stamp answers `noop`.
`GET status` masks the job read to the fields it returns and never returns
`fila`; `GET historico` lists runs newest first (`limite` 1–50, default 20,
refused rather than clamped) on the `(integracaoId, startedAt DESC)` composite
and HIDES a run whose `expiraEm` has passed, after the limit, so a page can
come back short; `GET relatorio` pages four shards at a time by document id
(`depois`, four or more digits) and joins each row's `nome` and `sku` — the
variation's on a model row, the anchor's on a no-model one. Every row's
`mensagem` is `mensagemDoMotivoDePreco`'s sentence, rendered at READ time. ⚠️
All three readers require `PERM.integracao.write`, unlike step 9's `.read`
status route.

**Retention.** The job carries `expiraEm` = `startedAt` + 180 days
(`RETENCAO_ENVIO_PRECO_SHOPEE_DIAS`, Mercado Livre's number) and every shard
write `startedAt` + 187 days, both `Date`s derived from `startedAt` and never
from a clock, so a replayed shard write re-stamps the SAME instant. The
`enviosPrecoShopee.expiraEm` policy is declared in `firestore.indexes.json`
with its `TTL_POLICIES` row; the `relatorios` group's policy already existed
for Mercado Livre's shards and now names this writer too. Like the two job
composites, it deploys in the migration window (#1532), never by an agent.

**Env, and what deliberately has none.** `SHOPEE_PRICE_PAGE_LIMIT` (25, [1, 50])
and `SHOPEE_PRICE_ITEMS_PER_DISPATCH` (10, [1, 10]), read only by the
functions codebase. ⚠️ The second's ceiling IS the budget: ≈ 20 s per listing
at worst makes ≈ 200 s of the queue's 300 s, so no accepted value can outrun
the timeout, and raising the ceiling is a decision on a MEASURED per-item time
(register 157), never an env change. No valve of its own — every job is an
operator's start, and the queue already rides `SHOPEE_TASKS_DISABLED`; no
pause knob — the burst fallback is the stock sync's `ratePauseMin()` (§11);
and no deploy-shell knob — the queue's `rateLimits` are a literal 1/1, because
the job document IS the checkpoint and two concurrent dispatches of one job
would race it.

## 14. Push 22 stays `ack`

`item_price_update_push` (push code 22, push_api_id 25) fires on OUR
`update_price` AND on a Seller Centre edit, and it carries no actor field and
no job id — the step text's "ignore it for our own job ids" had nothing to key
on. So it cannot tell the two apart, and the dispatch table `ack`s it with a
comment pointing here. What a future consumer would have to correlate, and
where each join is sharp:

- `(item_id, model_id)` → the link document: `prodshopee` for a no-model
  listing, the model's `variashopee` otherwise.
- `new_value` against `precoEnviado` — through `mesmoPrecoEmReais`, never
  `===`.
- The push's `update_time` is SECONDS and `precoEnviadoEm` is MILLISECONDS: a
  cross-unit comparison is the guard that never fires (root rule 7).
- ⚠️ The receiver's identity for code 22 is `<shop>:<item_id>` — the code-22
  arm of the identity switch in `notificacoes/notificacao.ts` — so its dedup
  key carries NO `model_id`, and two models of one listing are one entity to
  it.
- ⚠️ A price write does NOT move the listing's `update_time` (probe **P5**),
  so the listing's own clock confirms nothing either.

That consumer would be the first reader to DECIDE from the write-back fields,
so it must re-decide §10's race tier, which is tier 0 today only because
nothing decides from them (register 142). Unverified: whether push 22 fires
for an OpenAPI write at all, and whether it is one push per model (a BR shop,
E1 U13 — sandbox pushes are canned); whether an ERP System app may subscribe
to it (a Console look, U14).

## 15. Folder discipline

Eleven raw-text greps must hold under `apps/shopee/lib/shopee/precos/*` —
source files only, `*.test.ts` and `*.md` excluded, comments and docblocks
INCLUDED, so a source file states a prohibition without spelling the banned
name. As rules:

1. The multi-document atomic-write API appears in EXACTLY ONE file,
   `atualizarPrecos.ts` — the class-B finalize (§13). The first PR had none.
2. No ambient clock, no timer, no µs converter and no `next/server` import: the
   functions bundle reaches this folder, and the instant is `deps.nowMs`,
   elapsed time `deps.agora()` and a wait `deps.esperar(ms)`.
3. None of the shared equivalence-fold helpers. The price fold is
   `mesmoPrecoEmReais`, and it is inventoried (§3).
4. No raw `.collection(`: every access goes through the
   `@delfrance/data/admin/collections` handles, and `mergeIfExists` patches
   are FLAT.
5. No hour or day millisecond literal: every bound is built from named units.
6. `process.env` only in `constantesPreco.ts`, the folder's one reader family.
7. The sandbox variable is never read here (a WORD match: the resolved-host
   constant is allowed) — the region gate takes the config as a parameter
   (§5).
8. The promotional price's wire field is never spelled — the comparand is step
   9's shelf reader (§4).
9. No promotion pre-read on the send path (§6).
10. No `wholesale` key and no `item_status` key in anything this folder builds
    — it writes neither.
11. No ad-hoc rounding: money goes through `roundReais`, compared in integer
    centavos.

```bash
P='apps/shopee/lib/shopee/precos/*'; X=':(exclude)*.test.ts'; Y=':(exclude)*.md'
git grep -n "runTransaction" -- "$P" "$X" "$Y"   # exactly atualizarPrecos.ts
git grep -nE "Date\.now\(|new Date\(\)|setTimeout\(|setInterval\(|millisToMicros|coerceToMicros|from 'next/server'" -- "$P" "$X" "$Y"
git grep -nE "\b(normalizeLoose|localizarDecimal|parseDecimalPtBr|parseCentesimos|deepEqual|stripNullsDeep)\b" -- "$P" "$X" "$Y"
git grep -n "\.collection(" -- "$P" "$X" "$Y"
git grep -nE "3_600_000|86_400_000|8 \* 3600" -- "$P" "$X" "$Y"
git grep -n "process\.env" -- "$P" "$X" "$Y" ":(exclude)*constantesPreco.ts"
git grep -nw "SHOPEE_SANDBOX" -- "$P" "$X" "$Y"
git grep -n "current_price" -- "$P" "$X" "$Y"
git grep -n "getItemPromotion" -- "$P" "$X" "$Y"
git grep -nE "\bwholesale\b\s*:|item_status\s*:" -- "$P" "$X" "$Y"
git grep -nE "toFixed\(|Math\.round\(" -- "$P" "$X" "$Y"
```

Every line but the first must print NOTHING. ⚠️ `git grep` prints nothing for
an UNTRACKED file either, so a new module is checked only after `git add -N`.

Two backstops hold the vocabulary. `motivosProduzidos.test.ts` walks all 46
motivos and fails on any without a producer outside `errosPreco.ts` — over
this folder plus BOTH route folders, `enviar-precos` and `atualizar-precos`,
with an EMPTY allow-list. `filaPreco.types.test.ts` pins the stored `fila`
entry to the planner's own `ItemPlanejadoPreco`, field for field, so the job
can price a queue entry with no cast and no field can creep into one side
alone.

## 16. Out of scope, on purpose

- **A schedule.** Price sync is manual-only, as on Mercado Livre (master plan
  §7 q6, answered on 2026-09-24): every send is an operator's push or job, so
  there is nothing unattended to put behind a valve.
- **`wholesale` and the `tabelasAtacado` editor.** This step never sends
  `wholesale` — a wholesale listing's refusals are only classified (§6) — and
  the editor MOVED to whichever step first sends it (decision of 2026-09-24);
  the web override keeps the field hidden meanwhile.
- **Native kits.** A `kitNativo` listing is `kit-derivado`; whether
  `update_price` even accepts a kit `item_id` is step 19's probe (E1 U15). An
  ERP `ehKit` produto is an ordinary listing, and it IS priced.
- **Cross-border and `local_price`.** `is_cb` is refused before the region
  (§5); a CB listing's price is in the seller's own currency.
- **A pre-read of anything the refusal already answers**: no
  `get_item_promotion` (§6) and no `price_limit` band read — the band codes are
  classified (T6, register 136).
- **A reconciliation phase and a push-22 consumer** (§14).
- **A job CLI.** The rehearsal starts the job only through the deployed route,
  which is exactly what proves the App Hosting identity's first enqueue onto a
  real queue (reconcile C-s).
- **The web.** The provider row (Mercado Livre's, with the channel swapped), the
  job card, the history screen, the CSV export, `jobs-em-andamento` and the
  `registriesAlinhadas` row are step 21's (register 159); the five routes are
  what they will call.

## 17. What is UNVERIFIED and what settles it

The settle-live register for step 13 is **items 127–183**, and the
authoritative table — same numbers, same statuses — is the Built-13 bullet in
`.master_plans/shopee/shopee-marketplace-integration.md` §4. None of them is a
gate. In short:

- **Settled by the SG sandbox probe of 2026-09-24**: 127 (`model_id: 0` and an
  omitted key both land, and the success entry carries no `model_id`), 128
  (`error` coexists with the lists, so `updatePrice` carries `payloadNoErro`),
  129 (the success envelope does carry `error: ""`), 130 (echo == request ==
  read-back, so the echo verifies), 131 (a partial `price_list` preserves the
  unsent siblings — the first PR's pre-merge blocker), 132 (no zero-fill on a
  fresh item: the comparand's fallback is dormant, not wrong), 133 (the ratio
  refusal is `error_update_price_fail`, with no needle of its own), plus the
  facts the probe raised — 171 (that code is DETERMINISTIC, never transient),
  172 (SG's 5×: 4.5× accepted, 5.5× refused), 173 (T3's code never fired), 174
  (`has_promotion` is unreliable), 175 (`update_time` does not move) and 176
  (Shopee rounds a third decimal half-up).
- **Needs a BR shop, and is not rehearsable in the sandbox**: 134 (which of the
  four promotion codes each promotion type answers, and whether an UPCOMING
  one already refuses — E1 U10/U11, and the streaming-price row U12), 135
  (`is_cb` live), BR's 4× (the half of 172 that is documentation only) and
  BR's `price_limit` band (136; E1 U7/U19), 168 (what a slash sale is — U21, or
  a support ticket), the logistics threshold of
  `error_invalid_price_for_logistic` (U18), whether a seller-set selling price
  is visible to a promotion read (U22), and push 22's firing (142; U13).
  Whether the Console offers a BR test shop at all is Lucas's look (U20,
  register 170).
- **Needs a second sandbox run**: 144 (does a FULL holiday block a price write —
  U17, the twin of step 12's 106), 146 (a `MODEL_UNAVAILABLE` model in the
  ratio input — probe P14 was not run), 182 (whether a no-model item's FAILURE
  entry also omits `model_id`, which would fail the whole body's parse), and
  the wholesale codes on a decrease (U16, if the category takes wholesale at
  all).
- **Needs the staging rehearsal — Lucas's go, never an agent's**: 153 (the
  first ROUTE-started Shopee job through a real queue, which proves the App
  Hosting identity's first enqueue), 155 (a price job starving the stock sweep
  on the shared per-APP quota — the rehearsal records calls per listing), 157
  (the per-listing drain time that would lift the per-dispatch ceiling of 10),
  158 (whether the paged anchor query range-bounds the conta or inherits
  step 12's residual filter — **#1638**), 160 (the sandbox override's env
  parity between App Hosting and the functions env), and the first real
  execution of the keyset read, the batch checkpoint's deep merge and the
  class-B finalize on Enterprise (the emulator lane is the only engine they
  have met).
- **Settled only by a deploy, and it is migration-window work** (root
  `CLAUDE.md` rule 8): 154 (the firebase-tools first-deploy crash hits the
  fourth queue — once on staging, for the price queue alone, and for all four
  on production's first deploy; `functions/DEPLOY.md`), and the two job
  composites plus the TTL policy (#1532).
- **Accepted, and visible in code**: 147 (a crash replays at most one landed
  send, under-reported), 148 (the no-model comparand's one-request window,
  §1 — including a guard-bypassing DECREASE), 156 (the start race), 161 (a
  parked job holds the slot), 163 (a produto whose `integracoesComProduto` lags
  is never enumerated by the job; the manual push is the exit).
- **Questions and follow-ups with no owner yet**: 177 (the refusal-reader rule
  `precoRecusaEm >= (precoEnviadoEm ?? 0)`, for the item as well as the child,
  and whether a child should also anchor on its parent — step 21's call), 178
  (step 11's tier mapper refusing an UPDATE for a price it does not send — a
  question for Lucas), 179 (a throttle whose body is `response: {}` loses
  `Retry-After` in the transport's partial), 180 (Mercado Livre's two price
  comparisons still hand-rolled rather than bound to `mesmoPrecoEmReais`), 183
  (the duplicated conta ladder of the two routes), and 151's remainder
  (`ci-mercado-livre.yml`'s push paths still miss its own price-job schemas
  and `shared/ttl.ts`).
