# Migration: imposto-legacy-names (#398)

Copies + translates the tax-config docs the **legacy Flutter ERP** wrote into
the subcollections the **new imposto resolver** reads. Until this runs, any
tax config that only exists in the legacy shape silently falls through to the
operação default at NF-e emission (wrong CFOP/CSOSN, no error).

## What it does

| Legacy (Flutter wire)       | New (resolver reads)                 | Translation                                                                                                                         |
| --------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `categorias/{id}/imposto/*` | `categorias/{id}/impostocategoria/*` | scope key `impostoCategoriaOperacaoOuterRef` → `impostoOperacaoOuterRef`, ref normalized to `operacao/<id>`                         |
| `operacao/{id}/regras/*`    | `operacao/{id}/regraimposto/*`       | `CFOP` → `cfop`; `produtos`/`categorias` path entries → bare uids; `ncms` → digits-only 8 (non-conforming entries dropped + logged) |

- **Copy, not move** — the legacy app keeps reading its own paths until it is
  decommissioned.
- **Idempotent** — a target doc with the same id is never overwritten
  (protects docs created/edited via the new tax editor); re-runs are safe.
- `produtos/{id}/imposto` is **untouched**: the resolver already reads that
  subcollection in its legacy shape (Flutter's typo scope key
  `impostoOpercaoOuterRef` included).
- Translated docs are validated with the real `impostoCategoriaSchema` /
  `regraImpostoSchema` before writing; failures are logged and skipped —
  fix the legacy doc and re-run.

## Running

Dry-run first (writes nothing, logs every intended copy/skip to `out/`):

```bash
pnpm --filter @delfrance/migrations migrate:imposto-legacy-names -- --project <staging-id>
```

Inspect the `out/<timestamp>-imposto-legacy-names-dryrun.jsonl` log, then:

```bash
pnpm --filter @delfrance/migrations migrate:imposto-legacy-names -- --project <staging-id> --apply
```

Repeat against production once staging emission behaves. Credentials come
from `../../.env.local` (`FIREBASE_SERVICE_ACCOUNT[_PATH]`) or
`--service-account <path>`. On a machine with Norton TLS interception, run
with `NODE_EXTRA_CA_CERTS=<repo>\.ignore\norton-root.pem`.

## Caveats

- Tax config the legacy Flutter app writes **after** a run stays invisible to
  the new resolver until the migration is re-run. Re-run it as part of the
  legacy decommission checklist (or whenever legacy-side tax edits happen).
- Unknown legacy-only fields are dropped (the new schemas are the source of
  truth); every rename/normalization/drop is recorded in the JSONL log.
