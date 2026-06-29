/**
 * Tributary input schemas — the **Flutter-shape** Imposto + ConfiguracaoICMS /
 * IPI / PIS / COFINS / ISSQN / retenção / RTC (IBS/CBS/IS) configs.
 *
 * Single source of truth for the tax-config wire shapes. These mirror the Dart
 * classes in `.old/packages/operacao_fiscal/lib/src/models.dart`
 * (`ConfiguracaoICMS`, `confICMSSN101…confICMSSN900`, `confICMS00…confICMS90`,
 * `confPIS`, `ConfiguracaoPISST`, …) and the per-item `Imposto`
 * (`.old/packages/produtos/lib/src/models.dart`).
 *
 * Lives in `@delfrance/schemas` (not `@delfrance/integrations-nfe`) so the
 * **browser bundle** can author them: the NF-e package is Node-only (node-forge,
 * soap, wasm), and `apps/web`'s ESLint forbids importing its root specifier.
 * The tribute engine re-exports these from
 * `packages/integrations/nfe/src/tribute/schemas.ts`, so its builders + the
 * orchestrator stay on the same definitions.
 *
 * Numbers in (the way Firestore stores them); the NF-e dispatcher
 * (`tribute/imposto.ts`) converts them to the SEFAZ wire shape (strings).
 *
 * **Emission scope** is Simples Nacional (CSOSN) + the optional RTC groups; the
 * NF-e dispatcher throws on Regime Normal (CRT=3/4 → Phase D, issue #312). The
 * Regime Normal CST sub-configs (`confICMS00…90`) are modelled here anyway so
 * existing Flutter-authored docs **round-trip losslessly** through the typed
 * schemas — the editor surfaces SN+RTC, but never drops a Regime Normal blob.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared enums (mirror Flutter enums one-to-one)
// ---------------------------------------------------------------------------

/** CRT — Código de Regime Tributário. */
export const crtSchema = z.enum(['1', '2', '3', '4']);
export type Crt = z.infer<typeof crtSchema>;

export const CRT_LABELS: Record<Crt, string> = {
  '1': '1 - Simples Nacional',
  '2': '2 - Simples Nacional, excesso de sublimite de receita bruta',
  '3': '3 - Regime Normal',
  '4': '4 - MEI - Simples Nacional, microempreendedor individual',
};

/** CSOSN codes for Simples Nacional. */
export const csosnSchema = z.enum([
  '101',
  '102',
  '103',
  '201',
  '202',
  '203',
  '300',
  '400',
  '500',
  '900',
]);
export type Csosn = z.infer<typeof csosnSchema>;

export const CSOSN_LABELS: Record<Csosn, string> = {
  '101': '101 - Tributada pelo SN com permissão de crédito',
  '102': '102 - Tributada pelo SN sem permissão de crédito',
  '103': '103 - Isenção do ICMS no SN para faixa de receita bruta',
  '201': '201 - Tributada pelo SN com permissão de crédito e com cobrança do ICMS por ST',
  '202': '202 - Tributada pelo SN sem permissão de crédito e com cobrança do ICMS por ST',
  '203': '203 - Isenção do ICMS no SN para faixa de receita bruta e com cobrança do ICMS por ST',
  '300': '300 - Imune',
  '400': '400 - Não tributada pelo SN',
  '500': '500 - ICMS cobrado anteriormente por ST ou por antecipação',
  '900': '900 - Outros',
};

/** CST — Código da Situação Tributária do ICMS (Regime Normal). */
export const cstSchema = z.enum(['00', '10', '20', '30', '40', '41', '50', '51', '60', '70', '90']);
export type Cst = z.infer<typeof cstSchema>;

export const CST_ICMS_LABELS: Record<Cst, string> = {
  '00': '00 - Tributada integralmente',
  '10': '10 - Tributada e com cobrança do ICMS por substituição tributária',
  '20': '20 - Com redução de base de cálculo',
  '30': '30 - Isenta/não tributada e com cobrança do ICMS por substituição tributária',
  '40': '40 - Isenta',
  '41': '41 - Não tributada',
  '50': '50 - Suspensão',
  '51': '51 - Diferimento',
  '60': '60 - ICMS cobrado anteriormente por substituição tributária',
  '70': '70 - Com redução de BC e cobrança do ICMS por substituição tributária',
  '90': '90 - Outras',
};

/** modBC — Modalidade de determinação da BC do ICMS. */
export const modBCSchema = z.enum(['0', '1', '2', '3']);
export type ModBC = z.infer<typeof modBCSchema>;

export const MOD_BC_LABELS: Record<ModBC, string> = {
  '0': '0 - Margem Valor Agregado (%)',
  '1': '1 - Pauta (valor)',
  '2': '2 - Preço Tabelado Máximo (valor)',
  '3': '3 - Valor da Operação',
};

