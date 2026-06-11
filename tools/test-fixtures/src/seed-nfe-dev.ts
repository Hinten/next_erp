import { db } from './admin';
import { DEV_FILIAL_ID } from './seed-filiais-dev';
import { devPedidoIds } from './seed-pedidos-dev';

/**
 * NF-e generator for the pedidos seeded by `seed-pedidos-dev.ts`. Kept
 * separate from the pedido seed on purpose: open `/pedidos` after seeding
 * the pedidos (NF column shows DASH), then run this script and watch the
 * NFCell badges appear / change WITHOUT reloading the page — that proves
 * the per-row `onSnapshot` listener updates on its own.
 *
 * Each pedido gets exactly one NF-e doc at the stable id `<pedidoId>-nfe`,
 * so every run overwrites it (a `set()` on the same doc), which is what
 * fires the snapshot listener in the open page.
 *
 * The aprovada / cancelada / EPEC / SVC rows carry REALISTIC XML payloads
 * (a parseable NFe + protocolo), so "Imprimir DANFE" works end-to-end from
 * the dashboard — including the EPEC variant (renders from `xml_assinado` +
 * `xml_epec_proc` with the "PROTOCOLO DE AUTORIZAÇÃO DO EPEC" box) and the
 * SVC variant (DANFE prints the "EMISSÃO EM CONTINGÊNCIA (SVC-AN)" note).
 *
 * Usage (from the repo root):
 *   pnpm --filter @delfrance/test-fixtures seed:nfe
 *       → one NF-e per pedido, each at a different estado (covers every
 *         NFCell branch: aprovada, rejeitada, aguardando, error, EPEC,
 *         gerado, cancelada, SVC contingência).
 *   pnpm --filter @delfrance/test-fixtures seed:nfe --estado=a
 *       → ALL NF-es set to estado `a`. Re-run with different codes to
 *         watch every row's badge flip in unison. Valid codes:
 *         0 1 2 3 4 a p n c i e (see `estadoNFeSchema`). `--estado=p`
 *         writes the FULL EPEC doc (XMLs included) on every pedido.
 *   pnpm --filter @delfrance/test-fixtures seed:nfe --clean
 *       → delete every NF-e doc (the pedidos themselves stay).
 *
 * ⚠️ The seeded `estado='p'` docs are visible to the anti-loss poller
 * (`POST /api/nfe/processar-pendentes` scans estado in [1,2,p]) — if the
 * filial's contingency modo is not 'epec' it will try to transmit the fake
 * `xml_assinado` to SEFAZ and record a per-doc error (harmless but noisy).
 * Run `seed:nfe --clean` before exercising the poller against staging.
 *
 * Requires the same env as the other fixtures: `FIREBASE_SERVICE_ACCOUNT`
 * (or `FIREBASE_SERVICE_ACCOUNT_PATH`) and `FIREBASE_PROJECT_ID`.
 */

/** Wire-format estado codes — mirrors `estadoNFeSchema` in @delfrance/schemas. */
const ESTADO_CODES = ['0', '1', '2', '3', '4', 'a', 'p', 'n', 'c', 'i', 'e'];

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
/** Fixture emitter CNPJ — baked into the chave AND the XML emit block. */
const FIXTURE_CNPJ = '14200166000187';
const XJUST_FIXTURE = 'SEFAZ-SP indisponivel - fixture de contingencia para o dashboard';
const DH_CONT_FIXTURE = '2026-06-11T08:00:00-03:00';

/**
 * Deterministic 44-digit chave for the pedido at index `i`:
 * cUF(2) AAMM(4) CNPJ(14) mod(2) serie(3) nNF(9) tpEmis(1) cNF(8) DV(1).
 * The tpEmis digit (index 34) matches the doc's `tpEmis` so the chave is
 * coherent with what the dashboard displays.
 */
function devChave(i: number, tpEmis: number): string {
  const nNF = String(1000 + i).padStart(9, '0');
  const cNF = String(90000000 + i).padStart(8, '0');
  return `352606${FIXTURE_CNPJ}55001${nNF}${tpEmis}${cNF}7`;
}

/**
 * A parseable signed-looking `<NFe>` with every field the DANFE renderers
 * read (mirrors the test fixture at
 * `packages/integrations/nfe/test/danfe/fixtures.ts` — not importable from
 * here, so embedded). `contingencia` appends the mandatory dhCont/xJust
 * (B28/B29) for tpEmis ≠ 1.
 */
