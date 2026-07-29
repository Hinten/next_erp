import { describe, expect, it, vi, type Mock } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  MercadoLivreReauthRequiredError,
  type MercadoLivreApi,
} from '@delfrance/integrations-mercado-livre';
import {
  ESTADO_FRETE,
  ESTADO_NFE,
  ESTADO_PEDIDO,
  INTEGRACAO_FRETE,
  ML_ENVIO_ESTADO,
} from '@delfrance/schemas';

import { MercadoLivreContaNotConfiguredError } from './mercadoLivre';
import {
  MercadoLivreContaInativaError,
  NFE_UPLOAD_MAX_ATTEMPTS,
  NFE_UPLOAD_PENDENTE_TTL_MS,
  NfeUploadTransientError,
  classifyInvoiceError,
  decideNfeUploadDispatch,
  enqueueNfeUpload,
  extractTpAmb,
  nfeUploadTaskSchema,
  processNfeUploadTask,
  type MlNfeUploadScheduler,
  type NfeUploadDeps,
  type NfeUploadTaskPayload,
} from './nfeUpload';

/* ------------------------------ fake Firestore ---------------------------- */
// Own copy (repo convention: per-file FakeDb copies, not shared fakes) —
// cloned from orderShipmentImport.test.ts and SCOPED to what nfeUpload.ts
// touches: `pedidos` doc get/update (incl. inside the stampFreteErro
// transaction) and the `pedidos/{pedidoId}/nfev4` subcollection's get +
// set-merge (the admin handle's `merge()` transport). The reads-before-writes
// guard inside `runTransaction` mirrors orderPedidoTx.test.ts's FakeDb.
// `set` implements TOP-LEVEL shallow merge — sufficient here because mlEnvio
// markers are always written as FULL objects (deep-vs-shallow map merge is
// indistinguishable for them).

type DocData = Record<string, unknown>;
type OpKind = 'get' | 'update' | 'set';

interface FakeSnap {
  exists: boolean;
  id: string;
  data: () => DocData | undefined;
}

interface FakeDocRef {
  id: string;
  get: () => Promise<FakeSnap>;
  update: (patch: DocData) => Promise<void>;
  set: (data: DocData, opts?: { merge?: boolean }) => Promise<void>;
}

interface FakeTransaction {
  get: (ref: FakeDocRef) => Promise<FakeSnap>;
  update: (ref: FakeDocRef, patch: DocData) => Promise<void>;
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly opLog: Array<{ op: OpKind; path: string }> = [];
  private readonly patches = new Map<string, DocData>();

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }
  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }
  docs(path: string): Map<string, DocData> {
    return this.col(path);
  }
  /** The last `update()`/`set()` payload written at `path/id` — asserts the write's exact shape. */
  lastPatch(path: string, id: string): DocData | undefined {
    return this.patches.get(`${path}/${id}`);
  }

  private makeDocRef(path: string, id: string): FakeDocRef {
    const self = this;
    const col = this.col(path);
    return {
      id,
      get: async () => {
        self.opLog.push({ op: 'get', path: `${path}/${id}` });
        return { exists: col.has(id), id, data: () => col.get(id) };
      },
      update: async (patch: DocData) => {
        self.opLog.push({ op: 'update', path: `${path}/${id}` });
        self.patches.set(`${path}/${id}`, patch);
        col.set(id, { ...(col.get(id) ?? {}), ...patch });
      },
      set: async (data: DocData, opts?: { merge?: boolean }) => {
        self.opLog.push({ op: 'set', path: `${path}/${id}` });
        self.patches.set(`${path}/${id}`, data);
        col.set(id, opts?.merge ? { ...(col.get(id) ?? {}), ...data } : { ...data });
      },
    };
  }

  collection(path: string) {
    const self = this;
    return {
      doc: (id: string) => self.makeDocRef(path, id),
    };
  }

  /** Raw ref accessor for tests that wrap/override a single doc ref. */
  ref(path: string, id: string): FakeDocRef {
    return this.makeDocRef(path, id);
  }

  // Admin SDK invariant: every read in a transaction must happen before its
  // first write. `wroteAlready` is scoped to THIS call, not the instance.
  async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    let wroteAlready = false;
    const tx: FakeTransaction = {
      get: (ref) => {
        if (wroteAlready) {
          throw new Error('read after write in transaction (Admin SDK invariant)');
        }
        return ref.get();
      },
      update: async (ref, patch) => {
        await ref.update(patch);
        wroteAlready = true;
      },
    };
    return fn(tx);
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

/* --------------------------------- fixtures ------------------------------- */

const PEDIDO_ID = 'pedido-1';
const NFE_ID = 's1';
const NFE_COL = `pedidos/${PEDIDO_ID}/nfev4`;
const SHIPMENT_ID = '44440001';
const NOW_MS = Date.parse('2026-07-01T12:00:00.000Z');
const NOW_US = NOW_MS * 1000;
const PAYLOAD: NfeUploadTaskPayload = { pedidoId: PEDIDO_ID, nfeId: NFE_ID };

