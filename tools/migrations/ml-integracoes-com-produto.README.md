# `ml-integracoes-com-produto` — reconcile `integracoesComProduto` + backfill `contaOuterRef`

Repairs the produto denorm array that both Mercado Livre sweeps anchor on, and
backfills the `contaOuterRef` field #920 added to `variacaoMercadoLivre` link
docs.

## Why it exists

`produtos.integracoesComProduto` is the pre-filter both ML sweeps open with —
`bulkEstoquePlan.fetchStockFamilies` S1 and `precoPlan.fetchPrecoPage` each start
with `paiId == null AND integracoesComProduto array-contains <conta>`. A conta id
in it means _"this account's sweep visits this produto every run"_, so the
array's accuracy **is** stock and price coverage.

> ⚠️ Neither sweep carries `publicado == true` any more — price since #1072,
> stock since #1087 — so this array is now the **only** server-side term between
> a live anúncio and the sweep, and its accuracy matters more than when this
> script was written, not less.

Since #920 two Cloud Function triggers own it. But a trigger only fires on a
link **write**, which leaves two populations it can never reach on its own:

1. **Pre-existing drift** — produtos whose links have not been touched since the
   triggers were deployed. This already causes silent under-sends:
   `check-stock-indexes.mjs` records that its own ratio counter is a lower bound
   because _an anchor with a live link but a stale array entry is invisible to
   the shipped sweep_.
2. **Everything that arrives by import** — a Firestore import fires **no** Cloud
   Functions triggers (root `CLAUDE.md` rule 8). After the production data moves,
   nothing derives the array or the new `contaOuterRef` on arrival. This script
   is the only thing that does.

It is idempotent and re-runnable, so it doubles as the standing repair tool if a
trigger ever loses a removal race.

## ⚠️ The safety rule

**`integracoesComProduto` is not a Mercado Livre field.** The legacy Amazon code
writes it (`.old/lib/canaisDeVenda/amazon/pages/importarProdutos.dart:1191`,
`.old/packages/canais_de_venda/amazon/lib/functions.dart:148`) and Amazon's
periodic stock sender **reads** it (`estoqueAmazonPeriodic.dart:49`).

So this script never rebuilds the array. It reconciles only ids that resolve to
an integração whose `tipo` is Mercado Livre, and passes every other id through
untouched. A wholesale rebuild would delete Amazon's entries and stop its stock
sync with nothing in the logs.

## What it does

Three paged scans, diffed in memory — deliberately **not** a per-conta
`array-contains` query, which has no index of its own and on Enterprise would
full-scan `produtos` once per conta.

1. `integracao where tipo == mercadoLivre` → the set of ids it is allowed to touch.
2. `collectionGroup('produtoMercadoLivre')`, masked to
   `contaOuterRef, id, estado` → which contas each parent produto's listings
   justify (`id != null && estado != 'c'`), plus a path→conta map for step 3.
3. `collectionGroup('variacaoMercadoLivre')`, masked to
   `contaOuterRef, produtoMercadoLivreOuterRef, id, itemId` → **writes the
   missing `contaOuterRef`** from the parent link, and derives which contas each
   variation child's links justify (`id`/`itemId` present; `estado` deliberately
   not consulted — it lives only on the parent link).
4. `produtos`, masked to `integracoesComProduto` → add what is missing, drop the
   ML ids with no surviving link, leave every foreign id alone.

A variation link whose parent link is already gone is **skipped, not guessed** —
logged as `link-pai-ausente`. Leaving a stale entry costs one skipped sweep row;
removing a live one is a silent outage.

## Running it

Dry-run is the default and writes nothing:

```bash
pnpm --filter @delfrance/migrations migrate:ml-integracoes-com-produto --project <project-id>
```

Then, to write:

```bash
pnpm --filter @delfrance/migrations migrate:ml-integracoes-com-produto --project <project-id> --apply
```

Both write a JSONL log to `tools/migrations/out/`, one line per change and per
skip. `--project` is required and is matched against the service account, so a
credential for another project refuses to run.

## Ordering

**Deploy the triggers first.** Run the script after
`firebase deploy --only functions:mercado-livre`, never before: the script
converges the array once, and the triggers are what keep it converged. Run it
first and every publish/import/cancel in between re-opens the drift.

For the production cutover the authoritative run is the one **inside** the
window, after the import — nothing recomputes on arrival.

## Verifying

1. **Staging rehearsal.** Dry-run and read the counts, then `--apply`, then
   dry-run again — the second dry-run must report **zero** changes. That is the
   idempotence check, and it is also what proves the script and the triggers
   agree. Staging data itself never needs to migrate; if it is easier to
   re-seed from `tools/test-fixtures` than to fix, re-seed it.
2. **After the production run**, re-run `check-stock-indexes.mjs` and confirm the
   sweep still rides `produtos(paiId, integracoesComProduto, __name__)`.
   ⚠️ This step used to name the four-field `publicado` composite, whose
   declaration was deleted with #1087 — checking against that name would report
   a healthy sweep as broken.
3. A dry-run reporting zero changes a day after the triggers went live is the
   proof that the two agree; once that holds, the transitional fallback hop in
   `onVariacaoMercadoLivreLinkChanged` can be deleted.
