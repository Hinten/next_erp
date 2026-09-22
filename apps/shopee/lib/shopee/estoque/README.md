# `lib/shopee/estoque/` — the stock sync (step 12, #1520)

The design notes for the step that makes this app the first **SENDER of a
quantity** to Shopee, and the first thing in this channel that runs on a
schedule and writes to a live marketplace. `apps/shopee/CLAUDE.md` keeps only
the rules a reader must not break and points here for the reasoning; this file
is where the detail lives, in the root `CLAUDE.md`'s sense of "detail lives
where it is cheaper". The reconciled design, the sandbox WRITE probe of
2026-09-21 and the wave reports that produced this folder are in the step-12
review directory named by the PR that closed #1520.

Everything here is **offline-verified only**. The probe measured the wire
through the package's own operations against the **SG sandbox** shop; no module
in this folder has ever run against a BR shop, staging or production, and the
`README`'s last section says what that leaves open.

## The sixteen modules, in five families

The families are the seam, not a filing convention.

- **Constants and vocabulary** — `constantesEstoque.ts` (the queue name, the
  master valve, fifteen lazy `envInt`/`envFlag` readers and the ERP-side bounds;
  it is the folder's ONE `process.env` reader family and it is **PATH-BOUND** to
  `tools/deploy-env/preflight.mjs`) and `errosEstoque.ts` (the 47-member
  `MotivoEstoqueShopee` union with its TOTAL pt-BR table, `ehRecusa`, the
  per-model row shape, and the two error classes
  `ShopeeStockTasksDisabledError` and `ShopeeEnvioEstoqueGuardError`).
- **Pure quantity and policy** — `quantidadeEstoque.ts` (the ONE quantity
  function, moved here from `anuncios/montagemAnuncio.ts` and bound by BOTH
  publish and the sweep), `podeEnviarEstoque.ts` (the six-motivo send gate and
  the skip set), `planoEstoque.ts` (the planner, the chunker and the
  completeness invariant) and `reservaPromocao.ts` (the reserved floor). No
  clock, no network, no Firestore in any of the four.
- **Discovery and state** — `descobertaEstoque.ts` (the Pipelines discovery and
  the ledger pre-pass), `contaEstoque.ts` (the five conta gates behind three
  read caches), `estadoEstoque.ts` (the `estoqueShopeeSync/{integracaoId}` state
  document) and `varreduraEstoque.ts` (the three tiers, the window, the paging
  and the per-conta loop).
- **The sender and its write-backs** — `enviarEstoque.ts` (the task handler: the
  payload, the valve, the rungs, ONE `update_stock`, the arm table and the
  per-model attribution), `linkEstoque.ts` (the four link writers and the ONE
  clearer), `avisoEstoque.ts` (the clamp aviso and its machine resolver) and
  `shopeeStockTasks.ts` (the Cloud Tasks scheduler).
- **The surfaces** — `enviarEstoqueManual.ts` (the in-process manual push) and
  `enviarEstoqueCli.ts` (the pure half of the `enviar:estoque` rehearsal). Their
  I/O halves live outside this folder: `app/api/marketplace/shopee/enviar-estoque/route.ts`
  and `scripts/enviar-estoque.ts`.

## The design, clause by clause

### The ledger is summable, and step 9 punched a hole in it

The change window is a MAX over the ledger, not a scan of `estoque` rows: ADR
0014's aggregate is what makes "did this family move since the cursor?" one
indexed seek per anchor instead of N document reads. It is correct only where
`movimento` is a signed delta on **every** row, balanços included — a v1 balanço
stored its absolute counted value in the same field, and a sum over those is
silently wrong rather than visibly absent.

⚠️ **Step 9 writes stock with no ledger row at all.** `aplicarEstoqueShopee`
merges an imported quantity straight onto the estoque document, so the aggregate
cannot see it: `anteriores` reconstructs the pair as unchanged,
`deveEnviarFamiliaShopee` answers "nothing moved", and the listing keeps
advertising a number the ERP no longer holds. `estoqueDesauditado`
(`planoEstoque.ts:256`) closes the detectable half — a member whose estoque row
`ultimaModificacao` moved inside the window while the ledger reports nothing is
DROPPED from `anteriores`, so the policy sends — and
`anterioresComDesauditado` (`:291`) is the wrapper every caller must use;
calling `quantidadesAnterioresShopee` directly is the silent mistake, because
that one applies the core's two omission arms and knows nothing about step 9.
How far the hole actually reaches in the real corpus is **register 90**.

⚠️ `desconhecido: true` on a ledger pair means the window is UNREADABLE for
that pair, which is a different fact from "it did not move": the pair is dropped
and the policy SENDS. A pair simply ABSENT did not move, and skipping it is the
whole point of the tier.

### ONE task per ITEM, and why drift still needs a chunker

`update_stock` takes one `item_id` and that item's models in one call, so the
fan-out is per LISTING and the attribution is per MODEL. The planner emits one
`TarefaDeEstoqueShopee` per listing (`planoEstoque.ts:544`), and the natural
cut is the wire's own ceiling, `MAX_MODELOS_POR_TASK` — **imported from the
package, never a typed 50**, because the bound belongs to Shopee.

A listing cannot legally exceed it (guide 219 caps an item at 50 models), so the
chunker exists for DRIFTED link data: `variashopee` documents this app wrote
against a listing that has since changed shape. When it fires it splits into
`parte P / totalDePartes T`, 1-BASED, and emits a `task-excede-limite` row
carrying `modelosAfetados`. Probe **P8** is what makes splitting safe — a
partial `stock_list` leaves the omitted models UNTOUCHED — so one item's models
may travel across calls.