/** modBCST — Modalidade de determinação da BC do ICMS ST. */
export const modBCSTSchema = z.enum(['0', '1', '2', '3', '4', '5']);
export type ModBCST = z.infer<typeof modBCSTSchema>;

export const MOD_BCST_LABELS: Record<ModBCST, string> = {
  '0': '0 - Preço tabelado ou máximo sugerido',
  '1': '1 - Lista Negativa (valor)',
  '2': '2 - Lista Positiva (valor)',
  '3': '3 - Lista Neutra (valor)',
  '4': '4 - Margem Valor Agregado (%)',
  '5': '5 - Pauta (valor)',
};

/**
 * motDesICMS — Motivo da desoneração do ICMS. Flutter stores the bare integer
 * code (`motDesICMSenum.toJson()` returns the int), so accept both number and
 * string for a lossless round-trip of legacy docs.
 */
export const motDesICMSSchema = z.union([z.number().int(), z.string()]);
export type MotDesICMS = z.infer<typeof motDesICMSSchema>;

export const MOT_DES_ICMS_LABELS: Record<string, string> = {
  '1': '1 - Táxi',
  '3': '3 - Uso na agropecuária',
  '4': '4 - Frotista/Locadora',
  '5': '5 - Diplomático/Consular',
  '6': '6 - Utilitários e Motocicletas da Amazônia Ocidental e Áreas de Livre Comércio',
  '7': '7 - SUFRAMA',
  '8': '8 - Venda a Órgão Público',
  '9': '9 - Outros',
  '10': '10 - Deficiente Condutor',
  '11': '11 - Deficiente Não Condutor',
  '12': '12 - Órgão de fomento e desenvolvimento agropecuário',
  '16': '16 - Olimpíadas Rio 2016',
  '90': '90 - Solicitado pelo Fisco',
};

/** Origem da mercadoria (codegen also has this). */
export const origemSchema = z.enum(['0', '1', '2', '3', '4', '5', '6', '7', '8']);
export type Origem = z.infer<typeof origemSchema>;

/** CST PIS / COFINS (the most common codes; full surface = ~33 codes). */
export const cstPisCofinsSchema = z.enum([
  '01',
  '02',
  '03',
  '04',
  '05',
  '06',
  '07',
  '08',
  '09',
  '49',
  '50',
  '51',
  '52',
  '53',
  '54',
  '55',
  '56',
  '60',
  '61',
  '62',
  '63',
  '64',
  '65',
  '66',
  '67',
  '70',
  '71',
  '72',
  '73',
  '74',
  '75',
  '98',
  '99',
]);
export type CstPisCofins = z.infer<typeof cstPisCofinsSchema>;

export const CST_PIS_COFINS_LABELS: Record<CstPisCofins, string> = {
  '01': '01 - Operação Tributável com Alíquota Básica',
  '02': '02 - Operação Tributável com Alíquota Diferenciada',
  '03': '03 - Operação Tributável com Alíquota por Unidade de Medida de Produto',
  '04': '04 - Operação Tributável Monofásica - Revenda a Alíquota Zero',
  '05': '05 - Operação Tributável por Substituição Tributária',
  '06': '06 - Operação Tributável a Alíquota Zero',
  '07': '07 - Operação Isenta da Contribuição',
  '08': '08 - Operação sem Incidência da Contribuição',
  '09': '09 - Operação com Suspensão da Contribuição',
  '49': '49 - Outras Operações de Saída',
  '50': '50 - Operação com Direito a Crédito - Vinculada Exclusivamente a Receita Tributada no Mercado Interno',
  '51': '51 - Operação com Direito a Crédito - Vinculada Exclusivamente a Receita Não Tributada no Mercado Interno',
  '52': '52 - Operação com Direito a Crédito - Vinculada Exclusivamente a Receita de Exportação',
  '53': '53 - Operação com Direito a Crédito - Vinculada a Receitas Tributadas e Não-Tributadas no Mercado Interno',
  '54': '54 - Operação com Direito a Crédito - Vinculada a Receitas Tributadas no Mercado Interno e de Exportação',
  '55': '55 - Operação com Direito a Crédito - Vinculada a Receitas Não-Tributadas no Mercado Interno e de Exportação',
  '56': '56 - Operação com Direito a Crédito - Vinculada a Receitas Tributadas e Não-Tributadas no Mercado Interno, e de Exportação',
  '60': '60 - Crédito Presumido - Operação de Aquisição Vinculada Exclusivamente a Receita Tributada no Mercado Interno',
  '61': '61 - Crédito Presumido - Operação de Aquisição Vinculada Exclusivamente a Receita Não-Tributada no Mercado Interno',
  '62': '62 - Crédito Presumido - Operação de Aquisição Vinculada Exclusivamente a Receita de Exportação',
  '63': '63 - Crédito Presumido - Operação de Aquisição Vinculada a Receitas Tributadas e Não-Tributadas no Mercado Interno',
  '64': '64 - Crédito Presumido - Operação de Aquisição Vinculada a Receitas Tributadas no Mercado Interno e de Exportação',
  '65': '65 - Crédito Presumido - Operação de Aquisição Vinculada a Receitas Não-Tributadas no Mercado Interno e de Exportação',
  '66': '66 - Crédito Presumido - Operação de Aquisição Vinculada a Receitas Tributadas e Não-Tributadas no Mercado Interno, e de Exportação',
  '67': '67 - Crédito Presumido - Outras Operações',
  '70': '70 - Operação de Aquisição sem Direito a Crédito',
  '71': '71 - Operação de Aquisição com Isenção',
  '72': '72 - Operação de Aquisição com Suspensão',
  '73': '73 - Operação de Aquisição a Alíquota Zero',
  '74': '74 - Operação de Aquisição sem Incidência da Contribuição',
  '75': '75 - Operação de Aquisição por Substituição Tributária',
  '98': '98 - Outras Operações de Entrada',
  '99': '99 - Outras Operações',
};

