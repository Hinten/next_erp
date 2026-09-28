/**
 * **The emission rules a stored tax config must satisfy, decided from the
 * config alone** — the ICMS Simples Nacional choice (CRT → CSOSN → sub-config →
 * XSD sub-groups) and the PIS/COFINS group choice (CST → rate operands).
 *
 * Each rule lives here exactly once and returns DATA — a verdict — never text.
 * The NF-e engine (`packages/integrations/nfe/src/tribute/imposto.ts`) formats
 * a non-ok verdict into its English `NFeTributeError` and builds the XML from an
 * ok one. It lives here — browser-safe, unlike the NF-e package — so the web
 * imposto editor can format the SAME verdicts in pt-BR and refuse, before a
 * save, a config the engine would reject (#1655). Two copies of a rule drift
 * toward plausible while disagreeing; one copy cannot.
 *
 * ⚠️ Never a Zod refine. `impostoSchema` and the per-collection schemas gate
 * the resolver cascade and every collection read: a stored doc that fails to
 * parse silently drops to a LOWER resolver tier, which would turn an
 * incomplete config into a wrong NF-e instead of a loud refusal. These are
 * plain functions over the PARSED shapes; nothing here touches raw data.
 *
 * Pure and total over its typed inputs: no clock, no network, no Firestore.
 */
import {
  CRT,
  CSOSN,
  CST_PIS_COFINS,
  type ConfICMSSN201,
  type ConfICMSSN202ou203,
  type ConfICMSSN500,
  type ConfICMSSN900,
  type ConfiguracaoICMS,
  type Crt,
  type Csosn,
  type CstPisCofins,
} from './tribute';

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/** The two CRTs that choose a CSOSN (Simples Nacional); '3'/'4' are Phase D. */
export const CRTS_SIMPLES_NACIONAL = [
  CRT.simplesNacional,
  CRT.simplesNacionalExcessoSublimite,
] as const satisfies readonly Crt[];
export type CrtSimplesNacional = (typeof CRTS_SIMPLES_NACIONAL)[number];

/**
 * The ONLY Simples Nacional predicate. Takes `unknown` so a raw soft-read
 * value (a legacy number `1`, `null`, `''`) reads as "not SN" instead of
 * throwing: membership is strict equality against the two wire codes.
 */
export function ehCrtSimplesNacional(crt: unknown): crt is CrtSimplesNacional {
  return (CRTS_SIMPLES_NACIONAL as readonly unknown[]).includes(crt);
}

/**
 * The XSD `xs:choice` between `<ICMS>` and `<ISSQN>`: every item carries one,
 * and ISSQN wins when it is set (the Flutter dispatcher's order). An item that
 * uses ISSQN never has its ICMS config checked.
 */
export function usaIssqn<T extends { configuracaoISSQN?: unknown }>(
  imposto: T,
): imposto is T & { configuracaoISSQN: NonNullable<T['configuracaoISSQN']> } {
  return imposto.configuracaoISSQN != null;
}

// ---------------------------------------------------------------------------
// ICMS Simples Nacional: CSOSN → sub-config slot → XSD sub-groups
// ---------------------------------------------------------------------------

/** The `configuracaoICMS` keys that hold a Simples Nacional sub-config. */
export const SUBCONFIGS_ICMS_SN = [
  'csosn101',
  'csosn201',
  'csosn202ou203',
  'csosn500',
  'csosn900',
] as const satisfies readonly (keyof ConfiguracaoICMS)[];
export type SubConfigIcmsSn = (typeof SUBCONFIGS_ICMS_SN)[number];

/**
 * The sub-config each CSOSN reads, or `null` for the four that carry no values
 * (`ICMSSN102` covers 102/103/300/400: orig + CSOSN only). 202 and 203 share
 * one slot. A CSOSN never reads another CSOSN's slot, so a leftover sub-config
 * from a previous choice is ignored.
 */
export const SUBCONFIG_POR_CSOSN = {
  [CSOSN.tributadaComCredito]: 'csosn101',
  [CSOSN.tributadaSemCredito]: null,
  [CSOSN.isencaoFaixaReceitaBruta]: null,
  [CSOSN.tributadaComCreditoComSt]: 'csosn201',
  [CSOSN.tributadaSemCreditoComSt]: 'csosn202ou203',
  [CSOSN.isencaoFaixaReceitaBrutaComSt]: 'csosn202ou203',
  [CSOSN.imune]: null,
  [CSOSN.naoTributada]: null,
  [CSOSN.icmsCobradoAnteriormente]: 'csosn500',
  [CSOSN.outros]: 'csosn900',
} as const satisfies Record<Csosn, SubConfigIcmsSn | null>;

