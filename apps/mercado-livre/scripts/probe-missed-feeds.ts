/**
 * #1292: inspect the provider contract without enqueuing or changing ML config.
 * pnpm --filter @delfrance/mercado-livre-app probe:missed-feeds --project <id>
 * Supply runtime credentials externally. No dotenv file is loaded by this command.
 * Token refresh MAY update the selected integration's tokenDuravel credential.
 * Empty pages do not prove whether unfiltered requests include items.
 */
import { getAdminFirestore } from '../lib/firebase/admin';
import { missedFeedsSites } from '../lib/marketplace/notificacoes/missedFeedsAccess';
import { probeMissedFeedsAccounts } from '../lib/marketplace/notificacoes/missedFeedsProbe';
import { missedFeedsErrorCode } from '../lib/marketplace/notificacoes/missedFeedsSweep';

class ProbeArgumentError extends Error {}
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--project' || !args[1]?.trim()) {
  throw new ProbeArgumentError('Usage: probe:missed-feeds --project <id>');
}
const project = args[1].trim();
if (process.env.FIREBASE_PROJECT_ID !== project) {
  throw new ProbeArgumentError('--project must match the explicitly exported FIREBASE_PROJECT_ID.');
}
const appId = (process.env.MERCADO_LIVRE_CLIENT_ID ?? '').trim();
if (!/^[1-9]\d*$/.test(appId)) throw new ProbeArgumentError('MERCADO_LIVRE_CLIENT_ID is required.');
const site = missedFeedsSites()[0]!;
const deadline = performance.now() + 120_000;
try {
  const result = await probeMissedFeedsAccounts(getAdminFirestore(), appId, site, () => {
    if (performance.now() >= deadline)
      throw new ProbeArgumentError('Probe discovery budget exhausted.');
  });
  // eslint-disable-next-line no-console -- intentional, sanitized diagnostic output
  console.log(
    JSON.stringify(
      {
        project,
        appId,
        site,
        ...result,
        note: 'Empty pages cannot establish items coverage. No notifications were enqueued.',
      },
      null,
      2,
    ),
  );
  if (result.selectedIntegracaoId == null) process.exitCode = 1;
} catch (err) {
  const code = missedFeedsErrorCode(err);
  if (code == null) throw err;
  // Do not let the CLI's uncaught-error printer serialize provider bodies.
  throw new ProbeArgumentError('Provider probe failed: ' + code);
}
