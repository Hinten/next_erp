# `li-integracoes-com-produto` — the Loja Integrada anchor census

Finds every produto holding a Loja Integrada link whose link's conta is missing
from `produtos.integracoesComProduto`, and adds the missing **Loja Integrada**
contas. Add-only. Mercado Livre and Shopee gaps on the same produtos are
reported, never applied. Amazon is out of scope.

**Status: dry run by default.** `--apply` adds Loja Integrada contas only,
through the shared core's guarded add. The window issue is **#2112**, linked
from #1208.

## Why it exists

`produtos.integracoesComProduto` is the pre-filter every marketplace stock and
price sweep opens with (`paiId == null AND integracoesComProduto array-contains <conta>`).
A conta id in it means _"this account's sweeps visit this produto every run"_,
so a conta missing from it is a **silent stock and price outage**: the produto
is never selected and nothing logs a reason.

The Loja Integrada link trigger (`onProdutoLojaIntegradaLinkChanged`, in the
`loja-integrada` functions codebase) keeps the array in step with the link docs
from the day it is deployed. But a trigger fires only on a link WRITE, and a
Firestore import fires no triggers for any channel (root `CLAUDE.md` rule 8).
After the production data moves, nothing derives the array on arrival. This
census is the only thing that does, for every produto carrying a Loja Integrada
link.

## What it reads

| #   | Read                                                                                                                                                                                                              | Index                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | `integracao`, masked to `tipo`                                                                                                                                                                                    | none (a handful of docs)                                                                  |
| 2   | every `produtolojaintegrada` doc: a collection-group walk by document key, masked to `contaLojaIntegrada, id, removido`, pages of 300                                                                             | **`produtolojaintegrada (__name__ ASC)`, collection group** — declared for this walk only |
| 3   | the produtos those links name: point reads (`getAll`, 200 at a time) masked to `integracoesComProduto, paiId`                                                                                                     | none                                                                                      |
| 4   | for each produto that exists, its OWN `produtoMercadoLivre`, `variacaoMercadoLivre` and `prodshopee` docs: three unfiltered, unordered reads, 8 produtos at a time. `variashopee` and `prodAmazon` are never read | none                                                                                      |

Why a key walk and not a per-conta query: the only composite on the link group
filters on the two canonical conta ref forms, so it would miss a ref the shared
reader folds (a leading slash) and every link of a conta whose doc is gone,
which is the silent direction. An `array-contains` per conta over `produtos`
would full-scan once per conta on Enterprise.