// infNFe/ide precedes protNFe, exactly like a real nfeProc — the '9'
// protocol echo pins that the FIRST tpAmb wins.
const XML_PROD =
  '<nfeProc><NFe><infNFe><ide><cUF>35</cUF><tpAmb>1</tpAmb></ide></infNFe></NFe>' +
  '<protNFe><infProt><tpAmb>1</tpAmb></infProt></protNFe></nfeProc>';
const XML_HOM =
  '<nfeProc><NFe><infNFe><ide><tpAmb>2</tpAmb></ide></infNFe></NFe>' +
  '<protNFe><infProt><tpAmb>2</tpAmb></infProt></protNFe></nfeProc>';
const XML_SEM_TPAMB = '<nfeProc><NFe><infNFe><ide><cUF>35</cUF></ide></infNFe></NFe></nfeProc>';

function nfeDoc(over: DocData = {}): DocData {
  return {
    estado: ESTADO_NFE.aprovada,
    xml_nfe_proc: XML_PROD,
    ultima_modificacao: Date.parse('2026-06-30T00:00:00.000Z'),
    mlEnvio: null,
    ...over,
  };
}

function seedNfe(db: FakeDb, over: DocData = {}): void {
  db.seed(NFE_COL, NFE_ID, nfeDoc(over));
}

function freteMl(over: DocData = {}): DocData {
  return {
    estado: ESTADO_FRETE.aguardandoNFe,
    externalId: SHIPMENT_ID,
    externalOptionIntegracao: INTEGRACAO_FRETE.mercadoLivre,
    printLabelId: 'label-1',
    ultimaModificacao: Date.parse('2026-06-01T00:00:00.000Z') * 1000,
    ...over,
  };
}

function seedPedido(db: FakeDb, over: DocData = {}): void {
  db.seed('pedidos', PEDIDO_ID, {
    estado: ESTADO_PEDIDO.pago,
    integracaoPedidoOuterRef: 'documents/integracao/conta-A',
    freteInicial: freteMl(),
    ...over,
  });
}

function makeApi(
  over: Partial<Record<'getShipment' | 'sendShipmentInvoiceData', unknown>> = {},
): MercadoLivreApi {
  return {
    getShipment: vi.fn(async () => ({
      id: Number(SHIPMENT_ID),
      status: 'ready_to_ship',
      substatus: 'invoice_pending',
    })),
    sendShipmentInvoiceData: vi.fn(async () => ({})),
    ...over,
  } as unknown as MercadoLivreApi;
}

function makeDeps(
  db: FakeDb,
  api: MercadoLivreApi,
  over: Partial<NfeUploadDeps> = {},
): NfeUploadDeps {
  return { db: asDb(db), nowMs: NOW_MS, resolveApi: vi.fn(async () => api), ...over };
}

function marker(db: FakeDb): unknown {
  return db.docs(NFE_COL).get(NFE_ID)?.mlEnvio;
}

/** Every non-read op that hit the pedido doc — the "NO pedido write" probe. */
function pedidoWrites(db: FakeDb): Array<{ op: OpKind; path: string }> {
  return db.opLog.filter((e) => e.path === `pedidos/${PEDIDO_ID}` && e.op !== 'get');
}

// The mock is TYPED at its creation site so an async `mockImplementation`
// matches the declared Promise-returning signature (otherwise
// `@typescript-eslint/no-misused-promises` flags it).
function makeScheduler(): MlNfeUploadScheduler & {
  enqueue: Mock<(payload: NfeUploadTaskPayload) => Promise<void>>;
} {
  return { enqueue: vi.fn<(payload: NfeUploadTaskPayload) => Promise<void>>(async () => {}) };
}

const httpErr = (status: number, body: unknown = null): MercadoLivreHttpError =>
  new MercadoLivreHttpError(`ML ${status}`, status, body);

const fullMarker = (over: DocData = {}): DocData => ({
  estado: ML_ENVIO_ESTADO.pendente,
  tentativas: 0,
  shipmentId: null,
  motivo: null,
  ultimoErro: null,
  ultimoErroCodigo: null,
  atualizadoEm: NOW_MS,
  ...over,
});

/* ------------------------------- extractTpAmb ------------------------------ */

describe('extractTpAmb', () => {
  it('reads the produção flag, tolerating whitespace around the digit', () => {
    expect(extractTpAmb('<ide><tpAmb>\n  1  </tpAmb></ide>')).toBe('1');
    expect(extractTpAmb(XML_HOM)).toBe('2');
  });

  it('takes the FIRST tpAmb (infNFe/ide), not the protNFe echo', () => {
    const mixed =
      '<nfeProc><NFe><infNFe><ide><tpAmb>1</tpAmb></ide></infNFe></NFe>' +
      '<protNFe><infProt><tpAmb>2</tpAmb></infProt></protNFe></nfeProc>';
    expect(extractTpAmb(mixed)).toBe('1');
  });

  it('returns null when no tpAmb is present', () => {
    expect(extractTpAmb(XML_SEM_TPAMB)).toBeNull();
    expect(extractTpAmb('<tpAmb>3</tpAmb>')).toBeNull();
  });
});

