/**
 * Orchestrator tests for cartaCorrecaoService. vi.mock the library's CC-e
 * SEFAZ round-trip (`cartaCorrecaoNFe`) and back the Admin SDK with a small
 * in-memory Firestore fake, so the flow runs end-to-end without network. The
 * service uses only `collection().doc().get()`, `collection().where().get()`
 * and `collection().add()` — no transaction / collection-group / batch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@delfrance/integrations-nfe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delfrance/integrations-nfe')>();
  return {
    ...actual,
    cartaCorrecaoNFe: vi.fn(),
  };
});

import { cartaCorrecaoNFe, MAX_RECONCILE_ATTEMPTS } from '@delfrance/integrations-nfe';
import { cartaCorrecaoSchema, ESTADO_ENVI_NFE_MSG, ESTADO_NFE } from '@delfrance/schemas';

import {
  cartaCorrecaoService,
  reconcileCartaCorrecaoVinculo,
  NFeCartaCorrecaoError,
  NFeOrchestratorError,
  NFePedidoNotFoundError,
} from '../../../lib/nfe/orchestrator';
import type { NFeBaseRuntime, NFeRuntime } from '../../../lib/nfe/runtime';
import type {
  CceVinculoTaskInput,
  CceVinculoTaskPayload,
  TaskScheduler,
} from '../../../lib/nfe/tasks';

const CHAVE = '35260514200166000187550010000000071000000018';
const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
const XCORRECAO = 'Correcao do peso bruto informado no campo de transporte da nota';

function fakeRuntime(): NFeRuntime & NFeBaseRuntime {
  const rt: NFeRuntime = {
    cert: {
      privateKeyPem: '',
      certificatePem: '',
      certificateDerBase64: '',
      subjectCommonName: 'TEST:99999999000191',
      cnpj: '99999999000191',
      notAfter: new Date(Date.now() + 86_400_000),
      pfxBuffer: Buffer.from(''),
      password: '',
    },
    agent: {} as never,
    ambiente: 'homologacao',
    uf: 'SP',
    tpAmb: '2',
    endpoints: {
      NfeAutorizacao: 'https://example/sefaz/aut',
      NfeRetAutorizacao: 'https://example/sefaz/ret',
      NfeConsultaProtocolo: 'https://example/sefaz/cons',
      NfeStatusServico: 'https://example/sefaz/sta',
      NfeInutilizacao: 'https://example/sefaz/inu',
      RecepcaoEvento: 'https://example/sefaz/rec',
    },
    svc: (authorizer) => ({
      endpoints: {
        NfeAutorizacao: `https://example/${authorizer}/aut`,
        NfeRetAutorizacao: `https://example/${authorizer}/ret`,
        NfeConsultaProtocolo: `https://example/${authorizer}/cons`,
        NfeStatusServico: `https://example/${authorizer}/sta`,
        RecepcaoEvento: `https://example/${authorizer}/rec`,
      },
      agent: {} as never,
    }),
    an: () => ({
      endpoints: { RecepcaoEvento: 'https://example/an/rec' },
      agent: {} as never,
    }),
    diagnostics: {
      subjectCommonName: 'TEST',
      notAfter: new Date(Date.now() + 86_400_000).toISOString(),
      chainSource: '/tmp/fake.pem',
    },
  };
  // Base runtime for the entry points; the fallback path (no stored cert)
  // resolves to this same fake via `envRuntime`.
  return { ...rt, envRuntime: () => rt };
}

/** Compact in-memory Firestore — only what cartaCorrecaoService touches. */
function fakeFirestore(seed: Record<string, Record<string, unknown> | null>) {
  const docs: Record<string, Record<string, unknown> | null> = { ...seed };
  const writes: { path: string; data: Record<string, unknown> }[] = [];
  let auto = 0;

  function ref(path: string) {
    return {
      path,
      id: path.split('/').pop()!,
      async get() {
        const data = docs[path];
        return { exists: data != null, id: path.split('/').pop()!, data: () => data };
      },
      async set(data: Record<string, unknown>) {
        docs[path] = data;
        writes.push({ path, data });
      },
    };
  }

  function query(path: string, wheres: { field: string; op: string; value: unknown }[]) {
    return {
      where(field: string, op: string, value: unknown) {
        return query(path, [...wheres, { field, op, value }]);
      },
      async get() {
        const prefix = `${path}/`;
        let items = Object.entries(docs)
          .filter(
            ([k, v]) => k.startsWith(prefix) && v != null && !k.slice(prefix.length).includes('/'),
          )
          .map(([k, v]) => ({ id: k.slice(prefix.length), data: v as Record<string, unknown> }));
        for (const w of wheres)
          items = items.filter((it) =>
            w.op === 'in'
              ? Array.isArray(w.value) && (w.value as unknown[]).includes(it.data[w.field])
              : it.data[w.field] === w.value,
          );
        return {
          size: items.length,
          docs: items.map((it) => ({ id: it.id, data: () => it.data })),
        };
      },
    };
  }

  function collection(path: string) {
    return {
      doc: (id: string) => ref(`${path}/${id}`),
      where(field: string, op: string, value: unknown) {
        return query(path, []).where(field, op, value);
      },
      get() {
        return query(path, []).get();
      },
      async add(data: Record<string, unknown>) {
        // Mirror the real defineAdminCollection.add → parseForWrite: reject a
        // schema-invalid payload here so the offline tests exercise the same
        // validation the production write does.
        cartaCorrecaoSchema.parse(data);
        auto += 1;
        const r = ref(`${path}/auto-${auto}`);
        await r.set(data);
        return r;
      },
    };
  }

  return {
    fs: { collection: (p: string) => collection(p), doc: (p: string) => ref(p) } as never,
    docs,
    writes,
  };
}

