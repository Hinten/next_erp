/**
 * The generic (10×15cm) shipping label — a carrier-less PDF rendered on demand
 * for freight tipos with no carrier API (retiradaNaLoja / motoboy / fob /
 * outros). See `EtiquetaGenericaSheet` for the layout and
 * `useEtiquetaGenericaExport` for the capture surfaces.
 */
export {
  buildEtiquetaGenericaModel,
  type EtiquetaGenericaAddress,
  type EtiquetaGenericaModel,
  type EtiquetaGenericaPessoa,
} from './model';
export { EtiquetaGenericaSheet, type EtiquetaGenericaSheetProps } from './EtiquetaGenericaSheet';
export {
  exportEtiquetaGenericaPdf,
  renderAndExportEtiquetaGenericaPdf,
  useEtiquetaGenericaExport,
  type EtiquetaGenericaExport,
} from './useEtiquetaGenericaExport';
