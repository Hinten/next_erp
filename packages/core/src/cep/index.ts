/**
 * `@delfrance/core/cep` — universal (browser + server) CEP helpers.
 *
 * ⚠️ Keep this subpath SMALL and data-free. `apps/web` imports it into the
 * browser bundle, so the CEP-range → IBGE município table (#785) lives behind
 * the separate, server-only `@delfrance/core/cep/cmun` subpath and must never
 * be re-exported from here. Same reasoning as
 * `@delfrance/integrations-nfe/http-provider`, which exists so the 162 KB
 * generated NF-e schema never reaches `apps/web`.
 *
 * This subpath is also deliberately absent from `@delfrance/core`'s root
 * barrel — see `packages/core/src/index.barrel.test.ts`.
 */
export { cleanCep, isCepCompleto, formatCep } from './cep';
export { IBGE_UF_CODES, codigoMunicipioMatchesUf, ufFromCodigoMunicipio } from './ibgeUf';
export {
  type EnderecoViaCep,
  type ViaCepClient,
  type ViaCepConfig,
  ViaCepError,
  buscarCep,
  createViaCepClient,
} from './viaCep';