function nfeXml(opts: {
  chave: string;
  nNF: number;
  tpEmis: number;
  contingencia: boolean;
}): string {
  const cont = opts.contingencia
    ? `<dhCont>${DH_CONT_FIXTURE}</dhCont><xJust>${XJUST_FIXTURE}</xJust>`
    : '';
  return (
    `<NFe xmlns="${NFE_NS}"><infNFe Id="NFe${opts.chave}" versao="4.00">` +
    `<ide><cUF>35</cUF><cNF>${opts.chave.slice(35, 43)}</cNF><natOp>VENDA DE MERCADORIA</natOp>` +
    `<mod>55</mod><serie>1</serie><nNF>${opts.nNF}</nNF>` +
    `<dhEmi>2026-06-11T08:30:00-03:00</dhEmi><tpNF>1</tpNF><idDest>1</idDest>` +
    `<cMunFG>3550308</cMunFG><tpImp>1</tpImp><tpEmis>${opts.tpEmis}</tpEmis><cDV>7</cDV>` +
    `<tpAmb>2</tpAmb><finNFe>1</finNFe><indFinal>1</indFinal><indPres>1</indPres>` +
    `<procEmi>0</procEmi><verProc>erp-next dev-fixture</verProc>${cont}</ide>` +
    `<emit><CNPJ>${FIXTURE_CNPJ}</CNPJ><xNome>DELFRANCE COMERCIO LTDA (FIXTURE)</xNome>` +
    `<enderEmit><xLgr>RUA DAS FLORES</xLgr><nro>1000</nro><xBairro>CENTRO</xBairro>` +
    `<cMun>3550308</cMun><xMun>SAO PAULO</xMun><UF>SP</UF><CEP>01001000</CEP></enderEmit>` +
    `<IE>110042490114</IE><CRT>1</CRT></emit>` +
    `<dest><CNPJ>99999090910270</CNPJ>` +
    `<xNome>NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL</xNome>` +
    `<enderDest><xLgr>AVENIDA PAULISTA</xLgr><nro>2000</nro><xBairro>BELA VISTA</xBairro>` +
    `<cMun>3550308</cMun><xMun>SAO PAULO</xMun><UF>SP</UF><CEP>01310200</CEP></enderDest>` +
    `<indIEDest>9</indIEDest></dest>` +
    `<det nItem="1"><prod><cProd>SKU-001</cProd><cEAN>SEM GTIN</cEAN>` +
    `<xProd>CAMISETA ALGODAO PRETA M</xProd><NCM>61091000</NCM><CFOP>5102</CFOP>` +
    `<uCom>UN</uCom><qCom>2.0000</qCom><vUnCom>49.9000</vUnCom><vProd>99.80</vProd>` +
    `<cEANTrib>SEM GTIN</cEANTrib><uTrib>UN</uTrib><qTrib>2.0000</qTrib>` +
    `<vUnTrib>49.9000</vUnTrib><indTot>1</indTot></prod>` +
    `<imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS></imposto></det>` +
    `<det nItem="2"><prod><cProd>SKU-002</cProd><cEAN>7891234567890</cEAN>` +
    `<xProd>CALCA JEANS AZUL 42</xProd><NCM>62034200</NCM><CFOP>5102</CFOP>` +
    `<uCom>UN</uCom><qCom>1.0000</qCom><vUnCom>1134.7600</vUnCom><vProd>1134.76</vProd>` +
    `<cEANTrib>7891234567890</cEANTrib><uTrib>UN</uTrib><qTrib>1.0000</qTrib>` +
    `<vUnTrib>1134.7600</vUnTrib><indTot>1</indTot></prod>` +
    `<imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS></imposto></det>` +
    `<transp><modFrete>1</modFrete><vol><qVol>1</qVol><esp>CAIXA</esp><pesoL>1.500</pesoL>` +
    `<pesoB>1.800</pesoB></vol></transp>` +
    `<total><ICMSTot><vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson>` +
    `<vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST>` +
    `<vFCPSTRet>0.00</vFCPSTRet><vProd>1234.56</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg>` +
    `<vDesc>0.00</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol>` +
    `<vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro><vNF>1234.56</vNF>` +
    `</ICMSTot></total>` +
    `<infAdic><infCpl>Documento emitido por ME ou EPP optante pelo Simples Nacional.</infCpl>` +
    `</infAdic></infNFe><Signature>dev-fixture</Signature></NFe>`
  );
}

