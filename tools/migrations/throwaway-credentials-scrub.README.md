# throwaway-credentials-scrub

`src/2026-12-throwaway-credentials-scrub/` — removes every legacy credential from
a **throwaway test project** after its seed import (ADR 0013, amendment
2026-11-26).

> ⚠️ **Test project only, and human-run.** Never against the real new project:
> the real migration needs these tokens current. `--confirm-throwaway` must
> repeat the project id, so this cannot run by accident with a stray `--project`.

## Why

The seed import copies the legacy corpus as it is, live credentials included.
The Mercado Livre (`tokenDuravel`) and Melhor Envio (`tokenMelEnv`) refresh
tokens are **single-use**: the first refresh the test stack makes would rotate
them and cut production off from that channel. Even a read can trigger one.

The mirror running with `LEGACY_MIRROR_CREDENTIALS=deny` never copies them. This
script removes the ones the **import** brought in. Both use the same list,
`apps/legacy-mirror/functions/src/credentials.ts`.

It deletes:

- every document in `integracao/*/{tokenDuravel, token6h, token, tokenoaut, tokenMagalu, actokshopee, credenciais*}`,
  `integracoes/*/token`, `int_frete/*/tokenMelEnv`,
  `metodo_pgto/*/{token6hmp, tokenDuravelmp, credenciais}`, and
  `filiais/*/{certificados, certificadoSecreto}`, with any subcollections below
  them;
- the `permanent_token` and `pin` fields on `integracao/*` documents.

## Run — after the import, BEFORE any deploy to the test project

```bash
# Dry-run: lists what it would delete.
pnpm --filter @delfrance/migrations migrate:throwaway-credentials-scrub \
  --project <TESTE> --confirm-throwaway <TESTE> --service-account <teste-sa.json>

pnpm --filter @delfrance/migrations migrate:throwaway-credentials-scrub \
  --project <TESTE> --confirm-throwaway <TESTE> --service-account <teste-sa.json> --apply
```

Run the dry-run again afterwards. It must report `0 credential document(s)`.

## Log

`out/<stamp>-throwaway-credentials-scrub[-dryrun].jsonl` holds paths and field
names only. The scan reads keys (`select()`), never the secret values.