/** An aprovada nfev4 doc (the correctable state). */
function aprovadaNfev4(): Record<string, unknown> {
  return {
    estado: ESTADO_NFE.aprovada,
    chave: CHAVE,
    numeracao: 1,
    serie: 1,
    cStat: '100',
    xMotivo: 'Autorizado o uso da NF-e',
    tpEmis: 1,
    // Denormalized on every emitted doc (buildPlaceholderNfeDoc / buildNfeDocWrite);
    // cartaCorrecaoService reads it to resolve the filial's signing cert.
    filialId: 'F-1',
    ultima_modificacao: '2026-05-29T10:00:00.000Z',
  };
}

/** Build a CartaCorrecaoResult for a given per-evento cStat + nSeqEvento. */
function cceResult(cStat: string, nSeq: number) {
  return {
    ret: {
      idLote: '1',
      tpAmb: '2' as const,
      verAplic: 'SP_EVENTOS',
      cOrgao: '35' as const,
      cStat: '128',
      xMotivo: 'Lote de Evento Processado',
      versao: '1.00',
      retEvento: [
        {
          versao: '1.00',
          infEvento: {
            tpAmb: '2' as const,
            verAplic: 'SP_EVENTOS',
            cOrgao: '35' as const,
            cStat,
            xMotivo:
              cStat === '135'
                ? 'Evento registrado e vinculado a NF-e'
                : 'Rejeicao: Evento registrado mas nao vinculado a NF-e',
            chNFe: CHAVE,
            tpEvento: '110110',
            nSeqEvento: String(nSeq),
            dhRegEvento: '2026-05-29T10:30:00-03:00',
            nProt: '135200000077777',
          },
        },
      ],
    },
    signedEventoXml: `<evento xmlns="${NFE_NS}" versao="1.00"><infEvento Id="ID110110${CHAVE}${String(nSeq).padStart(2, '0')}">…</infEvento><Signature>…</Signature></evento>`,
    procEventoNFe: '<procEventoNFe>…</procEventoNFe>',
    rawResponse: '<retEnvEvento>…</retEnvEvento>',
  };
}

/** Records the cStat-136 re-check tasks the service would enqueue (#81). */
function recordingScheduler(): { scheduler: TaskScheduler; cce: CceVinculoTaskInput[] } {
  const cce: CceVinculoTaskInput[] = [];
  return {
    scheduler: {
      async enqueueConsulta() {
        /* CC-e never enqueues a lote consult */
      },
      async enqueueCceVinculo(input) {
        cce.push(input);
      },
    },
    cce,
  };
}

