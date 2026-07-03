/**
 * NF-e generator — turn a `GeneratorInput` into a signed-ready `<NFe>` XML.
 *
 * Phase A scope, by design, ends at structural assembly. Tributary
 * computation (CST/CSOSN, ICMS modBC, IPI brackets, PIS/COFINS) is the
 * caller's responsibility — they hand pre-built `<imposto>`, `<total>`,
 * `<transp>`, `<pag>` XML. See
 * `C:\\Users\\Lucas\\.claude\\plans\\quirky-orbiting-wren.md`.
 */
import { aammFromDate, composeChave, randomCNF, NFeChaveError } from './chave';
import { buildDetXml } from './det';
import { buildIde, cUFFromUF, NFeIdeError } from './ide';
import { offsetForUF } from './tz';
import { buildDest, buildEmit } from './parties';
import { serializeFragment, type XmlValue } from '../xml';
import { sanitizeNFeEmail, sanitizeNFeText } from '../sanitize';
import type { UF } from '@delfrance/schemas';

import type { GeneratorInput, GeneratorOutput, TpEmis } from './types';

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
const VERSAO = '4.00';

export class NFeGeneratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFeGeneratorError';
  }
}

export function generateNFe(input: GeneratorInput): GeneratorOutput {
  validateInput(input);

  if (!input.filial.cnpj) {
    throw new NFeGeneratorError('filial.cnpj is required to compose the chave');
  }
  const tpEmis: TpEmis = input.tpEmis ?? 1;
  const cUF = cUFFromUF(input.filial.sede.estado as UF);
  // Same issuer offset buildIde uses for <dhEmi> — the chave AAMM and the
  // dhEmi string must never disagree (SEFAZ cross-checks them).
  const aamm = aammFromDate(input.dhEmi, offsetForUF(input.filial.sede.estado as UF));
  const nNF = input.numeracao.toString().padStart(9, '0');
  const cNF = input.cNF ?? randomCNF(nNF);

  const { chave, cDV } = composeChave({
    cUF,
    aamm,
    cnpjOrCpf: input.filial.cnpj.padStart(14, '0'),
    mod: '55',
    serie: input.serie.toString().padStart(3, '0'),
    nNF,
    tpEmis: tpEmis.toString(),
    cNF,
  });

  const ide = buildIde(input, {
    cNF,
    cDV: cDV.toString(),
    tpEmis: tpEmis.toString(),
    ambiente: input.ambiente,
  });
  const emit = buildEmit(input.filial);
  const dest = buildDest(input.cliente, input.enderecoDest, input.ambiente);

  // Codegen interfaces lack an index signature, so cast to the serializer's
  // XmlValue. The shapes are structurally compatible — the cast is type-only.
  const ideXml = serializeFragment('TNFe_infNFe_ide', 'ide', ide as unknown as XmlValue);
  const emitXml = serializeFragment('TNFe_infNFe_emit', 'emit', emit as unknown as XmlValue);
  const destXml = serializeFragment('TNFe_infNFe_dest', 'dest', dest as unknown as XmlValue);
  const detXml = input.itens.map(buildDetXml).join('');
  const cobrXml = input.cobr
    ? serializeFragment('TNFe_infNFe_cobr', 'cobr', input.cobr as unknown as XmlValue)
    : '';
  const infIntermedXml = input.infIntermed
    ? serializeFragment(
        'TNFe_infNFe_infIntermed',
        'infIntermed',
        input.infIntermed as unknown as XmlValue,
      )
    : '';
  const infAdicXml = buildInfAdicXml(input.infAdic);
  const exportaXml = input.exporta
    ? serializeFragment('TNFe_infNFe_exporta', 'exporta', input.exporta as unknown as XmlValue)
    : '';
  const infRespTecXml = buildInfRespTecXml(input);

  // XSD order under <infNFe>: ide, emit, dest, det+, total, transp,
  // cobr?, pag, infIntermed?, infAdic?, exporta?, infRespTec?.
  const infNFeBody =
    ideXml +
    emitXml +
    destXml +
    detXml +
    input.totalXml +
    input.transpXml +
    cobrXml +
    input.pagXml +
    infIntermedXml +
    infAdicXml +
    exportaXml +
    infRespTecXml;

  // Hand-assembled wrapper: META's `TNFe_infNFe` declares `total`/`transp`/
  // `pag` as structured types, so we cannot serialize via `serializeFragment`
  // when those slots arrive as caller-built raw XML. The structural pieces
  // (ide, emit, dest, prod) still go through the serializer.
  const infNFeXml = `<infNFe Id="NFe${chave}" versao="${VERSAO}">` + infNFeBody + '</infNFe>';
  const nfeXml = `<NFe xmlns="${NFE_NS}">${infNFeXml}</NFe>`;

  return { chave, cNF, cDV, nfeXml };
}

