/**
 * The generic (10×15cm) shipping label — a carrier-less label rendered on
 * demand for freight tipos with no carrier API (retiradaNaLoja / motoboy / fob
 * / outros). `model.ts` resolves the Firestore data, `layout.ts` IS the design
 * (a pure list of draw ops in mm, ported from the legacy Flutter label), and
 * `pdf.ts` walks those ops into a vector PDF.
 */
export {
  buildEtiquetaGenericaModel,
  type EtiquetaGenericaAddress,
  type EtiquetaGenericaModel,
  type EtiquetaGenericaPessoa,
} from './model';
export {
  buildEtiquetaGenericaLayout,
  LABEL_H_MM,
  LABEL_W_MM,
  type EtiquetaGenericaLayout,
  type EtiquetaOp,
} from './layout';
export { renderEtiquetaGenericaPdf } from './pdf';
