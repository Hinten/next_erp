import { describe, expect, it } from 'vitest';
import type { ActionActor } from '@/lib/chat/conversaActions';
import { filterAtendentes } from './AtendentePickerModal';

const LIST: ActionActor[] = [
  { uid: 'op1', displayName: 'Operador X' },
  { uid: 'op2', displayName: 'Bruno' },
  { uid: 'op3', displayName: 'Carla' },
];

describe('filterAtendentes', () => {
  it('excludes only the operator (Transferir case)', () => {
    expect(filterAtendentes(LIST, ['op1']).map((a) => a.uid)).toEqual(['op2', 'op3']);
  });

  it('excludes the operator AND existing participants (Incluir case)', () => {
    // `[uid, ...usuarios]` — an already-present atendente is not offered, so an
    // idempotent re-include cannot append a duplicate entry event.
    expect(filterAtendentes(LIST, ['op1', 'op2']).map((a) => a.uid)).toEqual(['op3']);
  });

  it('ignores null/undefined entries in the exclusion list', () => {
    expect(filterAtendentes(LIST, [null, undefined]).map((a) => a.uid)).toEqual([
      'op1',
      'op2',
      'op3',
    ]);
  });

  it('returns everything when nothing is excluded', () => {
    expect(filterAtendentes(LIST, []).map((a) => a.uid)).toEqual(['op1', 'op2', 'op3']);
  });
});
