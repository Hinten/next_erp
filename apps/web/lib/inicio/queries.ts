import { getDoc, getDocs, type Firestore } from 'firebase/firestore';
import { FirebaseError } from 'firebase/app';
import { httpsCallable } from 'firebase/functions';
import {
  and,
  conditional,
  constant,
  sum,
  execute,
  field,
  greaterThanOrEqual,
  lessThanOrEqual,
} from 'firebase/firestore/pipelines';
import { z } from 'zod';
import { buildQuery, orderByField, pipelinePredicate } from '@delfrance/data';
import {
  canalInicioElegivel,
  DESPACHO_METRICAS,
  inicioDespachoFonte,
  inicioDespachoCondicao,
  vendasInicioRespostaSchema,
  toOuterRefOrNull,
  type InicioDespacho,
  type InicioCheckoutJanela,
  type DespachoMetrica,
} from '@delfrance/schemas';
import { getFirebaseFunctions } from '@/lib/firebase/client';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { usuarioCollection } from '@/lib/data/usuarioCollection';

export const INICIO_CACHE_MS = 60_000;
export const DESPACHO_KEYS = Object.keys(DESPACHO_METRICAS) as DespachoMetrica[];
const count = z.number().int().nonnegative().safe();
export const despachoContagensSchema = z.strictObject({
  faltam: count,
  atrasados: count,
  despachados: count,
  faltaImprimir: count,
  proximosDias: count,
  proximosDiasSemImpressao: count,
  total: count,
});

export async function loadVendasInicio() {
  const call = httpsCallable<Record<string, never>, unknown>(
    getFirebaseFunctions(),
    'consultarVendasInicio',
  );
  return vendasInicioRespostaSchema.parse((await call({})).data);
}
export async function loadCanaisInicio(db: Firestore) {
  const snapshot = await getDocs(
    buildQuery(integracaoCollection.ref(db, {}), [orderByField('nome', 'asc')]),
  );
  return snapshot.docs
    .map((doc) => ({ id: doc.id, data: doc.data() }))
    .filter((row) => canalInicioElegivel(row.data))
    .sort((a, b) => a.data.nome.localeCompare(b.data.nome, 'pt-BR'));
}

export function buildDespachoInicioPipeline(
  db: Firestore,
  window: Omit<InicioDespacho, 'metrica'>,
) {
  // Upcoming pending orders participate too; old dispatched orders do not.
  const source = inicioDespachoFonte(window);
  return db
    .pipeline()
    .collection('pedidos')
    .where(pipelinePredicate(source))
    .aggregate({
      accumulators: DESPACHO_KEYS.map((metrica) =>
        sum(
          conditional(
            pipelinePredicate(inicioDespachoCondicao({ ...window, metrica })),
            constant(1),
            constant(0),
          ),
        ).as(metrica),
      ),
    });
}
export async function loadDespachoInicio(db: Firestore, window: Omit<InicioDespacho, 'metrica'>) {
  const snapshot = await execute(buildDespachoInicioPipeline(db, window));
  const data =
    snapshot.results[0]?.data() ?? Object.fromEntries(DESPACHO_KEYS.map((key) => [key, 0]));
  return despachoContagensSchema.parse(data);
}

export const CHECKOUT_PERIODOS = { dia: 'Dia', semana: 'Semana', mes: 'Mês' } as const;
export type CheckoutPeriodo = keyof typeof CHECKOUT_PERIODOS;
const checkoutGroupSchema = z.object({
  userRef: z.unknown(),
  dia: count,
  semana: count,
  mes: count,
});
export interface CheckoutInicioRow {
  userId: string | null;
  label: string;
  dia: number;
  semana: number;
  mes: number;
}

export function buildCheckoutInicioPipeline(db: Firestore, window: InicioCheckoutJanela) {
  return db
    .pipeline()
    .collectionGroup('checkout')
    .where(
      and(
        greaterThanOrEqual(field('timestamp'), window.inicioMs),
        lessThanOrEqual(field('timestamp'), window.fimMs),
      ),
    )
    .aggregate({
      groups: [field('usuarioCheckoutFretePedidoOuterRef').ifAbsent(null).as('userRef')],
      accumulators: (Object.keys(CHECKOUT_PERIODOS) as CheckoutPeriodo[]).map((period) =>
        sum(
          conditional(
            greaterThanOrEqual(field('timestamp'), window[`${period}Ms`]),
            constant(1),
            constant(0),
          ),
        ).as(period),
      ),
    });
}

export async function loadCheckoutInicio(db: Firestore, window: InicioCheckoutJanela) {
  const snapshot = await execute(buildCheckoutInicioPipeline(db, window));
  const grouped = new Map<string | null, { dia: number; semana: number; mes: number }>();
  for (const result of snapshot.results) {
    const group = checkoutGroupSchema.parse(result.data());
    const ref = toOuterRefOrNull(group.userRef);
    const parts = ref?.split('/');
    const id = parts?.length === 3 && parts[1] === 'usuarios' ? parts[2]! : null;
    const previous = grouped.get(id) ?? { dia: 0, semana: 0, mes: 0 };
    grouped.set(id, {
      dia: previous.dia + group.dia,
      semana: previous.semana + group.semana,
      mes: previous.mes + group.mes,
    });
  }
  const names = await Promise.all(
    [...grouped.keys()]
      .filter((id): id is string => id !== null)
      .map(async (id) => {
        try {
          const user = (await getDoc(usuarioCollection.docRef(db, {}, id))).data();
          return [
            id,
            (user?.colaborador || user?.jaFoiColaborador) && user.nome?.trim() ? user.nome : null,
          ] as const;
        } catch (error) {
          if (error instanceof FirebaseError && error.code === 'permission-denied')
            return [id, null] as const;
          throw error;
        }
      }),
  );
  const byId = new Map(names);
  const rows: CheckoutInicioRow[] = [];
  const others: CheckoutInicioRow = {
    userId: null,
    label: 'Outros usuários',
    dia: 0,
    semana: 0,
    mes: 0,
  };
  const total = { dia: 0, semana: 0, mes: 0 };
  for (const [userId, counts] of grouped) {
    for (const period of Object.keys(total) as CheckoutPeriodo[]) total[period] += counts[period];
    const label = userId ? byId.get(userId) : null;
    if (label) rows.push({ userId, label, ...counts });
    else
      for (const period of Object.keys(total) as CheckoutPeriodo[])
        others[period] += counts[period];
  }
  rows.sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
  if (others.dia || others.semana || others.mes) rows.push(others);
  return { total, rows };
}
