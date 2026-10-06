import { describe, expect, it } from 'vitest';

import { extrairDataAutorizacao } from '../../src/nfeproc';

/** 2026-05-20 10:30:00 in Brasília (-03:00) = 13:30:00 UTC. */
const AUTORIZADA_MS = Date.UTC(2026, 4, 20, 13, 30, 0);
const TRES_HORAS_MS = 3 * 60 * 60 * 1000;

/**
 * A minimal `<nfeProc>`. `dhEmi` is deliberately a DIFFERENT instant from the
 * protocol's `dhRecbto`, so a read that leaves the `<infProt>` scope is caught.
 */
function procXml(opts: { dhRecbto?: string | null; foraDoInfProt?: string } = {}): string {
  const dh =
    opts.dhRecbto === null
      ? ''
      : `<dhRecbto>${opts.dhRecbto ?? '2026-05-20T10:30:00-03:00'}</dhRecbto>`;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe versao="4.00">' +
    '<ide><dhEmi>2026-05-19T08:00:00-03:00</dhEmi></ide>' +
    (opts.foraDoInfProt ?? '') +
    '</infNFe></NFe><protNFe versao="4.00"><infProt Id="ID135200000000789">' +
    '<tpAmb>2</tpAmb><chNFe>35260514200166000187550010000000071000000018</chNFe>' +
    `${dh}<nProt>135200000000789</nProt><cStat>100</cStat>` +
    '</infProt></protNFe></nfeProc>'
  );
}

describe('extrairDataAutorizacao', () => {
  it("reads the protocol's dhRecbto as an absolute instant, in ms", () => {
    expect(extrairDataAutorizacao(procXml())).toBe(AUTORIZADA_MS);
  });

  it('the same instant written with another offset is the same value', () => {
    expect(extrairDataAutorizacao(procXml({ dhRecbto: '2026-05-20T13:30:00Z' }))).toBe(
      AUTORIZADA_MS,
    );
    expect(extrairDataAutorizacao(procXml({ dhRecbto: '2026-05-20T13:30:00+00:00' }))).toBe(
      AUTORIZADA_MS,
    );
  });

  it('honours the offset: the same wall clock in another zone is another instant', () => {
    // Near-miss of the pair above: had the offset been dropped, both would be equal.
    const brasilia = extrairDataAutorizacao(procXml({ dhRecbto: '2026-05-20T10:30:00-03:00' }));
    const utc = extrairDataAutorizacao(procXml({ dhRecbto: '2026-05-20T10:30:00Z' }));
    expect(brasilia).not.toBe(utc);
    expect(brasilia! - utc!).toBe(TRES_HORAS_MS);
  });

  it('refuses an offset-less value instead of reading it as UTC', () => {
    // `parseIsoToMillis` alone would resolve this to 10:30 UTC — three hours
    // away from the Brasília instant SEFAZ meant.
    expect(extrairDataAutorizacao(procXml({ dhRecbto: '2026-05-20T10:30:00' }))).toBeNull();
    expect(extrairDataAutorizacao(procXml({ dhRecbto: '2026-05-20' }))).toBeNull();
  });

  it('is null when the protocol carries no readable dhRecbto', () => {
    expect(extrairDataAutorizacao(procXml({ dhRecbto: null }))).toBeNull();
    expect(extrairDataAutorizacao(procXml({ dhRecbto: '' }))).toBeNull();
    expect(extrairDataAutorizacao(procXml({ dhRecbto: 'ontem-03:00' }))).toBeNull();
  });

  it('is null when there is no <infProt> at all', () => {
    expect(
      extrairDataAutorizacao(
        '<nfeProc><NFe><infNFe><dhRecbto>2026-05-20T10:30:00-03:00</dhRecbto></infNFe></NFe></nfeProc>',
      ),
    ).toBeNull();
  });

  it('never takes a dhRecbto from outside <infProt> for the protocol one', () => {
    const outro = '<dhRecbto>2020-01-01T00:00:00-03:00</dhRecbto>';
    expect(extrairDataAutorizacao(procXml({ foraDoInfProt: outro }))).toBe(AUTORIZADA_MS);
    expect(extrairDataAutorizacao(procXml({ dhRecbto: null, foraDoInfProt: outro }))).toBeNull();
  });

  it('tolerates a namespace prefix and surrounding whitespace', () => {
    const xml =
      '<nfe:nfeProc xmlns:nfe="http://www.portalfiscal.inf.br/nfe"><nfe:protNFe>' +
      '<nfe:infProt Id="ID1"><nfe:dhRecbto> 2026-05-20T10:30:00-03:00 </nfe:dhRecbto></nfe:infProt>' +
      '</nfe:protNFe></nfe:nfeProc>';
    expect(extrairDataAutorizacao(xml)).toBe(AUTORIZADA_MS);
  });
});
