# `lib/shopee/etiqueta/` — the label flow (step 15, #1523)

The design notes for the step that makes this app ARRANGE a Shopee shipment
and hand back its label: one click on the pedido's **Imprimir** button becomes
`ship_order` (when the package is not arranged yet), the tracking number, the
shipping document, and the label's bytes. `apps/shopee/CLAUDE.md` keeps only
the rules a reader must not break and points here for the reasoning. The
reconciled design, the explorations and the wave reports that produced this
folder are in the step-15 review directory named by the PR that closes #1523.

**What the folder does.** It reads what Shopee holds for one order, decides the
ONE next action, runs it, folds the answer back in and decides again, until it
has the label's bytes, a question for the operator, a refusal, or no time left.
It holds nothing between calls: every call starts from Shopee's own answers.

**What it does NOT do.** It writes no Firestore document, emits no NF-e, picks
no agency, ships no batch of orders, and builds nothing of step 15b (#1744).
§12 lists the rest.

Step 15 ships in two stacked PRs: PR 1 is the server (this folder, the route,
the package's seven operations and the CLI), and PR 2 is the web. Neither is
merged, and nothing is deployed anywhere.

Everything here is **offline-verified**. The step-15 sandbox probe has NOT run
yet: it needs one fresh SG Console order. Every wire fact below comes from
Shopee's documentation and the legacy app, and every value the probe can move
is a named constant (§14).

## 1. The modules, in families

- **Vocabulary and bounds.** `constantesEtiqueta.ts` holds every tunable and
  every bound WE chose: the budget, the in-call poll cadences, the waits, the
  ONE order-read field list, the format → document-type table and the probe
  constants. A bound the WIRE states (the 50-entry batch cap, the document
  type and status spellings) is the package's, imported.
  `motivosEtiqueta.ts` holds the twenty-nine-member `MotivoEtiquetaShopee`
  vocabulary and its ONE total pt-BR text table, and imports nothing.
  `errosEtiqueta.ts` holds THE refusal classifier (§9), which answers in that
  vocabulary.
- **The pure decisions.** `faseEtiqueta.ts` turns what Shopee said into one
  package phase and the ONE next action (§5). `modoDeEnvio.ts` turns one
  `get_shipping_parameter` answer, plus the operator's choice, into a
  `ship_order` body, a question or a refusal (§6). `alvoEtiqueta.ts` is the
  pedido → conta ladder, the ONE copy the route and the CLI both run (§4).
  No clock, no I/O, and none of them loads the classifier.
- **The actions.** `programarPacote.ts` arranges ONE package: the fresh
  parameter read, the chooser, the ship (§6). It is Next-free and
  Firestore-free, because step 15b's automatic arrange will call it from the
  step-7 push arm. `executarEtiqueta.ts` is the runner: the loop, the reads,
  the document steps, the download and the budget (§8).
- **The answers.** `pendenteEtiqueta.ts` holds the 202 body type, the frozen
  pt-BR phase sentences, the NF-e outcome type and the filename; it is pure,
  so the runner that reads its sentences stays Next-free.
  `respostaEtiqueta.ts` is the ONE mapper from the runner's result to an HTTP
  response (§2), with the sentences only an HTTP answer carries. It imports
  `next/server`, and only the route imports it.
- **The CLI.** `etiquetaCli.ts` is the pure half of `baixar:etiqueta`, and
  `scripts/etiqueta.ts` its I/O half (§13). The pure half names the runner
  for its TYPES only and receives it injected, so loading it does not load
  the runner.
- **The discipline.** `disciplinaDaPasta.test.ts` pins the split as raw-text
  rules: `next/server` only in the mapper, no value import of it anywhere,
  `console` only in the runner, Firestore only in the CLI, and five pure
  modules that load neither the credential store, the listing module nor an
  impure sibling.

Outside the folder, and why each lives where it does:

- `app/api/marketplace/shopee/etiqueta/route.ts`: the route, and the
  composition root. It supplies the shop client, a moving clock and the ONE
  sleep; no module under `etiqueta/` reads a clock or builds a timer.
- `nfe/reenvioNfe.ts`: the NF-e re-drive, moved verbatim out of the
  `enviar-nfe` route so the label route runs the SAME ladder (§7).
- `core/recusaShopee.ts`: the code and sentence folds every Shopee refusal
  table compares through, promoted out of `nfe/classificarNfe.ts` so the two
  tables read a refusal identically (§9). Its code fold delegates to the
  package's `shopeeCodigoCanonico`, the ONE copy the batch reader uses too.
- `notificacoes/notificacao.ts`: push code 15 is `ack` and code 25 re-parked
  (§11).
- `proxy.ts`: exposes `Content-Disposition` to a cross-origin caller, so the
  filename the route chose reaches the browser (§10).
- `@delfrance/integrations-shopee`: the seven `v2.logistics.*` operations
  (`logistica.ts` holds their paths, request shapes and guards), the bytes
  transport `shopeeCallArquivo` and the byte sniff (`arquivo.ts`). The
  package README has the summary.

## 2. One stateless route, and re-clicking IS the resume

A label takes three things that each wait on Shopee: the arrange, the courier's
tracking number, and the document task. The tracking-number latency is not
documented (register 209), and one App Hosting request is capped at 180 s. A
job, a queue or a state document would each need an owner, a watermark and a
rule-7 analysis. Instead, every call RE-DERIVES the phase from Shopee:

1. `get_order_detail` with `response_optional_fields` = exactly
   `package_list,fulfillment_flag`. `order_status` is a base field and is
   never asked for, and no buyer, recipient or invoice field is asked for at
   all (`invoice_data` carries the NF-e key, which this flow never needs).
2. `get_package_detail` for every package of the order, 50 at a time.

Then it decides, acts once, folds the answer in, and decides again. Two tabs,
an aborted fetch and a second click all converge, because Shopee is the only
state there is. A duplicate `ship_order` is absorbed as `package_already_shipped`
(§6).

**The body** is strict, `{ pedidoId, formato, pacote?, envio? }`, judged in
this order before any read: the caller (`verifyCaller`, `PERM.frete.read`), a
JSON object, `pedidoId` a document id, `formato` ∈ `pdf`/`zpl2`, `pacote`
absent/`null` or a non-blank package number of at most `TAMANHO_MAX_PACOTE`
characters, `envio` absent/`null` or one of the two `EscolhaDeEnvio` shapes
with its EXACT key set, and no other key. Any other key is a 400, never an
ignored key. Then the ladder reads the clock ONCE, for the NF-e re-drive's
"now"; the runner gets a moving clock of its own, for the budget.

**The answers:**

| status | when                                                 | body                                                                                          |
| ------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 200    | the label                                            | the bytes, under the EXACT sniffed `Content-Type`, `attachment` with our filename, `no-store` |
| 202    | a wait or a question                                 | `EtiquetaPendente`, `no-store`                                                                |
| 400    | a body rung                                          | `{ error }`                                                                                   |
| 403    | an arrange is due and the caller lacks `frete.write` | `SHOPEE_ETIQUETA_SEM_PERMISSAO`, `motivo: 'programar-envio'`                                  |
| 404    | no pedido document                                   | `SHOPEE_ETIQUETA_PEDIDO_NAO_ENCONTRADO`                                                       |
| 409    | a refusal, `nfe-pendente` included                   | `SHOPEE_ETIQUETA_RECUSADA`, `motivo`, `mensagem`, `nfe?`, `tentarApos?`, `shopeeCode?`        |
| 502    | a file whose signature we do not know                | `SHOPEE_ETIQUETA_FORMATO_DESCONHECIDO`                                                        |

`verifyCaller` answers its own 401/403/500 first. Whatever the runner does not
classify is rethrown and mapped by `shopeeErrorResponse` UNCHANGED: 409
`SHOPEE_REAUTH_REQUIRED` for a dead grant, 503 on the network, 502 on a schema
drift. There is no label-specific error class and no second path to a 409.

A refusal the table does not know (`recusa-desconhecida`) carries Shopee's
canonical code as the optional `shopeeCode`, through `codigoSeguro` (a token of
at most 64 characters with fewer than seven digits, so an order or package
number can never ride it), and the route logs it ONCE as
`[shopee/etiqueta] recusa-desconhecida { op, code }` — the route's one log line
of its own. That code is the datum the table needs to learn the refusal;
Shopee's sentence is never logged or answered.

**The 202 body** has three shapes, told apart by `acao`:

- `aguardar` — a `fase` (`consultando`, `programando`, `aguardando-rastreio`,
  `gerando-documento`, `baixando`, `renovando-credencial`,
  `limite-de-requisicoes`), the `tentarEmMs` to wait before the next call, and
  the phase's frozen sentence. `consultando` ("Consultando a Shopee…") is the
  NEUTRAL phase of the order/package read that opens every call (review 2,
  F5): a read that drops or runs out of budget never reports `programando`,
  which after "a Shopee está gerando a etiqueta" would read as a second
  arrange;
- `escolher-envio` — ONE package's shipping-mode question (§6);
- `baixar-por-pacote` — the packages go by different couriers, so each is
  downloaded on its own call, with `pacote` (§10).

Every shape carries `progresso: { total, organizados, comRastreio, prontos }`,
counts only. It exists so the caller's give-up message is DETERMINISTIC:
`organizados === total && total > 0` means "already arranged, and it will not be
arranged again", and nothing has to parse a sentence to know it.

⚠️ **The 202 body is a MIRROR, not a shared schema** (reconcile R-aa).
`EtiquetaPendente` in `pendenteEtiqueta.ts` is the PRODUCER's shape. PR 2's web
schema MUST mirror its names, and the 409's, and tolerate every optional key
(`shopeeCode` included) — an obligation on that file, which this folder states
and never describes (#1369). The two are compared line by line by the
round-trip review, never by a comment. A rename is a wire change on both sides
of a deploy. So is a `motivo` slug: it rides the 409 for the caller to branch
on.

## 3. Permissions: a reprint is a read, an arrange is a write

The house split already exists: Mercado Livre's `etiqueta` and Melhor Envio's
`imprimir` are `frete.read`, Melhor Envio's `comprar` (an irreversible spend) is
`frete.write`. This route is both, so:

- the base bit is **`PERM.frete.read`**, and an operator with it alone still
  prints an ARRANGED package;
- the runner receives `podeProgramar = hasPerm(perms, PERM.frete.write)`, and an
  arrange that is due without it answers **403 BEFORE `get_shipping_parameter`**;
- the NF-e re-drive needs **`PERM.pedido.write`**, the `enviar-nfe` route's own
  bit (§7).

A flat `frete.write` would 403 a Shopee REPRINT for an operator who prints
Mercado Livre labels every day.

## 4. Ownership, the frete block and the conta — before any client

In this order, and each refusal costs zero Shopee calls and no token read:

- **The pedido**, raw. Absent ⇒ 404.
- **Ownership is `provaDeIdentidadeShopee`**: the document id must recompute
  from `(conta, order_sn)` — the legacy-exact digest. ⚠️ NEVER
  `avaliarPedidoParaNfeShopee`: its `bloquearEmissaoNFe` rung would refuse the
  label of every order that never gets an NF-e from this ERP, every SG order
  included. No proof ⇒ `nao-shopee`.
- **The frete block** is refused only when
  `freteInicial.externalOptionIntegracao` is PRESENT and not `shopee`
  (`frete-de-outra-integracao`). An absent or `null` owner passes: a migrated
  legacy pedido keeps whatever the legacy app wrote, and step 7 never rewrites
  that field.
- **The conta**, through the cached `readConta`, judged by the NF-e upload's
  own `avaliarContaParaNfeShopee` and mapped to this vocabulary by an
  exhaustive `switch`: missing or of another tipo ⇒ `conta-nao-configurada`,
  `ativo !== true` ⇒ `conta-inativa`. A third refusal on the NF-e side stops
  this route compiling.

The ladder after the missing-document rung is ONE pure module,
`alvoEtiqueta.ts` (`avaliarPedidoParaEtiquetaShopee`,
`avaliarContaParaEtiquetaShopee`), and the route and the CLI both call it: the
CLI rehearses exactly the ladder production runs. Each caller keeps only its
own answer to a missing document (the route's 404, the CLI's
`pedido-nao-encontrado`).

## 5. The phase decision (`faseEtiqueta.ts`)

**One package's phase** (`fasePacote`), in this order:

1. The invoice first among the PRE-ARRANGE phases (`LOGISTICS_NOT_START`,
   `LOGISTICS_READY` not arranged, an unknown token). An invoice-pending package
   reads `LOGISTICS_NOT_START`, so a table consulted before the invoice would
   answer "not ready" and the operator would never learn that the NF-e is what
   blocks (§7). An arranged, collected or ineligible package IGNORES a stale
   `invoice_pending`: it must never hold the rest of the order.
2. The `LOGISTICS_*` token, read with step 7's rule: an EXACT lookup, both alias
   spellings as their own keys, no trim, no case fold. The table is typed on
   step 7's own token table, so a token step 7 learns is a COMPILE error here
   until this table decides its phase. Anything else — `LOGISTICS_PENDING_ARRANGE`
   (a return token) included — is `desconhecido`, and nothing acts on it.
3. On `LOGISTICS_READY` only: `is_shipment_arranged === true` ⇒ arranged;
   a USABLE `pending_terms` entry (step 7's reader: `-` and blank hold
   nothing) ⇒ `retido` (Shopee holds it); else ⇒ arrange.
   `null` counts as NOT arranged, which is safe because a duplicate ship is
   absorbed (§6). `LOGISTICS_PICKUP_RETRY` is arranged and never re-arranged:
   the retry is Shopee's.

**The next action** (`decidirProximaAcao`), first match wins:

1. The order: FBS ⇒ `pedido-fbs`; `CANCELLED` ⇒ `pedido-cancelado`; no package
   ⇒ `sem-pacotes`; a `pacote` the order does not list ⇒ `pacote-inexistente`.
2. The working set: `pacote` alone, or every package — minus the ones past the
   print window and the ones Shopee cancelled or refused. Empty ⇒
   `janela-fechada` when any package was past the window, else
   `pacote-inelegivel`.
3. Any unknown phase, or a listed package Shopee gave no row for ⇒
   `status-desconhecido`.
4. Any invoice-pending package ⇒ `nfe-pendente` (the invoice is the ORDER's).
5. Any not-ready package ⇒ `pacote-nao-pronto`; any held one ⇒
   `retido-pela-shopee`.
6. The first package to arrange: on `IN_CANCEL` ⇒ `pedido-em-cancelamento`
   (an already-arranged package still prints); else arrange it.
7. Arranged with no usable tracking number ⇒ fetch it (§8).
8. No document type yet ⇒ read the document parameters.
9. Document state unknown ⇒ read the result.
10. A document that FAILED again after this call re-created it ⇒
    `documento-falhou`, checked BEFORE creating a sibling's, which would spend
    a call on an answer already known; else absent or failed once ⇒ create.
11. Any still processing ⇒ wait.
12. All ready: ONE download group sharing ONE document type ⇒ download; else ⇒
    `baixar-por-pacote`.

## 6. The shipping mode, and the one irreversible call

**The mode is the KEY Shopee put in `info_needed`**, never a channel id
(announcement 1327). `pickup`, `dropoff` or `non_integrated` PRESENT means the
mode is offered, and ⚠️ ABSENT (`null`) is not EMPTY (`[]`): `[]` is "offered,
nothing to fill". The package schema keeps them apart and the chooser never
folds them.

- **Pickup.** Only an address whose `address_flag` holds `pickup_address` is
  eligible; ⚠️ `default_address` alone is NOT one. A slot is offered only when
  `info_needed.pickup` asks for `pickup_time_id`, and zero slots is legal (no
  `pickup_time_id` is sent). A pickup that asks for anything else is a body we
  cannot build ⇒ `modo-nao-suportado`.
- **Dropoff.** Nothing to fill ⇒ `"dropoff": {}` is SENT (never `null`, never
  absent). `branch_id` with ONE branch ⇒ that branch; more than one ⇒
  `agencia-precisa-escolha` (there is no agency picker: the operator arranges
  it in the Seller Centre, and the next click finds it arranged and prints).
  The count is the RAW list, unreadable rows included. Any other item ⇒
  `modo-nao-suportado`.
- **`non_integrated` only** ⇒ `sem-etiqueta-shopee`: the seller's own
  logistics, for which Shopee prints no label.
- **Shopee's own refusals here.** `no_available_time_slot` /
  `no_supported_dropoff_branch` ⇒ `sem-horario-ou-agencia` (nothing to offer
  right now; its sentence never blames the address), and the pickup-address
  family (`error_no_pickup_address`, "pickup address is not serviceable", …)
  ⇒ `sem-endereco-de-coleta`. A slot past its cutoff at the ship ⇒
  `reescolher-envio`, which asks again.

**It offers only what the server can ship** (review 2, F2). Each side is judged
ALONE first: a pickup that asks for an item we cannot fill, or has no eligible
address, is not offered (`enderecos: []`); the dropoff is offered
(`permiteDropoff: true`) only when it would yield a body, so an
`agencia-precisa-escolha` or `modo-nao-suportado` dropoff is never an option.
Before this, the question offered a side the answer then refused with a 409,
and the next click asked the same question again.

**Then it asks only when a choice is left**: both sides buildable ⇒ ask; exactly
ONE ⇒ decide it (the pickup still asks when it has more than one eligible
address, or more than one slot); NONE ⇒ refuse with the motivo of the side
Shopee offered — the dropoff's when it offered both. So every question carries
at least one option the server can ship, and one with no address always offers
the dropoff. The `recommended` flag only labels a slot in the question; it never
decides one. The question's labels are built from the SELLER's own address row
and the slot's date (in `America/Sao_Paulo`, explicitly); no buyer datum is on
that page.

⚠️ **An answer is matched EXACTLY against THIS call's fresh read**:
`String(address_id) === enderecoId`, never `Number(enderecoId)` (which would
accept `'0123'` or `'1.23e2'`), and `horarioId` verbatim. An answer that no
longer matches is RE-ASKED with `escolhaInvalida: true`, never shipped and
never replaced by the one option left — and "matches" is against what this read
OFFERS, so an answer naming a side it cannot build is re-asked too. An answer
names its package, and one given for a sibling package is no answer for this
one.

⚠️ **`ship_order` is irreversible and NOT idempotent.** It goes out at most once
per package per call, plus exactly ONE documented re-send: Shopee refused the
`package_number` it was given (`ship_order_not_need_pacakge_number`), which
means nothing was arranged, so the same body goes once more without it.

- **`package_number` rides the ship only on a SPLIT order**
  (`SHOPEE_SHIP_ORDER_PACOTE = 'so-se-dividido'`, probe P3a). Shopee refuses
  it in both directions, and both refusals are handled. On the ship, an absent
  number is OMITTED, never `""`; every OTHER operation always names the
  package.
- **An unknown outcome is not a failure.** A network drop, an HTTP error with
  no envelope, Shopee's locks and its own transient codes after the ship do not
  mean "not arranged". The runner answers 202 `programando`, and the NEXT call
  re-reads `is_shipment_arranged`. Nothing re-sends the ship in-call.
- **Already arranged is success.** `package_already_shipped` (the ship page
  prints it with a LEADING SPACE) and `error_param` + "Order has been shipped."
  both mean ARRANGED; which one a repeated ship answers is register 207.
- **After a successful ship the package stays arranged for the rest of the
  call**, whatever a re-read says: `is_shipment_arranged` may not be observable
  yet (register 208). The runner pauses `ESPERA_POS_PROGRAMAR_MS` and re-reads
  the package for its tracking number.
- A slot or address Shopee refuses AFTER offering it is asked again, marked
  stale; if this read leaves nothing to ask, the call waits for the next read.

## 7. The invoice gate, and the NF-e re-drive

A Brazilian order ships only with its NF-e attached (step 14). The gate is the
PACKAGE's `invoice_pending.status`, trimmed and lower-cased, `=== 'pending'`
(FAQ 727), checked first (§5). The backstop is the classifier: the three texts
of `logistics.lack_of_invoice_data`, the bare `lack_of_invoice_data` and
announcement 1521's `error_pending_invoice` — five spellings, two canonical
codes — answer `nfe-pendente` from any operation (register 193 records which
one BR really sends).

- ⚠️ NEVER `freteInicial.estado === 'error'`. Step 14's stamp outlives a
  validated NF-e, so a gate on it would deadlock the very pedido whose note was
  re-sent.
- NEVER the `INVOICE_PENDING` order list: register 202 is answered NOT NEEDED.
- The SG sandbox never carries `invoice_pending`, so it passes the gate
  naturally; there is no sandbox override.

**On `nfe-pendente` the route re-drives the NF-e** through
`reenviarNfeDoPedidoShopee` — the SAME ladder the `enviar-nfe` route runs, moved
out of it verbatim (the route's unedited test is the proof). It re-runs the
pre-network gates and ENQUEUES one task: zero writes, zero Shopee calls, no
client. It runs only when the caller has `PERM.pedido.write`; without it
nothing is enqueued and the answer says `sem-permissao`. The 409 carries
`nfe: { desfecho, motivoNfe?, atrasoSegundos? }` with `desfecho` ∈
`enfileirado`, `nao-elegivel`, `nfe-nao-encontrada`, `desligado`,
`sem-permissao` — never the key, the XML or the NF-e document id.

The sentence is chosen from the outcome AND `motivoNfe`. The common case — the
operator clicked Imprimir before emitting the NF-e — arrives as `nao-elegivel`
with `sem-nfe-aprovada`, and its sentence asks for the emission ("emita a NF-e
do pedido e clique em Imprimir de novo"): nothing was ever uploaded, so there
is no aviso to point at. Every other `nao-elegivel` motivo keeps the "confira o
aviso de NF-e" sentence. `nfe-nao-encontrada` is unreachable from this route
(it re-drives with `nfeId: null`, and that arm answers only an explicit
`nfeId`), and keeps the same "emita" sentence for the union's exhaustiveness.

⚠️ The answer is a 409, TERMINAL for the click. A 202 would make the caller
poll, and every poll would enqueue the re-drive again. The operator clicks again
once Shopee has the note. The CLI never re-drives: it prints "use `enviar:nfe`".

## 8. The tracking number, the document, and the budget

**The tracking number.** While `IMPRIMIR_SEM_RASTREIO` is `false`, no document is
created without one. `get_package_detail.tracking_number` is trusted when the
row has one (`RASTREIO_DO_PACOTE_VALE`); otherwise `get_tracking_number` is read
per package, every `INTERVALO_RASTREIO_MS` inside the budget. `"-"` and `""` are
NO tracking number: every value goes through step 7's `textoShopeeUtilizavel`,
and the package guards refuse a blank or `-` one before a token is read.

**The document type** is decided on the server (reconcile R-u):
`TIPO_DOCUMENTO_DO_FORMATO[formato]` (`NORMAL_AIR_WAYBILL` for `pdf`,
`THERMAL_AIR_WAYBILL` for `zpl2`) when Shopee lists it as selectable for the
package; else Shopee's `suggest`; else the type is OMITTED (Shopee's default).
⚠️ "Omitted" is stored as a decision of its own, because a `null` type means
"not read yet" and would be re-read until the budget ran out. A refused type
falls back ONCE per package — to `suggest`, else to none — and then refuses
with `tipo-invalido`.

**The document task.** Create (with the tracking number whenever the package has
one) → poll the result every `INTERVALO_DOCUMENTO_MS` → download. A `FAILED`
task is re-created once per call, and a second failure refuses with
`documento-falhou`. `shipping_document_should_print_first` means nothing was
created yet. A result status nobody documented reads as NOT ready.

**Batch rows are matched by `(order_sn, package_number)`, never by position.**
Fewer rows than were asked for is a valid answer, and an absent or `null`
`result_list` reads as no rows (this API prints `null` for an empty list),
never as a 502. A row with no package number
belongs to the only package of an unsplit order; on a split order a FAILED one
is the whole batch's failure, and the package is never guessed. A batch where
every row failed arrives as a value (`todasFalharam`), each row with its own
verdict, and is read by the same table as a thrown failure (§9).

**The budget.** `ORCAMENTO_ETIQUETA_MS` (30 s) from the call's first clock read:
no Shopee action is STARTED after it. Each action is one HTTP call with no fetch
timeout, so a call ends at about the budget plus one action — the download
included — well inside App Hosting's 180 s, and `apphosting.yaml` needs no
change. The call's FIRST read is exempt: a call that read nothing could answer
nothing. A wait that fits is slept in-call; one that would reach the deadline
is not slept, and the 202 carries it as `tentarEmMs` for the caller to sleep. A
budget stop answers `tentarEmMs: 0`.

| wait                                                  | `fase`                  | `tentarEmMs`                                   |
| ----------------------------------------------------- | ----------------------- | ---------------------------------------------- |
| a burst rate limit                                    | `limite-de-requisicoes` | `max(Retry-After, TENTAR_EM_LIMITE_MS)` (10 s) |
| another instance holds the token-refresh lease        | `renovando-credencial`  | `TENTAR_EM_CREDENCIAL_MS` (2 s)                |
| Shopee's own "not now" (allocating, a lock, a hiccup) | the operation's         | `TENTAR_EM_SHOPEE_MS` (10 s)                   |
| … on the order/package READ, or its budget stop       | `consultando`           | `TENTAR_EM_SHOPEE_MS`, or `0` at the budget    |
| an unknown `ship_order` outcome                       | `programando`           | `ESPERA_POS_PROGRAMAR_MS`                      |
| an empty download, once per call                      | `baixando`              | `INTERVALO_DOCUMENTO_MS`                       |

The DAILY quota is not a wait: it is the 409 `limite-diario`, with `tentarApos`
at the quota's next reset. When Shopee says the call ran ahead of it (the
package list changed, a document step out of order), the runner re-reads the
order and every package ONCE per call, arranged packages staying arranged; the
second time is the operator's click.

## 9. The classifier (`errosEtiqueta.ts`)

ONE table for every label operation: design D1's rows E0–E26, first match wins,
answering a runner verdict. `null` means "not ours": the caller rethrows and
`core/respond.ts` answers as it does for every route (a dead grant, our own
misconfiguration, an unreadable body).

- ⚠️ **Needles read `providerMessage`, NEVER the Error's `.message`.** That is
  OUR sentence, and on `/api/v2/logistics/ship_order` it says `ship_order`
  before Shopee has said a word. Codes and sentences go through the two folds
  of `core/recusaShopee.ts`, the ones step 14's table reads, so
  ` logistics.package_already_shipped` ≡ `package_already_shipped` while a
  two-segment prefix stays distinct. The code fold is the package's
  `shopeeCodigoCanonico`, delegated to — the same one the package's batch
  reader folds `common.batch_api_all_failed` with, so the two cannot drift.
- ⚠️ **`logistics.error_param` is SIX rows, split by the sentence**: already
  shipped, still allocating (a wait), the order was split, not ready, the slot
  is stale, and a seller-registration error. A code-only row would read an
  allocation wait as an arranged package; each pair is pinned by a same-code
  near-miss test.
- ⚠️ **The daily-quota kind is trusted only with its sentence.** The
  `ship_order` page lists `logistics.error_limit` three times with other
  meanings (a batch over 50, a status that cannot change, a parcel count), and
  "try again after midnight" would be false for those.
- On `programar` an unknown outcome is `verificar`; on every OTHER operation the
  same failures are a plain wait, because a read or a document call is safe to
  repeat.
- A failed batch ROW is turned into exactly the error the transport would build
  for an envelope with that code and sentence, and classified by the same
  function (`classificarFalhaDeLinha`). A second row table would drift from the
  first by construction.
- Every lookup is a `Set`: the codes arrive verbatim from a provider, and an
  object literal would answer `constructor`.

## 10. Multi-package, the download, and the file

**One click arranges every package**, one ship per decision, each followed by a
re-read. A question names its package, and on a split order it carries
`pacoteRotulo: "Pacote i de n"`. Tracking, document parameters, create and
result are batch calls of at most 50 packages.

**The download is ONE file** only when every working-set package shares one
`logistics_channel_id` ("same courier") AND one document type, because the
download takes ONE type. A package with no channel id is a group of its own —
nothing proves it shares a courier. Otherwise the answer is `baixar-por-pacote`,
and the caller re-calls once per listed package with `pacote`.
`packages_can_not_download_together` is the backstop into the same answer, and
more than 50 packages can never be one file either. There is no ZIP of files.

**The bytes are judged by their signature, never by a header.** The package's
`shopeeCallArquivo` reads `arrayBuffer()` and lets the FIRST significant byte
decide file vs envelope: an empty 2xx and a success envelope are both failures,
and no body byte ever reaches a log. The runner then asks
`classificarArquivoDeEnvio`: `%PDF-` ⇒ `application/pdf`, a ZIP local file
header ⇒ `application/zip`, `^XA` ⇒ bare `text/plain`, each content type an
EXACT essence with no parameter. Anything else ⇒ the 502, ⚠️ NEVER
`application/octet-stream`: the print agent answers 200 for a type it cannot
print and prints nothing. An empty download is waited out once per call; the
second one is the 502 of `respond.ts`'s schema arm. The only log line in the
folder counts the bytes of an unknown file and names Shopee's header and status.

**The filename** is `etiqueta-shopee-<numero>[-p<i>de<n>].<pdf|zip|txt>`.
`numero` is the pedido's display number — on this channel, Shopee's order
number — under Mercado Livre's `[\w.-]+` guard (a failing one falls back to the
bare name). The `-p<i>de<n>` suffix is the package's POSITION on a per-package
download of a split order, ⚠️ never its number. Shopee's own
`Content-Disposition` is never forwarded.

## 11. Zero writes, and what step 7 observes

The manual flow writes NO Firestore document (reconcile R-o):

- no `printLabelId`: with `FREIGHT_TIPO_CAPS.canPrint` it would route
  **Imprimir** to Melhor Envio;
- no `codRastreio`: step 7 owns it;
- no in-process step-7 merge. Right after `ship_order` the package still reads
  `LOGISTICS_READY`, which step 7 maps to `despachoAutorizado`, so that write
  would change nothing anyway.

So there is no transaction, no inventory entry and no rule-7 race to answer:
the only writer the flow could race is itself, and it writes nothing.

**What step 7 observes.** The arrange reaches the pedido through step 7's
package pushes (codes 4/30/47 → one `get_package_detail`):
`LOGISTICS_REQUEST_CREATED` is `aguardandoPostagem`, which is in
`ESTADOS_FRETE_REMOVE_ESTOQUE`. So stock moves, and step 14's stamp clears,
as soon as step 7 observes OUR `ship_order` — before any physical pickup.
Without the push callback registered (a migration-window item), that
observation lags until step 5's order import — the backstop that folds
`package_list` — reaches the package.

**Pushes 15 and 25.** Code 15 (`shipping_document_status_push`) is `ack`: the
flow polls `get_shipping_document_result` in-request, so the push has no
consumer, and a parked row is TERMINAL — parking would leave one dead-letter row
per document we create. Code 25 is 24's booking twin (Advance Fulfillment,
never BR): its `data` names only a `booking_sn`, no order and no package, so it
is re-parked with NO owning step. Rows already parked stay parked.

## 12. What it does NOT do, on purpose

- **Step 15b (#1744)**: the Turbo automatic arrange (announcement 1573), hooked
  into step 7's push arm after `resolverAvisoNfeSeEncerrado`; the per-conta
  `search_package_list` backstop sweep; and `update_tracking_status` operator
  buttons for the seller-fulfilled channels (90021 stays non-operable end to
  end without the Seller-Logistics SPI app). ⚠️ The coupling 15b must design
  first: a Shopee error escaping that hook reaches the push arm's ONE narrow
  catch, `disposicaoDaFalhaDeRastreio`, which can park or defer a delivery
  whose frete write has already committed — so the hook classifies its own
  failures. `programarPacoteShopee` and `escolherModoDeEnvio` carry no
  automatic mode yet; 15b adds the parameter.
- **`printLabelId` and `codRastreio`** (§11).
- **An agency (branch) picker.** The Seller Centre is the picker (§6).
- **`batch_ship_order`, `mass_ship_order`, `search_package_list`.** One order
  per click; the route knows its `order_sn`, and `search_package_list` has no
  order filter.
- **A `non_integrated` arrange.** Shopee prints no label for it.
- **Any window operation.** No index, rule, TTL, backfill or trigger; the route
  runs no query.

## 13. The CLI

`baixar:etiqueta` drives the SAME runner from a terminal against ONE named
pedido. The dry run is the DEFAULT: every read runs, and the runner answers
`simulado` at the first `ship_order`, `create_shipping_document` or
`download_shipping_document`, none of which is sent. `--live` arranges for real
with a 5-minute budget for the whole run and never writes the file; it prints
the sniffed format and the byte length. It prints no order number, package
number, tracking number, address or byte — every line is an allow-list — and
no argument the operator typed: a stray token or an unknown option is named by
its POSITION ("argumento solto na posição N"), never echoed. Beside a
`recusa-desconhecida` it prints `code=<shopeeCode>`, through the same
`codigoSeguro` gate. A live run re-calls the runner only for the two things
the operator cannot do by hand (an answered question, the per-package walk),
and waits `ESPERA_POS_PROGRAMAR_MS` before EVERY re-call: the previous call may
have ended right after its own `ship_order`, and a read made at once may not
show the arrange yet (register 208). It is never run by an agent. Flags, output
and the runbook: `scripts/README.md` §16.

## 14. What is UNVERIFIED, and what settles it

The settle-live register for step 15 is **rows 204–221** in the master plan,
all ⏳. The probe (one fresh SG Console order) has not run. Each value it can
move is ONE line in one module, never a second copy:

| constant                          | where                   | today              | settled by                                                | register                         |
| --------------------------------- | ----------------------- | ------------------ | --------------------------------------------------------- | -------------------------------- |
| `ESPERA_POS_PROGRAMAR_MS`         | `constantesEtiqueta.ts` | `2_000`            | P2                                                        | 208                              |
| `RASTREIO_DO_PACOTE_VALE`         | `constantesEtiqueta.ts` | `true`             | P2 against P4                                             | none of its own (P2, beside 208) |
| `INTERVALO_RASTREIO_MS`           | `constantesEtiqueta.ts` | `5_000`            | P4                                                        | 209                              |
| `INTERVALO_DOCUMENTO_MS`          | `constantesEtiqueta.ts` | `3_000`            | P6                                                        | 210                              |
| `SHOPEE_SHIP_ORDER_PACOTE`        | `constantesEtiqueta.ts` | `'so-se-dividido'` | P3a                                                       | 206                              |
| `SHOPEE_SHIP_ORDER_DROPOFF_VAZIO` | package `logistica.ts`  | `'objeto-vazio'`   | P3 if SG offers dropoff, else the first BR Correios order | 205                              |
| `SHOPEE_ARQUIVO_ACCEPT`           | package `arquivo.ts`    | `'*/*'`            | P7                                                        | 204                              |
| `IMPRIMIR_SEM_RASTREIO`           | `constantesEtiqueta.ts` | `false`            | BR `get_channel_list.preprint`                            | 219                              |

The rows with no constant, each already handled both ways:

- **193** — which invoice spelling BR sends (all five are classified; the first
  BR refusal records it).
- **207** — which answer a repeated ship gives (P3b; both mean arranged).
- **211** — the `warning` array seen live on the batch pages (P5/P6; the
  package's `avisoEmLista` tolerance engages only after a strict failure).
- **217** — the delivered code-15 payload's spelling (P9; informational, since
  15 is `ack`).
- **218, 220, 221** — the seller-fulfilled channels' labels, `ship_order` on an
  `IN_CANCEL` order (why the flow refuses it today) and `pending_terms` on a BR
  package: a Brazilian shop only.
- **212, 213, 216** — what the THERMAL file contains, the PDF's page size and
  the print agent's exact MIME handling: the file and printer side, settled on
  a BR shop and the warehouse PC.
- **214, 215** — step 15b's.

P8 (a download after the Console "Pickup") gives the closed-window error its
text, which becomes a classifier needle. The SG sandbox's channels, addresses
and document types are not Brazil's, so a sandbox run proves the wiring, never
BR's wire.

## 15. Deploy order

**`apps/shopee` BEFORE `apps/web`.** The web (PR 2) is this route's caller, and
a web deploy first would call a route that does not exist yet. The App Hosting deploy
also carries the `proxy.ts` header without which a cross-origin caller cannot
read the filename. The nested functions codebase carries only the push-table
change (15 `ack`, 25's reason); until it deploys, code 15 keeps parking one
harmless row per document.

Nothing here is a migration-window operation. Two EXISTING window items gain a
consumer: the push callback URL (without it the frete, the stock and step 14's
stamp lag after an arrange, §11), and the static egress with Shopee's IP
allow-list (without it every label call from App Hosting is refused, as
`ip-nao-declarado`).
