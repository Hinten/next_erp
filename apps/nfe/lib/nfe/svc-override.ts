/**
 * Homologação-only dev override of the SVC authorizer.
 *
 * Each UF is legally bound to exactly one SVC (Ato COTEPE 39/2012) — SP to
 * SVC-AN. But SEFAZ publishes the `*.svc.fazenda.gov.br` DNS records only
 * while an SVC activation window is open; outside one the host does not
 * resolve and the SVC lane cannot be exercised live at all. SVC-RS runs on
 * SVRS's permanent infrastructure (`nfe-homologacao.svrs.rs.gov.br`), so
 * redirecting the lane there is the only way to live-test the SVC transport
 * (chain vendoring, mutual TLS, SVRS SOAP paths, response parsing) before a
 * real activation. SVC-RS may still reject the nota at the application level
 * for a UF it does not serve — that round-trip is the point.
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
