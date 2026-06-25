/**
 * `sweepCartasCorrecaoPendentes` — the CC-e backstop sweep (#241), the
 * cartacorrecao analogue of the lote sweep in `runProcessarPendentes`. Asserts
 * the due-gate (respect a future `proximaConsultaEm`, treat null as due), the
 * payload reconstructed from the doc path, the disposition → tally mapping, and
 * per-doc error isolation. The orchestrator re-check is mocked; the scan, the
 * due-gate and the path derivation run REAL against an in-memory fake that
 * supports `collectionGroup` with the `cartacorrecao/{cceId} → nfev4/{nfeId} →
 * pedidos/{pedidoId}` parent chain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nfe/orchestrator/carta-correcao', () => ({
  reconcileCartaCorrecaoVinculo: vi.fn(),
}));

import { ESTADO_ENVI_NFE_MSG } from '@delfrance/schemas';

import { reconcileCartaCorrecaoVinculo } from '@/lib/nfe/orchestrator/carta-correcao';
import { sweepCartasCorrecaoPendentes } from '@/lib/nfe/handlers/runProcessarPendentes';
import type { NFeBaseRuntime } from '@/lib/nfe/runtime';

const NOW = new Date('2026-06-25T12:00:00.000Z');
const NOW_MS = NOW.getTime();

/** In-memory Firestore exposing only `collectionGroup` with a recursive parent chain. */
function fakeFs(seed: Record<string, Record<string, unknown>>) {
  function ref(path: string): Record<string, unknown> {
    const segs = path.split('/');
    return {
      path,
      id: segs[segs.length - 1]!,
      parent: {
        path: segs.slice(0, -1).join('/'),
        parent: segs.length > 2 ? ref(segs.slice(0, -2).join('/')) : null,
      },
    };
  }
  function collectionGroup(groupId: string) {
    let estado: unknown = null;
    const q = {
      where(field: string, _op: string, value: unknown) {
        if (field === 'estado') estado = value;
        return q;
      },
      limit(_n: number) {
        return q;
      },
      async get() {
        const docs = Object.entries(seed)
          .filter(([k]) => k.split('/').at(-2) === groupId)
          .filter(([, v]) => estado == null || (v as { estado?: unknown }).estado === estado)
          .map(([k, v]) => ({ id: k.split('/').pop()!, ref: ref(k), data: () => v }));
        return { docs };
      },
    };
    return q;
  }
  return { collectionGroup } as never;
}

/** A pending (aguardandoVinculo) CC-e record. */
function cceDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    xCorrecao: 'Correção do endereço de entrega do destinatário.',
    nSeqEvento: 2,
    estado: ESTADO_ENVI_NFE_MSG.aguardandoVinculo,
    retries: 3,
    cStat: '136',
    // Due by default: proximaConsultaEm one minute in the past (µs epoch).
    proximaConsultaEm: (NOW_MS - 60_000) * 1000,
    ...overrides,
  };
}

const PATH = 'pedidos/PED-1/nfev4/s1/cartacorrecao/cce-1';
const baseRt = {} as NFeBaseRuntime;

describe('sweepCartasCorrecaoPendentes (#241)', () => {
  beforeEach(() => {
    vi.mocked(reconcileCartaCorrecaoVinculo).mockReset();
  });

  it('re-checks a due record with the payload derived from the doc path; pending → stillPending', async () => {
    vi.mocked(reconcileCartaCorrecaoVinculo).mockResolvedValue({
      cStat: '136',
      stillPending: true,
      nextAttempt: 4,
      disposition: 'pending',
    });

    const r = await sweepCartasCorrecaoPendentes({
      fs: fakeFs({ [PATH]: cceDoc() }),
      baseRt,
      batchSize: 100,
      now: NOW,
    });

    expect(r).toMatchObject({ scanned: 1, recovered: 0, stillPending: 1, errors: [] });
    expect(vi.mocked(reconcileCartaCorrecaoVinculo)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reconcileCartaCorrecaoVinculo)).toHaveBeenCalledWith(
      expect.anything(),
      baseRt,
      // pedidoId + nfeId from the path, cceId = doc id, attempt = doc.retries.
      {
        kind: 'cce-vinculo',
        pedidoId: 'PED-1',
        nfeId: 's1',
        cceId: 'cce-1',
        nSeqEvento: 2,
        attempt: 3,
      },
    );
  });

  it('counts a terminal disposition (resolved) as recovered', async () => {
    vi.mocked(reconcileCartaCorrecaoVinculo).mockResolvedValue({
      cStat: '135',
      stillPending: false,
      disposition: 'resolved',
    });

    const r = await sweepCartasCorrecaoPendentes({
      fs: fakeFs({ [PATH]: cceDoc() }),
      baseRt,
      batchSize: 100,
      now: NOW,
    });

    expect(r).toMatchObject({ scanned: 1, recovered: 1, stillPending: 0, errors: [] });
  });

  it('skips a not-yet-due record (future proximaConsultaEm) without re-checking', async () => {
    const r = await sweepCartasCorrecaoPendentes({
      fs: fakeFs({ [PATH]: cceDoc({ proximaConsultaEm: (NOW_MS + 600_000) * 1000 }) }),
      baseRt,
      batchSize: 100,
      now: NOW,
    });

    expect(r).toMatchObject({ scanned: 1, recovered: 0, stillPending: 1, errors: [] });
    expect(vi.mocked(reconcileCartaCorrecaoVinculo)).not.toHaveBeenCalled();
  });

  it('treats a null proximaConsultaEm (stranded pacing) as due', async () => {
    vi.mocked(reconcileCartaCorrecaoVinculo).mockResolvedValue({
      cStat: '135',
      stillPending: false,
      disposition: 'resolved',
    });

    const r = await sweepCartasCorrecaoPendentes({
      fs: fakeFs({ [PATH]: cceDoc({ proximaConsultaEm: null, retries: null }) }),
      baseRt,
      batchSize: 100,
      now: NOW,
    });

    expect(r).toMatchObject({ scanned: 1, recovered: 1, stillPending: 0 });
    // retries null → attempt defaults to 0.
    expect(vi.mocked(reconcileCartaCorrecaoVinculo)).toHaveBeenCalledWith(
      expect.anything(),
      baseRt,
      expect.objectContaining({ cceId: 'cce-1', attempt: 0 }),
    );
  });

  it('captures a per-doc throw in errors without aborting the sweep', async () => {
    vi.mocked(reconcileCartaCorrecaoVinculo)
      .mockRejectedValueOnce(new Error('SEFAZ timeout'))
      .mockResolvedValueOnce({ cStat: '135', stillPending: false, disposition: 'resolved' });

    const r = await sweepCartasCorrecaoPendentes({
      fs: fakeFs({
        'pedidos/PED-1/nfev4/s1/cartacorrecao/cce-1': cceDoc(),
        'pedidos/PED-2/nfev4/s1/cartacorrecao/cce-2': cceDoc(),
      }),
      baseRt,
      batchSize: 100,
      now: NOW,
    });

    expect(r.scanned).toBe(2);
    expect(r.recovered).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.error).toContain('SEFAZ timeout');
    expect(r.errors[0]!.chave).toBeNull();
  });
});
