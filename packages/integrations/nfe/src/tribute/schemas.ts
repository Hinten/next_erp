/**
 * Tributary input schemas for the NF-e engine.
 *
 * The Flutter-shape Imposto + Configuracao* schemas are the **single source of
 * truth in `@delfrance/schemas`** (`src/imposto/tribute.ts`) so the browser
 * bundle (apps/web) can author them — the NF-e package is Node-only and can't be
 * imported from the web app. This module re-exports them so the engine builders
 * (`imposto.ts`, `rtc.ts`, `total.ts`) and the tribute barrel keep importing from
 * `./schemas` unchanged.
 *
 * Only `tributeItemSchema` (the per-item value context the dispatcher needs
 * alongside the rules — price × quantity) is engine-internal and defined here.
 *
 * **Scope**: Simples Nacional (CSOSN) + the optional RTC groups. Regime Normal
 * (CST 00/10/20/…) is Phase D — the dispatcher in `imposto.ts` throws a clear
 * "not implemented" error on `crt='3'`/`'4'`.
 *
 * The emission rules those configs must satisfy (the ICMS SN CSOSN/sub-config/
 * XSD-group choice and the PIS/COFINS group choice) are re-exported too: they
 * are decided, as verdicts, in `@delfrance/schemas`
 * (`src/imposto/regrasDeEmissao.ts`); `total.ts`'s ICMSTot roll-up still
 * mirrors the CSOSN-slot and ISSQN choices with its own checks.
 */
import { z } from 'zod';

export {
  // enums
  crtSchema,
  csosnSchema,
  cstSchema,
  modBCSchema,
  modBCSTSchema,
  origemSchema,
  cstPisCofinsSchema,
  cstIpiSchema,
  indISSSchema,
  indIncentivoSchema,
  IPI_TRIB_CSTS,
  // enum member constants — the only spelling of a SEFAZ code in engine code
  CRT,
  CSOSN,
  CST,
  MOD_BC,
  MOD_BCST,
  ORIGEM,
  CST_PIS_COFINS,
  CST_IPI,
  IND_ISS,
  IND_INCENTIVO,
  // ICMS + sub-configs
  configuracaoICMSSchema,
  // PIS / COFINS / IPI / ISSQN / retenção
  confPISSchema,
  confCOFINSSchema,
  configuracaoIPISchema,
  configuracaoISSQNSchema,
  retencaoSchema,
  // RTC
  configuracaoISRtcSchema,
  configuracaoIBSCBSSchema,
  // canonical per-item Imposto
  impostoSchema,
  // types
  type Crt,
  type Csosn,
  type Cst,
  type ModBC,
  type ModBCST,
  type Origem,
  type CstPisCofins,
  type CstIpi,
  type IndISS,
  type IndIncentivo,
  type ConfiguracaoICMS,
  type ConfPIS,
  type ConfCOFINS,
  type ConfiguracaoIPI,
  type ConfiguracaoISSQN,
  type Retencao,
  type ConfiguracaoISRtc,
  type ConfiguracaoIBSCBS,
  type Imposto,
  // The emission rules as verdicts (#1655): `imposto.ts` throws from them, and
  // the web imposto editor can check the same ones before a save.
  CRTS_SIMPLES_NACIONAL,
  ehCrtSimplesNacional,
  usaIssqn,
  SUBCONFIGS_ICMS_SN,
  SUBCONFIG_POR_CSOSN,
  GRUPO_XSD_FCP_ST,
  GRUPOS_XSD_ICMSSN500,
  GRUPOS_XSD_ICMSSN900,
  GRUPOS_XSD_POR_SUBCONFIG,
  vereditoIcmsSn,
  ALIQUOTA_PIS_COFINS_LIMITE,
  vereditoPisCofins,
  type CrtSimplesNacional,
  type SubConfigIcmsSn,
  type GrupoXsd,
  type GrupoXsdIncompleto,
  type IcmsSnEmitivel,
  type VereditoIcmsSn,
  type CstPisCofinsAliq,
  type CstPisCofinsQtde,
  type CstPisCofinsNT,
  type CstPisCofinsOutr,
  type BasePisCofinsOutr,
  type VereditoPisCofins,
} from '@delfrance/schemas';

/**
 * Per-item value context the dispatcher needs alongside the Imposto rules.
 * Fed by the orchestrator from `ItemDoPedido` (price × quantity). Engine-
 * internal — not a stored shape, so it stays here rather than in schemas.
 */
export const tributeItemSchema = z.object({
  /** Pre-rounded item line total: `(precoDeVenda - desconto) × qCom`. */
  vProd: z.number().nonnegative(),
  /**
   * The det's `<qTrib>` — the item quantity. It is the `qBCProd` ("Quantidade
   * Vendida", NT 2011/004) of the per-unit PIS/COFINS groups: PISQtde /
   * COFINSQtde (CST 03) and the `(qBCProd + vAliqProd)` branch of PISOutr /
   * COFINSOutr (CST 49–99). `nullish` because only a per-unit rate reads it —
   * a caller that configures one without passing the quantity gets an
   * `NFeTributeError` naming `qTrib`, never a silent `qBCProd` of 1.
   */
  qTrib: z.number().nonnegative().nullish(),
});
export type TributeItem = z.infer<typeof tributeItemSchema>;
