/**
 * Unit tests for `verificarEnviNfeMsgs` — the manual re-verification core.
 *
 * Mocks the Firestore collection handles (`enviNfeMsgCollection.docRef`,
 * `nfev4Collection.groupQuery`), the audit writes (`persistPatchUnlessFinal` /
 * `enviNfeCollection` / `buildEnviNFeMsgFromConsulta` /
 * `findLatestEnviNFeMsgWithNRec`), the filial cert resolution and the SEFAZ
 * calls (`consultarLote` / `consultarSituacaoNFe`). The decision logic runs
 * REAL: `consultarChavePersistida`, `outcomeFromConsReci`,
 * `outcomeFromRetConsSit`, `applyOutcome`, `classifyCStat`,
 * `isEstadoFinalNFe`.
 *
 * Pinned invariants: final estados skip SEFAZ entirely; a cancelada consSit
 * (top 101 + inner 100) never regresses to aprovada; the loop is per-chave
 * isolated except for cStat=656, which aborts the rest of the run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@delfrance/data/admin/collections', () => ({
  nfev4Collection: {
    groupQuery: vi.fn(),
    parseRead: vi.fn((raw: unknown) => raw),
    ref: vi.fn(),
    docRef: vi.fn(),
  },
  enviNfeMsgCollection: { docRef: vi.fn(), parseRead: vi.fn((raw: unknown) => raw) },
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

import {
  NFeTransportError,
  consultarLote,
  consultarSituacaoNFe,
} from '@delfrance/integrations-nfe';
import { ESTADO_NFE } from '@delfrance/schemas';
import { enviNfeMsgCollection, nfev4Collection } from '@delfrance/data/admin/collections';

import {
  buildEnviNFeMsgFromConsulta,
  findLatestEnviNFeMsgWithNRec,
  persistPatchUnlessFinal,
} from '../../../lib/nfe/orchestrator/audit';
import {
  MAX_CHAVES_POR_VERIFICACAO,
  verificarEnviNfeMsgs,
} from '../../../lib/nfe/orchestrator/verificar';

const FILIAL = 'F-1';
const CHAVE_A = '35260614200166000187550010000000091400000010';
const CHAVE_B = '35260614200166000187550010000000092400000011';

/** Seed `enviNfeMsgCollection.docRef(fs, ctx, id).get()` with msg docs by id. */
function seedMsgs(msgs: Record<string, { targetsChnfe: string[] } | null>): void {
  vi.mocked(enviNfeMsgCollection.docRef).mockImplementation(
    (_fs, _ctx, id) =>
      ({
        path: `filiais/${FILIAL}/enviNfe/${id}`,
        get: async () => ({
          exists: msgs[id] != null,
          data: () => msgs[id],
          ref: { path: `filiais/${FILIAL}/enviNfe/${id}` },
        }),
      }) as never,
  );
}

/** One seeded nfev4 doc keyed by its chave field. */
interface SeededNota {
  chave: string;
  estado: string;
  pedidoId?: string;
  cStat?: string | null;
  xMotivo?: string | null;
  retries?: number;
  ultima_modificacao?: number;
  xml_assinado?: string | null;
  proximaConsultaEm?: number | null;
}

/** Seed `nfev4Collection.groupQuery(fs).where('chave','==',x).get()`. */
function seedNfev4(notas: SeededNota[]): void {
  vi.mocked(nfev4Collection.groupQuery).mockReturnValue({
    where: (_field: string, _op: string, chave: unknown) => ({
      get: async () => ({
        docs: notas
          .filter((n) => n.chave === chave)
          .map((n) => {
            const pedidoId = n.pedidoId ?? 'PED-1';
            return {
              ref: {
                path: `pedidos/${pedidoId}/nfev4/s1`,
                parent: { parent: { id: pedidoId } },
                set: vi.fn(),
              },
              data: () => ({
                cStat: null,
                xMotivo: null,
                retries: 0,
                xml_assinado: null,
                ultima_modificacao: 1,
                proximaConsultaEm: null,
                ...n,
              }),
            };
          }),
      }),
    }),
  } as never);
}

function consSitRet(cStat: string, opts: { protCStat?: string; xMotivo?: string } = {}): unknown {
  return {
    versao: '4.00',
    tpAmb: '2',
    verAplic: 'TEST',
    cStat,
    xMotivo: opts.xMotivo ?? `motivo ${cStat}`,
    cUF: '35',
    dhRecbto: new Date().toISOString(),
    chNFe: CHAVE_A,
    ...(opts.protCStat
      ? {
          protNFe: {
            versao: '4.00',
            infProt: {
              tpAmb: '2',
              verAplic: 'TEST',
              chNFe: CHAVE_A,
              dhRecbto: new Date().toISOString(),
              cStat: opts.protCStat,
              xMotivo: `prot ${opts.protCStat}`,
              nProt: '135000000000000',
              digVal: 'd',
            },
          },
        }
      : {}),
  };
}