/* --------------------------- decideNfeUploadDispatch ----------------------- */

describe('decideNfeUploadDispatch', () => {
  it('skips a deleted doc', () => {
    expect(decideNfeUploadDispatch(nfeDoc(), undefined, NOW_MS)).toEqual({
      action: 'skip',
      reason: 'apagada',
    });
  });

  it('skips a non-aprovada estado', () => {
    expect(
      decideNfeUploadDispatch(undefined, nfeDoc({ estado: ESTADO_NFE.gerado }), NOW_MS),
    ).toEqual({ action: 'skip', reason: 'nao-aprovada' });
  });

  it('skips when xml_nfe_proc is null', () => {
    expect(decideNfeUploadDispatch(undefined, nfeDoc({ xml_nfe_proc: null }), NOW_MS)).toEqual({
      action: 'skip',
      reason: 'xml-ausente',
    });
  });

  it('skips a homologação XML', () => {
    expect(decideNfeUploadDispatch(undefined, nfeDoc({ xml_nfe_proc: XML_HOM }), NOW_MS)).toEqual({
      action: 'skip',
      reason: 'tpamb-homologacao',
    });
  });

  it('skips an XML with no tpAmb at all', () => {
    expect(
      decideNfeUploadDispatch(undefined, nfeDoc({ xml_nfe_proc: XML_SEM_TPAMB }), NOW_MS),
    ).toEqual({ action: 'skip', reason: 'tpamb-homologacao' });
  });

  it('RECURSION GUARD: a marker-only write (our own stamp) skips', () => {
    const before = nfeDoc();
    const after = nfeDoc({ mlEnvio: fullMarker() });
    expect(decideNfeUploadDispatch(before, after, NOW_MS)).toEqual({
      action: 'skip',
      reason: 'marker-write',
    });
  });

  it('RECURSION GUARD: a pendente→erro marker transition (task stamp) also skips', () => {
    const before = nfeDoc({ mlEnvio: fullMarker() });
    const after = nfeDoc({
      mlEnvio: fullMarker({ estado: ML_ENVIO_ESTADO.erro, motivo: 'reauth', tentativas: 1 }),
    });
    expect(decideNfeUploadDispatch(before, after, NOW_MS)).toEqual({
      action: 'skip',
      reason: 'marker-write',
    });
  });

  it('a real poke (ultima_modificacao bumped) on an erro marker RE-ENQUEUES (poke-as-retry)', () => {
    const erroMarker = fullMarker({ estado: ML_ENVIO_ESTADO.erro, motivo: 'envio-rejeitado' });
    const before = nfeDoc({ mlEnvio: erroMarker });
    const after = nfeDoc({
      mlEnvio: erroMarker,
      ultima_modificacao: Date.parse('2026-07-01T00:00:00.000Z'),
    });
    expect(decideNfeUploadDispatch(before, after, NOW_MS)).toEqual({ action: 'enqueue' });
  });

  it('skips an already-resolved marker: enviado', () => {
    const m = fullMarker({ estado: ML_ENVIO_ESTADO.enviado });
    expect(decideNfeUploadDispatch(nfeDoc({ mlEnvio: m }), nfeDoc({ mlEnvio: m }), NOW_MS)).toEqual(
      { action: 'skip', reason: 'ja-resolvida' },
    );
  });

  it('skips an already-resolved marker: descartado', () => {
    const m = fullMarker({ estado: ML_ENVIO_ESTADO.descartado, motivo: 'shipment-404' });
    expect(decideNfeUploadDispatch(nfeDoc({ mlEnvio: m }), nfeDoc({ mlEnvio: m }), NOW_MS)).toEqual(
      { action: 'skip', reason: 'ja-resolvida' },
    );
  });

  it('skips a FRESH pendente marker (upload in flight)', () => {
    const m = fullMarker({ atualizadoEm: NOW_MS - NFE_UPLOAD_PENDENTE_TTL_MS + 60_000 });
    expect(decideNfeUploadDispatch(nfeDoc({ mlEnvio: m }), nfeDoc({ mlEnvio: m }), NOW_MS)).toEqual(
      { action: 'skip', reason: 'em-andamento' },
    );
  });

  it('re-enqueues a STALE pendente marker (orphaned task)', () => {
    const m = fullMarker({ atualizadoEm: NOW_MS - NFE_UPLOAD_PENDENTE_TTL_MS - 1 });
    expect(decideNfeUploadDispatch(nfeDoc({ mlEnvio: m }), nfeDoc({ mlEnvio: m }), NOW_MS)).toEqual(
      { action: 'enqueue' },
    );
  });

  it('enqueues a created-already-approved doc (before undefined, no marker)', () => {
    expect(decideNfeUploadDispatch(undefined, nfeDoc(), NOW_MS)).toEqual({ action: 'enqueue' });
  });

  it('enqueues on a malformed marker', () => {
    expect(decideNfeUploadDispatch(undefined, nfeDoc({ mlEnvio: 'garbage' }), NOW_MS)).toEqual({
      action: 'enqueue',
    });
  });

  it('Flutter dual-run full-doc save (marker ERASED + ultima_modificacao bumped) re-enqueues', () => {
    // The erased-marker re-arm path the schema docblock promises: a legacy
    // full-doc save drops the mlEnvio key entirely and bumps the poke field.
    const before = nfeDoc({ mlEnvio: fullMarker({ estado: ML_ENVIO_ESTADO.enviado }) });
    const after = nfeDoc({ ultima_modificacao: Date.parse('2026-07-01T00:00:00.000Z') });
    delete after.mlEnvio;
    expect(decideNfeUploadDispatch(before, after, NOW_MS)).toEqual({ action: 'enqueue' });
  });

  it('our own re-arm write (xml null, marker cleared) skips at xml-ausente, not the guards', () => {
    // Loop closure: the task's mlEnvio-null re-arm on a vanished XML re-fires
    // the trigger; step 3 (xml-ausente) must win BEFORE the recursion guard or
    // the marker logic ever run.
    const before = nfeDoc({
      xml_nfe_proc: null,
      mlEnvio: fullMarker({ estado: ML_ENVIO_ESTADO.erro }),
    });
    const after = nfeDoc({ xml_nfe_proc: null, mlEnvio: null });
    expect(decideNfeUploadDispatch(before, after, NOW_MS)).toEqual({
      action: 'skip',
      reason: 'xml-ausente',
    });
  });
});

