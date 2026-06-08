/**
 * Code 128 barcode rendering for the DANFE — the 44-digit chave de acesso.
 *
 * Uses bwip-js, which carries its own raster (no `node-canvas`/system libs), so
 * it stays a clean Node dependency. The PNG buffer is embedded into the pdfkit
 * document via `doc.image()`. The DANFE Simplificado-ETIQUETA and the A4
 * orientations all show the same Code 128 of the chave; the **ZPL** label uses
 * the printer's native `^BCN` instead (see `./zpl2`) and never touches this.
 *
 * Model 55 DANFE carries **no QR code** — that is NFC-e (model 65) only.
 */
import bwipjs from 'bwip-js/node';

/**
 * Render `data` as a Code 128 barcode PNG. For the all-numeric 44-digit chave
 * bwip-js auto-selects subset C (two digits per symbol), the most compact
 * encoding. `includetext: false` — the DANFE prints the grouped chave as its
 * own text line beneath the bars.
 */
export function code128Png(data: string): Promise<Buffer> {
  return bwipjs.toBuffer({
    bcid: 'code128',
    text: data,
    includetext: false,
    height: 12, // millimetres; the PDF fits it to the target box width
    scale: 3,
    backgroundcolor: 'ffffff',
    paddingwidth: 0,
    paddingheight: 0,
  });
}