function consReciRet(cStat: string, protCStat?: string): unknown {
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
              chNFe: CHAVE_A,
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

const baseArgs = [{} as never, {} as never] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(nfev4Collection.parseRead).mockImplementation((raw: unknown) => raw as never);
  vi.mocked(enviNfeMsgCollection.parseRead).mockImplementation((raw: unknown) => raw as never);
  vi.mocked(findLatestEnviNFeMsgWithNRec).mockResolvedValue(null);
  vi.mocked(persistPatchUnlessFinal).mockResolvedValue({ written: true });
});
afterEach(() => vi.restoreAllMocks());

describe('verificarEnviNfeMsgs', () => {
  it.each([
    [ESTADO_NFE.aprovada, '100'],
    [ESTADO_NFE.cancelada, '101'],
    [ESTADO_NFE.numeracaoInutilizada, '102'],
  ])(
    "final estado '%s' → skipped-final, ZERO SEFAZ calls, ZERO writes, ZERO audit docs",
    async (estado, cStat) => {
      seedMsgs({ 'msg-1': { targetsChnfe: [CHAVE_A] } });
      seedNfev4([{ chave: CHAVE_A, estado, cStat, xMotivo: `motivo ${cStat}` }]);

      const r = await verificarEnviNfeMsgs(...baseArgs, {
        filialId: FILIAL,
        enviNfeMsgIds: ['msg-1'],
      });

      expect(r.results).toEqual([
        {
          chave: CHAVE_A,
          status: 'skipped-final',
          estadoAnterior: estado,
          estadoNovo: estado,
          cStat,
          xMotivo: `motivo ${cStat}`,
          error: null,
        },
      ]);
      expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
      expect(vi.mocked(consultarLote)).not.toHaveBeenCalled();
      expect(vi.mocked(persistPatchUnlessFinal)).not.toHaveBeenCalled();
      expect(vi.mocked(buildEnviNFeMsgFromConsulta)).not.toHaveBeenCalled();
    },
  );

  it("stale 'e' doc + consSit 100 → atualizada 'a', with audit doc + persisted patch", async () => {
    seedMsgs({ 'msg-1': { targetsChnfe: [CHAVE_A] } });
    seedNfev4([{ chave: CHAVE_A, estado: ESTADO_NFE.error, cStat: '999' }]);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(
      consSitRet('100', { protCStat: '100' }) as never,
    );

    const r = await verificarEnviNfeMsgs(...baseArgs, {
      filialId: FILIAL,
      enviNfeMsgIds: ['msg-1'],
    });

    expect(r.results[0]).toMatchObject({
      chave: CHAVE_A,
      status: 'atualizada',
      estadoAnterior: ESTADO_NFE.error,
      estadoNovo: ESTADO_NFE.aprovada,
      cStat: '100',
    });
    // No nRec in the audit log → straight consSit, never consReci.
    expect(vi.mocked(consultarLote)).not.toHaveBeenCalled();
    expect(vi.mocked(buildEnviNFeMsgFromConsulta)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(persistPatchUnlessFinal)).toHaveBeenCalledTimes(1);
  });

  it("cancelada truth: doc '2' + consSit top 101 with inner protNFe 100 → estadoNovo 'c', never 'a'", async () => {
    seedMsgs({ 'msg-1': { targetsChnfe: [CHAVE_A] } });
    seedNfev4([{ chave: CHAVE_A, estado: ESTADO_NFE.aguardandoResposta }]);
    // The SEFAZ trap: cancelamento at the top, ORIGINAL authorization inside.
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(
      consSitRet('101', { protCStat: '100', xMotivo: 'Cancelamento de NF-e homologado' }) as never,
    );

    const r = await verificarEnviNfeMsgs(...baseArgs, {
      filialId: FILIAL,
      enviNfeMsgIds: ['msg-1'],
    });

    expect(r.results[0]).toMatchObject({
      status: 'atualizada',
      estadoNovo: ESTADO_NFE.cancelada,
      cStat: '101',
    });
    const persisted = vi.mocked(persistPatchUnlessFinal).mock.calls[0]![2];
    expect(persisted.estado).toBe(ESTADO_NFE.cancelada);
  });

  it('nRec in the audit log → consReci (consultarLote), NOT consSit', async () => {
    seedMsgs({ 'msg-1': { targetsChnfe: [CHAVE_A] } });
    seedNfev4([{ chave: CHAVE_A, estado: ESTADO_NFE.aguardandoResposta }]);
    vi.mocked(findLatestEnviNFeMsgWithNRec).mockResolvedValue({ nRec: 'REC-1' } as never);
    vi.mocked(consultarLote).mockResolvedValue(consReciRet('104', '100') as never);

    const r = await verificarEnviNfeMsgs(...baseArgs, {
      filialId: FILIAL,
      enviNfeMsgIds: ['msg-1'],
    });

    expect(r.results[0]).toMatchObject({ status: 'atualizada', estadoNovo: ESTADO_NFE.aprovada });
    expect(vi.mocked(consultarLote)).toHaveBeenCalledWith(expect.anything(), { nRec: 'REC-1' });
    expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
  });

  it('nRec path landing 106 (lote não localizado) falls through to consSit — the consSit outcome wins', async () => {
    seedMsgs({ 'msg-1': { targetsChnfe: [CHAVE_A] } });
    seedNfev4([{ chave: CHAVE_A, estado: ESTADO_NFE.aguardandoResposta }]);
    vi.mocked(findLatestEnviNFeMsgWithNRec).mockResolvedValue({ nRec: 'REC-1' } as never);
    vi.mocked(consultarLote).mockResolvedValue(consReciRet('106') as never);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(
      consSitRet('100', { protCStat: '100' }) as never,
    );

    const r = await verificarEnviNfeMsgs(...baseArgs, {
      filialId: FILIAL,
      enviNfeMsgIds: ['msg-1'],
    });

    expect(vi.mocked(consultarLote)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
    // Both round-trips audited.
    expect(vi.mocked(buildEnviNFeMsgFromConsulta)).toHaveBeenCalledTimes(2);
    expect(r.results[0]).toMatchObject({
      status: 'atualizada',
      estadoNovo: ESTADO_NFE.aprovada,
      cStat: '100',
    });
  });

  it('per-chave error isolation: a transport failure on one chave never sinks the next', async () => {
    seedMsgs({ 'msg-1': { targetsChnfe: [CHAVE_A, CHAVE_B] } });
    seedNfev4([
      { chave: CHAVE_A, estado: ESTADO_NFE.aguardandoResposta },
      { chave: CHAVE_B, estado: ESTADO_NFE.aguardandoResposta },
    ]);
    vi.mocked(consultarSituacaoNFe)
      .mockRejectedValueOnce(
        new NFeTransportError('SEFAZ HTTP 500', 500, '<xml>raw-sefaz-body</xml>'),
      )
      .mockResolvedValueOnce(consSitRet('100', { protCStat: '100' }) as never);

    const r = await verificarEnviNfeMsgs(...baseArgs, {
      filialId: FILIAL,
      enviNfeMsgIds: ['msg-1'],
    });

    expect(r.results[0]).toMatchObject({
      chave: CHAVE_A,
      status: 'erro',
      error: 'NFeTransportError: SEFAZ HTTP 500',
    });
    // The raw SEFAZ body (responseBody) must never leak into the result.
    expect(JSON.stringify(r)).not.toContain('raw-sefaz-body');
    expect(r.results[1]).toMatchObject({ chave: CHAVE_B, status: 'atualizada' });
  });

  it('cStat 656 (consumo indevido) aborts the run — remaining chaves get erro, NO further SEFAZ calls', async () => {
    seedMsgs({ 'msg-1': { targetsChnfe: [CHAVE_A, CHAVE_B] } });
    seedNfev4([
      { chave: CHAVE_A, estado: ESTADO_NFE.aguardandoResposta },
      { chave: CHAVE_B, estado: ESTADO_NFE.aguardandoResposta },
    ]);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('656') as never);

    const r = await verificarEnviNfeMsgs(...baseArgs, {
      filialId: FILIAL,
      enviNfeMsgIds: ['msg-1'],
    });

    expect(r.results[0]).toMatchObject({ chave: CHAVE_A, cStat: '656' });
    expect(r.results[1]).toEqual({
      chave: CHAVE_B,
      status: 'erro',
      estadoAnterior: null,
      estadoNovo: null,
      cStat: null,
      xMotivo: null,
      error: 'verificação interrompida — cStat 656 (consumo indevido)',
    });
    // Exactly ONE SEFAZ call — the one that surfaced the 656.
    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
  });

  it('dedupes a chave shared across msgs — one consult, one result', async () => {
    seedMsgs({
      'msg-1': { targetsChnfe: [CHAVE_A] },
      'msg-2': { targetsChnfe: [CHAVE_A] },
    });
    seedNfev4([{ chave: CHAVE_A, estado: ESTADO_NFE.aguardandoResposta }]);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(
      consSitRet('100', { protCStat: '100' }) as never,
    );

    const r = await verificarEnviNfeMsgs(...baseArgs, {
      filialId: FILIAL,
      enviNfeMsgIds: ['msg-1', 'msg-2'],
    });

    expect(r.results).toHaveLength(1);
    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
    expect(r.msgsNaoEncontradas).toEqual([]);
  });

  it('unknown msg id → msgsNaoEncontradas (the known one still runs)', async () => {
    seedMsgs({ 'msg-1': { targetsChnfe: [CHAVE_A] }, 'msg-missing': null });
    seedNfev4([{ chave: CHAVE_A, estado: ESTADO_NFE.aprovada, cStat: '100' }]);

    const r = await verificarEnviNfeMsgs(...baseArgs, {
      filialId: FILIAL,
      enviNfeMsgIds: ['msg-1', 'msg-missing'],
    });

    expect(r.msgsNaoEncontradas).toEqual(['msg-missing']);
    expect(r.results).toHaveLength(1);
  });

  it("chave with no nfev4 doc → 'erro' with no SEFAZ call", async () => {
    seedMsgs({ 'msg-1': { targetsChnfe: [CHAVE_A] } });
    seedNfev4([]);

    const r = await verificarEnviNfeMsgs(...baseArgs, {
      filialId: FILIAL,
      enviNfeMsgIds: ['msg-1'],
    });

    expect(r.results[0]).toEqual({
      chave: CHAVE_A,
      status: 'erro',
      estadoAnterior: null,
      estadoNovo: null,
      cStat: null,
      xMotivo: null,
      error: 'nenhum documento nfev4 com esta chave',
    });
    expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
    expect(vi.mocked(consultarLote)).not.toHaveBeenCalled();
    expect(vi.mocked(persistPatchUnlessFinal)).not.toHaveBeenCalled();
  });

  it("an unchanged estado reports 'sem-mudanca'", async () => {
    seedMsgs({ 'msg-1': { targetsChnfe: [CHAVE_A] } });
    // aguardandoResposta + consSit 105-ish top-level keeps the estado.
    seedNfev4([{ chave: CHAVE_A, estado: ESTADO_NFE.aguardandoResposta }]);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('105') as never);

    const r = await verificarEnviNfeMsgs(...baseArgs, {
      filialId: FILIAL,
      enviNfeMsgIds: ['msg-1'],
    });

    expect(r.results[0]).toMatchObject({
      status: 'sem-mudanca',
      estadoAnterior: ESTADO_NFE.aguardandoResposta,
      estadoNovo: ESTADO_NFE.aguardandoResposta,
    });
  });

  it('caps the SEFAZ fan-out: 25 chaves in one msg → 20 consulted, 5 capped erro entries', async () => {
    const chaves = Array.from(
      { length: 25 },
      (_, i) => `${CHAVE_A.slice(0, 42)}${String(i).padStart(2, '0')}`,
    );
    seedMsgs({ 'msg-1': { targetsChnfe: chaves } });
    seedNfev4(chaves.map((chave) => ({ chave, estado: ESTADO_NFE.aguardandoResposta })));
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(
      consSitRet('105', { xMotivo: 'Lote em processamento' }) as never,
    );

    const r = await verificarEnviNfeMsgs(...baseArgs, {
      filialId: FILIAL,
      enviNfeMsgIds: ['msg-1'],
    });

    expect(r.results).toHaveLength(25);
    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(MAX_CHAVES_POR_VERIFICACAO);
    for (const entry of r.results.slice(0, MAX_CHAVES_POR_VERIFICACAO)) {
      expect(entry.status).toBe('sem-mudanca');
    }
    for (const [i, entry] of r.results.slice(MAX_CHAVES_POR_VERIFICACAO).entries()) {
      expect(entry).toEqual({
        chave: chaves[MAX_CHAVES_POR_VERIFICACAO + i],
        status: 'erro',
        estadoAnterior: null,
        estadoNovo: null,
        cStat: null,
        xMotivo: null,
        error: 'não consultada — limite de 20 chaves por verificação',
      });
    }
  });

  it("future proximaConsultaEm (reconciler scheduled) → 'sem-mudanca' with the agendada xMotivo, NO SEFAZ call, NO writes", async () => {
    const futureMicros = (Date.now() + 5 * 60_000) * 1000;
    seedMsgs({ 'msg-1': { targetsChnfe: [CHAVE_A] } });
    seedNfev4([
      {
        chave: CHAVE_A,
        estado: ESTADO_NFE.aguardandoResposta,
        cStat: '103',
        proximaConsultaEm: futureMicros,
      },
    ]);

    const r = await verificarEnviNfeMsgs(...baseArgs, {
      filialId: FILIAL,
      enviNfeMsgIds: ['msg-1'],
    });

    expect(r.results[0]).toEqual({
      chave: CHAVE_A,
      status: 'sem-mudanca',
      estadoAnterior: ESTADO_NFE.aguardandoResposta,
      estadoNovo: ESTADO_NFE.aguardandoResposta,
      cStat: '103',
      xMotivo: `consulta agendada pelo reconciliador para ${new Date(
        futureMicros / 1000,
      ).toISOString()}`,
      error: null,
    });
    expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
    expect(vi.mocked(consultarLote)).not.toHaveBeenCalled();
    expect(vi.mocked(persistPatchUnlessFinal)).not.toHaveBeenCalled();
    expect(vi.mocked(buildEnviNFeMsgFromConsulta)).not.toHaveBeenCalled();
  });

  it.each([
    ['past', (Date.now() - 60_000) * 1000],
    ['null', null],
  ])('%s proximaConsultaEm → the consulta proceeds (the stuck case)', async (_label, value) => {
    seedMsgs({ 'msg-1': { targetsChnfe: [CHAVE_A] } });
    seedNfev4([
      { chave: CHAVE_A, estado: ESTADO_NFE.aguardandoResposta, proximaConsultaEm: value },
    ]);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(
      consSitRet('100', { protCStat: '100' }) as never,
    );

    const r = await verificarEnviNfeMsgs(...baseArgs, {
      filialId: FILIAL,
      enviNfeMsgIds: ['msg-1'],
    });

    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
    expect(r.results[0]).toMatchObject({ status: 'atualizada', estadoNovo: ESTADO_NFE.aprovada });
  });

  it('two chaves sharing one nRec → consultarLote called EXACTLY once, one audit doc, per-chave outcomes', async () => {
    seedMsgs({ 'msg-1': { targetsChnfe: [CHAVE_A, CHAVE_B] } });
    seedNfev4([
      { chave: CHAVE_A, estado: ESTADO_NFE.aguardandoResposta },
      { chave: CHAVE_B, estado: ESTADO_NFE.aguardandoResposta },
    ]);
    vi.mocked(findLatestEnviNFeMsgWithNRec).mockResolvedValue({ nRec: 'REC-1' } as never);
    const infProt = (chNFe: string, cStat: string) => ({
      versao: '4.00',
      infProt: {
        tpAmb: '2',
        verAplic: 'TEST',
        chNFe,
        dhRecbto: new Date().toISOString(),
        cStat,
        xMotivo: `prot ${cStat}`,
        nProt: '135000000000000',
        digVal: 'd',
      },
    });
    vi.mocked(consultarLote).mockResolvedValue({
      versao: '4.00',
      tpAmb: '2',
      verAplic: 'TEST',
      nRec: 'REC-1',
      cStat: '104',
      xMotivo: 'Lote processado',
      cUF: '35',
      dhRecbto: new Date().toISOString(),
      protNFe: [infProt(CHAVE_A, '100'), infProt(CHAVE_B, '110')],
    } as never);

    const r = await verificarEnviNfeMsgs(...baseArgs, {
      filialId: FILIAL,
      enviNfeMsgIds: ['msg-1'],
    });

    // ONE consReciNFe round-trip for the shared nRec — the 656 vector fix.
    expect(vi.mocked(consultarLote)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
    // ONE audit doc — the cache hit must not duplicate the row.
    expect(vi.mocked(buildEnviNFeMsgFromConsulta)).toHaveBeenCalledTimes(1);
    // Each chave still resolves ITS OWN protocol from the shared response.
    expect(r.results[0]).toMatchObject({
      chave: CHAVE_A,
      status: 'atualizada',
      estadoNovo: ESTADO_NFE.aprovada,
      cStat: '100',
    });
    expect(r.results[1]).toMatchObject({
      chave: CHAVE_B,
      status: 'atualizada',
      estadoNovo: ESTADO_NFE.rejeitada,
      cStat: '110',
    });
    expect(vi.mocked(persistPatchUnlessFinal)).toHaveBeenCalledTimes(2);
  });
});
