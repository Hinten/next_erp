/**
 * One-shot CLI driver for the NF-e orchestrator — calls `emitirPedido`
 * directly against Firestore + SEFAZ. Bypasses the HTTP `/api/nfe/emitir`
 * route and its auth/permission layer, so it's only useful for local /
 * staging dev (the same env the seed scripts target).
 *
 * Usage (from the repo root):
 *   pnpm --filter @delfrance/nfe-app emit:dev-pedido            # defaults to dev-pedidos-01
 *   pnpm --filter @delfrance/nfe-app emit:dev-pedido PED-12345  # specific id
 *
 * Requires the same env the apps/nfe dev server needs: FIREBASE_*,
 * NFE_AMBIENTE, NFE_UF, NFE_CERT_PATH (+ NFE_CERT_PASSWORD), plus the
 * vendored SEFAZ TLS chain at
 * `packages/integrations/nfe/ca/sefaz-<uf>-<ambiente>.pem`.
 */
import { getAdminFirestore } from '../lib/firebase/admin';
import { emitirPedido } from '../lib/nfe/orchestrator';
import { getNFeRuntime } from '../lib/nfe/runtime';

async function main(): Promise<void> {
  const pedidoId = process.argv[2] ?? 'dev-pedidos-01';
  console.log(`[emit-dev-pedido] starting — pedidoId=${pedidoId}`);

  const fs = getAdminFirestore();
  const base = getNFeRuntime();
  // The env cert is now only the fallback — when none is configured the per-filial
  // cert is resolved at emission, so there is no transmitter CN to log here.
  const env = base.envRuntime();
  console.log(
    `[emit-dev-pedido] runtime ready — ambiente=${base.ambiente} uf=${base.uf} ` +
      `cert=${env?.diagnostics.subjectCommonName ?? '(per-filial)'} ` +
      `chain=${env?.diagnostics.chainSource ?? '(per-filial)'}`,
  );

  const result = await emitirPedido(fs, base, pedidoId);
  console.log('[emit-dev-pedido] result:', JSON.stringify(result, null, 2));

  if (result.cStat === '100') {
    console.log('[emit-dev-pedido] ✓ SEFAZ accepted (cStat=100)');
    return;
  }
  console.error(
    `[emit-dev-pedido] ✗ SEFAZ did NOT accept — cStat=${result.cStat} ${result.xMotivo}`,
  );
  process.exit(2);
}

main().catch((err: unknown) => {
  console.error('[emit-dev-pedido] FAILED:', err);
  process.exit(1);
});
