import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FirebaseError } from 'firebase/app';
import type { Firestore } from 'firebase/firestore';

/**
 * The vendedor is the one header ref whose read may legitimately be refused.
 *
 * `usuarios` needs `PERM.configuracoes.read`, which a plain operator does not
 * hold, and `buildPrintModel` fans the header refs out through a `Promise.all` —
 * so an unguarded rejection takes the WHOLE print model down rather than one
 * line of it. That only became reachable when `PedidoForm` started stamping the
 * field on create; before, it was null on the plain-create path and the read
 * never happened.
 *
 * Both halves are pinned here. A tolerance that swallows more than
 * `permission-denied` would turn a real outage into a silently seller-less
 * sheet, which is the failure the narrowing exists to prevent.
 */
const { getDoc } = vi.hoisted(() => ({ getDoc: vi.fn() }));

vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<typeof import('firebase/firestore')>('firebase/firestore');
  return { ...actual, getDoc };
});
vi.mock('@/lib/data/dereferenceOuterRef', () => ({
  dereferenceOuterRef: (_db: unknown, ref: unknown) =>
    typeof ref === 'string' ? { id: ref.split('/').pop() } : null,
}));

// Import AFTER the mocks are registered.
import { readVendedor } from './assemble';

const db = {} as Firestore;
const REF = 'documents/usuarios/u-lucas';

beforeEach(() => {
  getDoc.mockReset();
});

describe('readVendedor', () => {
  it('returns the usuario when the read succeeds', async () => {
    getDoc.mockResolvedValue({ exists: () => true, data: () => ({ nome: 'Lucas' }) });
    await expect(readVendedor(db, REF)).resolves.toEqual({ nome: 'Lucas' });
  });

  it('reads nothing when the pedido has no vendedor', async () => {
    await expect(readVendedor(db, null)).resolves.toBeNull();
    expect(getDoc).not.toHaveBeenCalled();
  });

  it('degrades to null when the operator may not read usuarios', async () => {
    getDoc.mockRejectedValue(new FirebaseError('permission-denied', 'Missing permissions'));
    // The sheet omits the seller line for a null — the same output these pedidos
    // had before the create stamp existed.
    await expect(readVendedor(db, REF)).resolves.toBeNull();
  });

  // The near-miss: a tolerance wide enough to hide an outage is worse than the
  // crash it replaces, because the sheet still prints — just without a seller.
  it('rethrows every OTHER FirebaseError', async () => {
    getDoc.mockRejectedValue(new FirebaseError('unavailable', 'Backend unavailable'));
    await expect(readVendedor(db, REF)).rejects.toThrow('Backend unavailable');
  });

  it('rethrows a non-Firebase error untouched', async () => {
    getDoc.mockRejectedValue(new TypeError('boom'));
    await expect(readVendedor(db, REF)).rejects.toBeInstanceOf(TypeError);
  });
});