⚠️ `conferirCompletudeDoAnuncio` (`:450`) **THROWS**, and it is checked from
LOCAL counters rather than derived from the result: a chunk DROPPED over the
encoded-body budget and a listing merely SPLIT emit the same row, and nothing in
`pulos[]` distinguishes "those N models are in tasks" from "those N are gone".

⚠️ `modelId: 0` IS the no-model listing and it travels end to end. Never
`if (modelId)`, never a truthiness test, never folded to null — one of those
between the planner and the wire turns a simple item's write into a structure
error. `quantidade: 0` is a real value too, never "no quantity" (probe **P6**
confirmed `stock: 0` is accepted on a BR update, and announcement 1445 is why).

### `error === ''` proves nothing

The page for `error_busi_update_stock_failed` says "please check failure_list",
which means a non-empty envelope `error` can COEXIST with a populated
`failure_list` — two different answers to "what happened" in one body. The
package carries one capability for it, `payloadNoErro` + `ShopeeApiPartialError`,
built ONLY when the operation schema succeeds **and** the envelope carries a
non-empty `error`.

⚠️ **The probe inverted which of the two is the primary path.** P9 sent one good
`model_id` beside a bogus one and got **HTTP 200, `error: ''`, `success_list: 1`,
`failure_list: 1`** — that code never fired. So the sender reads the two lists
off the HAPPY-path envelope first, and arm I stays the documented fallback for
the coexisting-error case the page describes and the sandbox never produced.
Whether it is ever emitted at all is **register 103**'s remaining half.

⚠️ Arm I sits ABOVE the lettered arms in the ladder even though the design table
prints it between H and J. That is forced, not chosen: `ShopeeApiPartialError`
**extends** `ShopeeApiError`, which the lettered arms live inside, so a lettered
position would be unreachable. The same class relationship is why
`ShopeeRateLimitError` and `ShopeeReauthRequiredError` are narrowed FIRST at
every catch site in this folder.

### The floor is a clamp UP, it can be negative, and it is read LAZILY

`faq 59` gives a FLOOR, not a send value:
`Σ seller_stock ≥ total_reserved_stock − Σ shopee_stock`. The send value is the
ERP's own number; the floor only ever raises it, and only when Shopee refuses.
`aplicarPiso` (`reservaPromocao.ts:248`) is the one place that decides a
non-positive floor changes nothing, and `clampado` is true **only when the value
MOVED** — `quantidade === piso` is not a clamp, because nothing was published
above what the ERP holds.

**Σ shopee_stock is proven 0 per CONTA**, by the conta gate: a shop holding
Shopee-warehouse stock is an FBS/CBSC/outlet/multi-warehouse shape and is gated
out before any listing is read. That is what lets the sender subtract nothing
and skip `get_model_list` entirely on this path.

⚠️ **The read is LAZY — on an arm-A refusal, never up front.** Reading
`get_item_promotion` for every planned listing would be 2N calls against a quota
that is **per APP**, shared by every conta and every Shopee call this monorepo
makes; reading it only when Shopee actually complains is N plus the refusals.
The ladder is: refusal → one `get_item_promotion` → `aplicarPiso` per model →
ONE retry of the SAME `update_stock` → a second arm-A refusal is terminal
`piso-de-reserva-nao-atendido`. ⚠️ **The retry's list depends on WHICH of the
floor path's two entries fired**: an ENVELOPE-level arm-A refusal re-sends the
FULL clamped `stock_list` (nothing landed), while a 200 whose `failure_list`
names the floor re-sends **only the refused models** (the rest already landed) —
see the per-model paragraph after the arm table. So
`chamadasShopee` is **0–4**: 1 is the ordinary send, 3 is the floor path, and 4
is a floor path whose clamped re-send was refused by an arm that spends a call
of its own (today only arm G's one `get_shop_holiday_mode` — `pisoJaTentado`
guards arm A, not arm G). Nothing but the floor path reaches 3, so a 3 **or a
4** still says the floor path ran.

Three refinements the seam did not state and the code does:

- an EMPTY floor map after an arm-A refusal is **terminal immediately** — the
  module learned nothing new, and a second identical call would learn the same;
- a floor that moves NOTHING is terminal **without spending the retry**, because
  the retry body would be byte-identical to the call just refused;
- a rate limit or a reauth **during the floor read RETHROWS** rather than going
  terminal: a 429 there is a transport condition, not a verdict about the
  listing, and the queue re-drives the whole task payload-verbatim.

⚠️ `pisoPorModelo` (`:179`) answers an **ABSENT entry** for "no floor", never a
`0` entry, and `model_id 0` is a legitimate KEY. Read it as
`pisos.get(modelId) ?? null`; `pisos.get(modelId) || …` reads a real floor of
zero as absent. Arm A is MESSAGE-matched and **CODE-BLIND** and must stay FIRST,
because one of the four documented floor refusals arrives under `error.param`,
whose stripped form matches nothing in the table.

⚠️ `pisoAcimaDaBanda` (`:301`) is a REFUSAL predicate, never a second clamp:
it records `piso-acima-da-banda` without calling, and never lowers the quantity
to the band. It accepts BOTH spellings of "no band" — `null` and
`Number.POSITIVE_INFINITY`, which is what `opcoesShopee(null)` actually binds.
It has plausibly never fired: probe **P7-pre** measured `stock_limit` absent on
the sandbox category, and no band travels in the v1 task payload at all, so the
motivo has **no producer** by design and an over-band send lands in arm K
carrying Shopee's raw code.

### `min_limit` binds CREATE and probably not UPDATE

