/**
 * A small authorized **procNFe** XML fixture for the DANFE renderers — a
 * homologação (tpAmb=2) saída NF-e with emitente, destinatário, totais, dados
 * adicionais and an autorização protocolo (cStat 100). Hand-written (parsing is
 * name-based / order-independent) so the DANFE model + render tests have a
 * realistic input without booting the generator+signer.
 */
export const CHAVE = '35260514200166000187550010000000071000000018';

export const PROCNFE_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe>
    <infNFe Id="NFe${CHAVE}" versao="4.00">
      <ide>
        <cUF>35</cUF>
        <cNF>00000001</cNF>
        <natOp>VENDA DE MERCADORIA</natOp>
        <mod>55</mod>
        <serie>1</serie>
        <nNF>7</nNF>
        <dhEmi>2026-05-26T15:25:00-03:00</dhEmi>
        <tpNF>1</tpNF>
        <idDest>1</idDest>
        <cMunFG>3550308</cMunFG>
        <tpImp>1</tpImp>
        <tpEmis>1</tpEmis>
        <cDV>8</cDV>
        <tpAmb>2</tpAmb>
        <finNFe>1</finNFe>
        <indFinal>1</indFinal>
        <indPres>1</indPres>
        <procEmi>0</procEmi>
        <verProc>erp-next 1.0</verProc>
      </ide>
      <emit>
        <CNPJ>14200166000187</CNPJ>
        <xNome>DELFRANCE COMERCIO LTDA</xNome>
        <enderEmit>
          <xLgr>RUA DAS FLORES</xLgr>
          <nro>1000</nro>
          <xCpl>SALA 2</xCpl>
          <xBairro>CENTRO</xBairro>
          <cMun>3550308</cMun>
          <xMun>SAO PAULO</xMun>
          <UF>SP</UF>
          <CEP>01001000</CEP>
          <fone>1133224455</fone>
        </enderEmit>
        <IE>110042490114</IE>
        <CRT>1</CRT>
      </emit>
      <dest>
        <CNPJ>99999090910270</CNPJ>
        <xNome>NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL</xNome>
        <enderDest>
          <xLgr>AVENIDA PAULISTA</xLgr>
          <nro>2000</nro>
          <xBairro>BELA VISTA</xBairro>
          <cMun>3550308</cMun>
          <xMun>SAO PAULO</xMun>
          <UF>SP</UF>
          <CEP>01310200</CEP>
        </enderDest>
        <indIEDest>9</indIEDest>
      </dest>
      <total>
        <ICMSTot>
          <vBC>0.00</vBC>
          <vICMS>0.00</vICMS>
          <vICMSDeson>0.00</vICMSDeson>
          <vFCP>0.00</vFCP>
          <vBCST>0.00</vBCST>
          <vST>0.00</vST>
          <vFCPST>0.00</vFCPST>
          <vFCPSTRet>0.00</vFCPSTRet>
          <vProd>1234.56</vProd>
          <vFrete>0.00</vFrete>
          <vSeg>0.00</vSeg>
          <vDesc>0.00</vDesc>
          <vII>0.00</vII>
          <vIPI>0.00</vIPI>
          <vIPIDevol>0.00</vIPIDevol>
          <vPIS>0.00</vPIS>
          <vCOFINS>0.00</vCOFINS>
          <vOutro>0.00</vOutro>
          <vNF>1234.56</vNF>
        </ICMSTot>
      </total>
      <infAdic>
        <infCpl>Documento emitido por ME ou EPP optante pelo Simples Nacional. Nao gera direito a credito fiscal de IPI.</infCpl>
      </infAdic>
    </infNFe>
  </NFe>
  <protNFe versao="4.00">
    <infProt>
      <tpAmb>2</tpAmb>
      <verAplic>SP_NFE_PL009_V4</verAplic>
      <chNFe>${CHAVE}</chNFe>
      <dhRecbto>2026-05-26T15:30:12-03:00</dhRecbto>
      <nProt>135260000000456</nProt>
      <digVal>AbCdEf1234567890==</digVal>
      <cStat>100</cStat>
      <xMotivo>Autorizado o uso da NF-e</xMotivo>
    </infProt>
  </protNFe>
</nfeProc>`;
