/**
 * Public input/output shapes for the NF-e generator.
 *
 * The generator does **not** consume a raw `Pedido`. Phase A's strategy is to
 * leave tributary computation (CST/CSOSN, ICMS modBC, IPI brackets,
 * PIS/COFINS) to the caller and surface a normalized struct here. See the
 * plan in `C:\\Users\\Lucas\\.claude\\plans\\quirky-orbiting-wren.md`.
 */
import type { Cliente, Endereco, Filial, Operacao } from '@delfrance/schemas';

export type Ambiente = 'producao' | 'homologacao';

/** SEFAZ `tpEmis` — emission type. Phase A uses `1` (normal). */
export type TpEmis = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 9;

export interface GeneratorItem {
  /** Sequential position in the NF-e (1-based, `det.@nItem`). */
  readonly nItem: number;
  /** Product code — typically the SKU. */
  readonly cProd: string;
  /** GTIN / EAN — pass `'SEM GTIN'` when the product has no barcode. */
  readonly cEAN: string;
  /** Free-text product description; sanitised inside the generator. */
  readonly xProd: string;
  /** NCM classification (8 digits). */
  readonly NCM: string;
  /** CEST classification (7 digits) — when the product is in the CEST list. */
  readonly CEST?: string;
  /** CFOP resolved by the caller against the UF combo + Operacao. */
  readonly CFOP: string;
  /** Unidade comercial (e.g. `'UN'`). */
  readonly uCom: string;
  /** Quantidade comercial — up to 4 decimals. */
  readonly qCom: number;
  /** Valor unitário comercial — up to 10 decimals. */
  readonly vUnCom: number;
  /** Valor total do produto — 2 decimals, must equal `qCom × vUnCom` rounded. */
  readonly vProd: number;
  /**
   * Desconto do item (`<prod><vDesc>`, 2 decimals) — the per-unit discount
   * (`descontoUnitário × qtd`) plus this item's apportioned share of the
   * pedido-level `descontoTotal`. Emitted only when `> 0`. `vProd` stays gross
   * (`vUnCom × qCom`); the discount rides here so SEFAZ rule 629 holds and
   * `vNF = Σ(vProd − vDesc)`.
   */
  readonly vDesc?: number;
  /** GTIN / EAN tributário. */
  readonly cEANTrib: string;
  /** Unidade tributária. */
  readonly uTrib: string;
  /** Quantidade tributária. */
  readonly qTrib: number;
  /** Valor unitário tributário. */
  readonly vUnTrib: number;
  /** `indTot` — `'1'` when the item composes the NF-e total (default), `'0'` otherwise. */
  readonly indTot?: '0' | '1';
  /**
   * Optional per-item frete value (2 decimals). When the issuer
   * contracts the carrier (`frete.modalidade='0'`), Flutter stamps
   * the freight cost onto `det[0].prod.vFrete` so the value carries
   * onto the NF-e (`pedido_nfe_base.dart:932`).
   */
  readonly vFrete?: number;
  /**
   * Pre-built `<imposto>...</imposto>` XML for this det. The generator splices
   * it in as-is; tributary computation lives in the caller (Phase D follow-up).
   */
  readonly impostoXml: string;
}

export interface InfRespTec {
  readonly CNPJ: string;
  readonly xContato: string;
  readonly email: string;
  readonly fone?: string;
}

export interface InfAdic {
  readonly infCpl?: string;
  readonly infAdFisco?: string;
}

/**
 * Marketplace / intermediator identification, per SEFAZ NT 2020.006.
 * Required when `operacao.indIntermed === '1'` (sale brokered by a
 * marketplace). `CNPJ` is the intermediator's CNPJ; `idCadIntTran`
 * is the seller's identifier on the intermediator's platform (e.g.
 * the seller's store ID on Mercado Livre / Shopee / iFood).
 */
export interface InfIntermed {
  readonly CNPJ: string;
  readonly idCadIntTran: string;
}

/**
 * `<cobr>` fatura block — invoice header for duplicata payments.
 * All fields optional; `vLiq = vOrig - vDesc` is the convention but
 * SEFAZ doesn't recompute it server-side.
 */
export interface CobrFat {
  readonly nFat?: string;
  readonly vOrig?: string;
  readonly vDesc?: string;
  readonly vLiq?: string;
}

/**
 * One installment of a `<cobr>` duplicatas list. `vDup` is the only
 * required field; `nDup` (installment number) and `dVenc` (due date,
 * `YYYY-MM-DD`) are optional but customarily set.
 */
