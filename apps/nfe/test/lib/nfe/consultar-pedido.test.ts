/**
 * Unit tests for `consultarPedido` — the terminal guard + post-refactor
 * sanity of the shared `consultarChavePersistida` core.
 *
 * Guard regression: a doc already in a SEFAZ-final estado (aprovada /
 * cancelada / inutilizada) short-circuits with `reused: true` — zero SEFAZ
 * calls, zero writes. Without it, a consSit for a cancelada NF-e (which
 * still returns the ORIGINAL authorization protNFe, cStat 100) would flip
 * the doc back to aprovada.
 *
 * Mocking style mirrors `reconcile.test.ts`: Firestore handles, audit
 * writes, cert resolution and SEFAZ calls are mocked; `applyOutcome`,
 * `outcomeFromRetConsSit` and `isEstadoFinalNFe` run REAL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@delfrance/data/admin/collections', () => ({
  nfev4Collection: {
    ref: vi.fn(),
    docRef: vi.fn(),
    groupQuery: vi.fn(),
    parseRead: vi.fn((raw: unknown) => raw),
    // A write that bypassed the guarded persist (a plain merge on the doc ref)
    // would pass through here — kept a passthrough so it lands visibly.
    parseMerge: vi.fn((raw: unknown) => raw),
  },
  enviNfeMsgCollection: {},
}));
vi.mock('@delfrance/integrations-nfe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delfrance/integrations-nfe')>();
  return { ...actual, consultarLote: vi.fn(), consultarSituacaoNFe: vi.fn() };
});
vi.mock('../../../lib/nfe/orchestrator/sefaz-call', () => ({
  sefazCallFor: vi.fn(() => ({}) as never),
}));
vi.mock('../../../lib/nfe/orchestrator/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/nfe/orchestrator/audit')>();
  return {
    ...actual,
    persistPatch: vi.fn(),
    persistPatchUnlessFinal: vi.fn(async () => ({ written: true })),
    enviNfeCollection: vi.fn(() => ({ add: vi.fn() })),
    buildEnviNFeMsgFromConsulta: vi.fn(() => ({})),
    findLatestEnviNFeMsgWithNRec: vi.fn(async () => null),
  };
});
vi.mock('../../../lib/nfe/filial-cert', () => ({
  resolveFilialRuntime: vi.fn(async () => ({}) as never),
}));
vi.mock('../../../lib/nfe/orchestrator/bundle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/nfe/orchestrator/bundle')>();
  return { ...actual, loadPedidoBundle: vi.fn() };
});

import { consultarLote, consultarSituacaoNFe } from '@delfrance/integrations-nfe';
import { ESTADO_NFE } from '@delfrance/schemas';
import { nfev4Collection } from '@delfrance/data/admin/collections';

import {
  findLatestEnviNFeMsgWithNRec,
  persistPatchUnlessFinal,
} from '../../../lib/nfe/orchestrator/audit';
import { loadPedidoBundle } from '../../../lib/nfe/orchestrator/bundle';
import { consultarPedido } from '../../../lib/nfe/orchestrator/consultar';

const CHAVE = '35260614200166000187550010000000091400000010';
const PEDIDO = 'PED-1';

/** The slot's `updateTime` as the scan reads it — what the guarded write must carry (#1675). */
const LIDO = { isEqual: () => true, toMillis: () => 1 };

/** Seed the pedido's nfev4 slot scan (`nfev4Collection.ref(...).get()`) with one doc. */
function seedSlot(over: Record<string, unknown> = {}): void {
  const data = {
    estado: ESTADO_NFE.aguardandoResposta,
    chave: CHAVE,
    tpEmis: 1,
    nRec: null,
    retries: 0,
    cStat: null,
    xMotivo: null,
    xml_assinado: null,
    ultima_modificacao: 1,
    ...over,
  };
  vi.mocked(nfev4Collection.ref).mockReturnValue({
    get: async () => ({
      docs: [
        {
          id: 's1',
          ref: { path: `pedidos/${PEDIDO}/nfev4/s1` },
          updateTime: LIDO,
          data: () => data,
        },
      ],
    }),
  } as never);
  vi.mocked(nfev4Collection.docRef).mockReturnValue({
    id: 's1',
    path: `pedidos/${PEDIDO}/nfev4/s1`,
    set: vi.fn(),
  } as never);
}

