---
title: 0015 — No marketplace mega-contract
description: Why the MarketplaceChannel plugin interface was deleted rather than amended, and what replaced it — a capability table, a normalized model module, and one App Hosting backend per channel.
---

## Context

`MarketplaceChannel` (`packages/core/src/plugins/index.ts`) was designed up front in
two commits on 2026-06-30 to reach parity across five sales channels that did not
exist yet. It declared **5 required and 20 optional members** plus ~25 supporting
types: `syncProducts`, `pullOrders`, `pushTracking`, `oauthFlow`, `pushPrice`,
`pushStock`, `exportProduct`, `importOrders`, six order-enrichment getters,
`fetchLabel`, `uploadInvoice`, category discovery, and an incident triple.

Mercado Livre was then built as the first real channel. It was supposed to validate
the contract. It **routed around** it.

By the time the ML port was code-complete, the measured state was:

- Exactly **one** member was ever invoked through the channel object anywhere in
  production: `oauthFlow.start`, in the OAuth connect route — and that member is a
  one-line wrapper around `buildAuthorizeUrl`, which the channel package already
  exported on its own.
- Three of the four **required** members (`syncProducts`, `pullOrders`,
  `pushTracking`) plus `oauthFlow.callback` were implemented as `throw`.
- `PluginRegistry.registerMarketplace` had **one caller in the repo's entire
  history**: its own unit test.
- The three incident members ML *did* implement were wired onto the channel object
  and then bypassed — the claims resolver imported the underlying function
  directly. To satisfy the signature it wrote `const ctx = {} as ChannelContext;`,
  fabricating a context because the callee ignored the argument.
- Roughly 25 supporting types had **zero importers** outside the plugin-sdk barrel
  and two test files.
- Five channel packages (`shopee`, `magalu`, `amazon-sp-api`, `facebook`,
  `loja-integrada`) existed **only** to typecheck against it. Each was ~44 lines in
  which every member threw. None had an importer anywhere.

Two modules documented their refusal in code. The price sync recorded that the
contract's `MinorUnits` (integer centavos) "does not fit the reais floats the produto
price tables store and ML's wire format speaks". The NF-e upload recorded that
`uploadInvoice` "deliberately stays uncalled".

Severity, stated fairly: most of this was **unreached type surface**, not broken
production code. It still mattered, because validating the contract was the entire
reason for doing Mercado Livre first — and the plugin-authoring guide went on
instructing authors to implement four throwing members and register them into a
registry nothing read.

## The root cause

The contract was not too small. It was **at the wrong altitude**.

`packages/core` is storage- and secret-agnostic by design, so a contract living
there can only describe *provider-facing* operations: take a token, call an HTTP
endpoint, return a typed value. But almost every member declared was an *ERP-side
orchestration*. `syncProducts` means "walk the catalogue, diff it, write link
documents". `exportProduct(produtoId)` means "load the produto graph, upload the
photos, build the payload, write back". `uploadInvoice` means "read the NF-e, check
the shipment state, post, stamp the result". Each needs Firestore, Storage and a
token refresher, none of which core may import.

So Mercado Livre implemented all of it in `apps/mercado-livre` — where it belongs —
and left stubs behind in the shape the contract demanded. No amendment moves that:
the members cannot be implemented where the contract puts them.

Three further defects followed from the same altitude error, and each is worth
recording because they will recur in any replacement:

- **`MinorUnits`** — integer centavos, chosen for float safety, against an ERP whose
  price tables and whose providers' wires are both reais decimals. There was no
  correct place to convert, so the price and stock members were simply not used.
- **`LabelResult.data: string`** — ML returns a **ZIP** of bytes for both `pdf` and
  `zpl2`. A string field cannot carry it.
- **`ChannelContext.accessToken`** — a snapshot. A sweep page, a mass-import
  dispatch or any resumable job can outlive the grant it captured.

## Decision

**Delete `MarketplaceChannel`**, its supporting types, the marketplace half of
`PluginRegistry`, and the five throw-only scaffold packages. Replace it with three
things, each of which has real callers:

1. **`MARKETPLACE_TIPO_CAPS`** (`packages/schemas/src/shared/marketplace.ts`) — a
   `Record<MarketplaceTipo, MarketplaceCapabilities>` declaring what each channel
   supports: auth style, whether it signs its webhooks, variations, size charts,
   virtual kits, the stock write protocol and its batch size, label mode, post-sale
   surfaces. Because it is a `Record` over the tipo union, **adding a marketplace
   tipo without a caps row is a compile error**.

   Capability fields are **three-valued** — `'sim' | 'nao' | 'desconhecido'`. Five
   of the six rows are channels nobody has researched, and a boolean cannot say
   "nobody has checked"; it can only say `false`, which reads as an answer. Putting
   an unverified claim into a type is the failure this ADR exists to undo.

2. **`@delfrance/core/marketplace`** — the normalized data model, in **reais**: the
   incident types Mercado Livre genuinely implements, and the researched order/
   address/tracking/charges shapes for a future shared order importer. That second
   group is explicitly labelled as having **no implementation**, because keeping the
   cross-channel research is worth ~90 lines of types while duplicating the live ML
   mapper to satisfy it is not.

3. **One App Hosting backend per channel** (`apps/<channel>`), built on the shared
   seams that were extracted *because a second consumer needed them* —
   `defineNotificationPipeline`, `createOauthStateStore`, the read cache,
   `findOrCreateCliente` — plus the `marketplace-integration` skill, which carries
   the procedure.

## Why deletion rather than amendment

The repo had already made this exact call once. Commit `03cc0881` removed the whole
`FreightProvider` contract when the freight domain proved a three-method registry
shape could not express OAuth → quote → cart → checkout → label. Freight now runs on
`FREIGHT_TIPO_CAPS` plus per-provider modules, and that capability table has
**thirteen consuming files** against `MarketplaceChannel`'s one.

The alternative — repairing the members to provider-id altitude, switching to reais,
fixing the label type, adding a token thunk — was considered and rejected. It would
have produced roughly a dozen wrapper members whose only caller was a channel that
does not exist yet: the same unreached surface, one round later.

## Consequences

- A second channel is authored against a capability row and a procedure, not an
  interface. Nothing to bypass, because nothing claims to orchestrate.
- `apps/web` can ask what a channel supports without holding a server-side object —
  which the old contract made impossible, and which is why the `/canais` screen was
  showing a plugin-package name in place of a status.
- The ERP-side sharing that a second marketplace genuinely needs (order → pedido
  upsert, the stock plan) is **not** solved here. It is deferred deliberately: the
  precedent is `findOrCreateCliente`, promoted out of `apps/mercado-livre` once a
  second caller existed and its cascade defect was understood. Extracting before
  that point is how this ADR's subject was created.
- The invariant is enforced by
  `packages/config-eslint/rules/marketplace-contract-removed.test.js`, because every
  part of it is silent when violated: re-adding the interface typechecks, lints,
  builds and passes every suite.

## Status

Accepted.