export interface CobrDup {
  readonly nDup?: string;
  readonly dVenc?: string;
  readonly vDup: string;
}

/**
 * `<cobr>` billing block — fatura header + duplicatas (installments).
 * Used for boleto / duplicata payments. Both `fat` and `dup` are
 * optional individually but at least one should be present for the
 * block to carry useful information.
 */
export interface Cobr {
  readonly fat?: CobrFat;
  readonly dup?: ReadonlyArray<CobrDup>;
}

/**
 * `<exporta>` block — export-operation metadata. SEFAZ REQUIRES this
 * block when `ide.idDest === '3'` (operação com exterior) and rejects
 * it otherwise. `UFSaidaPais` is the UF the goods leave Brazil
 * through; `xLocExporta` is the customs city; `xLocDespacho` is the
 * dispatch location (optional).
 */
export interface Exporta {
  readonly UFSaidaPais:
    | 'AC'
    | 'AL'
    | 'AM'
    | 'AP'
    | 'BA'
    | 'CE'
    | 'DF'
    | 'ES'
    | 'GO'
    | 'MA'
    | 'MG'
    | 'MS'
    | 'MT'
    | 'PA'
    | 'PB'
    | 'PE'
    | 'PI'
    | 'PR'
    | 'RJ'
    | 'RN'
    | 'RO'
    | 'RR'
    | 'RS'
    | 'SC'
    | 'SE'
    | 'SP'
    | 'TO';
  readonly xLocExporta: string;
  readonly xLocDespacho?: string;
}

export interface GeneratorInput {
  readonly ambiente: Ambiente;
  /** `nNF` — the NF-e number assigned by the issuer. */
  readonly numeracao: number;
  /** `serie` (0–889 for normal emission). */
  readonly serie: number;
  /** Defaults to 1 (normal). 4 = EPEC, 6 = SVC-AN, 7 = SVC-RS. */
  readonly tpEmis?: TpEmis;
  /** Emission timestamp. Used for `ide.dhEmi` and the `AAMM` part of the chave. */
  readonly dhEmi: Date;
  /**
   * `ide.dhCont` (B28) — when the contingency mode was activated. Required
   * (with `xJust`) when `tpEmis` ≠ 1, forbidden otherwise.
   */
  readonly dhCont?: Date;
  /**
   * `ide.xJust` (B29) — contingency justification, 15–255 chars after
   * sanitisation. Required when `tpEmis` ≠ 1, forbidden otherwise.
   */
  readonly xJust?: string;
  readonly filial: Filial;
  readonly operacao: Operacao;
  readonly cliente: Cliente;
  readonly enderecoDest: Endereco;
  readonly itens: ReadonlyArray<GeneratorItem>;
  /** Pre-built `<total>...</total>` XML. */
  readonly totalXml: string;
  /** Pre-built `<transp>...</transp>` XML. */
  readonly transpXml: string;
  /** Pre-built `<pag>...</pag>` XML. */
  readonly pagXml: string;
  readonly infAdic?: InfAdic;
  /**
   * Marketplace / intermediator block. SEFAZ requires this when
   * `operacao.indIntermed === '1'`; leave undefined otherwise.
   */
  readonly infIntermed?: InfIntermed;
  /**
   * Billing block — fatura + duplicatas for boleto / duplicata
   * payments. Optional; omit for cash / card / PIX flows.
   */
  readonly cobr?: Cobr;
  /**
   * Export-operation block. SEFAZ requires this when
   * `ide.idDest === '3'` (operação com exterior); rejects it
   * otherwise. Leave undefined for domestic NF-es.
   */
  readonly exporta?: Exporta;
  readonly infRespTec?: InfRespTec;
  /**
   * Override `cNF` to make the chave deterministic — test fixtures only.
   * Production code never sets this; the generator draws cryptographic
   * randomness via `randomCNF`.
   */
  readonly cNF?: string;
}

export interface GeneratorOutput {
  /** 44-digit chave de acesso (anti-loss anchor). */
  readonly chave: string;
  /** The 8-digit `cNF` baked into the chave. */
  readonly cNF: string;
  /** The mod-11 check digit baked into the chave. */
  readonly cDV: number;
  /**
   * Unsigned `<NFe>...<infNFe Id="NFe<chave>" versao="4.00">...</infNFe></NFe>`.
   * Flows straight into `signNFe(nfeXml, cert)` — must NOT be re-parsed.
   */
  readonly nfeXml: string;
}
