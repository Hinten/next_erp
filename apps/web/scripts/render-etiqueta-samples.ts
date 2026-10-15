/**
 * Render the generic shipping label's fixtures to `etiqueta-samples/` — a PDF
 * and a ZPL per fixture — so the layout can be eyeballed without a browser, a
 * Firestore or a printer (drop the .zpl files on https://labelary.com):
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
  COM_NFE_ALFA_MODEL,
  COM_NFE_MODEL,
  LONG_STRINGS_MODEL,
  MAXIMAL_MODEL,
  MINIMAL_MODEL,
  RETIRADA_MODEL,
  REVERSO_MODEL,
} from '../lib/etiqueta-generica/fixtures';
import { buildEtiquetaGenericaLayout, LABEL_H_MM } from '../lib/etiqueta-generica/layout';
import type { EtiquetaGenericaModel } from '../lib/etiqueta-generica/model';
import { renderEtiquetaGenericaPdf } from '../lib/etiqueta-generica/pdf';
import { renderEtiquetaGenericaZpl } from '../lib/etiqueta-generica/zpl2';

const OUT_DIR = join(process.cwd(), 'etiqueta-samples');

const SAMPLES: ReadonlyArray<readonly [string, EtiquetaGenericaModel]> = [
  ['minima', MINIMAL_MODEL],
  ['com-nfe', COM_NFE_MODEL],
  ['com-nfe-alfa', COM_NFE_ALFA_MODEL],
  ['reverso', REVERSO_MODEL],
  ['retirada-na-loja', RETIRADA_MODEL],
  ['maxima', MAXIMAL_MODEL],
  ['textos-longos', LONG_STRINGS_MODEL],
];

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  let written = 0;
  for (const [name, model] of SAMPLES) {
    const blob = await renderEtiquetaGenericaPdf(model);
    writeFileSync(join(OUT_DIR, `etiqueta-${name}.pdf`), Buffer.from(await blob.arrayBuffer()));
    const zplName = name === 'com-nfe-alfa' ? `etiqueta-${name}-203.zpl` : `etiqueta-${name}.zpl`;
    writeFileSync(join(OUT_DIR, zplName), renderEtiquetaGenericaZpl(model), 'utf8');
    written += 2;
    if (name === 'com-nfe-alfa') {
      writeFileSync(
        join(OUT_DIR, `etiqueta-${name}-300.zpl`),
        renderEtiquetaGenericaZpl(model, { dpi: 300 }),
        'utf8',
      );
      written += 1;
    }
    const { contentHeightMm, scale, slack } = buildEtiquetaGenericaLayout(model);
    const fill = ((contentHeightMm / LABEL_H_MM) * 100).toFixed(0);
    const squeeze = [
      slack < 1 ? `padding ${(slack * 100).toFixed(0)}%` : null,
      scale < 1 ? `type ${(scale * 100).toFixed(0)}%` : null,
    ]
      .filter(Boolean)
      .join(', ');
    process.stdout.write(
      `etiqueta-${name} — ${contentHeightMm.toFixed(1)}mm of ${LABEL_H_MM}mm (${fill}%${squeeze ? `, ${squeeze}` : ''})\n`,
    );
  }
  process.stdout.write(`\nWrote ${written} samples to ${OUT_DIR}\n`);
}

await main();
