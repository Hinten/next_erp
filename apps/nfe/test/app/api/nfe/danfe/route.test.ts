/**
 * Route tests for GET /api/nfe/danfe. vi.mock the auth + firestore +
 * orchestrator layers to isolate the route's contract:
 *   - 401 / 403 on auth
 *   - 400 on a bad query
 *   - 200 + Content-Type/Content-Disposition for the PDF and ZPL artifacts
 *   - 404 / 422 on orchestrator-thrown errors
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nfe/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nfe/auth')>();
  return { ...actual, verifyCaller: vi.fn() };
});
vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: vi.fn(() => ({}) as never),
}));
vi.mock('@/lib/nfe/orchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nfe/orchestrator')>();
  return { ...actual, danfeArtifactService: vi.fn() };
});

import { NextResponse } from 'next/server';

import { verifyCaller } from '@/lib/nfe/auth';
import {
  danfeArtifactService,
  NFeDanfeError,
  NFePedidoNotFoundError,
} from '@/lib/nfe/orchestrator';

import { GET } from '../../../../../app/api/nfe/danfe/route';

function req(qs: string): Request {
  return new Request(`http://localhost/api/nfe/danfe?${qs}`, {
    method: 'GET',
    headers: { authorization: 'Bearer t' },
  });
}

beforeEach(() => {
  vi.mocked(verifyCaller).mockResolvedValue({ caller: { uid: 'u-1', permissions: '0xff' } });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/nfe/danfe', () => {
  it('401 when auth fails', async () => {
    vi.mocked(verifyCaller).mockResolvedValue({
      error: NextResponse.json({ error: 'no token' }, { status: 401 }),
    });
    const res = await GET(req('pedidoId=PED-1&nfeId=s1'));
    expect(res.status).toBe(401);
  });

  it('400 on a missing required query param', async () => {
    const res = await GET(req('pedidoId=PED-1'));
    expect(res.status).toBe(400);
  });

  it('200 PDF with Content-Disposition for the simplificado', async () => {
    vi.mocked(danfeArtifactService).mockResolvedValue({
      contentType: 'application/pdf',
      filename: 'danfe-7.pdf',
      body: Buffer.from('%PDF-1.7\n…'),
    });
    const res = await GET(req('pedidoId=PED-1&nfeId=s1&format=simplificado'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="danfe-7.pdf"');
  });

  it('200 text/plain for the ZPL label', async () => {
    vi.mocked(danfeArtifactService).mockResolvedValue({
      contentType: 'text/plain; charset=utf-8',
      filename: 'danfe-7.txt',
      body: '^XA^XZ',
    });
    const res = await GET(req('pedidoId=PED-1&nfeId=s1&format=zpl2'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toBe('^XA^XZ');
  });

  it('404 when the NF-e is not found', async () => {
    vi.mocked(danfeArtifactService).mockRejectedValue(new NFePedidoNotFoundError('PED-X'));
    const res = await GET(req('pedidoId=PED-X&nfeId=s1'));
    expect(res.status).toBe(404);
  });

  it('422 when the NF-e is not renderable', async () => {
    vi.mocked(danfeArtifactService).mockRejectedValue(new NFeDanfeError('estado não renderável'));
    const res = await GET(req('pedidoId=PED-1&nfeId=s1'));
    expect(res.status).toBe(422);
  });
});
