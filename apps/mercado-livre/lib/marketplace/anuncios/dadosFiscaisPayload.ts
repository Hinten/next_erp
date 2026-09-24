/**
 * **One fiscal SKU for ML's Faturador, built from what OUR nota would say**
 * (`POST /items/fiscal_information`, #745). Pure — no Firestore, no clock, no
 * ML call; `dadosFiscais.ts` is the half that reads and sends.
 *
 * The rule is Lucas's: send what our own NF-e would emit for this produto. So
 * the `Imposto` comes from the NF-e's own five-tier cascade (bound to the
 * conta's operação by `criarLeitorDeImpostoPorOperacao`), and every code the
 * nota fills per field from the operação — CFOP, NCM, CEST, unidade — plus the
 * cEAN rule goes through the SHARED `camposProdutoFiscal` / `gtinFiscal`
 * (`@delfrance/schemas`), never a copy here. A copy is how ML and the nota
 * would come to disagree while both read correct.
 *
 * Every refusal is a pt-BR REASON the operator can act on, never a guess: a
 * wrong fiscal record is worse than none, because ML invoices from it.
 *
 * ⚠️ What this port deliberately does not send — each one decided, not missed:
 *  - `tax_rule_id`: Regime Normal only. The NF-e engine emits CRT 1 (Simples)
 *    and throws on Regime Normal, so an `Imposto` without a CSOSN is REFUSED
 *    (`regime-normal`) rather than registered half-configured.
 *  - `type: 'bundle'`: a kit is registered as ONE `single` SKU under its own
 *    resolved imposto — exactly how our NF-e emits a kit (one line).
 *  - `fci`, `med_*`, `resale`: nothing in the ERP holds them, and our nota
 *    emits no `nFCI` either.
 */
import type { MlFiscalInformationBody } from '@delfrance/integrations-mercado-livre';
import { roundReais } from '@delfrance/core/money';
import {
  CRT,
  ORIGEM,
  camposProdutoFiscal,
  gtinFiscal,
  normalizeNCM,
  type Imposto,
  type OperacaoCamposFiscais,
} from '@delfrance/schemas';

/** pt-BR reasons for a SKU that is deliberately NOT sent. Shown to the operator. */
export const MOTIVO_DADOS_FISCAIS = {
  semSku: 'produto sem SKU — o Mercado Livre identifica os dados fiscais pelo SKU',
  skuDuplicado: 'SKU repetido em outro produto deste anúncio',
  semOperacao: 'a conta do Mercado Livre não tem operação de venda configurada',
  operacaoInexistente: 'a operação de venda configurada na conta não existe',
  semImposto: 'nenhuma configuração de imposto se aplica a este produto nesta operação',
  semNcm: 'sem NCM válido (nem no imposto do produto nem na operação)',
  regimeNormal:
    'o imposto resolvido não tem CSOSN (Regime Normal) — só o Simples Nacional é enviado',
} as const;

/** The reason for a CFOP that says neither "own production" nor "resale". */
export function motivoOrigemIndefinida(cfop: string | null): string {
  return cfop == null
    ? 'sem CFOP — não dá para dizer ao Mercado Livre se é fabricação própria ou revenda'
    : `CFOP ${cfop} não identifica fabricação própria nem revenda`;
}

export type TipoOrigemMl = MlFiscalInformationBody['tax_information']['origin_type'];

/**
 * ML's `origin_type` — the SELLER's role, which drives the CFOP ML's Faturador
 * invoices with — derived from the data our nota uses, never from a guess:
 *
 *  1. origem `1`/`6` (estrangeira, importação DIRETA) ⇒ `imported` — the seller
 *     is the importer, whatever the CFOP says;
 *  2. else the resolved CFOP's last three digits: `101`/`401` (produção do
 *     estabelecimento) ⇒ `manufacturer`, `102`/`403`/`405` (mercadoria de
 *     terceiros) ⇒ `reseller`;
 *  3. anything else ⇒ `null`, and the caller refuses the SKU naming the CFOP.
 *
 * ⚠️ Origem `2`/`7` (foreign goods BOUGHT domestically) is NOT `imported` —
 * the legacy draft mapped it so, and that would tell ML the seller imported
 * something it bought from a Brazilian supplier.
 */
