import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase/firestore';
import { FirebaseError } from 'firebase/app';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  docRef: vi.fn(),
  callable: vi.fn(),
}));
vi.mock('firebase/firestore', async (original) => ({
  ...(await original<typeof import('firebase/firestore')>()),
  getDoc: mocks.getDoc,
  getDocs: mocks.getDocs,
}));
vi.mock('firebase/firestore/pipelines', async (original) => ({
  ...(await original<typeof import('firebase/firestore/pipelines')>()),
  execute: mocks.execute,
}));
vi.mock('firebase/functions', () => ({ httpsCallable: () => mocks.callable }));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFunctions: () => ({}) }));
vi.mock('@/lib/data/usuarioCollection', () => ({ usuarioCollection: { docRef: mocks.docRef } }));
vi.mock('@/lib/data/integracaoCollection', () => ({ integracaoCollection: { ref: () => ({}) } }));
vi.mock('@delfrance/data', async (original) => ({
  ...(await original<typeof import('@delfrance/data')>()),
  buildQuery: () => ({}),
}));
import {
  buildDespachoInicioPipeline,
  buildCheckoutInicioPipeline,
  loadCheckoutInicio,
  loadCanaisInicio,
  loadVendasInicio,
  loadDespachoInicio,
} from './queries';
import { INTEGRACAO_TIPO, inicioCheckoutJanela } from '@delfrance/schemas';

function database() {
  const stage = { where: vi.fn(), aggregate: vi.fn() };
  stage.where.mockReturnValue(stage);
  stage.aggregate.mockReturnValue(stage);
  return {
    db: {
      pipeline: () => ({ collection: () => stage, collectionGroup: () => stage }),
    } as unknown as Firestore,
    stage,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.docRef.mockImplementation((_db, _context, id: string) => ({ id }));
  mocks.getDoc.mockImplementation(async ({ id }: { id: string }) => ({
    data: () => ({ nome: id, colaborador: true }),
  }));
});
describe('dashboard aggregates', () => {
  it('counts all seven dispatch conditions in one aggregate, including zero orders', async () => {
    const { db, stage } = database();
    buildDespachoInicioPipeline(db, { canalId: 'a', inicioUs: 1000, fimUs: 2000 });
    expect(stage.aggregate.mock.calls[0]![0].accumulators).toHaveLength(7);
    expect(stage.where).toHaveBeenCalledOnce();
    const zeros = {
      faltam: 0,
      atrasados: 0,
      despachados: 0,
      faltaImprimir: 0,
      proximosDias: 0,
      proximosDiasSemImpressao: 0,
      total: 0,
    };
    for (const data of [
      undefined,
      Object.fromEntries(Object.keys(zeros).map((key) => [key, null])),
    ]) {
      mocks.execute.mockResolvedValue({ results: data ? [{ data: () => data }] : [] });
      expect(await loadDespachoInicio(db, { canalId: 'a', inicioUs: 1, fimUs: 2 })).toEqual(zeros);
    }
    mocks.execute.mockResolvedValue({
      results: [{ data: () => ({ ...zeros, total: 'invalid' }) }],
    });
    await expect(loadDespachoInicio(db, { canalId: 'a', inicioUs: 1, fimUs: 2 })).rejects.toThrow();
  });
  it('groups all three checkout periods once and resolves every returned user without a top-20 cap', async () => {
    const window = inicioCheckoutJanela(new Date(2026, 9, 1, 13));
    const { db, stage } = database();
    buildCheckoutInicioPipeline(db, window);
    expect(stage.aggregate.mock.calls[0]![0].accumulators).toHaveLength(3);
    const groups = Array.from({ length: 25 }, (_, i) => ({
      userRef: `documents/usuarios/u${i}`,
      dia: 1,
      semana: 3,
      mes: 2,
    }));
    groups.push({ userRef: 'usuarios/u0', dia: 2, semana: 2, mes: 2 });
    mocks.execute.mockResolvedValue({
      results: [...groups, { userRef: null, dia: 2, semana: 4, mes: 3 }].map((data) => ({
        data: () => data,
      })),
    });
    mocks.getDoc.mockImplementation(async ({ id }: { id: string }) => {
      if (id === 'u1') throw new FirebaseError('permission-denied', 'denied');
      return { data: () => (id === 'u2' ? undefined : { nome: id, colaborador: id !== 'u3' }) };
    });
    const result = await loadCheckoutInicio(db, window);
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.getDoc).toHaveBeenCalledTimes(25);
    expect(result.total).toEqual({ dia: 29, semana: 81, mes: 55 });
    expect(result.rows.find((row) => row.userId === 'u0')).toMatchObject({
      dia: 3,
      semana: 5,
      mes: 4,
    });
    expect(result.rows.at(-1)).toEqual({
      userId: null,
      label: 'Outros usuários',
      dia: 5,
      semana: 13,
      mes: 9,
    });
  });
  it('includes all eligible active channels even without orders and sorts names', async () => {
    const channels = Object.values(INTEGRACAO_TIPO).map((tipo) => ({
      id: String(tipo),
      data: () => ({ nome: `Canal ${tipo}`, ativo: true, tipo }),
    }));
    channels.push({
      id: 'inactive',
      data: () => ({ nome: 'Inactive', ativo: false, tipo: INTEGRACAO_TIPO.balcao }),
    });
    mocks.getDocs.mockResolvedValue({ docs: channels.reverse() });
    expect((await loadCanaisInicio(database().db)).map((row) => row.id)).toEqual([
      '1',
      '3',
      '4',
      '5',
      '7',
      '8',
    ]);
  });
  it('validates callable data and sends an empty request', async () => {
    mocks.callable.mockResolvedValue({
      data: { receita: 10, quantidade: 1, ticketMedio: 10, inicioUs: 1, fimUs: 2 },
    });
    expect(await loadVendasInicio()).toHaveProperty('receita', 10);
    expect(mocks.callable).toHaveBeenCalledWith({});
    mocks.callable.mockResolvedValue({ data: { receita: 'invalid' } });
    await expect(loadVendasInicio()).rejects.toThrow();
  });
  it('declares Enterprise covering indexes for sales and both dispatch link shapes', () => {
    const indexes = JSON.parse(readFileSync(resolve('../../firestore.indexes.json'), 'utf8')) as {
      indexes: {
        collectionGroup: string;
        apiScope?: string;
        density?: string;
        fields: { fieldPath: string; order: string }[];
      }[];
    };
    const paths = [
      ['vendedorPedidoOuterRef', 'ehSaida', 'estado', 'timestamp', 'valorCobrado'],
      [
        'ehSaida',
        'integracaoPedidoOuterRef',
        'estado',
        'freteInicial.estado',
        'freteInicial.prazoDespacho',
        'foiImpresso',
      ],
      [
        'ehSaida',
        'integracaoPedidoOuterRef',
        'estado',
        'freteInicial.estado',
        'foiImpresso',
        'freteInicial.prazoDespacho',
      ],
    ];
    for (const fields of paths)
      expect(indexes.indexes).toContainEqual(
        expect.objectContaining({
          collectionGroup: 'pedidos',
          apiScope: 'ANY_API',
          density: 'SPARSE_ANY',
          fields: fields.map((fieldPath) => ({
            fieldPath,
            order:
              fieldPath === 'timestamp' || fieldPath === 'freteInicial.prazoDespacho'
                ? 'DESCENDING'
                : 'ASCENDING',
          })),
        }),
      );
  });
});