/* ------------------------------ enqueueNfeUpload --------------------------- */

describe('enqueueNfeUpload', () => {
  it('enqueues FIRST, then stamps the full pendente marker', async () => {
    const db = new FakeDb();
    seedNfe(db);
    const scheduler = makeScheduler();
    scheduler.enqueue.mockImplementation(async () => {
      // Order pin: at enqueue time the marker must NOT have been stamped yet.
      expect(marker(db)).toBeNull();
    });

    await enqueueNfeUpload(asDb(db), scheduler, PAYLOAD, NOW_MS);

    expect(scheduler.enqueue).toHaveBeenCalledExactlyOnceWith(PAYLOAD);
    expect(marker(db)).toEqual(fullMarker());
  });

  it('does NOT stamp when the enqueue fails (no stranded pendente)', async () => {
    const db = new FakeDb();
    seedNfe(db);
    const scheduler = makeScheduler();
    scheduler.enqueue.mockRejectedValue(new Error('queue down'));

    await expect(enqueueNfeUpload(asDb(db), scheduler, PAYLOAD, NOW_MS)).rejects.toThrow(
      'queue down',
    );
    expect(marker(db)).toBeNull();
  });

  it('propagates a marker-merge failure AFTER a successful enqueue (task stays queued)', async () => {
    // Eventarc redelivery covers the missing pendente stamp; the enqueued task
    // itself is duplicate-tolerant.
    const db = new FakeDb();
    seedNfe(db);
    const scheduler = makeScheduler();
    const failingDb = {
      collection: (path: string) => ({
        doc: (id: string) => ({
          ...db.ref(path, id),
          set: async () => {
            throw new Error('marker merge down');
          },
        }),
      }),
    } as unknown as Firestore;

    await expect(enqueueNfeUpload(failingDb, scheduler, PAYLOAD, NOW_MS)).rejects.toThrow(
      'marker merge down',
    );
    expect(scheduler.enqueue).toHaveBeenCalledExactlyOnceWith(PAYLOAD);
  });
});

/* --------------------------- processNfeUploadTask -------------------------- */

