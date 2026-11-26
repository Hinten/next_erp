# Loja Integrada price sync (master plan step 13)

The price sync sends the price the ERP gives a LINKED store CHILD (or a simple root) to that
product in Loja Integrada: one `PUT /v1/produto_preco/{produto id}` per send run, through the write
engine (`../core/escrita.ts`), with the full price, the promotion (or the configured clear) and the
store's own custo and `sob_consulta` echoed back from the deciding read.

This file covers what exists today: the SEND RUN and its QUEUE (PR 13-d). The price function, the
fold and the aviso tipos are `@delfrance/schemas`' (PR 13-a); the wire and the body builder are the
package's (PR 13-b); the engine's two price kinds and the produto detail's restore projection are
PR 13-c's. Not built yet, each landing in a later PR of step 13: the price TRIGGER on an ERP produto
write, the NIGHTLY by-id read and its reconcile, the operator's routes ("Enviar preços",
"Atualizar preços") and the web. Until then nothing enqueues a price task but the send run's own
`deriva` follow-up.

It ships INERT. The price valve `LOJA_INTEGRADA_MODO_PRECO`, its canary list and the read switch
`LOJA_INTEGRADA_CHAMADAS` are unset today, so every run returns `desligado` with zero reads. No test
can call the store: this app's two vitest setups make a `fetch` to any non-local host throw, the
suites that script the store pass a `deps.fetch`, and in the emulator lane a dispatched send run
stops at the read switch (section 10). Every test value is INVENTED (`../testing/precoLi.ts`); no
capture of the store's prices is committed.

The rules an agent must not break before touching price code are the short list in
[`apps/loja-integrada/CLAUDE.md`](../../../CLAUDE.md), "Price sync (step 13)". Also:

- deploy, IAM, the runtime env block and the operator notes:
  [`functions/DEPLOY.md`](../../../functions/DEPLOY.md);
- the write engine's price kinds: the "Write engine" section of the same `CLAUDE.md`;
- the stock sync, whose send run this one mirrors step for step:
  [`../estoque/README.md`](../estoque/README.md);
- the step's plan text:
  [the master plan](../../../../../.master_plans/loja-integrada/loja-integrada-marketplace-integration.md),
  step 13.

## 1. At a glance

```text
 a price task {tipo: preco, contaId, produtoId, origem, janela, geracao, baixar}
        │   (today: only the run's own `deriva` follow-up enqueues one)
        ▼
 filaPrecoLojaIntegrada  (functions/src/filaPreco.ts; options = the stock queue's)
        │
        ▼
 processarTarefaPrecoLi  (processarPreco.ts)
   payload → valve → clear forma → conta + tabelas → produto + links → parent
   → target (precoAlvoLi) → duplicate probe → target decision → write context
   → deciding GET /v1/produto/{id}/ → plan (planoPrecoLi.ts)
   → ONE PUT /v1/produto_preco/{id} → read-back (event-like origins) → ≤ 1 deriva
```

## 2. Files

| file                                       | what                                                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `processarPreco.ts`                        | ONE send run, in the stock run's order and shape; the outcomes the queue's line reads               |
| `planoPrecoLi.ts`                          | pure: the write kind by origin, the guard on the deciding read, the no-lower and reflected decision |
| `leituraPrecoErp.ts`                       | the ERP reads: the masked produto and parent, and the stock flow's link listing and duplicate probe |
| `tabelasLi.ts`                             | pure: the conta's tabela refs folded to bare ids, and the bulk send's "same tabelas" check          |
| `configPrecoLi.ts`                         | the clear's forma, read from the environment the entry point passes                                 |
| `avisosPreco.ts`                           | the run's ONE aviso tipo, `lojaIntegradaPrecoRecusado`                                              |
| `agendadorPreco.ts`                        | the price-queue PRODUCER (pure; the transport handed in): window, name, schedule, strict payload    |
| `processarPreco.tasks.test.ts`             | the emulator round trip (section 10)                                                                |
| `../../../functions/src/filaPreco.ts`      | the queue: `tipo` dispatch, the dispatch-start stamp, one line per dispatch                         |
| `../../../functions/src/agendadorPreco.ts` | the producer's composition root (the region and the sweep-only valve through the reads root)        |
| `../../../functions/src/depsEscrita.ts`    | `depsDePrecoLi`: the run's deps, bound beside the writes and stock queues'                          |

## 3. The data

