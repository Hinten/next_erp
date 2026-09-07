/**
 * `swapAnchorForProc` carries the `<ICMSTot>` totals (#1491).
 *
 * Every path that can land an authorization — sync emit, `reconcileByRecibo`,
 * the backstop sweep and the manual re-consult — builds its persist extras
 * through this ONE function, so testing it here covers all four. The write
 * itself is exercised by `audit.persist.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { swapAnchorForProc } from '../../../lib/nfe/orchestrator/audit';

/** A proc whose per-item `vProd` differs from the note total, on purpose. */
function procXml(totalVProd = '100.00', itemVProd = '30.00'): string {
  return (
    '<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe versao="4.00">' +
    '<ide><cUF>35</cUF><natOp>VENDA</natOp><tpNF>1</tpNF><finNFe>1</finNFe></ide>' +
    `<det nItem="1"><prod><vProd>${itemVProd}</vProd><vDesc>1.00</vDesc></prod></det>` +
    `<total><ICMSTot><vProd>${totalVProd}</vProd><vDesc>4.00</vDesc><vST>0.00</vST>` +
    '<vIPI>0.00</vIPI><vFrete>12.00</vFrete><vSeg>0.00</vSeg><vOutro>0.00</vOutro>' +
    '<vNF>108.00</vNF></ICMSTot></total>' +
    '</infNFe></NFe><protNFe><infProt><cStat>100</cStat></infProt></protNFe></nfeProc>'
  );
}

describe('swapAnchorForProc', () => {
  it('still swaps the anti-loss anchor (the #128 invariant is untouched)', () => {
    const out = swapAnchorForProc(procXml());
    expect(out.xml_nfe_proc).toContain('<nfeProc');
    expect(out.xml_assinado).toBeNull();
  });

  it('carries the totals derived from the very bytes it persists', () => {
    const out = swapAnchorForProc(procXml());
    expect(out.totais).toEqual({
      vProd: 100,
      vDesc: 4,
      vST: 0,
      vIPI: 0,
      vFrete: 12,
      vSeg: 0,
      vOutro: 0,
      vNF: 108,
      tpNF: 1,
      finNFe: 1,
    });
  });

  it('takes vProd from ICMSTot, not from the first item', () => {
    // 30 is the item and would be a plausible-looking total; 100 is the note.
    expect(swapAnchorForProc(procXml('100.00', '30.00')).totais?.vProd).toBe(100);
  });

  it('OMITS the key — never writes null — when the proc carries no ICMSTot', () => {
    // This is what protects a good stored block from being erased by a later
    // merge write (a re-persist from the sweep, say). `null` here would blank
    // it; an absent key leaves the stored value alone.
    const out = swapAnchorForProc('<nfeProc><NFe><infNFe/></NFe></nfeProc>');
    expect('totais' in out).toBe(false);
    // and the anchor swap must still happen, or the signed XML would be lost
    expect(out.xml_assinado).toBeNull();
  });
});
