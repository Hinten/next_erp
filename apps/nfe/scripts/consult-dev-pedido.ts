/**
 * One-shot CLI driver for `consultarPedido` — queries SEFAZ via
 * `consSitNFe` for the stable `s${tpEmis}` nfev4 doc, applies the
 * outcome, persists the patch, and prints the resulting cStat.
 *
 * Use it after `emit:dev-pedido` returns a cStat=103 (lote recebido)
 * to poll SEFAZ until the protocol resolves (cStat=100 / authorized
 * or cStat=215+/rejected).
 *
 * Usage (from the repo root):
 *   pnpm --filter @delfrance/nfe-app consult:dev-pedido            # defaults to dev-pedidos-01
 *   pnpm --filter @delfrance/nfe-app consult:dev-pedido PED-12345  # specific id
 *
 * Requires the same env the apps/nfe dev server needs (FIREBASE_*,
 * NFE_AMBIENTE, NFE_UF) plus the vendored SEFAZ TLS chain
 * (`sefaz-<uf>-<ambiente>.pem`). The env A1 cert (`NFE_CERT_PATH` +
 * `NFE_CERT_PASSWORD`) is OPTIONAL — the consulta signs with the cert of the
 * filial that emitted the chave; the env cert is only the fallback.
 */
import { NFeCertError } from '@delfrance/integrations-nfe';

import { getAdminFirestore } from '../lib/firebase/admin';
import { consultarPedido } from '../lib/nfe/orchestrator';
import { getNFeRuntime, type NFeRuntime } from '../lib/nfe/runtime';

async function main(): Promise<void> {
  const pedidoId = process.argv[2] ?? 'dev-pedidos-01';
  console.log(`[consult-dev-pedido] starting — pedidoId=${pedidoId}`);

  const fs = getAdminFirestore();
  const base = getNFeRuntime();
  // The env cert is only the fallback — the consulta signs with the cert of the
  // filial that emitted the chave (resolved inside consultarPedido). A bad/absent
  // env cert must NOT abort the script, so guard the diagnostics read.
  let env: NFeRuntime | null = null;
  try {
    env = base.envRuntime();
  } catch (e) {
    if (!(e instanceof NFeCertError)) throw e;
  }
  console.log(
    `[consult-dev-pedido] runtime ready — ambiente=${base.ambiente} uf=${base.uf} ` +
      `cert=${env?.diagnostics.subjectCommonName ?? '(per-filial)'}`,
  );

  const result = await consultarPedido(fs, base, pedidoId);
  console.log('[consult-dev-pedido] result:', JSON.stringify(result, null, 2));

  if (result.cStat === '100' || result.cStat === '150') {
    console.log(`[consult-dev-pedido] ✓ SEFAZ authorized (cStat=${result.cStat})`);
    return;
  }
  if (result.cStat === '105') {
    console.log('[consult-dev-pedido] · still processing (cStat=105) — re-run later');
    return;
  }
  console.error(`[consult-dev-pedido] ✗ unexpected cStat=${result.cStat} ${result.xMotivo}`);
  process.exit(2);
}

main().catch((err: unknown) => {
  console.error('[consult-dev-pedido] FAILED:', err);
  process.exit(1);
});