- **The task** (`packages/schemas/src/tarefaPrecoLojaIntegrada.ts`): a STRICT ids-only payload —
  `contaId`, `produtoId`, `origem`, `janela`, `geracao` (1 exactly for a `deriva`), `baixar` (may
  this run lower what the buyer pays), and the tabela ids exactly on a bulk origin (`reconcile`,
  `atualizacao`). A price, a custo or any other key is refused (`payload-invalido`, zero reads).
- **The conta's tabelas** (`tabelasLi.ts`): `tabelaNormalOuterRef` and `tabelaPromocionalOuterRef`,
  each stored canonical (`documents/listaDePrecos/<id>`) or bare (`listaDePrecos/<id>`), fold to the
  same bare id; anything else names no tabela. A conta with no normal tabela is skipped
  (`sem-tabela`). The run hands the RAW pair to `precoAlvoLi`; only the bulk check folds a
  promotional tabela equal to the normal one to `null`, on both sides.
- **The clear's forma** (`configPrecoLi.ts`, `LOJA_INTEGRADA_PRECO_PROMO_LIMPO`): how a CLEARED
  promotion goes on the wire — `nulo` (JSON `null`, the default for unset or blank), `zero` (0) or
  `igual-cheio` (the full price, a window-only fallback). Spelled exactly; anything else refuses
  every run (`forma-invalida`, one ERROR line, zero reads).

## 4. The target and the plan

- **The target** is `precoAlvoLi` (`@delfrance/schemas`): the child's own normal-tabela price, or
  its parent's when the parent propagates (the child rule), the promotion likewise, both in integer
  centavos. A produto it cannot price is HELD (`retido`: `sem-preco`, `ilegivel`, `pai-ausente`):
  the store keeps its own price. The ERP reads are masked to exactly what it reads (`paiId`,
  `precos`, `propagatePriceToChildren`) — no custo, no kit fields.
- **The kind by origin** (`tipoEscritaDaOrigemPrecoLi`): `evento`, `manual`, `publicacao` and
  `deriva` write `preco-produto`, read back by their own GET; `reconcile` and `atualizacao` write
  `preco-produto-lote`, with no read-back call (the engine's `eco` line is the only same-run
  evidence; the nightly by-id read will be their read-back).
- **The guard on the deciding read**, first hit wins: the detail's `id` is not the product asked
  (`linha-divergente`, one ERROR); not a variation (`nao-e-variacao`); `removido` or `bloqueado`
  true (dropped) or not a boolean (`guarda-ilegivel`, fail closed); `preco_sob_consulta` not a
  boolean (`sob-consulta-ilegivel` — the engine would refuse the write as a `TypeError`). `ativo`
  is NOT read: an inactive child is priced.
- **The decision**, in integer centavos against the deciding read: an unreadable current price ⇒
  `atual-ilegivel` (skipped, whatever `baixar`); the store already shows the target ⇒ `refletido`
  (custo and `sob_consulta` never compared); with `baixar` false, a lower full price, a lower
  positive promotion or a lower EFFECTIVE price (min of the full price and a positive promotion —
  so a new promotion where the store shows none) ⇒ `nao-baixado`, with the leaves that went down; a
  clear always passes. Otherwise the builder inputs: the target, the forma, and the deciding read's
  OWN `preco_custo` and `sob_consulta`, echoed.
- **The custo is never the ERP's.** The store's own custo is echoed: `null` ⇒ the key is omitted
  (the common case); one the package's builder cannot echo (a negative number, or decimal text) ⇒ omitted, still sent,
  with ONE WARNING `custo-omitido`; one the restore line cannot carry verbatim (non-decimal text, a
  boolean, an object) ⇒ the engine answers `sem-restauracao`, no PUT, ONE ERROR naming the produto —
  that produto's price is blocked until its store custo changes.

## 5. The send run (`processarPreco.ts`)

Every skip before the write context costs zero credential reads and zero store calls.

