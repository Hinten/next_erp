import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { PERM } from '@delfrance/auth';
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  where: vi.fn(),
  aggregate: vi.fn(),
  collection: vi.fn(),
}));
vi.mock('../lib/admin', () => ({
  getDb: () => ({ pipeline: () => ({ collection: mocks.collection }) }),
}));
import { consultarVendasInicioHandler } from './consultarVendasInicio';

const request = (
  uid: string | null,
  data: unknown = {},
  permissions = PERM.pedido.read.toString(),
) =>
  ({ data, auth: uid ? { uid, token: { permissions } } : undefined }) as CallableRequest<unknown>;
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});
describe('consultarVendasInicio', () => {
  it('denies authentication/permission and rejects client seller identity before querying', async () => {
    await expect(consultarVendasInicioHandler(request(null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    await expect(consultarVendasInicioHandler(request('a', {}, '0'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(
      consultarVendasInicioHandler(request('a', { vendedor: 'b' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(mocks.collection).not.toHaveBeenCalled();
  });
  it('derives seller from auth, executes one aggregate, validates and rounds the result', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    mocks.collection.mockReturnValue({ where: mocks.where });
    mocks.where.mockReturnValue({ aggregate: mocks.aggregate });
    mocks.aggregate.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({
      results: [{ data: () => ({ receita: 100, quantidade: 3 }) }],
    });
    const result = await consultarVendasInicioHandler(request('authenticated-seller'));
    expect(result).toMatchObject({ receita: 100, quantidade: 3, ticketMedio: 33.33 });
    expect(result.fimUs - result.inicioUs).toBe(7 * 86400 * 1_000_000);
    expect(JSON.stringify(mocks.where.mock.calls)).toContain(
      'documents/usuarios/authenticated-seller',
    );
    expect(mocks.execute).toHaveBeenCalledOnce();
    mocks.execute.mockResolvedValue({ results: [] });
    expect(await consultarVendasInicioHandler(request('a'))).toMatchObject({
      receita: 0,
      quantidade: 0,
      ticketMedio: 0,
    });
    mocks.execute.mockResolvedValue({
      results: [{ data: () => ({ receita: 'invalid', quantidade: 1 }) }],
    });
    await expect(consultarVendasInicioHandler(request('a'))).rejects.toThrow();
  });
});
