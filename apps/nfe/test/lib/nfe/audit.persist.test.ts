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

import { Timestamp } from 'firebase-admin/firestore';

import {
  ENVIO_EM_CURSO_MS,
  envioEmCurso,
  envioEmCursoAte,
  completarProtocoloEpec,
  gravarAncoraDoLote,
  type PersistGuard,
  persistPatch,
  persistPatchUnlessFinal,
  reivindicarEnvio,
  swapAnchorForProc,
} from '../../../lib/nfe/orchestrator/audit';
import { NFeDocAusenteError, NFeOrchestratorError } from '../../../lib/nfe/orchestrator/errors';

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

/**
 * Fake Firestore exposing only the `runTransaction` seam the guard uses.
 * `updateTime` is the snapshot's, as `tx.get` reports it (#1675).
 */
function fakeFs(
  doc: Record<string, unknown> | null,
  updateTime?: Timestamp,
): {
  fs: never;
  txGet: ReturnType<typeof vi.fn>;
  txSet: ReturnType<typeof vi.fn>;
} {
  const txGet = vi.fn(async () => ({ exists: doc != null, data: () => doc, updateTime }));
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
      chaveAtual: null,
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

  it("carries the proc's data_autorizacao (ms) into the merge, and leaves the key out when absent (#1743)", async () => {
    const proc = (infProt: string) =>
      `<nfeProc><NFe><infNFe/></NFe><protNFe><infProt>${infProt}</infProt></protNFe></nfeProc>`;

    const comData = fakeFs({ estado: ESTADO_NFE.aguardandoResposta, cStat: '103' });
    await persistPatchUnlessFinal(
      comData.fs,
      NFE_REF,
      patchOf(),
      swapAnchorForProc(proc('<dhRecbto>2026-05-20T10:30:00-03:00</dhRecbto>')),
    );
    const escrito = comData.txSet.mock.calls[0]![1] as Record<string, unknown>;
    expect(escrito.data_autorizacao).toBe(Date.UTC(2026, 4, 20, 13, 30, 0));

    // A merge without the key keeps whatever the doc stores; `null` would blank it.
    const semData = fakeFs({ estado: ESTADO_NFE.aguardandoResposta, cStat: '103' });
    await persistPatchUnlessFinal(semData.fs, NFE_REF, patchOf(), swapAnchorForProc(proc('')));
    const escritoSem = semData.txSet.mock.calls[0]![1] as Record<string, unknown>;
    expect('data_autorizacao' in escritoSem).toBe(false);
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
      chaveAtual: null,
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
      chaveAtual: null,
    });
    expect(txSet).not.toHaveBeenCalled();
  });

  it('a missing doc WITH a guard → rejects NFeDocAusenteError (an NFeOrchestratorError) naming the path, nothing written', async () => {
    // Near-miss of 'a missing doc → writes' above: without a guard the same
    // missing doc IS written.
    const { fs, txSet } = fakeFs(null);

    const p = persistPatchUnlessFinal(fs, NFE_REF, loteReply(), undefined, GUARD);

    // Its own class (#1654), so a reconcile can skip a vanished doc without
    // swallowing any other NFeOrchestratorError — and still that parent
    // class, so the routes' 400 and the batch errorCode do not move.
    await expect(p).rejects.toBeInstanceOf(NFeDocAusenteError);
    await expect(p).rejects.toBeInstanceOf(NFeOrchestratorError);
    await expect(p).rejects.toMatchObject({
      name: 'NFeDocAusenteError',
      path: 'pedidos/PED-1/nfev4/s1',
    });
    await expect(p).rejects.toThrow(/pedidos\/PED-1\/nfev4\/s1 .*lote 12/);
    expect(txSet).not.toHaveBeenCalled();
  });
});