| #   | step                                                                      | stops with                                                                                                     |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | the payload, strict                                                       | `payload-invalido`                                                                                             |
| 2   | the valve (`iniciarEscritaLi`, the `preco` flow)                          | `desligado`                                                                                                    |
| 3   | the clear's forma                                                         | `forma-invalida` (ERROR `forma-promo-invalida`)                                                                |
| 4   | the conta (cached; a bulk send whose cached conta differs: one re-read)   | `conta-inexistente`, `conta-inativa`, `sem-tabela` (WARNING), `tabela-mudou` (WARNING)                         |
| 5   | the produto and its own links, together                                   | `produto-inexistente`                                                                                          |
| 6   | the links alone (`vinculoDaContaLi`)                                      | `sem-vinculo`, `pai`, `nao-suportado`, `vinculo-ambiguo`                                                       |
| 7   | only now the parent, for a valid parent id                                | —                                                                                                              |
| 8   | the target (`precoAlvoLi`)                                                | `retido` (WARNING with the reason)                                                                             |
| 9   | the duplicate-link probe                                                  | `vinculo-duplicado` (WARNING)                                                                                  |
| 10  | the target `<conta>:<store id>` and its decision                          | `alvo-invalido` (ERROR)                                                                                        |
| 11  | the write context (the read switch first, then the conta, the credential) | its refusals drop (`chamadas-desligadas`, `credencial-ausente`, …)                                             |
| 12  | the deciding GET of the produto detail                                    | `ausente` on a 404 (WARNING)                                                                                   |
| 13  | the plan                                                                  | the guard's outcomes, `atual-ilegivel`, `refletido` (resolves the refusal row), `nao-baixado`                  |
| 14  | the ONE write, by origin                                                  | `nao-enviado` (dry-run, canary), `sem-restauracao` (ERROR), the error table                                    |
| 15  | a landed lote resolves; a landed `preco-produto` is read back             | `escrito-lote`; `escrito` with its follow-up (`nenhum`, `enfileirado`, `tarefas-desligadas`, `sem-seguimento`) |

**The read-back and the ONE follow-up.** A read-back is VERIFIED only when it read the detail and
that detail names the product asked. Verified and as written ⇒ the refusal row resolves
(`nenhum`). A drift — or a read-back that could not be made, or names another product (fail open:
a reflected follow-up costs one read, a missed drift a wrong price) — on generation 0 enqueues ONE
`deriva` (generation 1, `baixar` inherited, the window read after the read-back); the sweep-only
valve closed ⇒ one WARNING, the write stands. On generation 1 it never enqueues another (one ERROR
`deriva-sem-seguimento`), and under `on`, only when the read-back was VERIFIED, raises the aviso
`nao-refletido` — without resolving the row first, because the aviso clock drops a raise behind a
same-run resolve. So no loop is possible.

**The refusal aviso** (`lojaIntegradaPrecoRecusado`, one row per produto, `atencao`) is raised and
resolved only when the target decision is `on`. It is RESOLVED exactly by `refletido`,
`escrito/nenhum` and `escrito-lote` — read first, written only when open — and never by a skip, a
refused lowering, a drift or a dry-run.

## 6. The queue and the task names

- **`filaPrecoLojaIntegrada`** (`functions/src/filaPreco.ts`) is the fourth task queue of the
  functions codebase, with options IDENTICAL to the stock queue's (`functions/src/index.test.ts`
  pins the equality): one dispatch at a time, one instance serving one request, 3 attempts with a
  flat 300 s backoff, a 300 s timeout. A queue of its own: a whole-catalogue reprice would hold the
  status write-back for about a day on the writes queue, and every stock send on the stock queue.
- It dispatches on the RAW `tipo`: `preco` runs one send run, anything else is dropped
  (`tipo-desconhecido`) with one line. Its ONE line per dispatch carries the raw ids one by one,
  `baixar`, the attempt, the outcome's kind and its detail; a run that throws writes no line.
- ⚠️ **The export name IS the queue name** (`FILA_PRECO_LI`, asserted at module load): renaming it
  creates a NEW queue and strands the old one's tasks.
- **Names are the dedup** (`agendadorPreco.ts`): `preco-` + sha256 of
  `preco:<origem>:<conta>:<produto>:<b|n>:<janela>`, the window ⌊now / 60 s⌋ of a clock read right
  before the enqueue — the stock producer's window and schedule, by import. A task that may not
  lower a price never swallows one that may (the `b|n` bit); a follow-up never collides with the
  event that caused it. A bulk producer (later) names by its run's window and passes a not-before
  bound. An answered already-exists is success.

## 7. Costs (Firestore operations / credential reads / store calls)

Pinned in `processarPreco.test.ts`, child (a produto with a parent) and root (no parent: one ERP
read less after the links). Writes and enqueues are 0 unless stated.

