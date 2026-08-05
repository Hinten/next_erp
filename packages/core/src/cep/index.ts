/**
 * `@delfrance/core/cep` — universal (browser + server) CEP helpers.
 *
 * Browser-safe and data-free: the CEP → município mapping itself is the
 * Firestore `CMUN` collection, resolved server-side by
 * `@delfrance/data/admin`'s `resolveCodigoMunicipio` (#785). Nothing here
 * embeds that data.
 *
 * Deliberately absent from `@delfrance/core`'s root barrel — see
 * `packages/core/src/index.barrel.test.ts`.
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
