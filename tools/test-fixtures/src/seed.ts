import { db, namespace } from './admin';

/**
 * Idempotent seed for the e2e tenant. Lives in a namespaced collection so
 * parallel runs don't trample each other. Callable as a function (from
 * Playwright's globalSetup) or via the `pnpm seed` CLI script below.
 */
export async function seed(): Promise<{ namespace: string }> {
  const ns = namespace();
  const ref = db().collection(`${ns}_grupoEconomico`);
  await ref.doc('seed').set({
    uid: 'seed',
    nome: 'E2E Seed Tenant',
    ativo: true,
    criadoEm: new Date().toISOString(),
  });
  return { namespace: ns };
}

// Invoked via `tsx src/seed.ts` (see package.json scripts).
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('seed.ts') ||
  process.argv[1]?.endsWith('seed.js');

if (isDirectInvocation) {
  seed()
    .then(({ namespace: ns }) => {
      // eslint-disable-next-line no-console
      console.log(`[seed] wrote ${ns}_grupoEconomico/seed`);
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
