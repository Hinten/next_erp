import { getDoc, type Firestore } from 'firebase/firestore';
import {
  and,
  countAll,
  execute,
  field,
  greaterThanOrEqual,
  lessThan,
} from 'firebase/firestore/pipelines';
import { toOuterRefOrNull } from '@delfrance/schemas';
import { usuarioCollection } from '@/lib/data/usuarioCollection';
import {
  CHECKOUT_TOP_USERS,
  checkoutsPorUsuario,
  rankCheckoutUsers,
  type CheckoutUserCount,
} from './aggregations';

export interface CheckoutDateRange {
  startMs: number;
  endExclusiveMs: number;
}

/** Date-picker values are local calendar dates; checkout's wire unit is ms. */
export function checkoutDateRange(
  start: string | null,
  end: string | null,
): CheckoutDateRange | null {
  function parseDay(value: string | null): Date | null {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number) as [number, number, number];
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
      ? date
      : null;
  }
  const first = parseDay(start);
  const last = parseDay(end);
  if (!first || !last || first > last) return null;
  last.setDate(last.getDate() + 1);
  return { startMs: first.getTime(), endExclusiveMs: last.getTime() };
}

export function buildCheckoutReportPipeline(db: Firestore, range: CheckoutDateRange) {
  return db
    .pipeline()
    .collectionGroup('checkout')
    .where(
      and(
        greaterThanOrEqual(field('timestamp'), range.startMs),
        lessThan(field('timestamp'), range.endExclusiveMs),
      ),
    )
    .aggregate({
      groups: [field('usuarioCheckoutFretePedidoOuterRef').ifAbsent(null).as('userRef')],
      accumulators: [countAll().as('count')],
    });
}

/** Non-document aggregate results have no ref/id. Validate the count, retain unknown users. */
export function checkoutGroupFromResult(data: Record<string, unknown>): CheckoutUserCount {
  if (typeof data.count !== 'number' || !Number.isSafeInteger(data.count) || data.count < 0) {
    throw new TypeError('Contagem de checkouts inválida.');
  }
  const ref = toOuterRefOrNull(data.userRef);
  const parts = ref?.split('/');
  const userId = parts?.length === 3 && parts[1] === 'usuarios' ? parts[2]! : null;
  return { userId, count: data.count };
}

export async function loadCheckoutReport(db: Firestore, range: CheckoutDateRange) {
  const snapshot = await execute(buildCheckoutReportPipeline(db, range));
  const groups = snapshot.results.map((result) => checkoutGroupFromResult(result.data()));
  const candidates = rankCheckoutUsers(groups).slice(0, CHECKOUT_TOP_USERS);
  // Direct document reads need no user query/index. Never enumerate all usuarios.
  const names = await Promise.all(
    candidates.map(async ({ userId }) => {
      const snap = await getDoc(usuarioCollection.docRef(db, {}, userId!));
      const user = snap.data();
      return [
        userId!,
        user?.colaborador === true && typeof user.nome === 'string' ? user.nome : '',
      ] as const;
    }),
  );
  return checkoutsPorUsuario(groups, new Map(names));
}