export function tipoOrigemMercadoLivre(origem: string, cfop: string | null): TipoOrigemMl | null {
  if (origem === ORIGEM.estrangeiraImportacaoDireta) return 'imported';
  if (origem === ORIGEM.estrangeiraImportacaoDiretaSemSimilar) return 'imported';
  if (cfop == null || !/^\d{4}$/.test(cfop)) return null;
  const classe = cfop.slice(1);
  if (classe === '101' || classe === '401') return 'manufacturer';
  if (classe === '102' || classe === '403' || classe === '405') return 'reseller';
  return null;
}

export interface EntradaDadosFiscais {
  readonly sku: string;
  /** The listing title ML echoed, else the produto name. */
  readonly titulo: string;
  readonly imposto: Imposto;
  /** The operação document, RAW — the per-field fallback reads it. */
  readonly operacao: OperacaoCamposFiscais | null;
  readonly gtin: string | null;
  /** Kilograms; already resolved own → pai by the caller. */
  readonly pesoBrutoKg: number | null;
  readonly pesoLiquidoKg: number | null;
  /** R$; already resolved own → pai by the caller. */
  readonly custo: number | null;
}

export type ResultadoDadosFiscais =
  | { readonly ok: true; readonly body: MlFiscalInformationBody }
  | { readonly ok: false; readonly motivo: string };

export function montarDadosFiscais(e: EntradaDadosFiscais): ResultadoDadosFiscais {
  const campos = camposProdutoFiscal(e.imposto, e.operacao);

  const ncm = normalizeNCM(campos.NCM);
  if (ncm == null || ncm.length !== 8) return { ok: false, motivo: MOTIVO_DADOS_FISCAIS.semNcm };

  const icms = e.imposto.configuracaoICMS;
  if (icms == null || icms.crt === CRT.regimeNormal || icms.csosn == null) {
    return { ok: false, motivo: MOTIVO_DADOS_FISCAIS.regimeNormal };
  }

  // The intra-state CFOP first: ML sells to every UF, and `5xxx`/`6xxx` of the
  // same operation share their last three digits, which is all the rule reads.
  const cfop = campos.cfop || campos.cfopInterestadual || null;
  const originType = tipoOrigemMercadoLivre(e.imposto.origem, cfop);
  if (originType == null) return { ok: false, motivo: motivoOrigemIndefinida(cfop) };

  const cest = naoVazio(campos.CEST);
  const exTipi = naoVazio(e.imposto.extipi);
  const ean = gtinFiscal(e.gtin);
  const unidade = naoVazio(campos.unidade);
  const pesoBruto = quilos(e.pesoBrutoKg);
  const pesoLiquido = quilos(e.pesoLiquidoKg);
  const custo = e.custo != null && Number.isFinite(e.custo) && e.custo > 0 ? e.custo : null;

  return {
    ok: true,
    body: {
      sku: e.sku,
      title: e.titulo,
      type: 'single',
      register_type: 'final',
      ...(unidade != null ? { measurement_unit: unidade } : {}),
      ...(custo != null ? { cost: roundReais(custo) } : {}),
      tax_information: {
        ncm,
        origin_type: originType,
        origin_detail: e.imposto.origem,
        csosn: icms.csosn,
        ...(cest != null ? { cest } : {}),
        ...(exTipi != null ? { ex_tipi: exTipi } : {}),
        ...(ean != null ? { ean } : {}),
        ...(pesoLiquido != null ? { net_weight: pesoLiquido } : {}),
        ...(pesoBruto != null ? { gross_weight: pesoBruto } : {}),
      },
    },
  };
}

function naoVazio(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t != null && t.length > 0 ? t : null;
}

/** ML accepts at most 3 decimals; a zero or absent weight is omitted, never sent as 0. */
function quilos(v: number | null): number | null {
  if (v == null || !Number.isFinite(v) || v <= 0) return null;
  return Math.round(v * 1000) / 1000;
}
