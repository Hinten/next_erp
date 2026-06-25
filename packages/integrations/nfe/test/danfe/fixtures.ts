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
      <det nItem="1">
        <prod>
          <cProd>SKU-001</cProd>
          <cEAN>SEM GTIN</cEAN>
          <xProd>CAMISETA ALGODAO PRETA M</xProd>
          <NCM>61091000</NCM>
          <CFOP>5102</CFOP>
          <uCom>UN</uCom>
          <qCom>2.0000</qCom>
          <vUnCom>49.9000</vUnCom>
          <vProd>99.80</vProd>
          <cEANTrib>SEM GTIN</cEANTrib>
          <uTrib>UN</uTrib>
          <qTrib>2.0000</qTrib>
          <vUnTrib>49.9000</vUnTrib>
          <indTot>1</indTot>
        </prod>
        <imposto>
          <ICMS>
            <ICMSSN102>
              <orig>0</orig>
              <CSOSN>102</CSOSN>
            </ICMSSN102>
          </ICMS>
        </imposto>
      </det>
      <det nItem="2">
        <prod>
          <cProd>SKU-002</cProd>
          <cEAN>7891234567890</cEAN>
          <xProd>CALCA JEANS AZUL 42</xProd>
          <NCM>62034200</NCM>
          <CFOP>5102</CFOP>
          <uCom>UN</uCom>
          <qCom>1.0000</qCom>
          <vUnCom>1134.7600</vUnCom>
          <vProd>1134.76</vProd>
          <cEANTrib>7891234567890</cEANTrib>
          <uTrib>UN</uTrib>
          <qTrib>1.0000</qTrib>
          <vUnTrib>1134.7600</vUnTrib>
          <indTot>1</indTot>
        </prod>
        <imposto>
          <ICMS>
            <ICMSSN102>
              <orig>0</orig>
              <CSOSN>102</CSOSN>
            </ICMSSN102>
          </ICMS>
        </imposto>
      </det>
      <transp>
        <modFrete>1</modFrete>
        <transporta>
          <xNome>TRANSPORTADORA EXEMPLO LTDA</xNome>
          <CNPJ>12345678000199</CNPJ>
          <IE>111222333444</IE>
          <xEnder>RUA DO TRANSPORTE, 50</xEnder>
          <xMun>SAO PAULO</xMun>
          <UF>SP</UF>
        </transporta>
        <veicTransp>
          <placa>ABC1D23</placa>
          <UF>SP</UF>
        </veicTransp>
        <vol>
          <qVol>1</qVol>
          <esp>CAIXA</esp>
          <marca>EXEMPLO</marca>
          <nVol>0001</nVol>
          <pesoL>1.500</pesoL>
          <pesoB>1.800</pesoB>
        </vol>
      </transp>
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

/**
 * Worst-case simplificado label: maximal field presence + long values — a 64-char
 * razão social, long emitente street/complemento, a **B2B destinatário with an IE**
 * (the row that overflowed the 10×15 cm label before #93), a long destinatário
 * address and a multi-hundred-char `infCpl`. Locks the shrink-to-fit behavior.
 */
export const PROCNFE_MAXFIELDS_FIXTURE = PROCNFE_FIXTURE.replace(
  '<xNome>DELFRANCE COMERCIO LTDA</xNome>',
  '<xNome>DELFRANCE COMERCIO E DISTRIBUICAO DE PRODUTOS ALIMENTICIOS LTDA ME</xNome>',
)
  .replace(
    '<xLgr>RUA DAS FLORES</xLgr>',
    '<xLgr>AVENIDA PROFESSOR DOUTOR FRANCISCO MORATO DE OLIVEIRA</xLgr>',
  )
  .replace(
    '<xCpl>SALA 2</xCpl>',
    '<xCpl>BLOCO C, ANDAR 12, CONJUNTO 1204, EDIFICIO EMPRESARIAL CENTRO</xCpl>',
  )
  .replace(
    '<xLgr>AVENIDA PAULISTA</xLgr>',
    '<xLgr>RUA CONSELHEIRO FURTADO DE MENDONCA SOBRINHO E SILVA</xLgr>',
  )
  .replace(
    '<nro>2000</nro>',
    '<nro>2000</nro><xCpl>CONJUNTO 1010 A 1018, DECIMO ANDAR, TORRE NORTE</xCpl>',
  )
  .replace('<indIEDest>9</indIEDest>', '<indIEDest>1</indIEDest><IE>111222333444</IE>')
  .replace(
    '<infCpl>Documento emitido por ME ou EPP optante pelo Simples Nacional. Nao gera direito a credito fiscal de IPI.</infCpl>',
    '<infCpl>Documento emitido por ME ou EPP optante pelo Simples Nacional, conforme Lei Complementar 123/2006. ' +
      'Nao gera direito a credito fiscal de IPI nem de ICMS. Mercadoria destinada a uso e consumo do adquirente. ' +
      'Pedido numero 1234567 realizado em 26/05/2026 pelo canal de vendas online. Frete por conta do destinatario. ' +
      'Observacoes adicionais de interesse do contribuinte registradas para fins de conferencia fiscal.</infCpl>',
  );

/**
 * Minimal simplificado label: a **CPF emitente**, a destinatário with **no
 * document and no address**, and **no `infCpl`** — exercises the missing-field
 * separator hygiene and the smallest layout (no off-page / stray-separator glitch).
 */
export const PROCNFE_MINFIELDS_FIXTURE = PROCNFE_FIXTURE.replace(
  '<CNPJ>14200166000187</CNPJ>',
  '<CPF>12345678909</CPF>',
)
  .replace(
    /<dest>[\s\S]*?<\/dest>/,
    '<dest><xNome>CONSUMIDOR FINAL</xNome><indIEDest>9</indIEDest></dest>',
  )
  .replace(/<infAdic>[\s\S]*?<\/infAdic>/, '');
