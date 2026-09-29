/**
 * Unit tests for `persistPatchUnlessFinal` — the TOCTOU-guarded variant of
 * `persistPatch`. The guard runs a transaction that re-reads the nfev4 doc:
 * a doc that reached a final estado DIFFERENT from the patch's mid-flight is
 * never overwritten (`written: false` + the doc's live truth); everything
 * else writes exactly what `persistPatch` writes (shared mapping). Under a
 * `PersistGuard` a doc on which any stated condition fails is skipped the
 * same way — re-stamped by a newer lote (#512), or another receipt, another
 * `retries` or no longer in flight (#513) — and a missing doc is refused
 * instead of written.
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

import {
  type PersistGuard,
  persistPatch,
  persistPatchUnlessFinal,
} from '../../../lib/nfe/orchestrator/audit';
import { NFeOrchestratorError } from '../../../lib/nfe/orchestrator/errors';

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
      nRecAtual: null,
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

describe('persistPatchUnlessFinal with a PersistGuard (#512)', () => {
  const GUARD = { expectedIdLote: '12' } as const;
  /** A lote-level refusal with no infRec, as #512 writes it to a fresh member. */
  const loteReply = (): NFeStatePatch =>
    patchOf({
      estado: ESTADO_NFE.rejeitada,
      cStat: '225',
      xMotivo: 'Rejeição: Falha no Schema XML da NFe',
      action: 'done-rejected',
    });

  it('stored idLote EQUAL to the expected one → writes', async () => {
    const { fs, txSet } = fakeFs({ estado: ESTADO_NFE.enviando, idLote: '12', nRec: null });

    const r = await persistPatchUnlessFinal(fs, NFE_REF, loteReply(), undefined, GUARD);

    expect(r).toEqual({ written: true });
    expect(txSet).toHaveBeenCalledTimes(1);
    expect(txSet.mock.calls[0]![1]).toMatchObject({ estado: ESTADO_NFE.rejeitada, cStat: '225' });
  });

  it('NEAR-MISS: a newer lote re-stamped the doc → NO write, result carries the live doc incl. its nRec', async () => {
    const { fs, txSet } = fakeFs({
      estado: ESTADO_NFE.aguardandoResposta,
      idLote: '13',
      nRec: 'OUTRO',
      cStat: '103',
      xMotivo: 'Lote recebido com sucesso',
    });

    const r = await persistPatchUnlessFinal(fs, NFE_REF, loteReply(), undefined, GUARD);

    expect(r).toEqual({
      written: false,
      estadoAtual: ESTADO_NFE.aguardandoResposta,
      cStatAtual: '103',
      xMotivoAtual: 'Lote recebido com sucesso',
      nRecAtual: 'OUTRO',
    });
    expect(txSet).not.toHaveBeenCalled();
  });

  it('a stored idLote of null counts as superseded → NO write', async () => {
    const { fs, txSet } = fakeFs({ estado: ESTADO_NFE.enviando, idLote: null });

    const r = await persistPatchUnlessFinal(fs, NFE_REF, loteReply(), undefined, GUARD);

    expect(r).toMatchObject({ written: false, estadoAtual: ESTADO_NFE.enviando, nRecAtual: null });
    expect(txSet).not.toHaveBeenCalled();
  });

  it('a read-tolerated legacy NUMBER idLote equal to the expected one → writes (String() on both sides)', async () => {
    const { fs, txSet } = fakeFs({ estado: ESTADO_NFE.enviando, idLote: 12 });

    const r = await persistPatchUnlessFinal(fs, NFE_REF, loteReply(), undefined, GUARD);

    expect(r).toEqual({ written: true });
    expect(txSet).toHaveBeenCalledTimes(1);
  });

  it('guard omitted → idLote is ignored, a different stored lote still writes (as before #512)', async () => {
    const { fs, txSet } = fakeFs({ estado: ESTADO_NFE.enviando, idLote: '13', nRec: 'OUTRO' });

    const r = await persistPatchUnlessFinal(fs, NFE_REF, loteReply());

    expect(r).toEqual({ written: true });
    expect(txSet).toHaveBeenCalledTimes(1);
  });

  it('a FINAL estado with an EQUAL idLote → still NO write (the final guard wins)', async () => {
    const { fs, txSet } = fakeFs({
      estado: ESTADO_NFE.aprovada,
      idLote: '12',
      cStat: '100',
      xMotivo: 'Autorizado o uso da NF-e',
    });

    const r = await persistPatchUnlessFinal(fs, NFE_REF, loteReply(), undefined, GUARD);

    expect(r).toEqual({
      written: false,
      estadoAtual: ESTADO_NFE.aprovada,
      cStatAtual: '100',
      xMotivoAtual: 'Autorizado o uso da NF-e',
      nRecAtual: null,
    });
    expect(txSet).not.toHaveBeenCalled();
  });

  it('a missing doc WITH a guard → rejects NFeOrchestratorError, nothing written', async () => {
    // Near-miss of 'a missing doc → writes' above: without a guard the same
    // missing doc IS written.
    const { fs, txSet } = fakeFs(null);

    const p = persistPatchUnlessFinal(fs, NFE_REF, loteReply(), undefined, GUARD);

    await expect(p).rejects.toBeInstanceOf(NFeOrchestratorError);
    await expect(p).rejects.toThrow(/pedidos\/PED-1\/nfev4\/s1 .*lote 12/);
    expect(txSet).not.toHaveBeenCalled();
  });
});

