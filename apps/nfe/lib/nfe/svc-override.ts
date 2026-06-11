/**
 * Homologação-only dev override of the SVC authorizer.
 *
 * Each UF is legally bound to exactly one SVC (Ato COTEPE 39/2012) — SP to
 * SVC-AN. The knob lets homologação exercise EITHER SVC transport regardless
 * of that binding, so both lanes (chain vendoring, mutual TLS, each SVC's
 * SOAP paths, response parsing) can be live-tested from a single issuer —
 * the off-binding SVC answers with an application-level rejection (cStat 410
 * "UF não atendida"), and that round-trip is the point.
 *
 * Never honored in produção: a real contingency must hit the UF's bound
 * authorizer, so a produção process with the variable set fails loudly
 * instead of silently misrouting fiscal documents.
 */
import type { Ambiente } from './runtime';

export type SvcAuthorizer = 'svc-an' | 'svc-rs';

export function svcAuthorizerOverride(
  ambiente: Ambiente,
  env: Readonly<Record<string, string | undefined>> = process.env,
): SvcAuthorizer | undefined {
  const raw = env.NFE_SVC_AUTHORIZER_OVERRIDE;
  if (raw === undefined || raw === '') return undefined;
  if (raw !== 'svc-an' && raw !== 'svc-rs') {
    throw new Error(`NFE_SVC_AUTHORIZER_OVERRIDE must be 'svc-an' or 'svc-rs', got '${raw}'`);
  }
  if (ambiente !== 'homologacao') {
    throw new Error(
      'NFE_SVC_AUTHORIZER_OVERRIDE is homologação-only — a produção contingency ' +
        "must hit the UF's legally bound SVC (Ato COTEPE 39/2012). Unset the variable.",
    );
  }
  return raw;
}
