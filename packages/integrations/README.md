# packages/integrations/

Platform-neutral integration libraries: fetch-only, no Firestore, no Admin SDK. Each
is its own workspace package (`@delfrance/integrations-<channel>`), paired with an app
under `apps/` that holds the stateful half.

| Package              | Paired app           | Holds                                                                                                |
| -------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| `nfe`                | `apps/nfe`           | NF-e 4.00 generation, XML signing, SEFAZ transport, DANFE. XSD→TS types are generated (ADR 0004)     |
| `mercado-livre`      | `apps/mercado-livre` | OAuth, the 62-operation REST client, Zod wire schemas, the error taxonomy, pure ML↔ERP mappers       |
| `mercado-pago`       | `apps/mercado-pago`  | OAuth, the REST client, response schemas, the `mpPaymentToPagamento` mapper                          |
| `whatsapp-cloud-api` | `apps/whatsapp`      | Typed Graph client + webhook envelope schemas                                                        |
| `freight-br`         | `apps/melhor-envio`  | Melhor Envio: OAuth, quote, cart→checkout, label print, tracking                                     |
| `shopee`             | `apps/shopee`        | Shopee Open Platform: the HMAC request signature, hosts, consent URL + token endpoints, wire schemas |

## ⚠️ These are libraries, not plugins

Only `nfe` (`InvoiceProvider`) implements a contract from `@delfrance/core/plugins`.
The rest implement nothing — their app imports them directly.

That is the shape every integration here converged on, and **three** contracts were
deleted on the way:

- **`MarketplaceChannel`** (#815, [ADR 0015](../../apps/docs/src/content/docs/adr/0015-no-marketplace-mega-contract.md)) —
  its members were declared at ERP-orchestration altitude (`syncProducts`,
  `exportProduct(produtoId)`) while `packages/core` may not touch Firestore, so the
  one channel built against it implemented three of four required members as `throw`.
  Five packages here existed only to typecheck against it (`shopee`, `magalu`,
  `amazon-sp-api`, `facebook`, `loja-integrada`) with no importer anywhere; they were
  deleted with it. What a marketplace supports is now declared in
  `MARKETPLACE_TIPO_CAPS` (`@delfrance/schemas`).
  ⚠️ **Four of those five stay deleted; `shopee` came back as a REAL package.** It is
  the row in the table above — a fetch-only library describing Shopee's wire protocol,
  with no `MarketplaceChannel`, no plugin registration and no Firestore. That is the
  ADR-0015 shape, and the opposite of the scaffold that was deleted.
  `removed-plugin-contracts.test.js` asserts the absence of the other four and the
  SHAPE of this one.
- **`PaymentGateway`** (#1429) — all three members threw, `registerPayment` had one
  caller (its own unit test), and the one live consumer was a permanently disabled
  button. Its `webhook` had already shipped OUTSIDE the contract, in
  `apps/mercado-pago` on the shared `defineNotificationPipeline`; its `createCharge`
  mis-described the real write (a Checkout Pro _preference_, which returns a link and
  an expiry, not a charge id and a status); its `refund` had no precedent in this repo
  or the legacy one. ⚠️ No capability table replaced it: `TIPO_INTEGRACAO_PGTO` is a
  single literal, so a table would have exactly one row. The procedure for a second
  provider — including when to add that table — is on `tipoIntegracaoPgtoSchema` in
  `@delfrance/schemas`.
- **`FreightProvider`** (#262) — a three-method shape could not express
  OAuth → quote → cart → checkout → label. Replaced by `FREIGHT_TIPO_CAPS`.

Adding a channel: read the `marketplace-integration` skill (marketplaces) or
`freight-integrations` (carriers). Adding a payment provider:
`tipoIntegracaoPgtoSchema` in `@delfrance/schemas`. Adding a tax/invoice plugin: the
`plugin-authoring` guide in `apps/docs`.
