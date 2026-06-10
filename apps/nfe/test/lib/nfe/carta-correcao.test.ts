/**
 * Orchestrator tests for cartaCorrecaoService. vi.mock the library's CC-e
 * SEFAZ round-trip (`cartaCorrecaoNFe`) and back the Admin SDK with a small
 * in-memory Firestore fake, so the flow runs end-to-end without network. The
 * service uses only `collection().doc().get()`, `collection().where().get()`
 * and `collection().add()` — no transaction / collection-group / batch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@delfrance/integrations-nfe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delfrance/integrations-nfe')>();
  return {
    ...actual,
    cartaCorrecaoNFe: vi.fn(),
  };
});

import { cartaCorrecaoNFe } from '@delfrance/integrations-nfe';
import { cartaCorrecaoSchema, ESTADO_ENVI_NFE_MSG, ESTADO_NFE } from '@delfrance/schemas';

import {
  cartaCorrecaoService,
  NFeCartaCorrecaoError,
  NFeOrchestratorError,
  NFePedidoNotFoundError,
} from '../../../lib/nfe/orchestrator';
import type { NFeRuntime } from '../../../lib/nfe/runtime';

const CHAVE = '35260514200166000187550010000000071000000018';
const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
const XCORRECAO = 'Correcao do peso bruto informado no campo de transporte da nota';

function fakeRuntime(): NFeRuntime {
  return {
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
    diagnostics: {
      subjectCommonName: 'TEST',
      notAfter: new Date(Date.now() + 86_400_000).toISOString(),
      chainSource: '/tmp/fake.pem',
    },
  };
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

  function query(path: string, wheres: { field: string; value: unknown }[]) {
    return {
      where(field: string, _op: string, value: unknown) {
        return query(path, [...wheres, { field, value }]);
      },
      async get() {
        const prefix = `${path}/`;
        let items = Object.entries(docs)
          .filter(
            ([k, v]) => k.startsWith(prefix) && v != null && !k.slice(prefix.length).includes('/'),
          )
          .map(([k, v]) => ({ id: k.slice(prefix.length), data: v as Record<string, unknown> }));
        for (const w of wheres) items = items.filter((it) => it.data[w.field] === w.value);
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

afterEach(() => {
  vi.clearAllMocks();
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

  it('nSeqEvento increments past already-accepted CC-e (count of concluido + 1)', async () => {
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

  it('cStat 136 (registrado mas NÃO vinculado) → throws + persists an error record', async () => {
    const { fs, writes } = fakeFirestore({ 'pedidos/PED-1/nfev4/s1': aprovadaNfev4() });
    vi.mocked(cartaCorrecaoNFe).mockResolvedValue(cceResult('136', 1) as never);

    const err = await cartaCorrecaoService(fs, fakeRuntime(), 'PED-1', 's1', XCORRECAO).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NFeCartaCorrecaoError);
    expect((err as NFeCartaCorrecaoError).cStat).toBe('136');

    // The attempt is still recorded — as an error.
    const recs = writes.filter((w) => w.path.startsWith('pedidos/PED-1/nfev4/s1/cartacorrecao/'));
    expect(recs).toHaveLength(1);
    expect(recs[0]?.data.estado).toBe(ESTADO_ENVI_NFE_MSG.error);
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

  it('SVC contingency NF-e (tpEmis=6) → throws NFeCartaCorrecaoError, no event sent', async () => {
    // SVC offers no CC-e (MOC Anexo III) — the guard must fire before any SOAP.
    const { fs } = fakeFirestore({
      'pedidos/PED-1/nfev4/s6': { ...aprovadaNfev4(), tpEmis: 6 },
    });
    const err = await cartaCorrecaoService(fs, fakeRuntime(), 'PED-1', 's6', XCORRECAO).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NFeCartaCorrecaoError);
    expect((err as NFeCartaCorrecaoError).message).toContain('SVC');
    expect(cartaCorrecaoNFe).not.toHaveBeenCalled();
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
