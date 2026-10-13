# Audit: the `ehKitVirtual === true` contagem (Shopee step 19, L7)

**Status: AUDIT ONLY — a read-only COUNT for Lucas's review; no `--apply` path, never writes.**

## Why

Shopee step 19 (#1527) gives `ehKitVirtual` a meaning on Shopee: the FIRST
publish of a produto with `ehKit && ehKitVirtual` and no live Shopee link goes
to `add_kit_item` — a native kit whose composition is frozen once created —
instead of `add_item`.

The legacy Flutter app set the flag for Mercado Livre "User Products" kits
(`exportarProdutos.dart:157-170`, ML `models.dart:1787-1873`). The imported
corpus can therefore carry `true` on produtos nobody meant as a native Shopee
kit. Lucas's old Shopee kits are ordinary listings with the flag false/null
(2026-10-07).

This script lists every produto whose flag is `true`, split by whether it
carries a Mercado Livre link. **Lucas reviews the list and decides produto by
produto** (switch the flag off on the produto screen, or keep it). Nothing is
flipped by a script; there is no backfill.

It is named a **contagem**, never a census: Lucas rejected a census of native
kits (step 19's L7) — old kits cannot become native without a delete + create he
does by hand.

## When

At the cutover, in the migration window (root `CLAUDE.md` rule 8, ADR 0013):

- on the **NEW** project,
- right after the Firestore import,
- and BEFORE production `apps/shopee` App Hosting serves a `--live` publish.

Earlier is wrong: the legacy app is the only writer of the SOURCE project until
the window switches it off, so a count taken before the import is superseded by
its own later writes. The window issue is **#1854**
(`needs-migration-window` + `task: ops-deploy`), linked from #1208.

## Run it

```bash
pnpm --filter @delfrance/migrations audit:kit-virtual-contagem --project <id-do-projeto-novo>
```

`--project` is required, never inferred, and matched against the service
account (`src/admin.ts` refuses a mismatch). Credentials come from
`FIREBASE_SERVICE_ACCOUNT` / `FIREBASE_SERVICE_ACCOUNT_PATH` (the script loads
`.env.local`) or `--service-account <path>`. `--apply` is REJECTED, not ignored.

A staging run is a rehearsal only, and it is Lucas's to run.

## Reading the output

`tools/migrations/out/<timestamp>-kit-virtual-contagem-dryrun.jsonl` — one line
per produto with `ehKitVirtual === true`. Each line is the runner's shape:

- `path` — `produtos/<id>`;
- `field` — the split: `com-mercado-livre` or `sem-mercado-livre`, so the file
  greps by it;
- `from` — `null` (nothing is ever written);
- `to` — the row.

| `to` field        | What it says                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `produtoId`       | the produto                                                                                                                          |
| `paiId`           | `null` for a root; the parent's id for a child (a família-de-um member mirrors the parent's flag and is never published on its own)  |
| `ehKit`           | `ehKit === true`, strictly                                                                                                           |
| `temComponentes`  | `componentesKit` has at least one component                                                                                          |
| `comMercadoLivre` | `mlNoProduto` OR `mlNosFilhos`                                                                                                       |
| `mlNoProduto`     | an ML link doc in the produto's OWN subcollections — `produtoMercadoLivre` or `variacaoMercadoLivre`                                 |
| `mlNosFilhos`     | ANY child holds a `variacaoMercadoLivre` doc — every child is asked; one child alone does not decide                                 |
| `comShopee`       | a Shopee link doc (`prodshopee` or `variashopee`) in the produto's own subcollections, whatever its estado or conta — a fact to read |

On stdout:

- the total, split by `comMercadoLivre`;
- the subset `ehKit !== true` — step 19's publisher refuses those
  (`kit-virtual-sem-kit`), and the produto screen switches the flag off on the
  next save;
- `comShopee` and how many rows are children.

A row `comMercadoLivre: true` is most likely a legacy User Products kit: the flag
was set for ML, not for Shopee. A root row with `ehKit: true`, no Shopee link and
`comMercadoLivre: false` is the one a first Shopee publish would turn into a
native kit.

## Verify

- Run it twice: the counts and the JSONL are identical (a pure read, idempotent).
- Open three rows on the produto screen and check the flag, the components and
  the ML link.
- Lucas approves the list on #1854 before production `apps/shopee`
  serves publishes.

## Cost

No index is needed, and none should be added. The walk is a plain
`orderBy(documentId())` key-order scan of `produtos`, with
`ehKitVirtual === true` tested in memory — the `2026-08-ml-pedido-pago-audit`
shape, and the one ordering Firestore always serves without a declared index.
`where('ehKitVirtual','==',true)` looks cheaper and is not: Firestore
**Enterprise** never throws `FAILED_PRECONDITION` for a missing index; it silently
full-scans and bills data scanned. Indexing it would need a NEW composite for a
one-off report.

Only a counted row pays for more reads:

- four `limit(1)` reads of its own subcollections: `produtoMercadoLivre`,
  `variacaoMercadoLivre`, `prodshopee` and `variashopee`. Both kinds are read
  because a mirrored member holds the variation kinds;
- the children query `where('paiId','==',<id>)`, the shape the app already runs,
  served by the declared `produtos (paiId, …)` composites;
- one `variacaoMercadoLivre` `limit(1)` read per child.

That is 5 + F reads per row, F being the number of children.

## Code

`src/2026-10-kit-virtual-contagem/`: `audit.ts` (the walk, no write path),
`predicate.ts` (row → JSONL line, pure) and their tests. The predicate's truth
table includes a family whose ML link sits on its SECOND child only.