describe('processNfeUploadTask — happy path + dispositions', () => {
  it('POSTs the stored XML verbatim, stamps enviado, and NEVER touches the pedido', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const pedidoBefore = structuredClone(db.docs('pedidos').get(PEDIDO_ID));
    const api = makeApi();

    const result = await processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'enviado', motivo: null });
    expect(api.sendShipmentInvoiceData).toHaveBeenCalledExactlyOnceWith(SHIPMENT_ID, XML_PROD);
    expect(marker(db)).toEqual(
      fullMarker({ estado: ML_ENVIO_ESTADO.enviado, tentativas: 1, shipmentId: SHIPMENT_ID }),
    );
    expect(pedidoWrites(db)).toEqual([]);
    expect(db.docs('pedidos').get(PEDIDO_ID)).toEqual(pedidoBefore);
  });

  it('threads tentativas from retryCount (retryCount 2 → tentativas 3)', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);

    await processNfeUploadTask(makeDeps(db, makeApi()), PAYLOAD, 2);

    expect(marker(db)).toMatchObject({ estado: ML_ENVIO_ESTADO.enviado, tentativas: 3 });
  });

  it('returns nfe-nao-encontrada with NO write when the NF-e doc is gone', async () => {
    const db = new FakeDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await processNfeUploadTask(makeDeps(db, makeApi()), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'nfe-nao-encontrada', motivo: null });
    expect(db.opLog.filter((e) => e.op !== 'get')).toEqual([]);
    warn.mockRestore();
  });

  it('RE-ARMS (mlEnvio null, no tombstone) when the estado regressed since dispatch', async () => {
    // Estado bounce is real (rejeitada→re-verify→aprovada); a descartado
    // tombstone would permanently block the trigger AND the route.
    const db = new FakeDb();
    seedNfe(db, { estado: ESTADO_NFE.cancelada, mlEnvio: fullMarker() });

    const result = await processNfeUploadTask(makeDeps(db, makeApi()), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'descartado', motivo: 'nao-aprovada' });
    expect(marker(db)).toBeNull();
  });

  it('RE-ARMS (mlEnvio null) when the XML vanished', async () => {
    const db = new FakeDb();
    seedNfe(db, { xml_nfe_proc: null, mlEnvio: fullMarker() });

    const result = await processNfeUploadTask(makeDeps(db, makeApi()), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'descartado', motivo: 'xml-ausente' });
    expect(marker(db)).toBeNull();
  });

  it('discards a homologação XML', async () => {
    const db = new FakeDb();
    seedNfe(db, { xml_nfe_proc: XML_HOM });

    const result = await processNfeUploadTask(makeDeps(db, makeApi()), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'descartado', motivo: 'tpamb-homologacao' });
  });

  it('marks erro xml-invalido (deterministic, NO pedido stamp) on an unparseable tpAmb', async () => {
    const db = new FakeDb();
    seedNfe(db, { xml_nfe_proc: XML_SEM_TPAMB });
    seedPedido(db);

    const result = await processNfeUploadTask(makeDeps(db, makeApi()), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'erro-deterministico', motivo: 'xml-invalido' });
    expect(marker(db)).toMatchObject({ estado: ML_ENVIO_ESTADO.erro, motivo: 'xml-invalido' });
    expect(pedidoWrites(db)).toEqual([]);
  });

  it('discards when the pedido is gone', async () => {
    const db = new FakeDb();
    seedNfe(db);

    const result = await processNfeUploadTask(makeDeps(db, makeApi()), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'descartado', motivo: 'pedido-nao-encontrado' });
  });

  it('discards when another integradora owns the frete', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db, {
      freteInicial: freteMl({ externalOptionIntegracao: INTEGRACAO_FRETE.melhorEnvios }),
    });

    const result = await processNfeUploadTask(makeDeps(db, makeApi()), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'descartado', motivo: 'nao-mercado-livre' });
  });

  it('discards a local pedido (no integração)', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db, { integracaoPedidoOuterRef: null });

    const result = await processNfeUploadTask(makeDeps(db, makeApi()), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'descartado', motivo: 'sem-integracao' });
  });
});

describe('processNfeUploadTask — NF-e-before-shipment race (transient throws)', () => {
  it('THROWS (marker untouched) when the pedido has no freteInicial yet', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db, { freteInicial: null });

    await expect(processNfeUploadTask(makeDeps(db, makeApi()), PAYLOAD, 0)).rejects.toBeInstanceOf(
      NfeUploadTransientError,
    );
    expect(marker(db)).toBeNull();
    expect(pedidoWrites(db)).toEqual([]);
  });

  it('THROWS when the freteInicial has no externalId yet', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db, { freteInicial: freteMl({ externalId: null }) });

    await expect(processNfeUploadTask(makeDeps(db, makeApi()), PAYLOAD, 0)).rejects.toBeInstanceOf(
      NfeUploadTransientError,
    );
  });
});

describe('processNfeUploadTask — conta resolution', () => {
  it('conta not configured: marks erro (operator-recoverable, re-drivable), NO pedido stamp', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const deps = makeDeps(db, makeApi(), {
      resolveApi: vi.fn(async () => {
        throw new MercadoLivreContaNotConfiguredError('Integração conta-A não encontrada.');
      }),
    });

    const result = await processNfeUploadTask(deps, PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'erro-deterministico', motivo: 'conta-nao-configurada' });
    expect(marker(db)).toMatchObject({
      estado: ML_ENVIO_ESTADO.erro,
      motivo: 'conta-nao-configurada',
    });
    expect(pedidoWrites(db)).toEqual([]);
  });

  it('conta inactive: marks erro (operator-recoverable, re-drivable), NO pedido stamp', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const deps = makeDeps(db, makeApi(), {
      resolveApi: vi.fn(async () => {
        throw new MercadoLivreContaInativaError('conta-A');
      }),
    });

    const result = await processNfeUploadTask(deps, PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'erro-deterministico', motivo: 'conta-inativa' });
    expect(marker(db)).toMatchObject({ estado: ML_ENVIO_ESTADO.erro, motivo: 'conta-inativa' });
    expect(pedidoWrites(db)).toEqual([]);
  });

  it('reauth: marks erro reauth, does NOT throw, does NOT stamp the pedido', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = makeDeps(db, makeApi(), {
      resolveApi: vi.fn(async () => {
        throw new MercadoLivreReauthRequiredError('refresh_failed', 'refresh token morto');
      }),
    });

    const result = await processNfeUploadTask(deps, PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'erro-deterministico', motivo: 'reauth' });
    expect(marker(db)).toMatchObject({
      estado: ML_ENVIO_ESTADO.erro,
      motivo: 'reauth',
      ultimoErro: 'refresh token morto',
      shipmentId: SHIPMENT_ID,
    });
    expect(pedidoWrites(db)).toEqual([]);
    error.mockRestore();
  });
});