/** indISS — Indicador da exigibilidade do ISS (XSD enumeration). */
export const indISSSchema = z.enum(['1', '2', '3', '4', '5', '6', '7']);
export type IndISS = z.infer<typeof indISSSchema>;

export const IND_ISS_LABELS: Record<IndISS, string> = {
  '1': '1 - Exigível',
  '2': '2 - Não incidência',
  '3': '3 - Isenção',
  '4': '4 - Exportação',
  '5': '5 - Imunidade',
  '6': '6 - Exigibilidade Suspensa por Decisão Judicial',
  '7': '7 - Exigibilidade Suspensa por Processo Administrativo',
};

/** indIncentivo — Indicador de incentivo fiscal (1=sim, 2=não). */
export const indIncentivoSchema = z.enum(['1', '2']);
export type IndIncentivo = z.infer<typeof indIncentivoSchema>;

export const IND_INCENTIVO_LABELS: Record<IndIncentivo, string> = {
  '1': '1 - Sim',
  '2': '2 - Não',
};

// ---------------------------------------------------------------------------
// CSOSN sub-configs (mirror Flutter confICMSSN* classes) — Simples Nacional
// ---------------------------------------------------------------------------

/** confICMSSN101 — CSOSN 101 (com permissão de crédito). */
export const confICMSSN101Schema = z.object({
  pCredSN: z.number().nonnegative(),
  vCredICMSSN: z.number().nonnegative(),
});
export type ConfICMSSN101 = z.infer<typeof confICMSSN101Schema>;

/** confICMSSN201 — CSOSN 201 (com crédito + ST). */
export const confICMSSN201Schema = z.object({
  pCredSN: z.number().nonnegative(),
  vCredICMSSN: z.number().nonnegative(),
  modBCST: modBCSTSchema,
  pMVAST: z.number().nonnegative().optional().nullable(),
  pRedBCST: z.number().nonnegative().optional().nullable(),
  vBCST: z.number().nonnegative(),
  pICMSST: z.number().nonnegative(),
  vICMSST: z.number().nonnegative(),
  vBCFCPST: z.number().nonnegative().optional().nullable(),
  pFCPST: z.number().nonnegative().optional().nullable(),
  vFCPST: z.number().nonnegative().optional().nullable(),
});
export type ConfICMSSN201 = z.infer<typeof confICMSSN201Schema>;

/** confICMSSN202ou203 — CSOSN 202 / 203 (ST sem crédito). */
export const confICMSSN202ou203Schema = z.object({
  modBCST: modBCSTSchema,
  pMVAST: z.number().nonnegative().optional().nullable(),
  pRedBCST: z.number().nonnegative().optional().nullable(),
  vBCST: z.number().nonnegative(),
  pICMSST: z.number().nonnegative(),
  vICMSST: z.number().nonnegative(),
  vBCFCPST: z.number().nonnegative().optional().nullable(),
  pFCPST: z.number().nonnegative().optional().nullable(),
  vFCPST: z.number().nonnegative().optional().nullable(),
});
export type ConfICMSSN202ou203 = z.infer<typeof confICMSSN202ou203Schema>;

/** confICMSSN500 — CSOSN 500 (ST já retido anteriormente). */
export const confICMSSN500Schema = z.object({
  vBCSTRet: z.number().nonnegative().optional().nullable(),
  pST: z.number().nonnegative().optional().nullable(),
  vICMSSubstituto: z.number().nonnegative().optional().nullable(),
  vICMSSTRet: z.number().nonnegative().optional().nullable(),
  vBCFCPSTRet: z.number().nonnegative().optional().nullable(),
  pFCPSTRet: z.number().nonnegative().optional().nullable(),
  vFCPSTRet: z.number().nonnegative().optional().nullable(),
  pRedBCEfet: z.number().nonnegative().optional().nullable(),
  vBCEfet: z.number().nonnegative().optional().nullable(),
  pICMSEfet: z.number().nonnegative().optional().nullable(),
  vICMSEfet: z.number().nonnegative().optional().nullable(),
});
export type ConfICMSSN500 = z.infer<typeof confICMSSN500Schema>;