/**
 * One `xs:sequence minOccurs="0"` sub-group of an ICMSSN variant, named by the
 * sub-config's own field names (typed, so a misspelt member fails typecheck).
 * `obrigatorios` are the group's members without `minOccurs="0"`; `opcionais`
 * are the ones with it. An optional member still opens the group, so on its
 * own it forces every required member.
 */
export interface GrupoXsd<T> {
  readonly rotulo: string;
  readonly obrigatorios: readonly (keyof T & string)[];
  readonly opcionais?: readonly (keyof T & string)[];
}

// The group tables below transcribe
// `packages/integrations/nfe/generated/moc7.0/schemas/leiauteNFe_v4.00.xsd` —
// the XSD `validateXsd` and SEFAZ enforce, so it is the authority. Line ranges
// cite that file; each table lists its groups in XSD document order.

/**
 * FCP-ST (Fundo de Combate à Pobreza retido por ST): ICMSSN201 xsd:4016-4032,
 * ICMSSN202 xsd:4122-4138, ICMSSN900 xsd:4345-4361 (nested inside the ST
 * sequence there — see GRUPOS_XSD_ICMSSN900).
 */
export const GRUPO_XSD_FCP_ST = {
  rotulo: 'FCP-ST',
  obrigatorios: ['vBCFCPST', 'pFCPST', 'vFCPST'],
} as const satisfies GrupoXsd<ConfICMSSN201 | ConfICMSSN202ou203 | ConfICMSSN900>;

/** ICMSSN500 (xsd:4142-4230): three independent optional sub-groups. */
export const GRUPOS_XSD_ICMSSN500 = [
  // xsd:4167-4188
  {
    rotulo: 'ICMS-ST retido',
    obrigatorios: ['vBCSTRet', 'pST', 'vICMSSTRet'],
    opcionais: ['vICMSSubstituto'],
  },
  // xsd:4189-4205
  { rotulo: 'FCP-ST retido', obrigatorios: ['vBCFCPSTRet', 'pFCPSTRet', 'vFCPSTRet'] },
  // xsd:4206-4227
  { rotulo: 'ICMS efetivo', obrigatorios: ['pRedBCEfet', 'vBCEfet', 'pICMSEfet', 'vICMSEfet'] },
] as const satisfies ReadonlyArray<GrupoXsd<ConfICMSSN500>>;

/**
 * ICMSSN900 (xsd:4231-4377). The FCP-ST sequence is NESTED inside the ICMS-ST
 * one (xsd:4345-4361 within 4295-4362), so its trio is listed as optional
 * members of 'ICMS-ST' — an FCP-ST member with no ST group is schema-invalid —
 * and keeps its own all-or-nothing group besides.
 */
export const GRUPOS_XSD_ICMSSN900 = [
  // xsd:4255-4294
  {
    rotulo: 'ICMS próprio',
    obrigatorios: ['modBC', 'vBC', 'pICMS', 'vICMS'],
    opcionais: ['pRedBC'],
  },
  // xsd:4295-4362
  {
    rotulo: 'ICMS-ST',
    obrigatorios: ['modBCST', 'vBCST', 'pICMSST', 'vICMSST'],
    opcionais: ['pMVAST', 'pRedBCST', 'vBCFCPST', 'pFCPST', 'vFCPST'],
  },
  GRUPO_XSD_FCP_ST,
  // xsd:4363-4374
  { rotulo: 'crédito SN', obrigatorios: ['pCredSN', 'vCredICMSSN'] },
] as const satisfies ReadonlyArray<GrupoXsd<ConfICMSSN900>>;

/**
 * The sub-groups each slot checks. CSOSN 101's members are all Zod-required,
 * so its sub-config has no optional group to leave half-filled.
 */
export const GRUPOS_XSD_POR_SUBCONFIG = {
  csosn101: [],
  csosn201: [GRUPO_XSD_FCP_ST],
  csosn202ou203: [GRUPO_XSD_FCP_ST],
  csosn500: GRUPOS_XSD_ICMSSN500,
  csosn900: GRUPOS_XSD_ICMSSN900,
} as const satisfies {
  [K in SubConfigIcmsSn]: ReadonlyArray<GrupoXsd<NonNullable<ConfiguracaoICMS[K]>>>;
};

/** One incomplete sub-group: its label and its missing REQUIRED members, in XSD order. */
export interface GrupoXsdIncompleto {
  readonly grupo: string;
  readonly faltando: readonly string[];
}

