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
} from '@delfrance/schemas';

/**
 * Per-item value context the dispatcher needs alongside the Imposto rules.
 * Fed by the orchestrator from `ItemDoPedido` (price × quantity). Engine-
 * internal — not a stored shape, so it stays here rather than in schemas.
 */
export const tributeItemSchema = z.object({
  /** Pre-rounded item line total: `(precoDeVenda - desconto) × qCom`. */
  vProd: z.number().nonnegative(),
});
export type TributeItem = z.infer<typeof tributeItemSchema>;