/** confICMSSN900 — CSOSN 900 (kitchen sink). */
export const confICMSSN900Schema = z.object({
  modBC: modBCSchema.optional().nullable(),
  vBC: z.number().nonnegative().optional().nullable(),
  pRedBC: z.number().nonnegative().optional().nullable(),
  pICMS: z.number().nonnegative().optional().nullable(),
  vICMS: z.number().nonnegative().optional().nullable(),
  modBCST: modBCSTSchema.optional().nullable(),
  pMVAST: z.number().nonnegative().optional().nullable(),
  pRedBCST: z.number().nonnegative().optional().nullable(),
  vBCST: z.number().nonnegative().optional().nullable(),
  pICMSST: z.number().nonnegative().optional().nullable(),
  vICMSST: z.number().nonnegative().optional().nullable(),
  vBCFCPST: z.number().nonnegative().optional().nullable(),
  pFCPST: z.number().nonnegative().optional().nullable(),
  vFCPST: z.number().nonnegative().optional().nullable(),
  pCredSN: z.number().nonnegative().optional().nullable(),
  vCredICMSSN: z.number().nonnegative().optional().nullable(),
});
export type ConfICMSSN900 = z.infer<typeof confICMSSN900Schema>;

// ---------------------------------------------------------------------------
// CST sub-configs (mirror Flutter confICMS00…90 classes) — Regime Normal.
// Modelled for lossless storage round-trip; emission is Phase D (#312).
// ---------------------------------------------------------------------------

/** confICMS00 — CST 00 (tributada integralmente). */
export const confICMS00Schema = z.object({
  modBC: modBCSchema,
  vBC: z.number().nonnegative(),
  pICMS: z.number().nonnegative(),
  vICMS: z.number().nonnegative(),
  pFCP: z.number().nonnegative().optional().nullable(),
  vFCP: z.number().nonnegative().optional().nullable(),
});
export type ConfICMS00 = z.infer<typeof confICMS00Schema>;

/** confICMS10 — CST 10 (tributada + ST). */
export const confICMS10Schema = z.object({
  modBC: modBCSchema,
  vBC: z.number().nonnegative(),
  pICMS: z.number().nonnegative(),
  vICMS: z.number().nonnegative(),
  vBCFCP: z.number().nonnegative().optional().nullable(),
  pFCP: z.number().nonnegative().optional().nullable(),
  vFCP: z.number().nonnegative().optional().nullable(),
  modBCST: modBCSTSchema,
  pMVAST: z.number().nonnegative().optional().nullable(),
  pRedBCST: z.number().nonnegative().optional().nullable(),
  vBCST: z.number().nonnegative(),
  pICMSST: z.number().nonnegative(),
  vICMSST: z.number().nonnegative(),
  vBCFCPST: z.number().nonnegative().optional().nullable(),
  pFCPST: z.number().nonnegative().optional().nullable(),
  vFCPST: z.number().nonnegative().optional().nullable(),
});
export type ConfICMS10 = z.infer<typeof confICMS10Schema>;

/** confICMS20 — CST 20 (com redução de base de cálculo). */
export const confICMS20Schema = z.object({
  modBC: modBCSchema,
  pRedBC: z.number().nonnegative(),
  vBC: z.number().nonnegative(),
  pICMS: z.number().nonnegative(),
  vICMS: z.number().nonnegative(),
  vBCFCP: z.number().nonnegative().optional().nullable(),
  pFCP: z.number().nonnegative().optional().nullable(),
  vFCP: z.number().nonnegative().optional().nullable(),
  vICMSDeson: z.number().nonnegative().optional().nullable(),
  motDesICMS: motDesICMSSchema.optional().nullable(),
});
export type ConfICMS20 = z.infer<typeof confICMS20Schema>;

/** confICMS30 — CST 30 (isenta/não tributada + ST). */
export const confICMS30Schema = z.object({
  modBCST: modBCSTSchema,
  pMVAST: z.number().nonnegative().optional().nullable(),
  pRedBCST: z.number().nonnegative().optional().nullable(),
  vBCST: z.number().nonnegative(),
  pICMSST: z.number().nonnegative(),
  vICMSST: z.number().nonnegative(),
  vBCFCPST: z.number().nonnegative().optional().nullable(),
  pFCPST: z.number().nonnegative().optional().nullable(),
  vFCPST: z.number().nonnegative().optional().nullable(),
  vICMSDeson: z.number().nonnegative().optional().nullable(),
  motDesICMS: motDesICMSSchema.optional().nullable(),
});
export type ConfICMS30 = z.infer<typeof confICMS30Schema>;