function consSitRet(cStat: string, protCStat?: string): unknown {
  return {
    versao: '4.00',
    tpAmb: '2',
    verAplic: 'TEST',
    cStat,
    xMotivo: `motivo ${cStat}`,
    cUF: '35',
    dhRecbto: new Date().toISOString(),
    chNFe: CHAVE,
    ...(protCStat
      ? {
          protNFe: {
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
        }
      : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(nfev4Collection.parseRead).mockImplementation((raw: unknown) => raw as never);
  vi.mocked(loadPedidoBundle).mockResolvedValue({ pedidoId: PEDIDO, filialId: 'F-1' } as never);
  vi.mocked(persistPatchUnlessFinal).mockResolvedValue({ written: true });
});
afterEach(() => vi.restoreAllMocks());

describe('consultarPedido — terminal guard', () => {
  it.each([
    [ESTADO_NFE.cancelada, '101'],
    [ESTADO_NFE.aprovada, '100'],
  ])(
    "estado '%s' → returns the persisted doc with reused:true, ZERO SEFAZ calls, ZERO writes",
    async (estado, cStat) => {
      seedSlot({ estado, cStat, xMotivo: `motivo ${cStat}` });

      const r = await consultarPedido({} as never, {} as never, PEDIDO);

      expect(r).toMatchObject({
        pedidoId: PEDIDO,
        estado,
        chave: CHAVE,
        cStat,
        reused: true,
      });
      expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
      expect(vi.mocked(consultarLote)).not.toHaveBeenCalled();
      expect(vi.mocked(persistPatchUnlessFinal)).not.toHaveBeenCalled();
    },
  );
});

describe('consultarPedido — post-refactor sanity', () => {
  it("estado '2' with no nRec → consSit runs, patch persisted, reused:false", async () => {
    seedSlot();
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('100', '100') as never);

    const r = await consultarPedido({} as never, {} as never, PEDIDO);

    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledWith(expect.anything(), {
      chave: CHAVE,
    });
    expect(vi.mocked(consultarLote)).not.toHaveBeenCalled();
    expect(vi.mocked(persistPatchUnlessFinal)).toHaveBeenCalledTimes(1);
    const persisted = vi.mocked(persistPatchUnlessFinal).mock.calls[0]![2];
    expect(persisted.estado).toBe(ESTADO_NFE.aprovada);
    expect(r).toMatchObject({
      pedidoId: PEDIDO,
      estado: ESTADO_NFE.aprovada,
      chave: CHAVE,
      cStat: '100',
      reused: false,
    });
  });

  it('TOCTOU: the doc turned cancelada mid-call → guarded persist skips, the result reflects the live doc', async () => {
    // Read as aguardandoResposta, but by persist time the transaction sees a
    // cancelada doc — persistPatchUnlessFinal reports written:false.
    seedSlot();
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('100', '100') as never);
    vi.mocked(persistPatchUnlessFinal).mockResolvedValue({
      written: false,
      estadoAtual: ESTADO_NFE.cancelada,
      cStatAtual: '101',
      xMotivoAtual: 'Cancelamento de NF-e homologado',
      nRecAtual: null,
      chaveAtual: null,
    });

    const r = await consultarPedido({} as never, {} as never, PEDIDO);

    expect(r).toMatchObject({
      estado: ESTADO_NFE.cancelada,
      cStat: '101',
      xMotivo: 'Cancelamento de NF-e homologado',
      // #1675 — deliberately flipped from `false`: nothing was written, so the
      // reported state is another run's, never this consult's outcome.
      reused: true,
    });
  });
});

describe('consultarPedido — a send in progress (#1675)', () => {
  it.each([ESTADO_NFE.enviando, ESTADO_NFE.aguardandoResposta])(
    'a %s doc with no receipt under a future reservation → returned as is, reused, NO SEFAZ call, NO write',
    async (estado) => {
      seedSlot({ estado, idLote: '7', proximaConsultaEm: (Date.now() + 60_000) * 1000 });

      const r = await consultarPedido({} as never, {} as never, PEDIDO);

      expect(r).toMatchObject({ estado, reused: true });
      expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
      expect(vi.mocked(consultarLote)).not.toHaveBeenCalled();
      expect(vi.mocked(persistPatchUnlessFinal)).not.toHaveBeenCalled();
    },
  );

  it('a REFUSED write reports the live doc as reused — a state another run wrote, not this consult’s', async () => {
    seedSlot();
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('217') as never);
    vi.mocked(persistPatchUnlessFinal).mockResolvedValue({
      written: false,
      estadoAtual: ESTADO_NFE.enviando,
      cStatAtual: null,
      xMotivoAtual: null,
      nRecAtual: null,
      chaveAtual: CHAVE,
    });

    const r = await consultarPedido({} as never, {} as never, PEDIDO);

    // The live doc's truth only: no cStat/xMotivo of its own yet, never this
    // consult's 217.
    expect(r).toMatchObject({ estado: ESTADO_NFE.enviando, cStat: '', xMotivo: '', reused: true });
  });

  it('a REFUSED write reports the live doc’s chave (another run regenerated it), not the one this call read', async () => {
    seedSlot();
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('217') as never);
    const CHAVE_VIVA = `${CHAVE.slice(0, 43)}${CHAVE.endsWith('9') ? '0' : '9'}`;
    vi.mocked(persistPatchUnlessFinal).mockResolvedValue({
      written: false,
      estadoAtual: ESTADO_NFE.enviando,
      cStatAtual: null,
      xMotivoAtual: null,
      nRecAtual: null,
      chaveAtual: CHAVE_VIVA,
    });

    const r = await consultarPedido({} as never, {} as never, PEDIDO);

    expect(r).toMatchObject({ chave: CHAVE_VIVA, reused: true });
  });

  it('near-miss: an EXPIRED reservation is consulted, and the write is owned by the read (updateTime + no live send)', async () => {
    seedSlot({ idLote: '7', proximaConsultaEm: (Date.now() - 60_000) * 1000 });
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('100', '100') as never);

    await consultarPedido({} as never, {} as never, PEDIDO);

    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(persistPatchUnlessFinal)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(persistPatchUnlessFinal).mock.calls[0]![4]).toEqual({
      expectedUpdateTime: LIDO,
      refuseWhileReserved: true,
    });
  });
});