⚠️ **Read 4 is unmeasured, and its bad case is quadratic.** Nobody has measured
how Enterprise plans an unfiltered read of one parent's subcollection. If it
scans only that produto's docs, read 4 is linear. If it scans the whole
collection group instead, read 4 costs (produtos with a Loja Integrada link) ×
(the size of the three groups), billed as data scanned. So the measurement is a
**precondition of the production run** (see "Rehearsal" below). The fallback, if
the plan is wide: walk each other-channel group once by key and join in memory.
The two Mercado Livre groups already have key indexes (the Mercado Livre
reconcile's rows in `key-walks.json`); `prodshopee` would need its own.

The rest is an estimate, not a measurement: one key-walk page per 300 links,
one `getAll` per 200 produtos, three small queries per produto, most of them
empty. The run prints the real counts.

## What it decides

A conta belongs on the produto **whose own subcollection holds the link**,
never on a parent or a child (every link trigger's rule). The readers are the
ones the trigger uses, imported from `@delfrance/schemas`, so there is one copy
of each rule:

- **Loja Integrada:** a link counts when `vinculoLiConta` says so (a store
  product id, as a number or its canonical decimal text, not in the trash;
  hidden and blocked links count), and its conta is `contaDoLinkLi` (both stored
  ref forms and a leading slash read the same conta).
- **Mercado Livre:** `linkHasLiveListing` on a parent link,
  `variacaoLinkHasListing` on a variation link, the conta from
  `contaDoLinkMercadoLivre` (the link's OWN `contaOuterRef`, no parent hop).
- **Shopee:** `anuncioShopeeVivo`, the conta from `contaDoLinkShopee`.

A finding names a conta only when it is an existing `integracao` doc of that
channel's `tipo`. ⚠️ That check is load-bearing: an id of another tipo added
here because a Loja Integrada link names it would be removed by that channel's
own reconcile, and the two scripts would flip the array back and forth.

Membership is checked with **no fold on the stored side**: the exact
`array-contains` the sweeps run. `' C1'` or `integracao/C1` in the array does
not hold `C1`.

## The classes

Every row of the JSONL is one finding. Rows are sorted by path, then conta,
then class, so two dry runs over the same data are byte-identical.

| Class                               | Gated   | Applied | Meaning                                                                                                                                                                                     |
| ----------------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `li-ausente`                        | **yes** | **yes** | a Loja Integrada conta with a counting link on the produto, missing from the array (absent, `null` or an array without it)                                                                  |
| `li-campo-invalido`                 | **yes** | no      | the stored field is neither absent, `null` nor an array. A union would overwrite it, so a person fixes it (below)                                                                           |
| `li-conta-inexistente`              | no      | no      | a counting link whose conta doc does not exist. Printed as a WARNING beside the gate                                                                                                        |
| `li-conta-de-outro-tipo`            | no      | no      | a counting link whose ref names a conta of another channel                                                                                                                                  |
| `li-conta-ilegivel`                 | no      | no      | a counting link whose conta ref reads as no conta at all (malformed, absent, another collection's). Invisible to the trigger, the sweeps and the order import alike: a person reads the ref |
| `li-produto-ausente`                | no      | no      | an orphan link: its produto doc does not exist                                                                                                                                              |
| `li-caminho-inesperado`             | no      | no      | a link doc that is not at `produtos/<id>/produtolojaintegrada/<doc>`                                                                                                                        |
| `li-raiz-sem-vinculo`               | no      | no      | a child holds a counting link of the conta, its root holds none: a sweep anchored on roots never visits the family. The product import's link pass (`soVincular`), or a person, fixes it    |
| `li-id-texto`                       | no      | no      | a counting link whose `id` is stored as TEXT. It keeps its conta in the anchor, but the order import looks links up by the NUMBER id, and the text matches nothing there                    |
| `li-dono-duplicado`                 | no      | no      | two existing produtos hold a link with the same (conta, stored number id), trashed or not: the order import answers "ambiguous" for that store product. One row, naming every produto       |
| `entrada-em-forma-de-caminho`       | no      | no      | the array holds an `integracao/<id>`-shaped entry. Inert for every sweep, and left in place                                                                                                 |
| `ml-ausente`, `ml-variacao-ausente` | no      | no      | a live Mercado Livre link whose conta is missing. Owner: `migrate:ml-integracoes-com-produto`                                                                                               |
| `ml-variacao-sem-conta`             | no      | no      | a variation link with no `contaOuterRef` of its own. Owner: the same script's backfill                                                                                                      |
| `shopee-ausente`                    | no      | no      | a live Shopee listing whose conta is missing. Owner: the Shopee census (#1910)                                                                                                              |
| `ml-conta-*`, `shopee-conta-*`      | no      | no      | the `-ilegivel`, `-inexistente` and `-de-outro-tipo` classes above, for those channels                                                                                                      |

Row shapes (the runner's):

- `li-ausente` is a `change`: `path` = `produtos/<id>`, `field` =
  `integracoesComProduto`, `from` = the stored value, `to` = the conta id.
- Every other class is a `skip`: `reason` = the class, `value` = `{ conta, valor }`
  (stored fields only).
- On `--apply`: a `change` with `field: "aplicado"` per add that committed, and
  a `skip` with `reason: "divergente"` per add the core declined (below).

## The gate

```
GATE li: ausente=<n> campo-invalido=<m> contas-li=<c> vinculos-que-contam=<k> produtos=<p> => PASSA|BLOQUEIA
```

- It passes only with `ausente=0 campo-invalido=0`, **and** `contas-li` and
  `vinculos-que-contam` above 0. Every other class prints a count and gates
  nothing.
- `vinculos-que-contam` counts the links actually judged: counting, of a Loja
  Integrada conta, at a well-formed path, under a produto that exists. The
  summary splits it per conta (`li conta=<id> vinculos-que-contam=<n>`).
  Compare each against that store's own product count in the Loja Integrada
  panel, and a re-run's against the first run's.
- ⛔ **`GATE li: NAO-AVALIADO <motivo>` is a stop, not a pass.** The script
  exits 1 before writing anything, in every mode:
  - `sem-contas-li` — no `integracao` of the Loja Integrada tipo (refused
    before the walk);
  - `sem-vinculos-que-contam` — Loja Integrada contas exist, but no link was
    judged.

  The plausible causes are the wrong project, the wrong database or an
  incomplete import, and on every one of them the plain counts would read
  `0 0`.

- `AVISO li: conta-inexistente=<n>` beside the gate: a bulk count there with a
  gate of `0 0` is what links pointing at a re-created conta id look like. Read
  the JSONL before going on.
- For `--apply`: `adicionados=<k> divergentes=<d>`, then the note that the
  runner's `0 writes` is expected.

Exit code: `0` for a completed run, findings or not; `1` on a refusal or a
crash.

## What `--apply` writes

For each `li-ausente` pair, one call of the core's **guarded, read-derived add**
(`adicionarContaSeViva`, `@delfrance/data/admin/produtos`), bound to the shared
Loja Integrada survivor read (`sobrevivemVinculosDoProdutoLi`, the same one the
trigger's remove runs). Never the trigger's unguarded add: this census's
evidence is a walk page read earlier, and a stale union landing after the link
was trashed would stay listed for good, because the trash's own trigger already
ran and ignores every later write to a link that no longer counts. The core
re-reads the produto's links and adds only while one still counts.

- A `divergente` row means the core declined: the link stopped counting, or the
  produto is gone. It is not a change. A re-run classifies it afresh.
- Anything the core throws aborts the run. It is idempotent: run it again.
- Each write is one `arrayUnion` of one id. The script never removes an id,
  never rewrites the array (foreign ids, duplicates and path-shaped entries
  survive), and writes no link doc.
- Produtos run 8 at a time; one produto's contas run in sequence.
- ⚠️ **`0 writes` is expected.** The core writes on its own, outside the
  runner's `BatchWriter`, so the runner's closing figure is 0 by design.
  `adicionados=` and the JSONL are the record.

**Fixing a `li-campo-invalido` row:** read the stored value from the row, then
delete the field or set it to an array by hand, then run `--apply` again, which
adds the conta.

## Running it

Run from the repo root. `--project` is required and is matched against the
service account (`src/admin.ts`), so a credential for another project refuses
to run.

1. **Right before the first dry run, after the import:** prove the walk rides
   its key index. Run from `tools/migrations`:

   ```bash
   node --env-file=../../.env.local scripts/check-key-walks.mjs --project <project-id> --only produtolojaintegrada
   ```

   Exit 0 means the walk seeks. ⚠️ Before the import the group is empty and the
   checker exits 2 ("unverified"), so this probe means nothing earlier. The
   index itself deploys with the other indexes, before the import.

2. The pre-flight count, no rows:

   ```bash
   pnpm --filter @delfrance/migrations migrate:li-integracoes-com-produto --project <project-id> --report-only
   ```

3. The dry run, with every row in `tools/migrations/out/<stamp>-li-integracoes-com-produto-dryrun.jsonl`:

   ```bash
   pnpm --filter @delfrance/migrations migrate:li-integracoes-com-produto --project <project-id>
   ```

4. If the gate reads anything but `0 0`, fix the `li-campo-invalido` rows by
   hand, then apply:

   ```bash
   pnpm --filter @delfrance/migrations migrate:li-integracoes-com-produto --project <project-id> --apply
   ```

5. **The dry run again.** It must read `GATE li: ausente=0 campo-invalido=0`
   with the same `contas-li` and a `vinculos-que-contam` at or near the first
   run's. That is the idempotence check, and the proof that the census and the
   trigger's survivor read agree.

The `ml-*` and `shopee-ausente` counts are a cross-check. They should read 0
once their own scripts have run, but they never block the Loja Integrada valves:
those channels' valves have gates of their own.

## Ordering

- **After `functions:loja-integrada` is deployed** (the trigger is live): the
  census converges the array once, and the trigger keeps it converged. Run it
  first and every link write in between re-opens the drift. Always after the
  import.
- **After the Mercado Livre reconcile (`migrate:ml-integracoes-com-produto`) and
  the Shopee census (#1910), when they have already run. Never wait for them.**
  The Loja Integrada gate depends on neither. If they have not run, run this
  anyway and read its `ml-*` and `shopee-*` counts as pre-repair.
- ⛔ **Never while the Mercado Livre reconcile's `--apply` is running.** That
  script writes the whole array from a page read, in a batch with no
  precondition (#2124), so an add of this census landing between its read and
  its commit is lost. In sequence the two are safe in either order: the
  reconcile passes every non-Mercado Livre id through.
- **Before the Loja Integrada stock and price valves reach `on`.**
- **Re-runs** (after each conta's first product import, and after the sweeps
  switch to reading the anchor) need a **quiet conta**: no import job
  `pendente` or `executando` for it. The trigger is asynchronous, so a link the
  import wrote moments before the walk can read as `li-ausente` before its own
  add lands. A transient row that slips through is harmless to `--apply`: the
  guarded add only confirms a link that counts.

## ⚠️ The key index must outlive the cutover

`produtolojaintegrada (__name__ ASC)` is migration-only, and its
`key-walks.json` row puts it in the set #1896 deletes "after the cutover". But
this census is re-run after each conta's first import, after the sweeps switch
to the anchor, possibly weeks later. **#1896 must keep it until the last
re-run.** A re-run after the delete is the whole-group scan per page that the
key indexes exist to prevent.

## Out of scope

- **Amazon.** No `prodAmazon` read and no Amazon class. Amazon's own window work
  owns its anchor.
- Magalu and Facebook links are not read.
- The legacy `marketplace[]` / `marketplaceIds[]` arrays are not link evidence.
- The reverse gap (a Loja Integrada conta in the array with no counting link)
  is not reported: this census never removes, and the trigger's remove owns it.

## Rehearsal

Every step is the owner's (root `CLAUDE.md` rule 8: the index deploy, the hand
edits, the runs). Staging carries none of the production history, so a `0`
there proves nothing about production; the rehearsal proves the mechanics.

1. If staging holds no Loja Integrada link, write one test link by hand (the
   `sem-vinculos-que-contam` refusal stops a run that judges none).
2. Remove that test produto's Loja Integrada conta from its array by hand.
3. Dry run (`ausente=1`), `--apply`, dry run (`0 0`).
4. **The read-4 measurement:** explain the three per-produto reads for one
   produto that holds links, through the SDK's pipeline translation with
   `analyze` (Enterprise refuses the classic `explain()`; `scripts/check-key-walks.mjs`
   shows how). Record the documents and index entries scanned against the
   documents returned. A scan wider than that produto's own docs means switching
   to the fallback in "What it reads" before the window.

⛔ **Agents never run this.** It runs in the migration window only (root
`CLAUDE.md` rule 8, ADR 0013).
