# Loja Integrada price sync (master plan step 13)

The price sync sends the price the ERP gives a LINKED store CHILD (a variation; the ERP produto
itself may be a child or a root with no parent) to that product in Loja Integrada — a store
simple product is skipped (`nao-suportado`): one `PUT /v1/produto_preco/{produto id}` per send run, through the write
engine (`../core/escrita.ts`), with the full price, the promotion (or the configured clear) and the
store's own custo and `sob_consulta` echoed back from the deciding read.

This file covers what exists today: the SEND RUN and its QUEUE (PR 13-d), the price TRIGGER on an
ERP produto write, the queue's first producer (PR 13-e), and the ERP side of the NIGHTLY reconcile's
price arm (PR 13-f1, section 17), folded into the stock reconcile. The price function, the fold and
the aviso tipos are `@delfrance/schemas`' (PR 13-a); the wire and the body builder are the
package's (PR 13-b); the engine's two price kinds and the produto detail's restore projection are
PR 13-c's. Not built yet, each landing in a later PR of step 13: the nightly's by-id STORE read and
its queue phase (what re-covers what an event missed), the tabela re-point arm, the operator's
routes ("Enviar preços", "Atualizar preços") and the web. Until then a price task is enqueued only
by the trigger and by the send run's own `deriva` follow-up: the nightly's ERP side reads the ERP
and writes its own price state, and enqueues nothing.