describe('consultarPedido — a recovered 539 swaps the chave only in the guarded write (#1654 §2d)', () => {
  /** The chave SEFAZ asserts holds our número (another emission of it). */
  const OUTRA_CHAVE = '35260614200166000187550010000000099400000019';

  /**
   * Our receipt REC-1 answers a 539 for CHAVE asserting OUTRA_CHAVE; the audit
   * log knows OUTRA_CHAVE from receipt REC-0, which authorizes it.
   */
  function seed539Recuperavel(): void {
    seedSlot();
    vi.mocked(findLatestEnviNFeMsgWithNRec).mockImplementation(
      async (_fs, _filial, chave) => ({ nRec: chave === CHAVE ? 'REC-1' : 'REC-0' }) as never,
    );
    vi.mocked(consultarLote).mockImplementation(
      async (_call, { nRec }) =>
        ({
          versao: '4.00',
          tpAmb: '2',
          verAplic: 'TEST',
          nRec,
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
                chNFe: nRec === 'REC-1' ? CHAVE : OUTRA_CHAVE,
                dhRecbto: new Date().toISOString(),
                nProt: '135000000000000',
                cStat: nRec === 'REC-1' ? '539' : '100',
                xMotivo:
                  nRec === 'REC-1'
                    ? `Rejeicao: Duplicidade de NF-e com diferenca na Chave de Acesso [chNFe:${OUTRA_CHAVE}]`
                    : 'Autorizado o uso da NF-e',
              },
            },
          ],
        }) as never,
    );
  }

  afterEach(() => {
    // clearAllMocks keeps implementations — never let these leak.
    vi.mocked(findLatestEnviNFeMsgWithNRec).mockImplementation(async () => null);
    vi.mocked(consultarLote).mockReset();
  });

  /** The nfev4 doc ref the call wrote through — a plain merge would show on its `set`. */
  function refDoDoc(): { set: ReturnType<typeof vi.fn> } {
    return vi.mocked(nfev4Collection.docRef).mock.results.at(-1)!.value as {
      set: ReturnType<typeof vi.fn>;
    };
  }

  it('control: ONE guarded write carries the recovered estado AND the chave; the result names the recovered chave', async () => {
    seed539Recuperavel();

    const r = await consultarPedido({} as never, {} as never, PEDIDO);

    expect(vi.mocked(consultarLote).mock.calls.map(([, a]) => a.nRec)).toEqual(['REC-1', 'REC-0']);
    expect(vi.mocked(persistPatchUnlessFinal)).toHaveBeenCalledTimes(1);
    const [, , patch, extras] = vi.mocked(persistPatchUnlessFinal).mock.calls[0]!;
    expect(patch).toMatchObject({ estado: ESTADO_NFE.aprovada, cStat: '100' });
    expect(extras).toEqual({ chave: OUTRA_CHAVE });
    // No write of its own on the doc ref — the swap rides the guarded one.
    expect(refDoDoc().set).not.toHaveBeenCalled();
    expect(r).toMatchObject({ estado: ESTADO_NFE.aprovada, chave: OUTRA_CHAVE, reused: false });
  });

  it('the doc turned cancelada mid-call → the guarded write is refused, NOTHING swaps the chave, and the result keeps the original chave', async () => {
    seed539Recuperavel();
    vi.mocked(persistPatchUnlessFinal).mockResolvedValue({
      written: false,
      estadoAtual: ESTADO_NFE.cancelada,
      cStatAtual: '101',
      xMotivoAtual: 'Cancelamento de NF-e homologado',
      nRecAtual: 'REC-1',
      chaveAtual: null,
    });

    const r = await consultarPedido({} as never, {} as never, PEDIDO);

    // The refused write carried the swap — and nothing else did.
    expect(vi.mocked(persistPatchUnlessFinal).mock.calls[0]![3]).toEqual({ chave: OUTRA_CHAVE });
    expect(refDoDoc().set).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      estado: ESTADO_NFE.cancelada,
      cStat: '101',
      chave: CHAVE,
      // #1675 — deliberately flipped from `false`: the refused write reports a
      // state another run wrote.
      reused: true,
    });
  });
});
