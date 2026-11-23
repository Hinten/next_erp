# Loja Integrada stock sync (master plan step 12)

The stock sync pushes the ERP's sellable quantity of every LINKED store CHILD to that product's
stock row in Loja Integrada: one `PUT /v1/produto_estoque/{produto id}` per child, through the
write engine (`../core/escrita.ts`), with four leaves — managed, the quantity, and the two fixed
situações (lead times are overwritten by design). Never a parent's row, never a batch: the store
has no batch stock route.

It ships INERT. The stock valve `LOJA_INTEGRADA_MODO_ESTOQUE`, its canary list and the read switch
`LOJA_INTEGRADA_CHAMADAS` are unset today, so every trigger event, send run, fan-out and reconcile
slice returns with zero reads. Before the migration window the valve may be set to `dry-run` and to
nothing else (the staging measurement path, section 13); the canary list and the switch stay unset.
No test can call the store: this app's two vitest setups make a `fetch` to any non-local host
throw, the suites that script the store pass a `deps.fetch`, and in the emulator lane a dispatched
send run or reconcile store phase stops at the read switch while the fan-out makes no store call
at all (section 14). The package's wire tests (`packages/integrations/loja-integrada`) inject or
stub their own `fetch`.

This file is the reference. The rules an agent must not break before touching stock code are the
short list in [`apps/loja-integrada/CLAUDE.md`](../../../CLAUDE.md), "Stock sync (step 12)". Also:

- the daily FULL reconcile in depth: [`reconcile/README.md`](reconcile/README.md);
- deploy, IAM, the runtime env block and the operator notes:
  [`functions/DEPLOY.md`](../../../functions/DEPLOY.md);
- the wire (the stock row and detail schemas, the page reader, the one strict stock write route):
  [`packages/integrations/loja-integrada/README.md`](../../../../../packages/integrations/loja-integrada/README.md);
- the web provider of the shared "enviar estoque" dialog:
  [`apps/web/lib/marketplace/estoque/README.md`](../../../../web/lib/marketplace/estoque/README.md);
- the step's plan text:
  [the master plan](../../../../../.master_plans/loja-integrada/loja-integrada-marketplace-integration.md),
  step 12 (issue #1823).

## 1. The pipeline at a glance

```text
 ERP stock write  produtos/{p}/estoques/{e}
        │
        ▼
 onEstoqueLojaIntegrada  (functions trigger; its first two gates read nothing)
        │ estoque (evento | kit), estoque-kits
        ▼
 filaEstoqueLojaIntegrada  (the stock queue, single-file)
   ├─ estoque      → processarEstoque.ts → core/escrita.ts → PUT /v1/produto_estoque/{id}
   │                   └─ a drift on read-back → ONE estoque (deriva) back onto this queue
   └─ estoque-kits → processarKitsEstoque.ts → estoque (kit) per kit at 0, at slot instants
        ▲                                    ▲
        │ estoque (reconcile),               │ estoque (manual)
        │ at slot instants                   │
 filaLeituraLojaIntegrada  (the reads queue) │      App Hosting backend
   └─ estoque-reconcile slices:              └───── POST …/enviar-estoque
        erp → li → fila → fim  ◄─────────────────── POST …/conta/[id]/estoque/reconciliar
        ▲              ▲
 nightly 04:23 SP      conta trigger's depósito arm (and a release's depósito re-run)
```

**Who enqueues what:**

| Producer                                       | Identity               | Queue | Task                                             | Named by                                   |
| ---------------------------------------------- | ---------------------- | ----- | ------------------------------------------------ | ------------------------------------------ |
| The stock trigger                              | functions runtime SA   | stock | `estoque` (`evento` or `kit`), `estoque-kits`    | the clock's minute window                  |
| The kit fan-out (`estoque-kits`)               | functions runtime SA   | stock | `estoque` (`kit`)                                | the FAN-OUT's own window, at slot instants |
| A send run's read-back                         | functions runtime SA   | stock | `estoque` (`deriva`, generation 1)               | the clock's minute window                  |
| The reconcile's queue phase                    | functions runtime SA   | stock | `estoque` (`reconcile`, with the run's depósito) | the RUN's window, at slot instants         |
| The manual push (`POST …/enviar-estoque`)      | App Hosting runtime SA | stock | `estoque` (`manual`)                             | the clock's minute window                  |
| The nightly start, the depósito arm, a release | functions runtime SA   | reads | `estoque-reconcile` seq 0                        | `li-<execucaoId>-<seq>`                    |
| A slice's hand-off                             | functions runtime SA   | reads | `estoque-reconcile` seq + 1                      | `li-<execucaoId>-<seq>`                    |
| The operator's reconcile route                 | App Hosting runtime SA | reads | `estoque-reconcile` seq 0                        | `li-<execucaoId>-<seq>`                    |

The `publicacao` origin is reserved for a publish (step 11, not built), which will enqueue a send
and compute no stock of its own.

## 2. Files

Stock code lives under `lib/lojaIntegrada/estoque/`, Next-free, `db` a parameter, the environment
passed in (`deps.ambiente`); the functions codebase binds it.

| File                      | Role                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `processarEstoque.ts`     | ONE send run: one child produto of one conta, through the write engine only.                                                  |
| `leituraEstoqueErp.ts`    | The send run's ERP reads; every query built from the field constants its index-pin test reads.                                |
| `agendadorEstoque.ts`     | The pure stock-queue producer: window, name, schedule, the strict parse before anything leaves.                               |
| `avisosEstoque.ts`        | The send run's one aviso, `lojaIntegradaEstoqueRecusado`.                                                                     |
| `quantidadeEstoqueLi.ts`  | The channel's binding of the shared quantity core (`@delfrance/data/admin/estoque`): S, model A's target, the four-leaf body. |
| `planoEstoqueLi.ts`       | The pure decisions: the send, the trigger's relevance, the run's plan, the kit filters, the reconcile's row diff and order.   |
| `configEstoqueLi.ts`      | A leaf: the cap, the eager kit ceiling, the reconcile's page size, read from the passed environment.                          |
| `gatilhoEstoque.ts`       | The stock trigger's work, IO injected.                                                                                        |
| `depositosLi.ts`          | The trigger's cached map of the contas' depósitos.                                                                            |
| `mapaKitsLi.ts`           | The kits map's READ side, and `tarefaDoKitLi`, the one kit send task both kit producers build.                                |
| `processarKitsEstoque.ts` | The `estoque-kits` fan-out.                                                                                                   |
| `slotEstoqueLi.ts`        | The ONE global stagger slot of the bulk sends.                                                                                |
| `envioManualEstoqueLi.ts` | The manual push's core (PR 12-h).                                                                                             |
| `contaDoEstoqueLi.ts`     | The operator routes' uncached conta gate (PR 12-h).                                                                           |
| `reconcile/`              | The daily FULL reconcile: [`reconcile/README.md`](reconcile/README.md).                                                       |

Elsewhere in the app:

- `functions/src/filaEstoque.ts` (`filaEstoqueLojaIntegrada`), `functions/src/agendadorEstoque.ts`
  (the stock producer's functions root, through the reads root's region and valve readers),
  `functions/src/depsEscrita.ts` (`depsDeEstoqueLi` spreads the writes run's deps, so the two
  write queues cannot disagree on the environment, the clock, the pacer's sleep or the write
  deadline; `depsDeKitsEstoqueLi` takes only the environment, the clock, the attempt and the
  producer from it — no pacer, no deadline: the fan-out makes no store call),
  `functions/src/onEstoqueLojaIntegrada.ts` (the trigger),
  `functions/src/reconciliarEstoque.ts` (the nightly start), `functions/src/depsReconcileEstoque.ts`,
  the `estoque-reconcile` arm of `functions/src/filaLeitura.ts`, the reconcile producer root in
  `functions/src/agendador.ts`, and the depósito-change arm of
  `functions/src/onIntegracaoLojaIntegradaChanged.ts`;
- `lib/firebase/filasLi.ts` (the App Hosting producer root of the stock and reads queues),
  `app/api/marketplace/loja-integrada/enviar-estoque/route.ts` and
  `app/api/marketplace/loja-integrada/conta/[id]/estoque/reconciliar/route.ts`.

In `packages/schemas/src/`: `tarefaEstoqueLojaIntegrada.ts` (the task payloads),
`sincEstoqueLojaIntegrada.ts` (the per-conta documents), `reconcileEstoqueLojaIntegrada.ts` (the run
document), `estoqueErpLojaIntegrada.ts` (the ERP readers the sync and the read-only counts audit in
`tools/migrations` share, #2163), `estoqueManualLojaIntegrada.ts` (the two routes' request and
answers, shared with the web) and `aviso.ts` (the three stock aviso tipos). The web provider is
`apps/web/lib/marketplace/estoque/providers/lojaIntegrada.ts`.

