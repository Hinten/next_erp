# The daily FULL stock reconcile (step 12, PR 12-g)

One chain of time-boxed reads-queue slices covers every Loja Integrada conta: the ERP side
(`erp`), the store's stock list (`li`), the sends (`fila`), the avisos (`fim`). There is no light
mode: every run is FULL. This is the reconcile in depth; the whole stock sync, and how this part
fits it, is [`../README.md`](../README.md). The invariants an agent must not break are in
[`apps/loja-integrada/CLAUDE.md`](../../../../CLAUDE.md), "Stock sync (step 12)"; the operator
notes are in [`functions/DEPLOY.md`](../../../../functions/DEPLOY.md) ("The daily stock reconcile
… stops at the valve").

## 0. Files

| File                      | Role                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `agendamentoReconcile.ts` | The nightly start: valve, then ONE named first slice.                                                            |
| `agendadorReconcile.ts`   | The reads-queue producer, pure: tasks `li-<execucaoId>-<seq>`, the three delays.                                 |
| `despachoReconcile.ts`    | ONE slice: payload, valve, cap, the decision, the phase machine, the checkpoint, the hand-off, the last attempt. |
| `execucaoReconcile.ts`    | The run document: the decision, the take, every batch, the lease.                                                |
| `orcamentoReconcile.ts`   | The slice's time budget: the import's 70 + 30 s, one rule (`cabeNoOrcamentoMsLi`).                               |
| `caminhadaVinculos.ts`    | One page of the key walk over every link document.                                                               |
| `faseErp.ts`              | One page of links evaluated for every conta at once.                                                             |
| `snapshotReconcile.ts`    | A slice's per-conta state, and the snapshot entries' precedence.                                                 |
| `mapaKitsReconcile.ts`    | The kits map writer (headers, shards, the sweep of another run's).                                               |
| `faseLi.ts`               | The store phase, one unit at a time: the list walk, the lookups, the confirmations.                              |
| `candidatosReconcile.ts`  | The run's candidate list and its byte budget.                                                                    |
| `filaReconcile.ts`        | The queue phase and the safety gate.                                                                             |
| `fimReconcile.ts`         | The end: avisos and `ultimoReconcile`.                                                                           |
| `contasReconcile.ts`      | The uncached re-read of the run's contas, and the release's depósito revision.                                   |
| `gatilhoDepositoLi.ts`    | The depósito-change arm of the conta trigger.                                                                    |
| `reconcileManualLi.ts`    | The operator's "reconcile now" (PR 12-h), the core of `POST …/conta/[id]/estoque/reconciliar`.                   |

In `functions/src/`: `reconciliarEstoque.ts` (`onSchedule('23 4 * * *')`, America/Sao_Paulo,
`retryCount: 3`, 60 s), `depsReconcileEstoque.ts` (the ONE place a slice's deps are bound: the
environment passed whole and live, the clock, `inicioMs`, the pacer's sleep, the tier-0
`increment`, both producer roots built only when an enqueue is due, the logger), the
`estoque-reconcile` arm of `filaLeitura.ts` and the producer root in `agendador.ts`. The run
document's schema is `packages/schemas/src/reconcileEstoqueLojaIntegrada.ts`; the per-conta
documents' is `sincEstoqueLojaIntegrada.ts`.

## 1. How a run starts

Four ways, each enqueuing ONE named first slice `{ tipo: 'estoque-reconcile', execucaoId, seq: 0 }`
on the reads queue `filaLeituraLojaIntegrada`, delay 0:

| Start                                            | Run id                                         | Reads                                                                 |
| ------------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------- |
| The nightly schedule, 04:23 São Paulo            | `estoque-reconcile-<AAAAMMDD>`                 | NOTHING                                                               |
| The conta trigger's depósito arm (section 10)    | `estoque-reconcile-deposito-<µs of the write>` | NOTHING                                                               |
| The operator route (PR 12-h, App Hosting)        | `estoque-reconcile-manual-<minute ms>`         | the conta (uncached) and the run document's lease, masked to 4 fields |
| A release that saw a depósito change (section 9) | `estoque-reconcile-redeposito-<µs>`            | the release's one listing                                             |

- **The nightly start** (`agendamentoReconcile.ts`): valve `off` ⇒ nothing; else ONE task
  `estoque-reconcile-<AAAAMMDD>` seq 0, the date being the SCHEDULE TIME's civil date in São
  Paulo, so a Cloud Scheduler retry of the same night names the same run and the same task (one
  run per night); only a schedule time that does not parse falls back to the clock, with ONE
  WARNING. An answered already-exists is success; the closed sweep-only valve is ONE WARNING; a
  transient enqueue failure rethrows for the Scheduler's retry. The minute 23 is one no other
  schedule of this codebase fires at (`functions/src/index.test.ts` computes it).
- **No start is GATED on the read switch** (the approved design; the operator route only REPORTS
  it, as `chamadas` in its 202): with it off the run's ERP side still rebuilds the snapshot and the
  kits map every night — the stock trigger's eager kit sends and zero-crossing fan-out read that
  map (no header ⇒ `nenhum`), so gating the start on the switch would leave every kit listing
  without event-driven sends from the moment the switch goes `on` until a run completed after it —
  and every store phase stops at the switch. That is also how the run's cost is measured on
  staging before the window.
- **Task names** are `li-<execucaoId>-<seq>` (`idTarefaReconcileEstoqueLi`), derived from the
  payload, never passed in: a scheduler retry, a retried slice re-enqueueing its successor and the
  continuation repair all enqueue the SAME task. A duplicate that slips past the name finds the run
  document's `seq` already moved and does nothing.
- **Delays** are the import's three values, never a knob: `0` (a first slice), 2 s (an ordinary
  hand-off, so an order-intake task already waiting runs first) and 60 s (after a 429, and for
  every hand-off whose owner's delay is unknown — the repair). Anything else is refused before the
  queue is resolved (`RangeError`). The functions emulator ignores `scheduleDelaySeconds`
  (firebase-tools#8254): pinned offline only.
- **Rejections** follow the import's producer contract: an answered
  `functions/task-already-exists` is success; the closed valve is `LiTarefasDesligadasError`; a
  transient Cloud Tasks failure `LiTarefasTransitoriasError`; anything else rethrown as thrown.

## 2. The run document and the slice's decision

`reconcileEstoqueLojaIntegrada/atual` (ONE top-level document, admin-only) holds the run:
`execucaoId`, `iniciadoEmMs` (the avisos' clock), the lease `emExecucaoAteMs` (0 = free), `seq`
(the dispatch the next slice must carry), `fase`, `contas` (processing order), `idxConta`, the
walk's cursor `walk`, `candidatos`, the run's counters `contadores`, and the global stagger slot
`proximoSlotMs`, which the kit fan-out writes too (`../README.md`, section 8, "Kits: the map, the
eager path, the fan-out and the global slot").

A slice, after its payload, valve and cap (zero reads each; section 3), reads the document and
decides (`execucaoReconcile.ts`):

- the SAME run:
  - `executar` — `seq` equal and the lease held (an expired lease of our own run still runs:
    expiry only lets ANOTHER run take it);
  - `continuacao` — `seq` one behind while the lease is held: its end checkpoint landed and its
    hand-off may have failed, so the stored `seq` is re-enqueued at 60 s, nothing else;
  - `revisao` — `seq` one behind a RELEASED lease: the depósito re-run is asked for again from the
    stored counter, nothing else (the repair of a release that landed behind an error);
  - anything else ⇒ `nada` (a stale chain, or a late duplicate of a run already released);
- ANOTHER run, only at seq 0 (any other ⇒ `nada`):
  - a document that does not parse ⇒ `assumir`, abandoned (ONE ERROR line); no run ever (a
    document the kit fan-out created for its slot alone) ⇒ `assumir`;
  - the stored run STARTED in the same minute window ⇒ `adiar`, a retryable throw — so two runs
    never share the stock queue's naming window;
  - the lease free ⇒ `assumir`; expired, or held by a run started more than 48 h ago ⇒ `assumir`,
    abandoned (ONE WARNING each); otherwise `ocupado` (one INFO line): the running chain wins.

**The take** (`assumir`) lists the active Loja Integrada contas with a depósito, in the listing's
order (an active one without a depósito: one WARNING), and fixes each one's depósito in its root's
`execucao` (a run never reads two depósitos for one conta); the take resets the run's counters.
With no conta the run is released at once (`sem-contas`, one INFO line).

**Every write rides the run document's precondition** (one batch; root `CLAUDE.md` rule 7, tier
1): the run document `update(patch, { lastUpdateTime })` on the slice's own read, advance-only
(a chain that finds no document starts with a `create`), and every per-conta document the slice
changed in the SAME batch — a root or bucket `create`d when absent, else `update`d under the
slice's own read of it; a kits header or shard `set` whole or deleted with no precondition of its
own. At most 400 writes a batch. When the precondition is lost:

- a slot-only change by the kit fan-out ⇒ the SAME batch re-applied (the slot kept), up to 5
  attempts;
- our own landed batch with a lost reply ⇒ recognised (`guardaOPatchLi`), never re-advanced;
- the lease gone (another run took it, the slice's `seq` moved, released) ⇒ `parado`, nothing
  written, no throw;
- another dispatch of the same `seq` ⇒ `LiReconcileEstoqueConcorrenteError`.

⚠️ **A slice NEVER writes `proximoSlotMs`**, and nobody deletes the document: it holds the slot.

## 3. One slice

1. The payload, strict (`tarefaReconcileEstoqueLiSchema`): one that does not parse is DROPPED,
   zero reads.
2. The valve `LOJA_INTEGRADA_MODO_ESTOQUE`: `off` — unset, blank, a typo (one WARNING) — returns
   with zero reads. `dry-run` and `on` run alike up to the queue phase.
3. The cap `LOJA_INTEGRADA_ESTOQUE_MAX`: unreadable ⇒ ONE ERROR and zero reads (the diff applies
   it, and every send would refuse it).
4. The run document and the decision (section 2).
5. The PHASE MACHINE, one unit at a time while its worst case fits the budget
   (`orcamentoReconcile.ts`): `erp` (section 4; then, per conta, the kits map, section 5), `li`
   (section 6), `fila` (section 8), `fim` (section 9).
6. ONE end-of-slice checkpoint: the run document (`seq + 1`, the lease extended by 1 h, or
   released at `fim`) and every per-conta document the slice changed, in ONE batch; then the NAMED
   continuation `(execucaoId, seq + 1)`, 2 s later — 60 s after a 429 PAUSE of the store phase.
   The release bumps `seq` too, so a late duplicate of a run's last slice is refused.

**The budget.** A slice rides the reads queue beside order intake and the product import, so it is
held to the import's own ceiling: a unit starts only while its WORST case still ends inside 70 s,
and the last 30 s are left to the checkpoint and the hand-off (100 s, the SAME constant;
`functions/src/index.test.ts` pins the intake ladder with ONE reconcile slice as a co-tenant, so an
intake attempt waits at most one slice whatever the number of contas). Elapsed time counts from
the slice's FIRST statement, the run document's read included.

| Unit       | What                                                                                                                                              | Worst case                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `erp`      | one page of the link walk: the key query, the page's produtos (masked), their records at every run conta's depósito, the never-had-stock listings | 20 s, nominal                    |
| `mapa`     | one batch of the kits map writer, with the lease                                                                                                  | 20 s, nominal                    |
| `chamada`  | one Loja Integrada call of the list walk: a page, or one product's stock detail                                                                   | 2 s pacer + 20 s deadline = 22 s |
| `consulta` | the lookups of ONE page's unknown rows and the evaluation of the produtos they find                                                               | 20 s, nominal                    |
| `lote`     | one queue-phase batch: ONE slot reservation of at most 100 instants, then the enqueues 20 at a time                                               | 30 s, nominal                    |
| `fim`      | one conta's end: its avisos and `ultimoReconcile`                                                                                                 | 20 s, nominal                    |

The nominal rows are budgets, not measurements: every Firestore call carries the SDK's deadline,
the queue's 300 s timeout is the hard ceiling, and a slice the platform cuts resumes from its last
checkpoint. The owner's staging run confirms or corrects them (`../README.md`, "Staging
measurements to record").

## 4. The ERP phase (`erp`)

- **The key walk** (`caminhadaVinculos.ts`): `select` + `orderBy(documentId())` +
  `startAfter('<full path>')` + 300 on the collection group `produtolojaintegrada (__name__ ASC)`,
  a PERMANENT index (pinned by `caminhadaVinculos.indexes.test.ts`, and listed permanent by
  `tools/migrations/src/keyWalks.indexes.test.ts`). The cursor is always the page's last link; a
  full page's trailing produto is completed by its own where-less listing and skipped on the next
  page; only `produtos/{p}/produtolojaintegrada/{l}` counts. `walk.concluida` says the walk read
  its last page (the kits map writer runs next).
- **Per page** (`faseErp.ts`, every conta at once): the links alone first (`pai` ⇒ the conta's
  `pais`, `nao-suportado` ⇒ `ns`, `vinculo-ambiguo` ⇒ `amb` per id, nothing read); ONE masked
  produtos `getAll` (≤ 300); parity ⇒ `par` (no record read); ONE `lerRegistrosNoDepositoLi` per
  depósito (the send run's reader, generalised: canonical ids by `getAll`, the join, the
  own-collection query, 20 at a time); the plan; the never-had-stock listing only on
  `consultar-estoques`.
- **Snapshot precedence** (`snapshotReconcile.ts`): two produtos on one store id meet in the
  snapshot ⇒ `dup` (an `x` never counts as a produto). A store kit's entry carries its composition
  (`q`, `e`), so the kits map is written from the snapshot alone.
- **The run's read-path counters** — `erpProdutosLidos`, `erpCanonicosAchados`,
  `erpCanonicosAusentes`, `erpJuncoes`, `erpConsultasProprias`, `erpListagensSemEstoque` (the
  records reader's `aoContar` sink) — say which path each produto took; the end line carries them,
  for the staging measurement.

## 5. The kits map writer (`mapaKitsReconcile.ts`)

Per conta, bounded and resumable (`execucao.mapa` is its cursor): components in id order, ONE
batch per unit with each component's header AND all its shards (≤ 400 writes and about 4 MB a
batch), so the read side's `completa` holds when it lands; then the sweep of every header and
shard of another run (listings projected to `execucaoId`); then ONE INFO line with the
kits-per-component histogram. ⚠️ The header is the map's commit point: a header and its shards are
never split across batches. Only the lease holder writes the map.

## 6. The store phase (`li`)

Per conta in `contas` order, Loja Integrada ONLY through the context loader (`estrutura.test.ts`
walks the task path):

- **The context FIRST** (its read switch): off ⇒ one `chamada-bloqueada` line, zero reads, the
  conta skipped and counted `c<idx>ChamadasDesligadas`, the chain goes on. The conta's other
  refusals skip it the same way (one WARNING).
- **The list walk**: one page per call (`lerPaginaEstoqueLi`), `limit` =
  `LOJA_INTEGRADA_ESTOQUE_LIMITE_PAGINA` (default 100, clamped to the schema's 100; unreadable ⇒
  100 and ONE WARNING per run), read when a conta's walk starts and kept in its cursor (the root's
  `reconcile { offset, limite, iniciadoEmMs }`): a cursor started at or after the run is THIS
  run's and resumes at its offset (a run cut at page 13 of 25 resumes at 13); any other is another
  run's, and the walk starts over at 0 with no store id seen. A page's `next` is never followed as
  a path: its validated offset is, and `null` ends the walk. A page counts only once complete.
- **Per row**: a parent's id ⇒ counted only. Otherwise SEEN (`execucao.vistos`) and diffed by the
  plan's one rule (`diffLinhaEstoqueLi`, the cap applied there): out of step on a `v` entry ⇒ a
  candidate `{c, i, p, d}` and ONE INFO line (ids and the row's numbers) in every valve mode.
- **Rows no entry names** ⇒ the page's lookups, a budget unit of their own; no room ⇒ the page is
  dropped whole and read again first by the next slice. `consultaVinculosDaContaPorIdsLi` (15 ids =
  30 values per stored conta form, the builder the send run's duplicate probe uses, on the declared
  `(contaLojaIntegrada, id)` group index); the produtos found are evaluated by the ERP phase's
  evaluator; none ⇒ `x` (cached, so the steady state looks nothing up).
- **The anomaly block**: more counting links found than max(50, 2% of the rows read) ⇒ the conta is
  BLOCKED (`c<idx>BloqueioForaDoSnapshot`), ONE ERROR, nothing of it enqueued.
- **An unreadable row is never "no row"**: with a produto it is seen; without one (or a readable
  row naming none) the conta's unseen check and `x` sweep are skipped this run.
- **Unseen linked entries**: the store's list is unordered and read by offset, so a row can shift
  across a page boundary while it is read — a linked child the walk never saw is UNKNOWN, never "no
  row". After the walk each linked entry never seen gets ONE paced detail GET (≤ 200 per conta, the
  rest counted `naoConfirmados`; 404 ⇒ `sem-linha-na-loja`, counted and sampled; a row of that
  product ⇒ diffed; another product's row, or a body off its schema, settles it unread). Each
  settled id is recorded as seen, so a resumed slice never asks twice. Then the unseen `x` entries
  are dropped: the store no longer lists those rows.
- **Failures**:
  - 429 ⇒ a pause (checkpoint, next slice at 60 s); past `MAX_PAUSAS_429_LI` (10) the conta is
    skipped;
  - 401/403 ⇒ the shared mapper parks the conta, skipped;
  - 5xx, the deadline, the network, a malformed envelope, a paging stop, Firestore ⇒ a progress
    checkpoint at the SAME `seq`, then the original error rethrown (the retry resumes at the
    failed page) — on the queue's last attempt that conta is ended instead (one ERROR) and the
    chain goes on;
  - a DETERMINISTIC refusal of the conta's request (a 404 or another 3xx/4xx on the list, another
    3xx/4xx on a confirmation's detail GET, a `LiConfigError`) ends that conta on EVERY attempt
    (one ERROR `recusa-da-loja` naming the `operacao`, counted) — ONE chain serves every conta, so
    a rethrow would stop every conta after it, every night; a refused detail id is never settled,
    so `sem-linha-na-loja` stays unresolved (conservative);
  - a coding bug stays loud.

## 7. The candidates (`candidatosReconcile.ts`)

The rows to send live in the run document under a 600 000-byte budget
(`MAX_BYTES_CANDIDATOS_RECONCILE_LI`), one per conta and store id, each about 30 bytes: `c` (the
conta's index), `i` (the store id), `p` (the ERP produto), `d` (the store's effective quantity
minus S; positive is over-advertising). When full, the lowest `d` goes first. The send run
re-derives everything; `d` only orders.

## 8. The safety gate and the queue phase (`fila`, `filaReconcile.ts`)

- **The safety gate** (once, at the queue phase's start, in EVERY valve mode): a conta whose
  `zeroPorDeposito × 100 > 5 × avaliados` — more than 5% of its evaluated children have a record
  elsewhere and none at its depósito, which would push 0 everywhere — gets NONE of its candidates
  enqueued: ONE ERROR `deposito-sem-registros` and, under `on`, the vinculo aviso of that motivo
  (count + sample; the web renders it). Exactly 5% passes. Held never-stocked children are not in
  the numerator. The store phase's anomaly block (`bloqueioForaDoSnapshot`) blocks the same way.
- **A valve not exactly `on`** ⇒ NOTHING enqueued, no slot write, ONE summary INFO line per conta
  (the per-candidate lines are the store phase's), the list cleared.
- **Under `on`**: the contas read again UNCACHED (before each slice too) — a conta gone, inactive
  or whose depósito moved since the take loses its candidates (ONE WARNING), and one re-pointed at
  ANOTHER depósito (not left with none) is recorded for the release's re-run; the canary by the
  send run's own `decidirAlvo` (candidates outside it counted `foraDoCanario`); the list SORTED
  once, over-advertising first.
- **Batches** of ≤ 100 of ONE kind (`LOTE_FILA_RECONCILE_LI`): ONE reservation of exactly the
  batch's size on the global slot (`reservarSlotGlobalEstoqueLi`, whose read is MASKED to
  `proximoSlotMs`), so the slot advances by exactly m × 17 s for m sends; each `estoque` send
  (`origem: reconcile`, ids only, a kit's `estoqueIds` from its entry's `e`, and the run's
  `depositoId` for the conta) named by the RUN's window and scheduled at exactly its instant
  (`../agendadorEstoque.ts`'s header carries the naming proof; the `adiar` rule makes the window
  unique per run).
- **The horizon**: a batch that does not over-advertise reserves only instants within 12 h
  (`ateHorizonteMs`, the slot's own horizon constant) and the rest is DEFERRED to the next night
  (`adiadosHorizonte`). Over-advertising batches always go, bounded only by the slot's 29-day
  limit: `slot-esgotado` ⇒ ONE ERROR, nothing enqueued.
- **Progress**: enqueued (and strictly refused) rows leave the list in the slice's checkpoint; a
  transient failure (Cloud Tasks, the slot's contention, Firestore) checkpoints what landed and
  rethrows — on the last attempt the rest is counted `naoEnfileirados` and the run goes to its end;
  the sweep-only valve closed ⇒ ONE WARNING, the list dropped.
- **Residual**: a slice whose end checkpoint does not land leaves its batches' instants reserved
  but unused; the retry re-reserves for every batch it re-meets (up to about 57 min of slot per
  lost checkpoint). Latency, never load. Persisting the list per batch would close it at one
  run-document write per batch; the staging measurement decides.

## 9. The end (`fim`, `fimReconcile.ts`) and the release

Per conta in `contas` order, one unit each. Every conta is read again, uncached, with its root:

- a conta GONE (or no longer a Loja Integrada one) gets nothing — no root write, no aviso; the
  expiry sweep's orphan pass closes its rows;
- an inactive or re-pointed conta gets its `ultimoReconcile` but NO aviso;
- otherwise, under `on` and a valve live for the conta (`valvulaLigadaParaContaLi`: `*` or a canary
  entry of the conta), each row is raised on a count or resolved — only when OPEN (one read; a
  write only on a real open → resolved transition, never a seeded resolved row) — on none, clocked
  by the RUN's start (`relogioDoEnvioDeEstoqueUs`), so an older run can neither reopen nor close a
  newer one's row. A raise replaces `params` (the count and the sample, up to 200 produto ids,
  sorted). Not live for the conta ⇒ no aviso read or written: ONE INFO line per non-zero row (count,
  sample), which is what a dry-run review reads.

| Aviso                                        | Count                                         | Resolved when                                                                                                                                                    |
| -------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lojaIntegradaEstoqueSemErp`                 | `retidos`                                     | 0                                                                                                                                                                |
| `lojaIntegradaEstoqueVinculo` `ambiguo`      | `ambiguos`                                    | 0                                                                                                                                                                |
| … `duplicado`                                | `duplicados`                                  | 0                                                                                                                                                                |
| … `ausente`                                  | `ausentes`                                    | 0                                                                                                                                                                |
| … `estoque-ambiguo`                          | `estoqueAmbiguo`                              | 0                                                                                                                                                                |
| … `deposito-sem-registros` (the safety gate) | `zeroPorDeposito`, only when the gate tripped | the gate did not trip                                                                                                                                            |
| … `sem-linha-na-loja`                        | `semLinhaNaLoja` (each confirmed by a 404)    | 0, and ONLY when the conta's list was read whole AND every unseen linked child confirmed; a conta whose store phase was skipped or cut short leaves it untouched |

`ultimoReconcile` — `{ execucaoId, iniciadoEmMs, concluidoEmMs, contadores }`, the conta's
counters of the run (`c<idx><Nome>`) with the prefix taken off (`c1` never takes `c10`'s) — and the
list cursor cleared (`reconcile: null`), in the slice's batch under the root's own read (through
the loaded state when the slice holds it, so the root is written once). The machine resolution's
motivo is `conferencia-sem-casos`.

**The release.** Its slice first LISTS the contas once more (`contasReconcile.ts`) — an active
conta whose depósito is not the one the run fixed, or an active conta with one that the run did not
take (never a conta created during the run and not written since) — and stores what it found in
the release patch's counters (`depositoMudouEmUs`, beside the queue phase's own record). AFTER the
release lands, ONE full run `estoque-reconcile-redeposito-<µs>` is enqueued (after, so its first
slice never meets this run's lease); a failure is one line, never a rethrow (the run is already
released). A release that landed behind an error is repaired by the retry's `revisao` (section 2).
The reads queue's one-at-a-time dispatch keeps any depósito-arm run out of the gap between the
listing and the release.

## 10. Depósito changes

**The depósito-change arm** (`gatilhoDepositoLi.ts`, bound by
`functions/src/onIntegracaoLojaIntegradaChanged.ts`): an UPDATE of a Loja Integrada conta, not
inactive after it, whose folded depósito (`depositoDaContaLi`, either stored form) becomes another
one — none → D included — with the valve not `off` ⇒ ONE named first slice
(`estoque-reconcile-deposito-<µs of the AFTER side's update time>`, so an Eventarc redelivery names
the same task), zero reads, no read-switch check (that is how the ERP side runs before the window).
It never fires on a create (the nightly run bootstraps a new conta, and every emulator suite that
seeds a conta with a depósito does so by a create), a spelling change, a removal (`D → none`), a
delete, another channel's conta, an inactive conta, or a write that moves no depósito. The closed
sweep-only valve is ONE WARNING; a transient Cloud Tasks failure rethrows (the trigger runs with
`retry: true`, and the name keeps a retry idempotent).

**During a run.** A run holding the lease refuses the arm's run (`ocupado`, one INFO line); the
running chain catches the change itself (sections 8 and 9): worst case the rest of that chain plus
one full run. A chain released on its last attempt asks only for what its counter holds, one a
crash leaves to its lease's expiry asks for nothing, and a change otherwise unseen waits for the
next night.

**Sends already queued** are bound to their run's depósito: the send run drops one whose conta
names another (`deposito-mudou`, ONE WARNING), after one read past the conta cache. Within that
cache's 15 minutes a re-point a warm instance has not seen still sends at the old depósito — the
staleness every send run has — and the change's own run, scheduled behind those sends on the
global slot, sends last.

## 11. The last attempt

On the queue's last attempt a failure a retry could have changed — Firestore's, Cloud Tasks',
another dispatch of the same slice — is answered from a FRESH read instead, since no retry follows:

- a run still at this `seq` is released with ONE ERROR `tentativas-esgotadas` (the next night
  starts over: no store phase ever runs on a half-built snapshot);
- a run ONE `seq` ahead is handed off — with this slice's own delay when the stored document holds
  ITS end-of-slice patch, else as a courtesy at the conservative 60 s (that hand-off failing
  transiently releases it, ONE ERROR `tentativas-esgotadas`);
- a run this slice already RELEASED asks again for its depósito re-run.

Coding bugs stay loud on every attempt — rethrown, never swallowed — but on the last attempt the
lease is released first with ONE ERROR `falha-nao-retentavel` (the class only), so no
deterministic failure holds the lease for an hour. The same rule covers the two failures outside a
slice: the `continuacao` repair's hand-off (a transient failure releases the stored `seq` with ONE
ERROR `tentativas-esgotadas`; a coding bug releases it, then is rethrown) and a take that LANDED
behind its error (released with ONE ERROR, then the error rethrown). Every last-attempt release
logs its ERROR, and asks for the re-run its counter names, only once it LANDED (the closed valve's
release at a hand-off logs its WARNING the same way); another dispatch holding the run ⇒ nothing
released, logged or asked. A Firestore failure of the release itself leaves the lease to its
expiry (at most one hour past the last write).

## 12. What 12-g added to the 12-a contracts

In `packages/schemas`: the root's `execucao` (the depósito fixed at the take, `vistos`, the aviso
samples, the kits map writer's cursor `mapa`), a kit entry's `q`/`e`, the walk's `concluida`; the
write protocol (every per-conta write rides the run document's batch and precondition — a root
under its own read, a kits header or shard `set` or deleted with no precondition of its own, the
single lease holder's); the `revisao` decision; and the stock send payload's `depositoId`, EXACTLY
on `origem: reconcile` (producer and consumer are one codebase, and no reconcile send existed
before it). The schemas are bare: both rulesets regenerate with a zero diff. The store phase needs
no further field: whether a conta's list is complete, the confirmations made and the pauses taken
are the run document's per-conta counters (`c<idx>ListaCompleta`, …), which the take resets with
the run.

## 13. Operating it

`functions/DEPLOY.md` ("The daily stock reconcile … stops at the valve") carries the operator
notes: how to stop a running chain (the stock valve `off`; the lease frees within an hour), a
crashed chain, `recusa-da-loja`, `falha-nao-retentavel`, the backlog horizon and the page size.