describe('processNfeUploadTask — shipment gate', () => {
  it('discards on getShipment 404 (shipment permanently gone)', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const api = makeApi({
      getShipment: vi.fn(async () => {
        throw httpErr(404);
      }),
    });

    const result = await processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'descartado', motivo: 'shipment-404' });
  });

  it('marks erro get-shipment-<status> (NO pedido stamp) on another getShipment 4xx', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const api = makeApi({
      getShipment: vi.fn(async () => {
        throw httpErr(403);
      }),
    });

    const result = await processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'erro-deterministico', motivo: 'get-shipment-403' });
    expect(marker(db)).toMatchObject({
      estado: ML_ENVIO_ESTADO.erro,
      motivo: 'get-shipment-403',
      ultimoErro: 'ML 403',
    });
    expect(pedidoWrites(db)).toEqual([]);
  });

  it('reauth on getShipment: marks erro reauth, does NOT throw, does NOT stamp the pedido', async () => {
    // Every 401 surfaces as MercadoLivreReauthRequiredError (toHttpError maps
    // it before an HttpError exists) — without its own branch it would escape
    // the transient allow-list and crash-loop all 6 attempts.
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = makeApi({
      getShipment: vi.fn(async () => {
        throw new MercadoLivreReauthRequiredError('refresh_failed', 'refresh token morto');
      }),
    });

    const result = await processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'erro-deterministico', motivo: 'reauth' });
    expect(marker(db)).toMatchObject({
      estado: ML_ENVIO_ESTADO.erro,
      motivo: 'reauth',
      ultimoErro: 'refresh token morto',
      shipmentId: SHIPMENT_ID,
    });
    expect(pedidoWrites(db)).toEqual([]);
    error.mockRestore();
  });

  it('THROWS on getShipment 429 (transient — no terminal marker beyond the pendente)', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const api = makeApi({
      getShipment: vi.fn(async () => {
        throw httpErr(429);
      }),
    });

    await expect(processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0)).rejects.toBeInstanceOf(
      MercadoLivreHttpError,
    );
    expect(marker(db)).toBeNull();
  });

  it('THROWS on getShipment 5xx (transient)', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const api = makeApi({
      getShipment: vi.fn(async () => {
        throw httpErr(500);
      }),
    });

    await expect(processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0)).rejects.toBeInstanceOf(
      MercadoLivreHttpError,
    );
  });

  it('THROWS while the shipment is pre-eligible (pending/handling window)', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const api = makeApi({
      getShipment: vi.fn(async () => ({ id: 1, status: 'pending', substatus: null })),
    });

    await expect(processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0)).rejects.toBeInstanceOf(
      NfeUploadTransientError,
    );
  });

  it('THROWS on an unknown shipment status (conservative transient)', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const api = makeApi({
      getShipment: vi.fn(async () => ({ id: 1, status: 'some_new_status', substatus: null })),
    });

    await expect(processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0)).rejects.toBeInstanceOf(
      NfeUploadTransientError,
    );
  });

  it('ja-processado: ready_to_ship past invoice_pending marks enviado WITHOUT posting', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const api = makeApi({
      getShipment: vi.fn(async () => ({
        id: 1,
        status: 'ready_to_ship',
        substatus: 'ready_to_print',
      })),
    });

    const result = await processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'ja-processado', motivo: 'ja-processado' });
    expect(marker(db)).toMatchObject({
      estado: ML_ENVIO_ESTADO.enviado,
      motivo: 'ja-processado',
    });
    expect(api.sendShipmentInvoiceData).not.toHaveBeenCalled();
  });

  it('discards a closed shipment (delivered)', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const api = makeApi({
      getShipment: vi.fn(async () => ({ id: 1, status: 'delivered', substatus: null })),
    });

    const result = await processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'descartado', motivo: 'shipment-encerrado' });
  });
});