/**
 * Every `xs:sequence minOccurs="0"` sub-group is all-or-nothing on the wire:
 * absent is legal, complete is legal, anything in between is schema-invalid
 * (SEFAZ cStat 215). Returns every violation, in XSD order, so the operator
 * fixes them in one pass.
 *
 * Presence is `!= null`: 0 and '0' are legitimate values (the schema is
 * nonnegative; `modBC` '0' is a real modalidade), so they count as present,
 * and an explicit `null` (the stored shape of a cleared field) reads exactly
 * like a missing key.
 */
function gruposXsdIncompletos(
  cfg: Readonly<Record<string, unknown>>,
  grupos: ReadonlyArray<GrupoXsd<Record<string, unknown>>>,
): GrupoXsdIncompleto[] {
  const isPresent = (field: string): boolean => cfg[field] != null;
  const violations: GrupoXsdIncompleto[] = [];
  for (const group of grupos) {
    const missing = group.obrigatorios.filter((field) => !isPresent(field));
    if (missing.length === 0) continue; // complete
    const opened =
      missing.length < group.obrigatorios.length || (group.opcionais ?? []).some(isPresent);
    if (!opened) continue; // absent
    violations.push({ grupo: group.rotulo, faltando: missing });
  }
  return violations;
}

/** The slot a CSOSN reads, as a type: a {@link SubConfigIcmsSn} or `null`. */
type SlotDoCsosn<C extends Csosn> = (typeof SUBCONFIG_POR_CSOSN)[C];

/** The typed sub-config a CSOSN emits from: its slot's shape, or `null` for 102/103/300/400. */
type SubDoCsosn<C extends Csosn> =
  SlotDoCsosn<C> extends infer S extends SubConfigIcmsSn ? NonNullable<ConfiguracaoICMS[S]> : null;

/**
 * An emittable Simples Nacional ICMS config, discriminated by `csosn`: a
 * `switch (v.csosn)` narrows `v.sub` to that CSOSN's own sub-config, already
 * checked non-null and group-complete.
 */
export type IcmsSnEmitivel = {
  [C in Csosn]: { readonly tipo: 'ok'; readonly csosn: C; readonly sub: SubDoCsosn<C> };
}[Csosn];

export type VereditoIcmsSn =
  | { readonly tipo: 'naoSimplesNacional'; readonly crt: Exclude<Crt, CrtSimplesNacional> }
  | { readonly tipo: 'semCsosn'; readonly crt: CrtSimplesNacional }
  | {
      readonly tipo: 'subConfigAusente';
      readonly csosn: Csosn;
      readonly subConfig: SubConfigIcmsSn;
    }
  | {
      readonly tipo: 'gruposIncompletos';
      readonly csosn: Csosn;
      readonly subConfig: SubConfigIcmsSn;
      readonly grupos: readonly GrupoXsdIncompleto[];
    }
  | IcmsSnEmitivel;

/**
 * Whether the engine can emit `<ICMS>` from this config, and if not, why. The
 * checks run in the engine's order, and the FIRST failing one decides:
 *
 * 1. a CRT outside Simples Nacional (Regime Normal / MEI, Phase D) →
 *    `naoSimplesNacional`;
 * 2. no CSOSN → `semCsosn`;
 * 3. a CSOSN with no slot (102/103/300/400) → `ok` with `sub: null`, every
 *    other slot ignored;
 * 4. the CSOSN's slot is null → `subConfigAusente`;
 * 5. an incomplete XSD sub-group → `gruposIncompletos` (every group, XSD
 *    order), naming the actual CSOSN — 203, not the shared slot;
 * 6. otherwise `ok` with the typed sub-config.
 */
export function vereditoIcmsSn(icms: ConfiguracaoICMS): VereditoIcmsSn {
  const { crt, csosn } = icms;
  if (!ehCrtSimplesNacional(crt)) return { tipo: 'naoSimplesNacional', crt };
  if (csosn == null) return { tipo: 'semCsosn', crt };
  const subConfig = SUBCONFIG_POR_CSOSN[csosn];
  let sub: NonNullable<ConfiguracaoICMS[SubConfigIcmsSn]> | null = null;
  if (subConfig != null) {
    const slot = icms[subConfig];
    if (slot == null) return { tipo: 'subConfigAusente', csosn, subConfig };
    const grupos = gruposXsdIncompletos(slot, GRUPOS_XSD_POR_SUBCONFIG[subConfig]);
    if (grupos.length > 0) return { tipo: 'gruposIncompletos', csosn, subConfig, grupos };
    sub = slot;
  }
  // The one cast: TypeScript cannot correlate a lookup in SUBCONFIG_POR_CSOSN
  // with the member of the mapped union it selects. The lookup above IS that
  // correlation (the slot read is the one the table names for `csosn`), and
  // regrasDeEmissao.test.ts pins every ok member's `sub` type.
  return { tipo: 'ok', csosn, sub } as IcmsSnEmitivel;
}

