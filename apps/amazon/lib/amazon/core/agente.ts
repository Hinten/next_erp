/**
 * The `user-agent` every Amazon request from this app carries.
 *
 * Amazon requires one on every request and recommends
 * `AppId/AppVersionId (Language=…)` [D:connecting-to-the-selling-partner-api];
 * `@delfrance/integrations-amazon-sp-api` has no default on purpose — the app
 * names itself.
 *
 * ⚠️ This repository is PUBLIC: the value names the software, never a store, a
 * brand, a seller or a contact. `agente.test.ts` checks the package accepts it.
 */
export const AGENTE_USUARIO_AMAZON = 'erp-next/1.0 (Language=TypeScript)';
