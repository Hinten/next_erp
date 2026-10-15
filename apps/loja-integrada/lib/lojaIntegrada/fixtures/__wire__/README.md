# Loja Integrada wire fixtures

Every other file in this folder is one fixture envelope, `<nome>.json`, written by
`scripts/sanitizar.ts` and by nothing else. Do not hand-edit one: re-run the sanitizer.

## Provenance

- The bodies are real Loja Integrada responses, captured by the store owner himself
  (read-only requests, by his own means), kept outside every repository checkout, and
  converted offline by `scripts/sanitizar.ts`. No code in this repository calls Loja
  Integrada before the cutover (master plan D17).
- Personal and store-identifying values are fakes of the same JSON type: customer data,
  product names, descriptions, URLs, image paths, tracking codes, external order ids,
  configuration labels and cost (`fixture` profile of `core/redacao.ts`).
- SKUs, order numeros, dates, quantities and prices are real (master plan D17, Q3).
- Error bodies keep only their shape, booleans, null, safe integers below 1e7 and 1–7 digit
  strings under the allowed code keys; key names outside `[A-Za-z_]{1,32}` are renamed
  `chave_redigida_<n>`, and no error message text is ever kept.
- Each envelope says which credential the capture ran under, the capture date (no time
  of day), the redacted request line, the status, the body class and form, and the raw
  body's byte count.

## The corpus test

`wireCorpus.test.ts` reads this folder: every file must be a valid envelope, serialised
as `JSON.stringify(v, null, 2) + '\n'`, and pass both layers of `piiScan.ts`.
`MINIMO_DE_FIXTURES` is the number of committed fixtures (18 since the owner's first
captures, step 3), so a fixture that disappears fails the test. A change that adds or
deliberately removes a fixture moves it in the same commit.

## Excluded on purpose

- `pedido-enviado`: the owner's raw pair requested the same order as `pedido-boleto` and
  sanitized to identical bytes, so it is not committed. The shipped state is still
  covered: `pedido-pix` and `pedido-cartao` are orders in `pedido_enviado` with a tracking
  code under `envios`, and `historico-pedido-enviado` is a shipped order's status history.
  The raw pair stays in the owner's capture folder until he deletes it, and a sanitizer
  run without `--so` would write it back: delete that raw pair first, or regenerate with
  `--so` naming only the pairs wanted.

This folder is excluded from Prettier and checked out with LF line endings
(`.prettierignore`, `.gitattributes`), so a re-run over an unchanged capture writes
identical bytes.