/** confICMS404150 — CST 40 / 41 / 50 (isenta / não tributada / suspensão). */
export const confICMS404150Schema = z.object({
  vICMSDeson: z.number().nonnegative().optional().nullable(),
  motDesICMS: motDesICMSSchema.optional().nullable(),
});
export type ConfICMS404150 = z.infer<typeof confICMS404150Schema>;

/** confICMS51 — CST 51 (diferimento). */
export const confICMS51Schema = z.object({
  modBC: modBCSchema.optional().nullable(),
  pRedBC: z.number().nonnegative().optional().nullable(),
  vBC: z.number().nonnegative().optional().nullable(),
  pICMS: z.number().nonnegative().optional().nullable(),
  vICMSOp: z.number().nonnegative().optional().nullable(),
  pDif: z.number().nonnegative().optional().nullable(),
  vICMSDif: z.number().nonnegative().optional().nullable(),
  vICMS: z.number().nonnegative().optional().nullable(),
  vBCFCP: z.number().nonnegative().optional().nullable(),
  pFCP: z.number().nonnegative().optional().nullable(),
  vFCP: z.number().nonnegative().optional().nullable(),
});
export type ConfICMS51 = z.infer<typeof confICMS51Schema>;

/** confICMS60 — CST 60 (ICMS cobrado anteriormente por ST). */
export const confICMS60Schema = z.object({
  vBCSTRet: z.number().nonnegative().optional().nullable(),
  pST: z.number().nonnegative().optional().nullable(),
  vICMSSubstituto: z.number().nonnegative().optional().nullable(),
  vICMSSTRet: z.number().nonnegative().optional().nullable(),
  vBCFCPSTRet: z.number().nonnegative().optional().nullable(),
  pFCPSTRet: z.number().nonnegative().optional().nullable(),
  vFCPSTRet: z.number().nonnegative().optional().nullable(),
  pRedBCEfet: z.number().nonnegative().optional().nullable(),
  vBCEfet: z.number().nonnegative().optional().nullable(),
  pICMSEfet: z.number().nonnegative().optional().nullable(),
  vICMSEfet: z.number().nonnegative().optional().nullable(),
});
export type ConfICMS60 = z.infer<typeof confICMS60Schema>;

/** confICMS70 — CST 70 (redução de BC + ST). */
export const confICMS70Schema = z.object({
  modBC: modBCSchema,
  pRedBC: z.number().nonnegative(),
  vBC: z.number().nonnegative(),
  pICMS: z.number().nonnegative(),
  vICMS: z.number().nonnegative(),
  vBCFCP: z.number().nonnegative().optional().nullable(),
  pFCP: z.number().nonnegative().optional().nullable(),
  vFCP: z.number().nonnegative().optional().nullable(),
  modBCST: modBCSTSchema,
  pMVAST: z.number().nonnegative().optional().nullable(),
  pRedBCST: z.number().nonnegative().optional().nullable(),
  vBCST: z.number().nonnegative(),
  pICMSST: z.number().nonnegative(),
  vICMSST: z.number().nonnegative(),
  vBCFCPST: z.number().nonnegative().optional().nullable(),
  pFCPST: z.number().nonnegative().optional().nullable(),
  vFCPST: z.number().nonnegative().optional().nullable(),
  vICMSDeson: z.number().nonnegative().optional().nullable(),
  motDesICMS: motDesICMSSchema.optional().nullable(),
});
export type ConfICMS70 = z.infer<typeof confICMS70Schema>;

/** confICMS90 — CST 90 (outras). */
export const confICMS90Schema = z.object({
  modBC: modBCSchema.optional().nullable(),
  vBC: z.number().nonnegative().optional().nullable(),
  pRedBC: z.number().nonnegative().optional().nullable(),
  pICMS: z.number().nonnegative().optional().nullable(),
  vICMS: z.number().nonnegative().optional().nullable(),
  vBCFCP: z.number().nonnegative().optional().nullable(),
  pFCP: z.number().nonnegative().optional().nullable(),
  vFCP: z.number().nonnegative().optional().nullable(),
  modBCST: modBCSTSchema.optional().nullable(),
  pMVAST: z.number().nonnegative().optional().nullable(),
  pRedBCST: z.number().nonnegative().optional().nullable(),
  vBCST: z.number().nonnegative().optional().nullable(),
  pICMSST: z.number().nonnegative().optional().nullable(),
  vICMSST: z.number().nonnegative().optional().nullable(),
  vBCFCPST: z.number().nonnegative().optional().nullable(),
  pFCPST: z.number().nonnegative().optional().nullable(),
  vFCPST: z.number().nonnegative().optional().nullable(),
  vICMSDeson: z.number().nonnegative().optional().nullable(),
  motDesICMS: motDesICMSSchema.optional().nullable(),
});
export type ConfICMS90 = z.infer<typeof confICMS90Schema>;

