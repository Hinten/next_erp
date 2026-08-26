import { describe, expect, it } from 'vitest';
import { gitGrep } from './lib/repo-scan.js';

/**
 * Every source file that runs a Firestore transaction is inventoried here, with
 * how that transaction survives losing a race. Add a file that mentions
 * `runTransaction` and this test fails until you list it and say which class you
 * are in.
 *
 * ## Why this is a test and not an ESLint rule (#776)
 *
 * #776 asked for `delfrance/firestore-tx-fresh-reads`, catching "a decision
 * computed OUTSIDE `db.runTransaction` and applied INSIDE it" — the stale-closure
 * shape that produced O12/O13/O14 in the Mercado Livre port audit. It proposed
 * three checks. All three were implemented against the repo and measured, and all
 * three fail:
 *
 * **(a) "every `tx.set/update/delete` must be preceded by a `tx.get` of that same
 * ref"** — fires on 19 of 48 call sites (36 write statements) with **zero** true
 * positives. It fails for a reason worth writing down: this repo's OWN lint rule
 * defeats it. `delfrance/no-inline-admin-collection` bans raw `.collection()` /
 * `.doc()`, so every ref goes through a schema collection handle and is built
 * inline AT THE WRITE SITE (`X.docRef(db, ctx, id)`). Of the 36 flagged writes 13
 * refs are inline and 13 are member expressions (`d.ref`, `bundle.orderMlRef`) —
 * ~72% are structurally incomparable to their read. Six more sites read a whole
 * collection with `tx.get(<query>)` and write individual docs inside it, where no
 * syntactic "same ref" can ever exist; five pass `tx` across a function boundary
 * (`aplicarPlano(db, tx, …)`, `sobrevivem(tx)` — the latter an injected parameter,
 * statically unanalysable), which hides reads AND writes in both directions.
 *
 * **(b) "no `await` on a non-`tx` expression inside the callback"** — fires on 8
 * of 48 sites, also with zero true positives. There is not one `await fetch(…)`,
 * `await someApi(…)` or `await ref.get()` inside any transaction callback in this
 * repo; HTTP round-trips already happen before the transaction by convention.
 * Every flagged `await` is a `Promise.all` over `tx.get`s, a `.then()` on a
 * `tx.get`, or a helper taking `tx` — i.e. the rule fires only on the four correct
 * ways to do transactional reads.
 *
 * **(c) the real target, one-hop dataflow** — cannot separate the issue's own
 * fixture set. Measured against the pre-#791 source (`git show
 * feef99f7^:apps/mercado-livre/lib/marketplace/pedidos/orderImport.ts`), the two sites it
 * MUST fire on and the two it must stay quiet on are indistinguishable to it:
 * `:628` (must fire) and `:676` (must stay quiet) both build their write from
 * `mappedFrete`, a binding declared before the transaction; `:751` (must fire) and
 * `:785` (must stay quiet) both write `lastMarketplaceUpdate: nowUs`, likewise.
 * What separates each pair is semantic — `:676` COMPARES `mappedFrete`'s watermark
 * against the tx-fresh value and returns; `:785` recomputes the decision from
 * `oldPagamentos` and `raw.valorCobrado`. Deciding that means recognising "a guard
 * exists and covers this binding", and telling a provider payload apart from a
 * clock or an id. No AST or type-level analysis does either.
 *
 * A heuristic proxy was also considered — "a callback writing a watermark field
 * must contain a relational comparison over a `tx.get`-derived value". It passes
 * all four fixtures, but by coincidence of shape: any unrelated comparison
 * satisfies it and a legitimately guard-free write trips it. A guard with false
 * positives gets satisfied rather than obeyed, which defeats it (the same
 * reasoning as `reserva-arithmetic-inventory.test.js`).
 *
 * So this asserts the one thing that IS mechanically checkable — the SET of files
 * involved — and makes the classification a reviewed artifact. Same shape as
 * `reserva-arithmetic-inventory.test.js` (#931 hit this identical wall),
 * `env-secrets-no-copy.test.js` and `defaultQuery.indexes.test.ts`: failing the
 * test fails CI exactly like a lint error would.
 *
 * ⚠️ Scoped to `runTransaction`. The NON-transactional shape (`.update()` /
 * `merge()` on a ref read earlier in the same function, with no `lastUpdateTime`
 * precondition) gets the same verdict for the same reasons — read-then-update is
 * ubiquitous and usually correct, so a rule there is even less viable — but its
 * sweep stays on #839 §2, which carries its own seed list.
 *
 * ## The invariant being protected
 *
 * Firestore's OCC retries the callback but does **not** re-derive anything
 * captured in the closure, so a value read before an `await` is re-applied
 * verbatim over the winner. A second writer is always plausible here: provider
 * webhooks arrive out of order, Cloud Tasks retries re-drive payloads,
 * and the notification sweep re-drives hours-old payloads through the same
 * handler as a fresh task. See root `CLAUDE.md` Critical rule 7 and ADR 0011.
 */

