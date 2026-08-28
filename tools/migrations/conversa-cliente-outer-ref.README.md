# `conversa-cliente-outer-ref` — one identity field for the chat inbox

Backfills `chat/{id}.clienteOuterRef` from `usarioOuterRef`, so the inbox's
**Cliente** filter can be a single equality on one field.

```bash
# pre-flight — counts every verdict, logs no per-doc lines, writes nothing
pnpm --filter @delfrance/migrations migrate:conversa-cliente-outer-ref --project <project-id> --report-only

# dry-run (default) — logs every doc it WOULD touch, writes nothing
pnpm --filter @delfrance/migrations migrate:conversa-cliente-outer-ref --project <project-id>

# write
pnpm --filter @delfrance/migrations migrate:conversa-cliente-outer-ref --project <project-id> --apply
```

`--report-only` is the pass to run **first**. A dry-run enumerates documents; the
numbers that decide anything are how many land on **`sem-cliente`** and
**`ambiguo`** — the latter needs a human _before_ an `--apply` run, not after it.

## Why it exists

A Firestore `==` cannot OR two fields. Every Mercado Livre importer writes
`clienteOuterRef` (#768); WhatsApp writes it as of #1159; the legacy corpus
carries only `usarioOuterRef`. While both populations exist, filtering the inbox
by a customer silently returns a _subset_ of their threads — which looks like
"this customer has not written much", not like a bug.

This pass converges the stored data so the read side can be one equality forever
(#1159, #1160).

## ⚠️ Read this before scheduling the run

**Inside the cutover window, ordered between two other steps:**

| #   | step                                                             | why the order matters                                                                     |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | legacy data import                                               | the corpus has to exist before it can be mapped                                           |
| 2   | **this pass**                                                    |                                                                                           |
| 3   | `chat(clienteOuterRef, ultima_modificacao)` index deploy (#1160) |                                                                                           |
| 4   | `apps/web` deploy carrying the new filter                        | before this, an operator filtering by customer sees a correct-looking but half-empty list |

The pass is idempotent, so an early run is not _harmful_ — it is simply not
finished. The legacy app is the sole live writer on the source project until the
window switches it off, so the authoritative run is the one inside the window.

**This writes data only, and only where the field is ABSENT.** It never
overwrites a `clienteOuterRef` a live writer already set, and no reader is
narrowed: `useClienteLink`'s `usarioOuterRef` fallback stays exactly as it is.
That fallback is what keeps `sem-cliente` and `ambiguo` conversas usable, since
they will still have no cliente ref when this finishes.

## The verdicts

| verdict          | meaning                                         | action                                            |
| ---------------- | ----------------------------------------------- | ------------------------------------------------- |
| `ja-normalizado` | `clienteOuterRef` already set                   | never written — this is what makes a re-run cheap |
| `sem-usuario`    | anonymous conversa, nothing to map from         | skipped, counted                                  |
| `resolvido`      | exactly one cliente claims the usuario          | **written**                                       |
| `sem-cliente`    | no cliente carries that `userCliente`           | reported, left untouched                          |
| `ambiguo`        | two or more clientes claim it                   | reported, left untouched                          |
| `ref-invalida`   | `usarioOuterRef` does not name a `usuarios` doc | reported, left untouched                          |

**`ambiguo` above zero is a finding, not a nuisance.** It means duplicated cliente
identities exist in the corpus — the condition #1067 exists to prevent. Picking
the lower doc id would hide a real defect behind a coin flip, and merging clientes
is a human decision, never a side effect of a backfill. Resolve those first, then
re-run; they become `resolvido` once one claimant remains.

⚠️ **To enumerate them, use the DRY-RUN, not the report.** `--report-only` writes
no JSONL and prints at most 20 (labelled `amostra`), so it cannot list the
twenty-first. The dry-run logs every one:

```bash
pnpm --filter @delfrance/migrations migrate:conversa-cliente-outer-ref --project <project-id>
grep '"kind":"skip"' tools/migrations/out/*-conversa-cliente-outer-ref-*-dryrun.jsonl
```

Each `skip` line carries the conversa path, the usuario id and every claiming
cliente id.

**`sem-cliente`** is usually benign — a contact that was never paired, or whose
cliente was deleted. Writing a ref derived from the uid would aim the filter at a
`clientes` doc that does not exist, which is strictly worse than the absent field
the UI already handles.

## Verification

The second pass **is** the verification. After `--apply`, run `--report-only`
again:

- `resolvido` must be **0** — everything mappable was mapped.
- `sem-cliente` / `ambiguo` / `ref-invalida` must be **unchanged** — those are
  reported, never written, so they cannot move on their own.
- any **conflito** count from the `--apply` run should be **0** on the re-run:
  a conflito means another writer set `clienteOuterRef` between the read and the
  write, so the pass left it alone. Re-running re-evaluates it against the
  current value and it lands on `ja-normalizado`.
- `ja-normalizado` must have grown by exactly the previous `resolvido` count.

Then spot-check in the app: open `/chat`, filter by a customer who has both a
WhatsApp thread and a Mercado Livre thread, and confirm both appear.

## Cost

One root-collection scan of `clientes` to build the uid index, then one of
`chat`. Firestore Enterprise bills **data scanned**, so the index is built once
in memory rather than issuing a `where('userCliente','in',…)` per conversa —
that would be one query per document against a collection this pass reads in full
anyway.

Both scans page by document key (Firestore's always-available native ordering),
so neither needs an index. A `where` could not narrow the `chat` scan either: the
documents needing a change are the ones where a field is **missing**, and
Firestore cannot query for the absence of a field.
