/**
 * Reforma Tributária do Consumo (RTC) — IBS / CBS / IS builders.
 *
 * Emits the NT 2025.002 **item-level** `IBSCBS` (Grupo UB) + optional `IS`
 * groups, and exposes the per-item value computation reused by the `<total>`
 * aggregator (`total.ts`) so the item and the total never drift.
 *
 * Scope: the **"tributação integral"** shape — CST + cClassTrib + the IBS-UF /
 * IBS-Município / CBS alíquotas. Diferimento / redução / monofásica / crédito
 * presumido subgroups are out of scope (future NT-driven follow-up). The
 * CST/cClassTrib codes are caller-supplied (the Anexo III/IV tables are
 * Portal-published, not vendored). See
 * `.claude/skills/nfe/references/rtc-ibs-cbs-is.md`.
 *
 * Per the wire codegen (`nfe-schema.ts`), `IS` and `IBSCBS` are **sibling**
 * slots under `det/imposto` (not nested), so the dispatcher attaches each
 * independently.
 */
import { fmtMoney, fmtQuantity, fmtRate, roundReais } from './format';
import {
  configuracaoIBSCBSSchema,
  type ConfiguracaoIBSCBS,
  type ConfiguracaoISRtc,
} from './schemas';
import type { TIS, TTribNFe } from '../types/nfe-schema';

/**
 * Strict-parse a stored `configuracaoIBSCBS` blob (held as `z.unknown` on
 * `impostoSchema`) into the typed RTC config. Throws a clear error when RTC
 * emission is on for an item but its registered config is incomplete/invalid —
 * surfaced to the operator at emit time, never silently emitting bad values.
 */
export function parseRtcConfig(raw: unknown): ConfiguracaoIBSCBS {
  const result = configuracaoIBSCBSSchema.safeParse(raw);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  throw new Error(
    `Invalid configuracaoIBSCBS (RTC emission is on for this item): ` +
      `${first?.path.join('.') ?? '(root)'} — ${first?.message ?? 'parse failed'}`,
  );
}

/** Per-item RTC monetary values — single source of truth for item + total. */
export interface RtcItemValues {
  readonly vBC: number;
  readonly vIBSUF: number;
  readonly vIBSMun: number;
  readonly vIBS: number;
  readonly vCBS: number;
  readonly vIS: number;
}

/**
 * Compute the per-item IBS/CBS/IS values from the config + the line total.
 * `vBC` defaults to `vProd` (Simples Nacional posture). Each value is rounded
 * half-up at 2dp via `roundReais`, matching the PIS/COFINS path.
 */
export function computeRtcItemValues(cfg: ConfiguracaoIBSCBS, vProd: number): RtcItemValues {
  const vBC = cfg.vBC ?? vProd;
  const vIBSUF = roundReais((vBC * cfg.pIBSUF) / 100);
  const vIBSMun = roundReais((vBC * cfg.pIBSMun) / 100);
  const vIBS = roundReais(vIBSUF + vIBSMun);
  const vCBS = roundReais((vBC * cfg.pCBS) / 100);
  // IS has its own base (`vBCIS`); the fallback is the item line value, not the
  // IBS/CBS `vBC` override — keep them independent.
  const vIS = cfg.is != null ? computeIS(cfg.is, vProd) : 0;
  return { vBC, vIBSUF, vIBSMun, vIBS, vCBS, vIS };
}

/**
 * IS value: ad valorem (`pIS` over a base) takes precedence; otherwise per-unit
 * (`pISEspec × qTrib`). Returns 0 when neither is configured.
 */
function computeIS(cfg: ConfiguracaoISRtc, vBCFallback: number): number {
  if (cfg.pIS != null) {
    const base = cfg.vBCIS ?? vBCFallback;
    return roundReais((base * cfg.pIS) / 100);
  }
  if (cfg.pISEspec != null && cfg.qTrib != null) {
    return roundReais(cfg.pISEspec * cfg.qTrib);
  }
  return 0;
}

/** Build the item-level `<IBSCBS>` (Grupo UB) wire value. */
export function buildIBSCBS(cfg: ConfiguracaoIBSCBS, vProd: number): TTribNFe {
  const v = computeRtcItemValues(cfg, vProd);
  return {
    CST: cfg.CST,
    cClassTrib: cfg.cClassTrib,
    gIBSCBS: {
      vBC: fmtMoney('IBSCBS.vBC', v.vBC),
      gIBSUF: {
        pIBSUF: fmtRate('pIBSUF', cfg.pIBSUF),
        vIBSUF: fmtMoney('vIBSUF', v.vIBSUF),
      },
      gIBSMun: {
        pIBSMun: fmtRate('pIBSMun', cfg.pIBSMun),
        vIBSMun: fmtMoney('vIBSMun', v.vIBSMun),
      },
      vIBS: fmtMoney('vIBS', v.vIBS),
      gCBS: {
        pCBS: fmtRate('pCBS', cfg.pCBS),
        vCBS: fmtMoney('vCBS', v.vCBS),
      },
    },
  };
}

/**
 * Build the optional item-level `<IS>` (Imposto Seletivo) wire value. The XSD
 * sequence is a choice: ad valorem (`vBCIS` + `pIS` + `vIS`) OR per-unit
 * (`pISEspec` + `uTrib` + `qTrib` + `vIS`). `vBCIS` defaults to the item line
 * value (`vProd`) in the ad valorem path.
 */
export function buildIS(cfg: ConfiguracaoISRtc, vProd: number): TIS {
  const out: TIS = {
    CSTIS: cfg.CSTIS,
    cClassTribIS: cfg.cClassTribIS,
  };
  if (cfg.pIS != null) {
    const vBCIS = cfg.vBCIS ?? vProd;
    out.vBCIS = fmtMoney('vBCIS', vBCIS);
    out.pIS = fmtRate('pIS', cfg.pIS);
    out.vIS = fmtMoney('vIS', roundReais((vBCIS * cfg.pIS) / 100));
  } else if (cfg.pISEspec != null && cfg.qTrib != null) {
    out.pISEspec = fmtRate('pISEspec', cfg.pISEspec);
    if (cfg.uTrib != null) out.uTrib = cfg.uTrib;
    out.qTrib = fmtQuantity('qTrib', cfg.qTrib);
    out.vIS = fmtMoney('vIS', roundReais(cfg.pISEspec * cfg.qTrib));
  } else {
    // `configuracaoISRtcSchema`'s refine guarantees one mode is present; this
    // is a defensive backstop so `buildIS` can never emit a valueless `<IS>`.
    throw new Error('buildIS: IS requires pIS (ad valorem) or pISEspec + qTrib (per unit)');
  }
  return out;
}

/**
 * 2025–2026 RTC **test** alíquotas (per NT 2025.002 RV UB18-10 / UB56-10:
 * pIBSUF 0,1% and pCBS 0,9% in the transition years). A convenience for
 * fixtures/defaults — real rates always come from the registered config.
 * Years ≥ 2027 use the 0,05% reference; later years are TBD by SEFAZ.
 */
export function rtcTestRatesForYear(year: number): {
  pIBSUF: number;
  pIBSMun: number;
  pCBS: number;
} {
  if (year <= 2026) return { pIBSUF: 0.1, pIBSMun: 0, pCBS: 0.9 };
  return { pIBSUF: 0.05, pIBSMun: 0, pCBS: 0.9 };
}
