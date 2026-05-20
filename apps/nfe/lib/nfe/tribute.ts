/**
 * Homologação tributary stub — **PHASE A SCAFFOLDING ONLY**.
 *
 * Real fiscal computation (CST/CSOSN branches, modBC, bases, brackets,
 * per-UF rules) is Phase D — the .old Flutter ERP's tributary engine
 * is the source. For the Phase A homologação smoke we only need XML
 * that is *XSD-valid*; SEFAZ accepts it as test data with no fiscal
 * value. Every helper here returns a deliberately minimal block:
 *
 *   - ICMS  → ICMSSN102 (Simples Nacional, sem permissão de crédito)
 *   - PIS   → PISNT (CST 07 — não tributado)
 *   - COFINS → COFINSNT (CST 07)
 *   - IPI omitted (optional in the XSD)
 *
 * Every output is round-tripped through `validateXsd('NFe', wrappedSampleNFe)`
 * in the test suite, so regressions in SEFAZ XSD compatibility surface
 * before any network call.
 *
 * **Do not import this from produção code paths.** When Phase D lands,
 * the orchestrator switches to the real tributary engine based on
 * `Operacao.configuracaoICMS` / IPI / PIS.
 */
import type { GeneratorItem } from '@delfrance/integrations-nfe';

function fmtMoney(n: number): string {
  return n.toFixed(2);
}

/**
 * Build the `<imposto>` block for one item under Simples Nacional, CSOSN
 * 102 (sem permissão de crédito). All values zero — homologação only.
 */
export function buildSimplesNacionalCsosn102ImpostoXml(_item: GeneratorItem): string {
  return (
    '<imposto>' +
    '<ICMS>' +
    '<ICMSSN102>' +
    '<orig>0</orig>' +
    '<CSOSN>102</CSOSN>' +
    '</ICMSSN102>' +
    '</ICMS>' +
    '<PIS><PISNT><CST>07</CST></PISNT></PIS>' +
    '<COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS>' +
    '</imposto>'
  );
}

/**
 * Build the `<total>` block summing `vProd` / `vNF` only — every other
 * total is zero (no ICMS, no IPI, no frete, no seguro). Matches the
 * minimal-emission posture of the imposto stub above.
 */
export function buildEmptyTotalXml(items: ReadonlyArray<GeneratorItem>): string {
  const vProd = items.reduce((acc, it) => acc + it.vProd, 0);
  const vNF = vProd;
  return (
    '<total>' +
    '<ICMSTot>' +
    '<vBC>0.00</vBC>' +
    '<vICMS>0.00</vICMS>' +
    '<vICMSDeson>0.00</vICMSDeson>' +
    '<vFCP>0.00</vFCP>' +
    '<vBCST>0.00</vBCST>' +
    '<vST>0.00</vST>' +
    '<vFCPST>0.00</vFCPST>' +
    '<vFCPSTRet>0.00</vFCPSTRet>' +
    `<vProd>${fmtMoney(vProd)}</vProd>` +
    '<vFrete>0.00</vFrete>' +
    '<vSeg>0.00</vSeg>' +
    '<vDesc>0.00</vDesc>' +
    '<vII>0.00</vII>' +
    '<vIPI>0.00</vIPI>' +
    '<vIPIDevol>0.00</vIPIDevol>' +
    '<vPIS>0.00</vPIS>' +
    '<vCOFINS>0.00</vCOFINS>' +
    '<vOutro>0.00</vOutro>' +
    `<vNF>${fmtMoney(vNF)}</vNF>` +
    '</ICMSTot>' +
    '</total>'
  );
}

/**
 * `<transp>` block — `modFrete=9` (sem ocorrência de transporte). The
 * minimum valid shape: no transportador, no veículo, no volumes.
 */
export function buildSimpleTransp(): string {
  return '<transp><modFrete>9</modFrete></transp>';
}

/**
 * `<pag>` block with one `detPag`: `tPag=99` (outros), `vPag = vNF`.
 * Homologação only — real production maps `Pedido.pagamentos` properly.
 */
export function buildSimplePag(vNF: number): string {
  return (
    '<pag>' +
    '<detPag>' +
    '<tPag>99</tPag>' +
    `<vPag>${fmtMoney(vNF)}</vPag>` +
    '</detPag>' +
    '</pag>'
  );
}