// ---------------------------------------------------------------------------
// PIS / COFINS: CST → group → rate operands
// ---------------------------------------------------------------------------

/**
 * `pPIS` / `pCOFINS` go on the wire as TDec_0302a04 — at most three integer
 * digits, so a rate must be strictly below this bound. The stored schema has
 * no upper bound; the XSD does.
 */
export const ALIQUOTA_PIS_COFINS_LIMITE = 1000;

/** CST 01/02 → PISAliq / COFINSAliq: a percent rate on the item base. */
export type CstPisCofinsAliq =
  | typeof CST_PIS_COFINS.tributavelAliquotaBasica
  | typeof CST_PIS_COFINS.tributavelAliquotaDiferenciada;
/** CST 03 → PISQtde / COFINSQtde: a per-unit rate on the item quantity. */
export type CstPisCofinsQtde = typeof CST_PIS_COFINS.tributavelAliquotaPorUnidade;
/** CST 04–09 → PISNT / COFINSNT: the CST alone, no value. */
export type CstPisCofinsNT =
  | typeof CST_PIS_COFINS.tributavelMonofasicaRevendaAliquotaZero
  | typeof CST_PIS_COFINS.tributavelSubstituicaoTributaria
  | typeof CST_PIS_COFINS.tributavelAliquotaZero
  | typeof CST_PIS_COFINS.isentaContribuicao
  | typeof CST_PIS_COFINS.semIncidenciaContribuicao
  | typeof CST_PIS_COFINS.suspensaoContribuicao;
/** CST 49–99 → PISOutr / COFINSOutr: the `xs:choice` between a percent and a per-unit base. */
export type CstPisCofinsOutr = Exclude<
  CstPisCofins,
  CstPisCofinsAliq | CstPisCofinsQtde | CstPisCofinsNT
>;

/**
 * PISOutr / COFINSOutr's base: the percent branch, the per-unit branch, or
 * `zero` — nothing configured, which the engine emits as the value branch at
 * zero (the XSD demands one branch even when nothing is due).
 */
export type BasePisCofinsOutr =
  | { readonly modo: 'valor'; readonly aliquota: number }
  | { readonly modo: 'quantidade'; readonly vAliqProd: number }
  | { readonly modo: 'zero' };

export type VereditoPisCofins =
  | { readonly tipo: 'ok'; readonly grupo: 'NT'; readonly cst: CstPisCofinsNT }
  | {
      readonly tipo: 'ok';
      readonly grupo: 'Aliq';
      readonly cst: CstPisCofinsAliq;
      readonly aliquota: number;
    }
  | {
      readonly tipo: 'ok';
      readonly grupo: 'Qtde';
      readonly cst: CstPisCofinsQtde;
      readonly vAliqProd: number;
    }
  | {
      readonly tipo: 'ok';
      readonly grupo: 'Outr';
      readonly cst: CstPisCofinsOutr;
      readonly base: BasePisCofinsOutr;
    }
  | { readonly tipo: 'aliquotaAusente'; readonly cst: CstPisCofinsAliq }
  | { readonly tipo: 'vAliqProdAusente'; readonly cst: CstPisCofinsQtde }
  | { readonly tipo: 'ambasAliquotas'; readonly cst: CstPisCofinsOutr }
  | {
      readonly tipo: 'aliquotaForaDoFormato';
      readonly cst: CstPisCofinsAliq | CstPisCofinsOutr;
      readonly aliquota: number;
    };

/**
 * Which PIS/COFINS group a config emits, from its CST and its two rate
 * operands (`pPIS`/`pCOFINS` as `aliquota`, and `vAliqProd`), and which config
 * the XSD cannot carry. Item-level needs — the per-unit groups' `qTrib` — are
 * not decidable here and stay with the engine.
 *
 * - **Aliq (01/02)**: a missing rate → `aliquotaAusente`; a rate ≥
 *   {@link ALIQUOTA_PIS_COFINS_LIMITE} → `aliquotaForaDoFormato`. `vAliqProd`
 *   is never read. A stored 0 is a configured 0% rate (`== null`).
 * - **Qtde (03)**: a missing `vAliqProd` → `vAliqProdAusente`; the percent is
 *   never read. A stored 0 is a configured rate.
 * - **NT (04–09)**: always ok; no rate is read.
 * - **Outr (49–99)**: a rate counts as configured only when > 0 — stored docs
 *   legitimately hold an explicit 0 (e.g. for the Shopee `tax_info` block),
 *   and 0 must keep meaning "nothing configured". Both configured →
 *   `ambasAliquotas` (before the rate bound); the per-unit one →
 *   `quantidade`; the percent one → the rate bound, else `valor`; neither →
 *   `zero`.
 */
