/**
 * Unit tests for `persistPatchUnlessFinal` — the TOCTOU-guarded variant of
 * `persistPatch`. The guard runs a transaction that re-reads the nfev4 doc:
 * a doc that reached a final estado DIFFERENT from the patch's mid-flight is
 * never overwritten (`written: false` + the doc's live truth); everything
 * else writes exactly what `persistPatch` writes (shared mapping).
 *
 * Firestore is faked at the `runTransaction` seam; `nfev4Collection`
 * parseRead/parseMerge are passthrough mocks so the shapes stay visible.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@delfrance/data/admin/collections', () => ({
  nfev4Collection: {
    parseRead: vi.fn((raw: unknown) => raw),
    parseMerge: vi.fn((raw: unknown) => raw),
  },
  enviNfeMsgCollection: { parse: vi.fn((raw: unknown) => raw), ref: vi.fn() },
}));

import type { NFeStatePatch } from '@delfrance/integrations-nfe';
import { ESTADO_NFE } from '@delfrance/schemas';

import { persistPatch, persistPatchUnlessFinal } from '../../../lib/nfe/orchestrator/audit';

const NFE_REF = { path: 'pedidos/PED-1/nfev4/s1' } as never;

function patchOf(over: Partial<NFeStatePatch> = {}): NFeStatePatch {
  return {
    estado: ESTADO_NFE.aprovada,
    cStat: '100',
    xMotivo: 'Autorizado o uso da NF-e',
    retries: 0,
    nRec: null,
    action: 'done-authorized',
    tMed: null,
    ...over,
  };
}

/** Fake Firestore exposing only the `runTransaction` seam the guard uses. */
function fakeFs(doc: Record<string, unknown> | null): {
  fs: never;
  txGet: ReturnType<typeof vi.fn>;
  txSet: ReturnType<typeof vi.fn>;
} {
  const txGet = vi.fn(async () => ({ exists: doc != null, data: () => doc }));
  const txSet = vi.fn();
  const fs = {
    runTransaction: (fn: (tx: unknown) => Promise<unknown>) => fn({ get: txGet, set: txSet }),
  } as never;
  return { fs, txGet, txSet };
}

describe('persistPatchUnlessFinal', () => {
  it("transaction sees estado 'c' + patch says 'a' → NO write, result carries the live doc", async () => {
    const { fs, txSet } = fakeFs({
      estado: ESTADO_NFE.cancelada,
      cStat: '101',
      xMotivo: 'Cancelamento de NF-e homologado',
    });

    const r = await persistPatchUnlessFinal(fs, NFE_REF, patchOf());

    expect(r).toEqual({
      written: false,
      estadoAtual: ESTADO_NFE.cancelada,
      cStatAtual: '101',
      xMotivoAtual: 'Cancelamento de NF-e homologado',
    });
    expect(txSet).not.toHaveBeenCalled();
  });

  it('transaction sees inutilizada + patch says rejeitada → NO write', async () => {
    const { fs, txSet } = fakeFs({
      estado: ESTADO_NFE.numeracaoInutilizada,
      cStat: '102',
      xMotivo: 'Inutilização homologada',
    });

    const r = await persistPatchUnlessFinal(
      fs,
      NFE_REF,
      patchOf({ estado: ESTADO_NFE.rejeitada, cStat: '999', action: 'done-rejected' }),
    );

    expect(r).toMatchObject({ written: false, estadoAtual: ESTADO_NFE.numeracaoInutilizada });
    expect(txSet).not.toHaveBeenCalled();
  });

  it('a non-final current estado → writes and reports written:true', async () => {
    const { fs, txSet } = fakeFs({ estado: ESTADO_NFE.aguardandoResposta, cStat: '103' });

    const r = await persistPatchUnlessFinal(fs, NFE_REF, patchOf());

    expect(r).toEqual({ written: true });
    expect(txSet).toHaveBeenCalledTimes(1);
    const [ref, data, opts] = txSet.mock.calls[0]!;
    expect(ref).toBe(NFE_REF);
    expect(data).toMatchObject({ estado: ESTADO_NFE.aprovada, cStat: '100' });
    expect(opts).toEqual({ merge: true });
  });

  it('the SAME final estado flows through (e.g. re-persisting cancelada)', async () => {
    const { fs, txSet } = fakeFs({ estado: ESTADO_NFE.cancelada, cStat: '101' });

    const r = await persistPatchUnlessFinal(
      fs,
      NFE_REF,
      patchOf({ estado: ESTADO_NFE.cancelada, cStat: '101', action: 'done-terminal' }),
    );

    expect(r).toEqual({ written: true });
    expect(txSet).toHaveBeenCalledTimes(1);
  });

  it('a missing doc → writes (nothing to guard against)', async () => {
    const { fs, txSet } = fakeFs(null);

    const r = await persistPatchUnlessFinal(fs, NFE_REF, patchOf());

    expect(r).toEqual({ written: true });
    expect(txSet).toHaveBeenCalledTimes(1);
  });

  it('writes the exact same shape persistPatch writes (shared mapping)', async () => {
    const patch = patchOf({ estado: ESTADO_NFE.rejeitada, cStat: '999', action: 'done-rejected' });
    const extras = { xml_nfe_proc: '<proc/>', xml_assinado: null };

    const { fs, txSet } = fakeFs({ estado: ESTADO_NFE.aguardandoResposta, cStat: '103' });
    await persistPatchUnlessFinal(fs, NFE_REF, patch, extras);

    const plainSet = vi.fn();
    await persistPatch({ set: plainSet } as never, patch, extras);

    const guardedData = txSet.mock.calls[0]![1] as Record<string, unknown>;
    const plainData = plainSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(guardedData).sort()).toEqual(Object.keys(plainData).sort());
    const { ultima_modificacao: _g, ...guardedRest } = guardedData;
    const { ultima_modificacao: _p, ...plainRest } = plainData;
    expect(guardedRest).toEqual(plainRest);
    expect(plainSet.mock.calls[0]![1]).toEqual({ merge: true });
  });
});
