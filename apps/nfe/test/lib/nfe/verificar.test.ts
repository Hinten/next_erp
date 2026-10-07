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
  RECONCILE_INDISPONIVEL_DELAY_MS,
  consultarLote,
  consultarSituacaoNFe,
  isBloqueada,
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
  nRec?: string | null;
  idLote?: string | null;
}

/** Seed `nfev4Collection.groupQuery(fs).where('chave','==',x).get()`. */
function seedNfev4(notas: SeededNota[], updateTime?: unknown): void {
  vi.mocked(nfev4Collection.groupQuery).mockReturnValue({
    where: (_field: string, _op: string, chave: unknown) => ({
      get: async () => ({
        docs: notas
          .filter((n) => n.chave === chave)
          .map((n) => {
            const pedidoId = n.pedidoId ?? 'PED-1';
            return {
              updateTime,
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
        nRec: '351000000000123',
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

  it.each([ESTADO_NFE.enviando, ESTADO_NFE.aguardandoResposta])(
    "a doc with NO receipt under a future proximaConsultaEm (%s) has a send in progress (#1675) → 'sem-mudanca' naming the send, NO SEFAZ call, NO writes",
    async (estado) => {
      const futureMicros = (Date.now() + 5 * 60_000) * 1000;
      seedMsgs({ 'msg-1': { targetsChnfe: [CHAVE_A] } });
      seedNfev4([{ chave: CHAVE_A, estado, idLote: '7', proximaConsultaEm: futureMicros }]);

      const r = await verificarEnviNfeMsgs(...baseArgs, {
        filialId: FILIAL,
        enviNfeMsgIds: ['msg-1'],
      });

      expect(r.results[0]).toMatchObject({
        chave: CHAVE_A,
        status: 'sem-mudanca',
        estadoNovo: estado,
        xMotivo: `envio em curso ou nova tentativa agendada até ${new Date(
          futureMicros / 1000,
        ).toISOString()}`,
      });
      expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
      expect(vi.mocked(consultarLote)).not.toHaveBeenCalled();
      expect(vi.mocked(persistPatchUnlessFinal)).not.toHaveBeenCalled();
    },
  );

  it('a REFUSED write (#1675 — the doc changed during the consult) is reported as nothing written, never "atualizada"', async () => {
    seedMsgs({ 'msg-1': { targetsChnfe: [CHAVE_A] } });
    seedNfev4([{ chave: CHAVE_A, estado: ESTADO_NFE.aguardandoResposta }]);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('217') as never);
    vi.mocked(persistPatchUnlessFinal).mockResolvedValueOnce({
      written: false,
      estadoAtual: ESTADO_NFE.enviando,
      cStatAtual: null,
      xMotivoAtual: null,
      nRecAtual: null,
      chaveAtual: CHAVE_A,
    });

    const r = await verificarEnviNfeMsgs(...baseArgs, {
      filialId: FILIAL,
      enviNfeMsgIds: ['msg-1'],
    });

    expect(r.results[0]).toMatchObject({
      chave: CHAVE_A,
      status: 'sem-mudanca',
      estadoAnterior: ESTADO_NFE.aguardandoResposta,
      estadoNovo: ESTADO_NFE.enviando,
      error: null,
    });
    expect(r.results[0]!.xMotivo).toContain('nada gravado');
  });

  it('the consult’s write is owned by the read (#1675): the guard carries the snapshot’s updateTime and refuses while a send is in progress', async () => {
    const lido = { isEqual: () => true, toMillis: () => 1 };
    seedMsgs({ 'msg-1': { targetsChnfe: [CHAVE_A] } });
    seedNfev4([{ chave: CHAVE_A, estado: ESTADO_NFE.aguardandoResposta }], lido);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(
      consSitRet('100', { protCStat: '100' }) as never,
    );

    await verificarEnviNfeMsgs(...baseArgs, { filialId: FILIAL, enviNfeMsgIds: ['msg-1'] });

    expect(vi.mocked(persistPatchUnlessFinal)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(persistPatchUnlessFinal).mock.calls[0]![4]).toEqual({
      expectedUpdateTime: lido,
      refuseWhileReserved: true,
    });
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

describe('verificarEnviNfeMsgs — the receipt round shares reconcile’s decision and recovery table (#1654)', () => {
  /** One in-flight doc for CHAVE_A whose audit log holds receipt REC-1. */
  function comRecibo(estado: string = ESTADO_NFE.aguardandoResposta): void {
    seedMsgs({ 'msg-1': { targetsChnfe: [CHAVE_A] } });
    seedNfev4([{ chave: CHAVE_A, estado }]);
    vi.mocked(findLatestEnviNFeMsgWithNRec).mockResolvedValue({ nRec: 'REC-1' } as never);
  }

  async function verificar(): Promise<Awaited<ReturnType<typeof verificarEnviNfeMsgs>>> {
    return verificarEnviNfeMsgs(...baseArgs, { filialId: FILIAL, enviNfeMsgIds: ['msg-1'] });
  }

  /** The patch the (single) guarded write persisted. */
  function persistido(): Parameters<typeof persistPatchUnlessFinal>[2] {
    expect(vi.mocked(persistPatchUnlessFinal)).toHaveBeenCalledTimes(1);
    return vi.mocked(persistPatchUnlessFinal).mock.calls[0]![2];
  }

  it('a processed lote (104) WITHOUT our protNFe → exactly ONE consSit for the chave; 100 → aprovada', async () => {
    comRecibo();
    vi.mocked(consultarLote).mockResolvedValue(consReciRet('104') as never);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(
      consSitRet('100', { protCStat: '100' }) as never,
    );

    const r = await verificar();

    expect(vi.mocked(consultarLote)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledWith(expect.anything(), {
      chave: CHAVE_A,
    });
    expect(r.results[0]).toMatchObject({
      status: 'atualizada',
      estadoNovo: ESTADO_NFE.aprovada,
      cStat: '100',
    });
  });

  it('our protNFe 635 + consSit 217 → still aguardandoResposta (wait), never rejeitada; the receipt is kept', async () => {
    comRecibo();
    vi.mocked(consultarLote).mockResolvedValue(consReciRet('104', '635') as never);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('217') as never);

    const r = await verificar();

    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
    expect(r.results[0]).toMatchObject({
      status: 'sem-mudanca',
      estadoNovo: ESTADO_NFE.aguardandoResposta,
    });
    const patch = persistido();
    expect(patch.estado).toBe(ESTADO_NFE.aguardandoResposta);
    // nRec null → the persist leaves the stored receipt untouched.
    expect(patch.nRec).toBeNull();
    expect(patch.xMotivo).toContain('cStat 217');
  });

  it.each<[string, string, unknown]>([
    ['204', '217', consSitRet('217')],
    ['205', '110 (denegada)', consSitRet('110', { protCStat: '110' })],
    ['218', '562', consSitRet('562')],
  ])(
    'our protNFe %s + consSit %s → terminal error KEEPING cStat 104 (blocking), never rejeitada',
    async (protCStat, _caso, retSit) => {
      comRecibo();
      vi.mocked(consultarLote).mockResolvedValue(consReciRet('104', protCStat) as never);
      vi.mocked(consultarSituacaoNFe).mockResolvedValue(retSit as never);

      const r = await verificar();

      expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
      expect(r.results[0]).toMatchObject({
        status: 'atualizada',
        estadoNovo: ESTADO_NFE.error,
        cStat: '104',
      });
      expect(isBloqueada(r.results[0]!.cStat)).toBe(true);
      expect(r.results[0]!.xMotivo).toMatch(/verificar manualmente/);
    },
  );

  it('our protNFe 204 + consSit 100 → aprovada (the duplicidade was a lost response)', async () => {
    comRecibo();
    vi.mocked(consultarLote).mockResolvedValue(consReciRet('104', '204') as never);
    vi.mocked(consultarSituacaoNFe).mockResolvedValue(
      consSitRet('100', { protCStat: '100' }) as never,
    );

    const r = await verificar();

    expect(r.results[0]).toMatchObject({ estadoNovo: ESTADO_NFE.aprovada, cStat: '100' });
  });

  it('a refused consReci query (252) → terminal error with the BLOCKING cStat 103, no consSit', async () => {
    comRecibo();
    vi.mocked(consultarLote).mockResolvedValue(consReciRet('252') as never);

    const r = await verificar();

    expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
    expect(r.results[0]).toMatchObject({ estadoNovo: ESTADO_NFE.error, cStat: '103' });
    expect(r.results[0]!.xMotivo).toContain('cStat 252');
  });

  it('pin: a lote-level 656 on the first chave aborts the run — the second chave is never consulted, not even by receipt', async () => {
    seedMsgs({ 'msg-1': { targetsChnfe: [CHAVE_A, CHAVE_B] } });
    seedNfev4([
      { chave: CHAVE_A, estado: ESTADO_NFE.aguardandoResposta },
      { chave: CHAVE_B, estado: ESTADO_NFE.aguardandoResposta },
    ]);
    vi.mocked(findLatestEnviNFeMsgWithNRec).mockResolvedValue({ nRec: 'REC-1' } as never);
    vi.mocked(consultarLote).mockResolvedValue(consReciRet('656') as never);

    const r = await verificar();

    // A is a blocking terminal now (cStat 103), so the abort can no longer read
    // the persisted cStat — it reads the consumo-indevido flag.
    expect(r.results[0]).toMatchObject({ chave: CHAVE_A, estadoNovo: ESTADO_NFE.error });
    expect(r.results[1]).toMatchObject({
      chave: CHAVE_B,
      status: 'erro',
      error: 'verificação interrompida — cStat 656 (consumo indevido)',
    });
    expect(vi.mocked(consultarLote)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
    expect(vi.mocked(persistPatchUnlessFinal)).toHaveBeenCalledTimes(1);
  });

  it('near-miss: a 105 by receipt → no consSit, the doc stays in flight (unchanged)', async () => {
    comRecibo();
    vi.mocked(consultarLote).mockResolvedValue(consReciRet('105') as never);

    const r = await verificar();

    expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
    expect(r.results[0]).toMatchObject({
      status: 'sem-mudanca',
      estadoNovo: ESTADO_NFE.aguardandoResposta,
      cStat: '105',
    });
  });

  /**
   * An `error` doc the cap left terminal with the BLOCKING 103 (a paralisado
   * chain, "cStat 108: …" in xMotivo) and its receipt REC-1 in the audit log —
   * the doc "Verificar novamente" exists for.
   */
  function terminalDoCap(): void {
    seedMsgs({ 'msg-1': { targetsChnfe: [CHAVE_A] } });
    seedNfev4([
      {
        chave: CHAVE_A,
        estado: ESTADO_NFE.error,
        cStat: '103',
        xMotivo:
          'cStat 108: motivo 108 | sem resposta para a chave após 10 consultas — verificar manualmente',
        retries: 10,
      },
    ]);
    vi.mocked(findLatestEnviNFeMsgWithNRec).mockResolvedValue({ nRec: 'REC-1' } as never);
  }

  /** The extras of the (single) guarded write. */
  function extrasPersistidos(): { proximaConsultaEm?: number } | undefined {
    persistido();
    return vi.mocked(persistPatchUnlessFinal).mock.calls[0]![3] as
      | { proximaConsultaEm?: number }
      | undefined;
  }

  it.each(['107', '108', '109', '113', '114', ''])(
    "a capped terminal (error, BLOCKING 103) re-verified against a receipt that says nothing ('%s') → back IN FLIGHT on it — never error with that non-blocking cStat, never rejeitada",
    async (loteCStat) => {
      terminalDoCap();
      vi.mocked(consultarLote).mockResolvedValue(consReciRet(loteCStat) as never);

      const r = await verificar();

      expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
      const patch = persistido();
      // In flight WITH its receipt: the emit path skips it (no número reuse)
      // and the sweep consults it again.
      expect(patch.estado).toBe(ESTADO_NFE.aguardandoResposta);
      expect(patch.nRec).toBe('REC-1');
      expect(r.results[0]).toMatchObject({
        status: 'atualizada',
        estadoAnterior: ESTADO_NFE.error,
        estadoNovo: ESTADO_NFE.aguardandoResposta,
      });
    },
  );

  it("an in-flight doc + a receipt whose cStat is not TStat-shaped ('') → stays in flight, never a número-freeing rejeitada", async () => {
    comRecibo();
    vi.mocked(consultarLote).mockResolvedValue(consReciRet('') as never);

    const r = await verificar();

    expect(persistido().estado).toBe(ESTADO_NFE.aguardandoResposta);
    expect(r.results[0]).toMatchObject({ estadoNovo: ESTADO_NFE.aguardandoResposta });
  });

  it.each(['108', '109', '113', '114'])(
    'a paralisado receipt (%s) paces the doc like the reconcile: proximaConsultaEm ≥ now + RECONCILE_INDISPONIVEL_DELAY_MS',
    async (loteCStat) => {
      terminalDoCap();
      vi.mocked(consultarLote).mockResolvedValue(consReciRet(loteCStat) as never);
      const antes = Date.now() * 1000;

      await verificar();

      expect(extrasPersistidos()?.proximaConsultaEm).toBeGreaterThanOrEqual(
        antes + RECONCILE_INDISPONIVEL_DELAY_MS * 1000,
      );
    },
  );

  it.each(['105', '107', ''])(
    "near-miss: a receipt that says nothing but is not paralisado ('%s') keeps the default pacing — no extras",
    async (loteCStat) => {
      terminalDoCap();
      vi.mocked(consultarLote).mockResolvedValue(consReciRet(loteCStat) as never);

      await verificar();

      expect(persistido().estado).toBe(ESTADO_NFE.aguardandoResposta);
      expect(extrasPersistidos()).toBeUndefined();
    },
  );

  describe('a stored rejeitada — SEFAZ’s conclusive answer about the chave', () => {
    const XMOTIVO_778 = 'Rejeicao: Informado NCM inexistente';

    /**
     * Our protNFe in REC-1 rejected the chave (778): the número is free, and
     * the emit path keeps the fix-and-resend branch open for a rejeitada doc
     * (it skips only an in-flight doc with an nRec).
     */
    function rejeitadaPeloProtocolo(): void {
      seedMsgs({ 'msg-1': { targetsChnfe: [CHAVE_A] } });
      seedNfev4([
        { chave: CHAVE_A, estado: ESTADO_NFE.rejeitada, cStat: '778', xMotivo: XMOTIVO_778 },
      ]);
      vi.mocked(findLatestEnviNFeMsgWithNRec).mockResolvedValue({ nRec: 'REC-1' } as never);
    }

    it.each([
      ['says nothing', '107'],
      ['says nothing (paralisado)', '108'],
      ['says nothing (paralisado)', '109'],
      ['says nothing (SVC)', '113'],
      ['says nothing (SVC)', '114'],
      ['says nothing (not TStat-shaped)', ''],
      ['is terminal (consumo indevido)', '656'],
      ['is terminal (refused query)', '252'],
      ['is terminal (refused query)', '999'],
    ])(
      "a receipt that %s ('%s') leaves it as it is — never back in flight, never a blocking error",
      async (_caso, loteCStat) => {
        rejeitadaPeloProtocolo();
        vi.mocked(consultarLote).mockResolvedValue(consReciRet(loteCStat) as never);

        const r = await verificar();

        expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
        // Nothing was learned about the chave, so nothing is written.
        expect(vi.mocked(persistPatchUnlessFinal)).not.toHaveBeenCalled();
        expect(r.results[0]).toMatchObject({
          status: 'sem-mudanca',
          estadoAnterior: ESTADO_NFE.rejeitada,
          estadoNovo: ESTADO_NFE.rejeitada,
          cStat: '778',
          xMotivo: XMOTIVO_778,
        });
      },
    );

    it('a lote-level 656 still aborts the run, although nothing was written', async () => {
      seedMsgs({ 'msg-1': { targetsChnfe: [CHAVE_A, CHAVE_B] } });
      seedNfev4([
        { chave: CHAVE_A, estado: ESTADO_NFE.rejeitada, cStat: '778', xMotivo: XMOTIVO_778 },
        { chave: CHAVE_B, estado: ESTADO_NFE.aguardandoResposta },
      ]);
      vi.mocked(findLatestEnviNFeMsgWithNRec).mockResolvedValue({ nRec: 'REC-1' } as never);
      vi.mocked(consultarLote).mockResolvedValue(consReciRet('656') as never);

      const r = await verificar();

      expect(r.results[1]).toMatchObject({
        chave: CHAVE_B,
        status: 'erro',
        error: 'verificação interrompida — cStat 656 (consumo indevido)',
      });
      expect(vi.mocked(consultarLote)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(persistPatchUnlessFinal)).not.toHaveBeenCalled();
    });

    it('near-miss: our protNFe in the receipt IS about the chave — applied and written as before', async () => {
      rejeitadaPeloProtocolo();
      vi.mocked(consultarLote).mockResolvedValue(consReciRet('104', '778') as never);

      const r = await verificar();

      expect(persistido()).toMatchObject({ estado: ESTADO_NFE.rejeitada, cStat: '778' });
      expect(r.results[0]).toMatchObject({ estadoNovo: ESTADO_NFE.rejeitada, cStat: '778' });
    });

    // Where the "leave a rejeitada alone" fold STOPS: a 103/105 is not silent —
    // a lote holding the chave is still pending at SEFAZ, which may yet
    // authorize it — so the doc goes back in flight rather than leave its
    // número re-emittable (as before #1654).
    it.each([
      ['received', '103'],
      ['still processing', '105'],
    ])(
      "near-miss: a lote %s ('%s') maps in flight on its own, as before",
      async (_caso, loteCStat) => {
        rejeitadaPeloProtocolo();
        vi.mocked(consultarLote).mockResolvedValue(consReciRet(loteCStat) as never);

        await verificar();

        expect(persistido()).toMatchObject({
          estado: ESTADO_NFE.aguardandoResposta,
          cStat: loteCStat,
          nRec: 'REC-1',
        });
      },
    );

    /** An `error` doc with a NON-blocking cStat — e.g. the sweep's legacy consSit 656. */
    function errorNaoBloqueante(): void {
      seedMsgs({ 'msg-1': { targetsChnfe: [CHAVE_A] } });
      seedNfev4([
        { chave: CHAVE_A, estado: ESTADO_NFE.error, cStat: '656', xMotivo: 'Consumo indevido' },
      ]);
      vi.mocked(findLatestEnviNFeMsgWithNRec).mockResolvedValue({ nRec: 'REC-1' } as never);
    }

    it('near-miss: an error doc with a non-blocking cStat + a receipt that says nothing (108) → still back in flight', async () => {
      errorNaoBloqueante();
      vi.mocked(consultarLote).mockResolvedValue(consReciRet('108') as never);

      await verificar();

      expect(persistido()).toMatchObject({
        estado: ESTADO_NFE.aguardandoResposta,
        nRec: 'REC-1',
      });
    });

    it('near-miss: an error doc with a non-blocking cStat + a refused receipt query (252) → still the BLOCKING terminal', async () => {
      errorNaoBloqueante();
      vi.mocked(consultarLote).mockResolvedValue(consReciRet('252') as never);

      await verificar();

      const patch = persistido();
      expect(patch).toMatchObject({ estado: ESTADO_NFE.error, cStat: '103' });
      expect(isBloqueada(patch.cStat)).toBe(true);
    });
  });

  describe('our protNFe 204 carrying an [nRec:X] marker', () => {
    const MARCADOR = '351000000000999';

    function recibo204ComMarcador(): unknown {
      const ret = consReciRet('104', '204') as {
        protNFe: Array<{ infProt: { xMotivo: string } }>;
      };
      ret.protNFe[0]!.infProt.xMotivo = `Rejeicao: Duplicidade de NF-e [nRec:${MARCADOR}]`;
      return ret;
    }

    function consSitDeOutraChave(): unknown {
      const ret = consSitRet('100', { protCStat: '100' }) as {
        protNFe: { infProt: { chNFe: string } };
      };
      ret.protNFe.infProt.chNFe = CHAVE_B;
      return ret;
    }

    it.each<[string, () => unknown]>([
      ['consSit 217 (sem-resolucao)', () => consSitRet('217')],
      ['a consSit protNFe of ANOTHER chave', consSitDeOutraChave],
      ['consSit 108 (indisponivel, back in flight)', () => consSitRet('108')],
    ])(
      'the by-chave result (%s) keeps the stored receipt — never re-keyed onto X',
      async (_caso, retSit) => {
        comRecibo();
        vi.mocked(consultarLote).mockResolvedValue(recibo204ComMarcador() as never);
        vi.mocked(consultarSituacaoNFe).mockResolvedValue(retSit() as never);

        await verificar();

        expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledTimes(1);
        const patch = persistido();
        // nRec null → the persist leaves the stored receipt (REC-1) untouched.
        expect(patch.nRec).toBeNull();
        expect(patch.nRec).not.toBe(MARCADOR);
      },
    );

    it('the terminal still quotes what our protNFe said, behind the BLOCKING cStat 104', async () => {
      comRecibo();
      vi.mocked(consultarLote).mockResolvedValue(recibo204ComMarcador() as never);
      vi.mocked(consultarSituacaoNFe).mockResolvedValue(consSitRet('217') as never);

      await verificar();

      const patch = persistido();
      expect(patch).toMatchObject({ estado: ESTADO_NFE.error, cStat: '104' });
      expect(patch.xMotivo).toContain('cStat 204: Rejeicao: Duplicidade de NF-e');
    });
  });
});
