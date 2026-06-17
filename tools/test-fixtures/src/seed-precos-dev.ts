import { db } from './admin';

/**
 * Dev-seed for the produto "Preço e custo" tab — three `listaDePrecos` docs
 * exercising every engine path plus `custo`/`precos` on the `seed:variacoes`
 * produtos (run that seed first for the full experience; this one works
 * standalone too, it just skips the produto patch if the doc is missing).
 *
 *  - `dev-lista-varejo` (padrao): two formulas — limiar 100 / `C*L+T`
 *    (L=2, T=5, with a weight band lowering T to 2.5 under 0.5kg) and
 *    limiar 999999 / `C*L` (L=1.8) — plus a `formulasPorCategoria` sample.
 *    With custo 10 the Recalcular button yields 22.50 (peso defaults to
 *    0.25kg → the weight band applies) or 25.00 once pesoLiquidoKg > 0.5.
 *  - `dev-lista-atacado` (ativo, no formulas): manual prices only — the
 *    Recalcular button stays disabled.
 *  - `dev-lista-inativa` (ativo: false): hidden unless the produto already
 *    carries a price on it (it does — seeded below — so the row shows with
 *    the "inativa" badge).
 *
 * Idempotent: fixed doc ids, plain set() overwrites. Pass `--clean` to
 * delete the listas and strip the produto pricing fields.
 *
 * Usage (from the repo root):
 *   pnpm --filter @delfrance/test-fixtures seed:precos
 *   pnpm --filter @delfrance/test-fixtures seed:precos --clean
 */

const VAREJO_ID = 'dev-lista-varejo';
const ATACADO_ID = 'dev-lista-atacado';
const INATIVA_ID = 'dev-lista-inativa';
const PARENT_ID = 'dev-camiseta-pai';

const formulaBase = {
  taxaFixa: 0,
  custoFixo: 0,
  margemDeLucro: 0,
  comissaoMarketplace: 0,
  imposto: 0,
  frete: 0,
  marketing: 0,
  faixasTaxaFixaPeso: null,
};

export async function seedDevPrecos(): Promise<{ produtosPatched: number }> {
  // listaDePrecos.timestamp / ultimaModificacao are milliseconds since epoch now.
  const now = Date.now();
  const batch = db().batch();
  const listas = db().collection('listaDePrecos');

  batch.set(listas.doc(VAREJO_ID), {
    nome: 'Varejo Dev',
    padrao: true,
    ativo: true,
    formulasCalculoPreco: [
      {
        ...formulaBase,
        limiar: 100,
        formula: 'C*L+T',
        margemDeLucro: 2,
        taxaFixa: 5,
        faixasTaxaFixaPeso: [{ pesoMinKg: 0, pesoMaxKg: 0.5, taxaFixa: 2.5 }],
      },
      { ...formulaBase, limiar: 999999, formula: 'C*L', margemDeLucro: 1.8 },
    ],
    formulasPorCategoria: {
      'dev-categoria-exemplo': {
        name: 'dev-categoria-exemplo',
        formulasCalculoPreco: [
          { ...formulaBase, limiar: 999999, formula: 'C*L', margemDeLucro: 3 },
        ],
      },
    },
    timestamp: now,
    ultimaModificacao: now,
  });

  batch.set(listas.doc(ATACADO_ID), {
    nome: 'Atacado Dev',
    padrao: false,
    ativo: true,
    formulasCalculoPreco: null,
    formulasPorCategoria: null,
    timestamp: now,
    ultimaModificacao: now,
  });

  batch.set(listas.doc(INATIVA_ID), {
    nome: 'Lista Inativa Dev',
    padrao: false,
    ativo: false,
    formulasCalculoPreco: null,
    formulasPorCategoria: null,
    timestamp: now,
    ultimaModificacao: now,
  });

  // Price + cost the seed:variacoes parent (and its children — the propagation
  // keeps them in sync from here on, but seed them consistent up front).
  let produtosPatched = 0;
  const parent = await db().collection('produtos').doc(PARENT_ID).get();
  if (parent.exists) {
    const precos = {
      [VAREJO_ID]: { valor: 25 },
      [INATIVA_ID]: { valor: 19.9 },
    };
    batch.update(parent.ref, { custo: 10, precos });
    produtosPatched += 1;
    const children = await db().collection('produtos').where('paiId', '==', PARENT_ID).get();
    children.docs.forEach((d) => {
      batch.update(d.ref, { custo: 10, precos });
      produtosPatched += 1;
    });
  }

  await batch.commit();
  return { produtosPatched };
}

export async function cleanupDevPrecos(): Promise<{ deleted: number }> {
  const batch = db().batch();
  let deleted = 0;
  for (const id of [VAREJO_ID, ATACADO_ID, INATIVA_ID]) {
    batch.delete(db().collection('listaDePrecos').doc(id));
    deleted += 1;
  }
  const parent = await db().collection('produtos').doc(PARENT_ID).get();
  if (parent.exists) {
    batch.update(parent.ref, { custo: null, precos: null });
    const children = await db().collection('produtos').where('paiId', '==', PARENT_ID).get();
    children.docs.forEach((d) => batch.update(d.ref, { custo: null, precos: null }));
  }
  await batch.commit();
  return { deleted };
}

const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('seed-precos-dev.ts') ||
  process.argv[1]?.endsWith('seed-precos-dev.js');

if (isDirectInvocation) {
  const shouldClean = process.argv.includes('--clean');
  const runner = shouldClean
    ? cleanupDevPrecos().then(({ deleted }) => {
        // eslint-disable-next-line no-console
        console.log(`[seed-precos-dev] removed ${deleted} lista(s) + produto pricing fields`);
      })
    : seedDevPrecos().then(({ produtosPatched }) => {
        // eslint-disable-next-line no-console
        console.log(
          `[seed-precos-dev] wrote 3 listas de preços + priced ${produtosPatched} produto(s)\n` +
            `[seed-precos-dev] open /produtos/${PARENT_ID}/editar → aba Preço e custo (custo 10 → Recalcular Varejo = 22.50 com peso ≤ 0,5kg)`,
        );
      });
  runner.catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