describe('persistPatchUnlessFinal with a #513 PersistGuard (receipt + retries + in flight)', () => {
  /** reconcilePorChave's counted write, decided on a doc read at retries 3. */
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
          chaveAtual: null,
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

  it('a missing doc under a #513 guard → rejects NFeDocAusenteError naming the receipt, nothing written', async () => {
    const { fs, txSet } = fakeFs(null);

    const p = persistPatchUnlessFinal(fs, NFE_REF, contada(), undefined, GUARD);

    await expect(p).rejects.toBeInstanceOf(NFeDocAusenteError);
    await expect(p).rejects.toMatchObject({ path: 'pedidos/PED-1/nfev4/s1' });
    await expect(p).rejects.toThrow(/pedidos\/PED-1\/nfev4\/s1 .*recibo REC-1/);
    expect(txSet).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #1675 — the send reservation and the writes it owns
// ---------------------------------------------------------------------------

const AGORA = 1_780_000_000_000_000; // µs
const FUTURO = AGORA + 1_000_000;
const PASSADO = AGORA - 1_000_000;

describe('envioEmCurso (#1675)', () => {
  it.each([
    [ESTADO_NFE.enviando, null, FUTURO, true],
    [ESTADO_NFE.aguardandoResposta, null, FUTURO, true],
    [ESTADO_NFE.epecAprovado, null, FUTURO, true],
    // a receipt: the in-flight gate owns the doc, never the reservation
    [ESTADO_NFE.enviando, 'REC-1', FUTURO, false],
    [ESTADO_NFE.aguardandoResposta, 'REC-1', FUTURO, false],
    // not in flight / not 'p'
    [ESTADO_NFE.rejeitada, null, FUTURO, false],
    [ESTADO_NFE.error, null, FUTURO, false],
    [ESTADO_NFE.aprovada, null, FUTURO, false],
    // no reservation, an expired one, the boundary
    [ESTADO_NFE.enviando, null, null, false],
    [ESTADO_NFE.enviando, null, PASSADO, false],
    [ESTADO_NFE.enviando, null, AGORA, false],
  ] as const)(
    'estado %s · nRec %s · proximaConsultaEm %s → %s',
    (estado, nRec, proxima, esperado) => {
      expect(envioEmCurso({ estado, nRec, proximaConsultaEm: proxima }, AGORA)).toBe(esperado);
    },
  );

  it('reads the stored value through coerceToMicros — a ms-shaped FUTURE value is still a live reservation', () => {
    const futuroEmMs = (AGORA + 60_000_000) / 1000;
    expect(
      envioEmCurso(
        { estado: ESTADO_NFE.enviando, nRec: null, proximaConsultaEm: futuroEmMs },
        AGORA,
      ),
    ).toBe(true);
  });

  it('the reservation a claim stamps is ENVIO_EM_CURSO_MS ahead, in µs', () => {
    expect(ENVIO_EM_CURSO_MS).toBe(360_000);
    expect(envioEmCursoAte(AGORA)).toBe(AGORA + 360_000_000);
  });
});

describe('PersistGuard.expectedUpdateTime / refuseWhileReserved (#1675)', () => {
  const LIDO = Timestamp.fromMillis(1_000);

  it('the doc unchanged since the read → writes', async () => {
    const { fs, txSet } = fakeFs({ estado: ESTADO_NFE.aguardandoResposta }, LIDO);

    const r = await persistPatchUnlessFinal(fs, NFE_REF, patchOf(), undefined, {
      expectedUpdateTime: Timestamp.fromMillis(1_000),
    });

    expect(r).toEqual({ written: true });
    expect(txSet).toHaveBeenCalledTimes(1);
  });

  it('the doc written since the read (an emit claimed it) → NO write, the live doc reported', async () => {
    const { fs, txSet } = fakeFs(
      { estado: ESTADO_NFE.enviando, idLote: '8', chave: 'CHAVE-VIVA' },
      Timestamp.fromMillis(2_000),
    );

    const r = await persistPatchUnlessFinal(fs, NFE_REF, patchOf(), undefined, {
      expectedUpdateTime: LIDO,
    });

    expect(r).toEqual({
      written: false,
      estadoAtual: ESTADO_NFE.enviando,
      cStatAtual: null,
      xMotivoAtual: null,
      nRecAtual: null,
      chaveAtual: 'CHAVE-VIVA',
    });
    expect(txSet).not.toHaveBeenCalled();
  });

  it('a send in progress on the doc → NO write, even though nothing changed since the read', async () => {
    const vivo = {
      estado: ESTADO_NFE.enviando,
      nRec: null,
      proximaConsultaEm: Date.now() * 1000 + 60_000_000,
    };
    const { fs, txSet } = fakeFs(vivo, LIDO);

    const r = await persistPatchUnlessFinal(fs, NFE_REF, patchOf(), undefined, {
      expectedUpdateTime: LIDO,
      refuseWhileReserved: true,
    });

    expect(r).toMatchObject({ written: false, estadoAtual: ESTADO_NFE.enviando });
    expect(txSet).not.toHaveBeenCalled();
  });

  it('near-miss: an EXPIRED reservation does not refuse the write', async () => {
    const vivo = {
      estado: ESTADO_NFE.enviando,
      nRec: null,
      proximaConsultaEm: Date.now() * 1000 - 60_000_000,
    };
    const { fs, txSet } = fakeFs(vivo, LIDO);

    const r = await persistPatchUnlessFinal(fs, NFE_REF, patchOf(), undefined, {
      expectedUpdateTime: LIDO,
      refuseWhileReserved: true,
    });

    expect(r).toEqual({ written: true });
    expect(txSet).toHaveBeenCalledTimes(1);
  });
});

describe('gravarAncoraDoLote — batch 4b’s idLote-guarded anchor write (#1675)', () => {
  const DOC_DATA = { estado: ESTADO_NFE.enviando, chave: 'CHAVE-DO-LOTE', idLote: '12' };

  it('the doc still stamped with this lote → the full doc is written (no merge)', async () => {
    const { fs, txSet } = fakeFs({ estado: ESTADO_NFE.enviando, idLote: '12', chave: null });

    const r = await gravarAncoraDoLote(fs, NFE_REF, DOC_DATA, 12);

    expect(r).toEqual({ written: true });
    expect(txSet).toHaveBeenCalledTimes(1);
    expect(txSet.mock.calls[0]).toEqual([NFE_REF, DOC_DATA]);
  });

  it.each([
    [
      'another lote claimed it',
      { estado: ESTADO_NFE.enviando, idLote: '13', chave: 'CHAVE-OUTRA' },
    ],
    ['a stored null idLote', { estado: ESTADO_NFE.enviando, idLote: null, chave: null }],
    [
      'the doc went final (same idLote)',
      { estado: ESTADO_NFE.aprovada, idLote: '12', chave: 'CHAVE-OUTRA' },
    ],
  ])('%s → NO write, the live doc reported', async (_label, vivo) => {
    const { fs, txSet } = fakeFs(vivo);

    const r = await gravarAncoraDoLote(fs, NFE_REF, DOC_DATA, 12);

    expect(r).toMatchObject({ written: false, estadoAtual: vivo.estado, chaveAtual: vivo.chave });
    expect(txSet).not.toHaveBeenCalled();
  });

  it('a missing doc → NFeDocAusenteError, nothing written', async () => {
    const { fs, txSet } = fakeFs(null);

    await expect(gravarAncoraDoLote(fs, NFE_REF, DOC_DATA, 12)).rejects.toBeInstanceOf(
      NFeDocAusenteError,
    );
    expect(txSet).not.toHaveBeenCalled();
  });
});

describe('reivindicarEnvio — the pós-EPEC claim (#1675)', () => {
  const EPEC = {
    estado: ESTADO_NFE.epecAprovado,
    chave: 'CHAVE-EPEC',
    xml_assinado: '<NFe/>',
    nRec: null,
    idLote: '3',
    proximaConsultaEm: null,
  };

  it('a free EPEC-approved doc → stamps the idLote + a live reservation, returns the claimed snapshot', async () => {
    const { fs, txSet } = fakeFs(EPEC);
    const antes = Date.now() * 1000;

    const r = await reivindicarEnvio(fs, NFE_REF, 9);

    expect(r.claimed).toBe(true);
    expect(r.nota).toMatchObject({ chave: 'CHAVE-EPEC', xml_assinado: '<NFe/>', idLote: '9' });
    expect(txSet).toHaveBeenCalledTimes(1);
    const [ref, data, opts] = txSet.mock.calls[0]! as [unknown, Record<string, number>, unknown];
    expect(ref).toBe(NFE_REF);
    expect(opts).toEqual({ merge: true });
    expect(data).toMatchObject({ idLote: '9' });
    expect(data.proximaConsultaEm).toBeGreaterThanOrEqual(antes + ENVIO_EM_CURSO_MS * 1000);
    // The claim writes ONLY lote bookkeeping — never the anchor or the estado.
    expect(Object.keys(data).sort()).toEqual(['idLote', 'proximaConsultaEm', 'ultima_modificacao']);
  });

  it.each([
    [
      'a transmission already in progress',
      { ...EPEC, proximaConsultaEm: Date.now() * 1000 + 60_000_000 },
    ],
    ['no longer EPEC-approved', { ...EPEC, estado: ESTADO_NFE.aprovada }],
  ])('%s → NOT claimed, nothing written, the live doc returned', async (_label, vivo) => {
    const { fs, txSet } = fakeFs(vivo);

    const r = await reivindicarEnvio(fs, NFE_REF, 9);

    expect(r).toEqual({ claimed: false, nota: vivo });
    expect(txSet).not.toHaveBeenCalled();
  });

  it('near-miss: an EXPIRED reservation is claimed', async () => {
    const { fs, txSet } = fakeFs({ ...EPEC, proximaConsultaEm: Date.now() * 1000 - 60_000_000 });

    const r = await reivindicarEnvio(fs, NFE_REF, 9);

    expect(r.claimed).toBe(true);
    expect(txSet).toHaveBeenCalledTimes(1);
  });

  it('an EPEC-approved doc without its signed XML cannot be transmitted → throws, nothing written', async () => {
    const { fs, txSet } = fakeFs({ ...EPEC, xml_assinado: null });

    await expect(reivindicarEnvio(fs, NFE_REF, 9)).rejects.toBeInstanceOf(NFeOrchestratorError);
    expect(txSet).not.toHaveBeenCalled();
  });

  it('a missing doc → NFeDocAusenteError', async () => {
    const { fs } = fakeFs(null);

    await expect(reivindicarEnvio(fs, NFE_REF, 9)).rejects.toBeInstanceOf(NFeDocAusenteError);
  });
});

describe('gravarAncoraDoLote re-checks every premise 4a decided on (#1675 review)', () => {
  const DOC_DATA = { estado: ESTADO_NFE.enviando, chave: 'CHAVE-DO-LOTE', idLote: '12' };

  it.each([
    [
      'a consult between 4a and 4b wrote a BLOCKING terminal (same idLote)',
      { estado: ESTADO_NFE.error, idLote: '12', cStat: '103', nRec: null, chave: 'CHAVE-VELHA' },
    ],
    [
      'it went in flight on a receipt (same idLote)',
      {
        estado: ESTADO_NFE.aguardandoResposta,
        idLote: '12',
        cStat: '105',
        nRec: 'REC-9',
        chave: 'CHAVE-VELHA',
      },
    ],
    [
      'a send reservation is live on it (same idLote)',
      {
        estado: ESTADO_NFE.aguardandoResposta,
        idLote: '12',
        cStat: '225',
        nRec: null,
        chave: 'CHAVE-VELHA',
        proximaConsultaEm: Date.now() * 1000 + 60_000_000,
      },
    ],
  ])('%s → NO write, the live doc reported', async (_label, vivo) => {
    const { fs, txSet } = fakeFs(vivo);

    const r = await gravarAncoraDoLote(fs, NFE_REF, DOC_DATA, 12);

    expect(r).toMatchObject({
      written: false,
      estadoAtual: vivo.estado,
      chaveAtual: 'CHAVE-VELHA',
    });
    expect(txSet).not.toHaveBeenCalled();
  });

  it('near-miss: a REUSE member still rejeitada with a non-blocking cStat (and no receipt, no reservation) is written', async () => {
    const { fs, txSet } = fakeFs({
      estado: ESTADO_NFE.rejeitada,
      idLote: '12',
      cStat: '225',
      nRec: null,
      chave: 'CHAVE-VELHA',
      proximaConsultaEm: null,
    });

    const r = await gravarAncoraDoLote(fs, NFE_REF, DOC_DATA, 12);

    expect(r).toEqual({ written: true });
    expect(txSet).toHaveBeenCalledTimes(1);
  });
});

describe('completarProtocoloEpec — fill-only heal of a superseded EPEC run’s protocol (#1675)', () => {
  const REGISTRO = {
    signedXml: '<NFe>…B1…</NFe>',
    xml_epec_proc: '<procEventoNFe>…</procEventoNFe>',
    cStat: '135',
    xMotivo: 'Evento registrado e vinculado a NF-e',
    cStatsJaRegistrado: new Set(['485', '573']),
  };
  const SEM_PROTOCOLO = {
    estado: ESTADO_NFE.epecAprovado,
    chave: 'CHAVE-EPEC',
    xml_assinado: '<NFe>…B1…</NFe>',
    cStat: '573',
    xMotivo: 'Rejeicao: Duplicidade de Evento | EPEC já registrado…',
    xml_epec_proc: null,
    idLote: '9',
  };

  it('a p doc of this chave without its protocol → the proc + the registered cStat/xMotivo, nothing else', async () => {
    const { fs, txSet } = fakeFs(SEM_PROTOCOLO);

    const r = await completarProtocoloEpec(fs, NFE_REF, 'CHAVE-EPEC', REGISTRO);

    expect(r).toMatchObject({ estado: ESTADO_NFE.epecAprovado, cStat: '135', idLote: '9' });
    expect(txSet).toHaveBeenCalledTimes(1);
    const [, data, opts] = txSet.mock.calls[0]! as [unknown, Record<string, unknown>, unknown];
    expect(opts).toEqual({ merge: true });
    expect(Object.keys(data).sort()).toEqual([
      'cStat',
      'ultima_modificacao',
      'xMotivo',
      'xml_epec_proc',
    ]);
  });

  it('a later cStat (a pós-EPEC 468) is kept — only the proc is filled in', async () => {
    const { fs, txSet } = fakeFs({ ...SEM_PROTOCOLO, cStat: '468' });

    const r = await completarProtocoloEpec(fs, NFE_REF, 'CHAVE-EPEC', REGISTRO);

    expect(r).toMatchObject({ cStat: '468' });
    const [, data] = txSet.mock.calls[0]! as [unknown, Record<string, unknown>];
    expect(Object.keys(data).sort()).toEqual(['ultima_modificacao', 'xml_epec_proc']);
  });

  it.each([
    ['a protocol already there', { ...SEM_PROTOCOLO, xml_epec_proc: '<outro/>' }],
    ['another chave', { ...SEM_PROTOCOLO, chave: 'OUTRA' }],
    // a regenerate keeps the chave within the month — the proc describes OTHER bytes
    [
      'the same chave over OTHER signed bytes',
      { ...SEM_PROTOCOLO, xml_assinado: '<NFe>…B2…</NFe>' },
    ],
    ['no longer p', { ...SEM_PROTOCOLO, estado: ESTADO_NFE.aprovada }],
  ])('%s → nothing written, null', async (_label, vivo) => {
    const { fs, txSet } = fakeFs(vivo);

    expect(await completarProtocoloEpec(fs, NFE_REF, 'CHAVE-EPEC', REGISTRO)).toBeNull();
    expect(txSet).not.toHaveBeenCalled();
  });
});
