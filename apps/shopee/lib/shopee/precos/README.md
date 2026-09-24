# `lib/shopee/precos/` — the price sync (step 13, #1521)

The design notes for the step that makes this app the first **SENDER of a
price** to Shopee. `apps/shopee/CLAUDE.md` keeps only the rules a reader must
not break and points here for the reasoning; this file is where the detail
lives, in the root `CLAUDE.md`'s sense of "detail lives where it is cheaper".
The reconciled design, the sandbox probe of 2026-09-24 and the wave reports that
produced this folder are in the step-13 review directory named by the PR that
closes #1521.

Step 13 ships in two stacked PRs. The first — this folder's thirteen modules,
the manual push and the CLI — is what sections 1–12 below describe. The second
adds the account-wide job (`atualizarPrecos.ts`, its scheduler and queue, its
routes) and sections 13–17: the job, push 22, the folder discipline, what is
out of scope on purpose, and what is UNVERIFIED.

Everything here was **offline-verified**, and the wire was measured ONCE, by
the probe of 2026-09-24: the SHIPPED `updatePrice` plus raw signed calls
against the **SG sandbox** shop, on two throwaway unlisted items that were
deleted afterwards. No module in this folder has run against a BR shop, in
reais or on production, and no staging rehearsal of the manual push has run
yet. Every "measured" below means that probe, on an SGD shop; a fact that only a
BR shop can settle says so where it appears.

## 1. The thirteen modules, in five families

The families are the seam, not a filing convention.

- **Constants and vocabulary** — `constantesPreco.ts` (the three
  probe-settled wire decisions, the ERP-side bounds and the manual push's two
  lazy `envInt` knobs; the folder's ONE `process.env` reader family, and NOT
  path-bound to the deploy preflight, because no price queue rate is
  env-driven) and `errosPreco.ts` (the 44-member `MotivoPrecoShopee` union with
  its TOTAL pt-BR table rendered at READ time, `MOTIVOS_QUE_CARIMBAM`, and the
  manual push's `ShopeeEnvioPrecoGuardError` with its three codes).
- **The conta and the code table** — `regiaoPreco.ts` (the conta verdict:
  six rungs from a missing `shop_id` to the region, and the one sandbox
  override) and `classificarPreco.ts` (Shopee's answer → skip, refuse, end the
  run, or retry). Neither writes anything.
- **The reads** — `descobertaPreco.ts` (the family read by anchor ids: one
  batch key read plus one join per anchor, CLASSIC queries on purpose),
  `leitorDeBase.ts` (the BATCHED `get_item_base_info`, one lazy call per chunk
  of up to 50 ids, reconciled by `item_id`) and `leituraPreco.ts` (the fresh
  read of one listing — `get_model_list` only when `has_model === true` — and
  its pure projection).
- **The pure half** — `planoPreco.ts` (WHICH listings and models are addressed,
  and separately WHERE each price comes from), `decisaoPreco.ts` (gates G2–G8:
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
resolves to its anchor (deduplicated after resolution), ONE batched base reader
serves the whole request, a pool at `concorrenciaEnvioPrecoManual()` sends, and
the deadline is measured on ELAPSED time. The answer is **200 whenever the run
ran**, even when every row failed: a per-listing refusal is data. A pause or a
conta-wide `fatal` mid-run ends the rest as `nao-tentado` rows and still answers
200, so the rows that already landed are reported rather than lost to a 500.
The envelope says `canal: 'shopee'`; its rows are per MODEL, carry Shopee's
`codigo` verbatim, and their `mensagem` is always `mensagemDoMotivoDePreco`'s
sentence.

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
what the decrease guard reads as `preco-atual-ilegivel` (§12).

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
a per-model reason; which promotion produces which code is not documented
anywhere (register 134, needs a BR shop with a live Seller Discount).

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
  Shopee. This step never sends `wholesale` (§16 in the second PR).

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
- **P4c-bogus / P10** — a bogus model on a no-model item: the top-level
  `product.error_update_price_fail` **AND** a populated `failure_list`. The
  envelope error COEXISTS with the lists.

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
`modelo-sem-resposta`. A model Shopee both echoed and refused is never recorded
as sent. The item: any `falha` row ⇒ `falha` (`envio-parcial` when at least one
model was accepted); no `falha` and nothing accepted ⇒ `pulado`; otherwise
`enviado`.

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
send — the sender decides from a FRESH Shopee read every time — so a lost race
(the manual push and the job on one item, two operators, a retry) leaves at
worst a stale diagnostic the next send overwrites. No transaction, no
precondition, no inventory row. The accepted residual (register 147): a crash
between an accepted write and its write-back replays as `preco-igual`, writes no
success stamp for it, and under-reports at most that one item.

`ultimaModificacao` rides every write in ms; on these docs it is an UNDECLARED
pass-through with mixed legacy shapes (register 141).

**Push 22 stays `ack`.** Shopee's `item_price_update_push` fires on OUR
`update_price` AND on Seller Centre edits, with no actor field, so it cannot
tell the two apart and nothing consumes it yet. A future consumer would
correlate against these fields — `(item_id, model_id)` to the doc, `new_value`
against `precoEnviado`, the push's `update_time` in SECONDS against
`precoEnviadoEm` in MILLISECONDS — and must re-decide the race tier above,
because it would be the first reader to DECIDE from them (register 142; §14 in
the second PR).

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
parks a daily exhaustion is §13, in the second PR.

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
