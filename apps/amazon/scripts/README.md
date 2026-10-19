# `sanitizar`: the offline capture sanitizer

No code in this repository calls Amazon before the cutover (master plan D11, "mock only").
When a step needs a real response, the owner captures it himself, keeps it **outside every
repository checkout**, and this script turns it into a committed fixture under
`lib/amazon/fixtures/__wire__/`.

## What it reads and writes

- It reads the capture pairs in the folder given by `--entrada`, plus that folder's
  `nomes-proibidos.txt` and `.sal-sanitizador`. With `--verificar`, it reads the text files
  it is given.
- It writes `lib/amazon/fixtures/__wire__/<nome>.json`, one per pair, and only when every pair
  is clean: **any finding refuses the whole run and writes nothing**. Every fixture goes to a
  temporary file first and is renamed into place only once all of them are written. The one
  other file it ever creates is the salt, once, beside the captures.
- It never calls the network, never reads a token or an environment variable, and never
  starts a process. `lib/amazon/estrutura.test.ts` walks its import closure to prove it. All
  the logic lives in `lib/amazon/sanitizacao/`; the script only binds the file system to it.
- It never prints a value from a capture: only request lines after redaction (and only when
  they trip no pattern and no listed term; otherwise `<omitted: it trips <kind>>`), leaf paths
  with their JSON types and treatments, and findings as `<nome> <where> :: <kind>`. The only
  values it prints are closed-grammar enums (`paymentMethod`, `programs`, `detailedStatus`,
  `packageStatus`, `taxRegistrationType`, `taxRegistrationAttributes[].key`); a document leaf
  prints its SHAPE class only (`cpfPontuado`, `cnpj14`, `cnpjRaiz8`, …).

## Commands

`pnpm --filter` runs the script from `apps/amazon`, so pass absolute paths.

```bash
# What would be written: request lines, leaf tables, findings. Writes no fixture.
pnpm --filter @delfrance/amazon-app sanitizar --entrada "$HOME/amazon-capturas" --dry-run

# Write the fixtures (all pairs, or only some with --so).
pnpm --filter @delfrance/amazon-app sanitizar --entrada "$HOME/amazon-capturas"
pnpm --filter @delfrance/amazon-app sanitizar --entrada "$HOME/amazon-capturas" --so c1-pedido-cpf

# Before every push that touches docs or fixtures: the denylist and every pattern over the files.
pnpm --filter @delfrance/amazon-app sanitizar --entrada "$HOME/amazon-capturas" --verificar /abs/path/fixture.json /abs/path/pr-body.md
```

- `--verificar` prints `<file>:<line> :: <kind>`, never the term or the value. It also reads
  every window of 2 and 3 consecutive lines joined, so a listed term split by a hard wrap is
  reported as `<file>:<first>-<last> :: <kind>`, and a line's string escapes decoded.
- `--sobrescrever` replaces an existing fixture whose bytes differ; identical bytes are always
  a no-op.
- **A raw duplicate pair left in the folder is written back by any run without `--so`.**
  Delete it, or name the wanted pairs with `--so`.
- Exit codes: 0 done (or a clean dry run or check), 1 refused (no fixture written), 2 usage
  error, 70 unexpected error (only the error's class and code are printed, plus which
  fixtures were written when it struck while writing).

## Who runs it

An agent may run it on the owner's captures once he says they are in place, and reads
**only its output and the sanitized fixtures**. An agent never opens a raw capture by any
other means: no `cat`, no editor, no file-reading tool. This repository is public, so a
pushed branch is published: the owner sees the fixtures (or their diff) before any push.

## Capturing (the owner)

### The folder

- One capture folder for every branch, worktree and session. It must sit **outside every
  repository checkout and worktree** (the sanitizer refuses a folder with a `.git` entry in it
  or above it), outside every cloud-synced folder, and on an encrypted volume (BitLocker; DPP
  §2.3.2).
