/**
 * Render DANFE sample PDFs (+ a ZPL) for **manual** review — not a test.
 *
 *   pnpm --filter @delfrance/integrations-nfe render:danfe-samples
 *
 * Writes one file per scenario into `danfe-samples/` (gitignored) so the layout,
 * pagination and edge cases (NFref, max-length infCpl, escaped chars,
 * transportadora + local de entrega) can be eyeballed in a PDF viewer.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseProcNFe, type DanfeModel } from '../src/danfe/model';
import { renderRetrato } from '../src/danfe/pdf/retrato';
import { renderSimplificado } from '../src/danfe/pdf/simplificado';
import { renderSimplificadoZpl } from '../src/danfe/zpl2';
import { PROCNFE_FIXTURE } from '../test/danfe/fixtures';

const OUT_DIR = join(process.cwd(), 'danfe-samples');
const REF_CHAVE = '35260514200166000187550010000000061000000010';

function write(name: string, buf: Buffer | string): void {
  const path = join(OUT_DIR, name);
  writeFileSync(path, buf);
  console.log('  wrote', path);
}

/** Inject a `<retirada>`/`<entrega>` TLocal after `</dest>`. */
function local(tag: string): string {
  return (
    `<${tag}><xNome>LOCAL ${tag.toUpperCase()}</xNome><CNPJ>11222333000181</CNPJ>` +
    `<xLgr>RUA EXEMPLO</xLgr><nro>10</nro><xBairro>CENTRO</xBairro><cMun>3550308</cMun>` +
    `<xMun>SAO PAULO</xMun><UF>SP</UF><CEP>01001000</CEP></${tag}>`
  );
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log('Rendering DANFE samples →', OUT_DIR);

  const base = parseProcNFe(PROCNFE_FIXTURE);

  // Base scenario, all three outputs.
  write('retrato-base.pdf', await renderRetrato(base));
  write('simplificado-base.pdf', await renderSimplificado(base));
  write('etiqueta-base.zpl', renderSimplificadoZpl(base));

  // 100 itens + infCpl + infAdFisco (multi-page; both footer boxes populated).
  const big: DanfeModel = {
    ...base,
    itens: Array.from({ length: 100 }, (_, i) => ({
      ...base.itens[0]!,
      cProd: `SKU-${String(i + 1).padStart(3, '0')}`,
    })),
    infAdic: {
      infCpl: 'Documento emitido por ME ou EPP optante pelo Simples Nacional.',
      infAdFisco: 'Reservado ao Fisco: observação de interesse da fiscalização.',
    },
  };
  write('retrato-100-itens.pdf', await renderRetrato(big));

  // chNFe referenciada → aparece em informações complementares.
  const nfref = PROCNFE_FIXTURE.replace(
    '</ide>',
    `<NFref><refNFe>${REF_CHAVE}</refNFe></NFref></ide>`,
  );
  write('retrato-nfref.pdf', await renderRetrato(parseProcNFe(nfref)));

  // infCpl no limite do XML (5000 chars).
  const maxInfCpl: DanfeModel = {
    ...base,
    infAdic: {
      infCpl: 'LOREM IPSUM DOLOR SIT AMET. '.repeat(200).slice(0, 5000),
      infAdFisco: 'INFO FISCO. '.repeat(40),
    },
  };
  write('retrato-infcpl-max.pdf', await renderRetrato(maxInfCpl));

  // Caracteres escapados no XML.
  const escaped = PROCNFE_FIXTURE.replace(
    'CAMISETA ALGODAO PRETA M',
    'CAMISETA P&amp;B &lt;PROMO&gt;',
  ).replace('ME ou EPP', 'ME &amp; EPP &gt; 2024');
  write('retrato-escaped.pdf', await renderRetrato(parseProcNFe(escaped)));

  // Transportadora + local de entrega/retirada.
  const entrega = PROCNFE_FIXTURE.replace(
    '</dest>',
    `</dest>${local('retirada')}${local('entrega')}`,
  );
  write('retrato-entrega-transp.pdf', await renderRetrato(parseProcNFe(entrega)));

  console.log('\nDone. Open the PDFs in', OUT_DIR);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
