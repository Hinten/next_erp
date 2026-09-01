# `audit:ml-cliente-fork` — how many ML buyers own two clientes?

Read-only. Counts the clientes that were forked by the ML order import never
supplying the buyer's `idMercadoLivre` (#1087), which [#1407][pr] fixed going
forward. Tracked by [#1408][issue]; the authoritative run is a step in the
cutover runbook, [#1208][runbook].

[pr]: https://github.com/Hinten/next_erp/pull/1407
[issue]: https://github.com/Hinten/next_erp/issues/1408
[runbook]: https://github.com/Hinten/next_erp/issues/1208

## Why the population exists

`findOrCreateCliente` cascades `cpf_cnpj` → `idEstrangeiro` → `idMercadoLivre` →
`telefone` → `email`. Until #1407 the ORDER import passed no ML id, so that third
leg was always null on the order path and every ML order matched on a fiscal
document, a phone number or an e-mail.

A buyer who asked a **question** before ordering therefore ended up with two
documents: one keyed on their ML id by `questionImport`, and one built from the
billing identity by `orderImport`. `claimCliente.ts` was written partly to notice
that split and refuse to make it worse.

#1407 stops new ones. It repairs nothing already split — this counts what is
there.

## What it does NOT do

⚠️ **It never writes, and `--apply` is refused rather than ignored.** Repairing a
fork means moving pedidos, conversas and endereços from one cliente to another —
a decision per pair of documents, not one a script makes in bulk from a count.
Deciding whether a repair migration is worth writing is the point of running
this.

## Running it

Staging rehearsal — safe any time, and the only way to see the shape of the
output before the window:

```bash
pnpm --filter @delfrance/migrations audit:ml-cliente-fork --project <staging-id>
```

Production, **inside the migration window**, after the Firestore import and
before the legacy app is switched off:

```bash
pnpm --filter @delfrance/migrations audit:ml-cliente-fork --project <prod-id>
```

⚠️ **Agents never run this against production.** `--project` is required and is
matched against the service account (`src/admin.ts`), so a stray
`FIREBASE_PROJECT_ID` cannot point it somewhere else.

## Why the authoritative run is inside the window

The corpus whose fork count actually matters arrives **with** the migration. A
run before the window measures a set that is still being written to, so its
number is superseded rather than saved.

A staging run is a **rehearsal**, not a data-preservation goal: staging is
disposable and re-seedable from `tools/test-fixtures`, and holds mostly e2e seed
fixtures — the count there is meaningless as data, but it proves the predicate,
the harness and the JSONL shape.

## The verdicts

One line per ML pedido. `change` lines are findings, `skip` lines are clean, and
`changes + skips` reconciles with the ML pedido count printed during the run.

| kind                                     | meaning                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`                                     | the pedido's cliente owns exactly this buyer id — nothing to do                                                                                                                                                                                                                                                                    |
| `sem-buyer-id`                           | the `orderML` mirror carries no buyer id; nothing to assess                                                                                                                                                                                                                                                                        |
| `nao-carimbado`                          | nobody owns the id and the cliente carries none. **The common pre-#1407 shape, and benign.** ⚠️ It heals on that buyer's next NEW ORDER, not by re-importing this pedido — `applyClienteStep` returns early when `clientePedidoOuterRef` is already set (`orderImport.ts:744`), so re-running the import to fix these does nothing |
| `fork`                                   | exactly one cliente owns the id and it is **not** this pedido's. The population this audit exists to count                                                                                                                                                                                                                         |
| `dono-duplicado`                         | **two or more** clientes carry the id. The worst kind: the match leg takes the first row of a page, so every later delivery repeats the same arbitrary pick. #1407's guard refuses to create this state but cannot undo one already there                                                                                          |
| `cliente-com-outro-id`                   | nobody owns the id and this pedido's cliente carries a **different** one. ⚠️ **Predictive:** under #1407 the next order from this buyer is refused at the `cpf_cnpj` leg and forks into a second cliente carrying the same CPF. That is the documented intended trade — these rows are where it will land                          |
| `buyer-id-inseguro`                      | the id is past 2^53, so `JSON.parse` already rounded it. The runtime **refuses** to stamp these (`safeMlUserId`), so unlike `nao-carimbado` they never self-heal                                                                                                                                                                   |
| `buyers-divergentes`                     | a pack whose child orders name different buyers. Not expected — surfaced rather than resolved by picking one                                                                                                                                                                                                                       |
| `pedido-ausente`                         | the mirror is **orphan debris**: its pedido was deleted. ⚠️ `pedidoMeta` declares a cascade over `orderML` and states it is NOT enforced — there is no `onPedidoDeleted` trigger — so deleted pedidos leave their mirrors on disk and the import carries them across the window. Not a cliente problem, so not a finding           |
| `pedido-sem-cliente` / `cliente-ausente` | the import never linked a cliente, or the link points at a document that is gone                                                                                                                                                                                                                                                   |

## Worked example — the staging rehearsal, 2026-09-01

```
clientes=24 com idMercadoLivre=2 ids com MAIS DE UM dono=0
orderML lidos=10 pedidos ML=6
por kind: fork=1, ok=4, cliente-com-outro-id=1
done: scanned 6 docs, 2 with changes (2 field changes, 4 skipped, 0 writes)
```

It reconciles: `1 + 4 + 1 = 6 = pedidos ML`, findings `2 = docsChanged`, skips
`4`. Ten mirror docs over six pedidos, so packs are being folded per pedido
rather than counted per order.

⚠️ **All six pedidos point at ONE cliente**, `ci-mqbdw6rn-cliente` — the e2e seed
fixture whose placeholder telefone `11999990000` started #1087. It carries
`idMercadoLivre: 3615281810`, and the two findings are two OTHER ML buyers whose
orders landed on it anyway:

| pedido  | buyer        | verdict                | why                                                                                 |
| ------- | ------------ | ---------------------- | ----------------------------------------------------------------------------------- |
| `1729…` | `3646520554` | `fork`                 | owned by cliente `I6N5XVCTXj1rjHt76HSH` — a question-created row beside the order's |
| `ddcf…` | `3644236740` | `cliente-com-outro-id` | nobody owns it; the fixture already carries a different id                          |

So three distinct ML accounts resolved to one cliente. That is the absorption
#1407 exists to stop, visible as data rather than as an argument — and the split
this audit was written to count showed up on the first run.

⚠️ **Staging numbers are not evidence about production.** This corpus is seed
fixtures sharing one placeholder phone, which is precisely the shape that
absorbs. The run proves the predicate, the reconciliation and the JSONL; the
count means nothing until the authoritative run inside the window.

## How to verify it worked

- `out/<stamp>-ml-cliente-fork-audit-dryrun.jsonl` exists and has one line per ML
  pedido. ⚠️ **The verdict is the `field` key, not `kind`** — `ChangeSink` spends
  `kind` on `change`/`skip` (`src/runner.ts`), so `jq -r .kind` yields those two
  words and none of the nine verdicts this runbook is about. Tally them with:

  ```bash
  jq -r .field out/<stamp>-ml-cliente-fork-audit-dryrun.jsonl | sort | uniq -c
  ```

  The two line shapes differ in their other keys — a `change` carries
  `from`/`to`, a `skip` carries `value`/`reason` — but both carry `field`, so the
  command above covers the whole file.

- The run prints `clientes=… com idMercadoLivre=… ids com MAIS DE UM dono=…`,
  then `orderML lidos=… pedidos ML=…`, then the per-kind tally. The tally sums to
  the `pedidos ML` figure.
- Spot-check two `fork` rows in the console: both cliente documents exist, and
  exactly one of them carries the `idMercadoLivre`.
- **Re-run it.** It writes nothing, so a second pass must produce identical
  counts. That is this script's idempotence check.

## Cost

⚠️ Two full key-order scans — every `clientes` document and every `orderML`
document — plus one `getAll` per 200 ML pedidos. On Firestore **Enterprise** that
is billed by **data scanned**, and a missing index does not throw, it silently
full-scans. Both walks are `orderBy(documentId())`, the one ordering always
served without a declared index, so a "narrower" `where` here would cost more,
not less. Note the figure in the run log; it is acceptable for a one-off.

Two maps are held for the whole run (every cliente's ML id, one entry per ML
pedido) — a couple of short strings per document. That is what makes the
per-pedido classification zero-read.