- `nomes-proibidos.txt` lives there: one term per line (store and legal names, the seller id,
  the application id, AWS account ids and ARNs, the receiver host), `#` for comments, UTF-8,
  at least 4 letters or digits per term. Seed it from the private identifiers list. The
  sanitizer refuses to run without it, refuses any fixture where a listed term survives, and
  never prints a term. It never enters the repository.
- `.sal-sanitizador` is created by the first run that converts pairs (32 random bytes; a dry
  run or a refused run too, and the output then says so). It keys every fake, so the same
  capture always gives the same fixture; delete it together with the captures.
- **Never in the folder:** a `*.har` (of any kind), a `.env*` file, a label zip, a ZPL, a PDF
  or a gzip. The sanitizer refuses the whole run on the first bytes of any such file and
  never opens it.
- The sanitizer runs **the same day** as the capture. The raw files are deleted right after
  it succeeds, and in any case within 30 days of the order's delivery (DPP §2.1). A capture
  is never pasted into a chat (AUP §4.1/§4.7).

### A capture is a pair

`<nome>` is lowercase letters, digits and `-`, at most 40 characters, and describes the
request (`c1-pedido-cpf`, `c1-cancelado-depois`), never an order, a store or a person: it
becomes the committed fixture's file name. A run of 6 or more digits, or of 8 or more split by
`-` (an order id, a phone, a CEP, a document, a date), is outside the grammar and refuses the run. Every file is
a regular UTF-8 file.