| outcome                                                                                                                                              | child                | root                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | -------------------- |
| `payload-invalido`, `desligado`, `forma-invalida`                                                                                                    | 0/0/0                | 0/0/0                |
| `conta-inexistente`, `conta-inativa`, `sem-tabela`                                                                                                   | 1/0/0                | 1/0/0                |
| `tabela-mudou` (the eviction and one re-read)                                                                                                        | 2/0/0                | 2/0/0                |
| `produto-inexistente` and the link skips                                                                                                             | 3/0/0                | 3/0/0                |
| `retido` `pai-ausente` for a parent id that names no document (no parent read)                                                                       | 3/0/0                | —                    |
| `retido` after the parent read                                                                                                                       | 4/0/0                | 3/0/0                |
| `vinculo-duplicado` (the two probe queries)                                                                                                          | 6/0/0                | 5/0/0                |
| `chamadas-desligadas`                                                                                                                                | 6/0/0                | 5/0/0                |
| the other context refusals                                                                                                                           | 6/1/0                | 5/1/0                |
| dry-run, outside the canary, no canary                                                                                                               | 6/2/1                | 5/2/1                |
| after the GET, nothing sent (`ausente`, the guard, `atual-ilegivel`, `nao-baixado`, `leitura-ilegivel`, `sem-restauracao`, `refletido` outside `on`) | 6/2/1                | 5/2/1                |
| `refletido` under `on` (+ the refusal row's read)                                                                                                    | 7/2/1                | 6/2/1                |
| an event-origin PUT read back as written (`escrito/nenhum`)                                                                                          | 7/4/3                | 6/4/3                |
| an event-origin PUT, generation-0 drift                                                                                                              | 6/4/3, 1 enqueue     | 5/4/3, 1 enqueue     |
| an event-origin PUT, generation-1 verified drift under `on`                                                                                          | 6/4/3, 1 aviso write | 5/4/3, 1 aviso write |
| a bulk PUT (`escrito-lote`, + the refusal row's read)                                                                                                | 7/3/2                | 6/3/2                |
| a PUT refused on the LAST attempt (`recusado`)                                                                                                       | 6/3/2, 1 aviso write | 5/3/2, 1 aviso write |

An OPEN refusal row adds one write on a resolving outcome. The worst run is
`PIOR_EXECUCAO_PRECO_LI_MS` = 68 s (the deciding GET 4 s + 20 s, the PUT 20 s, the read-back 4 s +
20 s), measured by the run's timed grid; the PUT starts at most 24 s after the dispatch began.

## 8. Failures and the last attempt

The stock run's table, mirrored function by function (the stock module stays untouched):

| failure                                                                                                          | outcome                                                                                        |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 429, 5xx, network, the write deadline, the credential pin, our `LiConfigError`, gRPC, the builder's `RangeError` | THROWN: the retry re-derives everything from a fresh read (the PUT is absolute)                |
| the PUT refused with another 3xx/4xx                                                                             | rethrown until the queue's LAST attempt, then `recusado`, one ERROR and, under `on`, the aviso |
| 401/403 on a deciding read                                                                                       | the conta PARKS and the run drops (a 401 for an older token rethrows)                          |
| 401/403 on the PUT                                                                                               | the next deciding read on the same credential decides: refused ⇒ park; reads ⇒ the row above   |
| the deciding read off its schema (`formato`)                                                                     | `leitura-ilegivel`, one ERROR; an empty or non-JSON 200 rethrows                               |
| another 3xx/4xx on a read                                                                                        | rethrown until the last attempt, then `leitura-recusada`, one ERROR, no aviso                  |

There is no failure store: a task whose three attempts all meet a 429 or a 5xx is dropped (the
platform's error log is its only trace). Until the nightly read exists, only the next event of the
produto re-covers it.

## 9. Environment and valves

All read by the run itself from `deps.ambiente` (the functions codebase passes `process.env` whole
and live); see `functions/DEPLOY.md` for the runtime env block.

| variable                           | rule                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `LOJA_INTEGRADA_MODO_PRECO`        | the valve: only the exact `on` writes, the exact `dry-run` diffs; anything else (unset too) is `off` |
| `LOJA_INTEGRADA_CANARIO_PRECO`     | the targets an `on` valve writes to: unset = none, `*` = every target, else `<contaId>:<store id>,…` |
| `LOJA_INTEGRADA_CHAMADAS`          | the read switch: only the exact `on` lets the write context build a client                           |
| `LOJA_INTEGRADA_PRECO_PROMO_LIMPO` | the clear's forma (section 3): unset = `nulo`                                                        |
| `LOJA_INTEGRADA_TASKS_DISABLED`    | exactly `1` closes the producer: a drift follow-up is one WARNING, the write stands                  |

The App Hosting backend reads none of the price variables yet; the operator's routes (a later PR)
will, and both surfaces are then set alike.

## 10. The emulator lane

`processarPreco.tasks.test.ts` runs ONE send run IN PROCESS against the emulators
(`.github/workflows/ci-loja-integrada.yml`), the valve, canary and read switch on as a PARAMETER
only, against a scripted store: the real masked produto and parent reads, the where-less links
listing, the collection-group duplicate probe, and its one `deriva` follow-up through the real
producer root onto `filaPrecoLojaIntegrada` — the enqueue resolves only if the artifact registers
the queue. The lane's job env sets the price valve to `dry-run`, so that dispatched follow-up runs
its ERP reads and stops at its write context on the read switch, writing nothing: that hop is
unobservable by design, and the queue's options and dispatch are pinned offline. The suite seeds
its conta by a create, its own produtos and links (the anchor rules), and no stock record. The
emulator ignores the schedule (firebase-tools#8254).

## 11. Guards

| what                                                                         | pinned by                                                         |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| every cost of section 7, child and root; ≤ 1 PUT in every scenario           | `processarPreco.test.ts`                                          |
| the no-lower and reflected decisions against an independent oracle           | `planoPrecoLi.test.ts`, `planoPrecoLi.propriedade.test.ts`        |
| the mask is sufficient for `precoAlvoLi`                                     | `leituraPrecoErp.test.ts`                                         |
| the queue's options, their equality with the stock queue's, the export name  | `functions/src/index.test.ts`                                     |
| the dispatch, the bindings (the PRICE producer, the live env, the attempt)   | `functions/src/filaPreco.test.ts`                                 |
| the producer root's queue path, region and valve                             | `functions/src/agendadorPreco.test.ts`                            |
| five producer roots, each binding only its own queues                        | `estrutura.test.ts`                                               |
| the lane refuses the price valve `on` and a price canary; the job env itself | `testing/guardaDaLaneDeTarefas.test.ts`                           |
| the queue's `invoker`                                                        | `packages/config-eslint/rules/tasks-invoker-inventory.test.js`    |
| what `planoPrecoLi.ts` treats as the same price                              | `packages/config-eslint/rules/equivalence-fold-inventory.test.js` |
| the env variable is documented, never an `env:` row                          | `configPrecoLi.test.ts`                                           |

## 12. Deploy, IAM, indexes (listed, owner-run)

None of this is an agent's to run (root `CLAUDE.md` rule 8):

- deploy `functions:loja-integrada` only — one new function and its queue. It changes no behaviour:
  nothing enqueues a price task yet, and with the valve unset every run returns `desligado`;
- the new queue's enqueuer grant, per project, for each identity in `TASKS_INVOKER_SA` (the first
  deploy of a new queue crashes on that binding: `functions/DEPLOY.md`), then the same deploy
  re-run; verify both the queue's and the service's IAM policy;
- the index the duplicate probe rides, already declared for the stock flow:
  `produtolojaintegrada (contaLojaIntegrada, id)` READY. No new index.

## 13. Window items

- the consumer (this functions codebase) deploys before any price producer ships;
- the legacy app is off before the valve reaches `on`; the first real writes are a per-conta canary
  through the operator's manual push (a later PR of step 13);
- `LOJA_INTEGRADA_PRECO_PROMO_LIMPO` stays unset (`nulo`) unless the canary shows the store refusing
  it — then `zero`, and `igual-cheio` only as the last resort, set by a person.

## 14. Accepted residuals

- A store-panel edit of the full price or the promotion that lands between the deciding GET and the
  PUT is overwritten, by design: the ERP is the source of the price.
- The echoed custo and `sob_consulta` can revert a store-panel edit landing in that same gap.
- A task whose three attempts all meet a 429 or a 5xx is dropped; until the nightly read exists,
  only the next event of the produto re-covers it.
- A store custo the restore line cannot carry verbatim blocks that produto's writes until it
  changes (one ERROR per run).
- A refusal row of a produto unlinked after the refusal stands until the aviso retention closes it.
- A target past the builder's exact round trip (centavos far above any real price) is the builder's
  `RangeError`, thrown on every attempt and then dropped.