Step 11 learned `min 2` from a create REFUSAL, not from the limits page. The
GLOBAL API carries `error_stock_less_then_min_limit`; the shop API carries
neither bound, and the sandbox category declares none at all — so **P7 could not
run** and **register 105** stays open. Nothing in this folder clamps DOWN to a
minimum: the quantity sent is the ERP's, clamped UP or not at all.

### ONE quantity function, two bindings

`quantidadeParaPublicarShopee` (`quantidadeEstoque.ts:124`) is the body that
used to live in `anuncios/montagemAnuncio.ts`, **moved byte-identically**, and
`montagemAnuncio.ts` re-exports it so step 11's importers did not change. The
proof the move was behaviour-free is that the two step-11 suites are
**byte-unedited and green** against the new binding. The promoted core under
`@delfrance/data/admin/estoque` is the same arithmetic ML runs, with every env
default turned into an explicit parameter, and `bulkEstoquePlan.ts` re-exports
it byte-compatibly with its four suites likewise unedited.

⚠️ **ERP kits SEND.** An `ehKit` produto is an ordinary Shopee listing and goes
at its component-derived quantity — the minimum over components, optionally plus
the kit's own stock under `SHOPEE_STOCK_KIT_INCLUI_PROPRIO`. Only a **native
Shopee kit** is skipped, and the predicate for that is `link.kitNativo === true`
and nothing else (`podeEnviarEstoque.ts`, rung 3).

⚠️ **Step 11's publish refusal was wrong and is fixed here.** It keyed
`produto-e-kit` on `produto.ehKit` alone, so thousands of ordinary ERP kits could
not be published at all. The corrected predicate is
`kitNativoDoAnuncio(link, produto)` in `anuncios/montagemAnuncio.ts` —
`link !== null ? link.kitNativo === true : produto.ehKitVirtual === true` — ONE
definition with two producers. ⚠️ **The sweep's rung is deliberately DIFFERENT
and stays link-only**: the sweep only ever runs over rows that HAVE a link, so a
create-side `ehKitVirtual` fallback there would be unreachable code inviting the
create-side rule into a decision the link already owns. Never document the two
as "the same rule".

### The skips are deterministic, and every one names a cause AND a remedy

`MENSAGEM_POR_MOTIVO` (`errosEstoque.ts:195`) is **TOTAL** over the 47 members
and has no fallback, so every refusal renders a pt-BR sentence at the point it
is decided. `apps/web` must not re-word a slug and must not add a second cap —
`limitarMensagemEstoque` is the one, at 500 characters.

⚠️ **Count refusals through `ehRecusa` (`:314`), never by re-listing slugs.**
`clampado-na-reserva` is an ANNOTATION on a SUCCESSFUL send —
`MOTIVOS_QUE_ANOTAM` (`:309`) holds exactly that one member — so reading
`motivo !== null` as "it failed" reports every clamped send as a failure.

The skip set itself is **two mechanisms, `||` between them and `&&` inside the
second** (`podeEnviarEstoque.ts:245`):

- **TIME** — `estoqueRecusaAte`, strict `<`, for a refusal no reading will ever
  lift. Today that is the promotion arm alone: a promotion ending moves no
  `item_status`, so there is no state change to clear it.
- **STATE** — a two-half fingerprint, `estoqueRecusaEstado` against the current
  `estadoAnuncio` **and** `estoqueRecusaItemStatus` against the raw
  `item_status`, both as RECORDED READINGS compared for identity. `undefined` is
  folded to `null` on both sides before either comparison and **nothing else is
  normalised** — not `''`, not the string `'null'`, no trim, no case fold. A
  `.nullable().default(null)` column before its first write looks exactly like
  an absent key, which is the one equality that has to hold; `'pausado'` vs
  `'ativo'` must stay distinct, and two different readings are two different
  facts. ⚠️ **And the STATE half arms only when at least ONE of the two RECORDED
  readings is non-null.** A stamp that wrote down no state at all — the PARTIAL
  writer records `estoqueRecusaEm` and neither half, and `escreverNoLink` is a
  merge — would otherwise meet `null === null` twice on any link whose two
  readings are absent (every link a clean send has just cleared, every step-9
  import that folded an unknown status) and latch `recusa-anterior` with nothing
  left that could move to lift it. So **a partial never arms the skip**, which
  is what its writer's docblock has always claimed; the price is the
  false-negative direction — a terminal refusal on a link with no readings at
  all re-sends once per tick, one call, counted per motivo — against a listing
  that silently stops syncing for ever.

⚠️ Stamp **both** halves on a refusal, exactly as read, `null` included.
Inventing a value arms a skip against a reading nobody took; omitting one leaves
the previous half standing. And `reenviarComErro` / `ignorarRecusa` bypasses
rung 4 and **nothing else** — a removed, banned, in-review, native-kit or
id-less listing still refuses with it on.

### Both spellings of every code, and the dot

Shopee prefixes some codes with their module (`warehouse.error_not_in_whitelist`,
measured on the wire by probe P3) and not others, and `error.param` strips to a
bare `param`. The classifier therefore consults BOTH forms — the stripped one
against the table's keys, the VERBATIM one for storage — and the stripper is a
SECOND lookup that never rewrites `ShopeeApiError.code`.

The arm table (`enviarEstoque.ts:386`) walks **A → K in one declared order**, and
that order is load-bearing three times over:

