/**
 * tpEmis-aware SEFAZ call routing.
 *
 * The emission lifecycle (autorizar → retAutorizacao → consulta →
 * cancelamento evento) must hit the authorizer that owns the NF-e's
 * `tpEmis`: the home SEFAZ for 1 (and 4 — the post-EPEC full NF-e goes to
 * the home SEFAZ), SVC-AN for 6, SVC-RS for 7. Centralizing the
 * `SefazCall` construction here keeps the per-mode URL+agent choice out of
 * the orchestrator bodies — call sites say *which service* they need, not
 * *where it lives*.
 */
import type { SefazCall, SvcServiceUrls, TpEmis } from '@delfrance/integrations-nfe';

import type { ContingencyTarget, NFeRuntime } from '../runtime';

/**
 * Services available on every authorizer (home SEFAZ and SVC alike).
 * Inutilização is deliberately NOT addressable through this helper — SVC
 * does not offer it, and number ranges always belong to the home SEFAZ.
 */
export type SefazService = keyof SvcServiceUrls;

/** Resolve the authorizer (URLs + mTLS agent) that owns a `tpEmis`. */
export function sefazTarget(rt: NFeRuntime, tpEmis: TpEmis): ContingencyTarget {
  if (tpEmis === 6) return rt.svc('svc-an');
  if (tpEmis === 7) return rt.svc('svc-rs');
  // 1 (normal), 4 (EPEC full NF-e) and the paper-form modes (2/5) all
  // authorize at the home SEFAZ.
  return { endpoints: rt.endpoints, agent: rt.agent };
}

/** Build the `SefazCall` for one service on the authorizer that owns `tpEmis`. */
export function sefazCallFor(rt: NFeRuntime, tpEmis: TpEmis, service: SefazService): SefazCall {
  const target = sefazTarget(rt, tpEmis);
  return {
    url: target.endpoints[service],
    cert: rt.cert,
    agent: target.agent,
    tpAmb: rt.tpAmb,
  };
}

/**
 * Read the `tpEmis` digit baked into a chave de acesso (position 35,
 * 0-based index 34) — for chave-only contexts (consulta by chave, the
 * pendentes poller) where no nfev4 doc field is at hand.
 */
export function tpEmisFromChave(chave: string): TpEmis {
  const digit = Number(chave[34]);
  if (!Number.isInteger(digit) || digit < 1 || digit > 9 || digit === 8) {
    throw new Error(`chave '${chave.slice(0, 6)}…' carries an invalid tpEmis digit '${chave[34]}'`);
  }
  return digit as TpEmis;
}
