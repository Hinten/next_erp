/**
 * Single import point for what this tool borrows from `@delfrance/core`.
 *
 * The IBGE UF map is taken from the runtime package rather than duplicated, so
 * the dump validator cross-checks `cMun` prefixes against exactly the same
 * table the resolver uses.
 */
export { IBGE_UF_CODES } from '@delfrance/core/cep';