| arm    | what it is                                                                                                 | what it does (on the ENVELOPE)                                                                    |
| ------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **3**  | ⚠️ NOT a lettered arm — `ShopeeContaNotConfiguredError` at the step-3 context load, before any Shopee call | `descartado` + `conta-nao-configurada`; `lastError` on the STATE doc, **no link write**, no pause |
| **A**  | the reserved floor, MESSAGE-matched and code-blind                                                         | read the floor, clamp UP, retry ONCE (TWO entries — below)                                        |
| **G**  | holiday mode, above every other `error_auth` meaning                                                       | pause the CONTA until the holiday ends, or `pausaFeriasH()`                                       |
| **F1** | a stock location this integração cannot address                                                            | pause the CONTA                                                                                   |
| **F2** | the listing's stock structure is not the one we sent                                                       | terminal per listing                                                                              |
| **E**  | the shop's own shape (five codes + two message needles)                                                    | pause the CONTA, with the slug that says which                                                    |
| **B**  | a promotion holds the listing                                                                              | a TIME skip, `SHOPEE_STOCK_PROMOCAO_RETRY_MIN`                                                    |
| **C**  | models where there are none, or none where there are models                                                | terminal per listing                                                                              |
| **D**  | identity — whose listing is it, does it exist                                                              | terminal per listing                                                                              |
| **H**  | the listing is locked against edits                                                                        | terminal per listing                                                                              |
| **J**  | Shopee's own hiccup                                                                                        | THROW; the queue owns the retry                                                                   |
| **K**  | a code nobody taught us                                                                                    | recorded with the raw code, never retried                                                         |

⚠️ **The first row is NOT part of the A → K walk, and that is why it is spelled
out here.** `ShopeeContaNotConfiguredError` extends `Error` and not the package's
base class, so it can never reach the ladder at all: it is raised by the step-3
context load, which sits above every `try` the ladder owns. Until it was
contained it escaped the dispatched function, the queue re-drove it three times
and dead-lettered it — no `lastError`, no motivo, no row anywhere. It is the
CONTA arms' shape minus the pause: the class plus its message land on the state
document through `registrarErroDaConta`, **nothing at all lands on the link**
(a conta-level condition is not a listing state, so no fingerprint and no
`estoqueRecusa*`), no window is armed (a human clears this, it does not expire),
and every model of the payload is reported `sem-resposta` carrying the motivo.
Resolving is SUCCESS to the queue; the next sweep re-plans the listing once the
conta is configured. Everything else raised at step 3 still RETHROWS — a
`ShopeeConfigError` is a CALLER bug and must never be contained, and an unknown
class is a bug. The manual push cannot reach this arm at all: it supplies its own
`clientFor` and its route loads the context first, and `paraOutcomeDeEnvio` maps
`descartado` + a motivo to `nao-tentado` either way.

The three order constraints, in the code's own words: **A first and code-blind**,
because one floor refusal arrives under `error.param`; **G above E and F1**,
because `error_auth` has five meanings and holiday mode is one of them; and
**E above J**, because `error_server` carries both the FBS refusal and "please
try later", and reading the FBS one as transient retries a conta that
structurally cannot accept the write.

⚠️ **ONE table, TWO consumers.** The same function classifies the envelope's
error and each `failure_list` entry's free-text `failed_reason`, discriminated on
the ACTION rather than on the motivo — three arms act on the CONTA and the rest
on the LISTING. A second copy keyed on the same codes is exactly the drift the
root `CLAUDE.md` names.

⚠️ **…and the "what it does" column above is the ENVELOPE consumer's alone.**
The per-model consumer REDUCES and never ACTS — with exactly ONE exception,
arm A. Every other arm is terminal for that model, with the verbatim
`failed_reason` on the child link. Three consequences a reader must not have to
derive:

- **arm A DOES read the floor there — the floor path has TWO entries.** Probe
  **P9** measured the per-model refusal as the PRIMARY shape (HTTP 200,
  `error: ''`, both lists), so a floor only the error ladder could reach would
  be a floor that, on the measured wire, nothing ever reads. The two entries
  differ in ONE thing, the retry's list: the envelope entry re-sends the FULL
  clamped `stock_list`, the per-model entry re-sends **only the refused
  models**, because the others were already ACCEPTED by the very call that
  refused these — and P8's "a partial `stock_list` leaves the omitted models
  untouched" is what makes the narrow list safe. The one-`update_stock`
  contract reads "one per ATTEMPT"; the envelope entry already spends a second
  one. Entry is gated on at least one `failure_list` line CLASSIFYING as arm A,
  through the same table that names the motivo — an identity refusal such as
  `model ID not exist in sku` buys no promotion read. A failing floor read, an
  empty floor map and a floor that moves nothing all fall back to writing the
  first envelope as it stood: the refused models keep
  `piso-de-reserva-nao-atendido` plus the child diagnostic, the accepted ones
  keep their landing, and the listing is a PARTIAL rather than a listing-level
  refusal. ⚠️ Only in those fallbacks, and on a clamped re-send refused a second
  time, is that motivo final — and only then does its rendered sentence
  (refused _even when raised to the floor_) describe what happened; read the
  stored `estoqueRecusaCodigo` beside it either way;
- **the CONTA arms pause nothing there** — they reduce to their own slug on the
  model's row;
- **only the MESSAGE needles are reachable there.** The free text is handed in
  as the code as well, so `nu` is the whole sentence and anything a needle
  gates on a CODE (arm D's `error_param` ∧ `repeat|wrong model_id`, arms F1/G's
  `error_auth` pairs) can never fire per model. That is why the one per-model
  reason the probe measured — `model ID not exist in sku` — has its own
  code-blind needle in arm D.

### Burst is a re-enqueue; daily is a clock

A **burst** rate limit becomes a delayed self re-enqueue that **consumes no
attempt** — the mass import's precedent, not ML's rethrow — with
`SHOPEE_STOCK_RATE_PAUSE_MIN` plus a jitter, capped by
`SHOPEE_STOCK_MAX_PAUSE_REENQUEUES`. The **daily** quota is pure arithmetic: the
pause runs to the next 00:00 UTC+8 rollover, taken from the imported
`proximaViradaDaCotaMs`, and there is no knob.