- `<nome>.json`: the response body exactly as received.
- `<nome>.txt`: the sidecar, these lines only:

  ```text
  GET /orders/2026-01-01/orders/000-0000000-0000000?includedData=BUYER 200
  credencial: token-legado-curl
  papeis: dtc,tax-invoicing
  data: 2026-10-20
  limite-taxa: 0.0167
  ```

  - Line 1 is `METHOD URL STATUS`: the URL exactly as requested, either as a path only (as
    above) or with the `https://sellingpartnerapi-na.amazon.com` origin in front (what curl's
    `%{url_effective}` writes); a trailing slash matters.
    A notification is `NOTIFICACAO ORDER_CHANGE sqs` (or `pipe`).
  - `credencial:` is **mandatory**: `token-legado-curl` (your own curl, GET only),
    `copia-do-legado` (copied from the legacy app's own traffic or logs: mandatory for a write
    endpoint), `modelo-sandbox` or `documentacao-aws` (examples, never production).
  - `papeis:` is **mandatory**: the roles the capture was made under — `dtc`,
    `tax-invoicing`, `tax-remittance` (comma-separated), or `nenhum`; `nao-se-aplica` only
    for the two example credentials. A capture made without DTC and Tax Invoicing silently
    lacks the buyer's data, so the fixture records it.
  - `data:` (optional, else the body file's modification date in UTC) and `limite-taxa:`
    (optional, the `x-amzn-RateLimit-Limit` header's value).
  - **Never a header line.** Any other line refuses the pair, and so does a host other than
    the SP-API one (LWA, S3, a pre-signed URL), a query key that names a credential, a query
    value that is a URL, a `/documents` or token path, or an operation whose redaction table
    does not exist yet.

- `<nome>.req.json` (optional, POST bulk only): the request body.
- `<nome>.zip.txt` (optional, POST bulk only): the label zip's listing, one `<bytes> <name>`
  per line. Names are shape-faked (only a label or document extension such as `.zpl` or
  `.pdf` is kept) and sizes kept. **Never the zip itself.** Raw `unzip -l` output (its
  header, dates and totals) is refused line by line, so convert it where the zip lives,
  never inside the capture folder; `unzip -l` reads the central directory without
  extracting anything, and the conversion keeps only the size and name columns:

  ```bash
  unzip -l <label>.zip \
    | awk 'NR>3 && NF>=4 && $1 ~ /^[0-9]+$/ { n=$1; sub(/^ *[0-9]+ +[^ ]+ +[^ ]+ +/, ""); print n " " $0 }' \
    > ~/amazon-capturas/<nome>.zip.txt
  ```

### With curl (Git Bash), GET only

The helper reads the access token without echoing it and hands the header to curl on stdin,
so the token is never in the command line, the shell history or a file. curl writes the
sidecar itself; the helper drops an empty `limite-taxa:` line and prints line 1 so a wrong
request shows at once.

```bash
amz_capturar() {  # amz_capturar <nome> '<path and query>' '<papeis>'
  local nome="$1" caminho="$2" papeis="$3" token
  read -rsp 'Access token: ' token; echo
  printf 'x-amz-access-token: %s\n' "$token" \
    | curl -sS --proto =https -H @- -o "$nome.json" \
        -w "GET %{url_effective} %{http_code}\ncredencial: token-legado-curl\npapeis: $papeis\nlimite-taxa: %header{x-amzn-ratelimit-limit}\n" \
        "https://sellingpartnerapi-na.amazon.com$caminho" > "$nome.txt"
  unset token
  sed -i '/^limite-taxa: *$/d' "$nome.txt"
  head -n 1 "$nome.txt"
}
cd ~/amazon-capturas && amz_capturar c1-pedido-cpf '/orders/2026-01-01/orders/<orderId>?includedData=BUYER,RECIPIENT,TAX,PAYMENT,PROCEEDS,FULFILLMENT,PACKAGES,CANCELLATION' dtc,tax-invoicing
```

- **Never** "Save all as HAR" and **never** "Copy as cURL": both carry the access token.
- **Write endpoints are never curled.** C3 (the Easy Ship bulk response) comes only as a copy
  of the legacy app's own traffic or logs, with `credencial: copia-do-legado`.

### What to capture

Each batch is captured before the step that needs it merges and is sanitized the same day.
One pair per item, where such an order exists.

- **C1, orders** (before step 5), `token-legado-curl`, `papeis: dtc,tax-invoicing`:
  `GET /orders/2026-01-01/orders/<orderId>?includedData=BUYER,RECIPIENT,TAX,PAYMENT,PROCEEDS,FULFILLMENT,PACKAGES,CANCELLATION`
  (the full list: a shorter one silently drops the blocks the steps read) for:
  - (1) a CPF buyer, UNSHIPPED; (2) a CNPJ buyer;
  - (3) CreditCard, (4) Pix, (5) boleto; (6) a discounted order;
  - (7) a DBA order in PENDING_SCHEDULE, and (8) the same order after pickup;
  - (9) and (10) one order before AND after its cancellation (two dates, two names);
  - (11) a refunded or returned SHIPPED order; (12) a SHIPPED order past its delivery
    date; (13) a PENDING order;
  - (14) one `GET /orders/2026-01-01/orders?…&maxResultsPerPage=<small>` page, for the
    pagination shape.
- **C2, invoice status** (before step 14), `token-legado-curl`:
  `GET /delivery/2022-07-01/invoice/status?orderId=…&marketplaceId=…&invoiceType=Outbound&programType=EasyShip`
  for one Accepted order and one not accepted (if any), plus one `invoiceId=<chave>` variant.
- **C3, Easy Ship bulk** (before step 15), `copia-do-legado` only: the legacy app's bulk
  response to its reprint of an already-scheduled order (and of the first print, if still
  available), sidecar `POST /easyShip/2022-03-23/packages/bulk 200`, with the optional
  `.req.json` and `.zip.txt` above. Never curled, never the zip.
- **C4, ORDER_CHANGE**: nothing. It is agent-made from the schema example
  (`modelo-sandbox`).
- **C5 (listings and the listings report) and C6 (External Fulfillment returns)**: not yet.
  Their tables arrive with steps 9 and 22, and so do their capture lists.