describe('processNfeUploadTask — invoice POST outcomes', () => {
  it('shipment_invoice_already_saved → ja-enviado (success-equivalent, no pedido stamp)', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const api = makeApi({
      sendShipmentInvoiceData: vi.fn(async () => {
        throw httpErr(400, { code: 'shipment_invoice_already_saved' });
      }),
    });

    const result = await processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'ja-enviado', motivo: 'ja-enviado' });
    expect(marker(db)).toMatchObject({ estado: ML_ENVIO_ESTADO.enviado, motivo: 'ja-enviado' });
    expect(pedidoWrites(db)).toEqual([]);
  });

  it('a deterministic 4xx records the code AND stamps freteInicial.estado = error', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = makeApi({
      sendShipmentInvoiceData: vi.fn(async () => {
        throw httpErr(400, { code: 'wrong_receiver_cpf', message: 'CPF divergente' });
      }),
    });

    const result = await processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'erro-deterministico', motivo: 'envio-rejeitado' });
    expect(marker(db)).toMatchObject({
      estado: ML_ENVIO_ESTADO.erro,
      motivo: 'envio-rejeitado',
      ultimoErro: 'ML 400',
      ultimoErroCodigo: 'wrong_receiver_cpf',
      shipmentId: SHIPMENT_ID,
    });
    const pedidoDoc = db.docs('pedidos').get(PEDIDO_ID)!;
    const frete = pedidoDoc.freteInicial as DocData;
    expect(frete.estado).toBe(ESTADO_FRETE.error);
    expect(frete.externalId).toBe(SHIPMENT_ID); // preserved
    expect(frete.printLabelId).toBe('label-1'); // preserved
    expect(pedidoDoc.lastMarketplaceUpdate).toBe(NOW_US);
    error.mockRestore();
  });

  it('stamp guard: pedido deleted mid-POST → marker written, NO stamp attempted', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = makeApi({
      sendShipmentInvoiceData: vi.fn(async () => {
        db.docs('pedidos').delete(PEDIDO_ID);
        throw httpErr(400, { code: 'invalid_nfe_cstat' });
      }),
    });

    const result = await processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'erro-deterministico', motivo: 'envio-rejeitado' });
    expect(marker(db)).toMatchObject({ ultimoErroCodigo: 'invalid_nfe_cstat' });
    expect(pedidoWrites(db)).toEqual([]);
    logs.mockRestore();
    warn.mockRestore();
  });

  it('stamp guard: frete nulled mid-POST → NO stamp', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = makeApi({
      sendShipmentInvoiceData: vi.fn(async () => {
        const existing = db.docs('pedidos').get(PEDIDO_ID)!;
        db.docs('pedidos').set(PEDIDO_ID, { ...existing, freteInicial: null });
        throw httpErr(400, { code: 'invalid_nfe_cstat' });
      }),
    });

    const result = await processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'erro-deterministico', motivo: 'envio-rejeitado' });
    expect(pedidoWrites(db)).toEqual([]);
    logs.mockRestore();
  });

  it('stamp guard: frete reassigned to another integradora mid-POST → NO stamp, marker kept', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = makeApi({
      sendShipmentInvoiceData: vi.fn(async () => {
        const existing = db.docs('pedidos').get(PEDIDO_ID)!;
        db.docs('pedidos').set(PEDIDO_ID, {
          ...existing,
          freteInicial: freteMl({ externalOptionIntegracao: INTEGRACAO_FRETE.melhorEnvios }),
        });
        throw httpErr(400, { code: 'invalid_nfe_cstat' });
      }),
    });

    const result = await processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'erro-deterministico', motivo: 'envio-rejeitado' });
    expect(marker(db)).toMatchObject({ estado: ML_ENVIO_ESTADO.erro });
    expect(pedidoWrites(db)).toEqual([]);
    const frete = db.docs('pedidos').get(PEDIDO_ID)!.freteInicial as DocData;
    expect(frete.estado).not.toBe(ESTADO_FRETE.error);
    logs.mockRestore();
    warn.mockRestore();
  });

  it('THROWS on POST 429 (queue backoff covers the rate limit — no pause doc)', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const api = makeApi({
      sendShipmentInvoiceData: vi.fn(async () => {
        throw httpErr(429);
      }),
    });

    await expect(processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0)).rejects.toBeInstanceOf(
      MercadoLivreHttpError,
    );
  });

  it('THROWS on POST 5xx', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const api = makeApi({
      sendShipmentInvoiceData: vi.fn(async () => {
        throw httpErr(500);
      }),
    });

    await expect(processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0)).rejects.toBeInstanceOf(
      MercadoLivreHttpError,
    );
  });

  it('THROWS on shipment_already_being_processed (transient despite 4xx)', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const api = makeApi({
      sendShipmentInvoiceData: vi.fn(async () => {
        throw httpErr(409, { code: 'shipment_already_being_processed' });
      }),
    });

    await expect(processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0)).rejects.toBeInstanceOf(
      MercadoLivreHttpError,
    );
  });

  it('THROWS on a network failure', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const api = makeApi({
      sendShipmentInvoiceData: vi.fn(async () => {
        throw new MercadoLivreNetworkError('fetch falhou');
      }),
    });

    await expect(processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0)).rejects.toBeInstanceOf(
      MercadoLivreNetworkError,
    );
  });
});

