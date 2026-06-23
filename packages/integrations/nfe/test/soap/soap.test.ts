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
    // Consulta Cadastro's SP service is `CadConsultaCadastro4` (the .asmx is
    // `cadconsultacadastro4`, NOT `nfeconsultacadastro4`). SEFAZ rejects the
    // NFe-prefixed action as "not recognized" — pin the correct service ns.
    expect(buildEnvelope('NFeConsultaCadastro', '<x/>')).toContain('/CadConsultaCadastro4"');
    expect(buildEnvelope('NFeConsultaCadastro', '<x/>')).not.toContain('/NFeConsultaCadastro4"');
  });

  it('wraps a consCad payload in the CadConsultaCadastro4 namespace', () => {
    const env = buildEnvelope(
      'NFeConsultaCadastro',
      '<consCad xmlns="http://www.portalfiscal.inf.br/nfe" versao="2.00">' +
        '<infCons><xServ>CONS-CAD</xServ><UF>SP</UF><CNPJ>14200166000187</CNPJ></infCons></consCad>',
    );
    expect(env).toContain(
      '<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/CadConsultaCadastro4">',
    );
    expect(env).toContain('<consCad');
    expect(env).toContain('<xServ>CONS-CAD</xServ>');
    expect(env).not.toMatch(/>\s+</);
  });

  it('SOAPAction is the service namespace, with the consultaCadastro suffix only for Consulta Cadastro', () => {
    const { soapActionFor } = __internal;
    // Standard v4 services: action == the bare service namespace (no operation).
    expect(soapActionFor('NFeStatusServico')).toBe(
      'http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4',
    );
    // Consulta Cadastro (classic ASMX): action carries the `/consultaCadastro`
    // operation suffix; the bare action is rejected by SEFAZ as "not recognized".
    expect(soapActionFor('NFeConsultaCadastro')).toBe(
      'http://www.portalfiscal.inf.br/nfe/wsdl/CadConsultaCadastro4/consultaCadastro',
    );
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
    expect(match![2]).toContain('<retEnviNFe');
    expect(match![2]).toContain('<cStat>103</cStat>');
  });

  it("extracts the Ambiente Nacional's ASMX-style wrapper (nfeRecepcaoEventoNFResult)", () => {
    // Captured live from hom1.nfe.fazenda.gov.br (AN_1.10.2) — the AN does
    // NOT use the standard <nfeResultMsg>; its classic .NET service wraps
    // the payload in `{operation}Result`. Regression for the EPEC emission
    // failing with "SEFAZ response missing <nfeResultMsg> (HTTP 200)".
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">` +
      `<soap:Body>` +
      `<nfeRecepcaoEventoNFResult xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">` +
      `<retEnvEvento versao="1.00" xmlns="http://www.portalfiscal.inf.br/nfe">` +
      `<idLote>1</idLote><tpAmb>2</tpAmb><verAplic>AN_1.10.2</verAplic><cOrgao>91</cOrgao>` +
      `<cStat>128</cStat><xMotivo>Lote de Evento Processado</xMotivo></retEnvEvento>` +
      `</nfeRecepcaoEventoNFResult>` +
      `</soap:Body>` +
      `</soap:Envelope>`;
    const match = __internal.RE_RESULT_MSG.exec(body);
    expect(match).not.toBeNull();
    expect(match![2]).toContain('<retEnvEvento');
    expect(match![2]).toContain('<cOrgao>91</cOrgao>');
    // The wrapper itself must not leak into the extracted payload.
    expect(match![2]).not.toContain('nfeRecepcaoEventoNFResult');
  });

  it('closes the wrapper match on the SAME tag (backreference), not a sibling', () => {
    const body =
      `<x><nfeResultMsg xmlns="a"><retEnviNFe>ok</retEnviNFe></nfeResultMsg>` +
      `<nfeOtherResult>junk</nfeOtherResult></x>`;
    const match = __internal.RE_RESULT_MSG.exec(body);
    expect(match![2]).toBe('<retEnviNFe>ok</retEnviNFe>');
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

  it('detects a WCF-style Fault with an arbitrary namespace prefix', () => {
    const fault =
      `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>` +
      `<s:Fault><s:Code><s:Value>s:Sender</s:Value></s:Code>` +
      `<s:Reason><s:Text>The message with Action '' cannot be processed</s:Text></s:Reason>` +
      `</s:Fault></s:Body></s:Envelope>`;
    expect(__internal.RE_SOAP_FAULT.test(fault)).toBe(true);
  });
});
