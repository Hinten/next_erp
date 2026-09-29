# `lib/shopee/nfe/` — the NF-e upload (step 14, #1522)

The design notes for the step that makes this app send an ERP NF-e to
Shopee: the authorized `nfeProc` XML of a Shopee pedido's SALE, uploaded with
`upload_invoice_doc` after SEFAZ approves it and before step 15 asks Shopee to
ship. For a Brazilian order that is not on a carrier exempt from invoices,
Shopee refuses `ship_order` until an NF-e is attached, so step 15 depends on
this one. `apps/shopee/CLAUDE.md` keeps only the rules a reader must not break
and points here for the reasoning. The reconciled design, the explorations and
the wave reports that produced this folder are in the step-14 review directory
named by the PR that closes #1522.

**What the folder does.** It decides whether one NF-e document belongs on one
Shopee order, reads what Shopee already holds for that order, uploads our note
only when Shopee holds none, reads the order back, and checks again about 15
minutes later. When the channel PROVABLY refuses the note, it tells the
operator (the aviso `nfeUploadRejeitado`) and stops the parcel from looking
dispatchable (the frete stamp `freteInicial.estado = error`).

**What it does NOT do.** It never emits, signs or cancels an NF-e (`apps/nfe`
does). It never calls `ship_order` (that is step 15), and it has no sweep and no
schedule. It never overwrites a note Shopee already holds for the order, never
uploads a note that is not the sale's, and never touches Mercado Livre's
uploader (#1705). §15 lists the rest.

Step 14 ships in two stacked PRs. The first is this folder, the package op,
the shared predicate, the step-5/7 hook and the CLI: the whole path runs IN
PROCESS, and nothing enqueues in production because nothing enqueues onto a
queue that does not exist yet. The second adds the cloud path: the approval
trigger `onNfeAprovadaShopee`, the fifth queue `processShopeeNfeUpload`, the
re-drive route `POST /api/marketplace/shopee/enviar-nfe` and the emulator round
trip. Anything below marked **(PR 2)** is not in the tree until then.

Everything here is **offline-verified**. No module has uploaded to a Brazilian
shop, and none can in the sandbox: that shop is SG, which Shopee answers with
`invoice_data: null`, and staging emits homologação (`tpAmb 2`) notes, which the
shared predicate never sends. No probe result is recorded in this tree yet.
Until one is, every wire fact below comes from Shopee's documentation and the
legacy app, and §16 names what settles each one.

## 1. The modules, in families

The families are the seam, not a filing convention.

- **Vocabulary and bounds.** `constantesNfe.ts` holds the queue name, the
  attempt ceiling, the three delay ladders (§12), the pause ceiling, the ONE
  `get_order_detail` field list, the excerpt cap and `atrasoSerproS`. It holds
  no environment reader and no clock, and no byte ceiling: that bound is the
  PACKAGE's `SHOPEE_UPLOAD_INVOICE_DOC_MAX_BYTES`, measured on the same bytes
  the package sends. `errosNfe.ts` holds the outcomes, the fifty-six-member
  `MotivoNfeShopee` union with its TOTAL pt-BR fragment table, the three sets
  that are the only source of every effect (§8), and the queue's own
  `ShopeeNfeUploadTasksDisabledError`. `tarefaNfe.ts` holds the `.strict()`
  Cloud Tasks payload, the enqueue seam, the in-memory context the two
  phases share, and ONE declaration of the execution's deps and result
  (`DepsNfeShopee`, `ResultadoNfeShopee`): the recheck may not import the
  handler, and a structural copy kept in step by a comment is the drift the
  root `CLAUDE.md` warns about. `redacaoNfe.ts` holds the ONE sanitizer for
  Shopee's free text (§9).
- **The wire readers and the classifier.** `notaNaShopee.ts` reads our key out
  of our XML (§5), decides whether our note is a sale (§4), turns one order row
  into one of four verdicts, and gates the order (§6). It is the only source
  file in the folder that names Shopee's key field. `classificarNfe.ts` holds
  THE refusal table (§7). Both are pure.
- **The decisions.** `pedidoNfe.ts` proves the pedido is Shopee's, gates the
  conta, picks which of a pedido's NF-e documents goes to the channel (the slot
  rule), and cross-checks the document's stored key against the one in its
  proc. It is pure over snapshots already in memory, so the trigger decides at
  zero extra reads.
- **The effects.** `carimboFreteNfe.ts` holds the stamp, the folder's ONE
  transaction (class C, §11). `avisoNfe.ts` produces `nfeUploadRejeitado`,
  holds its resolvers and holds the cross-step hook (§10). It imports nothing
  from `pedidos/`: `pedidos/` imports it.
- **The transport.** `shopeeNfeUploadTasks.ts` is the scheduler for the fifth
  queue, a clone of step 13's. The valve is decided at construction and the
  region at the first enqueue. The payload is validated against the strict
  schema before anything else, and the options object is omitted when no
  positive delay was asked.
- **The handler.** `processarNfe.ts` runs the common prefix P1–P8, the upload
  ladder, the pauses and the SERPRO waits, the final-attempt split and the ONE
  completion log line. It also holds `lerPedidoNaShopee`, the folder's one
  order read, and `simularEnvioNfeShopee`, the writer-free dry run, and
  re-exports the two shared types for its importers.
  `reverificacaoNfe.ts` is the recheck: it judges the row the prefix already
  read, makes no Shopee call of its own and never uploads. It also holds the
  cancelled-sibling rule, `ehChaveDeIrmaoCancelado` (§6), because both phases
  ask it and the handler may import the recheck but not the other way round.
- **The CLI (wave 4).** `enviarNfeCli.ts` is the pure half of `enviar:nfe`
  (argument parsing and the two renderers), and `scripts/enviar-nfe.ts` is its
  I/O half (§13). The runbook is `scripts/README.md`.

Outside the folder, and why each lives where it does:

- `@delfrance/integrations-shopee`: `uploadInvoiceDoc({ orderSn, xml })` on the
  SHOP client only. It sends a multipart part named `file`, the filename
  `procNFe.xml` (a constant, never the key), `application/octet-stream`, the
  text `file_type` `'4'`, and an envelope-only response. It checks the UTF-8
  bytes against 1 MiB before any token read, and its error messages name
  LENGTHS only. It also carries `ShopeeApiError.providerMessage`: the
  envelope's own sentence, verbatim, which the partial rebuild in `call.ts`
  copies. The classifier needs it (§7).