export function vereditoPisCofins(
  cst: CstPisCofins,
  aliquota: number | null | undefined,
  vAliqProd: number | null | undefined,
): VereditoPisCofins {
  switch (cst) {
    case CST_PIS_COFINS.tributavelAliquotaBasica:
    case CST_PIS_COFINS.tributavelAliquotaDiferenciada: {
      if (aliquota == null) return { tipo: 'aliquotaAusente', cst };
      if (aliquota >= ALIQUOTA_PIS_COFINS_LIMITE) {
        return { tipo: 'aliquotaForaDoFormato', cst, aliquota };
      }
      return { tipo: 'ok', grupo: 'Aliq', cst, aliquota };
    }
    case CST_PIS_COFINS.tributavelAliquotaPorUnidade: {
      if (vAliqProd == null) return { tipo: 'vAliqProdAusente', cst };
      return { tipo: 'ok', grupo: 'Qtde', cst, vAliqProd };
    }
    case CST_PIS_COFINS.tributavelMonofasicaRevendaAliquotaZero:
    case CST_PIS_COFINS.tributavelSubstituicaoTributaria:
    case CST_PIS_COFINS.tributavelAliquotaZero:
    case CST_PIS_COFINS.isentaContribuicao:
    case CST_PIS_COFINS.semIncidenciaContribuicao:
    case CST_PIS_COFINS.suspensaoContribuicao:
      // Não tributado — the group carries the CST alone.
      return { tipo: 'ok', grupo: 'NT', cst };
    case CST_PIS_COFINS.outrasOperacoesSaida:
    case CST_PIS_COFINS.creditoExclusivoTributadaMercadoInterno:
    case CST_PIS_COFINS.creditoExclusivoNaoTributadaMercadoInterno:
    case CST_PIS_COFINS.creditoExclusivoExportacao:
    case CST_PIS_COFINS.creditoTributadaENaoTributadaMercadoInterno:
    case CST_PIS_COFINS.creditoTributadaMercadoInternoEExportacao:
    case CST_PIS_COFINS.creditoNaoTributadaMercadoInternoEExportacao:
    case CST_PIS_COFINS.creditoTributadaENaoTributadaMercadoInternoEExportacao:
    case CST_PIS_COFINS.creditoPresumidoExclusivoTributadaMercadoInterno:
    case CST_PIS_COFINS.creditoPresumidoExclusivoNaoTributadaMercadoInterno:
    case CST_PIS_COFINS.creditoPresumidoExclusivoExportacao:
    case CST_PIS_COFINS.creditoPresumidoTributadaENaoTributadaMercadoInterno:
    case CST_PIS_COFINS.creditoPresumidoTributadaMercadoInternoEExportacao:
    case CST_PIS_COFINS.creditoPresumidoNaoTributadaMercadoInternoEExportacao:
    case CST_PIS_COFINS.creditoPresumidoTributadaENaoTributadaMercadoInternoEExportacao:
    case CST_PIS_COFINS.creditoPresumidoOutrasOperacoes:
    case CST_PIS_COFINS.aquisicaoSemDireitoCredito:
    case CST_PIS_COFINS.aquisicaoComIsencao:
    case CST_PIS_COFINS.aquisicaoComSuspensao:
    case CST_PIS_COFINS.aquisicaoAliquotaZero:
    case CST_PIS_COFINS.aquisicaoSemIncidencia:
    case CST_PIS_COFINS.aquisicaoSubstituicaoTributaria:
    case CST_PIS_COFINS.outrasOperacoesEntrada:
    case CST_PIS_COFINS.outrasOperacoes: {
      const porValor = aliquota != null && aliquota > 0;
      const porQtde = vAliqProd != null && vAliqProd > 0;
      if (porValor && porQtde) return { tipo: 'ambasAliquotas', cst };
      if (porQtde) {
        return { tipo: 'ok', grupo: 'Outr', cst, base: { modo: 'quantidade', vAliqProd } };
      }
      if (porValor) {
        if (aliquota >= ALIQUOTA_PIS_COFINS_LIMITE) {
          return { tipo: 'aliquotaForaDoFormato', cst, aliquota };
        }
        return { tipo: 'ok', grupo: 'Outr', cst, base: { modo: 'valor', aliquota } };
      }
      return { tipo: 'ok', grupo: 'Outr', cst, base: { modo: 'zero' } };
    }
  }
}