A conta block is a **24-hour pause, not a latch** (`estadoEstoque.ts:262`):
no human clearer exists, and one call per conta per day is the entire cost of
being wrong. `estaPausada` (`:231`) is a strict `>`, deliberately — the send
task re-enqueues for exactly `pausadoAte`, and `===` as still-paused would spend
a second re-enqueue on nothing.

⚠️ `pausaLojaH()` and `pausaFeriasH()` already answer **MILLISECONDS** while
`PAUSA_LOJA_H` / `PAUSA_FERIAS_H` hold hours — write `nowMs + pausaFeriasH()`
and stop. `ratePauseMin()` and `promocaoRetryMin()` ARE minutes and the sender
converts them in one named place. You cannot even spell the hour multiplier in
this folder; the grep bans it.

⚠️ The pause arms write **only** `armarPausa`. They deliberately do NOT call
`registrarMotivoDaConta`, which also stamps `lastSweepAtMs` — a field the SWEEP
owns, and a sender moving it would tell a monitor the conta was freshly swept
when it was not. The per-slug distinction therefore survives in `pausaCodigo`
and in the log line, and `ultimoMotivoConta` has no writer on the send path.

⚠️ `scheduleDelaySeconds` is proved **forwarded** and proved **honoured
nowhere**: the tasks emulator ignores it (firebase-tools#8254), so neither the
pause rung nor the burst arm has ever produced an actual delay in any test
(**register 121**).

### The manual push force-sends, and announcement 1445 is why

Both surfaces pass `ignoreSyncFlag: true`, so the master valve does not gate
them: the operator asked explicitly, and the button has to work before the
automatic sync is switched on. The queue handler must **never** set it — two
independent pins, on the built deps object and on the comment-stripped source
text, both of which would have to be deleted deliberately.

The same announcement is why the monthly reconciliação tier ships **ON with no
flag of its own**: Shopee returns stock by itself when an order is cancelled,
and that drift leaves **no ledger row**, so no incremental window can ever see
it. Keeping the number right is an obligation, and its blast radius is bounded
by `SHOPEE_STOCK_MAX_TASKS_PER_SWEEP` alone.

**The two surfaces diverge in exactly one behaviour, and it is deliberate.** The
route answers **409 `SHOPEE_CONTA_PAUSADA`** before any provider call — that
saves calls on a screen. The CLI **REPORTS** the pause and proceeds, because
inspecting a paused conta is what a dry run is for, and under `--live` the
refusing scheduler turns it into per-listing `nao-tentado` rows carrying
`pausadoAte`, which says more than one refusal. The two still agree on the EXIT
CODE, which is the thing a caller can depend on.

Three residuals of the manual path, recorded rather than fixed:

- `bandaPorItem` (`enviarEstoqueCli.ts:440`) is an OPTIONAL plan input with **no
  producer today** — resolving a real band would need one `get_item_limit` per
  listing — so the `banda` clamp arm has never run outside a fixture and the
  plan's `banda` column reads `—`;
- `produtoNome` costs **up to 50 document reads per manual request**, one per
  requested id, in parallel and unmeasured. It is step 11's `nomeDoProduto`
  precedent; a batched `getAll` would be one round trip, but the shared test
  double has no such member;
- `MENSAGEM_ENVIO_LIMPO` (`enviarEstoqueManual.ts:230`) is the ONE sentence
  outside `MENSAGEM_POR_MOTIVO`, for `motivo === null` only — that map is a
  vocabulary of refusals plus one annotation and deliberately has no member for
  "it worked".

⚠️ The manual push's concurrency is **clamped by the queue's own knob**:
`Math.max(1, Math.min(manualConcurrencyRaw(), concurrentDispatches()))`
(`enviarEstoqueManual.ts:308`). So `SHOPEE_STOCK_CONCURRENT_DISPATCHES` has two
homes — the deploy shell and the App Hosting console — and they must agree.

### An absent `estadoAnuncio` is VIVO

`anuncioShopeeVivo`'s rule, verbatim: a link whose `estadoAnuncio` was never
written reads as LIVE, not as dead. The alternative fails silently in the
expensive direction — a listing that is live at Shopee and reads as dead here
stops being sent and advertises a stale quantity for ever, which oversells. The
six motivos the gate can answer are `sem-item-id`, `anuncio-removido`,
`anuncio-banido`, `anuncio-em-revisao`, `kit-derivado` and `recusa-anterior`,
and nothing else.

⚠️ `em_revisao` REFUSING and `pausado`/`agendado` SENDING are **design bets on
negative wire evidence**: `update_stock`'s error list carries no "item is
unlisted" refusal, and the guide names deletion rather than unlisting. If a live
shop refuses, the cost is bounded by construction — the refusal arms the
fingerprint, so it is one call per listing per state change, not one per tick.

⚠️ `{ enviar: true }` means "worth asking Shopee", never "Shopee will accept it".
The provider's `failure_list` is the authority and refuses things this gate
cannot see, a promotion lock above all.

### The state doc is `.merge`-only and holds ONE gate field

`estoqueShopeeSync/{integracaoId}` (`estadoEstoque.ts:198`) is read RAW —
`snap.data()` plus `typeof` narrowing, the `notificacoes/orderBackfill.ts`
precedent — and never through `parseRead`, which is SOFT (it returns the raw
object anyway) and would log a warning every tick for a malformed `continuacao`
this module deliberately TOLERATES: that reads back as `null` and the tick
derives its own window. `changedSinceMs: -1` and `movimentosDesdeMs: null` are
LEGAL values, not damage.

Every write is `.merge` (an upsert), never `mergeIfExists`: a conta's first tick
has no document, and the nested `continuacao` object would additionally throw.
`existe: false` (no document) and `existe: true` with all nulls (a partial patch
created it) are different facts and are reported differently.

⚠️ `carimbarVarredura` (`:381`) is the ONLY way to close a tick — build the
union member, never hand-write a patch. `truncada` advances **nothing**; the
incremental cursor is the tick's `startedAtMs`, never `nowMs`; and the diário
and reconciliação tiers never touch `cursorMs` at all.

⚠️ A stored `continuacao` **WINS**. A tick that finds one runs ONLY it — its own
window waits for the next tick — and it stamps the FROZEN mode's field. Draining
the continuation and then doing your own window too is two sweeps of pages in
one tick, and it makes both caps meaningless.

The tiers, the windows and the slots:

| tier          | cron                  | window                                                                                                                |
| ------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| incremental   | `10,25,40,55 * * * *` | no cursor ⇒ `now − INCREMENTAL_WINDOW_MIN − overlap`; a cursor ⇒ `max(cursor, now − CURSOR_MAX_LOOKBACK_H) − overlap` |
| diário        | `10 2 * * *`          | `now − DAILY_WINDOW_H`, **no overlap**                                                                                |
| reconciliação | `10 3 1 * *`          | `changedSinceMs: -1`, no ledger pre-pass at all                                                                       |

⚠️ The **incremental tier skips its own 02:10 and day-1 03:10 slots IN CODE** —
a cron cannot express the exclusion, so the wrapper asks `ehSlotDoDiario` /
`ehSlotDaReconciliacao` (`varreduraEstoque.ts:311`, `:320`) off the tick's ONE
clock read. Those predicates ask `Intl` for `America/Sao_Paulo`, and they assume
Brazil has no DST — true since 2019.

⚠️ The **diário window's lack of an overlap is deliberate and vetoable**
(**register 118**): the frozen seam writes it that way and the ML template
subtracts one there too. The residual is a cron-jitter-sized sliver at the far
edge of a 24-hour window, which the quarter-hourly tier re-covers.

### The conta gates are an optimisation; the sender's ladder is the correctness

`avaliarContaParaEstoque` (`contaEstoque.ts:330`) runs ONCE per conta per tick,
before discovery, and answers in a fixed order that is itself pinned: no
`shop_id` ⇒ `sem-shop-id` (zero provider calls); a blank `depositoOuterRef` ⇒
`sem-deposito` (zero calls); then `get_shop_info` (banned/frozen, FBS, CBSC,
outlet), then `get_shop_holiday_mode` (FULL only), then `getWarehouseDetail` (a
NON-EMPTY list ⇒ `multi-armazem`). Three `createReadCache`s sit behind it —
shop-info and warehouse at `READ_CACHE_TTL.config`, holiday at `.volatile` — all
keyed on `integracaoId` FIRST, and the Shopee client is built lazily inside the
load closures so a fully warm tick loads no context at all.

⚠️ **Do NOT re-check any of these five rungs in the sender or in the manual
push.** The gates save calls; the error ladder is what is correct. A provider
failure there **propagates** — there is no `catch` in the module — because
swallowing one into a verdict would report a silent outage as a refusal with a
rendered pt-BR message.

⚠️ `contaAceitaEstoqueShopee` (`:261`) is the ONE place that decides what FBS
means, and it is a hand-rolled trim + lowercase comparison against exactly
`pure - fbs shop`. **`Others - Unknown` SENDS**, and so does a null or an absent
flag — the ordinary BR shape. Never widen it to an allow-list of the other five
values and never read `is_cb` / `is_sip` as a proxy. An undocumented SEVENTH
value logs its own line; an absent flag logs nothing, because one line per conta
per tick would drown the two that matter. ⚠️ That comparison is invisible to
`equivalence-fold-inventory` by that rule's own measured design, so BOTH
directions are pinned by tests here instead.

⚠️ An EMPTY warehouse list is the NORMAL path: `sem-multi-armazem` and a
zero-row `lista` both SEND, and ONE row already refuses, because `faq 61` wants
every `location_id` in one call and this ERP binds ONE depósito per conta.

⚠️ `sem-shop-id` is COUNTED and **never written to the state doc**; every other
verdict becomes the `ultimoMotivoConta` the sweep stamps.

### Nothing here reads a clock

The clock is a PARAMETER: `deps.nowMs` is the tick's or the request's ONE
logical instant, `deps.agora()` is the ELAPSED reader (never `nowMs`) and
`deps.esperar(ms)` is a wait. One read per tick or per request, threaded through
the window, the gates' cache expiry, the skip set, the task payload's
`sweepComputadoEmMs`, every stamp and half of the `sweepId` — a second read
anywhere makes two listings in one sweep straddle an expiry.

Where the ambient clock and `next/server` ARE allowed: the route
(`app/api/marketplace/shopee/enviar-estoque/route.ts`, which reads the wall
clock exactly once and builds `agora` and `esperar` from it), the
CLI shell (`scripts/enviar-estoque.ts`) and the nested functions codebase
(`apps/shopee/functions/src/`). A `*.tasks.test.ts` needs the wall clock and is
excluded from the greps by suffix.

⚠️ **Every stamp in this folder is MILLISECONDS.** There is no microsecond
anywhere — no site, no converter, no reader — and `apps/shopee/CLAUDE.md`'s µs
list stays at eight. The ms → µs crossing the clamp aviso needs lives in
`../avisos/autorizacao.ts`, OUTSIDE this folder, and the grep bans the converter
names here, comments included.

### The write-backs: eleven parent fields, three on the child, ONE clearer

`CAMPOS_DO_PATCH_DE_ESTOQUE` (`linkEstoque.ts:124`) is the eleven-name list, and
`registrarEnvioLimpo`'s patch is typed TOTAL over it — so a twelfth name added
to the list alone, or a field written but not listed, is a COMPILER error in
both directions before any test runs.

⚠️ **`registrarEnvioLimpo` is the ONLY clearer.** Call it only when every model
Shopee answered about was accepted. A partial goes to `registrarEnvioParcial`,
which writes SEVEN keys and — deliberately — **no `estoqueEnviadoEm` and no
fingerprint**: that field means "the last time this listing was FULLY in sync"
and is the anchor child visibility compares against, so stamping it would make
every child row the same send just wrote read as stale the instant it landed.

⚠️ **CLEAN requires zero refusals AND zero `sem-resposta`.** A model in NEITHER
list is an absence of evidence; calling it clean would run the one clearer over a
refusal fingerprint that is still live, so it routes to the partial writer and
the next tick re-sends (**register 122**, a design bet).

⚠️ Every patch is FLAT and scalar-only, enforced twice — the TypeScript types
reject a nested object or an invented name, and `mergeIfExists` throws a real
`TypeError` on a nested plain object or a dotted key. `mergeIfExists` is also
what stops a deleted link being resurrected as a ghost holding only these eleven
keys and none of the schema's required ones; all four writers resolve `false`
rather than throwing when that happens.

`codigoDoErp` (`:284`) is the ONE producer of the `erp:<motivo>` spelling. Never
re-type that prefix at a call site: the field is a loose string no reader parses
today, which is exactly how one fact ends up stored as `erp-`, `erp/` and `erp:`
in one collection with nothing failing.

⚠️ **The ACCEPTED split-listing race.** Parts of one listing are independent
tasks, and each write-back is a full overwrite of the same eleven parent fields,
so two parts race on the parent's **diagnostics only**. Stock is never lost —
each part is payload-verbatim at Shopee — and the child diagnostics are per
model. The sharp edge is that a CLEAN part clears a fingerprint a REFUSED part
just wrote; the next tick re-derives both halves, and nothing here is read back
to decide what to send. A per-part fingerprint is a follow-up if the
pathological case is ever observed (**register 117**).

### The clamp aviso, and the only thing that closes it

`avisarEstoqueAcimaDoDisponivel` (`avisoEstoque.ts:119`) fires once per clamped
task, for the widest gap, keyed on **(conta, the MODEL's produto)** —
`chaveEstoqueAcimaDoDisponivel` (`:72`), with **no `janela`** — and it renders
three number-valued params and nothing else: `anuncio`, `reservado` (the floor),
`disponivel` (what the ERP holds).

⚠️ **The resolver is a SEND, not a sweep.** `resolverEstoqueAcimaDoDisponivel`
(`:179`) runs on the non-clamp path of a successful send of the same produto,
and **nothing else closes that row** — an unresolved aviso stands until the
90-day retention sweep on a `serverOwned` collection with no dismiss button. Do
NOT resolve on a refusal, a skip or a rate limit: those are the ABSENCE of an
observation, not evidence the clamp stopped. It runs once per DISTINCT
`produtoId` of the task, because a single call keyed on the anchor would never
close a row raised for a child — cost is up to N transactions on a clean,
unclamped family send (**register 119**, unmeasured).

## Folder discipline

Six raw-text greps must stay EMPTY under
`apps/shopee/lib/shopee/estoque/*` (source files; comments and docblocks
INCLUDED, so state a prohibition without spelling the banned name): the
multi-document atomic-write API's own name; the ambient clock and the
`next/server` import; the shared equivalence-fold helpers; the package's UNLIST
batch cap; and the hour/day millisecond literals.

⚠️ **This FILE is a seventh exemption, and it has to be excluded explicitly.**
The greps are scoped to `estoque/*` and exclude only `*.test.ts`, so a README
that documents what is banned is itself a hit — the raw-text trap the folder has
now sprung four times. Every command below therefore carries
`':(exclude)*.md'`, and the canonical six in the wave-3 context need the same
token added before they can be run against this folder.

⚠️ **The sixth, `.collection(`, carries ONE documented exemption** — and it is a
Pipelines SOURCE stage, not a raw Firestore handle. The SDK's `PipelineSource`
offers only `collection` / `collectionGroup` / `database` / `documents`, there is
no pipeline surface on a `defineAdminCollection` handle, and ML's
`bulkEstoquePlan.ts` carries the identical `eslint-disable`. A computed
`db.pipeline()['collection'](…)` would satisfy the regex while defeating the
guard, which is precisely the anti-pattern the raw-text discipline exists to
prevent. So the exemption is granted ONCE, in one centralised thunk
(`descobertaEstoque.ts:162-163`), and the verification is two commands rather
than one:

```bash
# 1. every other file in the folder must be clean
git grep -n "\.collection(" -- 'apps/shopee/lib/shopee/estoque/*' \
  'packages/data/src/admin/estoque/*' ':(exclude)*.md' \
  ':(exclude)apps/shopee/lib/shopee/estoque/descobertaEstoque.ts'
# 2. and the exempted file must hold EXACTLY ONE hit
git grep -c "\.collection(" -- 'apps/shopee/lib/shopee/estoque/descobertaEstoque.ts'
```

Every document addressed **by id** still goes through `produtoCollection.docRef`
or the typed link handles, including in the tests: that grep carries no
`:(exclude)*.test.ts`, so writing a diagnostic the obvious way would make the
verification the first violation. The two `collectionGroup` sources — one of
them the correlated subquery — carry their own one-line exemptions at
`descobertaEstoque.ts:247` and `:674`. **Two exemptions, two anchors**: there is
no third source.

Two more rules the folder holds by construction:

- **ZERO new Firestore indexes** (ruling C-p). S1 rides
  `produtos(paiId, integracoesComProduto, __name__)`; the `estoques` joins and
  the ledger aggregate ride existing collection-group entries; and the two link
  probes carry **no `where` at all**, so there is no index to ride and none to
  miss. ⚠️ On Enterprise a missing index does not throw — it full-scans and bills
  the scan — so the reversal condition is written down rather than assumed
  (**register 112**).
- **No multi-document atomic write anywhere in this folder.** Every write is a
  `merge`, a `mergeIfExists` or a `FieldValue.increment`, so no row is owed in
  `firestore-transaction-inventory.test.js` — and that API may not be NAMED in a
  source file here either, comments included, which is the `orderBackfill.ts` /
  `liquidacaoSweep.ts` rule.

## Out of scope, on purpose

- **Publishing or creating a kit ON Shopee** — step 19. A native kit is
  `kit-derivado` here and nothing is sent for it.
- **The produto tab and the operator surface in `apps/web`** — step 21. The only
  UI this step feeds is the aviso row and the `enviar-estoque` route.
- **`batch_update_outlet_stock`** — outlet shops only, and an outlet conta is
  gated out.
- **`v2.global_product.update_stock`** — CNSC/KRSC only; a CNSC shop that has
  not migrated is gated out with its own slug.
- **`push 5 / 7 / 8 / 9`, the reserved-stock churn stream.** `push 8` really
  does carry the exact reserved delta, and step 12 still declines it: it is per
  model and chatty, and reading the floor lazily on a refusal costs less than
  ingesting the stream.
- **`location_id`, in any form.** There is one `depositoOuterRef` per conta, so
  there is nowhere to store a map; a multi-warehouse conta is gated out instead,
  and a location on one entry and not on another is a structure error Shopee
  makes sticky.
- **A web dialog for the manual push.** The route exists; the screen is step 21's.

## What is UNVERIFIED and what settles it

The settle-live register for step 12 is **items 90–122**, and the authoritative
table — same numbers, same statuses — is the Built-12 bullet in
`.master_plans/shopee/shopee-marketplace-integration.md` §4. None of them is a
gate. In short:

- **Settled by the sandbox probe of 2026-09-21**: 94 (`update_time` does not
  move on a stock write), 95 (no promotion ⇒ an EMPTY array; the field POSITION
  is still open), 96 (the `update_stock` echo equalled the read-back, and the
  read-back stays the authority), 103 (partial failure = both lists on an
  `error: ''` envelope; that changed which path is primary), 104 (a partial
  `stock_list` preserves the omitted models), 106 for PARTIAL holiday only, plus
  the three the probe itself raised — 114, 115 and 116.
- **Needs a BR shop with a live Seller Discount, and is not rehearsable in the
  sandbox**: 107 (the three promotion hard-block codes), 108 (the floor's
  boundary, `≥` vs `>`, and SIP P), 110 (whether BR shop-level multi-warehouse
  exists at all).
- **Needs a second sandbox run**: 105 (`min_limit` on an UPDATE — the category
  used had no band), the FULL half of 106.
- **Needs a staging measurement, orchestrator or Lucas only**: 90 (how far step
  9's ledger hole reaches), 111 (the scan cost of the two correlated MAX
  aggregates — the build-phase gate), 112 (whether the four indexes are
  DEPLOYED, not merely declared), 113 (whether any produto carries more than 50
  `variashopee` docs).
- **Settled only by the first deploy, and it is migration-window work** (root
  `CLAUDE.md` rule 8, never an agent): 92 (Cloud Scheduler / Cloud Tasks
  enablement for three new schedules and a third queue).
- **Design bets and recorded residuals, all visible in code**: 117 (the accepted
  split-listing race), 118 (the diário window's missing overlap), 119 (the aviso
  resolver's cost), 120 (`deps.retryCount` is logged with no consumer), 121 (the
  tasks emulator ignores `scheduleDelaySeconds`), 122 (a model in neither list
  routes to the partial writer).
- **The manual push's deadline is per LISTING, not per request**: the budget is
  checked between listings, never during one, and the transport sets no fetch
  timeout, so a hung call inside the last listing is unbounded — the 180 s
  `timeoutSeconds` in `apps/shopee/apphosting.yaml` is headroom for its two
  ladder attempts, not a bound.
- **Open questions with no owner yet**: 97 (the real burst ceiling and daily
  quota, per APP — a support ticket), 98's third `promotion_id: wireInt()` site
  on live order-import traffic, 100 (a shared `pool.ts`), 101, 102, 109 (a kit
  `item_id` on `update_stock` — step 19's probe), 93 (the preflight path
  binding).

Two further things nothing in this folder can settle, and both are FINDINGS
rather than open questions:

- **`contaNaoConfigurada` has no producer.** `ShopeeContaNotConfiguredError`
  extends `Error` rather than `ShopeeError`, and the client is built outside any
  try, so a misconfigured conta throws out of the dispatched function into the
  queue's three-attempt ladder and dead-letters instead of being filed as a
  listing refusal. The options are to narrow that class at the client step, to
  drop the member, or to keep it for a future conta-screen writer.
- **`pisoAcimaDaBanda` has no producer either, BY DESIGN** — no band travels in
  the v1 payload.

Both are authorised, with a one-line reason each, in `motivosProduzidos.test.ts`,
which walks all 47 members and **fails the day either gains a producer while
still on that list** — so the allow-list cannot rot in the direction that
matters. Every other member of `MOTIVO_ESTOQUE_SHOPEE` and all four
`MOTIVOS_DE_PAUSA` have a real producer today.
