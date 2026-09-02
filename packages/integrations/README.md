# packages/integrations/

Platform-neutral integration libraries: fetch-only, no Firestore, no Admin SDK. Each
is its own workspace package (`@delfrance/integrations-<channel>`), paired with an app
under `apps/` that holds the stateful half.

| Package              | Paired app           | Holds                                                                                            |
| -------------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| `nfe`                | `apps/nfe`           | NF-e 4.00 generation, XML signing, SEFAZ transport, DANFE. XSD→TS types are generated (ADR 0004) |
| `mercado-livre`      | `apps/mercado-livre` | OAuth, the 62-operation REST client, Zod wire schemas, the error taxonomy, pure ML↔ERP mappers   |
| `mercado-pago`       | `apps/mercado-pago`  | OAuth + payment API client                                                                       |
| `whatsapp-cloud-api` | `apps/whatsapp`      | Typed Graph client + webhook envelope schemas                                                    |
| `freight-br`         | `apps/melhor-envio`  | Melhor Envio: OAuth, quote, cart→checkout, label print, tracking                                 |

## ⚠️ These are libraries, not plugins

Only `nfe` (`InvoiceProvider`) and `mercado-pago` (`PaymentGateway`) implement a
contract from `@delfrance/core/plugins`. The rest implement nothing — their app
imports them directly.

That is the shape every integration here converged on, and two contracts were
**deleted** on the way:

- **`MarketplaceChannel`** (#815, [ADR 0015](../../apps/docs/src/content/docs/adr/0015-no-marketplace-mega-contract.md)) —
  its members were declared at ERP-orchestration altitude (`syncProducts`,
  `exportProduct(produtoId)`) while `packages/core` may not touch Firestore, so the
  one channel built against it implemented three of four required members as `throw`.
  Five packages here existed only to typecheck against it (`shopee`, `magalu`,
  `amazon-sp-api`, `facebook`, `loja-integrada`) with no importer anywhere; they were
  deleted with it. What a marketplace supports is now declared in
  `MARKETPLACE_TIPO_CAPS` (`@delfrance/schemas`).
- **`FreightProvider`** (#262) — a three-method shape could not express
  OAuth → quote → cart → checkout → label. Replaced by `FREIGHT_TIPO_CAPS`.

Adding a channel: read the `marketplace-integration` skill (marketplaces) or
`freight-integrations` (carriers). Adding a tax/invoice/payment plugin: the
`plugin-authoring` guide in `apps/docs`.
