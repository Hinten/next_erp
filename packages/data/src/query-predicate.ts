import {
  and,
  or,
  where,
  type QueryCompositeFilterConstraint,
  type QueryFieldFilterConstraint,
} from 'firebase/firestore';
import { mapQueryPredicate, type QueryPredicate } from '@delfrance/schemas';

export function classicPredicate(
  predicate: QueryPredicate,
): QueryCompositeFilterConstraint | QueryFieldFilterConstraint {
  return mapQueryPredicate(predicate, {
    and: (children) => and(...children),
    or: (children) => or(...children),
    leaf: ({ field, op, value }) =>
      where(
        field,
        { eq: '==', lt: '<', lte: '<=', gt: '>', gte: '>=', in: 'in' }[op] as
          | '=='
          | '<'
          | '<='
          | '>'
          | '>='
          | 'in',
        value,
      ),
  });
}
