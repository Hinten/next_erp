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
- Catalogue ids are not: in a `catalogo` fixture every Loja Integrada id (a row's `id`
  or `*_id`, the ids inside `resource_uri`, `categoria_pai`, an option's `grade` and its
  `/grade/<g>/variacao/<v>`, the ids of the request path and of `meta.next`/
  `meta.previous`, and a `produto=` query value) is a keyed 9-digit pseudonym
  (`scripts/README.md`, "The pseudonym key"). One real id is one pseudonym in every
  file and both stores, so the relations hold: a row's URI ends in its id, a
  `categoria_pai` names a category of the same store, a grade detail is a row of its
  store's grade list, and distinct rows keep distinct ids. Never key a test on a
  particular id value; the whole catalogue corpus shares ONE key, which outlives the
  raw captures, and regenerating under another key changes every id at once. Counts,
  the other query values (`limit`, `offset`), booleans and nulls are as captured, and
  so are the configuration ids (`situacao`, `pagamento`), which are platform-wide
  constants. A catalogue error body never holds a number other than its status (the
  sanitizer refuses one: it may echo an id a pseudonym cannot replace there).
- Error bodies keep only their shape, booleans, null, safe integers below 1e7 and 1–7 digit
  strings under the allowed code keys; key names outside `[A-Za-z_]{1,32}` are renamed
  `chave_redigida_<n>`, and no error message text is ever kept.
- Each envelope says which credential the capture ran under, the capture date (no time
  of day), the redacted request line, the status, the body class and form, and the raw
  body's byte count.

## The corpus test

`wireCorpus.test.ts` reads this folder: every file must be a valid envelope, serialised
as `JSON.stringify(v, null, 2) + '\n'`, and pass both layers of `piiScan.ts`.
`MINIMO_DE_FIXTURES` is the number of committed fixtures (29 since step 10: 18 from the
owner's first captures, step 3, plus the 11 catalogue captures `c9-*`), and the test
asserts the count equals it: a fixture that disappears fails, and so does one added
without moving it. A change that adds or deliberately removes a fixture moves it in the
same commit.

A change to `core/redacao.ts` can change what the sanitizer writes for a fixture already
committed. Re-run the dry run over every pair: a fixture whose bytes would change is
reported `fixture-existente-diferente`. Rewrite it in the same change with
`--so <nome> --sobrescrever`, and show the owner its diff. The corpus test catches part of
this: a resource that two fixtures hold must carry one `resource_uri` in both. It also
pins the catalogue ids' function without naming one (each row's URI ends in its id,
every `categoria_pai` names a category of its store, each grade detail is one grade
listed by its store, a store's category, grade and brand rows and a grade's options
carry distinct ids) and that every catalogue id is in the pseudonym range
`[100000000, 999999999]`.

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
