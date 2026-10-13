import { vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { createMercadoLivreApi, type MlSizeChartApi } from '@delfrance/integrations-mercado-livre';
import type { MlSizeChart } from '@delfrance/schemas';
import { MemoryFirestore } from '@delfrance/data/testing';
import { chartCreatePayload, syncSizeCharts } from '../sizeChartSync';
import { randomUUID } from 'node:crypto';

export const CHART: MlSizeChart = {
  id: '501',
  nome: 'Shirts',
  domain_id: 'MLB-T_SHIRTS',
  main_attribute_id: 'SIZE',
  rows: [
    {
      id: '501:1',
      varianteUid: 'v1',
      attributes: [
        { id: 'SIZE', value_name: 'M' },
        { id: 'CHEST', value_name: '90,5', unit_id: 'cm' },
      ],
    },
    {
      id: '501:2',
      varianteUid: 'v2',
      attributes: [
        { id: 'SIZE', value_name: 'G' },
        { id: 'CHEST', value_name: '100', unit_id: 'cm' },
      ],
    },
  ],
};

/** The real HTTP adapter runs over an in-memory provider, capturing wire calls. */
export function chartHarness(chart = CHART) {
  const db = new MemoryFirestore();
  db.seed('tabMedi', 'table', {
    nome: 'Table',
    tabelasDeMedidasMercadoLivre: {
      account: {
        tabelas: [chart, { ...CHART, id: null, nome: 'Unrelated draft' }],
        metadata: 'keep',
      },
      other: { tabelas: [{ ...CHART, id: 'OTHER' }] },
    },
    tabelasMedidasShopee: { shop: [{ size_chart_id: 42 }] },
    legacy: 'keep',
  });
  let remote = {
    ...chartCreatePayload(chart),
    id: chart.id ?? '501',
    main_attribute_id: 'SIZE',
    seller_id: 7,
    rows: (chartCreatePayload(chart).rows as Record<string, unknown>[]).map((row, i) => ({
      ...row,
      id: `501:${i + 1}`,
    })),
  } as MlSizeChartApi;
  const calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  let intercept: ((method: string, path: string) => Promise<Response | null>) | null = null;
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? 'GET';
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method, path, body });
    const result = await intercept?.(method, path);
    if (result) return result;
    if (path === '/users/me')
      return Response.json({ id: 7, nickname: 'seller', email: 'test@example.invalid' });
    if (method === 'POST' && path === '/catalog/charts') {
      remote = {
        ...remote,
        ...body,
        id: '501',
        main_attribute_id: 'SIZE',
        rows: (body!.rows as Record<string, unknown>[]).map((row, i) => ({
          ...row,
          id: `501:${i + 1}`,
        })),
      };
    } else if (method === 'PUT' && path === '/catalog/charts/501') {
      remote = { ...remote, names: body!.names as Record<string, string> };
    } else if (method === 'POST' && path.endsWith('/rows')) {
      remote = {
        ...remote,
        rows: [...remote.rows!, { ...body, id: `501:${remote.rows!.length + 1}` }],
      };
    } else if (method === 'PUT' && path.includes('/rows/')) {
      const id = path.split('/').pop();
      remote = {
        ...remote,
        rows: remote.rows!.map((row) =>
          String(row.id) === id
            ? { ...row, attributes: body!.attributes as Record<string, unknown>[] }
            : row,
        ),
      };
    }
    return Response.json(remote);
  });
  const api = createMercadoLivreApi({ getAccessToken: async () => 'test', fetch, maxRetries: 0 });
  return {
    db,
    api,
    calls,
    fetch,
    get remote() {
      return remote;
    },
    set remote(value: MlSizeChartApi) {
      remote = value;
    },
    set intercept(value: typeof intercept) {
      intercept = value;
    },
    charts: () =>
      (
        db.docs('tabMedi').get('table')!.tabelasDeMedidasMercadoLivre as Record<
          string,
          { tabelas: MlSizeChart[] }
        >
      ).account!.tabelas,
    saved: (chart: MlSizeChart) => {
      const doc = db.docs('tabMedi').get('table')!;
      const map = doc.tabelasDeMedidasMercadoLivre as Record<string, { tabelas: MlSizeChart[] }>;
      db.seed('tabMedi', 'table', {
        ...doc,
        tabelasDeMedidasMercadoLivre: {
          ...map,
          account: { ...map.account, tabelas: [chart, ...map.account!.tabelas.slice(1)] },
        },
      });
    },
    send: (chart: MlSizeChart, operationId = randomUUID(), recoveryChartId?: string) =>
      syncSizeCharts({ db: db as unknown as Firestore, api, integracaoId: 'account' }, 'table', {
        operationId,
        chartIndex: 0,
        chart,
        recoveryChartId,
      }),
  };
}
