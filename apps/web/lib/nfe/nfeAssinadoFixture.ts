/**
 * Minimal hand-written signed-NF-e fixtures for the cStat 805 guidance tests
 * (#852) — the shape of an nfev4 doc's `xml_assinado`. Mirrors
 * `./export/procnfeFixture.ts`: only test code imports this, so it is
 * tree-shaken from the app bundle.
 *
 * Always HOMOLOGAÇÃO: `<tpAmb>2</tpAmb>`, a cUF-35 chave built on a public
 * example CNPJ, the generator's homologação `dest/xNome` placeholder and a
 * stub `<Signature/>`. It is parsed with `DOMParser` only — nothing here is
 * ever transmitted.
 *
 * Carries an `<emit><enderEmit><UF>` on purpose, so the reader tests can prove
 * the UF comes from `<dest><enderDest>`, never from the emitente.
 */

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
/** `HOMOLOGACAO_XNOME` in `packages/integrations/nfe/src/generator/parties.ts`. */
export const HOMOLOGACAO_XNOME_FIXTURE =
  'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
const CHAVE_FIXTURE = '35260911222333000181550010000000011000000010';

export interface NfeAssinadoFixtureInput {
  /** Raw text of `<ide><idDest>` — a string so near-misses (`'4'`, `''`) are expressible. */
  readonly idDest: string;
  /** Raw text of `<dest><indIEDest>`. */
  readonly indIEDest: string;
  /** `<emit><enderEmit><UF>`. Defaults to `'SP'`. */
  readonly ufEmit?: string;
  /** `<dest><enderDest><UF>`. `null` omits `<enderDest>` (`minOccurs=0`). Defaults to `'SP'`. */
  readonly ufDest?: string | null;
  /** `false` omits the whole `<dest>` group. Defaults to `true`. */
  readonly comDest?: boolean;
}

function nfeElement({
  idDest,
  indIEDest,
  ufEmit = 'SP',
  ufDest = 'SP',
  comDest = true,
}: NfeAssinadoFixtureInput): string {
  const enderDest = ufDest === null ? '' : `<enderDest><UF>${ufDest}</UF></enderDest>`;
  const dest = comDest
    ? `<dest>
        <CNPJ>11444777000161</CNPJ>
        <xNome>${HOMOLOGACAO_XNOME_FIXTURE}</xNome>
        ${enderDest}
        <indIEDest>${indIEDest}</indIEDest>
      </dest>`
    : '';
  return `<NFe xmlns="${NFE_NS}">
    <infNFe Id="NFe${CHAVE_FIXTURE}" versao="4.00">
      <ide>
        <cUF>35</cUF>
        <natOp>VENDA DE MERCADORIA</natOp>
        <mod>55</mod>
        <serie>1</serie>
        <nNF>1</nNF>
        <tpNF>1</tpNF>
        <idDest>${idDest}</idDest>
        <tpAmb>2</tpAmb>
        <finNFe>1</finNFe>
      </ide>
      <emit>
        <CNPJ>11222333000181</CNPJ>
        <xNome>EMITENTE HOMOLOGACAO LTDA</xNome>
        <enderEmit><UF>${ufEmit}</UF></enderEmit>
      </emit>
      ${dest}
    </infNFe>
    <Signature xmlns="http://www.w3.org/2000/09/xmldsig#"/>
  </NFe>`;
}

/** A bare signed `<NFe>` — the shape of `xml_assinado`. */
export function nfeAssinadoXml(input: NfeAssinadoFixtureInput): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${nfeElement(input)}`;
}

/** The same `<NFe>` wrapped in an `<nfeProc>` — the shape of `xml_nfe_proc`. */
export function nfeProcXml(input: NfeAssinadoFixtureInput): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="${NFE_NS}" versao="4.00">
  ${nfeElement(input)}
  <protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><cStat>100</cStat></infProt></protNFe>
</nfeProc>`;
}
