/**
 * Unit tests for `reconcileByRecibo` — the async lote reconcile core.
 *
 * Mocks the Firestore collection handle (`nfev4Collection.groupQuery`), the
 * audit writes (`persistPatch` / `enviNfeCollection` / `buildEnviNFeMsgFromConsulta`)
 * and the SEFAZ call (`consultarLote`), so the test exercises the decision logic
 * in isolation: 105 → still pending, 104+autorizada → recovered, 656 → terminal
 * error (NO retry), and the attempt cap → terminal error. `outcomeFromConsReci`,
 * `applyOutcome` and `classifyCStat` run REAL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NFeStatePatch } from '@delfrance/integrations-nfe';

vi.mock('@delfrance/data/admin/collections', () => ({
  nfev4Collection: { groupQuery: vi.fn() },
  enviNfeMsgCollection: {},
}));
vi.mock('@delfrance/integrations-nfe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delfrance/integrations-nfe')>();
  return { ...actual, consultarLote: vi.fn() };
});
vi.mock('../../../lib/nfe/orchestrator/sefaz-call', () => ({
  sefazCallFor: vi.fn(() => ({}) as never),
}));
vi.mock('../../../lib/nfe/orchestrator/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/nfe/orchestrator/audit')>();
  return {
    ...actual,
    persistPatch: vi.fn(),
    enviNfeCollection: vi.fn(() => ({ add: vi.fn() })),
    buildEnviNFeMsgFromConsulta: vi.fn(() => ({})),
    // recoverFrom539 (real) looks the SEFAZ-asserted chave up here; null = "not
    // one we emitted" → markAsLost → terminal error, with no further SEFAZ call.
    findLatestEnviNFeMsgWithNRec: vi.fn(async () => null),
  };
});

import { consultarLote, MAX_RECONCILE_ATTEMPTS } from '@delfrance/integrations-nfe';
import { ESTADO_NFE } from '@delfrance/schemas';
import { nfev4Collection } from '@delfrance/data/admin/collections';

import { persistPatch } from '../../../lib/nfe/orchestrator/audit';
import { reconcileByRecibo } from '../../../lib/nfe/orchestrator/reconcile';

const CHAVE = '35260614200166000187550010000000091400000010';

/** Seed `groupQuery().where().get()` with one in-flight doc for the lote. */
function seedDoc(over: Record<string, unknown> = {}): void {
  const data = {
    estado: ESTADO_NFE.aguardandoResposta,
    chave: CHAVE,
    nRec: 'REC-1',
    retries: 0,
    xml_assinado: null,
    ...over,
  };
  vi.mocked(nfev4Collection.groupQuery).mockReturnValue({
    where: () => ({
      get: async () => ({ docs: [{ ref: { path: `pedidos/P/nfev4/s1` }, data: () => data }] }),
    }),
  } as never);
}

/** Capture the patch persisted for the (single) doc. */
function lastPatch(): NFeStatePatch {
  const calls = vi.mocked(persistPatch).mock.calls;
  return calls[calls.length - 1]![1];
}

function loteRet(cStat: string, protCStat?: string): unknown {
  return {
    versao: '4.00',
    tpAmb: '2',
    verAplic: 'TEST',
    nRec: 'REC-1',
    cStat,
    xMotivo: `motivo ${cStat}`,
    cUF: '35',
    dhRecbto: new Date().toISOString(),
    protNFe: protCStat
      ? [
          {
            versao: '4.00',
            infProt: {
              tpAmb: '2',
              verAplic: 'TEST',
              chNFe: CHAVE,
              dhRecbto: new Date().toISOString(),
              cStat: protCStat,
              xMotivo: `prot ${protCStat}`,
              nProt: '135000000000000',
              digVal: 'd',
            },
          },
        ]
      : undefined,
  };
}

/**
 * 104 lote whose inner protNFe for our chave is a cStat=539 (duplicidade com
 * chave diferente) — xMotivo asserts a DIFFERENT chave via the `[chNFe:...]`
 * marker the recovery parser reads.
 */
function loteRet539(): unknown {
  const OUTRA_CHAVE = '35260614200166000187550010000000099400000019';
  return {
    versao: '4.00',
    tpAmb: '2',
    verAplic: 'TEST',
    nRec: 'REC-1',
    cStat: '104',
    xMotivo: 'Lote processado',
    cUF: '35',
    dhRecbto: new Date().toISOString(),
    protNFe: [
      {
        versao: '4.00',
        infProt: {
          tpAmb: '2',
          verAplic: 'TEST',
          chNFe: CHAVE,
          dhRecbto: new Date().toISOString(),
          cStat: '539',
          xMotivo: `Rejeicao: Duplicidade de NF-e com diferenca na Chave de Acesso [chNFe:${OUTRA_CHAVE}]`,
          nProt: '135000000000000',
          digVal: 'd',
        },
      },
    ],
  };
}