## 3. The data

### 3.1 Task payloads (`tarefaEstoqueLojaIntegrada.ts`)

Three tasks, every object STRICT and **ids only**: what a PUT sends is derived when the task RUNS
(S from the ERP then, the store's reservation from a fresh read just before the PUT), so a
quantity — or any key the schema does not name — fails the parse, and a task that does not parse
is dropped by its queue with one log line (`tarefaEstoqueLojaIntegrada.test.ts` pins it).

- `estoque` (stock queue): one send run for one child produto of one conta. Its `origem` is one of
  `evento` (the trigger), `kit` (the trigger's eager kit sends, or the fan-out), `reconcile` (the
  daily reconcile's diff), `manual` (the operator's push), `publicacao` (a publish, step 11) and
  `deriva` (the one follow-up a read-back enqueues; `geracao` 1, never re-enqueued). `evento`,
  `manual`, `publicacao` and `deriva` are read back after the PUT; `kit` and `reconcile` are bulk
  origins, read back by the next day's list walk. A kit send carries the components' record ids
  (`estoqueIds`); `depositoId` rides EXACTLY on `origem: reconcile` (the depósito its run diffed
  at).
- `estoque-kits` (stock queue): the fan-out of ONE component with more store kits than the eager
  ceiling.
- `estoque-reconcile` (READS queue): one slice of the daily reconcile, `{ execucaoId, seq }`.
  Deliberately not a persisted notification `tipo`: never persisted, re-driven or parked.

⚠️ Strict cuts both ways: a field a later step adds ships to the CONSUMER (the functions codebase)
before any producer sends it, or the tasks in between are dropped.

### 3.2 Per-conta sync documents (`sincEstoqueLojaIntegrada/{conta}`)

ONE top-level root per conta (doc id = `integracaoId`) and three subcollections. Admin-only: bare
schemas outside `ALL_DOMAINS`, no Meta, so no rules block and no client access; unknown keys are
stripped. Every stamp is in MILLISECONDS and says so (`…Ms`).

- **The root**: `reconcile { offset, limite, iniciadoEmMs }` (the store list walk's resumable
  cursor), `ultimoReconcile` (the counters of the last finished run), `execucao` (what ONE run
  keeps for the conta across its slices: the depósito it fixed at the take, the store ids its walk
  has `vistos`, the aviso `amostras` — at most 200 ids per reason — and the kits map writer's
  cursor `mapa`).
- **`snapshot/{'00'..'31'}`**: one entry per store product id the ERP side knows, bucketed by the
  id modulo 32 (about 50 bytes an entry, so no document approaches 1 MiB). An entry is `p` (the ERP
  child; `null` exactly for `x`), `s` (S, floored and clamped at 0 only — the cap is applied at diff
  and send time, never stored; present exactly for `v`), `f` (the flag), `k` (a kit), and on a valid
  kit `q`/`e` (each constraining component's quantity in the kit, and the record id it resolved to
  at the depósito). Flags: `v` valid, `r` held (never had an ERP stock record at ANY depósito),
  `par` parity (`enviarEstoque === false`), `amb` ambiguous (two counting child links, or two
  non-canonical records at the depósito), `dup` (one store id linked from two ERP produtos), `ns`
  (a shape the step does not send), `x` (a store row no link names, cached so the lookup is not
  repeated daily). **Only `v` is ever a send candidate.**
- **`snapshot/pais`**: the store ids of the parent products, whose rows are never sent.
- **`kits/{componente}`**: for one ERP component, the store-linked kits containing it — `F` (how
  many), `qMax` (its largest quantity in any of them), `comps` (every component of those kits →
  its stock record id at the depósito), `kits` inline when `F` ≤ 30, else in shards.
- **`kitsFatias/{componente}~{n}`**: those shards, at most 1,000 kits each. A subcollection of
  their own because a produto id may itself end in `~0`.

⚠️ **Nothing here is ever SENT.** The snapshot and the kits map are PRE-FILTERS: they decide which
children are worth a send run, never what that run sends, so a stale entry can only waste one store
read or miss a change until the next daily reconcile — never write a wrong number.

### 3.3 The run document (`reconcileEstoqueLojaIntegrada/atual`)

ONE top-level document: the reconcile's lease and progress (`execucaoId`, `iniciadoEmMs`, the lease
`emExecucaoAteMs` — one hour past each write —, `seq`, `fase`, `contas`, `idxConta`, `walk`,
`candidatos` under a 600 000-byte budget, the counters `c<idx><Nome>`) and the global stagger slot
`proximoSlotMs`. The reconcile's use of it is [`reconcile/README.md`](reconcile/README.md); the slot
is section 8 below. ⚠️ Never delete the document: it holds the slot.

### 3.4 Writers (root `CLAUDE.md` rule 7)

- The **lease-holding reconcile slice** writes the run document and every per-conta document, ONE
  batch per checkpoint on its own read's `lastUpdateTime` (tier 1): the run document
  `update(patch, { lastUpdateTime })`, advance-only; a root, a bucket or `pais` `create`d when
  absent, else `update`d under the slice's own read of it; a kits header or shard `set` whole, or
  deleted, under the run document's precondition alone. Every document a run writes carries its
  `execucaoId`.
- A component's header and ALL its shards go in ONE batch: the header is the map's commit point,
  so no reader sees a header of one run beside shards of another.
- The **kit fan-out** writes ONLY `proximoSlotMs` (section 8): `create` when the document is absent,
  else `update` on its own read, advance-only. **A slice never writes `proximoSlotMs`**; a lost
  precondition that moved only the slot re-applies the slice's same batch.
- The **send runs, the trigger and the operator routes** only READ these documents.
- No transaction anywhere in the stock code, so no transaction-inventory row. The new collections
  are bare: both rulesets regenerate with a zero diff.

### 3.5 Avisos

| Tipo                           | Key                                    | Raised and resolved by                    | Clock                         |
| ------------------------------ | -------------------------------------- | ----------------------------------------- | ----------------------------- |
| `lojaIntegradaEstoqueRecusado` | one row per child produto of the conta | the send run, on its LAST attempt         | the send run's dispatch start |
| `lojaIntegradaEstoqueSemErp`   | one row per conta (the held children)  | the reconcile's end                       | the run's start               |
| `lojaIntegradaEstoqueVinculo`  | one row per conta and `motivo`         | the reconcile's end (and its safety gate) | the run's start               |

