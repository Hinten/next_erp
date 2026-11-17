# Audit: the Loja Integrada stock counts (step 12)

**Status: AUDIT ONLY — a read-only COUNT on the legacy project; no `--apply` path, never writes.**

## Why

Step 12 (the Loja Integrada stock sync) sends a store product's stock when its ERP
stock moves. PR 12-f adds the two pieces whose settings depend on the real data:

- **the trigger** on every `produtos/{p}/estoques/{e}` write — how many writes a day
  it sees at each Loja Integrada depósito sets its cost and queue load;
- **the kit fan-out** — a component's stock change re-sends every linked kit it
  constrains, at once while a component constrains at most
  `MAX_KITS_EM_LINHA_ESTOQUE_LI` (30) kits, deferred above that. The split is only
  as good as the real distribution of kits per component (**F**).

Two more facts gate the cutover day itself: whether each conta's depósito is the
right one (the plan stops when more than 5% of the linked children have no stock
record at their conta's depósito — the **>5% gate**), and whether each conta's
operação moves unavailable stock.

These are the step-12 stock plan's ERP counts. They have to be measured on real
data **before PR 12-f merges**; this script measures them.

## What it counts

Per Loja Integrada conta unless noted. Contas and depósitos appear only as
pseudonyms (`loja-1`, `loja-2`, … by number of linked children; `dep-1`, … with the
Loja Integrada depósitos first).

| #   | Count                                                                                                                                                                                                                | Summary section                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1   | Linked children that are kits (`ehKit`, `ehKitVirtual`, both), constrained or not; the **F** histogram of linked kits per constraining component, its top 10 values, how many exceed 30, per conta and combined      | `kits`                                      |
| 2   | Stock writes per day at each Loja Integrada depósito: distinct records by their last `ultimaModificacao`, and ledger (`historicoEstoque`) rows per day — both LOWER bounds                                           | `escritasPorDia`                            |
| 3   | Whether both Loja Integrada contas, the Mercado Livre contas and the Shopee contas stock from one depósito (compared by the bare depósito id, either stored ref form), over all contas and over active ones          | `contas`                                    |
| 4   | Each conta's operação `movimentaIndisponivelEstoque` (and `movimentaEstoque`), outbound and returns, as stored                                                                                                       | `contas.lojas.*.operacao*`                  |
| 5   | Produtos touched per day by `ultimaModificacao`, and how many of them are linked children or parents                                                                                                                 | `produtosTocados`                           |
| 6   | Linked children with no stock record at the conta's depósito — only in a folded form there, with records elsewhere, or with none at all — and their share against the >5% gate; constrained kits missing a component | `semRegistro`                               |
| 7   | Duplicate stock records of one produto at one depósito (with and without the canonical `est-<produto>-<depósito>` id), and records without `parentId`                                                                | `duplicados`, `semParentId`                 |
| —   | Links per conta: documents, counting links, children / parents / simple roots, text ids, stored conta-ref forms, trashed, store ids linked from two produtos; every skipped shape by count                           | `vinculos`, `ignorados`, `formasDoDeposito` |

Every decision is the stock run's own reader, imported from `@delfrance/schemas`
(`vinculoDaContaLi`, `depositoDaContaLi`, `formasDoDepositoLi`,
`estoqueNoDepositoLi`, `caminhoEstoqueLi`) and `@delfrance/data`
(`componentesNaoResolvidos` for the constraining components), so a count here is
what the run would see. A "linked child" is a produto whose links for the conta
name exactly one store product, as a child. The >5% gate's base is the linked
children whose own record feeds the quantity — constrained kits are reported
apart, since their quantity comes from their components.

A depósito ref that folds to the depósito but matches neither exact stored form
(`documents/depositos/<id>`, `depositos/<id>`) — a leading slash, a doubled slash —
is counted apart as `dobrada`: the run's queries do not see it.

Count 6 splits the children with no record the run reads at the depósito into
three disjoint cases, in this order: a record there only in a `dobrada` form (the
depósito mapping is right, the ref is not — `soNaFormaDobrada`), a record at
another depósito or with no readable depósito (what a wrong mapping looks like —
`semRegistroComRegistrosEmOutroLugar`), and no record at all
(`semNenhumRegistro`). All three count against the >5% gate.

## When

**Now, on the LEGACY project, read-only, before PR 12-f merges.** It is a
measurement, not a migration and not a cutover-window step:

- the legacy app keeps writing that project, so any result is a snapshot that
  later legacy writes supersede — re-run it whenever a fresher number is needed;
- it writes nothing, so it is safe to run any time, as often as wanted.

Record the run (date, `--dias`) and the pasted summary on the step-12 PR. No
`needs-migration-window` issue is opened for it.

## Run it

The legacy project is Firestore **Standard**, whose database is named
`(default)` — not `default`, which is this repo's own Enterprise name. Set it
explicitly for the run; the shell's value wins over `.env.local`.

```bash
FIREBASE_DATABASE_ID='(default)' pnpm --filter @delfrance/migrations audit:li-estoque-contagens --project <legacy-project-id> --service-account <legacy-service-account.json> --dias 14
```

On Windows PowerShell:

```powershell
$env:FIREBASE_DATABASE_ID = '(default)'
pnpm --filter @delfrance/migrations audit:li-estoque-contagens --project <legacy-project-id> --service-account <legacy-service-account.json> --dias 14
Remove-Item Env:FIREBASE_DATABASE_ID
```

- `--project` is required, never inferred, and matched against the service
  account (`src/admin.ts` refuses a mismatch).
- `--dias N` (1–60, default 14) is the per-day window: the last N civil days in
  São Paulo, today included.
- `--report-only` writes the summary only, no per-document JSONL rows.
- `--apply` and `--target` are REJECTED, before any credential is read.

**Check the database line.** The runner prints its own
`[li-estoque-contagens] project=… mode=DRY-RUN → …` line first; the line right
after it, `[li-estoque-contagens] database=… janela=…`, must read
`database=(default)`. The reads start right after it.

- A wrong project is refused before any read: `src/admin.ts` matches `--project`
  against the service account.
- An unset or wrong `FIREBASE_DATABASE_ID` falls back to `default`, a database the
  legacy Standard project does not have: the first read fails with
  **`5 NOT_FOUND`**. That error means "set `FIREBASE_DATABASE_ID='(default)'`".
- A database that exists but holds no Loja Integrada data would count zero
  everywhere, so the script refuses instead of reporting:
  - `NAO-AVALIADO sem-contas-li` — no `integracao` doc of the Loja Integrada tipo;
  - `NAO-AVALIADO sem-vinculos-que-contam` — no counting link names one of them.

Every one of these exits 1 having written nothing.

A staging rehearsal is optional and also the owner's to run (there,
`FIREBASE_DATABASE_ID` is `default`); its numbers mean nothing for step 12.

