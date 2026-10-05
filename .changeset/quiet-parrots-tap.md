---
"@delfrance/core": minor
"@delfrance/integrations-nfe": minor
---

Delete the plugin system: `TaxProvider`, `InvoiceProvider`, `PluginRegistry` and `@delfrance/plugin-sdk` (#1444).

`packages/core/src/plugins` and the `@delfrance/plugin-sdk` package are gone, and `@delfrance/core` no longer re-exports `./plugins` from its root barrel or advertises the `./plugins` subpath — which also takes `PluginRegistry` and `PluginNotRegisteredError`, both runtime classes, out of every browser bundle that imports bare `@delfrance/core`. `@delfrance/integrations-nfe` drops `createNFeProvider()`, the only implementation either contract ever had, which had zero callers: every real caller reaches `createNFeHttpClient` on the `./http-provider` subpath, and `apps/web`'s `no-restricted-imports` rule pins it there.

These were the last two of five contracts, and the two ADR 0015 had deliberately spared as sitting "at a defensible altitude". That was the error the others did not have: pure and fetch-shaped they were, but neither can express its own domain. `calculate({ amount, ncm })` carries no CRT, no CST/CSOSN, no origem and no UF pair, while the real engine `buildImpostoXml` emits XSD-valid XML per CST and the tax configuration is a resolver chain that never mentions the contract; `issue(orderId)` returning one of three statuses cannot express `aguardandoVinculo`, cStat 136 reconciliation, SVC/EPEC contingência, filial, ambiente or série. A contract at a defensible altitude that no implementation can satisfy is still the wrong contract.

No runtime behaviour changes. `packages/config-eslint/rules/removed-plugin-contracts.test.js` now asserts both paths are absent and scans every file under `packages/core/src`, rather than reading the single path the contracts used to occupy.
