import { db, namespace } from './admin';

async function main() {
  const ns = namespace();
  const ref = db().collection(`${ns}_grupoEconomico`);
  await ref.doc('seed').set({
    uid: 'seed',
    nome: 'E2E Seed Tenant',
    ativo: true,
    criadoEm: new Date().toISOString(),
  });
  // eslint-disable-next-line no-console
  console.log(`[seed] wrote ${ns}_grupoEconomico/seed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
