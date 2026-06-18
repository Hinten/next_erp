/**
 * Route tests for POST /api/nfe/reconciliar (Cloud Task target). Mocks auth,
 * runtime, the reconcile core and the scheduler, isolating the endpoint's
 * decision logic: re-enqueue while still pending, no re-enqueue on terminal
 * (656 / cap / done), and fail-fast on missing Cloud Tasks config.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nfe/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nfe/auth')>();
  return { ...actual, verifyServiceCaller: vi.fn() };
});
vi.mock('@/lib/nfe/runtime', () => ({ getNFeRuntime: vi.fn(() => ({})) }));
vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: vi.fn(() => ({})) }));
vi.mock('@/lib/nfe/filial-cert', () => ({ resolveFilialRuntime: vi.fn(async () => ({})) }));
vi.mock('@/lib/nfe/orchestrator/reconcile', () => ({ reconcileByRecibo: vi.fn() }));
vi.mock('@/lib/nfe/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nfe/tasks')>();
  return { ...actual, createTaskScheduler: vi.fn() };
});

import { NextResponse } from 'next/server';

import { verifyServiceCaller } from '@/lib/nfe/auth';
import { reconcileByRecibo } from '@/lib/nfe/orchestrator/reconcile';
import { createTaskScheduler, NFeTasksConfigError } from '@/lib/nfe/tasks';

import { POST } from '../../../../../app/api/nfe/reconciliar/route';

function req(body: unknown): Request {
  return new Request('http://localhost/api/nfe/reconciliar', {
    method: 'POST',
    headers: { authorization: 'Bearer oidc', 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const PAYLOAD = { kind: 'consulta-lote', filialId: 'F-1', nRec: 'REC-1', tpEmis: 1, attempt: 0 };
let enqueued: unknown[];

beforeEach(() => {
  process.env.NFE_BASE_URL = 'https://nfe.example';
  enqueued = [];
  vi.mocked(verifyServiceCaller).mockResolvedValue({ service: { email: 'runner@p.iam' } });
  vi.mocked(createTaskScheduler).mockReturnValue({
    async enqueueConsulta(i) {
      enqueued.push(i);
    },
  });
});
afterEach(() => {
  delete process.env.NFE_BASE_URL;
  vi.clearAllMocks();
});

describe('POST /api/nfe/reconciliar', () => {
  it('re-enqueues with attempt+1 while the lote is still pending', async () => {
    vi.mocked(reconcileByRecibo).mockResolvedValue({
      scanned: 1,
      stillPending: 1,
      recovered: 0,
      errored: 0,
      cStat: '105',
    });
    const res = await POST(req(PAYLOAD));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reEnqueued).toBe(true);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ nRec: 'REC-1', attempt: 1 });
  });

  it('does NOT re-enqueue on a terminal outcome (e.g. 656 → errored)', async () => {
    vi.mocked(reconcileByRecibo).mockResolvedValue({
      scanned: 1,
      stillPending: 0,
      recovered: 0,
      errored: 1,
      cStat: '656',
    });
    const res = await POST(req(PAYLOAD));
    expect(res.status).toBe(200); // 200 so Cloud Tasks does NOT retry the 656
    expect((await res.json()).reEnqueued).toBe(false);
    expect(enqueued).toHaveLength(0);
  });

  it('returns the auth error when the OIDC caller is rejected', async () => {
    vi.mocked(verifyServiceCaller).mockResolvedValue({
      error: NextResponse.json({ error: 'nope' }, { status: 403 }),
    });
    const res = await POST(req(PAYLOAD));
    expect(res.status).toBe(403);
    expect(vi.mocked(reconcileByRecibo)).not.toHaveBeenCalled();
  });

  it('400 on a malformed payload', async () => {
    const res = await POST(req({ kind: 'consulta-lote', filialId: 'F-1' }));
    expect(res.status).toBe(400);
  });

  it('503 (fail-fast) when Cloud Tasks config is missing — before any consult', async () => {
    vi.mocked(createTaskScheduler).mockImplementation(() => {
      throw new NFeTasksConfigError(['NFE_TASKS_QUEUE']);
    });
    const res = await POST(req(PAYLOAD));
    expect(res.status).toBe(503);
    expect(vi.mocked(reconcileByRecibo)).not.toHaveBeenCalled();
  });
});