## What it reads, and what it costs

| Leg              | Read                                                                                                                                  | Index on Standard                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| contas           | `integracao`, masked                                                                                                                  | none (where-less)                        |
| operações        | one `getAll` of the Loja Integrada contas' operações                                                                                  | none (point reads)                       |
| links            | every `produtolojaintegrada` doc, collection group, by document key                                                                   | none (native key order)                  |
| produtos         | `getAll` of every produto a link names, masked                                                                                        | none (point reads)                       |
| stock records    | every `estoques` doc, collection group, by document key                                                                               | none (native key order)                  |
| produtos touched | `produtos where ultimaModificacao >= <window start> order by ultimaModificacao desc`                                                  | automatic single-field, collection scope |
| ledger           | per record at a Loja Integrada depósito touched in the window **or with no numeric stamp**: its `historicoEstoque where timestamp >=` | automatic single-field, collection scope |

**Expected cost: about 40–90 thousand document reads** (an estimate; the corpus's
stock-record count is the big unknown). On Standard that is a few cents. Zero
writes. The ledger leg dominates when writes per day are high; `--dias 7` roughly
halves it. Each record the ledger leg reads costs at least one read even with no
row (an empty query is billed), so the records at the depósito with no numeric
stamp (`registrosSemCarimboNumerico`) add about one read each. The summary prints
the measured reads per leg (`leituras.porPerna`) and the billed estimate.

If the legacy project refuses the ledger query for a missing index (gRPC 9), the
script says so (`AVISO`), sends no further ledger query, reports
`razaoDisponivel: false` and keeps the walk-based figures; any other error stops
the run.

## Reading the output

Two files under `tools/migrations/out/` (gitignored, local only):

- `<stamp>-li-estoque-contagens-resumo.json` — **the summary: counts, booleans,
  civil dates and pseudonyms only.** The same JSON is printed on stdout as the line
  starting `RESUMO ` (the runner's own `done:` line follows it).
- `<stamp>-li-estoque-contagens-dryrun.jsonl` — the runner's log, **with ids**:
  the pseudonym map (`pseudonimo-conta`, `pseudonimo-deposito`), one row per
  finding (`kit-vinculado`, `componente-acima-do-limite-em-linha`,
  `sem-registro-no-deposito`, `estoque-ambiguo`, `kit-componente-sem-registro`,
  `vinculo-duplicado`, `estoque-duplicado`, `estoque-sem-parentid`) and one `skip`
  row per shape it could not read. It stays on the owner's machine.

Every per-day figure is a lower bound: a record or produto counts once, on the day
of its LAST stamp, and a stamp that is not a number is invisible to the range
(counted apart). `linhasDaRazao` — ledger rows — is the closer measure of stock
writes; `registros` is its floor. The ledger is read only for records whose own
stamp is in the window or is not a number (the rows of the latter are also totalled
apart, `linhasDaRazaoDeRegistrosSemCarimbo`). A write that adds a ledger row
without moving a numeric stamp from before the window is therefore in **neither**
measure; read both as floors, never as the exact E.

The window's last day (`janela.ate`) is today, a partial day: it keeps its own row
in `dias` and `porDia`, and `mediaDiaria` averages the `janela.diasCompletos` days
before it (`null` with `--dias 1`). `maximoDiario` includes today.

## What to paste back

**Only the summary JSON** (the `-resumo.json` file, or the `RESUMO` line). Never
the JSONL: it carries produto, conta and depósito ids.

## ⛔ Agents never run this

The owner runs it, on the legacy project, with the legacy credentials. Agents
build and test it against fakes only.

## Code

- `src/2026-11-li-estoque-contagens/audit.ts` — the reads, in order, and the
  flags; no write path.
- `src/2026-11-li-estoque-contagens/predicate.ts` — every decision and count,
  pure; its tests pin each same/different decision from both sides and that the
  summary carries no id.
- The two key walks are listed in `key-walks.json` (their `__name__` indexes serve
  an Enterprise rehearsal; Standard needs none).