/** Wrap an NFe in an authorized `<nfeProc>` (protNFe cStat 100). */
function wrapNfeProc(nfe: string, chave: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<nfeProc xmlns="${NFE_NS}" versao="4.00">${nfe}` +
    `<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>SP_NFE_PL009_V4</verAplic>` +
    `<chNFe>${chave}</chNFe><dhRecbto>2026-06-11T08:35:12-03:00</dhRecbto>` +
    `<nProt>1352600000${chave.slice(25, 31)}</nProt><digVal>ZGV2LWZpeHR1cmU=</digVal>` +
    `<cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></nfeProc>`
  );
}

/** Archival `<procEventoNFe>` of a registered EPEC (AN retEvento, cStat 136). */
function xmlEpecProc(chave: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<procEventoNFe xmlns="${NFE_NS}" versao="1.00">` +
    `<evento versao="1.00"><infEvento Id="ID110140${chave}01"><cOrgao>91</cOrgao>` +
    `<tpAmb>2</tpAmb><CNPJ>${FIXTURE_CNPJ}</CNPJ><chNFe>${chave}</chNFe>` +
    `<dhEvento>2026-06-11T08:30:30-03:00</dhEvento><tpEvento>110140</tpEvento>` +
    `<nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento></infEvento></evento>` +
    `<retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><verAplic>AN_EVENTOS</verAplic>` +
    `<cOrgao>91</cOrgao><cStat>136</cStat>` +
    `<xMotivo>Evento registrado, mas nao vinculado a NF-e</xMotivo>` +
    `<chNFe>${chave}</chNFe><tpEvento>110140</tpEvento><xEvento>EPEC</xEvento>` +
    `<nSeqEvento>1</nSeqEvento><dhRegEvento>2026-06-11T08:31:02-03:00</dhRegEvento>` +
    `<nProt>891260000012345</nProt></infEvento></retEvento></procEventoNFe>`
  );
}

interface NFeSeed {
  readonly estado: string;
  readonly chave?: string | null;
  readonly cStat?: string | null;
  readonly xMotivo?: string | null;
  readonly error?: string | null;
  readonly tpEmis?: number;
  readonly xml_assinado?: string | null;
  readonly xml_epec_proc?: string | null;
  readonly xml_nfe_proc?: string | null;
  readonly dataContingencia?: string | null;
  readonly justificativaContingencia?: string | null;
}

/** Full EPEC-approved (estado 'p') doc — DANFE renders from these XMLs. */
function epecSeed(i: number): NFeSeed {
  const chave = devChave(i, 4);
  return {
    estado: 'p',
    tpEmis: 4,
    chave,
    cStat: '136',
    xMotivo: 'Evento registrado, mas nao vinculado a NF-e',
    xml_assinado: nfeXml({ chave, nNF: 1000 + i, tpEmis: 4, contingencia: true }),
    xml_epec_proc: xmlEpecProc(chave),
    dataContingencia: DH_CONT_FIXTURE,
    justificativaContingencia: XJUST_FIXTURE,
  };
}

/** Aprovada doc with a real procNFe — `contingencia` flips it to an SVC-AN emission. */
function aprovadaSeed(i: number, tpEmis: 1 | 6): NFeSeed {
  const chave = devChave(i, tpEmis);
  const contingencia = tpEmis !== 1;
  return {
    estado: 'a',
    tpEmis,
    chave,
    cStat: '100',
    xMotivo: 'Autorizado o uso da NF-e',
    xml_nfe_proc: wrapNfeProc(nfeXml({ chave, nNF: 1000 + i, tpEmis, contingencia }), chave),
    ...(contingencia
      ? { dataContingencia: DH_CONT_FIXTURE, justificativaContingencia: XJUST_FIXTURE }
      : {}),
  };
}

/**
 * Per-pedido estado spread for the default (no `--estado`) run, index-
 * aligned with the 8 ids from `devPedidoIds()`. Picks a representative
 * slice of the NF-e state machine so every NFCell branch renders at least
 * once — including a fully printable EPEC ('p') and an SVC-contingência
 * aprovada (outline badge + DANFE contingency note).
 */