describe('persistPatchUnlessFinal with a #513 PersistGuard (receipt + retries + in flight)', () => {
  /** reconcileLoteSemProtocolo's counted write, decided on a doc read at retries 3. */
  const GUARD = { expectedNRec: 'REC-1', expectedRetries: 3, requireInFlight: true } as const;
  const contada = (): NFeStatePatch =>
    patchOf({
      estado: ESTADO_NFE.aguardandoResposta,
      cStat: '104',
      xMotivo: 'Lote processado | protNFe desta chave ausente (consulta 4/10)',
      retries: 4,
      action: 'recover-via-consulta',
    });
  /** The stored doc the counted write was decided on — every condition holds. */
  const premissa = {
    estado: ESTADO_NFE.aguardandoResposta,
    nRec: 'REC-1',
    retries: 3,
    cStat: '104',
    xMotivo: 'Lote processado',
  };

  it('every condition holds on the stored doc → writes', async () => {
    const { fs, txSet } = fakeFs(premissa);

    const r = await persistPatchUnlessFinal(fs, NFE_REF, contada(), undefined, GUARD);

    expect(r).toEqual({ written: true });
    expect(txSet).toHaveBeenCalledTimes(1);
    expect(txSet.mock.calls[0]![1]).toMatchObject({
      estado: ESTADO_NFE.aguardandoResposta,
      retries: 4,
    });
  });

  // Each condition alone: a stored doc on which it HOLDS writes; its near-miss
  // is refused with the live doc — and every other field stays as the premise.
  it.each<[string, PersistGuard, Record<string, unknown>, Record<string, unknown>]>([
    ['expectedNRec', { expectedNRec: 'REC-1' }, { nRec: 'REC-1' }, { nRec: 'REC-2' }],
    ['expectedNRec (stored null)', { expectedNRec: 'REC-1' }, { nRec: 'REC-1' }, { nRec: null }],
    ['expectedRetries', { expectedRetries: 3 }, { retries: 3 }, { retries: 4 }],
    [
      'expectedRetries (legacy null = 0)',
      { expectedRetries: 0 },
      { retries: null },
      { retries: 1 },
    ],
    [
      'requireInFlight (enviando / error)',
      { requireInFlight: true },
      { estado: ESTADO_NFE.enviando },
      { estado: ESTADO_NFE.error, cStat: '656' },
    ],
    [
      'requireInFlight (aguardandoResposta / rejeitada)',
      { requireInFlight: true },
      { estado: ESTADO_NFE.aguardandoResposta },
      { estado: ESTADO_NFE.rejeitada, cStat: '217' },
    ],
  ])(
    '%s: holds → writes; near-miss → NO write, the live doc returned',
    async (_c, guard, ok, quase) => {
      const passa = fakeFs({ ...premissa, ...ok });
      expect(await persistPatchUnlessFinal(passa.fs, NFE_REF, contada(), undefined, guard)).toEqual(
        {
          written: true,
        },
      );
      expect(passa.txSet).toHaveBeenCalledTimes(1);

      const vivo = { ...premissa, ...quase };
      const falha = fakeFs(vivo);
      expect(await persistPatchUnlessFinal(falha.fs, NFE_REF, contada(), undefined, guard)).toEqual(
        {
          written: false,
          estadoAtual: vivo.estado,
          cStatAtual: vivo.cStat,
          xMotivoAtual: vivo.xMotivo,
          nRecAtual: vivo.nRec,
        },
      );
      expect(falha.txSet).not.toHaveBeenCalled();
    },
  );

  it('a condition the guard OMITS is not checked (the #512 guard ignores nRec / retries / estado)', async () => {
    const { fs, txSet } = fakeFs({
      estado: ESTADO_NFE.error,
      idLote: '12',
      nRec: 'OUTRO',
      retries: 7,
    });

    const r = await persistPatchUnlessFinal(fs, NFE_REF, contada(), undefined, {
      expectedIdLote: '12',
    });

    expect(r).toEqual({ written: true });
    expect(txSet).toHaveBeenCalledTimes(1);
  });

  it('combined with expectedIdLote: all hold → writes; any ONE failing → NO write', async () => {
    const combinada = { ...GUARD, expectedIdLote: '12' } as const;
    const base = { ...premissa, idLote: '12' };

    const ok = fakeFs(base);
    expect(await persistPatchUnlessFinal(ok.fs, NFE_REF, contada(), undefined, combinada)).toEqual({
      written: true,
    });

    for (const quase of [
      { idLote: '13' },
      { nRec: 'REC-2' },
      { retries: 4 },
      { estado: ESTADO_NFE.error },
    ]) {
      const falha = fakeFs({ ...base, ...quase });
      const r = await persistPatchUnlessFinal(falha.fs, NFE_REF, contada(), undefined, combinada);
      expect(r.written).toBe(false);
      expect(falha.txSet).not.toHaveBeenCalled();
    }
  });

  it('a FINAL estado still refuses first, whatever the guard says', async () => {
    const { fs, txSet } = fakeFs({ ...premissa, estado: ESTADO_NFE.aprovada, cStat: '100' });

    const r = await persistPatchUnlessFinal(fs, NFE_REF, contada(), undefined, {
      expectedNRec: 'REC-1',
      expectedRetries: 3,
    });

    expect(r).toMatchObject({ written: false, estadoAtual: ESTADO_NFE.aprovada });
    expect(txSet).not.toHaveBeenCalled();
  });

  it('a missing doc under a #513 guard → rejects NFeOrchestratorError naming the receipt, nothing written', async () => {
    const { fs, txSet } = fakeFs(null);

    const p = persistPatchUnlessFinal(fs, NFE_REF, contada(), undefined, GUARD);

    await expect(p).rejects.toBeInstanceOf(NFeOrchestratorError);
    await expect(p).rejects.toThrow(/pedidos\/PED-1\/nfev4\/s1 .*recibo REC-1/);
    expect(txSet).not.toHaveBeenCalled();
  });
});