beforeEach(() => {
  // Fixtures have no per-filial stored cert — emit the CC-e with the env cert
  // via the fallback (per-filial resolution covered in filial-cert.test.ts).
  process.env.NFE_CERT_ENV_FALLBACK = '1';
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.NFE_CERT_ENV_FALLBACK;
});

describe('cartaCorrecaoService', () => {
  it('cStat 135 → registra: persists a concluido CC-e record (nSeqEvento 1) + returns accepted', async () => {
    const { fs, writes } = fakeFirestore({ 'pedidos/PED-1/nfev4/s1': aprovadaNfev4() });
    vi.mocked(cartaCorrecaoNFe).mockResolvedValue(cceResult('135', 1) as never);

    const result = await cartaCorrecaoService(fs, fakeRuntime(), 'PED-1', 's1', XCORRECAO);

    expect(result.accepted).toBe(true);
    expect(result.cStat).toBe('135');
    expect(result.nSeqEvento).toBe(1);
    expect(result.nProt).toBe('135200000077777');

    const recs = writes.filter((w) => w.path.startsWith('pedidos/PED-1/nfev4/s1/cartacorrecao/'));
    expect(recs).toHaveLength(1);
    expect(recs[0]?.data.estado).toBe(ESTADO_ENVI_NFE_MSG.concluido);
    expect(recs[0]?.data.nSeqEvento).toBe(1);
    expect(recs[0]?.data.nProt).toBe('135200000077777');
    expect(recs[0]?.data.xCorrecao).toBe(XCORRECAO);
  });

  it('nSeqEvento increments past already-sequenced CC-e (count of concluido + 1)', async () => {
    const { fs, writes } = fakeFirestore({
      'pedidos/PED-1/nfev4/s1': aprovadaNfev4(),
      // One prior, accepted CC-e → next sequence must be 2.
      'pedidos/PED-1/nfev4/s1/cartacorrecao/prev': {
        xCorrecao: XCORRECAO,
        nSeqEvento: 1,
        estado: ESTADO_ENVI_NFE_MSG.concluido,
      },
    });
    vi.mocked(cartaCorrecaoNFe).mockResolvedValue(cceResult('135', 2) as never);

    const result = await cartaCorrecaoService(fs, fakeRuntime(), 'PED-1', 's1', XCORRECAO);

    expect(result.nSeqEvento).toBe(2);
    expect(vi.mocked(cartaCorrecaoNFe).mock.calls[0]![1].nSeqEvento).toBe(2);
    const recs = writes.filter((w) => w.path.startsWith('pedidos/PED-1/nfev4/s1/cartacorrecao/'));
    expect(recs).toHaveLength(1);
    expect(recs[0]?.data.nSeqEvento).toBe(2);
  });

  it('nSeqEvento also counts a still-pending (aguardandoVinculo) CC-e — a 136 burns its sequence (#81)', async () => {
    const { fs } = fakeFirestore({
      'pedidos/PED-1/nfev4/s1': aprovadaNfev4(),
      // A prior CC-e is registered-but-not-yet-linked: it already holds seq 1 at
      // SEFAZ, so a FRESH CC-e must take seq 2 (the pending one is re-sent with
      // its own unchanged sequence by the re-check task).
      'pedidos/PED-1/nfev4/s1/cartacorrecao/pend': {
        xCorrecao: XCORRECAO,
        nSeqEvento: 1,
        estado: ESTADO_ENVI_NFE_MSG.aguardandoVinculo,
      },
    });
    vi.mocked(cartaCorrecaoNFe).mockResolvedValue(cceResult('135', 2) as never);

    const result = await cartaCorrecaoService(fs, fakeRuntime(), 'PED-1', 's1', XCORRECAO);

    expect(result.nSeqEvento).toBe(2);
    expect(vi.mocked(cartaCorrecaoNFe).mock.calls[0]![1].nSeqEvento).toBe(2);
  });

  it('cStat 136 (registrado mas NÃO vinculado) → pending: persists aguardandoVinculo + enqueues a re-check, no throw (#81)', async () => {
    const { fs, writes } = fakeFirestore({ 'pedidos/PED-1/nfev4/s1': aprovadaNfev4() });
    vi.mocked(cartaCorrecaoNFe).mockResolvedValue(cceResult('136', 1) as never);
    const { scheduler, cce } = recordingScheduler();

    const result = await cartaCorrecaoService(
      fs,
      fakeRuntime(),
      'PED-1',
      's1',
      XCORRECAO,
      scheduler,
    );

    // 136 is non-terminal: not accepted, but NOT a rejection either — pending.
    expect(result.accepted).toBe(false);
    expect(result.pending).toBe(true);
    expect(result.cStat).toBe('136');
    expect(result.nSeqEvento).toBe(1);

    // The record is persisted as aguardandoVinculo with a re-check gate.
    const recs = writes.filter((w) => w.path.startsWith('pedidos/PED-1/nfev4/s1/cartacorrecao/'));
    expect(recs).toHaveLength(1);
    expect(recs[0]?.data.estado).toBe(ESTADO_ENVI_NFE_MSG.aguardandoVinculo);
    expect(recs[0]?.data.proximaConsultaEm).toBeTypeOf('number');
    expect(recs[0]?.data.retries).toBe(0);
    expect(recs[0]?.data.error).toBeNull();

    // A re-check task was scheduled with the SAME nSeqEvento + the new record id.
    expect(cce).toHaveLength(1);
    expect(cce[0]).toMatchObject({
      pedidoId: 'PED-1',
      nfeId: 's1',
      cceId: result.cceId,
      nSeqEvento: 1,
      attempt: 0,
    });
  });

  it('estado not aprovada (rejeitada) → throws NFeCartaCorrecaoError, no event sent', async () => {
    const { fs } = fakeFirestore({
      'pedidos/PED-1/nfev4/s1': { ...aprovadaNfev4(), estado: ESTADO_NFE.rejeitada },
    });
    await expect(
      cartaCorrecaoService(fs, fakeRuntime(), 'PED-1', 's1', XCORRECAO),
    ).rejects.toBeInstanceOf(NFeCartaCorrecaoError);
    expect(cartaCorrecaoNFe).not.toHaveBeenCalled();
  });

  it("EPEC-approved (estado 'p') → rejected with the transmit-first message, no event sent (#86)", async () => {
    // The NF-e exists only as an EPEC summary at the AN — events can't attach
    // until the full NF-e is authorized at the home SEFAZ.
    const { fs } = fakeFirestore({
      'pedidos/PED-1/nfev4/s4': { ...aprovadaNfev4(), tpEmis: 4, estado: ESTADO_NFE.epecAprovado },
    });
    await expect(cartaCorrecaoService(fs, fakeRuntime(), 'PED-1', 's4', XCORRECAO)).rejects.toThrow(
      /transmita a NF-e completa/,
    );
    expect(cartaCorrecaoNFe).not.toHaveBeenCalled();
  });

  it('SVC contingency NF-e (tpEmis=6) → CC-e sent to the HOME SEFAZ RecepcaoEvento', async () => {
    // The SVC does not serve CC-e, but SVC-authorized documents are shared
    // with the normal environment, which registers the event (MOC 7.0 Anexo
    // III §2.1.3.4-d) — so the CC-e must go out, routed to the home SEFAZ.
    const { fs, writes } = fakeFirestore({
      'pedidos/PED-1/nfev4/s6': { ...aprovadaNfev4(), tpEmis: 6 },
    });
    vi.mocked(cartaCorrecaoNFe).mockResolvedValue(cceResult('135', 1) as never);

    const result = await cartaCorrecaoService(fs, fakeRuntime(), 'PED-1', 's6', XCORRECAO);

    expect(result.accepted).toBe(true);
    expect(vi.mocked(cartaCorrecaoNFe)).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example/sefaz/rec' }),
      expect.anything(),
    );
    const rec = writes.find((w) => w.path.startsWith('pedidos/PED-1/nfev4/s6/cartacorrecao/'));
    expect(rec?.data.estado).toBe(ESTADO_ENVI_NFE_MSG.concluido);
  });

  it('throws NFePedidoNotFoundError (→ 404) when the nfev4 doc id does not exist', async () => {
    const { fs } = fakeFirestore({ 'pedidos/PED-1/nfev4/s1': null });
    await expect(
      cartaCorrecaoService(fs, fakeRuntime(), 'PED-1', 's1', XCORRECAO),
    ).rejects.toBeInstanceOf(NFePedidoNotFoundError);
    expect(cartaCorrecaoNFe).not.toHaveBeenCalled();
  });

  it('throws NFeOrchestratorError when the nfev4 doc has no chave', async () => {
    const { fs } = fakeFirestore({
      'pedidos/PED-1/nfev4/s1': { ...aprovadaNfev4(), chave: null },
    });
    await expect(
      cartaCorrecaoService(fs, fakeRuntime(), 'PED-1', 's1', XCORRECAO),
    ).rejects.toBeInstanceOf(NFeOrchestratorError);
    expect(cartaCorrecaoNFe).not.toHaveBeenCalled();
  });
});

