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

import { persistPatchUnlessFinal } from '../../../lib/nfe/orchestrator/audit';
import { loadPedidoBundle } from '../../../lib/nfe/orchestrator/bundle';
import { consultarPedido } from '../../../lib/nfe/orchestrator/consultar';

const CHAVE = '35260614200166000187550010000000091400000010';
const PEDIDO = 'PED-1';

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
      docs: [{ id: 's1', ref: { path: `pedidos/${PEDIDO}/nfev4/s1` }, data: () => data }],
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
    });

    const r = await consultarPedido({} as never, {} as never, PEDIDO);

    expect(r).toMatchObject({
      estado: ESTADO_NFE.cancelada,
      cStat: '101',
      xMotivo: 'Cancelamento de NF-e homologado',
      reused: false,
    });
  });
});
