import { describe, it, expect } from 'vitest';
import { __internal } from '../../src/soap/index';

describe('buildEnvelope', () => {
  const { buildEnvelope } = __internal;

  it('wraps the payload in a SOAP 1.2 envelope with the right service namespace', () => {
    const env = buildEnvelope(
      'NFeAutorizacao',
      '<enviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><idLote>1</idLote></enviNFe>',
    );
    expect(env).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(env).toContain('xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"');
    expect(env).toContain(
      '<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">',
    );
    expect(env).toContain('</enviNFe></nfeDadosMsg></soap12:Body></soap12:Envelope>');
  });

  it('uses the per-operation WSDL namespace', () => {
    expect(buildEnvelope('NFeStatusServico', '<x/>')).toContain('/NFeStatusServico4"');
    expect(buildEnvelope('NFeConsultaProtocolo', '<x/>')).toContain('/NFeConsultaProtocolo4"');
    expect(buildEnvelope('NFeRetAutorizacao', '<x/>')).toContain('/NFeRetAutorizacao4"');
    expect(buildEnvelope('NFeInutilizacao', '<x/>')).toContain('/NFeInutilizacao4"');
    // RecepcaoEvento's WSDL service name carries the `NFe` prefix like the
    // rest — SEFAZ rejects `…/RecepcaoEvento4` with a SOAP Fault ("action not
    // recognized"). This pins the correct namespace so it can't regress.
    expect(buildEnvelope('RecepcaoEvento', '<x/>')).toContain('/NFeRecepcaoEvento4"');
    expect(buildEnvelope('RecepcaoEvento', '<x/>')).not.toContain('/RecepcaoEvento4"');
  });

  it('contains no formatting whitespace between elements', () => {
    const env = buildEnvelope('NFeAutorizacao', '<a/>');
    // No newlines or tabs would slip between elements — keeps the wire shape
    // predictable for namespace-ordering-sensitive SEFAZ rejections (215/225).
    expect(env).not.toMatch(/>\s+</);
  });

  it('strips a leading <?xml ?> declaration from the inner dadosMsg', () => {
    // serialize() emits a full document with a declaration; the SOAP body
    // can only carry one declaration (at the top). A duplicate declaration
    // mid-document is what SEFAZ rejects with HTTP 400.
    const env = buildEnvelope(
      'NFeStatusServico',
      '<?xml version="1.0" encoding="UTF-8"?><consStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><tpAmb>2</tpAmb><cUF>35</cUF><xServ>STATUS</xServ></consStatServ>',
    );
    // The outer envelope carries exactly one declaration — at the very top.
    expect(env.indexOf('<?xml')).toBe(0);
    expect(env.indexOf('<?xml', 1)).toBe(-1);
    expect(env).toContain('<nfeDadosMsg xmlns=');
    expect(env).toContain('<consStatServ');
  });
});

describe('result unwrap regex', () => {
  it('extracts the body content from a real-shaped SEFAZ response', () => {
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">` +
      `<soap12:Body>` +
      `<nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">` +
      `<retEnviNFe versao="4.00"><tpAmb>2</tpAmb><cStat>103</cStat></retEnviNFe>` +
      `</nfeResultMsg>` +
      `</soap12:Body>` +
      `</soap12:Envelope>`;
    const match = __internal.RE_RESULT_MSG.exec(body);
    expect(match).not.toBeNull();
    expect(match![1]).toContain('<retEnviNFe');
    expect(match![1]).toContain('<cStat>103</cStat>');
  });

  it('detects a SOAP Fault response', () => {
    const fault =
      `<soap12:Envelope xmlns:soap12="...">` +
      `<soap12:Body>` +
      `<soap12:Fault><soap12:Code><soap12:Value>soap12:Sender</soap12:Value></soap12:Code></soap12:Fault>` +
      `</soap12:Body>` +
      `</soap12:Envelope>`;
    expect(__internal.RE_SOAP_FAULT.test(fault)).toBe(true);
  });
});
