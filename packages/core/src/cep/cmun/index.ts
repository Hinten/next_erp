/**
 * `@delfrance/core/cep/cmun` — CEP → IBGE município code (`cMun`) resolution
 * backed by a vendored offline range table (#785).
 *
 * ⚠️ SERVER-ONLY BY CONVENTION. This subpath carries the ~150 KB vendored
 * table; `apps/web` must keep importing `@delfrance/core/cep` (the small,
 * universal sibling) and must never reach for this one. The containment is the
 * same shape `@delfrance/integrations-nfe/http-provider` gives `apps/web`.
 *
 * The port of the legacy Flutter `TabelaoCmun` Firestore collection. It is a
 * static file rather than a collection because Firestore Enterprise bills data
 * scanned and this lookup runs on every NF-e emission — and because a file
 * works in tests, in the emulator, and with no rules/index/deploy step.
 */
export {
  type CMunRange,
  type CMunTable,
  type EncodedCMunTable,
  CMunTableError,
  decodeCMunTable,
  decodeU32List,
  encodeCMunTable,
  encodeU32List,
} from './codec';
export { cmunTable, lookupCodigoMunicipio, lookupCodigoMunicipioIn, searchRanges } from './table';
export { CMUN_RANGES, CMUN_TABLE_PROVENANCE, type CMunTableProvenance } from './ranges.data';
export {
  type EnderecoCMunInput,
  type MotivoCodigoMunicipioNaoResolvido,
  type ResolveCodigoMunicipioOptions,
  CodigoMunicipioNaoResolvidoError,
  resolveCodigoMunicipio,
  resolveCodigoMunicipioSync,
} from './resolve';