function variedSeeds(): NFeSeed[] {
  return [
    aprovadaSeed(0, 1), // aprovada — green, DANFE printable
    { estado: 'n', xMotivo: '561 - Inscrição estadual do destinatário inválida' }, // rejeitada — red + tooltip
    { estado: '2' }, // aguardando resposta — yellow
    { estado: 'e', error: 'TLS handshake failed contacting SEFAZ-RS' }, // erro — red
    epecSeed(4), // EPEC aprovado — outline badge, EPEC DANFE printable
    { estado: '0' }, // gerado — gray
    {
      // cancelada — gray; keeps its procNFe so the DANFE prints with the
      // CANCELADO overlay (same rule as production).
      ...aprovadaSeed(6, 1),
      estado: 'c',
      cStat: '101',
      xMotivo: 'Cancelamento de NF-e homologado',
    },
    aprovadaSeed(7, 6), // SVC-AN contingência aprovada — outline badge + DANFE note
  ];
}

/** Build the NF-e seed for the pedido at index `i`, honoring an estado override. */
function nfeFor(i: number, override: string | null): NFeSeed {
  if (!override) {
    const varied = variedSeeds();
    return varied[i % varied.length]!;
  }
  // Uniform mode: keep the payload sensible for the chosen estado so the
  // cell's tooltip / DANFE button have something real to work with.
  if (override === 'p') return epecSeed(i);
  if (override === 'a') return aprovadaSeed(i, 1);
  if (override === 'n') {
    return { estado: override, xMotivo: '561 - Inscrição estadual inválida' };
  }
  if (override === 'e') {
    return { estado: override, error: 'Falha de comunicação com a SEFAZ' };
  }
  return { estado: override };
}

async function writeNFe(pedidoId: string, index: number, spec: NFeSeed): Promise<void> {
  const now = Date.now();
  await db()
    .collection('pedidos')
    .doc(pedidoId)
    .collection('nfev4')
    .doc(`${pedidoId}-nfe`)
    .set({
      numeracao: 1000 + index,
      serie: 1,
      tpEmis: spec.tpEmis ?? 1,
      estado: spec.estado,
      filialId: DEV_FILIAL_ID,
      chave: spec.chave ?? null,
      idLote: null,
      infNFe: null,
      xml_nfe_proc: spec.xml_nfe_proc ?? null,
      xml_epec_proc: spec.xml_epec_proc ?? null,
      xml_assinado: spec.xml_assinado ?? null,
      nRec: null,
      retries: null,
      cStat: spec.cStat ?? null,
      xMotivo: spec.xMotivo ?? null,
      dataContingencia: spec.dataContingencia ?? null,
      justificativaContingencia: spec.justificativaContingencia ?? null,
      error: spec.error ?? null,
      timestamp: now,
      ultima_modificacao: new Date(now).toISOString(),
    });
}

export async function seedDevNFe(
  estado: string | null = null,
): Promise<{ written: number; estado: string }> {
  const ids = devPedidoIds();
  for (let i = 0; i < ids.length; i += 1) {
    await writeNFe(ids[i]!, i, nfeFor(i, estado));
  }
  return { written: ids.length, estado: estado ?? 'varied' };
}

export async function cleanupDevNFe(): Promise<{ deleted: number }> {
  let deleted = 0;
  for (const id of devPedidoIds()) {
    const ref = db().collection('pedidos').doc(id).collection('nfev4').doc(`${id}-nfe`);
    const snap = await ref.get();
    if (snap.exists) {
      await ref.delete();
      deleted += 1;
    }
  }
  return { deleted };
}

/** Parse `--estado=<code>` from argv, validating against the wire codes. */
function parseEstadoFlag(): string | null {
  const arg = process.argv.find((a) => a.startsWith('--estado='));
  if (!arg) return null;
  const code = arg.slice('--estado='.length);
  if (!ESTADO_CODES.includes(code)) {
    throw new Error(`Invalid --estado=${code}. Valid codes: ${ESTADO_CODES.join(' ')}`);
  }
  return code;
}

const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('seed-nfe-dev.ts') ||
  process.argv[1]?.endsWith('seed-nfe-dev.js');

if (isDirectInvocation) {
  const shouldClean = process.argv.includes('--clean');
  let runner: Promise<void>;
  if (shouldClean) {
    runner = cleanupDevNFe().then(({ deleted }) => {
      // eslint-disable-next-line no-console
      console.log(`[seed-nfe-dev] removed ${deleted} NF-e doc(s)`);
    });
  } else {
    let estado: string | null;
    try {
      estado = parseEstadoFlag();
    } catch (err: unknown) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
    runner = seedDevNFe(estado).then(({ written, estado: applied }) => {
      // eslint-disable-next-line no-console
      console.log(
        `[seed-nfe-dev] wrote ${written} NF-e doc(s) (estado: ${applied}); ` +
          `the open /pedidos page should update its NF column live`,
      );
    });
  }
  runner.catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
