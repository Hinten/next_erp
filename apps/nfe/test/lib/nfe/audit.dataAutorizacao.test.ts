/**
 * `swapAnchorForProc` stamps `data_autorizacao` (#1743).
 *
 * Every path that can land an authorization — sync emit (and the pós-EPEC
 * transmission through it), `reconcileByRecibo`, the lote reply without a
 * receipt, the backstop sweep and the manual re-consult — builds its persist
 * extras through this ONE function, so testing it here covers all of them. The
 * write itself is exercised by `audit.persist.test.ts`; one path end to end by
 * `orchestrator.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { swapAnchorForProc } from '../../../lib/nfe/orchestrator/audit';

function procXml(infProt: string): string {
  return (
    '<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe versao="4.00">' +
    '<ide><dhEmi>2026-05-19T08:00:00-03:00</dhEmi></ide>' +
    `</infNFe></NFe><protNFe><infProt>${infProt}<cStat>100</cStat></infProt></protNFe></nfeProc>`
  );
}

describe('swapAnchorForProc — data_autorizacao', () => {
  it("stamps the protocol's dhRecbto, in ms", () => {
    const out = swapAnchorForProc(procXml('<dhRecbto>2026-05-20T10:30:00-03:00</dhRecbto>'));
    expect(out.data_autorizacao).toBe(Date.UTC(2026, 4, 20, 13, 30, 0));
  });

  it('OMITS the key — never writes null — when the proc has no dhRecbto', () => {
    // A merge carrying `null` would blank a stored value; an absent key leaves
    // it alone.
    const out = swapAnchorForProc(procXml(''));
    expect('data_autorizacao' in out).toBe(false);
    // and the anchor swap must still happen, or the signed XML would be lost
    expect(out.xml_assinado).toBeNull();
    expect(out.xml_nfe_proc).toContain('<nfeProc');
  });

  it('OMITS the key when dhRecbto carries no offset', () => {
    const out = swapAnchorForProc(procXml('<dhRecbto>2026-05-20T10:30:00</dhRecbto>'));
    expect('data_autorizacao' in out).toBe(false);
  });
});
