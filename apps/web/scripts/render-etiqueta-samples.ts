/**
 * Render the generic shipping label's fixtures to `etiqueta-samples/` so the
 * layout can be eyeballed without a browser, a Firestore or a printer:
 *
 *     pnpm --filter @delfrance/web render:etiqueta-samples
 *
 * Mirrors `packages/integrations/nfe/scripts/render-danfe-samples.ts`. This is
 * only possible because the label is drawn as VECTOR jsPDF (see `lib/etiqueta-
 * generica/pdf.ts`) — the previous `html-to-image` renderer needed a live DOM
 * and could not run headless at all.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  COM_NFE_MODEL,
  MAXIMAL_MODEL,
  MINIMAL_MODEL,
  RETIRADA_MODEL,
  REVERSO_MODEL,
} from '../lib/etiqueta-generica/fixtures';
import { buildEtiquetaGenericaLayout, LABEL_H_MM } from '../lib/etiqueta-generica/layout';
import type { EtiquetaGenericaModel } from '../lib/etiqueta-generica/model';
import { renderEtiquetaGenericaPdf } from '../lib/etiqueta-generica/pdf';

const OUT_DIR = join(process.cwd(), 'etiqueta-samples');

const SAMPLES: ReadonlyArray<readonly [string, EtiquetaGenericaModel]> = [
  ['minima', MINIMAL_MODEL],
  ['com-nfe', COM_NFE_MODEL],
  ['reverso', REVERSO_MODEL],
  ['retirada-na-loja', RETIRADA_MODEL],
  ['maxima', MAXIMAL_MODEL],
];

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, model] of SAMPLES) {
    const blob = await renderEtiquetaGenericaPdf(model);
    writeFileSync(join(OUT_DIR, `etiqueta-${name}.pdf`), Buffer.from(await blob.arrayBuffer()));
    const { contentHeightMm } = buildEtiquetaGenericaLayout(model);
    const fill = ((contentHeightMm / LABEL_H_MM) * 100).toFixed(0);
    process.stdout.write(
      `etiqueta-${name}.pdf — ${contentHeightMm.toFixed(1)}mm of ${LABEL_H_MM}mm (${fill}%)\n`,
    );
  }
  process.stdout.write(`\nWrote ${SAMPLES.length} samples to ${OUT_DIR}\n`);
}

await main();
