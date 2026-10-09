# `sanitizar`: the offline capture sanitizer

No code in this repository calls Loja Integrada before the cutover (master plan D17,
"mock only"). When a step needs real responses, the store owner captures read-only
production responses himself, keeps them **outside every repository checkout**, and
this script turns them into committed fixtures under
`lib/lojaIntegrada/fixtures/__wire__/`.

## What it reads and writes

- It reads the capture pairs in the folder given by `--entrada`, plus that folder's
  `nomes-proibidos.txt`. With `--verificar`, it reads the text files it is given.
- It writes `lib/lojaIntegrada/fixtures/__wire__/<nome>.json`, one per pair, and
  nothing else, and only when every pair is clean: **any finding refuses the whole
  run and writes nothing**.
- It never calls the network, never reads a token or an environment variable, and
  never starts a process. `lib/lojaIntegrada/estrutura.test.ts` walks its import
  closure to prove it. All the logic lives in `lib/lojaIntegrada/sanitizacao/`; the
  script only binds the file system to it.
- It never prints a value from a capture: only request lines after redaction, leaf
  paths with their JSON types and treatments, and findings as
  `<nome> <where> :: <kind>`.

## Commands

`pnpm --filter` runs the script from `apps/loja-integrada`, so pass absolute paths.

```bash
# What would be written: request lines, classes, leaf tables, findings. Writes nothing.
pnpm --filter @delfrance/loja-integrada-app sanitizar --entrada "$HOME/li-capturas" --dry-run

# Write the fixtures (all pairs, or only some with --so).
pnpm --filter @delfrance/loja-integrada-app sanitizar --entrada "$HOME/li-capturas"
pnpm --filter @delfrance/loja-integrada-app sanitizar --entrada "$HOME/li-capturas" --so c1-pedido-busca

# Before any push: the store names and personal-data patterns over fixtures, docs and the PR body.
pnpm --filter @delfrance/loja-integrada-app sanitizar --entrada "$HOME/li-capturas" --verificar /abs/path/fixture.json /abs/path/pr-body.md
```

- `--sobrescrever` replaces an existing fixture whose bytes differ; identical bytes are
  always a no-op.
- Exit codes: 0 done (or a clean dry run or check), 1 refused (nothing written),
  2 usage error, 70 unexpected error (only the error's class and code are printed).

## Who runs it

An agent may run it on the owner's captures once he says they are in place, and reads
**only its output and the sanitized fixtures**. An agent never opens a raw capture by
any other means: no `cat`, no editor, no file-reading tool. The owner sees the
sanitized fixtures (or their diff) before anything is pushed: this repository is
public, so a pushed branch is published.

## Capturing (the owner)

### The folder

- One folder, `~/li-capturas`, for every branch, worktree and session. It must sit
  **outside every repository checkout and worktree** (the sanitizer refuses a folder
  with a `.git` entry in it or above it) and outside any cloud-synced folder.
- `nomes-proibidos.txt` lives there too: one store name, domain or short name per
  line, `#` for comments, UTF-8. A term needs at least 4 letters or digits. The
  sanitizer refuses to run without it, refuses any fixture where a listed name
  survives, and never prints a term. It never enters the repository.
- The raw captures hold real personal data. They never leave this machine, are never
  pasted into a chat, and are deleted once their fixtures are merged.

### A capture is a pair

`<nome>` is lowercase letters, digits and `-`, at most 40 characters, and describes
the request (`c1-pedido-busca`), never a store or a person.

- `<nome>.json`: the response body exactly as received (even when it is HTML or empty).
- `<nome>.txt`: the sidecar, UTF-8, these lines only:

  ```text
  GET https://api.awsli.com.br/v1/pedido/search/?limit=50 200
  credencial: personal-token
  data: 2026-10-07
  ```

  - Line 1 is `METHOD URL STATUS`. The URL is `https://api.awsli.com.br/v1/…` or
    `/v1/…`, exactly as requested (a trailing slash matters).
  - `credencial:` is **mandatory** and names the credential the request really ran
    under: `personal-token`, `personal-token-invalido` (a deliberately invalid token),
    `chave-api-aplicacao` (legacy logs older than 2026-10-07) or `sessao-painel` (a
    request the store's admin panel authenticated in the browser).
  - `data:` is optional; without it the body file's modification date (UTC) is used.
  - **Never a header line.** Any other line refuses the pair, and so does a query key
    that names a credential (`chave`, `token`, `aplicacao`, `api_key`, …): then delete
    both files and capture again.

### With curl (Git Bash)

The helper reads the token without echoing it and hands the header to curl on stdin,
so the token is never in the command line, the shell history or a file. curl writes
the sidecar itself, and the helper prints its first line so a wrong request shows at
once.

```bash
li_capturar() {  # li_capturar <nome> '<path and query>'
  local nome="$1" caminho="$2" token
  read -rsp 'Personal Token: ' token; echo
  printf 'Authorization: Basic %s\n' "$token" \
    | curl -sS -H @- -o "$nome.json" \
        -w 'GET %{url_effective} %{http_code}\ncredencial: personal-token\n' \
        "https://api.awsli.com.br$caminho" > "$nome.txt"
  unset token
  head -n 1 "$nome.txt"
}
cd ~/li-capturas && li_capturar c1-pedido-busca '/v1/pedido/search/?limit=50'
```

Read-only requests only (`GET`). A capture made with an invalid token gets its
`credencial:` line edited to `personal-token-invalido`.

### From the browser or from logs

- **Browser devtools:** save the response body as `<nome>.json` and write
  `<nome>.txt` by hand. **Never "Save all as HAR" and never "Copy as cURL"**: both
  carry the `Authorization` header and cookies. A `*.har` file in the folder refuses
  the whole run.
- **Legacy logs:** copy the body into `<nome>.json`, write the request line, and set
  `credencial: chave-api-aplicacao` and `data:` to the log's date. A write echo (`PUT`)
  is accepted as metadata; nothing is ever sent.