/**
 * The BARE WORD, deliberately — not `runTransaction\(`.
 *
 * ⚠️ Two call sites carry a generic type argument and are invisible to a pattern
 * that demands the paren: `apps/web/lib/mercado-livre/listingDraft.ts`
 * (`runTransaction<DraftOutcome>(db, …)`) and `apps/nfe/lib/nfe/orchestrator/emitir.ts`
 * (`fs.runTransaction<TxOutcome>(…)`). A guard that silently skips two files is
 * worse than no guard, so the pattern matches the identifier and the inventory
 * absorbs the resulting comment-only mentions as explicit entries.
 */
const PATTERN = 'runTransaction';

/**
 * Source only. Tests, e2e specs and seed fixtures are excluded: they carry ~30
 * mock `runTransaction` definitions plus deliberate competitor writers that exist
 * precisely to lose a race, and inventorying them would be noise that hides a real
 * new call site.
 */
const PATHSPECS = [
  '*.ts',
  '*.tsx',
  '*.mjs',
  ':(exclude)*.test.ts',
  ':(exclude)*.test.tsx',
  ':(exclude)*.spec.ts',
  ':(exclude)apps/web/e2e/*',
  ':(exclude)tools/test-fixtures/*',
  ':(exclude)packages/config-eslint/rules/*',
];

/**
 * Path → how that file's transaction(s) survive losing a race. Grouped by class;
 * the grouping IS the audit #776 and #824 asked for.
 *
 *   A — self-contained: every input to the write is re-derived from a `tx.get`
 *       inside the callback. OCC alone is sufficient.
 *   B — a decision or payload computed OUTSIDE the callback reaches the write.
 *       Safe only with a named guard, so the entry names it.
 *   C — network I/O sits between the outside read and the transaction, which is B
 *       with a much wider window.
 *
 * A file whose sites span two classes is filed under the STRICTER one (B/C), so
 * an audit of the guards cannot skim past it.
 *
 * Tier numbers are ADR 0011's: 0 make the race impossible, 1 native precondition,
 * 2 event-clock watermark, 3 tell the human.
 */
