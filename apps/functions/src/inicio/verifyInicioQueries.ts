/** Read-only staging Query Explain. Uses ADC; never loads a credential file itself. */
import * as pipelines from '@google-cloud/firestore/pipelines';
import { Firestore } from '@google-cloud/firestore';
import {
  DESPACHO_METRICAS,
  inicioDespachoFonte,
  inicioDespachoCondicao,
  inicioDespachoPredicado,
  type InicioDespacho,
  type DespachoMetrica,
} from '@delfrance/schemas';
import { adminInicioPredicate, buildVendasInicioPipeline } from './consultarVendasInicio';

export async function verifyInicioQueries(
  db: Firestore,
  uid: string,
  window: Omit<InicioDespacho, 'metrica'>,
  checkout: { inicioMs: number; diaMs: number; semanaMs: number; mesMs: number; fimMs: number },
) {
  const keys = Object.keys(DESPACHO_METRICAS) as DespachoMetrica[];
  const queries = [
    {
      name: 'sales',
      pipeline: buildVendasInicioPipeline(
        db,
        uid,
        checkout.fimMs * 1000 - 7 * 86400 * 1_000_000,
        checkout.fimMs * 1000,
      ),
    },
    {
      name: 'dispatch aggregate',
      pipeline: db
        .pipeline()
        .collection('pedidos')
        .where(adminInicioPredicate(inicioDespachoFonte(window)))
        .aggregate({
          accumulators: keys.map((metrica) =>
            pipelines
              .sum(
                pipelines.conditional(
                  adminInicioPredicate(inicioDespachoCondicao({ ...window, metrica })),
                  pipelines.constant(1),
                  pipelines.constant(0),
                ),
              )
              .as(metrica),
          ),
        }),
    },
    ...keys.map((metrica) => ({
      name: `link ${metrica}`,
      pipeline: db
        .pipeline()
        .collection('pedidos')
        .where(adminInicioPredicate(inicioDespachoPredicado({ ...window, metrica })))
        .sort(pipelines.descending('freteInicial.prazoDespacho'))
        .select('numero', 'timestamp')
        .limit(50),
    })),
    {
      name: 'checkout aggregate',
      pipeline: db
        .pipeline()
        .collectionGroup('checkout')
        .where(
          pipelines.and(
            pipelines.greaterThanOrEqual(pipelines.field('timestamp'), checkout.inicioMs),
            pipelines.lessThanOrEqual(pipelines.field('timestamp'), checkout.fimMs),
          ),
        )
        .aggregate({
          groups: [
            pipelines.field('usuarioCheckoutFretePedidoOuterRef').ifAbsent(null).as('userRef'),
          ],
          accumulators: (['dia', 'semana', 'mes'] as const).map((period) =>
            pipelines
              .sum(
                pipelines.conditional(
                  pipelines.greaterThanOrEqual(
                    pipelines.field('timestamp'),
                    checkout[`${period}Ms`],
                  ),
                  pipelines.constant(1),
                  pipelines.constant(0),
                ),
              )
              .as(period),
          ),
        }),
    },
  ];
  for (const { name, pipeline } of queries) {
    const snapshot = await pipeline.execute({
      explainOptions: { mode: 'analyze', outputFormat: 'text' },
    });
    const explanation = snapshot.explainStats?.text;
    if (!explanation) throw new Error(`Missing Explain output for ${name}.`);
    process.stdout.write(`${name}\n${explanation}\n`);
    if (/TableScan/.test(explanation)) throw new Error(`Unindexed table scan in ${name}.`);
  }
}

// Supply concrete OPERATOR-LOCAL bounds from a dashboard link, avoiding a
// server's ambient timezone. The command deliberately requires a project.
if (process.argv[1]?.endsWith('verifyInicioQueries.ts')) {
  const [project, uid, canalId, start, end, day, week, month, now] = process.argv.slice(2);
  if (
    !project ||
    !uid ||
    !canalId ||
    [start, end, day, week, month, now].some((v) => !v || !Number.isSafeInteger(Number(v)))
  ) {
    throw new Error(
      'Usage: verifyInicioQueries.ts PROJECT UID CHANNEL START_US END_US DAY_MS WEEK_MS MONTH_MS NOW_MS',
    );
  }
  await verifyInicioQueries(
    new Firestore({ projectId: project, databaseId: 'default' }),
    uid,
    { canalId, inicioUs: Number(start), fimUs: Number(end) },
    {
      inicioMs: Math.min(Number(week), Number(month)),
      diaMs: Number(day),
      semanaMs: Number(week),
      mesMs: Number(month),
      fimMs: Number(now),
    },
  );
}