- `packages/schemas/src/nfeEnvioCanal.ts`: `extractTpAmb`,
  `decideNfeUploadDispatch` (LEVEL, moved byte-identical out of Mercado
  Livre's `nfeUpload.ts`, which re-exports it) and `decideNfeUploadTransition`
  (§3).
- `pedidos/orderMapping.ts`'s `pedidoForaDoBrasil(region)`: the importer's
  `bloquearEmissaoNFe` predicate, extracted so the order read decides "foreign"
  by the same definition (§6).
- `pedidos/importarPedido.ts` and `pedidos/rastrearPedido.ts`: the two call
  sites of the cross-step hook (§10).
- **(PR 2)** `functions/src/onNfeAprovadaShopee.ts` (the trigger),
  `functions/src/processNfeUpload.ts` (the `onTaskDispatched`, export name
  `processShopeeNfeUpload`, equal to `SHOPEE_NFE_UPLOAD_QUEUE`) and
  `app/api/marketplace/shopee/enviar-nfe/route.ts`.

## 2. The flow, end to end

```
nfev4 write ──► (PR 2) onNfeAprovadaShopee
                 T1  decideNfeUploadTransition     0 reads; skip = silent
                 T1b finalidadeDoProc              0 reads; non-sale = log
                 T2  ONE raw pedido read
                 T3  avaliarPedidoParaNfeShopee    proof of ownership
                 T4  enqueue {pedidoId, nfeId}     scheduleDelaySeconds 360
                 T5  valve closed ⇒ aviso tasks-desabilitadas

(PR 2) processShopeeNfeUpload ──► processarNfeShopee(deps, payload, retryCount)
   P1 NF-e read (raw)      P2 LEVEL predicate       P3 pedido read + proof
   P4 sale gate            P5 key + byte ceiling    P6 conta gate
   P7 SHOP client          P8 ONE get_order_detail + portaoDoPedido
   ├─ fase envio:  pre-read verdict ─► upload ─► read-back ─► enqueue recheck
   └─ fase reverificacao: reverificarNfeShopee (judges P8's row, never uploads)
```

The pedido and its ownership proof are read BEFORE the XML is judged
(reconcile R-n). The aviso for a broken XML needs the conta and the display
number, and this order lets a broken XML reach an aviso AND a stamp with zero
Shopee calls. The tasks round trip of PR 2 relies on exactly that.

**The upload phase, after P8.** The pre-read decides whether to upload at all:

- Shopee holds OUR key ⇒ `ja-enviado`. When the note reads valid, it also
  resolves any open aviso. It reads `sefaz-pendente` when Shopee gives a
  pending reason, and otherwise queues one recheck.
- Shopee holds ANOTHER key ⇒ never overwritten. `outra-nfe-anexada`, or
  `chave-ilegivel` when the value is not a key at all, raises the aviso,
  unless the key belongs to a CANCELLED sibling NF-e of the same pedido. That
  is the re-emission after a cancel, and it uploads as a substitution (§6).
- No key ⇒ upload. A 200 is followed by ONE read-back. The read-back's own
  failure is logged and swallowed, because the upload landed. A read-back that
  still shows no key, or still shows the key of a CANCELLED sibling (the note
  a substitution just replaced), is read-your-write lag:
  `nao-refletida-ainda`, a log line (§6). Then the recheck is ALWAYS enqueued,
  whatever the read-back said, with a fresh pause budget (§12).
- A refusal is narrowed by CLASS: the rate limit first (it extends the API
  class), then the lapsed grant, then the refusal table (§7). An answer we
  cannot read (schema, HTTP, network) lets a read-back decide, and its absence
  of our key is never a stamp. There too, a cancelled sibling's key counts as
  no key of ours.

**The recheck phase** reads the row the prefix already fetched: valid ⇒
resolve; pending with a reason ⇒ `sefaz-pendente` (aviso + stamp); pending
without one, or a cancelled sibling's key still showing ⇒ one more look on the
ladder, then a log line; no key ⇒ `nao-anexada` (aviso, no stamp); any other
key ⇒ the aviso. It never uploads, and every re-enqueue it makes is pinned to
its own phase.

**The attempts.** A transient Shopee failure RETHROWS to the queue's ladder,
except on the last attempt (`retryCount >= NFE_SHOPEE_MAX_TENTATIVAS - 1`).
There the upload finalizes as `canal-indisponivel` and queues ONE recheck,
which heals a 200 lost on that very attempt, and a recheck finalizes as
`reverificacao-indisponivel`. A Firestore failure or a bug rethrows on EVERY
attempt: only the four transport classes ever finalize.

**The re-drives** (§13). The route (PR 2) and the CLI start from a pedido and
pick the slot with the LEVEL predicate. The route enqueues. The CLI runs the
same handler in process.

## 3. The trigger is TRANSITION-gated, and the predicate is not in `nfe.ts`

Mercado Livre's `onNfeAprovada` is LEVEL-gated: every write to an
already-approved `nfev4` document re-runs the ladder and, when the document is
still ready, enqueues again. Its dedup is the live shipment-status gate inside
its task. Shopee's trigger enqueues only on the EDGE:
`decideNfeUploadTransition` answers `enqueue` when `after` is ready and `before`
was not, and `ja-pronta` for a write that leaves a ready document ready.

The reason is data that already exists. The migration-window script
`2026-09-nfe-totais` rewrites `totais` on EVERY `nfev4` document, approved ones
included. Under a level trigger that one backfill becomes one upload task per
historic NF-e, each spending a `get_order_detail` against the channel's quota.
The edge still fires for the late-proc repair (`aprovada` without
`xml_nfe_proc`, then with it), because "ready" is the whole level predicate
(aprovada, proc present, first `<tpAmb>` = `1`), not the `estado` alone.

`'ja-pronta'` lives on its own type (`NfeUploadTransition`) and never joins
`NfeUploadDispatch`. Mercado Livre's route keys an exhaustive `Record` on the
four dispatch reasons, so a fifth member would be a typecheck break in another
app. Mercado Livre's behaviour is unchanged by this step; moving it to the edge
(and adding the sale gate of §4) is #1705.

⚠️ **The predicate lives in `nfeEnvioCanal.ts`, never in `nfe.ts`.** The NF-e
lane's live job selects its scope by LITERAL path prefix, and `nfe.ts` is on
that list (so are `nfeConfig.ts`, `enviNfeMsg.ts`, `pedido/`,
`shared/frete.ts` and `integracao.ts`). Any edit there emits test documents at
the rate-limited SEFAZ homologação endpoint. This predicate is about channels,
not about emission. The same constraint is why the stamp's estado set is
DERIVED in this folder (§11) rather than declared in `shared/frete.ts`.

⚠️ The re-drives never use the transition helper. A re-drive exists for a
document that is ALREADY ready (the trigger never fired, the valve was shut,
the document arrived by import), and a transition gate would refuse exactly
that population.

## 4. The sale gate

The `nfev4` subcollection of a pedido is not only the sale: it also holds
entrada, complementar, ajuste and devolução notes, and since NT 2025.002 the
crédito/débito ones. None of the designs checked that the note is a SALE, and
Mercado Livre does not either (#1705). An approved tpAmb-1 devolução on a
Shopee pedido would otherwise be UPLOADED, attaching the wrong fiscal document
to the order, or, after the sale's upload, would raise a false
`outra-nfe-anexada`.

`finalidadeDoProc(xml)` reads the first `<tpNF>` and the first `<finNFe>`:

- `1` and `1` ⇒ `venda`;
- both legible (exactly one digit once trimmed) but anything else ⇒ `outra` ⇒
  `nfe-nao-e-de-venda`, a LOG line and never an aviso;
- either element missing, or not one digit ⇒ `ilegivel` ⇒ `xml-invalido`.

"Legible" is a SHAPE, not the XSD's value list. The note is authorized, so its
domain is SEFAZ's to enforce, and a code a future layout adds lands on `outra`
(a log line) rather than on a stamp. Only the exact pair `1`/`1` is a sale:
`01` is illegible, never read as `1`.

It runs in three places. **(PR 2)** In the trigger, after the edge and before
any read. In the task, as P4. And in the slot rule, where an ILLEGIBLE proc
stays eligible on purpose: the slot rule cannot answer `xml-invalido`, and the
handler judges that XML with an aviso the operator sees. The gate is NOT in the
shared predicate, which is why Mercado Livre's behaviour did not change.

## 5. "Ours" is the key INSIDE the XML

Shopee parses the access key out of the uploaded file, and the request carries
none. So the identity that matters is the key in the SIGNED content, and
`chaveDoProc` reads it from there:

- k1 = `infNFe/@Id` minus its `NFe` prefix, which must satisfy
  `CHAVE_NFE_REGEX` ⇒ otherwise `sem-chave`;
- k2 = the first `<chNFe>` read from `<protNFe>` onwards. When present, it must
  equal k1 once trimmed ⇒ otherwise `chaves-divergentes`. No protocol at all ⇒
  k1 alone.

`chaveDaNfeParaCanal` then requires the document's stored `chave`, when it has
one, to be the same key. A document that contradicts its own XML is broken data
of ours: `xml-invalido`, never uploaded.

⚠️ `CHAVE_NFE_REGEX` is POSITIONAL and alphanumeric in the CNPJ window (NT
2026.004). A digits-only extractor would silently fail every NF-e of an
alphanumeric-CNPJ emitter.

**The key fold, and where it STOPS.** `chaveCanonica(raw)` is `trim()` and then
the regex, NOTHING more. EQUAL: the key with surrounding whitespace, or with a
trailing newline. DISTINCT, each pinned by a near-miss test: one digit
changed, the first 43 characters, one character more, `NFe` + the key, the
CNPJ letters lower-cased, the key spaced in DANFE groups of four. Every
widening (a prefix strip, a case fold, an inner-space fold, a `startsWith`)
would read ANOTHER note as ours and skip an upload in silence. The narrow fold
fails with an aviso, which an operator sees. No shared comparison helper is
used, so there is no fold-inventory row: the pairs live in the tests.

⚠️ PII: the key is compared, never logged. It never reaches a log line, an
aviso, a stamp, a task payload, the upload filename or the CLI's output. The
CLI prints `chave: confere | difere | ausente`.

## 6. What Shopee holds: four verdicts, and the order gate

Every order read (the pre-read, the read-back, the recheck) goes through
`lerPedidoNaShopee` with `SHOPEE_NFE_DETALHE_CAMPOS`: `invoice_data`,
`fulfillment_flag` and `international_label`. That list REPLACES the package's
default, so this wire carries no buyer, address, item or payment block. Rows are
reconciled by `order_sn`, never by position. A GET error never goes through the
upload's refusal table (reconcile R-f(3)):

- the rate limit ⇒ the pause arms;
- the lapsed grant ⇒ `reauth`;
- `order_not_found` or `error_not_found` (module prefix stripped, trimmed), or
  an answer without our row ⇒ `pedido-inexistente-no-canal`;
- `source_ip_undeclared` ⇒ `ip-nao-declarado`;
- anything else ⇒ thrown to the queue's ladder.

`lerNotaNaShopee(row, nossaChave)` answers one of four verdicts:

| verdict    | when                                                                         |                                                                         |
| ---------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `nao-br`   | `pedidoForaDoBrasil(row.region)`                                             | whatever `invoice_data` says                                            |
| `sem-nota` | `invoice_data` null, or its key blank (`null`, `""`, whitespace)             | `status`, `statusBruto`; `invoiceDataAusente` if the block was missing  |
| `nossa`    | the canonical key equals ours                                                | `status`, `statusBruto`, and the SANITIZED pending reason if `pendente` |
| `outra`    | a legible other key (`legivel`, with that key), or a value that is not a key |                                                                         |

⚠️ **Never "foreign" on the absence of `invoice_data`.** The wire schema folds
an ABSENT `invoice_data` and a `null` one into the same `null`, so a Brazilian
row that lacks the field reads exactly like a foreign one. Foreign is decided by
the ORDER's `region`, through the same predicate the importer uses for
`bloquearEmissaoNFe`. A Brazilian row with no block is `sem-nota`, and that
UPLOADS: a wrong skip is silent, and a wrong attempt is refused loudly.

⚠️ A blank key is `sem-nota`, never `outra`. An empty key read as "another
note" would block every upload silently, and Shopee's own sample answers `""`.

**The status fold.** `statusDaNota` is `trim()` + lower-case, then an EXACT
match on `valid` / `pending`. `invalid`, `validated` and `pending_review` are
`desconhecido`, because a substring test would RESOLVE the aviso of a rejected
note. `null` or blank is `ausente`. Shopee added the field (with
`pending_reason`) on 2026-08-06, and it is why the key alone does not confirm
an upload: a SEFAZ or SERPRO rejection can land after a 200.

**`statusBruto`, the diagnostic beside the fold.** The fold above says
`desconhecido` for every value we do not know, so it cannot say WHICH value
Shopee sent. The `sem-nota` and `nossa` verdicts therefore also carry the raw
status reduced to a TOKEN: the same trim and lower-case, kept only when the
result is 1 to 24 characters of `[a-z_]`, else `null`. It decides nothing. The
handler's completion line carries it for exactly two readings,
`status-desconhecido` and `nota-dispensada` (§8). EQUAL: `' INVALID '` logs as
`invalid`. DISTINCT (`null`): `valid.`, `pending review`, anything with a digit
and anything over 24 characters. A token has no room for a key, a document
number or a sentence, so the line never carries Shopee's free text.

**The order gate.** `portaoDoPedido(row)`, in order, the first match answers:

1. foreign region ⇒ `pedido-nao-br`;
2. `fulfillment_flag` (trimmed, lower-cased, exact) `fulfilled_by_shopee` ⇒
   `pedido-fbs`;
3. `fulfilled_by_cb_seller` ⇒ `loja-cross-border` (step 13's spelling);
4. `is_international === true` ⇒ `pedido-exportacao`. An export order's note
   is emitted by Shopee itself, so this one raises an aviso: a note exists
   for an order that should not have one;
5. `order_status` exactly `CANCELLED` ⇒ `pedido-cancelado`, which also
   RESOLVES the pedido's open aviso.

⚠️ `IN_CANCEL` does not stop the upload. The cancellation may still be refused,
so the doctrine is "send and classify, never pre-skip". A refusal of a
cancelling order classifies as `pedido-cancelado` from that same status (§7,
N3).

**The substitution.** When Shopee holds another legible key, the handler reads
the pedido's slot documents once, unfiltered (a handful, no index). If a
`cancelada` sibling carries that key, the upload proceeds with
`substituicao: true`. The sibling's key is read from its own proc, through the
same reader. Only when no proc string is stored at all does the stored `chave`
count, because an NF-e can reach `aprovada` WITHOUT its proc (the audit's
digest-mismatch path) and still be cancelled. Both cancel writers keep the
proc: `apps/nfe`'s cancel is a merge, and the legacy app's is a `copyWith`.

**The substitution lag rule.** After an upload, the order can still show the
key a substitution just replaced (read-your-write lag, register 189). An
`outra-nfe-anexada` aviso there would tell the operator, seconds after the ERP
replaced that note, that the ERP does not replace it. So the same helper,
`ehChaveDeIrmaoCancelado` (one unfiltered read of the slot documents, only when
Shopee shows another legible key), is asked at every reading AFTER an upload:

- the read-back after a 200 ⇒ `nao-refletida-ainda`, a log line, and the
  recheck it always enqueues is the arbiter;
- the recheck ⇒ one more look on its `[900, 1800]` ladder, then `descartado`
  `nao-refletida-ainda` (a log line; nothing would ever resolve an aviso);
- the read-back that DECIDES after an unreadable answer or an "already
  attached" refusal ⇒ judged as an order with NO key of ours: an uncertain
  upload retries (on the last attempt, `canal-indisponivel` plus a recheck),
  N1 stays the proven `chave-em-outro-pedido`, and N2 retries. Read as another
  note, it would end the substitution with no retry.

The rule is not gated on the upload having been a substitution: the recheck's
payload cannot say so, and a cancelled sibling's key is the same fact either
way. A THIRD key, or the same key on a sibling that is NOT cancelled, stays
`outra-nfe-anexada` at every reading.

## 7. The classifier: the code cannot decide, so the sentence does

Most of guide 382's seventeen refusal cases share ONE code, `error_param`,
with the text `Wrong parameters, detail: <sentence>`. So
`classificarRecusaDeNfe` reads the envelope's code (trimmed, one module segment
stripped, trimmed again: the api page prints `order.upload_invoice_error`
followed by a TAB), the package's `kind`, and `providerMessage`. The sentence
is folded ONCE: whitespace collapsed, the envelope prefix stripped,
lower-cased, trailing periods dropped (guide 382's texts end in `..`).

⚠️ **Needles never read `.message`.** The thrown sentence is
`Shopee <path> respondeu <code> (HTTP n) — <text>`, and on this endpoint its
haystack holds `upload`, `invoice` and `error` before Shopee has said a word. A
`null` sentence matches no needle at all.

The action is the discriminant: `ja-anexada` (the read-back decides),
`aguardar-serpro`, `ignorar`, `recusar` (whether it ALSO stamps is the sets'
answer, never the table's) and `transitorio` (rethrow). The rows, walked in
order:

| row    | matches                                                                                                           | class · motivo                                                                                               |
| ------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| N0     | `kind` burst / daily / reauth                                                                                     | `transitorio` — the handler's class ladder owns these                                                        |
| N1     | `access key duplicated` or `access_key duplicated` (case 7)                                                       | `ja-anexada` — read-back: ours ⇒ `ja-enviado`; another ⇒ aviso; none (§6) ⇒ `chave-em-outro-pedido`          |
| N2     | `already sent` (the legacy's same-order text)                                                                     | `ja-anexada` — read-back: none (§6) ⇒ `transitorio`                                                          |
| N3     | `invoice status is invalid` (case 11)                                                                             | `ignorar` — `pedido-cancelado` when the pre-read status is `IN_CANCEL`/`CANCELLED`, else `sem-suporte-a-nfe` |
| N4–N13 | issuer, CNPJ, UF, IE, cancelled, issue date, model 55, CFOP, file/XML, key                                        | `recusar` — one motivo each                                                                                  |
| N14    | `invalid nf-e` (case 5)                                                                                           | `aguardar-serpro` — the #5 ladder, then `nfe-invalida`                                                       |
| N15    | `order_sn is a required`, `file_type`                                                                             | `recusar` · `requisicao-invalida` (OUR request's defect)                                                     |
| N16    | code `source_ip_undeclared`                                                                                       | `recusar` · `ip-nao-declarado` (infrastructure; never stamps)                                                |
| N17    | `kind` transient; `error_database`; both spellings of the lapsed-token code; `upload_invoice_error` + `try again` | `transitorio`                                                                                                |
| N18    | anything else                                                                                                     | `recusar` · `recusa-desconhecida` (carries the excerpt)                                                      |

⚠️ **The order is load-bearing, and each constraint has a near-miss test.**

- **N0 first.** The package's classes are not mutually exclusive (a partial
  error copies its `kind`), so a mis-ordered arm in the handler could hand a
  rate limit to the table. Read as a row it would fall to N18 and STAMP on the
  absence of an answer.
- **N1/N2 before every other needle.** Both share the template of the other
  refusals, and a stamp on an already-attached note is the one false alarm
  nothing resolves. For the same reason N1 is the one row where a NARROW
  needle is the dangerous direction: a drift to the underscore spelling would
  fall to N18 and stamp, with no read-back, a note that may be our own. Its
  needle is therefore N13's form, a space or an underscore.
- **N10 before N14.** `Invalid NF-e model. Only model 55 is accepted.`
  contains `invalid nf-e`. Read as case 5, it would wait for SERPRO on a
  document that can never pass.
- **N12 against N15.** `field file_type type error` is our request's defect
  and must not read as a file refusal (`file error`).
- **N17 after every needle.** `upload_invoice_error` carries TWO sentences:
  "File error." (N12, deterministic) and "Upload invoice failed, please try
  again later." (transient). A code-only row would retry a file Shopee will
  never accept.

Substring needles rather than exact texts: a wording drift on a `recusar` row
costs a label, since N18 also avisa and stamps. On N14 an exact match would
turn a SERPRO wait into a stamp. The N1 and N13 needles accept a space or an
underscore in the key's field name, because guide 382 prints it both ways (and
the folder may not spell the wire field outside `notaNaShopee.ts`, §14). Every
lookup is a `Set`, never an object literal, because the codes arrive verbatim
from a provider.

## 8. What stamps, what raises an aviso, and what only logs

Every arm DECIDES a motivo, and the effects are the answer of three sets in
`errosNfe.ts`. Each phase APPLIES them in exactly one place (`aplicar` in the
handler, `aplicarEfeitos` in the recheck). Every handler outcome goes through
`aplicar`, the pauses and the SERPRO waits included, so the dry run (which
READS the sets for those arms too) and the live run cannot diverge when a set
changes. Both phases have a sweep test over every motivo they can produce:
`avisado` and the stamp follow the sets. Elsewhere the sets are only READ: the
dry run uses them to report what it would do, the outcome label follows the
aviso set, and the log line keeps the excerpt only for X. No producer restates
a set with an inline comparison.

- **A** = `MOTIVOS_QUE_AVISAM` (26): the aviso `nfeUploadRejeitado`.
- **S** = `MOTIVOS_QUE_CARIMBAM` (17): ALSO the frete stamp. `S ⊂ A`, pinned by
  a test: a stamp nobody is told about is a pedido that silently stops
  shipping.
- **X** = `MOTIVOS_COM_EXCERTO` (2): the aviso carries a sanitized Shopee
  excerpt. `X ⊂ A`.

A stamp is a DETERMINISTIC failure of THIS NF-e: the channel refused it, SEFAZ
flagged it, or our own XML can never be uploaded. It is never spent on the
ABSENCE of an answer: an exhausted transport, a note that does not show up, a
lapsed grant, an undeclared IP, the valve or the pauses. This step cannot
revoke a stamp; only step 7 moving the parcel replaces it (§10).

The five conta-wide refusals are `emissor-shopee`, `cnpj-divergente`,
`uf-divergente`, `ie-divergente` and `ip-nao-declarado`: a shop registered
wrongly at Shopee meets them on every pedido. Each raises one aviso PER PEDIDO.
That is the known cost of one chave per pedido, and the list of those avisos is
the re-drive worklist once the registration is fixed. `reauth` and the valve
behave the same way while they last. No `MOTIVOS_DA_CONTA` set is declared,
because nothing would consume it. The two conta gates only LOG: switching a
conta off is deliberate, and one aviso per pending pedido would be noise.

The whole vocabulary, as `errosNfe.ts` declares it:

| motivo                        | produced by                                                          | outcome                                                                | A   | S   | X   |
| ----------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- | --- | --- | --- |
| `apagada`                     | shared LEVEL predicate (trigger, P2, slot rule)                      | descartado                                                             |     |     |     |
| `nao-aprovada`                | shared LEVEL predicate                                               | descartado                                                             |     |     |     |
| `xml-ausente`                 | shared LEVEL predicate                                               | descartado                                                             |     |     |     |
| `tpamb-homologacao`           | shared LEVEL predicate                                               | descartado                                                             |     |     |     |
| `nfe-nao-encontrada`          | `processarNfe` P1                                                    | descartado                                                             |     |     |     |
| `sem-nfe-aprovada`            | `pedidoNfe` slot rule (route 409, CLI)                               | —                                                                      |     |     |     |
| `nfe-nao-e-de-venda`          | `finalidadeDoProc` (trigger, P4, slot rule)                          | descartado                                                             |     |     |     |
| `pedido-nao-encontrado`       | `avaliarPedidoParaNfeShopee`                                         | descartado                                                             |     |     |     |
| `nao-shopee`                  | `avaliarPedidoParaNfeShopee`                                         | descartado                                                             |     |     |     |
| `emissao-bloqueada`           | `avaliarPedidoParaNfeShopee`                                         | descartado (warn)                                                      |     |     |     |
| `xml-invalido`                | P4 illegible proc; P5 `chaveDaNfeParaCanal`                          | recusado                                                               | A   | S   |     |
| `xml-grande-demais`           | P5, the package's byte ceiling                                       | recusado                                                               | A   | S   |     |
| `conta-nao-configurada`       | P6 `avaliarContaParaNfeShopee`; P7 typed conta and credential errors | descartado                                                             |     |     |     |
| `conta-inativa`               | P6 (`ativo !== true`)                                                | descartado                                                             |     |     |     |
| `sem-shop-id`                 | P7                                                                   | descartado                                                             |     |     |     |
| `configuracao-do-app`         | P7 (`ShopeeConfigError`)                                             | descartado (warn)                                                      |     |     |     |
| `aguardando-serpro`           | the #5 self re-enqueue                                               | adiado                                                                 |     |     |     |
| `pedido-inexistente-no-canal` | `lerPedidoNaShopee`                                                  | descartado (`error` log)                                               |     |     |     |
| `pedido-nao-br`               | `portaoDoPedido`; a read-back or recheck `nao-br`                    | descartado                                                             |     |     |     |
| `pedido-fbs`                  | `portaoDoPedido`                                                     | descartado                                                             |     |     |     |
| `loja-cross-border`           | `portaoDoPedido`                                                     | descartado                                                             |     |     |     |
| `pedido-cancelado`            | `portaoDoPedido` (resolves); N3 on a cancelling order                | descartado                                                             |     |     |     |
| `pedido-exportacao`           | `portaoDoPedido`                                                     | recusado                                                               | A   |     |     |
| `outra-nfe-anexada`           | any read: another legible key, not a cancelled sibling's (§6)        | recusado                                                               | A   |     |     |
| `chave-ilegivel`              | pre-read, read-back, recheck: a value that is not a key              | recusado                                                               | A   |     |     |
| `nfe-validada`                | ours + `valid`, at any read (resolves)                               | ja-enviado / enviado / validada                                        |     |     |     |
| `validacao-pendente`          | ours + `pending`, no reason                                          | ja-enviado + recheck; recheck: reverificacao-agendada, then descartado |     |     |     |
| `status-desconhecido`         | ours + no or unknown status (never resolves)                         | ja-enviado + recheck; recheck: descartado (warn)                       |     |     |     |
| `nota-dispensada`             | recheck: no key, status `valid`                                      | descartado                                                             |     |     |     |
| `nao-refletida-ainda`         | read-back: no key / a cancelled sibling's key; recheck: the latter   | enviado + recheck; recheck: reverificacao-agendada, then descartado    |     |     |     |
| `sefaz-pendente`              | ours + `pending` + a reason, at any read                             | recusado (enviado after a 200)                                         | A   | S   | X   |
| `nao-anexada`                 | recheck: no key, status not `valid`                                  | recusado                                                               | A   |     |     |
| `emissor-shopee`              | classifier N4                                                        | recusado                                                               | A   | S   |     |
| `cnpj-divergente`             | classifier N5                                                        | recusado                                                               | A   | S   |     |
| `uf-divergente`               | classifier N6                                                        | recusado                                                               | A   | S   |     |
| `ie-divergente`               | classifier N7                                                        | recusado                                                               | A   | S   |     |
| `nfe-cancelada`               | classifier N8                                                        | recusado                                                               | A   | S   |     |
| `data-de-emissao-invalida`    | classifier N9                                                        | recusado                                                               | A   | S   |     |
| `modelo-nao-55`               | classifier N10                                                       | recusado                                                               | A   | S   |     |
| `cfop-nao-aceito`             | classifier N11                                                       | recusado                                                               | A   | S   |     |
| `xml-recusado`                | classifier N12                                                       | recusado                                                               | A   | S   |     |
| `chave-invalida`              | classifier N13                                                       | recusado                                                               | A   | S   |     |
| `requisicao-invalida`         | classifier N15                                                       | recusado                                                               | A   | S   |     |
| `chave-em-outro-pedido`       | N1 + a read-back with no key                                         | recusado                                                               | A   | S   |     |
| `nfe-invalida`                | the #5 ceiling (the fourth "not valid yet")                          | recusado                                                               | A   | S   |     |
| `recusa-desconhecida`         | classifier N18                                                       | recusado                                                               | A   | S   | X   |
| `ip-nao-declarado`            | classifier N16; `lerPedidoNaShopee`                                  | recusado                                                               | A   |     |     |
| `sem-suporte-a-nfe`           | classifier N3, order not cancelling                                  | descartado                                                             |     |     |     |
| `reauth`                      | `ShopeeReauthRequiredError`, upload or read                          | recusado                                                               | A   |     |     |
| `canal-indisponivel`          | the upload's last attempt, transient                                 | erro-final (+ one recheck)                                             | A   |     |     |
| `reverificacao-indisponivel`  | the recheck's last attempt, transient                                | erro-final                                                             |     |     |     |
| `limite-de-taxa`              | burst pause                                                          | pausado                                                                |     |     |     |
| `cota-diaria`                 | daily pause                                                          | pausado                                                                |     |     |     |
| `pausa-reenqueues-esgotados`  | the pause ceiling (6)                                                | erro-final                                                             | A   |     |     |
| `tasks-desabilitadas`         | a closed valve on a self re-enqueue; (PR 2) the trigger's enqueue    | descartado                                                             | A   |     |     |
| `payload-invalido`            | the dispatcher's `safeParse`                                         | descartado (`error` log, field paths only)                             |     |     |     |

The outcome label FOLLOWS the aviso set for every stop (`recusado` when the
operator is told, `descartado` otherwise); it never decides an effect. After a
200 the outcome stays `enviado` whatever the read-back says, and the sets still
apply: a `sefaz-pendente` read-back avisa and stamps. The handler writes ONE
completion line per task, with ids, counters, slugs, Shopee's code only when
it is a token, `statusBruto` only for `status-desconhecido` and
`nota-dispensada` (§6), and the excerpt only for X. Its LEVEL follows the
effects too: a line is a `warn` whenever the execution raised the aviso or
stamped the frete, even when the label is `enviado`, so a parcel that stops
shipping never hides among the healthy `info` lines. A
`motivosProduzidos.test.ts` backstop (wave 4) fails on any member nothing
produces.

⚠️ **The frete's owner is not a motivo.** A proved Shopee pedido whose
`freteInicial.externalOptionIntegracao` names ANOTHER integradora (an operator
re-pointed it to Melhor Envio, a courier, a pickup) is enqueued and uploaded
like any other. Shopee attaches the note to the ORDER (its upload has no
package number), so the order still owes it, and Mercado Livre's
shipment-scoped reason for skipping does not transfer. Only the stamp is
owner-guarded, by its own `outra-integradora` answer (§11). No member encodes
that skip, on purpose (an earlier draft had `frete-de-outra-integradora`).

## 9. Shopee's text: two motivos, one sanitizer

Shopee's free text reaches an operator only where its meaning is not ours to
know in advance: SEFAZ's `pending_reason` (`sefaz-pendente`) and the detail of
a refusal no row recognises (`recusa-desconhecida`). There is no open family
like `sefaz-<cStat>`, which would break the closed union and its backstop. The
cStat survives inside the excerpt instead. Everywhere else the operator reads
our own fragment, and the frete stamp carries no text at all.

The raw string can carry an access key, a CNPJ or CPF (numeric or
alphanumeric) or an order number, so it goes through `resumirTextoDaShopee`
first. An IP address is masked only when it carries ≥ 7 digits: an IPv4 such
as `34.95.1.2` (six digits) survives, which is acceptable because it is our own
egress address, not personal data. Steps, in order:

1. `null` or blank ⇒ `null`.
2. Control (`\p{Cc}`) AND format (`\p{Cf}`) characters DROPPED, not spaced.
   Shopee's pages print a TAB inside their own strings, and a zero-width space
   or a soft hyphen between digit groups is invisible to an operator yet splits
   every rule's run. Dropping can only glue, never hide a match.
3. Whitespace collapsed, trimmed.
4. A leading `Wrong parameters, detail:` (case-insensitive, repeated) and the
   trailing periods stripped.
5. Masked (below).
6. Capped at `EXCERTO_SHOPEE_MAX` = 160 characters with `…`, AFTER the mask, so
   a cut can never expose the first digits of a number the mask would have
   hidden whole.
7. Masked AGAIN. The cut glues `…` to the last token, which can lift it to rule
   (b)'s twelve characters, so without this pass the output is not a fixpoint
   at the cap edge, and the aviso, the log line and the CLI (which each
   re-sanitize) could disagree. A mask only shrinks the text, so the result
   still fits the cap.

**Three mask rules, because each alone leaks.**

- (a) **digit groups:** every maximal run of digits joined by at most ONE of
  `.` `/` `-` or a space between groups, whose DIGIT total is ≥ 7. It catches a
  key printed the way the DANFE prints it (groups of four, each harmless on its
  own), and a formatted CNPJ or CPF.
- (b) **long tokens:** every whitespace token of ≥ 12 characters that carries
  ≥ 7 digits (letters or not), or that mixes letters with ≥ 2 digits. The first
  arm catches a numeric key or CNPJ whose groups are joined by a character rule
  (a) does not join on (`,` `_` `|` `:` `–`). The second catches a formatted
  alphanumeric CNPJ, an order number shaped like `260910KJBHUJDM` (only six
  digits) and a key glued to a label.
- (c) **alphanumeric groups:** every maximal run of ≥ 3 groups joined by ONE
  space, `.`, `/` or `-`, each group 1 to 6 characters of `[0-9A-Za-z]` with at
  least one digit, whose DIGIT total is ≥ 7. It catches a DANFE-spaced key
  whose CNPJ window holds letters (`… 09ZZ 1ZZ2 ZZ3Z …`: rule (a) stops at
  every letter, and every token is short) and a SPACED alphanumeric CNPJ. The
  one-digit-per-group demand is what keeps prose alive: without it
  `539 CFOP 5102` would read as one seven-digit identifier.

All three rules judge the SAME unmasked text and the union of their spans
becomes `•••`. Applying them in sequence leaks either way: masking one first can
shorten a token below another's threshold. The pass then repeats until nothing
more matches, so `f(f(x)) = f(x)`, the cap edge included. `fraseDoErroDoAviso`
re-runs the sanitizer on whatever excerpt it is handed, so an unsanitized string
passed by mistake still cannot reach the aviso. PAIR: a DANFE-spaced key
(numeric or alphanumeric), a key joined by any of `,` `_` `|` `:` `–`, a
zero-width space or a soft hyphen, a formatted CNPJ and the fixture order
number are masked. NEAR-MISS: a cStat (`539`), a CFOP (`5102`), a sentence like
`Rejeição 539: CFOP 5102 não permitido`, an amount (`12.345,67`) and any run of
up to six digits SURVIVE on purpose, because they are what the operator needs
to act. The price is paid at the other edge: a date written with separators
(eight digits) is masked too.

**The accepted residue**, measured and pinned by the tests so neither this page
nor the module's header can start lying in silence:

- Groups joined by TWO characters (a dash between spaces, or a comma or a
  semicolon followed by a space) join under no rule, so a key printed
  `9926 - 0911 - …` leaves every four-digit group readable. Joining
  across two characters would also join `123 - 4567` and a list of short
  numbers, which is prose.
- A group with NO digit breaks rule (c)'s run: the bare alphanumeric root
  `12.ABC.345` (five digits) survives whole, and a spaced `12 ABC 345 01DE 35`
  keeps its leading `12 ABC` while the rest is masked. The FORMATTED
  `12.ABC.345/01DE-35` is one long token and rule (b) masks it whole.

The leak the first draft carried (a DANFE-spaced key with an alphanumeric CNPJ,
of which cUF, AAMM and most of the CNPJ stayed readable) is FIXED by rule (c).
It reached `motivoPendente` too, which is sanitized by this same function.
#1706 (register 200) still tracks promoting ONE shared identifier masker for
the whole repo, so the next module that needs one reuses it instead of growing
its own copy.

## 10. The aviso, and who resolves it

`nfeUploadRejeitado` has ONE row per PEDIDO:
`chaveDeAviso({ tipo, conta: integracaoId, entidade: pedidoId })`, with no NF-e
id and no window. A pedido can carry several NF-e documents over its life, and
keying on the NF-e would leave the row a cancelled note raised standing after
its replacement landed, because the resolver would compute the NEW note's key.
A second refusal on the same pedido refreshes the row (`ocorrencias` + 1, the
newer `motivo` and `erro`) instead of minting another.

- `severidade: atencao`, `canal: shopee`, the link is the PEDIDO's route
  through `ROTAS_AVISO.pedido`.
- `params` are exactly `pedido` (the display number, which is the order number
  on this channel) and `erro` (the motivo's fragment, plus the excerpt for X
  only). The web renders those two and nothing else. The kebab motivo rides in
  `aviso.motivo`, and Shopee's code goes to the log line.
- No event clock and no `prazo`. `escreverAviso` drops a delivery whose clock
  merely EQUALS the stored one, and every NF-e task starts from a fresh read
  rather than a provider delivery, so a supplied clock would freeze
  `ocorrencias` and drop a genuine repeat.
- `avisarNfeShopee` throws `RangeError` when handed a motivo outside A, before
  any read or write: a caller that gets there is a bug.
- The web title and body read "Envio de NF-e ao canal não concluído" and
  `O envio da NF-e do pedido {pedido} ao canal não foi concluído: {erro}.`.
  The old "recusou" wording was false for most of the motivos that raise it.
  The change needs a web deploy.

**The machine resolvers** (the `aviso.ts` rule: every tipo names its resolver
before it ships), each a TRANSITION: an absent or already-resolved row answers
`false` and writes nothing.

- **Step 14's own.** Ours + `valid` at the pre-read, the read-back or the
  recheck ⇒ `nfe-validada`. An order `CANCELLED` at a task's pre-read ⇒
  `pedido-cancelado`. An absent or unknown status NEVER resolves: an unknown
  token may be a rejection spelled in a way we do not know.
- **The cross-step hook, `resolverAvisoNfeSeEncerrado`**, called by BOTH
  callers of step 7's `salvarFreteShopee`, after it returns and outside its
  transaction, on EVERY outcome:
  - Both hand it `ResultadoFreteShopee.estadoConfirmado`: the estado the block
    holds once the frete transaction is over (the one it wrote, or on a replay
    the one its own `tx.get` found and kept, never a second read), and only
    when Shopee's own package diary folds to that same estado; `null`
    otherwise. An estado in `ESTADOS_FRETE_REMOVE_ESTOQUE` ⇒
    `frete-despachado`. On this channel the parcel moves only after a shipment
    Shopee allows with a valid invoice.
  - ⚠️ The diary condition is load-bearing. The bare stored estado is not a
    Shopee fact: `empacotado` and `checkFinalizado` are the OPERATOR's
    warehouse estados, sit in the removal set too, and step 7's ladder keeps
    them against a lower pull. They are also outside the stamp's estado set,
    so on a packed pedido the aviso is the ONLY signal, and closing it because
    a parcel was packed would hide a problem Shopee has not cleared. Accepted
    residual, pinned by a test: an operator `checkFinalizado` kept against
    Shopee's `aguardandoPostagem` does not resolve, although both are in the
    set.
  - `pedidos/importarPedido.ts` (step 5, the order import) also passes the
    order's `order_status`: otherwise `CANCELLED` ⇒ `pedido-cancelado`. That
    arm deliberately does NOT wait for a frete write: an XML defect can open an
    aviso on an already-cancelled order, and its next re-import changes no
    frete. `pedidos/rastrearPedido.ts` (step 7, the package push) has no order
    row, hence no order status.
  - The cost: ZERO reads for a pre-shipment delivery; ONE aviso read per
    delivery about a parcel already in the removal set (a replay, or a refresh
    that moves no estado), plus one per import of a cancelled order. That read
    is what makes the retry real: a Firestore failure PROPAGATES (no catch),
    the queue redelivers, the frete comes back `ignorado-sem-mudanca`, and the
    caller still hands over the confirmed estado (or the cancelled status), so
    the resolve is tried again. Handing over only a WRITTEN estado would have
    skipped it on the replay, and an aviso whose resolve failed on the
    parcel's last transition would have stood forever.
  - Without the CANCELLED arm an aviso on a cancelled order would stand
    forever. A stamped frete never becomes `cancelado`, because step 7's gate
    preserves `error` against routine churn (`erro-preservado`). An unresolved
    aviso is never swept.

`avisoNfe.ts` imports nothing from `pedidos/`, and the dependency stays
one-way. The one status token it compares (`CANCELLED`) is spelled locally, and
its suite pins it against the importer's own status table.

## 11. Rule 7, write by write

This folder writes three things, and each one names its race tier.

- **The frete stamp: class C** (`carimboFreteNfe.ts`, inventoried in
  `firestore-transaction-inventory.test.js`). The handler reads the pedido,
  talks to Shopee, and only then opens the transaction, so a network round
  trip sits between the outside read and the write. The named guard: NOTHING
  from the outside read reaches the write. The callback re-reads the pedido
  with its own `tx.get` (raw, the step-7 reason), and the pure
  `preverCarimboNfeShopee` re-derives every guard and every written value from
  that snapshot. The only outside inputs are the pedido id and `nowUs`. An OCC
  loser therefore recomputes: when step 7 commits `aguardandoPostagem` between
  our read and our commit, the retry answers `fora-do-escopo` and writes
  nothing, which is correct because the parcel shipped. The guards, each a
  no-write answer:
  - `sem-pedido` (a stamp never creates);
  - `sem-frete` (a synthesized block would render a freight nobody chose);
  - `outra-integradora` (strict equality to Shopee's slug, so an absent owner
    refuses too). This is the ONLY place the frete's owner matters: the upload
    itself still runs for a re-pointed frete (§8), because the note belongs to
    the order;
  - `ja-carimbado` (ZERO writes on a replay, or every replay would move
    `ultimaModificacao` and file an audit row);
  - `estado-ilegivel`;
  - `fora-do-escopo`, outside the DERIVED eight-estado set
    `NAO_POSTADO ∖ REMOVE_ESTOQUE ∖ SHOPEE_TERMINAL`. Derived, so it cannot
    disagree with its three sources, and pinned literally, so an upstream
    change reds a test instead of widening what is stamped.

  The write rebuilds `freteInicial` WHOLE from the snapshot
  (`{ ...stored, estado: error }`), because `tx.update` masks at the top-level
  key and a partial block would erase `pacotes`, `codRastreio` and step 5's
  watermark. It also advances the top-level `ultimaModificacao` monotonically
  in µs: `maiorUs(coerceToMicros(stored), nowUs)`. That makes the stamp the
  app's FIFTH µs READER. It coerces a stored value the way the other readers
  do and converts nothing it receives (`nowUs` arrives computed once per
  execution through `avisos/autorizacao.ts`'s `agoraUsDe`), so there is no
  ninth numbered site. It never writes `lastMarketplaceUpdate` (step 5's ORDER
  clock), and the operator-interaction flag is not a guard. It is
  stock-neutral: `error` is only written over an estado outside the removal
  set.

- **The aviso raise: tier 0 + tier 1.** A deterministic id, plus the shared
  writer's read and `lastUpdateTime` precondition, which recomputes the patch
  when it loses. **The resolve: tier 1**, the same precondition inside
  `resolverAviso`, answering a transition.
- **A raise racing a resolve: the raise wins.** There is no event clock by
  design, so sequentially the later write wins. In a true race the raise that
  loses its precondition re-reads and REOPENS a row the resolve just closed,
  and a resolve that loses answers `false` (the shared resolver's comment
  names only "someone else resolved"; a concurrent raise is the third case).
  That is the safe direction: a stale open aviso, never a hidden problem. The
  envio and its recheck share one queue, which PR 2 serialises
  (`rateLimits { 1, 1 }`), so the only real concurrency is a step-5/7 hook
  (another queue) or the in-process CLI `--live`, and the stale row heals the
  way §10 describes.
- **The write order, in the handler.** The aviso FIRST, then a due recheck,
  then the stamp, then the resolve. A swallowed stamp would leave the pedido
  looking dispatchable, so a stamp failure PROPAGATES: the aviso already
  stands, and the queue retries the WHOLE execution. That retry is not a
  zero-write replay. After a refusal it UPLOADS again (a refused note leaves no
  key), Shopee refuses again, and the aviso is written again (a repeat, which
  bumps `ocorrencias`); only then does the stamp land. The recheck is enqueued
  BEFORE the stamp because the enqueue writes no document: after a
  `sefaz-pendente` read-back (the one arm that both stamps and owes a recheck),
  a stamp failure no longer loses the look, and the retry's pre-read, which
  finds our key BEFORE any upload of its own, owes none, so at most one
  recheck is ever enqueued.
- **The write order, in the recheck.** The aviso, then the stamp. A stamp
  failure re-runs the whole recheck: one more order read, the same verdict,
  the aviso again, then the stamp. No arm of its table both stamps and
  re-enqueues, so no look is lost with it.
- **The re-enqueues write no document.** A duplicate task converges through the
  pre-read (Shopee then holds OUR key ⇒ `ja-enviado`), and a duplicate recheck
  is one more read-only look.

## 12. The delays, and why each is what it is

| constant                    | value                 | what                                                                      |
| --------------------------- | --------------------- | ------------------------------------------------------------------------- |
| `ATRASO_SERPRO_S`           | 360 s                 | the trigger's first enqueue, after approval                               |
| `ATRASOS_SERPRO_REENVIO_S`  | `[600, 1800, 3600]` s | the #5 self re-enqueues; the length is the ceiling                        |
| `ATRASOS_REVERIFICACAO_S`   | `[900, 1800]` s       | the recheck after a 200, and one more only while pending without a reason |
| `NFE_SHOPEE_MAX_PAUSAS`     | 6                     | rate-limit re-enqueues, burst and daily together                          |
| `NFE_SHOPEE_MAX_TENTATIVAS` | 4                     | the queue's `maxAttempts`, pinned by equality in PR 2                     |

- **360 s.** Shopee checks the note against the federal record (SERPRO), which
  lags the SEFAZ authorization, and its guide asks for about five minutes. The
  trigger fires only AFTER the authorization is persisted, so both candidate
  anchors (the emission instant and the authorization instant) are already
  past when the wait starts. 300 s plus a 60 s margin covers both. Every minute
  above the need is a minute the expedição waits at step 15. ⚠️ Never below
  300: the tasks emulator IGNORES `scheduleDelaySeconds`, so no round trip can
  catch an early dispatch, and the constant pin is the only guard. The
  re-drives pass `atrasoSerproS(data_autorizacao, nowMs)` instead, clamped to
  `[0, 360]` and rounded UP. A note approved yesterday waits nothing, and a
  delay of 0 omits the option entirely. A `null` or non-finite instant waits
  the full window, because the safe direction is to wait.
- **`[600, 1800, 3600]`.** Shopee's case 5 ("not valid, or less than five
  minutes old") is a DELAYED SELF re-enqueue that spends no queue attempt,
  since waiting for SERPRO is not a transport failure. It escalates because
  multi-hour SEFAZ outages have been observed, and it reaches about an hour and
  forty minutes after the first attempt before the fourth such answer
  finalizes as `nfe-invalida`.
- **`[900, 1800]`.** A 200 is not proof, because a SEFAZ flag can land after
  it. The recheck is one GET and is the only chance to see that flag before
  step 15 tries to ship. The second look happens only for "pending without a
  reason", which is ambiguous (still validating, or simply not
  shipment-ready). After it comes a log line, never an aviso, because nothing
  would ever resolve one. Step 15's shipment call is the backstop. A cancelled
  sibling's key still showing after an upload earns the same second look
  (§6).
- **Pauses.** A burst waits for its `Retry-After`, or step 12's pause minutes.
  A daily limit waits until the next 00:00 UTC+8 (step 11's
  `proximaViradaDaCotaMs`). Both add a jitter of up to 30 s (step 13's
  `PARQUE_JITTER_MAX_S`), so a fleet paused on one limit does not resume on
  one second, and both count in `pausas`. Without a ceiling, a conta stuck at
  its quota would re-enqueue the same NF-e forever. ⚠️ The ceiling is per
  re-enqueue CHAIN: the recheck an upload enqueues (after a 200, or with the
  final-attempt `canal-indisponivel`) starts a new chain, bounded by its own
  ladder, with `pausas: 0` (`adiamentosSerpro` is carried as it is; nothing in
  the recheck spends it). Inheriting the upload's count would let one rate
  limit on the recheck's read end an ACCEPTED note as
  `pausa-reenqueues-esgotados`, with an aviso, and the recheck (the only look
  before step 15) would never run. Pauses inside the recheck chain keep
  counting.
- **The queue (PR 2).** `maxAttempts 4`, `timeoutSeconds 120`, backoff 60–300 s
  with `maxDoublings 2`, `rateLimits { 1, 1 }`, the two partner secrets. The
  whole ladder is 4 × 120 + 3 × 300 = 1380 s, within the 1800 s bound the
  functions index test pins on every queue.

## 13. The re-drives, the valve, and why there is no sweep

Nothing re-sends by itself. Step 4's order backfill never filters for a missing
invoice, and a Firestore import fires no trigger, so an NF-e approved while the
valve was shut, or imported at the cutover, arrives inert. Two surfaces
re-drive, both starting from a pedido, both picking the slot with
`escolherNfeParaEnvioShopee`:

- The slot rule lists the pedido's `nfev4` documents unfiltered (a handful, no
  index). A document is eligible when the LEVEL predicate says ready and its
  proc is not a legible non-sale note. Several eligible ⇒ the latest
  `data_autorizacao` wins (read in ms through the tolerant reader), and a tie
  goes to the lowest id. None ⇒ the reason of the document that got FURTHEST
  (`nfe-nao-e-de-venda` over `tpamb-homologacao` over `xml-ausente`), else
  `sem-nfe-aprovada`. A cancelled slot is `nao-aprovada` to the predicate, so
  it is never chosen over its replacement.
- **(PR 2) The route** `POST /api/marketplace/shopee/enviar-nfe` is
  `PERM.pedido.write`, because its callers are expedição staff on a pedido
  screen, unlike every other Shopee route. Its body is its own strict
  `{ pedidoId, nfeId? }`, never the task payload, so a caller cannot post a
  phase or a counter. It re-runs the pre-network gates, never builds a client
  and never calls Shopee. It answers 202 (with `enfileirado`, the two ids and
  `atrasoSegundos`) for EVERY eligible document. Even when Shopee already holds
  our key, the task's pre-read answers `ja-enviado`, and it closes any open
  aviso once the note reads valid. It answers 409 `SHOPEE_NFE_NAO_ELEGIVEL` with the motivo and
  `mensagemDoMotivoNfe`'s sentence, 404 for an explicit `nfeId` that does not
  exist, and 503 `SHOPEE_NFE_ENFILEIRAMENTO_DESLIGADO` on the valve.
- **The CLI** `enviar:nfe` is dry-run by default and **never enqueues**. The
  queue-level enqueuer binding is authoritative for the identities in
  `TASKS_INVOKER_SA`, and a developer's credentials are a third identity whose
  enqueue is unverified. So `--dry-run` runs `simularEnvioNfeShopee`: the same
  prefix and the ONE Shopee pre-read, with no scheduler, no increment sentinel
  and no writer reachable. `--live` runs `processarNfeShopee` in process with
  `retryCount` 0 and a RECORDING scheduler, and prints the recheck or wait it
  would have queued. At attempt 0 a transient throws, so the CLI can never
  finalize `canal-indisponivel`. It prints ids, outcomes, motivo sentences,
  byte counts and `chave: confere | difere | ausente`, never the key, the order
  number, the XML or Shopee's raw text. Flags and output are in
  `scripts/README.md`.

**The valve.** `SHOPEE_TASKS_DISABLED=1` makes this queue's scheduler throw its
OWN `ShopeeNfeUploadTasksDisabledError`, not the channel's shared class. The
shared one sits in `core/containment.ts`'s per-conta containment set, where an
NF-e enqueue raising it could be swallowed as one conta's `lastError`. The
valve is a deployment state and no NF-e sweep sits behind it, so every caller
answers the class explicitly:

- **(PR 2)** the trigger raises the `tasks-desabilitadas` aviso, one per
  pedido: the list is the worklist;
- **(PR 2)** the route answers 503;
- the handler's self re-enqueues end as `tasks-desabilitadas`;
- the post-200 recheck only warns, because the upload already landed. So does
  the one queued with the final-attempt `canal-indisponivel`, which is why that
  motivo's sentence promises no automatic check: it leads with the remedy
  (verify in the Seller Center, or re-send through the ERP).

The channel's documented promise ("never a silent drop") therefore holds for
NF-e through the aviso, not through a sweep. PR 2 amends the `.env.example`
and `apphosting.yaml` comments to say so. There is no master valve: an unset
flag must mean "on".

**No sweep, by decision.** The plan chose the two re-drive surfaces over a
sweep. Step 4's backfill cannot stand in for one: it sends no status filter,
and the package has no parameter for Shopee's `INVOICE_PENDING` list (register
202, step 15's decision). The aviso list is the worklist, and the route and the
CLI are the recovery.

## 14. Folder discipline

Ten raw-text greps must hold under `apps/shopee/lib/shopee/nfe/*`. They cover
source files only (`*.test.ts` and `*.md` excluded), comments and docblocks
INCLUDED, so a source file states a prohibition without spelling the banned
name. As rules:

1. The multi-document atomic-write API appears in EXACTLY ONE file,
   `carimboFreteNfe.ts`: the class-C stamp (§11).
2. No ambient clock, no timer, no ms → µs converter and no `next/server`
   import. The functions bundle reaches this folder, so the instant is
   `deps.nowMs`, and the randomness of the jitter is `deps.jitterSec`.
3. The tolerant µs coercion appears only in `carimboFreteNfe.ts`, on the
   STORED `ultimaModificacao`.
4. No raw `.collection(`: every access goes through the
   `@delfrance/data/admin/collections` handles.
5. No `process.env`. The valve and the region come from `../shopeeTasks.ts`,
   and the pause minutes from step 12's constants.
6. Nothing keys on a logistics channel or a carrier id. Whether a carrier needs
   no note is Shopee's answer (N3), never our table.
7. No `.message` in `classificarNfe.ts`: the needles read `providerMessage`.
8. None of the shared equivalence-fold helpers. The two folds here are the
   narrow key and status folds of §5 and §6.
9. Shopee's key field is named only in `notaNaShopee.ts`. Every other module
   holds a verdict, never the row's key.
10. No Mercado Livre text in `errosNfe.ts`: a sentence borrowed from another
    integration describes that one's mechanism, not this one's.

```bash
P='apps/shopee/lib/shopee/nfe/*'; X=':(exclude)*.test.ts'; Y=':(exclude)*.md'
git grep -n "runTransaction" -- "$P" "$X" "$Y"            # exactly carimboFreteNfe.ts
git grep -nE "Date\.now\(|new Date\(\)|setTimeout\(|setInterval\(|millisToMicros|from 'next/server'" -- "$P" "$X" "$Y"
git grep -n "coerceToMicros" -- "$P" "$X" "$Y"            # exactly carimboFreteNfe.ts
git grep -n "\.collection(" -- "$P" "$X" "$Y"
git grep -n "process\.env" -- "$P" "$X" "$Y"
git grep -nE "logistic_id|logistics_channel_id|90003" -- "$P" "$X" "$Y"
git grep -nE "\.message\b" -- apps/shopee/lib/shopee/nfe/classificarNfe.ts
git grep -nE "\b(normalizeLoose|deepEqual|stripNullsDeep|localizarDecimal)\b" -- "$P" "$X" "$Y"
git grep -n "access_key" -- "$P" "$X" "$Y"                # only notaNaShopee.ts
git grep -ni "mercado livre" -- apps/shopee/lib/shopee/nfe/errosNfe.ts
```

Every line without a comment must print NOTHING. ⚠️ `git grep` prints nothing
for an UNTRACKED file either, so a new module is checked only after
`git add -N`.

Two backstops hold the vocabulary (wave 4). `motivosProduzidos.test.ts` walks
all fifty-six motivos and fails on any that no source outside `errosNfe.ts`
produces. It scans this folder, plus the route folder `enviar-nfe` once PR 2
creates it (`PASTAS_DE_ROTA` flips to `true` there), and it exempts, each with
its reason, the quoted literals that are not this vocabulary: the stamp's
`MotivoCarimbo` values and the classifier's two "already attached" cases.
`disciplinaDaPasta.test.ts` beside it runs the ten greps above as a test.

## 15. Out of scope, on purpose

- **Emitting, signing, cancelling or correcting an NF-e**, and the NF-e total
  formula: `apps/nfe` owns all of it.
- **`ship_order` and the label** (step 15). Step 15 will call `/enviar-nfe`
  when the ship call answers that the invoice is missing. The ship-side code's
  spelling is register 193. ⚠️ Step 15 must NEVER gate `ship_order` on the
  frete not being `error`. The stamp outlives a validated NF-e: when a
  replacement lands, or a `sefaz-pendente` note later reads valid, the aviso
  closes, but this step cannot revoke the stamp (§8), and it clears only when
  step 7 writes an estado of the removal set, which happens only AFTER the
  parcel moves. A gate on it would deadlock the very pedido it waits for.
- **A sweep or a schedule** (§13), and a `get_order_list` walk on
  `INVOICE_PENDING` (register 202, step 15's decision).
- **`add_invoice_data`.** It exists behind a login-gated page, and it is
  deliberately unused (register 203).
- **PDFs** (DANFE or CC-e) and **the FBS document family**: Shopee invoices
  fulfilled orders itself, and `portaoDoPedido` skips them.
- **Export orders.** They are skipped with an aviso, never uploaded (§6).
- **Mercado Livre.** Its uploader keeps its level trigger and has no sale gate;
  #1705 carries both.
- **Any deploy or any run against real data.** Everything a real project needs
  is §16's window list, proposed, never run.

## 16. What is UNVERIFIED and what settles it

The settle-live register for step 14 is **items 184–203**. The authoritative
table, with the same numbers and statuses, is the Built-14 bullet of
`.master_plans/shopee/shopee-marketplace-integration.md` §4. None of the
items is a gate.

- **Settled by the sandbox probe** (a synthetic XML with an impossible UF and a
  repeated-digit CNPJ, on ONE fresh SG Console order, against the COMMITTED
  op; each answer flips one named constant, in a commit quoting the probe
  step). Items: 184 (the multipart shape: parts, `file_type` as text `'4'`,
  filename, content type), 185 (what an SG order answers), 194's half
  (whether `international_label` is accepted on a replacing field list; if
  refused, the export arm and its motivo go), 195 (whether "1MB" is 10⁶ or
  2²⁰ bytes, which is the ceiling literal), and 186 and 188 when the probe
  reaches them (the success envelope's `error: ""` vs absent, and the
  same-order resend text, which is N2's needle).
- **Needs a Brazilian shop, and is not rehearsable in the sandbox** (the
  migration window's first watched upload, W5 below):
  - 186 if the probe did not answer it;
  - 187: whether guide 382's cases arrive as `error_param` plus the envelope
    prefix, and which of them this API can return at all. Cases 8, 9, 12 and
    13 name `add_invoice_data` fields;
  - 188 if not the probe;
  - 189: the read-your-write lag after a 200, in both faces (no key yet, and
    a substitution's replaced key still showing, §6). `nao-refletida-ainda`
    counts it;
  - 190: `valid` with no key on a carrier that needs no note, and its pair with
    case 11 (master plan §7 q4: whether Correios is in use at all);
  - 191: the SERPRO anchor, and whether an upload under five minutes really
    answers case 5;
  - 192: the `pending_reason` values, whether they carry identifiers, and how
    often "pending without a reason" still holds at 15 and 45 minutes;
  - 194's half: an export order's `region`;
  - 196: whether `upload_invoice_error` + "try again later" is really
    transient;
  - 197: a second upload over an attached key of a CANCELLED note (the
    substitution);
  - 198: `invoice_data` absent on a Brazilian row, and a `-` or spaced key.
- **Step 15's**: 193 (the ship-side code: `logistics.lack_of_invoice_data` per
  the ship page, `error_pending_invoice` per the announcement) and 202.
- **Follow-ups with issues** (opened 2026-09-29): 199 → #1705 (Mercado Livre's
  level trigger re-fires on the `nfe-totais` migration and uploads non-sale
  notes), 200 → #1706 (one shared identifier masker for the repo; §9's leak
  is already fixed here, by rule (c)) and 201 → #1707 (no cross-codebase
  guard stops two codebases from exporting the same function name, the
  `onNfeAprovada` collision class).
- **Recorded**: 203 (`add_invoice_data` exists, login-gated, unused).
- **Accepted, and visible in code**:
  - A held token-refresh lease on the LAST attempt rethrows like every other
    non-transport error, so that task ends after its four attempts with no
    aviso. The next re-drive covers it.
  - A rethrown `ShopeeApiError`'s `.message` embeds Shopee's sentence. PR 2's
    task function must not let the runtime log it whole: log the class and
    the token code, then rethrow.
  - Two slots approved at once are unverified. The slot rule is total, and the
    pre-read makes the loser `outra-nfe-anexada`.

**The window live checks — proposed, none run** (root `CLAUDE.md` rule 8; the
runbook is #1208, which PR 2 edits with these, in ADR 0013's phase order):

- **W1.** The shopee codebase grows to seventeen functions and five queues,
  with a second Firestore trigger, and the enqueuer-binding workaround now
  covers five queues for each `TASKS_INVOKER_SA` identity. The queue must exist
  before the trigger can enqueue.
- **W2.** Three Seller Centre and infra preconditions. The Invoice Setting is
  "Other" (else case 4 on every upload). The issuer CNPJ, UF and IE registered
  at Shopee equal the NF-e issuer's (else cases 1–3). The IP allow-list and
  static egress cover `upload_invoice_doc` and the two order reads.
- **W3.** After the legacy app is switched off, re-drive the
  approved-not-uploaded NF-e with `enviar:nfe`, `--dry-run` first. The
  pre-read makes an already-uploaded order `ja-enviado`, so the run is
  idempotent. Earlier is wrong: the legacy app is the live writer until then
  and may upload a different key.
- **W4.** Delete the legacy `nfe-shopee--updated-trigger` after the switch-off
  and before the first new-project upload. It cannot fire on this repo's
  documents, so it is not a dual run. What survives is the SHARED-PROVIDER
  hazard: the same order exists in both projects, and a legacy upload to it
  would make ours read `outra-nfe-anexada`.
- **W5.** The first real upload, on one watched order: the read-back shows OUR
  key, then the status, then the recheck, and `order_status` stays unchanged.
  It settles 186–192 and 195–198 as dated observations.
- **Deploy order**: functions (the queue before the trigger), then App Hosting
  (the route), then web (the aviso wording).

## 17. Premises this step refuted — do not re-assert them

- The multipart "transport gap": the package has carried multipart since
  `upload_image`.
- "Step 22 creates the lane and the tasks configuration": both already exist.
- "`CI gate (shopee)` runs the unit tests": they run in `ci.yml`'s `CI test`.
- An emulator round trip "to the failure stamp with the client faked at the
  transport boundary": the dispatched function runs outside the test's fetch
  kill-switch, so the round trip uses a path with NO Shopee call (a keyless
  sale proc ⇒ `xml-invalido` ⇒ aviso + stamp).
- "The queue's delivery delay": the wait is per task (`scheduleDelaySeconds`),
  and Mercado Livre sets none.
- "Just reached aprovada" as Mercado Livre's predicate: that one is level.
- A re-drive from step 4's `INVOICE_PENDING` backfill: step 4 sends no status
  filter.
- A carrier that needs no note keyed on a logistics channel id.
- Case 11 as "carrier only": it also answers a cancelled order.
- Case 7 after a lost 200: a same-order resend answers a different text.
- The key alone confirms the upload: `status` and `pending_reason` exist since
  2026-08-06.
- "`add_invoice_data` does not exist": it is login-gated.
- Guide 382's "working cURL".
- Guide 383's FAQ "unused in Brazil".
- An end-to-end sandbox path: an SG order's pedido is marked
  `bloquearEmissaoNFe`, and staging is homologação.
- "INVOICE_PENDING is undetectable from `get_order_detail`": that predates
  `invoice_data.status`.
- `apps/nfe/CLAUDE.md`'s `nfev4/{chave}`: the code's slot ids are
  `s<tpEmis>`.
- "Every approved tpAmb-1 NF-e of a Shopee pedido is the sale's" (§4).
- The legacy trigger as parity: it was update-only, had no delay and wrote
  nothing.
- "A frete of another integradora skips the upload": that is Mercado Livre's
  shipment-scoped reason, and Shopee's upload is per ORDER (§8).
- "The retry re-applies a no-op frete write and tries the resolve again" while
  the hook ran only when the frete was WRITTEN: a replay writes nothing, so
  that retry read nothing. It is true only with `estadoConfirmado` (§10).
- "The stamp failure's retry meets a zero-write replay": the stamp aborted, so
  the retry re-runs the whole execution (§11).
- The sanitizer's two-rule "fixpoint": a numeric key joined by `,` `_` `|` `:`
  `–` or an invisible character survived both rules, a DANFE-spaced
  alphanumeric key survived partly, and the cap could break idempotence (§9).
