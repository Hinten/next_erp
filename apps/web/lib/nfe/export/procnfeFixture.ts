/**
 * Minimal hand-written procNFe fixtures for the export tests. Carry per-item
 * `<prod><vProd>/<vDesc>` AND `<emit><xNome>` so the tests prove the report
 * extractor scopes its reads to `<ICMSTot>` / `<dest>` (and never picks up the
 * item or emitente values). Only test code imports this — tree-shaken from the
 * app bundle.
 */

/** Saída (tpNF=1), authorized, with a destinatário and totais. vNF = 103.00. */
export const FIXTURE_SAIDA = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe>
    <infNFe Id="NFe35260514200166000187550010000000071000000018" versao="4.00">
      <ide>
        <natOp>VENDA DE MERCADORIA</natOp>
        <serie>1</serie>
        <nNF>7</nNF>
        <dhEmi>2026-05-26T15:25:00-03:00</dhEmi>
        <tpNF>1</tpNF>
        <finNFe>1</finNFe>
      </ide>
      <emit><xNome>EMITENTE LTDA</xNome></emit>
      <dest>
        <xNome>CLIENTE EXEMPLO</xNome>
        <enderDest><UF>RJ</UF></enderDest>
      </dest>
      <det nItem="1">
        <prod><vProd>10.00</vProd><vDesc>1.00</vDesc></prod>
      </det>
      <total>
        <ICMSTot>
          <vProd>100.00</vProd>
          <vFrete>5.00</vFrete>
          <vDesc>2.00</vDesc>
          <vNF>103.00</vNF>
        </ICMSTot>
      </total>
    </infNFe>
  </NFe>
  <protNFe><infProt><cStat>100</cStat></infProt></protNFe>
</nfeProc>`;

/** Entrada (tpNF=0). vNF = 50.00. No destinatário endereço UF. */
export const FIXTURE_ENTRADA = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe>
    <infNFe Id="NFe35260514200166000187550010000000081000000025" versao="4.00">
      <ide>
        <natOp>DEVOLUCAO</natOp>
        <serie>1</serie>
        <nNF>8</nNF>
        <dhEmi>2026-05-27T09:00:00-03:00</dhEmi>
        <tpNF>0</tpNF>
        <finNFe>4</finNFe>
      </ide>
      <emit><xNome>EMITENTE LTDA</xNome></emit>
      <dest><xNome>FORNECEDOR XYZ</xNome></dest>
      <total>
        <ICMSTot>
          <vProd>48.00</vProd>
          <vFrete>2.00</vFrete>
          <vDesc>0.00</vDesc>
          <vNF>50.00</vNF>
        </ICMSTot>
      </total>
    </infNFe>
  </NFe>
  <protNFe><infProt><cStat>100</cStat></infProt></protNFe>
</nfeProc>`;