// ---------------------------------------------------------------------------
// ConfiguracaoICMS — mirror of the Flutter class (SN + Regime Normal surface)
// ---------------------------------------------------------------------------

/**
 * Mirror of `ConfiguracaoICMS` (`.old/.../operacao_fiscal/models.dart:712`).
 * Carries `crt`, the active `csosn` (SN) **or** `cst` (Regime Normal) code, and
 * exactly one matching sub-config. The NF-e dispatcher emits the SN groups and
 * throws on Regime Normal (Phase D, #312) — the `cst*`/`icms*` slots exist for
 * lossless storage round-trip of Flutter-authored docs.
 */
export const configuracaoICMSSchema = z.object({
  crt: crtSchema,
  csosn: csosnSchema.nullable(),
  cst: cstSchema.nullable().optional(),
  // Simples Nacional
  csosn101: confICMSSN101Schema.optional().nullable(),
  csosn201: confICMSSN201Schema.optional().nullable(),
  csosn202ou203: confICMSSN202ou203Schema.optional().nullable(),
  csosn500: confICMSSN500Schema.optional().nullable(),
  csosn900: confICMSSN900Schema.optional().nullable(),
  // Regime Normal (Flutter wire keys: icms00, icms10, … icms90)
  icms00: confICMS00Schema.optional().nullable(),
  icms10: confICMS10Schema.optional().nullable(),
  icms20: confICMS20Schema.optional().nullable(),
  icms30: confICMS30Schema.optional().nullable(),
  icms404150: confICMS404150Schema.optional().nullable(),
  icms51: confICMS51Schema.optional().nullable(),
  icms60: confICMS60Schema.optional().nullable(),
  icms70: confICMS70Schema.optional().nullable(),
  icms90: confICMS90Schema.optional().nullable(),
});
export type ConfiguracaoICMS = z.infer<typeof configuracaoICMSSchema>;

// ---------------------------------------------------------------------------
// confPIS + confCOFINS + ConfiguracaoPISST — mirror of the Flutter classes
// ---------------------------------------------------------------------------

export const confPISSchema = z.object({
  CST: cstPisCofinsSchema,
  pPIS: z.number().nonnegative().optional().nullable(),
  vAliqProd: z.number().nonnegative().optional().nullable(),
});
export type ConfPIS = z.infer<typeof confPISSchema>;

export const confCOFINSSchema = z.object({
  CST: cstPisCofinsSchema,
  pCOFINS: z.number().nonnegative().optional().nullable(),
  vAliqProd: z.number().nonnegative().optional().nullable(),
});
export type ConfCOFINS = z.infer<typeof confCOFINSSchema>;

/**
 * ConfiguracaoPISST — PIS por substituição tributária
 * (`.old/.../operacao_fiscal/models.dart`). `compoeTotalNota` flags whether the
 * value rolls up into the NF-e total. Legacy/back-compat only — the SN engine
 * consumes `confPIS` + `confCOFINS`, not PIS-ST.
 */
export const configuracaoPISSTSchema = z.object({
  compoeTotalNota: z.boolean(),
  pPIS: z.number().nonnegative().optional().nullable(),
  vAliqProd: z.number().nonnegative().optional().nullable(),
});
export type ConfiguracaoPISST = z.infer<typeof configuracaoPISSTSchema>;

// ---------------------------------------------------------------------------
// configuracaoIPI — mirror of the Flutter class (per-item IPI)
// ---------------------------------------------------------------------------

/** IPI CST codes — XSD `IPITrib` (tributado) + `IPINT` (não tributado). */
export const cstIpiSchema = z.enum([
  '00',
  '01',
  '02',
  '03',
  '04',
  '05',
  '49',
  '50',
  '51',
  '52',
  '53',
  '54',
  '55',
  '99',
]);
export type CstIpi = z.infer<typeof cstIpiSchema>;

export const CST_IPI_LABELS: Record<CstIpi, string> = {
  '00': '00 - Entrada com recuperação de crédito',
  '01': '01 - Entrada tributada com alíquota zero',
  '02': '02 - Entrada isenta',
  '03': '03 - Entrada não-tributada',
  '04': '04 - Entrada imune',
  '05': '05 - Entrada com suspensão',
  '49': '49 - Outras entradas',
  '50': '50 - Saída tributada',
  '51': '51 - Saída tributada com alíquota zero',
  '52': '52 - Saída isenta',
  '53': '53 - Saída não-tributada',
  '54': '54 - Saída imune',
  '55': '55 - Saída com suspensão',
  '99': '99 - Outras saídas',
};

