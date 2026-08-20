# Migration: telefone → E.164 (`2026-08-telefone-e164`)

Rewrites every stored telefone to the repo's wire format — digits-only E.164
without the leading `+`, e.g. `5511999998888` — the format
`packages/core/src/phone/index.ts` documents and every lookup expects.

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
| `endereco` | `clientes/{id}/enderecos.telefone`        | 🚧 **Gated** — feeds Melhor Envio `to.phone`.                                                                                 |
| `filial`   | `filiais.sede.telefone`                   | 🚧 **Gated** — feeds Melhor Envio `from.phone`.                                                                               |
| `intFrete` | `int_frete.enderecoDeOrigem.telefone`     | 🚧 **Gated** — the freight-origin address.                                                                                    |
| `cheque`   | `pedidos/{id}/pagamentos.cheque.telefone` | Safe but low value — never displayed, queried or transmitted.                                                                 |

**The three gated targets must not run until the Melhor Envio question is
answered.** Every reference in the repo says ME expects the _local_ BR shape —
ME's own documented example, transcribed at
`tools/test-fixtures/src/debug-me-cart.ts`, uses `11912345678`; the freight
tests use local numbers; and the legacy Flutter app, which wrote raw phones,
sent a local number. Nothing in the repo says whether ME hard-rejects,
normalizes, or silently mangles a `55…` value. Normalizing these fields before
that is settled could break label purchase. See the tracking issue.

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

## Running it

Dry-run by default; `--project` is required and never inferred. Every intended
change and every non-empty skip is written to a timestamped JSONL file under
`tools/migrations/out/`.

```bash
pnpm --filter @delfrance/migrations migrate:telefone-e164 -- --project <staging-id>
```

Then read the log, confirm the change/skip counts, and only then:

```bash
pnpm --filter @delfrance/migrations migrate:telefone-e164 -- --project <staging-id> --apply
```

Re-run the dry form afterwards — a clean second pass (all `already-normalized`)
is the idempotence check.

```bash
pnpm --filter @delfrance/migrations migrate:telefone-e164 -- --project <id> --target clientes,cheque
```

## Order of operations

1. Dry run on **staging**, read `out/`.
2. Apply on staging → re-run dry to confirm idempotence.
3. Dry run on **production**, read `out/`, review the `invalid` skips with an
   operator.
4. Apply on production — in the Flutter cutover window, not before.
5. Only after step 4 and a clean dry run: consider simplifying
   `telefoneQueryShapes`.

Nested fields are written with a **dotted key** (`sede.telefone`), never a
nested object: `update()` replaces a nested map, which would wipe every sibling
field of `sede`.

The migration scans **collection groups**, which are unindexed on Firestore
Enterprise and therefore full scans billed by data scanned. Acceptable for a
one-shot manual run — which is exactly why this is a script an operator invokes
and not something scheduled.