describe('processNfeUploadTask — final attempt', () => {
  it('persists tentativas-esgotadas + stamps the frete instead of throwing', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const api = makeApi({
      sendShipmentInvoiceData: vi.fn(async () => {
        throw httpErr(500);
      }),
    });

    const result = await processNfeUploadTask(
      makeDeps(db, api),
      PAYLOAD,
      NFE_UPLOAD_MAX_ATTEMPTS - 1,
    );

    expect(result).toEqual({ outcome: 'erro-final', motivo: 'tentativas-esgotadas' });
    expect(marker(db)).toEqual(
      fullMarker({
        estado: ML_ENVIO_ESTADO.erro,
        tentativas: NFE_UPLOAD_MAX_ATTEMPTS,
        shipmentId: SHIPMENT_ID,
        motivo: 'tentativas-esgotadas',
        ultimoErro: 'ML 500',
      }),
    );
    const pedidoDoc = db.docs('pedidos').get(PEDIDO_ID)!;
    expect((pedidoDoc.freteInicial as DocData).estado).toBe(ESTADO_FRETE.error);
    expect(pedidoDoc.lastMarketplaceUpdate).toBe(NOW_US);
  });

  it('sem-frete exhausted keeps its tag as motivo and skips the frete stamp BY DESIGN', async () => {
    // Tagged transient → no pedido write, by design (not merely because the
    // frete happens to be null): "the shipment never became eligible" is not
    // an upload failure.
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db, { freteInicial: null });

    const result = await processNfeUploadTask(
      makeDeps(db, makeApi()),
      PAYLOAD,
      NFE_UPLOAD_MAX_ATTEMPTS - 1,
    );

    expect(result).toEqual({ outcome: 'erro-final', motivo: 'sem-frete' });
    expect(marker(db)).toMatchObject({
      estado: ML_ENVIO_ESTADO.erro,
      motivo: 'sem-frete',
      shipmentId: null,
    });
    expect(pedidoWrites(db)).toEqual([]);
  });

  it('shipment-pendente exhausted: marker keeps the tag, pedido UNTOUCHED despite a frete', async () => {
    // The frete exists here — the skipped stamp is the tagged-transient rule,
    // not a missing-frete accident: false-stamping freteInicial 'error' would
    // flag a healthy pedido whose shipment simply never opened invoice_pending.
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const pedidoBefore = structuredClone(db.docs('pedidos').get(PEDIDO_ID));
    const api = makeApi({
      getShipment: vi.fn(async () => ({ id: 1, status: 'pending', substatus: null })),
    });

    const result = await processNfeUploadTask(
      makeDeps(db, api),
      PAYLOAD,
      NFE_UPLOAD_MAX_ATTEMPTS - 1,
    );

    expect(result).toEqual({ outcome: 'erro-final', motivo: 'shipment-pendente' });
    expect(marker(db)).toMatchObject({
      estado: ML_ENVIO_ESTADO.erro,
      motivo: 'shipment-pendente',
      shipmentId: SHIPMENT_ID,
    });
    expect(pedidoWrites(db)).toEqual([]);
    expect(db.docs('pedidos').get(PEDIDO_ID)).toEqual(pedidoBefore);
  });
});

/* ---------------------------- classifyInvoiceError ------------------------- */

describe('classifyInvoiceError', () => {
  it('classifies network failures and 5xx/429 as transient', () => {
    expect(classifyInvoiceError(new MercadoLivreNetworkError('down'))).toEqual({
      kind: 'transient',
    });
    expect(classifyInvoiceError(httpErr(503))).toEqual({ kind: 'transient' });
    expect(classifyInvoiceError(httpErr(429))).toEqual({ kind: 'transient' });
  });

  it('classifies 401 and ReauthRequired as reauth', () => {
    expect(classifyInvoiceError(httpErr(401))).toEqual({ kind: 'reauth' });
    expect(
      classifyInvoiceError(new MercadoLivreReauthRequiredError('no_token', 'sem credencial')),
    ).toEqual({ kind: 'reauth' });
  });

  it('extracts a code from the nested cause[]/causes[] shapes', () => {
    expect(
      classifyInvoiceError(
        httpErr(400, { message: 'Validation error', cause: [{ code: 'duplicated_fiscal_key' }] }),
      ),
    ).toEqual({ kind: 'deterministic', code: 'duplicated_fiscal_key' });
    expect(classifyInvoiceError(httpErr(400, { causes: ['wrong_invoice_date'] }))).toEqual({
      kind: 'deterministic',
      code: 'wrong_invoice_date',
    });
  });

  it('does NOT mistake free prose for a machine code', () => {
    expect(classifyInvoiceError(httpErr(400, { message: 'Invoice already saved' }))).toEqual({
      kind: 'deterministic',
      code: null,
    });
  });

  it('treats shipment_already_being_processed / internal_error as transient despite 4xx', () => {
    expect(
      classifyInvoiceError(httpErr(409, { code: 'shipment_already_being_processed' })),
    ).toEqual({ kind: 'transient' });
    expect(classifyInvoiceError(httpErr(400, { code: 'internal_error' }))).toEqual({
      kind: 'transient',
    });
  });
});

/* ------------------------------- task schema ------------------------------- */

describe('nfeUploadTaskSchema', () => {
  it('rejects empty ids', () => {
    expect(nfeUploadTaskSchema.safeParse({ pedidoId: '', nfeId: NFE_ID }).success).toBe(false);
    expect(nfeUploadTaskSchema.safeParse({ pedidoId: PEDIDO_ID, nfeId: NFE_ID }).success).toBe(
      true,
    );
  });
});