/** The set of CSTs that emit `<IPITrib>`; the rest emit `<IPINT>`. */
export const IPI_TRIB_CSTS = new Set<CstIpi>(['00', '49', '50', '99']);

/**
 * Mirror of the Flutter `ConfiguracaoIPI` slot on Imposto. `cEnq` is XSD-
 * required (1–3 chars — Código de Enquadramento Legal, typically `'999'`); a
 * single CST picks the `<IPITrib>` vs `<IPINT>` wire variant. Tributado fields
 * stay optional (the builder enforces `vIPI` when the CST is IPITrib).
 */
export const configuracaoIPISchema = z.object({
  cEnq: z.string().min(1).max(3),
  CST: cstIpiSchema,
  vBC: z.number().nonnegative().optional().nullable(),
  pIPI: z.number().nonnegative().optional().nullable(),
  qUnid: z.number().nonnegative().optional().nullable(),
  vUnid: z.number().nonnegative().optional().nullable(),
  vIPI: z.number().nonnegative().optional().nullable(),
});
export type ConfiguracaoIPI = z.infer<typeof configuracaoIPISchema>;

// ---------------------------------------------------------------------------
// configuracaoISSQN — mirror of the Flutter class (per-item ISSQN, services)
// ---------------------------------------------------------------------------

/**
 * Mirror of the Flutter `ConfiguracaoISSQN`. Driven by the XSD `<ISSQN>` shape.
 * The XSD makes `<imposto>` carry **either** `<ICMS>` **or** `<ISSQN>`
 * (xs:choice) — the dispatcher emits `<ISSQN>` and skips `<ICMS>` when set.
 */
export const configuracaoISSQNSchema = z.object({
  vBC: z.number().nonnegative(),
  vAliq: z.number().nonnegative(),
  vISSQN: z.number().nonnegative(),
  cMunFG: z.string().regex(/^\d{7}$/),
  cListServ: z.string().regex(/^\d{2}\.\d{2}$|^\d{4,5}$/),
  vDeducao: z.number().nonnegative().optional().nullable(),
  vOutro: z.number().nonnegative().optional().nullable(),
  vDescIncond: z.number().nonnegative().optional().nullable(),
  vDescCond: z.number().nonnegative().optional().nullable(),
  vISSRet: z.number().nonnegative().optional().nullable(),
  indISS: indISSSchema,
  cServico: z.string().min(1).max(20).optional().nullable(),
  cMun: z
    .string()
    .regex(/^\d{7}$/)
    .optional()
    .nullable(),
  cPais: z
    .string()
    .regex(/^\d{1,4}$/)
    .optional()
    .nullable(),
  nProcesso: z.string().min(1).max(30).optional().nullable(),
  indIncentivo: indIncentivoSchema,
});
export type ConfiguracaoISSQN = z.infer<typeof configuracaoISSQNSchema>;

// ---------------------------------------------------------------------------
// retencao — per-item retention values (rolled up into <total><retTrib>)
// ---------------------------------------------------------------------------

export const retencaoSchema = z.object({
  vBCPIS: z.number().nonnegative().optional().nullable(),
  vRetPIS: z.number().nonnegative().optional().nullable(),
  vBCCOFINS: z.number().nonnegative().optional().nullable(),
  vRetCOFINS: z.number().nonnegative().optional().nullable(),
  vBCCSLL: z.number().nonnegative().optional().nullable(),
  vRetCSLL: z.number().nonnegative().optional().nullable(),
  vBCIRRF: z.number().nonnegative().optional().nullable(),
  vIRRF: z.number().nonnegative().optional().nullable(),
  vBCRetPrev: z.number().nonnegative().optional().nullable(),
  vRetPrev: z.number().nonnegative().optional().nullable(),
});
export type Retencao = z.infer<typeof retencaoSchema>;

// ---------------------------------------------------------------------------
// configuracaoIBSCBS — Reforma Tributária do Consumo (RTC) item-level input
// ---------------------------------------------------------------------------

/**
 * RTC `IS` (Imposto Seletivo) per-item sub-config. `pIS` (ad valorem over a
 * base) OR `pISEspec` (per unit, with `qTrib`) drives the value.
 */
export const configuracaoISRtcSchema = z
  .object({
    CSTIS: z.string().regex(/^\d{3}$/),
    cClassTribIS: z.string().regex(/^\d{6}$/),
    vBCIS: z.number().nonnegative().optional().nullable(),
    pIS: z.number().nonnegative().optional().nullable(),
    pISEspec: z.number().nonnegative().optional().nullable(),
    uTrib: z.string().min(1).max(6).optional().nullable(),
    qTrib: z.number().nonnegative().optional().nullable(),
  })
  .superRefine((cfg, ctx) => {
    const adValorem = cfg.pIS != null;
    const perUnit = cfg.pISEspec != null && cfg.qTrib != null;
    if (!adValorem && !perUnit) {
      ctx.addIssue({
        code: 'custom',
        message: 'IS requires either pIS (ad valorem) or pISEspec + qTrib (per unit)',
      });
    }
  });
