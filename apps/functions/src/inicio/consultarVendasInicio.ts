import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import * as pipelines from '@google-cloud/firestore/pipelines';
import { z } from 'zod';
import { PERM, hasPerm } from '@delfrance/auth';
import {
  inicioVendasPredicado,
  mapQueryPredicate,
  vendasInicioResultado,
  type QueryPredicate,
} from '@delfrance/schemas';
import { getDb } from '../lib/admin';

export function adminInicioPredicate(predicate: QueryPredicate): pipelines.BooleanExpression {
  return mapQueryPredicate(predicate, {
    and: (children) =>
      children.length === 1
        ? children[0]!
        : pipelines.and(children[0]!, children[1]!, ...children.slice(2)),
    or: (children) =>
      children.length === 1
        ? children[0]!
        : pipelines.or(children[0]!, children[1]!, ...children.slice(2)),
    leaf: ({ field, op, value }) => {
      const fld = pipelines.field(field);
      switch (op) {
        case 'eq':
          return pipelines.equal(fld, value);
        case 'in':
          return pipelines.equalAny(fld, [...value]);
        case 'lt':
          return pipelines.lessThan(fld, value);
        case 'lte':
          return pipelines.lessThanOrEqual(fld, value);
        case 'gt':
          return pipelines.greaterThan(fld, value);
        case 'gte':
          return pipelines.greaterThanOrEqual(fld, value);
      }
    },
  });
}

export function buildVendasInicioPipeline(
  db: ReturnType<typeof getDb>,
  uid: string,
  inicioUs: number,
  fimUs: number,
) {
  return db
    .pipeline()
    .collection('pedidos')
    .where(adminInicioPredicate(inicioVendasPredicado(uid, inicioUs, fimUs)))
    .aggregate({
      accumulators: [
        pipelines.sum('valorCobrado').as('receita'),
        pipelines.countAll().as('quantidade'),
      ],
    });
}

const inputSchema = z.strictObject({});
export async function consultarVendasInicioHandler(request: CallableRequest<unknown>) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Usuário não autenticado.');
  const { permissions, su } = request.auth.token;
  if (
    su !== true &&
    !hasPerm(typeof permissions === 'string' ? permissions : undefined, PERM.pedido.read)
  ) {
    throw new HttpsError('permission-denied', 'Sem permissão para consultar pedidos.');
  }
  if (!inputSchema.safeParse(request.data).success) {
    throw new HttpsError('invalid-argument', 'Esta consulta não aceita parâmetros.');
  }
  const fimUs = Date.now() * 1000;
  const inicioUs = fimUs - 7 * 24 * 60 * 60 * 1_000_000;
  const snapshot = await buildVendasInicioPipeline(
    getDb(),
    request.auth.uid,
    inicioUs,
    fimUs,
  ).execute();
  const data = snapshot.results[0]?.data();
  return vendasInicioResultado(data?.receita ?? 0, data?.quantidade ?? 0, inicioUs, fimUs);
}
export const consultarVendasInicio = onCall(consultarVendasInicioHandler);