describe('reconcileCartaCorrecaoVinculo (#81 CC-e 136 re-check)', () => {
  const CCE_PATH = 'pedidos/PED-1/nfev4/s1/cartacorrecao/cce-1';

  /** A persisted, still-pending (aguardandoVinculo) CC-e record. */
  function pendingCce(nSeq = 1): Record<string, unknown> {
    return {
      xCorrecao: XCORRECAO,
      nSeqEvento: nSeq,
      xml_enviado: '<evento/>',
      xml_retorno: '<retEnvEvento/>',
      cStat: '136',
      xMotivo: 'Evento registrado mas nao vinculado a NF-e',
      nProt: null,
      error: null,
      tpEmis: 1,
      proximaConsultaEm: 1000,
      retries: 0,
      estado: ESTADO_ENVI_NFE_MSG.aguardandoVinculo,
    };
  }

  function input(attempt = 0, nSeq = 1): CceVinculoTaskPayload {
    return {
      kind: 'cce-vinculo',
      pedidoId: 'PED-1',
      nfeId: 's1',
      cceId: 'cce-1',
      nSeqEvento: nSeq,
      attempt,
    };
  }

  const lastCceWrite = (writes: { path: string; data: Record<string, unknown> }[]) =>
    writes.filter((w) => w.path === CCE_PATH).at(-1)?.data;

  it('135 → resolves the record to concluido (re-send uses the record’s own nSeqEvento)', async () => {
    const { fs, writes } = fakeFirestore({
      'pedidos/PED-1/nfev4/s1': aprovadaNfev4(),
      [CCE_PATH]: pendingCce(2),
    });
    vi.mocked(cartaCorrecaoNFe).mockResolvedValue(cceResult('135', 2) as never);

    const res = await reconcileCartaCorrecaoVinculo(fs, fakeRuntime(), input(0, 2));

    expect(res.disposition).toBe('resolved');
    expect(res.stillPending).toBe(false);
    // Re-sent with the record’s stored sequence, NOT a recomputed one.
    expect(vi.mocked(cartaCorrecaoNFe).mock.calls[0]![1].nSeqEvento).toBe(2);
    const w = lastCceWrite(writes);
    expect(w?.estado).toBe(ESTADO_ENVI_NFE_MSG.concluido);
    expect(w?.proximaConsultaEm).toBeNull();
    expect(w?.retries).toBeNull();
  });

  it('573 (duplicidade — já vinculado) → resolves to concluido', async () => {
    const { fs, writes } = fakeFirestore({
      'pedidos/PED-1/nfev4/s1': aprovadaNfev4(),
      [CCE_PATH]: pendingCce(),
    });
    vi.mocked(cartaCorrecaoNFe).mockResolvedValue(cceResult('573', 1) as never);

    const res = await reconcileCartaCorrecaoVinculo(fs, fakeRuntime(), input());

    expect(res.disposition).toBe('resolved');
    expect(lastCceWrite(writes)?.estado).toBe(ESTADO_ENVI_NFE_MSG.concluido);
  });

  it('still 136 under the cap → stays aguardandoVinculo, bumps retries + proximaConsultaEm', async () => {
    const { fs, writes } = fakeFirestore({
      'pedidos/PED-1/nfev4/s1': aprovadaNfev4(),
      [CCE_PATH]: pendingCce(),
    });
    vi.mocked(cartaCorrecaoNFe).mockResolvedValue(cceResult('136', 1) as never);

    const res = await reconcileCartaCorrecaoVinculo(fs, fakeRuntime(), input(0));

    expect(res.disposition).toBe('pending');
    expect(res.stillPending).toBe(true);
    expect(res.nextAttempt).toBe(1);
    const w = lastCceWrite(writes);
    // estado is NOT in the patch — the record keeps aguardandoVinculo.
    expect(w?.estado).toBeUndefined();
    expect(w?.retries).toBe(1);
    expect(w?.proximaConsultaEm).toBeTypeOf('number');
    // The latest re-send response is persisted (diagnostics), not just the first 136.
    expect(w?.xml_retorno).toContain('retEnvEvento');
  });

  it('136 at the attempt cap → terminal error, no further re-check', async () => {
    const { fs, writes } = fakeFirestore({
      'pedidos/PED-1/nfev4/s1': aprovadaNfev4(),
      [CCE_PATH]: pendingCce(),
    });
    vi.mocked(cartaCorrecaoNFe).mockResolvedValue(cceResult('136', 1) as never);

    // attempt N-1 → nextAttempt N === cap → close as error.
    const res = await reconcileCartaCorrecaoVinculo(
      fs,
      fakeRuntime(),
      input(MAX_RECONCILE_ATTEMPTS - 1),
    );

    expect(res.disposition).toBe('capped');
    expect(res.stillPending).toBe(false);
    const w = lastCceWrite(writes);
    expect(w?.estado).toBe(ESTADO_ENVI_NFE_MSG.error);
    expect(w?.proximaConsultaEm).toBeNull();
    expect(w?.retries).toBeNull();
    // Terminal closure persists the final SEFAZ response, like the other paths.
    expect(w?.xml_retorno).toContain('retEnvEvento');
  });

  it('any other cStat → terminal error (rejected)', async () => {
    const { fs, writes } = fakeFirestore({
      'pedidos/PED-1/nfev4/s1': aprovadaNfev4(),
      [CCE_PATH]: pendingCce(),
    });
    vi.mocked(cartaCorrecaoNFe).mockResolvedValue(cceResult('240', 1) as never);

    const res = await reconcileCartaCorrecaoVinculo(fs, fakeRuntime(), input());

    expect(res.disposition).toBe('rejected');
    expect(lastCceWrite(writes)?.estado).toBe(ESTADO_ENVI_NFE_MSG.error);
  });

  it('record already terminal → idempotent no-op (no re-send, no write)', async () => {
    const { fs, writes } = fakeFirestore({
      'pedidos/PED-1/nfev4/s1': aprovadaNfev4(),
      [CCE_PATH]: { ...pendingCce(), estado: ESTADO_ENVI_NFE_MSG.concluido },
    });

    const res = await reconcileCartaCorrecaoVinculo(fs, fakeRuntime(), input());

    expect(res.disposition).toBe('already-resolved');
    expect(res.stillPending).toBe(false);
    expect(cartaCorrecaoNFe).not.toHaveBeenCalled();
    expect(writes.filter((w) => w.path === CCE_PATH)).toHaveLength(0);
  });

  it('NF-e no longer aprovada (cancelada) → closes the record as error, no re-send', async () => {
    const { fs, writes } = fakeFirestore({
      'pedidos/PED-1/nfev4/s1': { ...aprovadaNfev4(), estado: ESTADO_NFE.cancelada },
      [CCE_PATH]: pendingCce(),
    });

    const res = await reconcileCartaCorrecaoVinculo(fs, fakeRuntime(), input());

    expect(res.disposition).toBe('gone');
    expect(cartaCorrecaoNFe).not.toHaveBeenCalled();
    expect(lastCceWrite(writes)?.estado).toBe(ESTADO_ENVI_NFE_MSG.error);
  });

  it('cce record gone → no-op gone, no re-send', async () => {
    const { fs, writes } = fakeFirestore({
      'pedidos/PED-1/nfev4/s1': aprovadaNfev4(),
      [CCE_PATH]: null,
    });

    const res = await reconcileCartaCorrecaoVinculo(fs, fakeRuntime(), input());

    expect(res.disposition).toBe('gone');
    expect(cartaCorrecaoNFe).not.toHaveBeenCalled();
    expect(writes.filter((w) => w.path === CCE_PATH)).toHaveLength(0);
  });
});
