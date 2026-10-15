/**
 * One-shot Mercado Livre freight reconciliation (#782, #1888).
 *
 * Enumerate ML account IDs through the existing indexed pagination, then read
 * current account and freight state. Apply uses the same transactional reconciler
 * as onIntegracaoMercadoLivreChanged; page snapshots and event clocks never reach
 * the write. A dry-run uses the same pure planner with fresh read-only snapshots,
 * so its preview is advisory when concurrent changes occur.
 *
 * Existing canonical or bare-reference freight records retain their IDs and
 * operator-owned configuration. Only new records use mercadoLivre-<accountId>.
 * An already-reconciled project writes nothing on another apply pass.
 *
 *   # dry run — reports what WOULD change, writes nothing
 *   pnpm --filter @delfrance/mercado-livre-app backfill:int-frete --project <id>
 *   # apply
 *   pnpm --filter @delfrance/mercado-livre-app backfill:int-frete --project <id> --apply
 *
 * --project is REQUIRED and never inferred. The authoritative production pass
 * belongs after import/index readiness in cutover Phase 2b (#1905, #1208), because
 * import fires no trigger and an earlier pass is superseded by legacy writes.
 */
import { getAdminFirestore } from '../lib/firebase/admin';
import { backfillIntFrete } from '../lib/marketplace/frete/backfillIntFrete';

function log(message: string): void {
  // eslint-disable-next-line no-console -- CLI progress output
  console.log(message);
}

class BackfillArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackfillArgError';
  }
}

function parseArgs(argv: readonly string[]): { projectId: string; apply: boolean } {
  let projectId: string | undefined;
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--apply') apply = true;
    else if (arg === '--project') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new BackfillArgError('--project requires a value.');
      }
      projectId = next;
      i += 1;
    } else if (arg.startsWith('--project=')) projectId = arg.slice('--project='.length);
    else throw new BackfillArgError(`Unknown argument: ${arg}`);
  }
  if (!projectId || projectId.trim().length === 0) {
    throw new BackfillArgError(
      '--project <id> is required. This backfill refuses to guess the target project.',
    );
  }
  return { projectId: projectId.trim(), apply };
}

async function main(): Promise<void> {
  const { projectId, apply } = parseArgs(process.argv.slice(2));
  // getAdminFirestore() resolves the project from env; pin it to the explicit flag
  // so the credentials and the target can't drift apart.
  process.env.FIREBASE_PROJECT_ID = projectId;
  const db = getAdminFirestore();

  log(`[backfill:int-frete] project=${projectId} mode=${apply ? 'APPLY' : 'DRY-RUN'}`);

  const { contas, totals } = await backfillIntFrete(db, {
    apply,
    onConta: (integracaoId, disposicao) => {
      log(
        `  ${integracaoId} → ${disposicao.action}${fmtDetalhe(disposicao.campos, disposicao.faltando)}`,
      );
    },
  });

  const resumo = Object.entries(totals)
    .map(([action, n]) => `${action}=${n}`)
    .join(' ');
  log(
    `[backfill:int-frete] done: ${contas} contas Mercado Livre — ${resumo || 'nenhuma'}. ` +
      `${apply ? 'APPLIED.' : 'DRY-RUN — no writes performed; preview is advisory under concurrent changes.'}`,
  );
}

function fmtDetalhe(campos?: string[], faltando?: string[]): string {
  const list = faltando ?? campos;
  return list && list.length > 0 ? ` [${list.join(', ')}]` : '';
}

await main();