It ships INERT. The price valve `LOJA_INTEGRADA_MODO_PRECO`, its canary list and the read switch
`LOJA_INTEGRADA_CHAMADAS` are unset today, so every produto write returns at the trigger's
zero-read gates and every run returns `desligado` with zero reads. No test can call the store: this
app's two vitest setups make a `fetch` to any non-local host throw, the suites that script the store
pass a `deps.fetch`, and in the emulator lane a dispatched send run stops at the read switch
(section 11). Every test value is INVENTED (`../testing/precoLi.ts`); no capture of the store's
prices is committed.

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
 an ERP produto write  produtos/{produtoId}   (every channel's produtos)
        │
        ▼
 onPrecoLojaIntegrada  (functions/src/onPrecoLojaIntegrada.ts → gatilhoPreco.ts)
   relevance (payload) → valve → anchor (payload) → conta map (cached)
   → a child: ≤ 1 masked parent read  |  a root: ≤ 1 family query per conta
        │   named tasks, ids only, origin `evento` (section 7)
        ▼
 a price task {tipo: preco, contaId, produtoId, origem, janela, geracao, baixar}
        │   (also: the run's own `deriva` follow-up)
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

| file                                             | what                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `processarPreco.ts`                              | ONE send run, in the stock run's order and shape; the outcomes the queue's line reads               |
| `planoPrecoLi.ts`                                | pure: the write kind by origin, the guard on the deciding read, the no-lower and reflected decision |
| `leituraPrecoErp.ts`                             | the ERP reads: the masked produto and parent, and the stock flow's link listing and duplicate probe |
| `tabelasLi.ts`                                   | pure: the conta's tabela refs folded to bare ids, and the bulk send's "same tabelas" check          |
| `configPrecoLi.ts`                               | the clear's forma, read from the environment the entry point passes                                 |
| `avisosPreco.ts`                                 | the run's ONE aviso tipo, `lojaIntegradaPrecoRecusado`                                              |
| `agendadorPreco.ts`                              | the price-queue PRODUCER (pure; the transport handed in): window, name, schedule, strict payload    |
| `relevanciaPrecoLi.ts`                           | pure: the trigger's relevance from the payload alone, each tabela key through the shared fold       |
| `mapaTabelasLi.ts`                               | the trigger's cached conta map (active contas naming a normal tabela) and the payload's anchor      |
| `gatilhoPreco.ts`                                | the trigger's work: the gates, the parent read, the family query, the enqueues (section 7)          |
| `processarPreco.tasks.test.ts`                   | the send run's emulator round trip (section 11)                                                     |
| `gatilhoPreco.tasks.test.ts`                     | the trigger's work against the emulators (section 11)                                               |
| `../../../functions/src/filaPreco.ts`            | the queue: `tipo` dispatch, the dispatch-start stamp, one line per dispatch                         |
| `../../../functions/src/agendadorPreco.ts`       | the producer's composition root (the region and the sweep-only valve through the reads root)        |
| `../../../functions/src/depsEscrita.ts`          | `depsDePrecoLi`: the run's deps, bound beside the writes and stock queues'                          |
| `../../../functions/src/onPrecoLojaIntegrada.ts` | the trigger: `onDocumentWritten` on `produtos/{produtoId}`, its deps bound per event                |

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
  every run that passed the valve, `dry-run` or `on` (`forma-invalida`, one ERROR line, zero
  reads). With the valve off the run returns before reading it, so a misspelling says nothing
  until the valve moves: check the value before flipping the valve.

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

## 7. The trigger (PR 13-e, `gatilhoPreco.ts`)

`onPrecoLojaIntegrada` (`functions/src/onPrecoLojaIntegrada.ts`) is an `onDocumentWritten` on
`produtos/{produtoId}`, database `default` (inlined at build time: an `onDocument*` bound to
`(default)` deploys fine and NEVER fires), `retry: true`, no secrets, no `region:`, and no
`maxInstances` of its own (the codebase's 10). It shares the path with `apps/functions`' produto
triggers and Mercado Livre's category trigger, in other codebases; they are independent. It fires
on EVERY ERP produto write of every channel, so its gates run from the cheapest up:

1. **Relevance, from the payload alone** (`relevanciaPrecoLi.ts`): zero reads, no line. It reads
   the produto's own `precos`, `propagatePriceToChildren` and `paiId` — the send run's mask — and
   nothing else. A create, a delete, and an update that moves no tabela reading, no folded
   propagation flag and no parent stop here: the anchor's array writes, a new counting link, the
   custo, the name, the photos, `publicado`, a kit rollup, a mirror field. Each tabela key is read
   through the shared `leituraTabelaPrecoLi` and compared in integer centavos, so float residue
   (10 → 10.004) and a key that can name no tabela stop here too; 49.99 → 50, and an unreadable
   value against a readable one (fail-open), go on. The custo is not a signal (the ERP custo is
   never sent), and neither is a new counting link: an "only link" import must not become an
   unreviewed mass price change.
2. **The valve** `LOJA_INTEGRADA_MODO_PRECO`: `off` (unset, blank, a typo) ⇒ zero reads; an
   UNRECOGNISED value logs ONE WARNING per instance (latched); `dry-run` and `on` go on alike. The
   trigger reads no canary list and no read switch.
3. **The anchor**: the contas the produto's `integracoesComProduto` lists, before ∪ after, from the
   payload, matched exactly. None ⇒ return, still zero reads.
4. **The conta map** (`mapaTabelasLi.ts`, below): the anchor ∩ the cached map of ACTIVE contas that
   name a normal tabela. No conta concerned ⇒ return: a conta with no normal tabela, or an inactive
   one, is inert.
5. **A child** (a parent on either side):
   - the parent moved ⇒ ONE task per concerned conta, `baixar: false`, zero reads. It wins over a
     price that moved in the same write;
   - otherwise only the contas one of whose OWN tabelas moved go on (the normal one, and the
     promotional one when it is not the normal one again), and for them ONE masked read of the
     parent (its flag and its anchor), shared by every conta. The parent propagates AND its anchor
     names the conta ⇒ NO task: under propagation the child's own map never prices it, and the
     parent's own event owns the family — this is what removes the duplicates the ERP's propagation
     echo would cause. It propagates but its anchor lacks the conta, or it does not propagate, or it
     is missing ⇒ ONE task, `baixar: true`. A parent id that names no document costs no read and
     counts as missing; a ref is never built from a raw `paiId`.
6. **A root** (no parent on either side: absent, `''`, or itself), per concerned conta: it affects
   its children when (the flag is on after AND one of the conta's tabelas moved) OR the flag
   flipped, and itself when one of the conta's tabelas moved. If either, ONE family query (below).
   Children found and affected ⇒ ONE task each; none found and the root affected ⇒ the root's own
   task; children found and only the root's own price moved (a parent that does not propagate) ⇒
   nothing. Every one `baixar: true`.

**The family query** (`lerFilhosDaRaizPrecoLi`): `produtos where paiId == <root> and
integracoesComProduto array-contains <conta>`, projected to `paiId`, `limit` 51, built from the
manual stock push's own index constant (`CAMPOS_INDICE_FILHOS_ENVIO_MANUAL_LI`) on the declared
COLLECTION index `produtos (paiId, integracoesComProduto, __name__)` — no new index. The per-conta
queries run concurrently. A 51st child ⇒ ONE WARNING `familia-excede-limite` and only the first 50,
in document-id order (the store's variation cap); until the nightly price phase ships, nothing
covers the rest. A root's own document never counts as its child (a self-parent matches its own
query), and a `''` root is queried by its id, never read at `produtos/''`.

**`baixar`** is `true` exactly when an ERP PRICE decision moved the target (a concerned tabela, or
the flag, which switches which map prices the family), `false` for a structural parent move.

**The enqueues come after EVERY read**, through the price producer (`agendadorPreco.ts`): origin
`evento`, generation 0, ids only (a non-bulk origin carries no tabela id), deduplicated and sorted,
at most 8 at a time, each named by the minute window of a clock read right before ITS enqueue —
never the event's time, never a value read before the reads. Rejections: an answered already-exists
is success; the closed sweep-only valve is ONE WARNING and the event's remaining enqueues are
skipped; a payload the strict schema refuses is ONE WARNING with field names, and only that task is
skipped; a transient Cloud Tasks failure, or anything else, is rethrown once its round settled, for
Eventarc's retry (a retry inside the window re-meets its names; one in a later window is one more
run, never a loss). A conta-map load, a parent read or a family query that throws is rethrown too,
with nothing enqueued.

**One INFO line** (`[loja-integrada/preco] gatilho decidido`, ids and counts) for each event that
read a parent, ran a family query or enqueued — so the echoes that read the parent and enqueued
nothing can be counted; none for an event that stopped at the relevance gate, the valve, the anchor
or the map. The run's own lines share the `[loja-integrada/preco]` prefix.

**It never** writes to Firestore (so it cannot trigger itself or anything else, and root rule 7
holds at tier 0: the names are deterministic by window, and every send run re-reads), calls Loja
Integrada or builds a client, reads the produto document, the credential, the canary or the switch,
or logs a price, a tabela id or an environment value.

**The conta map** (`mapaTabelasLi.ts`) caches `listarContasLojaIntegrada` — ONE query on the
declared `integracao (tipo, nome)` index — through a module-scope `createReadCache`, TTL
`READ_CACHE_TTL.config` (15 min) per warm instance; an EMPTY map is cached too (a project with no
conta pays one query per TTL, not one per produto write). It keeps a conta exactly when it is ACTIVE
and names a normal tabela (`core/contas.ts` folds both stored ref forms to bare ids on the same row,
at no extra read; the promotional one is kept as stored). Unlike the depósito map, inactive contas
are DROPPED: a reactivation is seen within the TTL per instance, and the events in between wait for
the produto's next event or the nightly. A conta created or re-pointed to another tabela is seen
within the TTL too; the re-point's immediate full run is the tabela arm's (a later PR of step 13).
Its answer decides only whether to ENQUEUE: the run reads the conta again itself.

⚠️ **The anchor is load-bearing for price.** The trigger pre-filters on `integracoesComProduto`, so
a counting link whose conta is missing from that array makes it skip that produto's price events
silently — the window's anchor census (`functions/DEPLOY.md`, Prerequisites) runs before the price
valve reaches `on`. The other direction is cheap: a conta listed with no counting link costs one
send run that skips (`sem-vinculo`).

## 8. Costs (Firestore operations / credential reads / store calls)

### One send run

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

### The trigger, per event

Pinned row by row in `gatilhoPreco.test.ts`. Every event is one invocation, and every row makes
ZERO credential reads, ZERO store calls and ZERO Firestore writes. "Map" is the cached conta
enumeration: zero queries on a warm instance, ONE `integracao (tipo, nome)` query per 15 min per
instance otherwise (at most 10 instances). `k` = the concerned contas; `k'` = those one of whose own
tabelas moved; `m_c` = the root's children whose anchor names conta `c`.

| event                                                                                                                                                                                         | map | parent reads       | family queries (documents)                   | tasks (`baixar`)                                         | lines                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------ | -------------------------------------------- | -------------------------------------------------------- | ----------------------------------- |
| a create or a delete                                                                                                                                                                          | 0   | 0                  | 0                                            | 0                                                        | none                                |
| an update moving no tabela reading, flag or parent (an anchor write, a new counting link, the custo, the name, photos, `publicado`, a kit rollup, a mirror field, float residue, a ghost key) | 0   | 0                  | 0                                            | 0                                                        | none                                |
| relevant, the valve off (unset, blank, a typo)                                                                                                                                                | 0   | 0                  | 0                                            | 0                                                        | one WARNING per instance for a typo |
| relevant, the anchor empty on both sides                                                                                                                                                      | 0   | 0                  | 0                                            | 0                                                        | none                                |
| relevant, the anchor names no active conta with a normal tabela                                                                                                                               | map | 0                  | 0                                            | 0                                                        | none                                |
| concerned contas, but only another tabela (or a child's own flag) moved                                                                                                                       | map | 0                  | 0                                            | 0                                                        | none                                |
| a child, its parent moved                                                                                                                                                                     | map | 0                  | 0                                            | `k` (`false`)                                            | one INFO                            |
| a child's price move, the parent propagating and anchored to every conta in `k'`                                                                                                              | map | 1                  | 0                                            | 0                                                        | one INFO                            |
| … the parent propagating, its anchor lacking `j` of them                                                                                                                                      | map | 1                  | 0                                            | `j` (`true`)                                             | one INFO                            |
| … the parent not propagating                                                                                                                                                                  | map | 1                  | 0                                            | `k'` (`true`)                                            | one INFO                            |
| … the parent missing                                                                                                                                                                          | map | 1 (not found)      | 0                                            | `k'` (`true`)                                            | one INFO                            |
| … a parent id that names no document                                                                                                                                                          | map | 0                  | 0                                            | `k'` (`true`)                                            | one INFO                            |
| a root, flag on, its own concerned tabela moved, anchored children                                                                                                                            | map | 0                  | 1 per such conta (min(`m_c`, 51), projected) | Σ min(`m_c`, 50) (`true`)                                | one INFO                            |
| a root with no anchored child, its own concerned tabela moved                                                                                                                                 | map | 0                  | 1 per such conta (0)                         | 1 per such conta (`true`)                                | one INFO                            |
| a root, flag off, its own tabela moved, anchored children                                                                                                                                     | map | 0                  | 1 per such conta (min(`m_c`, 51))            | 0                                                        | one INFO                            |
| a root, the flag flipped                                                                                                                                                                      | map | 0                  | 1 per concerned conta                        | `m_c` per conta (`true`), or 0 with none and no own move | one INFO                            |
| a root with a 51st anchored child                                                                                                                                                             | map | 0                  | 1 (51)                                       | 50 (`true`)                                              | one WARNING + one INFO              |
| a propagating root's price edit with `m` anchored children: the root's event and its `m` echo events                                                                                          | map | `m` (one per echo) | 1 per conta                                  | `m` per conta, about 0 duplicates                        | 1 + `m` INFO                        |

The index entries one family query scans on `produtos (paiId, integracoesComProduto, __name__)` are
about the family's entries for that conta plus one; the planner may pick another index and apply
the array as a residual filter (then up to the family's size): the staging `explain` (section 14)
records which. Each task the trigger enqueues then costs one send run (the table above): while the
read switch is off it stops at its write context (a child: 6/0/0); at `dry-run` with the switch on
it makes one deciding GET (6/2/1) and sends nothing.

## 9. Failures and the last attempt

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

## 10. Environment and valves

All read by the run (the valve by the trigger too) from `deps.ambiente`: the functions codebase
passes `process.env` whole and live, per event. See `functions/DEPLOY.md` for the runtime env
block.

| variable                           | rule                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOJA_INTEGRADA_MODO_PRECO`        | the valve: only the exact `on` writes, the exact `dry-run` diffs; anything else (unset too) is `off`. The trigger enqueues at `dry-run` and `on` alike. Since PR 13-f1 it also gates the nightly reconcile's price arm, and with the stock valve it STARTS the nightly and the depósito arm (section 17) |
| `LOJA_INTEGRADA_CANARIO_PRECO`     | the targets an `on` valve writes to: unset = none, `*` = every target, else `<contaId>:<store id>,…`                                                                                                                                                                                                     |
| `LOJA_INTEGRADA_CHAMADAS`          | the read switch: only the exact `on` lets the write context build a client                                                                                                                                                                                                                               |
| `LOJA_INTEGRADA_PRECO_PROMO_LIMPO` | the clear's forma (section 3): unset = `nulo`. Unreadable, it also keeps the price arm out of every nightly run (ONE ERROR, section 17)                                                                                                                                                                  |
| `LOJA_INTEGRADA_TASKS_DISABLED`    | exactly `1` closes the producer: the trigger logs one WARNING and skips the event's enqueues; a drift follow-up is one WARNING, the write stands                                                                                                                                                         |

The App Hosting backend reads none of the price variables yet; the operator's routes (a later PR)
will, and both surfaces are then set alike.

**Before the window — decided by the owner (2026-11-27).**
`LOJA_INTEGRADA_MODO_PRECO=dry-run`, functions only, is the ONE price value allowed before the
window: set first in `.env.deploy.<staging-project-id>` for the staging measurements (section 14),
and carried by the deploy that opens operations, so the first-deploy check (`functions/DEPLOY.md`,
"Verifying a first deploy", item 11) watches a real price edit enqueue its tasks before any switch
is flipped. That mirrors the stock valve. With the read switch off and no token saved it calls
nothing and writes nothing to a store: each relevant event enqueues tasks that stop at their write
context. With the read switch on, each such task makes one deciding GET (reads only) and sends
nothing. The alternative, leaving the price valve unset until its ramp in the window, was not
taken. `on`, any canary entry, the clear forma and the read switch stay window decisions.

⚠️ **Since PR 13-f1 that same `dry-run` makes EVERY nightly reconcile run carry the price arm's ERP
side** (section 17): the walk's produto read takes three more masked fields, each priced conta's
price state is read and written in each ERP slice, its parents are read, and its targets are
written — still no store call and no enqueue. And the nightly STARTS when only the price valve is
set (the stock valve unset), so stopping it takes both valves `off`.

## 11. The emulator lane

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

`gatilhoPreco.tasks.test.ts` runs the TRIGGER's work IN PROCESS (the valve `dry-run` as a
PARAMETER, the map's cache reset per case, each event's before and after handed in): the conta
map's real `integracao` query (a conta storing its normal tabela BARE and its promotional one
canonical), the masked parent read (an echo under a propagating anchored parent, a parent with no
link, one that does not propagate, a parent id no document has), the family query (only the
ANCHORED children of the root; a childless root; a root stored with `paiId: ''`), and every enqueue
through the real price producer root — each accepted only if the artifact registers the queue. The
deployed trigger's map is a 15-minute cache in the emulator's worker, warmed by whichever suite
writes a produto first, which is why the work is driven in process.

`../estoque/reconcile/reconcilePreco.tasks.test.ts` (PR 13-f1) drives the NIGHTLY reconcile's price
arm IN PROCESS (the valves as PARAMETERS, the hand-offs recorded): a price-only run (stock `off`,
price `dry-run`) over the real collection group, its produto and parent reads watched by a Proxy
that records each `getAll`'s field mask and the fields the server answered with, every bucket and
the price root on the server, the end; and a run carrying both arms, whose walk reads each produto
once through the union mask (section 17). Its conta has a depósito AND a normal tabela, so it keeps
a rule set of its own (`vitest.tasks.config.ts`): seeded by a create, deleted at the teardown.

**What fires on every suite's writes.** Since PR 13-e the deployed PRICE trigger fires on every
suite's `produtos/*` writes (the anchor's own array writes included). Its relevance gate stops a
create, a delete and an update that moves no price field at zero reads; past it, at the lane's
`dry-run`, it may enqueue send runs (which write nothing), and only for a produto whose anchor names
an ACTIVE conta with a NORMAL tabela — a conta with no normal tabela is inert. So a suite that writes
produtos seeds them by a CREATE (after a delete) and never updates `precos`,
`propagatePriceToChildren` or `paiId` on a produto anchored to a conta with a normal tabela (only
the two price suites seed such a conta, under ids no other suite uses, by a create, and neither
edits a price field in the emulator), and asserts only what its own in-process run decides
(`vitest.tasks.config.ts`).

The lane cannot prove the deployed trigger end to end, its gate order or its costs (pinned offline:
`gatilhoPreco.test.ts`, `functions/src/onPrecoLojaIntegrada.test.ts`), the map's TTL, named-task
dedup, or the declared indexes (the emulator auto-creates every one; `gatilhoPreco.test.ts` and
`mapaTabelasLi.test.ts` pin both queries against `firestore.indexes.json`).

## 12. Guards

| what                                                                                                           | pinned by                                                                   |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| every cost of section 8's send-run table, child and root; ≤ 1 PUT in every scenario                            | `processarPreco.test.ts`                                                    |
| the trigger's gate order, every row of its cost table, the clock after every read, the rejection contract      | `gatilhoPreco.test.ts`                                                      |
| the relevance's per-key fold and its near-misses; a move of `precoAlvoLi` never judged irrelevant              | `relevanciaPrecoLi.test.ts`, `relevanciaPrecoLi.propriedade.test.ts`        |
| the conta map: active, a normal tabela, the exact anchor match, cached (an empty map too)                      | `mapaTabelasLi.test.ts`                                                     |
| both trigger queries ride a declared index (the family query on the manual push's constant)                    | `gatilhoPreco.test.ts`, `mapaTabelasLi.test.ts`                             |
| the trigger's options: database `default`, `retry`, its path, no secret, the inherited region and instance cap | `functions/src/index.test.ts`, `functions/src/onPrecoLojaIntegrada.test.ts` |
| the trigger calls nothing outside the ERP: no context, park, pacer, engine or send run                         | `estrutura.test.ts`                                                         |
| the no-lower and reflected decisions against an independent oracle                                             | `planoPrecoLi.test.ts`, `planoPrecoLi.propriedade.test.ts`                  |
| the mask is sufficient for `precoAlvoLi`                                                                       | `leituraPrecoErp.test.ts`                                                   |
| the queue's options, their equality with the stock queue's, the export name                                    | `functions/src/index.test.ts`                                               |
| the dispatch, the bindings (the PRICE producer, the live env, the attempt)                                     | `functions/src/filaPreco.test.ts`                                           |
| the producer root's queue path, region and valve                                                               | `functions/src/agendadorPreco.test.ts`                                      |
| five producer roots, each binding only its own queues                                                          | `estrutura.test.ts`                                                         |
| the lane refuses the price valve `on` and a price canary; the job env itself                                   | `testing/guardaDaLaneDeTarefas.test.ts`                                     |
| the queue's `invoker`                                                                                          | `packages/config-eslint/rules/tasks-invoker-inventory.test.js`              |
| what `planoPrecoLi.ts` and `relevanciaPrecoLi.ts` treat as the same price                                      | `packages/config-eslint/rules/equivalence-fold-inventory.test.js`           |
| the env variable is documented, never an `env:` row                                                            | `configPrecoLi.test.ts`                                                     |
| the nightly with the price valve unset (or `off`, or unrecognised) is the stock-only reconcile, byte for byte  | `../estoque/reconcile/reconcileEstoque.golden.test.ts`                      |
| a fault in the nightly's price arm leaves every stock write, enqueue, aviso and counter unchanged              | `../estoque/reconcile/reconcilePreco.espelho.test.ts`                       |
| the both-valve gate, at zero reads; the arms a run carries and drops; the end pair never split                 | `armasReconcile.test.ts`, `despachoReconcile.preco.test.ts` (reconcile)     |
| the nightly's price arm calls nothing outside the ERP, and rides the reconcile's task path                     | `estrutura.test.ts`                                                         |

## 13. Deploy, IAM, indexes (listed, owner-run)

None of this is an agent's to run (root `CLAUDE.md` rule 8):

- deploy `functions:loja-integrada` only — the price queue (PR 13-d) and, since PR 13-e, its
  trigger `onPrecoLojaIntegrada`, the codebase's sixth Firestore trigger. It changes no behaviour
  while the price valve is unset: every produto write returns at the trigger's zero-read gates, and
  every run returns `desligado`. No App Hosting, web, rules, index or TTL deploy;
- the trigger's binding: `gcloud eventarc triggers list --project <project-id>` shows a trigger for
  `onprecolojaintegrada`, event type `google.cloud.firestore.document.v1.written`, database
  `default`, path `produtos/*`; confirm that the Eventarc and Firestore service-agent grants serving
  the other five Firestore triggers serve it too. One bound to `(default)` deploys fine and never
  fires (`functions/DEPLOY.md`, "Verifying a first deploy", item 11);
- the new queue's enqueuer grant, per project, for each identity in `TASKS_INVOKER_SA` (the first
  deploy of a new queue crashes on that binding: `functions/DEPLOY.md`), then the same deploy
  re-run; verify both the queue's and the service's IAM policy;
- the index the duplicate probe rides, already declared for the stock flow:
  `produtolojaintegrada (contaLojaIntegrada, id)` READY; and the two the trigger rides, declared
  too: `produtos (paiId, integracoesComProduto, __name__)` (the manual stock push's) and
  `integracao (tipo, nome)`. No new index;
- since PR 13-f1 the same `functions:loja-integrada` deploy changes the reads queue's reconcile
  slice and the nightly start: with the price valve unset nothing changes (the stock-only
  reconcile, byte for byte); with the decided `dry-run`, every nightly also runs the price arm's
  ERP side (section 17). No new function, queue, schedule, secret, index, rule, TTL or IAM grant.

## 14. Staging measurements to record

None is recorded at HEAD. The owner measures them on staging, in the #785 style, after the merge
and before the window, with the price valve at `dry-run` on staging only, the read switch unset,
seeded produtos and no token saved:

- irrelevant produto writes (a name, an anchor write, a custo, float residue) ⇒ zero trigger reads;
- the family query's `explain` for a family of one linked child, a mid-sized one and one at the
  50-child cap (the store's variation cap): the index chosen, the entries scanned, the documents
  returned;
- a child edit under a parent that does not propagate ⇒ one parent read and one task; an anchored
  echo under a propagating parent ⇒ one parent read and zero tasks;
- a staged reprice of seeded propagating families ⇒ at most one family query per family per conta,
  one parent read per echo, tasks ≈ children, and the event lag with `maxInstances` 10;
- the nightly with the price arm's ERP side (PR 13-f1, section 17), stock and price at `dry-run`,
  the read switch off, a conta with a depósito and both tabelas seeded with a propagating family, a
  non-propagating one, a `''` root, a parent link and a produto with no normal price:
  - against the previous stock-only night, the key-walk entries and the produto documents read do
    not move (the same `getAll`, three more fields: record the bytes the wider mask adds); the
    parent documents read are at most the distinct parents; at most C + 32·Cp price-state
    documents read per ERP slice (C run contas, Cp of them priced), and every slice stays within
    its 100 s;
  - the six ERP read-path counters of the run's end line equal the previous stock-only night's;
  - the largest bucket and the price root in bytes, at a recorded entry count, extrapolated
    linearly (the documents' 1 MiB limit);
  - the largest end-of-slice commit in bytes — its stock and its price documents apart — at a
    recorded entry count, extrapolated linearly against Firestore's 10 MiB request limit and the
    price share of one commit (4 MiB; no `lote-preco-excedido` ERROR expected);
  - the write units per KiB for a bucket and for the root;
  - `[loja-integrada/preco] reconcile alvos da conta calculados` once per priced conta,
    `sincPrecoLojaIntegrada/{conta}.ultimoReconcilePreco` naming the run, and neither an
    `arma-preco-falhou` nor a `lote-preco-excedido` ERROR.

## 15. Window items

- the consumer (this functions codebase) deploys before any price producer ships;
- the migrated links' anchor census runs before the valve reaches `on`: the trigger pre-filters on
  `integracoesComProduto` (section 7);
- the deploy that opens operations carries `LOJA_INTEGRADA_MODO_PRECO=dry-run` (functions only,
  the owner's decision, section 10), so the next real price edit of a linked produto enqueues what its family shape gives (`functions/DEPLOY.md`, item 11): a
  propagating root one task per child anchored to the conta, a simple produto its own task, a
  non-propagating root with anchored children none, the ERP's echo onto the children of an
  anchored propagating parent none (one parent read and one INFO line each), and a child's own
  write one task only when its parent does not propagate or is not anchored to the conta. Each
  dispatch line shows the run stopping at the read switch while it is off, or, with it on, one
  deciding GET and its diff line with nothing sent — never hand-edit a real price to check it;
- that same `dry-run` makes every nightly reconcile run carry the price arm's ERP side (section
  17), and starts the nightly even with the stock valve unset: stopping a running chain takes BOTH
  valves `off`. The clear forma must read (unset, or exactly `zero` / `igual-cheio`) before any
  price-carrying nightly, or every run drops its price arm with ONE ERROR `forma-promo-invalida`;
- a Firestore import fires no trigger: the migrated prices reach a store only through a send run
  (the nightly's store read and queue phase and "Atualizar preços", later PRs of step 13), and the
  trigger covers the ERP price edits after the switch-over;
- at `dry-run` with the read switch on, a whole-catalogue reprice is one deciding GET per linked
  child on the price queue (reads only, one at a time, for hours on a large catalogue): keep it in
  mind before a bulk change of prices in the window;
- the legacy app is off before the valve reaches `on`; the first real writes are a per-conta canary
  through the operator's manual push (a later PR of step 13);
- `LOJA_INTEGRADA_PRECO_PROMO_LIMPO` stays unset (`nulo`) unless the canary shows the store refusing
  it — then `zero`, and `igual-cheio` only as the last resort, set by a person.

## 16. Accepted residuals

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
- A write that moves the parent and a price together sends `baixar: false`: a lowering in it waits
  for a later event, or for "Atualizar preços" with lowering allowed.
- A family whose root's link no longer counts gets its children's tasks only from the echo path (a
  propagating parent); a flag turned OFF on such a root reaches no child until the nightly.
- The conta map is up to 15 min stale per warm instance (a conta created, re-pointed or
  reactivated).
- A counting link whose conta is missing from the anchor is skipped silently (the census gate,
  section 15).
- More than 50 linked children of one root in one conta: the first 50 are enqueued and ONE WARNING
  is written; a self-parent root (legacy data) with more than 50 may enqueue 50 with no WARNING.
- ⚠️ Until the nightly's store read and queue phase ship (later PRs of step 13; its ERP side alone,
  section 17, enqueues nothing), nothing re-covers a missed event — a task dropped after three
  429/5xx attempts, a period with the valve off, the cases above — except the produto's next event.

## 17. The nightly reconcile's price arm: its ERP side (PR 13-f1)

The price reconcile is FOLDED into the daily stock reconcile: one schedule, one lease and run
document, one ERP key walk, one batch per slice. The design in depth — the gate, the arms, the price
state, the walk arm, the parents phase, the end, containment, persistence — is
[`../estoque/reconcile/README.md`](../estoque/reconcile/README.md), section 14. In short:

- **The both-valve gate.** A slice, the nightly start and the depósito arm return at zero reads
  only when BOTH `LOJA_INTEGRADA_MODO_ESTOQUE` and `LOJA_INTEGRADA_MODO_PRECO` are `off`. The price
  arm is active when its valve is not `off` and the clear's forma reads; an unreadable cap keeps
  only the stock arm out (ONE ERROR per run), an unreadable forma only the price arm (ONE ERROR
  `forma-promo-invalida`). With the price valve unset, the nightly is the stock-only reconcile, read
  for read and write for write (`reconcileEstoque.golden.test.ts`).
- **Which contas.** The run's contas stay the stock list (active, with a depósito); a conta naming
  a normal tabela at the take is priced, its tabelas folded and fixed for the run in its root
  `sincPrecoLojaIntegrada/{conta}`. A conta with a normal tabela but no depósito is not priced by
  the nightly; its events still are.
- **The walk.** Each page's produtos are read ONCE for both arms (the stock mask widened by `paiId`,
  `precos` and `propagatePriceToChildren`; a price-only read when stock is not carried — never the
  ERP custo). A PURE arm per priced conta writes the page's entries into the conta's 32 buckets
  (the produto's own readings, in centavos), contained per (page, conta): a bug or a value off its
  schema costs that conta its price arm for the night, never the stock flow.
- **The parents phase** (`pais-preco`): each distinct parent read ONCE per conta per run, at most
  300 per masked `getAll`, and every child's target computed by `precoAlvoLi` itself — the same
  rule the send run applies.
- **The end**: `ultimoReconcilePreco` (the run's tabelas and counters) per priced conta, and the
  aviso `lojaIntegradaPrecoSemErp` (children the ERP cannot price: no normal price, an unreadable
  one, a missing parent) only under the price valve exactly `on` and live for the conta; at
  `dry-run`, ONE INFO line per conta instead.

Nothing here calls the store or enqueues a send: the by-id store read, the candidates and the
queue phase come in the next PRs of step 13.

### Costs

Per night with price carried, beside today's stock costs (C run contas, Cp of them priced; P walk
pages): the walk's produto reads are the SAME documents (three more masked fields, so more bytes,
never more reads); each ERP slice reads the C price roots and the 32·Cp buckets once (two
`getAll`s) and writes up to 33·Cp more documents in its one batch — in practice all of them, every
ERP slice: a walk page spreads its store ids over all 32 buckets and a bucket is written whole, so
each slice rewrites every priced conta's whole price snapshot, in the same commit as the stock
writes; the parents phase reads each conta's distinct parents once (≤ 300 a unit) and writes its
buckets once more with the targets; the end reads the price roots, one uncached contas `getAll` per
slice, and under `on` at most one aviso read per conta (a write only when it moves). A price-only
run (stock `off`) pays the walk itself: one key query per page and its price-masked produto reads.
No store call, no enqueue, no new index, rule, TTL, function, queue or schedule.

A bucket holds about one in 32 of the conta's linked entries, at about 90 bytes each plus about 40
bytes of carry while the walk runs; the root holds counters and samples. Both are among the staging
measurements (section 14), and so is the commit they ride: Firestore refuses a commit past 10 MiB
whole, on every retry, so the price documents of one commit are held to 4 MiB
(`../estoque/reconcile/README.md`, "The commit's bytes") — a conta past it loses its price arm for
the night with ONE ERROR `lote-preco-excedido`, and the stock writes keep their commit.

### Environment

No new variable. The price valve now gates the nightly's price arm and, with the stock valve,
starts the nightly and the depósito arm (section 10); the clear's forma must read before any
price-carrying nightly; `dry-run` is the decided opening value (section 10). Stopping a running
chain takes BOTH valves `off` (`functions/DEPLOY.md`).

### The emulator lane

`../estoque/reconcile/reconcilePreco.tasks.test.ts` (section 11) drives a price-only run and a run
carrying both arms IN PROCESS on the real emulators. It cannot prove the indexes (none is new), the
schedule, named-task dedup or a store call (none on this side).
