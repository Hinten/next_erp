/**
 * **What the NF-e engine would refuse in a stored tax config, in pt-BR** — the
 * web imposto editor's side of `regrasDeEmissao.ts` (#1655).
 *
 * The rules themselves are NOT here: `vereditoIcmsSn` and `vereditoPisCofins`
 * decide them, once, for both the engine (which throws its English
 * `NFeTributeError` from the same verdicts) and this module (which formats them
 * for the operator). This file only does two things the engine also does:
 *
 * 1. **The tier gate.** The engine builds a tier doc only when it parses under
 *    `impostoSchema` (`resolverImposto.ts` tries each tier with `safeParse` and
 *    falls through on failure). A doc that does not parse — no `origem`, a
 *    malformed CFOP/NCM, an off-enum CSOSN from a legacy soft-read — is never
 *    read, so it is never refused either, and nothing here blocks it. The same
 *    line makes the function total over `unknown`: the web hands raw
 *    soft-read documents to the editor, and only the parse touches them.
 * 2. **The build order.** PIS, then COFINS, then ICMS (skipped when the item
 *    uses ISSQN — the XSD `ICMS | ISSQN` choice), then the RTC `IS`, as
 *    `buildImpostoXml` builds them. The engine stops at the first refusal; this lists every one, so the
 *    operator fixes them in one pass.
 *
 * Deliberately NOT modelled: which tier the engine SELECTS (the operação's
 * `ehFiscal`, regra matchers, a higher tier shadowing this one) — that lives
 * on other documents and changes without this doc being re-saved — and a
 * reachable tier with neither an ICMS nor an ISSQN config.
 *
 * ⚠️ Never wire this into a Zod refine on a stored schema: a doc that fails its
 * schema drops to a LOWER resolver tier silently, which would turn a refusal
 * into a wrong NF-e. It runs at save time, on the page.
 */
import {
  ALIQUOTA_PIS_COFINS_LIMITE,
  usaIssqn,
  vereditoIcmsSn,
  vereditoIsRtc,
  vereditoPisCofins,
  type VereditoIcmsSn,
  type VereditoIsRtc,
  type VereditoPisCofins,
} from './regrasDeEmissao';
import { impostoSchema } from './tribute';

/**
 * One config the engine would refuse: the operator-facing message and the
 * dotted field paths (relative to the tier doc) it is about — the first one is
 * where a page-level issue points.
 */
export interface ProblemaDeEmissao {
  readonly campos: readonly string[];
  readonly mensagem: string;
}

/** Which of the two PIS-shaped configs a verdict belongs to. */
interface TributoPisCofins {
  readonly rotulo: 'PIS' | 'COFINS';
  readonly chave: 'configuracaoPIS' | 'configuracaoCOFINS';
  readonly aliquota: 'pPIS' | 'pCOFINS';
}

const PIS: TributoPisCofins = { rotulo: 'PIS', chave: 'configuracaoPIS', aliquota: 'pPIS' };
const COFINS: TributoPisCofins = {
  rotulo: 'COFINS',
  chave: 'configuracaoCOFINS',
  aliquota: 'pCOFINS',
};

function problemasPisCofins(t: TributoPisCofins, v: VereditoPisCofins): ProblemaDeEmissao[] {
  const aliquota = `${t.chave}.${t.aliquota}`;
  const porUnidade = `${t.chave}.vAliqProd`;
  switch (v.tipo) {
    case 'ok':
      return [];
    case 'aliquotaAusente':
      return [
        { campos: [aliquota], mensagem: `${t.rotulo} (CST ${v.cst}): preencha a alíquota (%).` },
      ];
    case 'aliquotaForaDoFormato':
      return [
        {
          campos: [aliquota],
          mensagem: `${t.rotulo} (CST ${v.cst}): a alíquota (%) deve ser menor que ${ALIQUOTA_PIS_COFINS_LIMITE}.`,
        },
      ];
    case 'vAliqProdAusente':
      return [
        {
          campos: [porUnidade],
          mensagem: `${t.rotulo} (CST ${v.cst}): preencha a alíquota por unidade (R$).`,
        },
      ];
    case 'ambasAliquotas':
      return [
        {
          campos: [aliquota, porUnidade],
          mensagem:
            `${t.rotulo} (CST ${v.cst}): preencha só a alíquota (%) ou só a alíquota por ` +
            'unidade (R$), não as duas.',
        },
      ];
  }
}

/** The ICMS field paths name the XSD tags, which are also the editor's labels. */
function problemasIcms(v: VereditoIcmsSn): ProblemaDeEmissao[] {
  switch (v.tipo) {
    case 'ok':
    case 'naoSimplesNacional':
      // Regime Normal / MEI is Phase D (#312): the editor keeps saving it.
      return [];
    case 'semCsosn':
      return [{ campos: ['configuracaoICMS.csosn'], mensagem: 'ICMS: selecione o CSOSN.' }];
    case 'subConfigAusente':
      return [
        {
          campos: ['configuracaoICMS.csosn'],
          mensagem: `CSOSN ${v.csosn}: os campos do CSOSN ${v.csosn} não foram preenchidos.`,
        },
      ];
    case 'gruposIncompletos':
      return v.grupos.map(({ grupo, faltando }) => ({
        campos: faltando.map((campo) => `configuracaoICMS.${v.subConfig}.${campo}`),
        mensagem:
          `CSOSN ${v.csosn}: o grupo "${grupo}" está incompleto — falta ${faltando.join(', ')}. ` +
          'Preencha o grupo inteiro ou deixe-o todo vazio.',
      }));
  }
}