const INVENTARIO = {
  // ---- A — every input re-derived from a `tx.get` inside the callback -----
  'apps/functions/src/estoques/aplicarBalanco.ts':
    'Two sites. `:417` reads every target with `tx.getAll` and plans against those snapshots; the shard counter rides `FieldValue.increment` (tier 0). `:601` re-reads the balanço and re-checks `podeFinalizarBalanco` on the fresh doc before claiming `finalizando`.',
  'apps/nfe/lib/nfe/orchestrator/audit.ts':
    '`:348` re-reads the NF-e and refuses to leave a FINAL estado for a different one, decided on the fresh snapshot.',
  'apps/nfe/lib/nfe/orchestrator/cancelar.ts':
    '`:183` re-reads the NF-e and returns when a concurrent cancel already landed.',
  'apps/nfe/lib/nfe/orchestrator/emitir.ts':
    'Two sites, both re-reading inside. `:343` (`runTransaction<TxOutcome>` — no paren after the identifier) reads the NF-e + the config and decides the lote stamp on them; `:562` reads the config and `Promise.all`s a `tx.get` over every NF-e in the lote before writing any of them.',
  'apps/web/lib/nfe/nfeConfigPort.ts':
    'Class A BY CONSTRUCTION: the port hands `nextFor(current)` the `tx.get` snapshot, so the caller cannot compute its patch anywhere else. `nextFor` throws to abort on a detected conflict (tier 3 — the browser SDK has no precondition). #1005.',
  'apps/web/lib/mercado-livre/listingPort.ts':
    'Same port shape — the patch builder runs on the `tx.get` snapshot inside the callback.',
  'apps/web/lib/mercado-livre/listingDraft.ts':
    "Two sites, both `runTransaction<T>` (generic — invisible to a `runTransaction\\(` pattern). `createListingDraft`\u2019s `'primeiro'` path reads the draft and only writes when it is absent, decided on that read; its `'adicional'` path runs no transaction at all (a fresh auto-id has nothing to check against). `removeListingDraft` re-derives \u201cnever published\u201d from the `tx.get` snapshot rather than from the link the button was rendered with, so a publish landing inside the confirm window aborts the delete instead of orphaning a live listing.",
  'apps/web/lib/pedidos/clientPort.ts':
    'Two sites, both class A by construction. `:97` calls `apply(current)` on the `tx.get` snapshot; `:125` reads every path up front (JS SDK: all reads before the first write) and calls `apply(docs)` on that map. The port shape is what makes a stale closure unrepresentable.',
  'apps/web/lib/pedidos/createPedido.ts':
    'Counter read-increment-write plus the pedido create, one transaction. The next número is derived from the counter doc read inside; `FieldValue.increment` cannot return the new value, so the RMW is required (see `packages/schemas/src/counter.ts`).',
  'apps/web/app/(app)/configuracoes/ia/_components/ConfigIaPanel.tsx':
    'Tier 3. Re-reads the config, compares it against what the form was seeded with and throws `ConfigIaConflictError` on divergence; the write is `{...fresh, ...next}`, so untouched fields come from the tx-fresh doc.',
  'apps/mercado-livre/lib/marketplace/pedidos/orderImport.ts':
    'Five sites, all re-deriving from `tx.get`. The #1087 estado-PROMOTION arm rides the pago site and stays class A — the ladder position, the target estado and the ML-order-clock comparison all come off the same `tx.get` snapshot, and the pago re-check it falls through to is evaluated against the promoted value rather than the stale one. `:654` / `:752` write the cliente / endereço outer-ref only when the fresh doc still lacks it; `applyFreteSemEnvioStep` seeds a `freteInicial` for an order with no Mercado Envios shipment and is class A by construction — BOTH its guards (block already present, endereço not yet resolved) and both written values come from the `tx.get` snapshot, and it is create-only, so a concurrent writer that got there first simply wins; the divergence site runs a READ PHASE then decides the verdict on tx-fresh inputs only (its `veredito` is reset per attempt — legacy poisoned retries with that flag); the pago site re-derives the actually-missing pagamento set from its own reads, so the pre-fetched candidate pool may safely be a superset. The two sites #776 cited as broken were fixed here by #791.',
  'apps/mercado-livre/lib/marketplace/pedidos/orderPedidoTx.ts':
    'One transaction covering every order of a pack, with an explicit READ PHASE (`packRef`, each standalone pedido, `orderMlRef`, `pagRef`) before any write. The orderML merge compares the stored `last_updated` (ms) against the incoming one, both from the tx-fresh read — the docblock at `:487` says outright not to hoist that read out.',
  'apps/mercado-livre/lib/marketplace/importacao/importTaxonomia.ts':
    '`:191` re-reads the grupo inside and merges the variações onto the tx-fresh document, so a Flutter session’s already-loaded array cannot win.',
  'packages/data/src/admin/oauthState/store.ts':
    '`:99` redeems the single-use OAuth nonce: every branch is re-derived from the `tx.get` snapshot, so two callbacks racing one nonce contend on OCC and the loser is REJECTED — the intended outcome here.',
  'apps/whatsapp/lib/whatsapp/outbound.ts':
    'Two sites. `:277` is tier 0 — `create` + `delete` with no read at all, where `create` IS the precondition (`ALREADY_EXISTS` is caught and treated as "a redelivery re-anchored this send"). `:380` claims the mensagem by re-reading it and re-checking `mid` + `isClaimable` on the fresh doc.',

  // ---- B/C — outside input reaches the write; the guard is named ----------
  // ⚠️ A file with sites in BOTH classes is filed HERE, never under A. The
  // grouping is what an auditor skims, so the failure that costs is a class-B
  // guard sitting in the A block where a re-check never looks; over-inclusion
  // costs only a re-read.
  'apps/functions/src/estoques/sincronizarEstoquePedido.ts':
    'MIXED. `:707` is class A — it re-extracts the pedido from its own `tx.get` and plans from that, so an OCC retry re-derives; the estoque deltas go through `tx.getAll` + `Math.max(stored, agora)` in `aplicarPlano`. `:997` is class **B** — the plano comes from the DELETED pedido’s `before` snapshot — guarded by re-reading the pedido and bailing if it reappeared, over tier-0 deltas.',
  'apps/whatsapp/lib/whatsapp/credentialStore.ts':
    'Two sites. `:113` is the only **tier 1 INSIDE a transaction**: the registro pin write-back rides `tx.update(currentRef, data, { lastUpdateTime: options.expectedVersion })`, so a token stored meanwhile fails `FAILED_PRECONDITION` instead of being reverted (#1004). ⚠️ Tier 1 outside one also exists and is arguably the better template — `import.ts:341` and `publish.ts:631` both do `ref.update(patch, { lastUpdateTime })`; they carry no `runTransaction`, so they are out of THIS inventory (see #839 §2). `:158` is a purge — reads the whole lineage with one `tx.get(collRef)` and deletes it.',
  'apps/melhor-envio/lib/freight/tokenStore.ts':
    'C — the token comes from an OAuth round-trip before the transaction. Reads the whole lineage with `tx.get(collRef)`, writes the `current` doc and prunes Flutter’s auto-id siblings. Since #966 the write is GUARDED: tier 2, update-if-newer in **ms** on `expirationDate`, re-derived from the callback’s own `tx.get` so an OCC retry re-decides instead of replaying the captured patch — a token that is not strictly newer is dropped and the STORED one is returned, which is why `save()` returns a token at all (the loser of a write race walks away with the winner’s credential instead of an error). ⚠️ The comparison is against the `current` doc ONLY, never the strays: a legacy auto-id doc carrying a bogus far-future `expirationDate` would otherwise reject every write forever — ADR 0011’s wrong-way default, the shape that made the legacy ML shipment guard reject everything. Strays are pruned in both branches. ⚠️ Tier 2 rather than the tier 1 this entry used to promise: the guard has to live behind the `TokenStore` port in `@delfrance/integrations-freight-br`, which is deliberately `firebase-admin`-free, so a `lastUpdateTime` cannot cross it without leaking a `Timestamp` or inventing an opaque version wrapper plus a conflict error class; tier 2 rides the transaction that already exists here. The clock only orders two credentials that are each valid ~30 days, so instance skew cannot pick a harmful winner. The `force` option bypasses the guard for the authorization-code flow — a human who just re-consented always wins.',
  'apps/mercado-pago/lib/payments/credentialStore.ts':
    'C — same lineage-collapse shape as the melhor-envio store, same "one wins" refresh contract.',
  'apps/mercado-livre/lib/marketplace/frete/intFreteSync.ts':
    'C — an Eventarc redelivery replays the ORIGINAL CloudEvent. Tier 2 in **ms**: the lookup reads through `tx`, `coerceToMillis(data.ultimaModificacao)` is compared against the event time, and the winning write advances the watermark. The create path is tier 0 (`tx.create`).',
  'apps/mercado-livre/lib/marketplace/pedidos/orderPaymentImport.ts':
    'C — three ML API calls precede the transaction. The #1087 bootstrap guards run BEFORE it and add no writes: they only decide whether the caller may ask the `orders_v2` topic for a pedido, and the pedido itself is created by `orderPedidoTx.ts` under its own `tx.create`. The #1087 RELEASE arm is a second estado write and stays class C at the same tier: the stored estado, every sibling pagamento and the approved-payment check all come off this transaction reads, and it is scoped to the pre-payment estados the ML bootstrap creates. Tier 2 in **µs**: reads the pagamento, the pedido and the whole pagamento collection, then drops with `skipped: "stale"` unless the incoming `ultimaModificacao` is strictly newer than the stored one. The estado advance is computed only inside the write branch.',
  'apps/mercado-livre/lib/marketplace/pedidos/orderShipmentImport.ts':
    'C — same shape for shipments. Tier 2 in **µs**, null-tolerant the OPPOSITE way from the payment import (a null stored OR mapped stamp skips), which the file docblock spells out; the pedido stamp is the monotonic `maiorUs(stored, now)`.',
  'apps/mercado-livre/lib/marketplace/nfe/nfeUpload.ts':
    'C — stamps `freteInicial.estado = "error"` after an ML upload attempt. Re-reads the pedido and takes the new stamp from `maiorUsNfe(coerceToMicros(pedido.ultimaModificacao), nowUs)`, so it can only move forward (**µs**).',
  'apps/mercado-livre/lib/marketplace/estoque/estoqueSend.ts':
    'C — one site (`podarVariacoesFantasma`, #707), and the whole decision straddles a network call: ML’s live `variations[].id` set comes from the verification `GET /items/{id}` the terminal 4xx branch just made. Guard: the STORED half is re-read with `tx.get(familyMemberQuery(...))` INSIDE the callback and `planejarPoda` runs on that snapshot, so the member docs join the read set and a concurrent import or publish rewriting a member’s `id` aborts this attempt instead of losing to it. Losing here is the expensive direction — it would mark a LIVE variation `closed`, which `buildSendTasks` then skips, silently stopping that variation’s stock. The ML half is deliberately NOT re-derived: it cannot be read inside a transaction, and it is exactly one round trip old. `planejarPoda`’s already-`closed` rung makes a replay write nothing (tier 0 by idempotence). The file’s OTHER writes are not transactional and stay out of scope: the link writebacks go through `mergeIfExists`, and the User-Products member path delegates its fold to `itemsStatusSync.applyMemberStatusAndFold`, which carries its own entry above.',
  'apps/mercado-livre/lib/marketplace/anuncios/itemsStatusSync.ts':
    'C — a `GET /items/{id}` precedes the transaction, and its `status` reaches the write. Guard for THAT value: it is re-fetched from ML at processing time rather than taken from the notification payload, so two out-of-order deliveries for the same item both write the live state. The transaction exists for a different race (#1142): a User-Products FAMILY’s `estado` is a FOLD over its members, so the sibling read MUST sit in the read set — with `maxConcurrentDispatches: 3` and ML fanning out one notification per member item, two members of one family are processed at once, and a fold decided against a stale sibling parks the family at `estado "c"` while another member is live. That drops the conta from `integracoesComProduto`, the anchor pre-filter both sweeps open with, silently. Everything else is re-derived inside: `currentEstado`, the member’s stored status and the denorm arrays all come from the callback’s own `tx.get`, never from the `resolveLink` snapshot captured before the ML round trip. The parent link write and the denorm write share the transaction, so the denorm-first ordering `applyItemStatusToLink` needs does not apply here — there is no window in which one landed and the other did not.',
  'apps/mercado-livre/lib/marketplace/mass-import/massImport.ts':
    'One site (`finalizeMassImportJob`), class **B** and the reason it exists: `status` has TWO writers that do not coordinate — the task handler stamping `completed`/`failed` at the end of a dispatch, and the `importar-todos/cancelar` route stamping `cancelled` at any moment. The decision to finalize is made outside the callback, so the guard is named and explicit: `status` (still `running`?) and `integracaoId` (the ownership check) are BOTH re-derived from the `tx.get` snapshot, and a concurrent winner turns the call into a `not-running` no-op instead of a clobber. Nothing else in the patch comes from the read. It was three unguarded `merge()`s before the cancel action existed.',
  'apps/mercado-livre/lib/marketplace/anuncios/integracoesComProduto.ts':
    'Tier 0 — the write is `FieldValue.arrayRemove(integracaoId)`, commutative, so there is no loser. The read set is a DIFFERENT collection by design: `sobrevivem(tx)` re-derives membership from its own `tx.get` and aborts the removal when a link survives.',
  'apps/web/lib/checkout/saveCheckout.ts':
    'Two sites; phase 2 is class B and was the #1005 fix. Both re-read the pedido and re-derive their estado decision from that snapshot rather than from what phase 1 saw — the phases are separated by an `await`, so the pedido can move between them.',
  'packages/data/src/admin/pedidoReconcile.ts':
    'Two sites (`:180`, `:288`). B by necessity — the browser SDK cannot read a query inside a transaction, so the ADMIN copy re-reads the whole pagamento collection with `tx.get` and re-derives `valorPago` from it; the estado transition is decided on the tx-fresh pedido.',
  'packages/ui/src/object/saveRecord.ts':
    'The ERP’s universal ObjectView save. Tier 3: re-reads the doc and raises `RecordConflictError` when a field the operator touched changed since the form was seeded (#1006). ⚠️ The `tx.get` sits inside `if (guarded)`, so a create — and an update that opted out via `disableConcurrencyGuard` — commits with an empty read set; that is correct, because OCC with nothing to compare only buys latency.',
  'apps/mercado-livre/lib/marketplace/claims/claimImport.ts':
    'C — the whole claim, its reason and its messages are fetched from ML before the transaction, so the conversa patch is built entirely from outside input. Tier 2 in **ms** on `ultimaModificacaoIntegracao` (`claim.last_updated`), re-read with `tx.get`. ⚠️ The gate is `>=`, not `>`: ML does not always move `last_updated` when a seller’s `available_actions` drain away, and a strict comparison would refuse the close forever and leave an open composer on a dead claim. It replaced an `ultima_modificacao` check — a MIXED clock operators also write, so an edited conversa looked permanently newer than the wire — plus an out-of-band close that could only ever CLOSE, never reopen. Both directions now ride the one guarded patch. The mensagens are written OUTSIDE it: keyed by ML id, they only add history.',
  'apps/mercado-livre/lib/marketplace/chat/orderMessageImport.ts':
    'C — two ML reads (the by-id message, then the whole paged pack thread) precede the transaction, so the conversa patch is built entirely from outside input. Tier 2 in **ms**, same field and same shape as the WhatsApp inbound guard below: re-reads the conversa with `tx.get` and drops the patch when the incoming `ultimaModificacaoIntegracao` is strictly older than the stored one. ⚠️ The watermark is `max(newest message, conversation_status.status_date)`, NOT the message time alone — a thread going `blocked` usually carries no new message, and a message-only clock would let a stale `active` snapshot land afterwards and reopen a closed thread (#817 by another road). The mensagens are written OUTSIDE the transaction on purpose: keyed by ML id, they can only add history, never contradict whatever the newer snapshot decided.',
  'apps/whatsapp/lib/whatsapp/processMessages.ts':
    'Two sites, both tier 2 in **ms**. `:342` upserts the conversa behind the `ultimaModificacaoIntegracao` out-of-order guard; `:436` bumps `ultima_modificacao` only forwards (`current >= incoming` returns). Both re-read the conversa and compare against that snapshot.',
  'apps/functions/src/estoques/aplicarEstoque.ts':
    'Tier 0 on the hot path (a read-free batch of `increment` + `maximum`/`minimum`) — the ONE transaction is the balanço at `:172`, because an absolute set has a signed delta only relative to the value it replaces. `planMovimentacao` runs INSIDE the callback on the `tx.get` result, so a retry re-derives the delta against the winner. `:43` is the localização touch-up, decided on its own read.',

  // ---- Domain port — not Firestore ---------------------------------------
  'packages/integrations/nfe/src/numeracao/index.ts':
    'Four sites on the `NFeConfigStore` PORT, not Firestore: the "ref" is a `filialId` string and `tx.get`/`tx.set` are the port’s own methods. Every one reads the config inside and derives the next nNF / idLote from it, which is what makes the sequence gap-free.',
  'packages/integrations/nfe/src/numeracao/firestore-adapter.ts':
    'The Firestore binding for that port. `:125` wraps `fs.runTransaction` and exposes `get`/`set` closing over the same `refFor(filialId)`; the retry loop around it is the port’s, not Firestore’s.',

  // ---- Test harness -------------------------------------------------------
  'packages/data/src/testing/occTransaction.ts':
    'The OCC harness both SDK shapes adapt onto (#1003) — it FORCES a retry so a test can prove the callback re-derives instead of replaying a stale closure. Not a call site.',

  // ---- Comment only — no transaction here ---------------------------------
  'apps/functions/src/pedidos/reconciliarPagamentoPedido.ts':
    'Comment only — explains why the client sums pagamentos outside the transaction and the admin copy does not.',
  'apps/mercado-livre/lib/marketplace/core/tokenStore.ts':
    'Comment only — records why the token refresh is NOT a transaction (a retried callback would re-fire the single-use refresh_token).',
  'apps/mercado-pago/lib/payments/mercadoPago.ts':
    'Comment only — same reasoning for the Mercado Pago refresh.',
  'packages/integrations/freight-br/src/melhor-envio/token-store.ts':
    'Comment only, and not Firestore at all — this package is `firebase-admin`-free and talks to the injected `TokenStore` port. The header records the same reasoning as the two above (a retried callback would re-fire the non-idempotent ME refresh grant) plus why refresh-token rotation is no longer load-bearing: the guarding happens in the port implementation, `apps/melhor-envio/lib/freight/tokenStore.ts`, listed above.',
  'packages/data/src/admin/cache/readCache.ts':
    'Comment only — rule 1 of the read cache: never cache anything read inside a transaction, because a `tx.get` is a lock.',
  'packages/data/src/pedido/usecases.ts':
    'Comment only — notes the JS SDK cannot read a query inside a transaction.',
  'packages/schemas/src/counter.ts':
    'Comment only — documents why the counter allocation is a client read-increment-write (`increment` cannot return the new value).',
};

