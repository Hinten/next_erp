import { describe, expect, it } from 'vitest';
import { initializeApp } from 'firebase/app';
import {
  and,
  collection,
  getFirestore,
  limit,
  or,
  orderBy,
  query,
  queryEqual,
  where,
} from 'firebase/firestore';
import { buildQuery } from './queries';

describe('classic predicate transport', () => {
  it('ANDs the base constraints with an OR preset and retains sort/limit', () => {
    const db = getFirestore(
      initializeApp({ projectId: 'demo-inicio' }, 'inicio-predicate-test'),
      'default',
    );
    const ref = collection(db, 'pedidos');
    const result = buildQuery(
      ref,
      [where('ehSaida', '==', true), orderBy('timestamp', 'desc'), limit(100)],
      {
        or: [
          { field: 'estado', op: 'eq', value: 'pago' },
          { field: 'estado', op: 'in', value: ['finalizado'] },
        ],
      },
    );
    expect(
      queryEqual(
        result,
        query(
          ref,
          and(
            or(where('estado', '==', 'pago'), where('estado', 'in', ['finalizado'])),
            where('ehSaida', '==', true),
          ),
          orderBy('timestamp', 'desc'),
          limit(100),
        ),
      ),
    ).toBe(true);
  });
});