/**
 * The RTC `IS` is read only with the filial's Reforma Tributária switch on, and
 * the editor cannot see that switch. A half-filled per-unit IS is refused at
 * save anyway: the operator is filling it in now, and otherwise nothing would
 * say so before the first emission with the switch on (#1696 review).
 */
function problemasIs(v: VereditoIsRtc): ProblemaDeEmissao[] {
  switch (v.tipo) {
    case 'adValorem':
    case 'porUnidade':
      return [];
    case 'uTribAusente':
      return [
        {
          campos: ['configuracaoIBSCBS.is.uTrib'],
          mensagem:
            'IS por unidade: preencha a unidade tributável (uTrib) junto com a quantidade (qTrib).',
        },
      ];
    case 'semAliquota':
      return [
        {
          campos: ['configuracaoIBSCBS.is.pIS'],
          mensagem:
            'IS: informe a alíquota ad valorem (pIS) ou a específica por unidade (pISEspec, qTrib e uTrib).',
        },
      ];
  }
}

/**
 * The tier doc exactly as `resolverImposto.ts` hands it to `impostoSchema`. The
 * categoria and regra tiers store the legacy UPPERCASE `CFOP`, and the resolver
 * folds it into the lowercase `cfop` before parsing (a lowercase value, when
 * present, wins) — so a malformed legacy `CFOP` fails the gate there and the
 * tier is never read. Without the same fold the parse would strip `CFOP` and
 * refuse a row the engine skips. On the operação and produto tiers it changes
 * nothing: neither writer emits an uppercase `CFOP` (`impostoProduto.ts`).
 */
function comoOResolverLe(nivel: unknown): unknown {
  if (nivel == null || typeof nivel !== 'object' || Array.isArray(nivel)) return nivel;
  const doc = nivel as { cfop?: unknown; CFOP?: unknown };
  return { ...doc, cfop: doc.cfop ?? doc.CFOP };
}

/**
 * Every refusal the NF-e engine would raise from this tier doc's config alone,
 * in build order (PIS, COFINS, ICMS, IS). `[]` for a doc the engine would emit —
 * and for one it would never read (it fails `impostoSchema`, the engine's own
 * tier gate, after the resolver's legacy-`CFOP` fold), which includes any raw
 * value that is not a tier doc at all.
 */
export function problemasDeEmissaoDoImposto(nivel: unknown): ProblemaDeEmissao[] {
  const parsed = impostoSchema.safeParse(comoOResolverLe(nivel));
  if (!parsed.success) return [];
  const imposto = parsed.data;
  const problemas: ProblemaDeEmissao[] = [];
  const pis = imposto.configuracaoPIS;
  if (pis != null) {
    problemas.push(...problemasPisCofins(PIS, vereditoPisCofins(pis.CST, pis.pPIS, pis.vAliqProd)));
  }
  const cofins = imposto.configuracaoCOFINS;
  if (cofins != null) {
    problemas.push(
      ...problemasPisCofins(
        COFINS,
        vereditoPisCofins(cofins.CST, cofins.pCOFINS, cofins.vAliqProd),
      ),
    );
  }
  if (!usaIssqn(imposto) && imposto.configuracaoICMS != null) {
    problemas.push(...problemasIcms(vereditoIcmsSn(imposto.configuracaoICMS)));
  }
  const is = imposto.configuracaoIBSCBS?.is;
  if (is != null) problemas.push(...problemasIs(vereditoIsRtc(is)));
  return problemas;
}

/**
 * The per-operação rows of a produto or categoria Impostos tab as page-level
 * issues: row `i`, problem `p` → `{ path: `${campo}.${i}.${p.campos[0]}` }`.
 * Total: anything that is not an array (an unvisited tab's `null`, a raw
 * `z.unknown` value) yields no issue.
 */
export function issuesDeEmissaoDasLinhas(
  linhas: ReadonlyArray<unknown> | null | undefined,
  campo: string,
): Array<{ path: string; message: string }> {
  if (!Array.isArray(linhas)) return [];
  const issues: Array<{ path: string; message: string }> = [];
  linhas.forEach((linha: unknown, i: number) => {
    for (const problema of problemasDeEmissaoDoImposto(linha)) {
      const [primeiro] = problema.campos;
      issues.push({
        path: primeiro == null ? `${campo}.${i}` : `${campo}.${i}.${primeiro}`,
        message: problema.mensagem,
      });
    }
  });
  return issues;
}