/** Files matching the pattern, over the index + untracked-but-not-ignored. */
function ficheirosComTransacao() {
  return gitGrep({ patterns: PATTERN, pathspecs: PATHSPECS, mode: 'extended' });
}

describe('every Firestore transaction is inventoried with its race class', () => {
  it('has no UNLISTED file mentioning runTransaction', () => {
    const naoListados = ficheirosComTransacao().filter((f) => !(f in INVENTARIO));
    expect(
      naoListados,
      [
        'These files mention `runTransaction` and are not in INVENTARIO. Firestore’s OCC',
        'retries the callback but does NOT re-derive anything captured in the closure, so a',
        'value read before an `await` is re-applied verbatim over the winner. A new',
        'transaction has to state which class it is in:',
        '',
        '  - A: every input to the write re-derived from a `tx.get` in the callback -> say so',
        '  - B: a decision/payload computed OUTSIDE reaches the write -> NAME the guard',
        '  - C: network I/O between the outside read and the tx -> same, and say it is C',
        '',
        'A class-B/C site with no guard is a finding, not an inventory line — fix it, or file',
        'it against #839. Name the UNIT on any watermark compare (µs vs ms: a cross-unit',
        'comparison is a guard that never fires). See root CLAUDE.md rule 7 + ADR 0011.',
        '',
        'Then add the file here with that one-liner. Offending files:',
        ...naoListados.map((f) => `  - ${f}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('has no STALE entry for a file that no longer mentions it', () => {
    const atuais = new Set(ficheirosComTransacao());
    const obsoletos = Object.keys(INVENTARIO).filter((f) => !atuais.has(f));
    expect(
      obsoletos,
      [
        'These INVENTARIO entries no longer match anything — the file was renamed, deleted,',
        'or stopped running a transaction. Remove them, so the inventory keeps being read as',
        'current rather than decoration:',
        ...obsoletos.map((f) => `  - ${f}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('⚠️ matches a call carrying a generic type argument', () => {
    // `runTransaction\(` would silently skip `listingDraft.ts` and one of the two
    // sites in `emitir.ts`, and a guard that skips two files unannounced is worse
    // than no guard at all.
    const regex = new RegExp(PATTERN);
    expect(
      regex.test('const outcome = await runTransaction<DraftOutcome>(db, async (tx) => {'),
    ).toBe(true);
    expect(regex.test('return fs.runTransaction<TxOutcome>(async (tx) => {')).toBe(true);
    expect(regex.test('await db.runTransaction(async (tx) => {')).toBe(true);
  });
});