function validateInput(input: GeneratorInput): void {
  if (!Number.isInteger(input.numeracao) || input.numeracao < 1) {
    throw new NFeGeneratorError(`numeracao must be a positive integer, got ${input.numeracao}`);
  }
  if (!Number.isInteger(input.serie) || input.serie < 0 || input.serie > 889) {
    throw new NFeGeneratorError(`serie must be an integer in [0, 889], got ${input.serie}`);
  }
  if (input.itens.length === 0) {
    throw new NFeGeneratorError('itens must contain at least one item');
  }
  for (const it of input.itens) {
    if (!it.impostoXml) {
      throw new NFeGeneratorError(`item ${it.nItem}: impostoXml is required`);
    }
  }
  if (!input.totalXml || !input.transpXml || !input.pagXml) {
    throw new NFeGeneratorError('totalXml, transpXml, and pagXml are all required');
  }
  const tpEmis = input.tpEmis ?? 1;
  if (tpEmis === 1) {
    if (input.dhCont !== undefined || input.xJust !== undefined) {
      throw new NFeGeneratorError('dhCont/xJust are forbidden for normal emission (tpEmis=1)');
    }
    return;
  }
  // Contingency (B28/B29): SEFAZ requires both fields, xJust 15–255 chars.
  if (!input.dhCont) {
    throw new NFeGeneratorError(`dhCont is required for contingency emission (tpEmis=${tpEmis})`);
  }
  const xJust = sanitizeNFeText(input.xJust) ?? '';
  if (xJust.length < 15 || xJust.length > 255) {
    throw new NFeGeneratorError(
      `xJust must be 15–255 chars after sanitisation for contingency emission, got ${xJust.length}`,
    );
  }
}

function buildInfAdicXml(infAdic: GeneratorInput['infAdic']): string {
  if (!infAdic) return '';
  const cleanedFisco = sanitizeNFeText(infAdic.infAdFisco);
  const cleanedCpl = sanitizeNFeText(infAdic.infCpl);
  if (!cleanedFisco && !cleanedCpl) return '';
  const parts: string[] = [];
  if (cleanedFisco) parts.push(`<infAdFisco>${escape(cleanedFisco)}</infAdFisco>`);
  if (cleanedCpl) parts.push(`<infCpl>${escape(cleanedCpl)}</infCpl>`);
  return `<infAdic>${parts.join('')}</infAdic>`;
}

function buildInfRespTecXml(input: GeneratorInput): string {
  const r = input.infRespTec;
  if (!r) return '';
  return (
    `<infRespTec>` +
    `<CNPJ>${r.CNPJ}</CNPJ>` +
    `<xContato>${escape(sanitizeNFeText(r.xContato) ?? '')}</xContato>` +
    // `@` must survive — sanitizeNFeText would strip it.
    `<email>${escape(sanitizeNFeEmail(r.email) ?? '')}</email>` +
    (r.fone ? `<fone>${r.fone}</fone>` : '') +
    `</infRespTec>`
  );
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export type { GeneratorInput, GeneratorItem, GeneratorOutput, TpEmis } from './types';
export { NFeChaveError, NFeIdeError };
export { cUFFromUF } from './ide';
export { extractCNFFromChave } from './chave';
export { datePartsInOffset, NFeTzError, offsetForCUF, offsetForUF } from './tz';
