# Migration: telefone → E.164 (`2026-08-telefone-e164`)

Rewrites every stored telefone to the repo's wire format — digits-only E.164
without the leading `+`, e.g. `5511999998888` — the format
`packages/core/src/phone/index.ts` documents and every lookup expects.

Production execution is a coordinated cutover operation in
[#1208](https://github.com/Hinten/next_erp/issues/1208), never part of deploying
this code.

## Why the collection is mixed today

This app has normalized on write since the format was introduced, but there was
never a backfill, and two things keep the old shape alive:

1. **The stored corpus is full of raw 10/11-digit BR numbers** (DDD + subscriber,
   no country code) — that is what the legacy app wrote, and it keeps writing more
   of them into the source project until the cutover switches it off. Those rows
   arrive with the import and stay until this script runs, which is why
   `telefoneQueryShapes` searches both shapes.
2. **Editing a cliente does not re-normalize it.** `ObjectView` only transforms
   fields the operator actually touched, so an untouched legacy phone is written
   back unchanged.

## ⚠️ Read this before scheduling the run

**A run today is partially undone by every subsequent Flutter write.** That is
not a flaw in the script — it is why the script is idempotent and re-runnable.
Plan on:

- **a dry run now**, to learn the scale (how many rows, how many skips and why);
- **the authoritative run inside the Flutter cutover window**, once that writer
  is retired.

**Do not simplify `telefoneQueryShapes` afterwards** — dropping the legacy shape
from the `in` query is only safe once the Flutter writer is gone _and_ a
follow-up dry run reports zero remaining raw values. Until both hold, a
simplified lookup silently stops finding clientes.

## Targets, and why the order matters

Targets are **opt-in** via `--target`; the default is `clientes` alone.

| `--target` | field                                     | status                                                                                                                        |
| ---------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `clientes` | `clientes.telefone`                       | **Run this first.** The dedup key, the WhatsApp `wa_id` join, and the only phone field carrying the `isValidTelefone` refine. |
| `endereco` | `clientes/{id}/enderecos.telefone`        | Safe to normalize; Melhor Envio `to.phone` is converted back to the documented local shape at its boundary.                   |
| `filial`   | `filiais.sede.telefone`                   | Safe to normalize; the fallback for Melhor Envio `from.phone` crosses the same boundary.                                      |
| `intFrete` | `int_frete.enderecoDeOrigem.telefone`     | Safe to normalize; the freight-origin phone crosses the same boundary.                                                        |
| `cheque`   | `pedidos/{id}/pagamentos.cheque.telefone` | Safe but low value — never displayed, queried or transmitted.                                                                 |

[#868](https://github.com/Hinten/next_erp/issues/868) settled the Melhor Envio
contract: its cart documentation uses `11912345678` / `41912345678`, and its
store-phone endpoint uses `11987654321`; neither promises that an E.164 `55…`
value is accepted or normalized. The ERP therefore keeps E.164 as its stored
shape and sends local 10/11-digit BR phones only at the ME boundary. This makes
all three address targets safe to normalize without relying on undocumented
provider tolerance.

## What the transform decides

| stored value                                    | verdict                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| absent / `''` / not a string                    | skip `empty` (not logged — most docs in a collection group have no phone at all) |
| contains `*` (provider-redacted)                | skip `masked` — normalizing would invent digits                                  |
| already canonical                               | skip `already-normalized` ⇒ **idempotent**                                       |
| 10/11 digits, or punctuated                     | **change** → `55…`                                                               |
| still fails `isValidTelefone` after normalizing | skip `invalid`                                                                   |

The `invalid` skip is deliberate: writing such a value would store something
`clienteSchema.telefone`'s refine rejects, making the record unsavable from the
web form — strictly worse than leaving it alone. Those rows want a human.

Foreign numbers already carry their own country code (12+ digits), so they take
the `already-normalized` branch and are never touched.

**Short international numbers (#1084):** for `clientes`, explicit `+`,
`tipo == Estrangeiro`, or `telefoneGerenciado == true` selects the international
normalizer: `+1 415 555 2671` becomes `14155552671`, never `5514155552671`.
When a changed cliente uses this context the pass also records
`telefoneGerenciado: true`, so a second pass retains the context after removing
the `+`. A bare 10/11-digit number with no context remains ambiguous and follows
the historical BR assumption; audit/review these before applying. This flag is
not proof that the person owns a WhatsApp number.

## Running it

Dry-run by default; `--project` is required and never inferred. Every intended
change and every non-empty skip is written to a timestamped JSONL file under
`tools/migrations/out/`.

```bash
pnpm --filter @delfrance/migrations migrate:telefone-e164 --project <staging-id>
```

Then read the log, confirm the change/skip counts, and only then:

```bash
pnpm --filter @delfrance/migrations migrate:telefone-e164 --project <staging-id> --apply
```

Re-run the dry form afterwards — a clean second pass (all `already-normalized`)
is the idempotence check.

```bash
pnpm --filter @delfrance/migrations migrate:telefone-e164 --project <id> --target clientes,cheque
```

For the complete cutover pass tracked by #1208, select every target explicitly:

```bash
pnpm --filter @delfrance/migrations migrate:telefone-e164 --project <production-id> --target clientes,endereco,filial,intFrete,cheque
```

## Order of operations

1. Dry run on **staging**, read `out/`.
2. Apply on staging → re-run dry to confirm idempotence.
3. In #1208's cutover window, dry run **production** with every explicit target,
   read `out/`, and review the `invalid` skips with an operator.
4. Apply the same target set on production — in the Flutter cutover window, not
   before.
5. Only after step 4 and a clean dry run: consider simplifying
   `telefoneQueryShapes`.

Nested fields are written with a **dotted key** (`sede.telefone`), never a
nested object: `update()` replaces a nested map, which would wipe every sibling
field of `sede`.

The migration scans **collection groups**, which are unindexed on Firestore
Enterprise and therefore full scans billed by data scanned. Acceptable for a
one-shot manual run — which is exactly why this is a script an operator invokes
and not something scheduled.
