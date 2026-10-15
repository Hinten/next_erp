/**
 * Code 128 barcode rendering for the DANFE — the 44-character chave de acesso.
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
 * Render `data` as a Code 128 barcode PNG. For an all-numeric 44-character
 * chave bwip-js auto-selects subset C (two digits per symbol), the most compact
 * encoding. `includetext: false` — the DANFE prints the grouped chave as its
 * own text line beneath the bars.
 *
 * ⚠️ Pass the chave WHOLE. Positions 6–17 are the emitente CNPJ, alphanumeric
 * since RFB IN 2.229/2024, and bwip-js chooses subsets per run — so the letters
 * encode correctly here without any caller doing anything, and stripping them
 * to "help" is what printed a wrong barcode on a fiscal document.
 *
 * The ZPL label (`./zpl2`) reaches the same result through Zebra's native
 * mixed-subset invocation codes; this PNG path still hands the whole chave to
 * bwip-js and never tries to reproduce those switches itself.
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