export type ConfiguracaoISRtc = z.infer<typeof configuracaoISRtcSchema>;

/**
 * `configuracaoIBSCBS` — per-item **Reforma Tributária (IBS/CBS/IS)** input
 * (NT 2025.002). Only the "tributação integral" shape is modelled (CST +
 * cClassTrib + the three alíquotas). `vBC` defaults to the item `vProd` when
 * null (Simples Nacional posture). The IBS portion is split UF + Município.
 */
export const configuracaoIBSCBSSchema = z.object({
  CST: z.string().regex(/^\d{3}$/),
  cClassTrib: z.string().regex(/^\d{6}$/),
  vBC: z.number().nonnegative().optional().nullable(),
  pIBSUF: z.number().nonnegative(),
  pIBSMun: z.number().nonnegative(),
  pCBS: z.number().nonnegative(),
  is: configuracaoISRtcSchema.optional().nullable(),
});
export type ConfiguracaoIBSCBS = z.infer<typeof configuracaoIBSCBSSchema>;

// ---------------------------------------------------------------------------
// Top-level Imposto — what `pedido.itens[i].imposto` should be
// ---------------------------------------------------------------------------

/**
 * The per-item `Imposto` blob (Flutter `Imposto`,
 * `.old/packages/produtos/lib/src/models.dart`). The tribute engine uses
 * `origem` + `configuracao*`; the other fields (`cfop`, `NCM`, …) are stamped so
 * the orchestrator can read everything-fiscal from one blob.
 *
 * `configuracaoIBSCBS` is held **leniently** (`z.unknown`) so a half-filled RTC
 * blob never fails the whole imposto parse — the resolver falls through to the
 * next tier on any parse failure, and RTC is opt-in per-filial. The strict shape
 * is `configuracaoIBSCBSSchema`, enforced at emit by `parseRtcConfig`.
 */
export const impostoSchema = z.object({
  origem: origemSchema,
  cfop: z
    .string()
    .regex(/^\d{4}$/)
    .optional()
    .nullable(),
  cfopInterestadual: z
    .string()
    .regex(/^\d{4}$/)
    .optional()
    .nullable(),
  NCM: z
    .string()
    .regex(/^\d{8}$/)
    .optional()
    .nullable(),
  CEST: z
    .string()
    .regex(/^\d{7}$/)
    .optional()
    .nullable(),
  unidade: z.string().min(1).max(6).optional().nullable(),
  configuracaoICMS: configuracaoICMSSchema.optional().nullable(),
  configuracaoISSQN: configuracaoISSQNSchema.optional().nullable(),
  configuracaoPIS: confPISSchema.optional().nullable(),
  configuracaoCOFINS: confCOFINSSchema.optional().nullable(),
  configuracaoIPI: configuracaoIPISchema.optional().nullable(),
  retencao: retencaoSchema.optional().nullable(),
  configuracaoIBSCBS: z.unknown().nullable().optional(),
});
export type Imposto = z.infer<typeof impostoSchema>;

/**
 * The shared `configuracao*` field set carried by every Imposto-bearing
 * **stored** doc (`operacao`, `produtos/{}/imposto`,
 * `categorias/{}/impostocategoria`, `operacao/{}/regraimposto`). Spread into each
 * collection schema so the deep tax config is **typed** (no `z.unknown` /
 * `.passthrough`) while keeping each doc's own Dados Gerais + scope fields.
 *
 * `.nullable().optional()` — an Imposto-bearing doc may omit any config entirely
 * (the resolver/editor tolerate absent + null), matching the original
 * pass-through semantics. The editor only ever writes a config object or `null`,
 * never `undefined`, so this is safe for Firebase JS SDK v12.
 * `configuracaoIBSCBS` stays lenient (`z.unknown`) — a half-filled RTC blob must
 * not fail the whole imposto parse and disable the resolver fall-through; the
 * strict shape (`configuracaoIBSCBSSchema`) is enforced at emit by `parseRtcConfig`.
 */
export const taxConfigFields = {
  configuracaoICMS: configuracaoICMSSchema.nullable().optional(),
  configuracaoIPI: configuracaoIPISchema.nullable().optional(),
  configuracaoPIS: confPISSchema.nullable().optional(),
  configuracaoCOFINS: confCOFINSSchema.nullable().optional(),
  configuracaoPISST: configuracaoPISSTSchema.nullable().optional(),
  configuracaoISSQN: configuracaoISSQNSchema.nullable().optional(),
  retencao: retencaoSchema.nullable().optional(),
  configuracaoIBSCBS: z.unknown().nullable().optional(),
} as const;