const baseArgs = {
  fs: {} as never,
  rt: {} as never,
  filialId: 'F-1',
  nRec: 'REC-1',
  tpEmis: 1 as never,
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('reconcileByRecibo', () => {
  it('105 (lote em processamento) → still pending, retries incremented', async () => {
    seedDoc({ retries: 1 });
    vi.mocked(consultarLote).mockResolvedValue(loteRet('105') as never);
    const r = await reconcileByRecibo({ ...baseArgs, attempt: 1 });
    expect(r.stillPending).toBe(1);
    expect(r.recovered).toBe(0);
    expect(r.errored).toBe(0);
    const patch = lastPatch();
    expect(patch.estado).toBe(ESTADO_NFE.aguardandoResposta);
    expect(patch.retries).toBe(2);
  });

  it('104 + protNFe autorizada → recovered (aprovada)', async () => {
    seedDoc();
    vi.mocked(consultarLote).mockResolvedValue(loteRet('104', '100') as never);
    const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });
    expect(r.recovered).toBe(1);
    expect(r.stillPending).toBe(0);
    expect(lastPatch().estado).toBe(ESTADO_NFE.aprovada);
  });

  it('autorizada + stored bytes with MATCHING digest → proc extras persisted (#396)', async () => {
    seedDoc({
      xml_assinado:
        '<NFe><infNFe>…</infNFe><Signature><SignedInfo><Reference>' +
        '<DigestValue>d</DigestValue></Reference></SignedInfo></Signature></NFe>',
    });
    // loteRet's protNFe carries digVal 'd' — matches the stored DigestValue.
    vi.mocked(consultarLote).mockResolvedValue(loteRet('104', '100') as never);
    await reconcileByRecibo({ ...baseArgs, attempt: 0 });
    const call = vi.mocked(persistPatch).mock.calls.at(-1)!;
    expect(call[2]).toBeDefined(); // swapAnchorForProc extras present → xml_nfe_proc written
  });

  it('autorizada + stored bytes with digest MISMATCH → NO proc extras, doc stays aprovada (#396)', async () => {
    seedDoc({
      xml_assinado:
        '<NFe><infNFe>…</infNFe><Signature><SignedInfo><Reference>' +
        '<DigestValue>OTHER</DigestValue></Reference></SignedInfo></Signature></NFe>',
    });
    vi.mocked(consultarLote).mockResolvedValue(loteRet('104', '100') as never);
    const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });
    expect(r.recovered).toBe(1);
    const call = vi.mocked(persistPatch).mock.calls.at(-1)!;
    expect(call[1].estado).toBe(ESTADO_NFE.aprovada);
    expect(call[2]).toBeUndefined(); // no proc — anchor kept for DistDFe/manual fetch
  });

  it('656 (consumo indevido) → terminal error, NEVER retried', async () => {
    seedDoc({ retries: 0 });
    vi.mocked(consultarLote).mockResolvedValue(loteRet('656') as never);
    const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });
    expect(r.errored).toBe(1);
    expect(r.stillPending).toBe(0); // → caller does NOT re-enqueue
    expect(lastPatch().estado).toBe(ESTADO_NFE.error);
  });

  it('105 at the attempt cap → terminal error with a manual-review motivo', async () => {
    // retries already at cap-1; the 105 bump reaches the cap → flip to error.
    seedDoc({ retries: MAX_RECONCILE_ATTEMPTS - 1 });
    vi.mocked(consultarLote).mockResolvedValue(loteRet('105') as never);
    const r = await reconcileByRecibo({ ...baseArgs, attempt: MAX_RECONCILE_ATTEMPTS - 1 });
    expect(r.errored).toBe(1);
    expect(r.stillPending).toBe(0);
    const patch = lastPatch();
    expect(patch.estado).toBe(ESTADO_NFE.error);
    expect(patch.xMotivo).toMatch(/verificar manualmente/);
  });

  it('539 (duplicidade, chave not in our audit log) → terminal error, never left aguardandoResposta (#243)', async () => {
    seedDoc();
    vi.mocked(consultarLote).mockResolvedValue(loteRet539() as never);
    const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });
    expect(r.errored).toBe(1);
    // The whole point of #243: a 539 must NOT keep re-queuing as still-pending.
    expect(r.stillPending).toBe(0);
    expect(lastPatch().estado).toBe(ESTADO_NFE.error);
  });

  it('no in-flight docs → noop (idempotent re-delivery)', async () => {
    seedDoc({ estado: ESTADO_NFE.aprovada }); // already terminal → filtered out
    const r = await reconcileByRecibo({ ...baseArgs, attempt: 0 });
    expect(r.scanned).toBe(0);
    expect(vi.mocked(consultarLote)).not.toHaveBeenCalled();
  });
});
