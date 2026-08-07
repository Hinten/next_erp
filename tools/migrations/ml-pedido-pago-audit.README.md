# Audit: ML pedidos at `pago` without approved payments (#791)

**Status: AUDIT ONLY — this script has no `--apply` path and never writes.**

## Why

Until #791, the Mercado Livre order import's primary `pago` advance summed
**every** pagamento regardless of status (`orderImport.ts`'s `sumAllValores`).
A **rejected** payment therefore counted toward the total, so a pedido could
reach `pago` unpaid — and `pago` authorizes dispatch and NF-e emission.

The fix makes the advance approved-only, but it is **one-way**: pedidos already
at `pago` do not self-correct. This report finds them so a human can decide,
one by one, what each one should be.

## Run it

```bash
pnpm --filter @delfrance/migrations audit:ml-pedido-pago -- --project <project-id>
```

Output: `tools/migrations/out/<timestamp>-ml-pedido-pago-audit-dryrun.jsonl`,
one line per flagged pedido, plus a per-`kind` count on stdout.

Run it **twice**: once on production before the fix merges (the baseline), and
again after the deploy has soaked. `never-covered` must not have grown.

Staging first, to confirm the walk works. Credentials come from
`FIREBASE_SERVICE_ACCOUNT` / `FIREBASE_SERVICE_ACCOUNT_PATH` (the script loads
`.env.local`) or `--service-account <path>`. `--project` is required and never
inferred.

## Reading the output

| `kind`                | What it means                                                                                                                                                                              | What to do                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `never-covered`       | Even summing every pagamento regardless of status falls short. Either the advance was wrong from the start (the defect), or `valorCobrado` was raised afterwards by a frete re-conference. | Judge from `valorCobrado` / `somaTodos` / `deficit` on the row. This is the count that must not grow after the deploy. |
| `refunded-after-pago` | Sum-of-all covers it, approved-only does not — a refund, chargeback or rejection landed **after** the advance.                                                                             | Usually not a defect: the advance may well have been correct when it happened. A business decision.                    |

There is deliberately **no third kind** for "`valorCobrado` was raised". It is
not decidable from the document as it stands — it needs the value the threshold
had at advance time, and nothing records that. Every row carries the numbers so
a human can tell the two apart, rather than a script putting a confident label
on a guess.

Also on each row:

- **`fonte`** — `pagamentos` (this app), `pagamento` (legacy Flutter, singular),
  or `ambos`. Both paths are read and unioned by pagamento id. Reading only the
  plural path would report a **false positive** on every pedido whose payments
  came from the Flutter app.
- **`orderIds`** — from the pedido's `orderML` mirror, so each row is a link you
  can open in Mercado Livre. Only the ML import writes that collection, so a
  non-empty mirror also confirms the pedido really is ML-sourced.
- **`ultimaModificacao` vs `lastMarketplaceUpdate`** — a row where the first runs
  well ahead of the second is a pedido a human touched. That is the exact class
  whose ML sync the retired clock gate used to block, so these come free in the
  same pass and size #791's blast radius.

## Cost

No index is needed, and none should be added. The walk is a plain
`orderBy(documentId())` key-order scan with filtering done in memory — the one
ordering Firestore always serves without a declared index. The narrower
`where('estado','==','pago')` form looks cheaper and is not: Firestore
**Enterprise** never throws `FAILED_PRECONDITION` for a missing index, it
silently full-scans and bills data scanned, and making it genuinely indexed
needs a **new composite** (`estado ASC, __name__ ASC` — Enterprise omits the
implicit trailing `__name__`), i.e. an index deploy and a build wait, for a
one-off read-only report.

Only pedidos that pass the two cheap in-memory filters (`estado === 'pago'` and
an ML `integracaoPedidoOuterRef`) pay for the subcollection reads.

## Related

- `tools/migrations/pedido-pagamento-micros.README.md` — the datetime backfill,
  and its `--report-only` pre-flight.
- `src/2026-08-ml-lastmarketplaceupdate/backfill.ts` — the mandatory
  `lastMarketplaceUpdate` correction, run **after** the #791 functions deploy.
