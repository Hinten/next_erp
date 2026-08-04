/**
 * Single import point for everything this tool borrows from `@delfrance/core`.
 *
 * The encoder, decoder and IBGE UF map are deliberately taken from the RUNTIME
 * package rather than reimplemented here: the vendoring script round-trips its
 * output through the very decoder that will read the committed table at
 * runtime, so an encoder/decoder drift is impossible by construction.
 */
export {
  type CMunRange,
  type EncodedCMunTable,
  decodeCMunTable,
  encodeCMunTable,
} from '@delfrance/core/cep/cmun';
export { IBGE_UF_CODES } from '@delfrance/core/cep';