- `lojaIntegradaEstoqueRecusado`: the store refused a child's stock WRITE with a 3xx or a 4xx
  other than 429 on the task's last attempt (a 401/403 only once the next deciding read on the
  same credential reads fine; refused too, the conta parks instead). Params `loja`, `produto`,
  `idLi` (text), `status` (a number); routes to the produto. Resolved only when OPEN: one pre-read,
  so a successful send writes nothing (the run's "no write on success").
- `lojaIntegradaEstoqueSemErp`: params `loja`, `produtos` (a count), `amostra`.
- `lojaIntegradaEstoqueVinculo` motivos: `ambiguo`, `duplicado`, `ausente`, `estoque-ambiguo`,
  `deposito-sem-registros` (the reconcile's safety gate) and `sem-linha-na-loja` (resolved only
  after a whole list AND a full confirmation). Params `loja`, `motivo`, `produtos`, `amostra`.
- All three are `atencao` and written only under `on` (a send run whose write decision for that
  target is `on`; a reconcile end whose valve is live for the conta), the samples at most 200 ids;
  all three joined the token-expiry sweep's orphan pass, so a deleted conta's rows
  are closed (`conta-removida`). Clocks go through the app's one conversion module
  (`../avisos/avisos.ts`), so an older run can neither reopen nor close a newer one's row.
- A send run raises none of the per-conta avisos: duplicado, an ambiguous record, held and a 404
  are WARNING lines there; a send run raising them would overwrite the reconcile's full count with
  one.

## 4. The quantity and the plan

- **Model A** (decided 2026-11-12): the store subtracts its own pending reservations from
  `quantidade`, so the ERP's sellable S is sent as
  `quantidade = min(S, cap) + max(0, quantidade_reservada)`, the reservation read from the store's
  row by the deciding GET right before the PUT (no pacer interval between them).
  `quantidade_disponivel` is never the input: it is the store's own derived figure.
- **S comes from ONE function**, `quantidadeEstoqueLi.ts`, the channel's binding of the shared
  core `@delfrance/data/admin/estoque` (the kit fold, the floor and the lower clamp live there,
  called and never forked; its suites stay byte-unedited). The channel owns three parameters:
  `incluirEstoqueProprioDoKit: false` (a constrained kit is the minimum over its components, never
  that plus its own record: ERP kits hold no stock, ADR 0014), `pularKitVirtual: false` (the stock
  PUT always carries `quantidade`, so a virtual kit takes the ordinary kit branch, #1087) and
  `estoqueMax: +∞` (never `0`). A record's owner comes from its PATH, never the stored `parentId`
  denorm (#932). Publish (step 11) will share the same function.
- **The record at the depósito**: the canonical record `makeEstoqueUid(produto, depósito)` wins; two
  legacy (non-canonical) records ⇒ ambiguous (`estoque-ambiguo`: nothing sent, the reconcile's
  vinculo aviso).
- **The never-had-stock hold, read literally**: only a produto with no stock record ANYWHERE is held
  (`r`, never pushed, listed in `lojaIntegradaEstoqueSemErp`); a produto with a record at another
  depósito is pushed the conta depósito's real 0.
- **Parity**: `statusProdutosMarketplace['<contaId>_<idLi>'].enviarEstoque === false`, exactly, is
  the operator's per-listing "do not send stock".
- **"Reflected"** needs all four leaves exactly (managed, the quantity, both situações); a row
  showing any other value is re-sent.
- **The cap** `LOJA_INTEGRADA_ESTOQUE_MAX` is applied by every function that takes it, at diff and
  send time, never stored; anything but `+∞` or a positive safe integer is a `RangeError`. Never
  `0`: zero is a legal quantity, so a `0` cap would zero every row it touched.
- **The kit filter, and why ties count.** With τ_c = ⌊available_c / q_c⌋ for each constraining
  component c of kit K, the trigger handling an event of component p flags K iff
  `min(τ_p(before), τ_p(after)) ≤ min(min over c ≠ p of τ_c(now), cap)`, and a sibling it cannot
  read flags K too. "K changed" is UNSOUND: a kit sale moves every component in ONE commit, so each
  component's event sees the others already moved and computes no change. A property test over
  random interleavings pins that the rule never loses a change (`planoEstoqueLi.propriedade.test.ts`).
- **Fail open**: an unreadable stock record is relevant, an unknown sibling flags, an unreadable
  kit quantity fires. One wasted run costs one store read; a hidden change is a stale number until
  the next reconcile.

## 5. The send run (PR 12-e, `processarEstoque.ts`)

The order of one run, every skip BEFORE the write context:

1. The payload, parsed STRICT (`tarefaEstoqueLiSchema`): `payload-invalido`, zero reads.
2. The valve (`iniciarEscritaLi(FLUXO_LI.estoque)`): `off` — recognised or not — is `desligado`,
   zero reads.
3. The cap from `ambiente`: unset or blank ⇒ none; only a canonical positive integer; anything else
   refuses EVERY run (`teto-invalido`, one ERROR line, zero reads).
4. The conta (the cached reader) and its depósito: gone, not a Loja Integrada conta, inactive or no
   readable depósito ⇒ skipped. A RECONCILE send's `depositoId` must be the conta's: a cached copy
   naming another is evicted and read once more (`invalidarContaEmCache`), and a conta still naming
   another drops the send (`deposito-mudou`, ONE WARNING). Equal in either stored form costs nothing
   more.
5. The masked produto and its where-less links, together. No produto ⇒ skipped.
6. The link-only plan (`planoDosVinculosEstoqueLi`): no counting child link, a parent's, a root with
   no grades, two store products, or parity ⇒ skipped WITHOUT reading a stock record.
7. The records: a canonical `estoqueId` hint read by id only when it IS
   `makeEstoqueUid(produto, depósito)` at the depósito — never a delete's, whose hint names the
   record deleted — else the `in` query over both stored ref forms, limit 3; for a kit its
   components bound, the bounding components' records (a constrained kit's own record is not read);
   then the plan. `consultar-estoques` ⇒ ONE listing of any record at any depósito, then the plan
   again (the
   hold). Only an `enviar` pays the duplicate-link probe; a hit plans again (`vinculo-duplicado`).
   `retido`, `estoque-ambiguo` and `vinculo-duplicado` are one WARNING line each.
8. `decidirAlvo` on `<conta>:<store id>` (`on`, or why not; only an exact `*` widens the canary).
9. Only NOW the write context (the read switch first, then the conta, one credential read): its
   refusals DROP, with the class — there is no failure store; the reconcile re-covers.
10. The deciding GET (`lerBaseLi`, the stock detail by PRODUCT id): a 404 ⇒ `ausente` (one
    WARNING); a row naming another produto (`produtoIdDoEstoqueLi`) ⇒ `linha-divergente` (one
    ERROR, nothing written).
11. Model A (`decidirEnvioEstoqueLi`): the target; the row already showing all four leaves ⇒
    `refletido`; a reservation it cannot read ⇒ ERROR drop.
12. The write, by origin (`tipoEscritaDaOrigemLi`): `evento`, `manual`, `publicacao` and `deriva`
    write `estoque-produto` and are READ BACK two pacer intervals later; `reconcile` and `kit` write
    `estoque-produto-lote`, with NO read-back call (the next daily walk is theirs). Not `on`: the
    engine's one diff line, nothing sent.
13. **The drift rule** after a read-back: the written leaves read back differently, the store's
    reservation moved so model A now targets another quantity, or the read-back could not be made
    (fail open) ⇒ ONE `deriva` follow-up (generation 1); a generation-1 run only logs
    `deriva-sem-seguimento`, so no loop is possible. This closes the race of an order LEAVING the
    store between the GET and the PUT: it lowers quantity and reservation by the same k, the PUT
    then advertises S + k, and the ERP's own matching pair moves no available quantity, so no event
    would ever correct it.

The follow-up's enqueue: the closed tasks valve ⇒ one WARNING and the write stands; any other
rejection (a transient Cloud Tasks failure, a deploy or region misconfiguration, the strict parse)
rethrows — a permitted post-write throw, `../core/escrita.ts` requirement 6 (i) — and the retry's
fresh GET decides. A read-back refused with 401/403 parks the conta and still enqueues the
follow-up (it drops at the park unless the token is fixed before it runs).

**At most ONE PUT per run, and no Firestore write on success.** A run's only Firestore writes are
the refusal aviso (under `on` only; tier 2, the dispatch start as its clock) and the park (tier 1).

**Worst case.** `PIOR_EXECUCAO_ESTOQUE_LI_MS` = 68 s: the deciding GET (two pacer intervals + its
20 s deadline), the PUT at once (+ 20 s), the read-back (4 s + 20 s) — or, after a write refused
with 401/403, the confirming deciding read in its place. The PUT starts at most 24 s after the
dispatch began. `processarEstoque.test.ts` pins it on a clock every wait advances, and the queue's
timeout is sized against it (`functions/src/index.test.ts`).

**Rollback.** Every deciding read writes a restore line with the store's whole stock row. Undo a
send by re-sending that row's `quantidade` through the same strict route, which sends only a
NON-NEGATIVE quantity under the four fixed leaves: a prior negative quantity, a prior unmanaged row
or a prior lead-time setting cannot be restored that way (`functions/DEPLOY.md`, "Undoing a stock
send").

**Rule 7 class.** Serialised by the stock queue (narrowed, not absolute: an abandoned dispatch or a
rare duplicate delivery can overlap); ONE write per run, decided by the deciding read just before
it; S re-derived on every attempt, never carried. The store takes no version on a write, so a
movement in the gap is the residual — closed by the `deriva` follow-up for the read-back origins
and within a day by the reconcile for the bulk ones. `reserva-arithmetic-inventory.test.js` lists
the run: it reads the STORE's reservation only through `alvoEstoqueLi`.

## 6. The stock queue and its task names

- **The queue** `filaEstoqueLojaIntegrada` is its OWN function, so the status write-back never waits
  behind a stock pass, with options EQUAL to the writes queue's (`functions/src/index.test.ts` pins
  the equality): one dispatch at a time, `concurrency: 1`, `maxInstances: 1`, 3 attempts on a FLAT
  300 s backoff, 300 s timeout. No `secrets:`, no failure store.
- **Routing** on the RAW `tipo`: `estoque` runs one send run; `estoque-kits` the fan-out; anything
  else is dropped as `tipo-desconhecido` (nothing could ever process it, so it spends no retry).
  ONE info line per dispatch, raw ids only (a fan-out's adds its counts and the reserved horizon); a
  thrown run writes none.
- **The window**: `janela = ⌊now / 60 s⌋`, the clock read IMMEDIATELY before the enqueue, never an
  event's own time (the trigger reads it inside each enqueue helper, after every read).
- **The name**: `estoque-` + sha256 of `estoque:<origem>:<conta>:<produto>:<d|w>:<janela>` (a burst
  inside one window enqueues ONE task per origin, conta, produto and delete flag; a create and a
  delete in one window are two tasks; a `deriva` never collides with the event that caused it); a
  fan-out task `estoque-kits-` + sha256 of `estoque-kits:<conta>:<componente>:<janela>` (its own
  prefix AND tag, so it can never take a send task's name). The window is in the name, so Cloud
  Tasks' ban on re-using a name for about an hour never bites.
- **The schedule**: `(janela + 1) · 60 s + 60 s + (hash(produto) mod 30 s)` — the task cannot
  dispatch before its window closed and a margin at least as long as an enqueue's own deadline
  passed, so an enqueue either creates its task or collides with one that dispatches after it and
  reads the ERP as it left it. A late redelivery lands in a later window: one more run, never a
  loss.
- **A bulk enqueue** passes `enfileirarTarefaEstoqueLi` two options (`OpcoesEnvioEstoqueLi`):
  `janela`, the window that NAMES the task in place of the clock's, and `naoAntesDeMs`, a not-before
  bound that only pushes the schedule later. The fan-out names every kit task by ITS OWN payload's
  window J: every task named for J is scheduled at or after `(J + 2) · 60 s`, after the crossing
  that caused the fan-out committed, so meeting one loses nothing, and a retry of the fan-out
  re-meets its own sends. The
  reconcile names every send by the RUN's window `J = ⌊iniciadoEmMs / 60 s⌋` and schedules it at its
  reserved slot instant, after the run's diff of that row; only that run's queue phase ever
  enqueues a `reconcile` task of window J (two runs never start in one minute: `adiar`), so an
  already-exists there is THIS run's earlier enqueue. Every other producer passes neither option.
- **The payload is parsed STRICT before it leaves**: a quantity can never be enqueued (a
  `ZodError`, nothing sent).
- **What a rejection means** (the writes producer's contract): `functions/task-already-exists` WITH
  an answered `httpResponse` is SUCCESS; `LiTarefasDesligadasError` — the sweep-only valve is closed,
  nothing enqueued, the queue never resolved; `LiTarefasTransitoriasError` — Cloud Tasks hiccupped,
  the caller rethrows and its retry enqueues the same name; anything else rethrown EXACTLY as thrown
  (a broken deploy, a root's region guard, a bug).
- **Load on the store**: the two write queues together make at most two writes in flight per store,
  each paced by the engine (`../core/ritmo.ts`): the theoretical worst per store is 150 calls a
  minute against Loja Integrada's 100; a 429 throws and the retry re-derives.
- ⚠️ **The export name IS the queue name**: renaming the function creates a NEW queue and strands
  the old one's tasks (`functions/src/index.ts` asserts it equals `FILA_ESTOQUE_LI`).

## 7. The trigger (PR 12-f, `gatilhoEstoque.ts`)

`onEstoqueLojaIntegrada` is an `onDocumentWritten` on `produtos/{produtoId}/estoques/{estoqueId}`,
database `default` (inlined at build time: an `onDocument*` bound to `(default)` deploys fine and
NEVER fires), `retry: true`, no secrets, no `region:`. It shares the path with `apps/functions`'
`onEstoqueDeleted` (deletes); the two are independent. It fires on EVERY ERP stock write of every
depósito and channel, so its gates run from the cheapest up:

1. **Relevance, from the payload alone** (`relevanciaEventoEstoqueLi`): zero reads, no line. A
   `localizacao` edit, an `ultimaModificacao`-only update (the kit stamp) and the paid → shipped
   pair (quantity and reservation lowered by the same k) move no available quantity and stop here.
   The cap sharpens the answer; an unreadable cap reads as none here.
2. **The valve**: `off` ⇒ zero reads; an UNRECOGNISED value logs ONE WARNING per instance (latched);
   `dry-run` and `on` go on alike. The trigger reads no canary list and no read switch.
3. **The depósito** (`depositosLi.ts`): the record's stored ref, on each side of the write, looked up
   in the cached map. No conta concerned ⇒ return. Only now an unreadable cap is reported (ONE
   ERROR, nothing enqueued): an ERP-wide line for writes no conta stocks from would drown it.
4. **The links**, only when the write can move the produto's OWN quantity: ONE where-less listing of
   `produtos/{p}/produtolojaintegrada`. A conta gets the DIRECT task exactly when its links make the
   produto one linked CHILD (`vinculoDaContaLi`); parity stays the run's (the trigger never reads the
   produto; a parity child costs one skipped run of three ERP reads).
5. **The kits**, per concerned conta, linked or not: ONE `getAll` of the component's header in every
   concerned conta (NOT_FOUND is the common case), then section 8's eager or zero-crossing path.

**The enqueues come after EVERY read**, the clock read inside each enqueue helper. Every send task
goes first (the direct ones, then the flagged kits), at most 8 at a time; the fan-out tasks go LAST,
only once every send task was accepted, so a failed send task never leaves a fan-out behind for the
retry to enqueue again. A fan-out can still be enqueued twice, under two window names: contas
sharing a round where one fails transiently after another landed, a landed enqueue whose answer was
lost, a duplicate Eventarc delivery. Nothing is lost; the cost is one more fan-out. Rejections: an
answered already-exists is success; the closed sweep-only valve is ONE WARNING and the event's
remaining enqueues are skipped; a transient failure rethrows for Eventarc's retry; a payload the
strict schema refuses is ONE WARNING with field names, and only that task is skipped; anything else
rethrows.

**It never**: writes to Firestore (so it cannot trigger itself or anything else), calls Loja
Integrada or builds a client, reads the produto document, the credential, the canary or the switch,
or logs a quantity, a stored ref or an environment value.

**The depósito map** (`depositosLi.ts`) caches `listarContasLojaIntegrada` — ONE query on the
declared `integracao (tipo, nome)` index — through a module-scope `createReadCache`, TTL
`READ_CACHE_TTL.config` (15 min) per warm instance. An EMPTY map is cached too (a project with no
conta pays one query per TTL, not one per stock write). Inactive contas are KEPT (the run skips one
after a single cached read; dropping it would delay a reactivation by up to the TTL). A tipo-3 conta
lacking `nome` is outside the enumeration. A record matches only by one of the two EXACT stored
forms (`registroNoDepositoLi`, the send run's own `in` equality); the conta's side folds
(`depositoDaContaLi`). A record stored under any other spelling is not found by the run either, so
the trigger ignores it and the reconcile's full walk is where it shows. A write that changes the
depósito concerns both sides' contas; two contas on one depósito are both concerned. A conta
created or re-pointed is seen within the TTL per instance; a re-point ALSO starts an immediate full
reconcile through the conta trigger's depósito-change arm ([`reconcile/README.md`](reconcile/README.md),
"Depósito changes").

## 8. Kits: the map, the eager path, the fan-out and the global slot

**The map's read side** (`mapaKitsLi.ts`): every read a point read by id (no index), every batch
ONE `getAll`. A header is parsed with the REFINED schema (`F`, `kits` and `fatias` agree) — one
whose invariants fail decides nothing (`invalido`); what a shard read cannot account for is
counted, never guessed (`completa`). The reconcile alone writes the map (section 3.4).

**The eager path** — header inline and `F` ≤ `LOJA_INTEGRADA_ESTOQUE_KITS_IMEDIATO_MAX` (unset = 30;
0..30; anything else ONE WARNING per event that reaches a header, and it acts as 0): the zero-cost
skip (only with a finite cap), or the siblings read in ONE `getAll` — a sibling named by a legacy id
has its CANONICAL path read beside it, and the records read at the depósito are resolved by the
shared `estoqueNoDepositoLi`, the send run's own rule — then `kitsSinalizadosLi` (tie-inclusive,
fail-open), one `estoque` task (`kit`) per flagged kit. A sibling absent, at another depósito,
unresolved or unreadable is left out of the readings, and its kits flag.

**The zero-crossing path** — more kits than the ceiling, or kits in shards: ONE `estoque-kits`
fan-out exactly when `disparaKitsZeradosLi` fires, on EVERY decrease while the component sits below
`qMax`. The canonical record's create (or move into the depósito) has an UNKNOWN before-side — it
can displace a positive legacy record — so that side is read as above every kit's need and the
fan-out fires exactly when the new record is below `qMax`. The trigger never reads the shards.

**The fan-out** (`processarKitsEstoque.ts`, on the stock queue):

1. The payload, strict — zero reads.
2. The valve: `off` ⇒ zero reads; `dry-run` and `on` alike (the sends it enqueues honour the valve
   themselves).
3. The cap: unreadable ⇒ ONE ERROR, zero reads.
4. The conta (`lerContaEmCache`): gone, not Loja Integrada, inactive or no depósito ⇒ `pulado`.
5. In parallel: the header and the component's OWN stock at the depósito, read as the send run reads
   it (canonical by id, else the two-form query, canonical-wins). No record, two legacy ones or an
   unreadable count ⇒ available 0, every kit (fail open). No header ⇒ `sem-mapa`; one off its
   refined schema ⇒ ONE WARNING, `mapa-invalido`.
6. The kits: inline, or the shards in ONE `getAll`. A read that does not account for every kit is
   ONE WARNING and, before the queue's last attempt, `LiMapaKitsEstoqueIncompletoError` (a retry
   300 s later reads the map after its writer finished); on the last attempt the kits that WERE read
   go on.
7. Nothing at 0 (`kitsZeradosPeloComponenteLi`: ⌊available / q⌋ ≤ 0, quantity ascending — the
   likeliest crossings first) ⇒ `nenhum`, and NO write.
8. The global slot: n instants reserved — its ONLY Firestore write.
9. The enqueues, 20 at a time, each named by the FAN-OUT's own window and scheduled at exactly its
   reserved instant. An answered already-exists is success; the closed sweep-only valve is ONE
   WARNING and ends the run (`tarefas-desligadas`; the slot already moved — harmless); a strictly
   refused payload is counted and ONE WARNING names its fields; a transient failure lets the batch
   finish, then the first is rethrown once; anything else is rethrown at the end of its round.

⚠️ **The fan-out's cost is per FIRING, not per crossing.** A component at 5 selling to 4, then to 3,
fires twice, and each fan-out enqueues EVERY kit this component holds at 0 — those already at 0 in
the store included — named by its own window, so nothing deduplicates them across firings. Each send
costs its run's ERP reads, one store GET at `on` (a PUT too when the store differs) and one slot
interval. A pre-filter would need the event's before-available in the payload, a change to the
strict ids-only schema: the owner's decision, from the ERP kit counts.

**The global slot** (`slotEstoqueLi.ts`): `reconcileEstoqueLojaIntegrada/atual.proximoSlotMs`, the
next free instant for a bulk send, taken by the fan-out and the reconcile's queue phase.

- **The interval** `INTERVALO_SLOT_ESTOQUE_LOTE_LI_MS` = 17 s: one bulk run (two pacer intervals, the
  GET, the PUT) PLUS one event run (two intervals, the GET, the PUT, two more intervals, the
  read-back) — 6 × `RITMO_ESCRITA_LI_MS` of sleeps and 5 calls at 1 s each, pinned against the pacer
  by `slotEstoqueLi.test.ts`. One event run fits between two bulk sends, so a fan-out keeps the
  queue about two-thirds busy; a 2,000-kit fan-out spans about 9.4 h. ⚠️ The per-call second is an
  ESTIMATE, not a bound (section 17 measures it).
- **The floor** `(⌊now / 60 s⌋ + 3) · 60 s + 30 s`: one whole window past the latest instant any task
  of the current window can be scheduled at, so every task is scheduled at EXACTLY its reserved
  instant.
- **Always behind the stored slot, never double-booked**: two reservations never share an instant,
  so the queue never carries more than one bulk send per interval. A retried attempt reserves like a
  first one; its earlier attempt's unused instants are a stated gap (latency, never load).
- **The write**, tier 1: read MASKED to `proximoSlotMs` (the document may hold up to 600 KB of
  candidates), `create` when absent, else `update` on its own read's `lastUpdateTime`, advance-only;
  a 9 or a 6 re-reads and re-derives, and a re-read finding EXACTLY the value this attempt wrote is a
  landed write, never a second advance; at most 3 writes, then `LiSlotEstoqueEmConflitoError` and the
  task retries. A stored value that is not a non-negative safe integer reads as none (fail open).
- **The backlog signal**: a stored slot more than 12 h ahead is ONE ERROR line, and the run still
  queues behind it. No setting relieves it today — `KITS_IMEDIATO_MAX=0` moves MORE kits onto the
  slot; what would is a pre-filter on the fan-out or another interval, both the owner's decisions.
- **The schedule limit**: a reservation that would end past 29 days (inside Cloud Tasks' 30-day
  limit) writes and enqueues NOTHING: `slot-esgotado`, ONE ERROR; those kits wait for the nightly
  reconcile. Only a backlog of weeks or a hand-edited value gets there; a person who finds a value no
  backlog explains deletes the `proximoSlotMs` FIELD, never the document (`functions/DEPLOY.md`).
- **A horizon cut** (`ateHorizonteMs`, the reconcile's under-advertising batches only): only
  instants within that horizon are reserved; the fan-out passes none.
- ⚠️ **Pacing is the ONLY latency control**: Cloud Tasks orders no ready tasks, so once a backlog
  exists no send has a latency bound beyond its drain. The fan-out's queue line logs the reserved
  horizon: that is the signal.

## 9. The daily FULL reconcile (PR 12-g)

One chain of time-boxed slices on the READS queue covers every conta, one phase after another: the
ERP side (`erp`: the key walk of every link, the snapshot, the kits map), the store's stock list
(`li`: read whole and diffed, rows out of step become candidates), the sends (`fila`: the safety
gate, then the candidates enqueued over-advertising first on the global slot), the avisos (`fim`).
It starts four ways — nightly at 04:23 São Paulo, the conta trigger's depósito arm, the operator's
route, and a release that saw a depósito change — and none of them is gated on the read switch
(the operator route only reports it): with it off the ERP side still rebuilds the kits map the
trigger reads, and every store phase stops at the switch. A dry-run enqueues nothing and never
touches the slot. The 5% safety gate is decided in every valve mode. A missed trigger, the cutover
import and the bulk sends' drift are each bounded by it: at most 24 h.

Everything else — the run document's decision and write protocol, the phases, the budget, the
failures and the last attempt — is [`reconcile/README.md`](reconcile/README.md).

## 10. The operator routes and the web provider (PR 12-h)

Both routes require `PERM.integracao.write`, ENQUEUE only — no Loja Integrada call, no credential
read, no Firestore write — and answer the `erroContaLojaIntegradaSchema` envelope on a refusal.

| Order | `POST …/enviar-estoque` (the manual push)                                                              | `POST …/conta/[id]/estoque/reconciliar` (reconcile now)             |
| ----- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| 1     | caller 401/403; strict body `{ contaId, produtoIds[1..200] }` ⇒ 400 `LI_CORPO_INVALIDO`                | caller 401/403; the id ⇒ 400 `LI_ID_INVALIDO`                       |
| 2     | stock valve `off` ⇒ 503 `LI_ESTOQUE_DESLIGADO`                                                         | stock valve `off` ⇒ 503 `LI_ESTOQUE_DESLIGADO`                      |
| 3     | read switch not exactly `on` ⇒ 503 `LI_CHAMADAS_DESLIGADAS` (one `chamada-bloqueada` line)             | — (the switch is only REPORTED, as `chamadas`)                      |
| 4     | `LOJA_INTEGRADA_TASKS_DISABLED=1` ⇒ 503 `LI_TAREFAS_DESLIGADAS`                                        | the same                                                            |
| 5     | no queue region ⇒ 500 `MissingRegionError` — zero Firestore reads up to here                           | the same                                                            |
| 6     | the conta UNCACHED: 404 `LI_CONTA_NAO_ENCONTRADA`, 409 `LI_CONTA_INATIVA`, 409 `LI_CONTA_SEM_DEPOSITO` | the same                                                            |
| 7     | more than 30 children ⇒ 400 `LI_SELECAO_EXCEDE_LIMITE` (refused whole); else 200                       | a run holding the lease ⇒ 409 `LI_RECONCILE_EM_ANDAMENTO`; else 202 |

**The manual push** (`envioManualEstoqueLi.ts`): ONE masked `getAll` of the selection; a missing
document ⇒ `produto-ausente`; one whose `integracoesComProduto` does not name the conta ⇒ ONE
`sem-vinculo` entry and no further read. A selected CHILD is its own target; a selected ROOT that
passed is expanded by ONE query `paiId == <root>` + `integracoesComProduto array-contains <conta>`,
projected to two fields, `limit` 31, on the declared COLLECTION index
`produtos (paiId, integracoesComProduto, __name__)` (pinned against `firestore.indexes.json`);
children found are the targets, none ⇒ the root itself. More than 30 targets ⇒ refused WHOLE before
any listing or enqueue. Per target ONE where-less listing of its own links, classified by the send
run's own `planoDosVinculosEstoqueLi`: `vinculado` ⇒ one `estoque` task (`origem: manual`, named by
the clock's minute, so a double click in one minute meets its own task); `paridade`, `pai`,
`nao-suportado`, `vinculo-ambiguo` ⇒ a `pulado` row; `sem-vinculo` ⇒ no row, and a selected id
none of whose targets made a row gets ONE `sem-vinculo` entry, never one per child. A transient
Cloud Tasks failure on one target is that row's `falha` (`fila-indisponivel`); anything else
rethrows once the round settles (a 500 after which some tasks MAY exist). A queued row is
`enfileirado`, never `enviado`: the send run decides minutes later. Everything after the links stays
the send run's (the hold, a duplicate link, an ambiguous record, `refletido`, a 404, the park, the
depósito, the canary, the cap). Per request:
one conta read, one masked `getAll`, one projected query per root that names the conta, one listing
per target, one enqueue per linked child; no full produto document, no stock record, no write.

- **Why 30**: the stock queue is single-file and a manual run is a read-back run (about 11 s), so 30
  unpaced tasks hold it about five and a half minutes, the burst the trigger already makes for one
  component's eager kits; a larger batch would delay every sale-driven send behind it. ⚠️ The bound
  is PER REQUEST: the web provider sends at most ONE request per conta and run that can enqueue
  anything. The number is the owner's to change; a larger one should reserve its sends on the slot.
- ⚠️ **A deviation from the approved design, flagged in PR 12-h and merged with it**: a family is reached
  only through a ROOT whose own array names the conta. The anchor keeps each produto's array from its
  OWN links, so a family whose root link is trashed or removed while its children's links still count
  answers `sem-vinculo` here, although the trigger and the reconcile still send those children.
  Selecting the children directly covers it.

**Reconcile now** (`reconcile/reconcileManualLi.ts`): ONE read of the run document's four lease
fields (masked: the document can hold about 600 KB of candidates); a run still holding the lease ⇒
409 with its `execucaoId`; else ONE enqueue of `estoque-reconcile-manual-<minute ms>` (the request's
minute, in ms) seq 0 ⇒ 202 `{ execucaoId, modo, chamadas, mensagem }`. A repeat in the same minute
names the same task (the same 202). The run is GLOBAL: every active conta with a depósito, not only
the one in the path. The operator copy of both routes states only what this backend knows:
`chamadas` reports
THIS backend's read switch, and the functions codebase's own copy of each set-alike pair decides
what the run and the sends do.

**The App Hosting producer root** `lib/firebase/filasLi.ts` binds the stock and reads queues only
(never the writes queue; `estrutura.test.ts` pins every root's queue set) through ONE `getFunctions(`
call. The region is `LOJA_INTEGRADA_TASKS_REGION`, then `FUNCTIONS_REGION`, with NO default,
resolved per enqueue and once more by each route before any read. `LOJA_INTEGRADA_TASKS_DISABLED`
exactly `1` closes both. No `oidcToken`: the Admin SDK stamps the enqueuer's own identity. Both are
console values of that backend only, never an `apphosting.yaml` `env:` row. The IAM it needs is
section 16.

**The web provider** (`apps/web/lib/marketplace/estoque/providers/lojaIntegrada.ts`) has its
`PROVIDERS` row ahead of the caps flip and stays UNREACHABLE until step 22 (the caps row still says
`implementado: false`). It renders `enfileirado` with its own label, slices the selection into
requests of at most 200 ids, and lets at most ONE slice per conta and run enqueue anything. No web
screen calls the reconcile route yet.

## 11. Costs

Pinned by counting, offline. Planning estimates in read units live in the master plan, labelled as
estimates; no staging measurement is recorded yet (section 17).

**The send run** — ERP Firestore operations / credential reads / store calls
(`processarEstoque.test.ts`):

| Outcome                                                                   | Cost  |
| ------------------------------------------------------------------------- | ----- |
| valve off, bad payload, unreadable cap                                    | 0/0/0 |
| a link skip                                                               | 3/0/0 |
| a record skip                                                             | 4/0/0 |
| held (never had stock)                                                    | 5/0/0 |
| duplicate link                                                            | 6/0/0 |
| read switch off                                                           | 6/0/0 |
| 404, or a row of another produto                                          | 6/2/1 |
| reflected, under `on` (the aviso pre-read)                                | 7/2/1 |
| dry-run (one restore line, one diff line)                                 | 6/2/1 |
| an `evento`, `manual`, `publicacao` or `deriva` PUT (GET, PUT, read-back) | 7/4/3 |
| a `reconcile` or `kit` PUT (`estoque-produto-lote`, no read-back)         | 7/3/2 |

A kit its components bound reads no record of its own but its k bounding components': with the
payload's canonical ids ONE `getAll` (k reads), a PUT 6 + k under `on`; without them two group
queries per 30 components, then one own-collection query per component whose CANONICAL record is
still unread — none found, or only legacy ones (a record with no `parentId`, the canonical one
included, is invisible to the join, so a legacy hit never stands for the whole answer: it could
hide the record that wins, or a second legacy one that makes it ambiguous). A component with no
record at the depósito, or with legacy records only, pays it on EVERY run (k = 2, one unresolved: a
PUT 9/4/3).

**The trigger** (`gatilhoEstoque.test.ts`): an irrelevant event or the valve off, 0 reads; a
relevant event at a depósito no conta stocks from, only the cached map (one
`integracao (tipo, nome)` query per 15 min per instance); at a Loja Integrada depósito, one links
listing (when direct), plus one header read per concerned conta, plus the deduplicated siblings only
when the eager filter needs them.

**The fan-out**: per FIRING (section 8) — the conta (cached), the header and the component's own
record, the shards in one `getAll`, one masked slot read and one write (more on contention), then
up to F sends, each costing its own send run.

**The manual push**: per request (section 10).

**The reconcile**: one budget unit per page of 300 links, per kits map batch, per store call, per
page's lookups, per queue batch and per conta's end ([`reconcile/README.md`](reconcile/README.md),
"One slice"); the run's six ERP read-path counters say which path the corpus took. Store calls per
run: one list page per call, plus one detail GET per unseen linked child (at most 200 per conta;
about 0 in the steady state).

## 12. Failures and the last attempt

There is no failure store anywhere in the stock sync: a dropped task's only trace is its log line,
and the daily reconcile re-covers the produto.

| Component             | Throws (the queue or Eventarc retries)                                                                                                                                     | Drops or skips                                                                                                                                                 | On the last attempt                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Send run              | 429 and 5xx (a PUT answered either may have landed: the retry re-GETs); the credential pin, the write deadline, network, `LiConfigError`, gRPC; another 3xx/4xx on the PUT | the context's refusals (the read switch included); 401/403 on a deciding read PARKS and drops; a deciding read off its schema (`formato`) drops with one ERROR | another 3xx/4xx on the PUT ⇒ `recusado`, one ERROR, the aviso under `on`; another non-transient read error ⇒ one ERROR drop |
| Send run, PUT 401/403 | —                                                                                                                                                                          | the next deciding read confirms: refused ⇒ park; reads fine ⇒ the 4xx rule above                                                                               | —                                                                                                                           |
| Fan-out               | an incomplete map read (`LiMapaKitsEstoqueIncompletoError`); a lost slot race (`LiSlotEstoqueEmConflitoError`); a transient enqueue                                        | `slot-esgotado`, `tarefas-desligadas`, `sem-mapa`, `mapa-invalido`                                                                                             | an incomplete map: the kits that WERE read go on                                                                            |
| Trigger               | a transient read or enqueue failure (`retry: true`; names keep it idempotent)                                                                                              | an unreadable cap (one ERROR); the closed tasks valve (one WARNING); a refused payload (one WARNING)                                                           | —                                                                                                                           |
| Nightly start         | a transient enqueue (Cloud Scheduler's retry carries the same schedule time)                                                                                               | the valve off; the closed tasks valve (one WARNING)                                                                                                            | —                                                                                                                           |
| Depósito arm          | a transient enqueue (`retry: true`)                                                                                                                                        | the valve off; the closed tasks valve (one WARNING)                                                                                                            | —                                                                                                                           |
| Reconcile slice       | see [`reconcile/README.md`](reconcile/README.md), "The store phase" and "The last attempt"                                                                                 | a payload that does not parse; the valve off; an unreadable cap (one ERROR)                                                                                    | released with `tentativas-esgotadas` or `falha-nao-retentavel`                                                              |
| Operator routes       | — (a 500 leaves the outcome unknown: a repeat inside the minute collides harmlessly)                                                                                       | the gates of section 10                                                                                                                                        | —                                                                                                                           |

## 13. Environment and valves

Nothing under `lib/lojaIntegrada` reads the process environment: each entry point passes
`deps.ambiente`. The valve, the canary, the switch and the three numeric settings are read exactly:
nothing is trimmed or case-folded. The rows below are what each variable means for stock.

| Variable                                   | Functions readers                                                                                                               | App Hosting readers                                                    | Unset                                                                                                                          | An unreadable value                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOJA_INTEGRADA_MODO_ESTOQUE`              | the trigger, the send run, the fan-out, a reconcile slice, the nightly start, the depósito arm                                  | both stock routes                                                      | `off`: zero reads everywhere                                                                                                   | anything but exact `dry-run` or `on` is `off`, with one WARNING (once per instance on the trigger)                                                                         |
| `LOJA_INTEGRADA_CANARIO_ESTOQUE`           | the send run (`decidirAlvo`); the reconcile's queue phase (`foraDoCanario`) and end (avisos only for a conta the canary admits) | parsed with the valve, never applied                                   | no target                                                                                                                      | only exact `*` widens; `<contaId>:<store id>,…` otherwise; a malformed entry names no target                                                                               |
| `LOJA_INTEGRADA_CHAMADAS`                  | the send run's write context; the reconcile's store phase (its context)                                                         | the push requires it exactly `on`; the reconcile route only REPORTS it | no call                                                                                                                        | only exact `on` calls                                                                                                                                                      |
| `LOJA_INTEGRADA_ESTOQUE_MAX`               | the send run, the trigger (relevance; reported at gate 3), the fan-out, a reconcile slice (gate and diff)                       | —                                                                      | no cap                                                                                                                         | refused: the send run `teto-invalido` (one ERROR, zero reads); the trigger one ERROR per event at a Loja Integrada depósito; the fan-out and a slice one ERROR, zero reads |
| `LOJA_INTEGRADA_ESTOQUE_KITS_IMEDIATO_MAX` | the trigger                                                                                                                     | —                                                                      | 30                                                                                                                             | anything but 0..30 in canonical decimal acts as 0, with ONE WARNING per event that reaches a kits header                                                                   |
| `LOJA_INTEGRADA_ESTOQUE_LIMITE_PAGINA`     | a reconcile slice's store phase, when a conta's walk starts                                                                     | —                                                                      | 100                                                                                                                            | above 100 clamped to 100, anything else 100; ONE WARNING per run either way                                                                                                |
| `LOJA_INTEGRADA_TASKS_DISABLED`            | every functions producer                                                                                                        | both stock routes (its own copy)                                       | open                                                                                                                           | only exact `1` closes                                                                                                                                                      |
| `LOJA_INTEGRADA_TASKS_REGION`              | every functions producer (one region for all three queues)                                                                      | both stock routes                                                      | functions: the bundle's `FUNCTIONS_REGION` (blank counts as unset); App Hosting: `FUNCTIONS_REGION`, else `MissingRegionError` | a well-formed WRONG region drops every task while the enqueue reports success (#1108)                                                                                      |

What `LOJA_INTEGRADA_TASKS_DISABLED=1` does to stock on the functions side: the trigger logs one
WARNING and skips the event's remaining enqueues; a `deriva` follow-up is one WARNING (the write
stands); the fan-out ends `tarefas-desligadas`; the nightly start and the depósito arm log one
WARNING; a slice's hand-off releases the lease with one WARNING; the queue phase drops its list with
one WARNING. The next event or night re-covers.

**Where they are set.** Functions: `apps/loja-integrada/functions/.env.deploy` (the block in
`functions/DEPLOY.md`, "Runtime env"). App Hosting: that backend's console, never an `env:` row of
`apphosting.yaml` (whose comment rows list what it reads). The valve and the read switch are set
ALIKE on both surfaces; `TASKS_DISABLED` is per surface. **`LOJA_INTEGRADA_MODO_ESTOQUE=dry-run`,
alike on both surfaces, is the ONE value allowed before the window**: it is the daily reconcile's
staging measurement path, and with the read switch off and no token saved it calls nothing and
writes nothing to a store. `on`, any canary entry and the read switch are window decisions. ⚠️
Staging hazard: Loja Integrada has no sandbox, so a conta holding a token makes our code read LIVE;
no Loja Integrada token is saved or renewed in staging, or locally, before the window.

The root `.env.example` must list the valve, the canary and the switch as blank rows
(`core/valvulas.test.ts`); the three numeric settings and the two tasks variables are optional rows
there (`functions/DEPLOY.md` is their real home).

## 14. The emulator lane

The Loja Integrada lane (`ci-loja-integrada.yml`, `CI gate (loja-integrada)`) runs the
`*.tasks.test.ts` and `*.firestore.test.ts` suites against one shared emulator, with the stock valve
at `dry-run` and the read switch `off` in the job env. Three stock suites share it, each driving its
work IN PROCESS (`ambiente` `on` only as a PARAMETER, with a scripted `fetch`):

- `processarEstoque.tasks.test.ts` — the send run: the real queries (both depósito ref forms, the
  any-depósito listing, the collection-group duplicate probe) and the `deriva` follow-up through the
  real producer root. The DISPATCHED follow-up passes the stock valve and stops at its write context
  (the read switch off): that hop has no Firestore-observable outcome by design.
- `gatilhoEstoque.tasks.test.ts` — the trigger's work, in process (the deployed trigger's depósito
  map is a 15-minute cache in the emulator's worker, warmed by whichever suite writes first), through
  the real producer root; it observes the DISPATCHED fan-out through its slot write, read back raw
  and checked exactly.
- `reconcile/reconcileEstoque.tasks.test.ts` — the chain: the real key walk, joins, snapshot and kits
  map, the store's list through a scripted `fetch`, the sends through the real stock producer root,
  its hand-offs recorded so no deployed dispatch drives the same lease; it observes one DISPATCHED
  depósito-arm run through the run document, and asserts `run.contas` is exactly its own conta.

**What fires on every suite's writes.** The STOCK trigger fires on every suite's
`produtos/*/estoques/*` writes, and at the lane's `dry-run` it may enqueue send runs (which write
nothing) and, for a seeded kits header, a fan-out (whose one write is the slot). The conta trigger's
depósito arm fires on an UPDATE that moves a Loja Integrada conta's depósito, and its dispatched run
walks every link and conta in the emulator; the run document is the one the fan-out writes its slot
on. So a suite that writes stock records or contas:

- uses produtos and contas no other suite seeds, and seeds contas with a depósito by a CREATE (the
  arm never fires on one);
- never moves a record from positive to 0 under a sharded or over-ceiling kits header, nor creates a
  CANONICAL record below that header's `qMax` (its before-side is unknown, so it fires);
- deletes its kits map before its records;
- when it seeds a kits header (so a fan-out it causes can write the slot), moves a conta's depósito
  or asserts on the run document, wipes `reconcileEstoqueLojaIntegrada/atual` before AND after each
  case, awaiting the slot write of a fan-out it caused (the trigger and reconcile suites do; the
  send-run suite seeds no kits header, so nothing it causes writes the slot, and it never touches
  the run document);
- also keeps the anchor trigger's rules (`apps/loja-integrada/CLAUDE.md`, CI) when it writes links;
- deletes its links (the anchor awaited) before their produtos. The reconcile suite's teardown is
  the full pattern, in order: the contas' sync documents, the run document, then links (the anchor
  awaited), records and produtos, contas, avisos.

**What the lane cannot prove**: Cloud Scheduler firing (`onSchedule` is ignored),
`scheduleDelaySeconds` and `scheduleTime` (firebase-tools#8254), index declarations, that the
emulator honours `maxConcurrentDispatches` or the instance limits, named-task dedup, Eventarc
ordering or redelivery, the stock queue's dispatch of a SEND run, the deployed stock trigger end to
end or its gate order and costs (pinned offline, `gatilhoEstoque.test.ts`), or a trigger's
`database` binding (pinned offline in `functions/src/index.test.ts`). Locally, run the lane as
`apps/loja-integrada/CLAUDE.md` ("CI") says, with `LOJA_INTEGRADA_MODO_ESTOQUE=dry-run` and
`LOJA_INTEGRADA_CHAMADAS=off`.

## 15. Guards

- `../estrutura.test.ts`: the trigger and the fan-out call nothing outside the ERP (their closure,
  the stock producer's root a leaf, reaches no context loader, park, pacer, write engine or send run,
  names no client, calls no `fetch`, and loads the package only through `pedidos/vinculoProdutoLi.ts`'s
  constants); the two operator routes are `ROTAS_DE_ENFILEIRAMENTO_ESTOQUE_LI` (the trigger's rules,
  the App Hosting root walked, plus a ban on every credential module and `core/contas.ts`); the
  reconcile reaches the store only through the context loader; each `getFunctions(` root binds only
  its own queues; nothing under `lib/lojaIntegrada` reads the process environment.
- `../prazos.test.ts` lists `ROTAS_DO_ESTOQUE`: the two routes and their cores make NO context load
  and name no package read.
- Index pins, each against `firestore.indexes.json`: `leituraEstoqueErp.test.ts` (the send run's
  queries), `depositosLi.test.ts`, `envioManualEstoqueLi.test.ts` (the expansion query),
  `reconcile/caminhadaVinculos.indexes.test.ts` (the key walk), `reconcile/faseLi.test.ts` (the
  lookup), and `tools/migrations/src/keyWalks.indexes.test.ts`, which lists the group key index
  `produtolojaintegrada (__name__)` as PERMANENT.
- `packages/config-eslint/rules/`: `reserva-arithmetic-inventory.test.js` (the four files that read
  the store's reservation), `equivalence-fold-inventory.test.js` (rows for the stock row's
  product-id reader and the link ids' canonical fold), `tasks-invoker-inventory.test.js` (the stock
  queue and its two enqueuing identities). No transaction-inventory row: there is no transaction.
- `functions/src/index.test.ts`: the stock queue's options EQUAL to the writes queue's, the nightly
  schedule's free minute, every trigger's `database`, and the export names equal to the queue
  constants.
- `capturasEstoque.test.ts` replays the 33 sanitized stock captures against the code.

## 16. Deploy, IAM, indexes (listed, owner-run)

Nothing here is run by an agent; `functions/DEPLOY.md` is the runbook ("Functions in this codebase",
"Runtime env", "One-time IAM", "App Hosting enqueues since PR 12-h").

- **Order**: this functions codebase first (the queues' consumers and the invoker list), then the
  `apps/loja-integrada` App Hosting backend, then `apps/web`.
- **The stock queue is NEW**: its first deploy needs the firebase-tools enqueuer-binding workaround
  (`functions/DEPLOY.md`).
- **IAM**: `TASKS_INVOKER_SA` names BOTH the functions runtime SA and the App Hosting runtime SA (the
  deploy grants enqueue on every queue and `run.invoker` on every queue's service); the App Hosting
  runtime SA needs `roles/iam.serviceAccountUser` on ITSELF, which no deploy grants.
- **Console values** on the App Hosting backend: `LOJA_INTEGRADA_TASKS_REGION` equal to this
  codebase's `FUNCTIONS_REGION` (the preflight prints the cross-check), optionally
  `LOJA_INTEGRADA_TASKS_DISABLED`; and, since PR 12-h, the stock valve and the read switch set ALIKE
  with the functions side (`dry-run` and unset before the window; section 13).
- **The stock trigger's binding**: on its first deploy, `onEstoqueLojaIntegrada` (this codebase's
  fifth Firestore trigger) is listed on database `default` and fires, on the grants serving the
  other four; one bound to `(default)` deploys fine and never fires (`functions/DEPLOY.md`,
  "Verifying a first deploy", item 10).
- **Indexes, READY before the valve leaves `off`** (all declared; no new one): collection group
  `produtolojaintegrada (contaLojaIntegrada, id)`; collection group `produtolojaintegrada (__name__)`,
  PERMANENT; collection group `estoques (parentId, depositoOuterRef, ultimaModificacao)`; collection
  `estoques (depositoOuterRef, ultimaModificacao)`; `integracao (tipo, nome)`;
  `produtos (paiId, integracoesComProduto, __name__)`. On Enterprise a missing index full-scans and
  bills the scan.
- **The Cloud Scheduler job** for `reconciliarEstoqueLojaIntegrada` is created by the deploy.
- **Staging verification** at `dry-run` on both surfaces, the read switch unset: the reconcile route
  answers 202 with `chamadas: false` and the run takes its lease; the push answers 503
  `LI_CHAMADAS_DESLIGADAS` with no task; the stock queue's rights checked read-only.

## 17. Staging measurements to record

None is recorded at HEAD. The owner measures them on staging, in the #785 style, before the window;
the planning figures stay estimates until then.

- A where-less listing of one produto's own links.
- A masked produto read.
- The duplicate probe and the reconcile's lookup query, against values plus matches.
- The depósito `in` query and the component join.
- A NOT_FOUND point read and an empty listing (about one unit each), and a NOT_FOUND kits-header
  read.
- A FOUND large kits header (F > 30, `comps` with about 2,000 entries), which the trigger reads on
  every relevant event of that component.
- The key walk: index rows per 300-link page.
- A full run's six ERP read-path counters, from its end line.
- The run document's re-read per queue slice, and the masked slot read against a document holding
  the candidate list.
- The kits sweep's listings, per unit.
- The sizes of `candidatos` and `vistos` at the real catalogue, and write units per KiB for the
  bucket and run-document writes.
- One slice's real duration against the nominal 20 / 30 s units.
- One bulk and one event send run's wall time, against the 1 s per call the 17 s interval budgets.
- The manual push's expansion query (index rows) and one link listing per child.
- A full run of about 1,000 linked children with the read switch off: the nightly run itself, once
  the stock valve is `dry-run`.

## 18. Window items and open owner decisions

The window operations are tracked in #2199, linked from the cutover runbook #1208, with the exact
commands and checks: item 2 is its step 1; items 1 and 3–5 are its steps 10–13; item 9 is its
step 14, before the widening to `*`; items 6–8 are its steps 15–17; and item 10 is folded into
step 15's bootstrap. Agents never run any of them (root `CLAUDE.md` rule 8).

1. The legacy app's own stock push turned OFF before the valve reaches `on`.
2. The six indexes READY in the new project, the permanent key index kept.
3. Each conta's depósito mapping checked (the master plan's window gate: more than about 5% of a
   conta's linked children with no record at its depósito means the mapping is wrong — fix it
   before `on`), with the operação stock flags the counts audit (#2163) reports.
4. Day 0: one `dry-run` full run (a run is global: it covers every active conta with a depósito),
   reviewed per conta for differing rows, held, duplicate and ambiguous links, the kits histogram
   and the 5% gate.
5. Canary store ids plus `on`, the first real PUT and its read-back reviewed (the PUT path form is
   unproven; only the GET path form was observed).
6. The canary widened to `*` and the bootstrap, over-advertising first; operators told the store
   shows its own numbers until then.
7. The cap and the eager kit ceiling set from the read-only counts audit (#2163) and the first days.
8. A first-week billing and Loja Integrada call-volume check.
9. The manual push's first end-to-end run, once the read switch is `on` on both surfaces
   (`functions/DEPLOY.md`).
10. A Firestore import fires no trigger: the migrated stock reaches the store only through the first
    reconcile run with the read switch on.

**Owner decisions flagged in the PR bodies** (each PR merged with its "please confirm" list; revisit
one here if it should change): the manual push's pre-filter invariant (section 10), the 30-child
bound, the web's one-enqueuing-slice rule, the fan-out's per-firing cost or a pre-filter for it, and
whether the fan-out at `dry-run` should enqueue exactly like `on` (today it does; the reconcile's
dry-run enqueues nothing).

## 19. Accepted residuals

- A conta re-pointed to another depósito is seen within the 15-minute caches per warm instance;
  until then a send may go to the old depósito, and the depósito-change run sends last.
- The single-file queues narrow two runs of one produto overlapping, not eliminate it: an abandoned
  dispatch still running, or a rare duplicate delivery. Each PUT carries an ABSOLUTE quantity from
  its own fresh read, so the last one landing stands — possibly the one built on the older read —
  and the next event or the reconcile re-covers it.
- The fan-out re-sends kits already at 0, once per firing (section 8).
- A retried fan-out or a lost reconcile checkpoint leaves reserved slot instants unused: latency,
  never load.
- A kit whose component moves through a non-zero-crossing change with more kits than the eager
  ceiling, and every bulk send's drift, wait for the next reconcile: at most 24 h.
- The store's behaviour with pending reservations under a rewritten `quantidade`, and the PUT path
  form, are not live-proven; the first real write is a canary.
- Rollback restores only a non-negative quantity under the four fixed leaves (section 5).
- An already-resolved recusado aviso keeps the clock its closing run left, so a refusal from a run
  that STARTED earlier but ends later (only an abandoned overlapping dispatch can) reopens it; the
  next run under `on` that ends written or reflected closes it again.
