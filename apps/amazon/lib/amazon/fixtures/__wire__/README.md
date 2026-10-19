# Amazon (SP-API) wire fixtures

Every other file in this folder is one fixture envelope, `<nome>.json`, written by
`scripts/sanitizar.ts` and by nothing else. A fixture is never edited by hand: re-run the
sanitizer.

## Provenance

- No code in this repository calls Amazon before the cutover (master plan D11). A fixture is
  either an Amazon model's own `x-amzn-api-sandbox` example (`credencial: modelo-sandbox`) or
  a read-only response the owner captured by hand, kept outside every repository checkout and
  converted offline by the sanitizer.
- The six `sb-*` fixtures are the starting corpus: model-sandbox examples written by
  `amazon-doc.mjs exemplo` / `notif-exemplo` into a folder outside the checkout, then run
  through the sanitizer like any capture. They are not production data. From the repository
  root, with `<abs>` an absolute folder outside every checkout:

  ```bash
  node .master_plans/amazon/evidence/amazon-doc.mjs exemplo getOrder orders 0 --saida <abs> --nome sb-getorder-br
  node .master_plans/amazon/evidence/amazon-doc.mjs exemplo searchOrders orders 2 --saida <abs> --nome sb-searchorders-br
  node .master_plans/amazon/evidence/amazon-doc.mjs exemplo getInvoiceStatus delivery 0 --saida <abs> --nome sb-invoice-status
  node .master_plans/amazon/evidence/amazon-doc.mjs exemplo createScheduledPackageBulk easyShip 0 --saida <abs> --nome sb-bulk-200
  node .master_plans/amazon/evidence/amazon-doc.mjs exemplo getScheduledPackage easyShip 0 --saida <abs> --nome sb-scheduled-package
  node .master_plans/amazon/evidence/amazon-doc.mjs notif-exemplo OrderChangeNotification 0 --saida <abs> --nome sb-order-change
  pnpm --filter @delfrance/amazon-app sanitizar --entrada <abs> --dry-run
  ```

  The salt that keyed them is never committed, and each sidecar's `data:` is the day it was
  generated: a regeneration under a new salt or on another day differs from every committed
  fixture, so it needs `--sobrescrever` and rewrites every fake (and `capturadoEm`).
- Personal and store-identifying values are fakes of the same JSON type (`fixture` profile of
  `core/redacao.ts`): buyer and recipient data, names, addresses, phones, e-mails, gift
  messages, product titles, URLs. A document under `taxRegistrationNumber` or `acquirerId`
  keeps its SHAPE through a fixed placeholder.
- Ids are faked by a keyed hash (`sanitizacao/falsificacao.ts`): order ids, order item ids,
  ASINs, SKUs, package, slot, tracking, promotion, subscription and notification ids, the
  NF-e chave. The same id gives the same fake within a batch, so joins hold. A seller id is
  always `<sellerId>`.
- Dates, quantities, money, statuses and the public marketplace ids are real.
- Error bodies keep only their shape, booleans, null, integers below 1e7 and the closed set
  of Amazon error codes; no error message text is ever kept.
- Each envelope says which credential the capture ran under, the roles it was made under,
  the capture date (no time of day), the redacted request line, the status, the body policy
  and form, and the raw body's byte count. It never carries a host, a header, a file path or
  an alias.

## The corpus test

`wireCorpus.test.ts` reads this folder: every file must be a valid envelope, serialised as
`JSON.stringify(v, null, 2) + '\n'`, and pass both layers of `piiScan.ts`.
`MINIMO_DE_FIXTURES` is the number of committed fixtures (6, the model-sandbox seed), so a
fixture that disappears fails the test. A change that adds or deliberately removes a fixture
moves it in the same commit.

This folder is excluded from Prettier and checked out with LF line endings
(`.prettierignore`, `.gitattributes`), so a re-run over an unchanged capture writes identical
bytes.
