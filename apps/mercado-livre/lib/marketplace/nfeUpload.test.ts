import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  MercadoLivreReauthRequiredError,
  type MercadoLivreApi,
} from '@delfrance/integrations-mercado-livre';
import { ESTADO_FRETE, ESTADO_NFE, ESTADO_PEDIDO, INTEGRACAO_FRETE } from '@delfrance/schemas';

import { MercadoLivreContaNotConfiguredError } from './mercadoLivre';
import {
  MercadoLivreContaInativaError,
  NFE_UPLOAD_MAX_ATTEMPTS,
  NfeUploadTransientError,
  classifyInvoiceError,
  decideNfeUploadDispatch,
  extractTpAmb,
  nfeUploadTaskSchema,
  processNfeUploadTask,
  shouldUploadForPedido,
  type NfeUploadDeps,
  type NfeUploadTaskPayload,
} from './nfeUpload';

/* ------------------------------ fake Firestore ---------------------------- */
// Own copy (repo convention: per-file FakeDb copies, not shared fakes) —
// cloned from orderShipmentImport.test.ts and SCOPED to what nfeUpload.ts
// touches: `pedidos` doc get/update (incl. inside the stampFreteErro
// transaction) and the `pedidos/{pedidoId}/nfev4` subcollection's get. The
// opLog records EVERY op — it is the probe behind the REV-2 pinned cost
// invariant (zero Firestore writes anywhere except the single pedido TX
// update on genuine upload failure). The reads-before-writes guard inside
// `runTransaction` mirrors orderPedidoTx.test.ts's FakeDb.

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
        col.set(id, { ...(col.get(id) ?? {}), ...patch });
      },
      set: async (data: DocData, opts?: { merge?: boolean }) => {
        self.opLog.push({ op: 'set', path: `${path}/${id}` });
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

/* ---- the REV-2 cost probes: writes are recorded per path by the opLog ---- */

/** Every non-read op, anywhere — the "ZERO writes" probe. */
function allWrites(db: FakeDb): Array<{ op: OpKind; path: string }> {
  return db.opLog.filter((e) => e.op !== 'get');
}

/**
 * Every non-read op that hit the nfev4 subcollection — must ALWAYS be empty,
 * even on the two paths where the pedido IS written (`allWrites` pins the
 * full shape there; this probe names the nfev4 half of the invariant).
 */
function nfeWrites(db: FakeDb): Array<{ op: OpKind; path: string }> {
  return allWrites(db).filter((e) => e.path.startsWith(`${NFE_COL}/`));
}

const httpErr = (status: number, body: unknown = null): MercadoLivreHttpError =>
  new MercadoLivreHttpError(`ML ${status}`, status, body);

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

// REV 2: there is NO recursion guard and NO marker/TTL dedup here anymore —
// this module writes nothing to nfev4 (zero-write model), so no self-inflicted
// trigger re-fire exists to guard against. Any doc write (pokes included)
// simply re-runs these four cheap guards; a redundant enqueue is resolved by
// the task's live shipment-status gate (substatus leaves `invoice_pending`
// once ML has the invoice).
describe('decideNfeUploadDispatch', () => {
  it('skips a deleted doc', () => {
    expect(decideNfeUploadDispatch(nfeDoc(), undefined)).toEqual({
      action: 'skip',
      reason: 'apagada',
    });
  });

  it('skips a non-aprovada estado', () => {
    expect(decideNfeUploadDispatch(undefined, nfeDoc({ estado: ESTADO_NFE.gerado }))).toEqual({
      action: 'skip',
      reason: 'nao-aprovada',
    });
  });

  it('skips when xml_nfe_proc is null', () => {
    expect(decideNfeUploadDispatch(undefined, nfeDoc({ xml_nfe_proc: null }))).toEqual({
      action: 'skip',
      reason: 'xml-ausente',
    });
  });

  it('skips a non-string xml_nfe_proc (malformed doc)', () => {
    expect(decideNfeUploadDispatch(undefined, nfeDoc({ xml_nfe_proc: 123 }))).toEqual({
      action: 'skip',
      reason: 'xml-ausente',
    });
  });

  it('skips a homologação XML', () => {
    expect(decideNfeUploadDispatch(undefined, nfeDoc({ xml_nfe_proc: XML_HOM }))).toEqual({
      action: 'skip',
      reason: 'tpamb-homologacao',
    });
  });

  it('skips an XML with no tpAmb at all', () => {
    expect(decideNfeUploadDispatch(undefined, nfeDoc({ xml_nfe_proc: XML_SEM_TPAMB }))).toEqual({
      action: 'skip',
      reason: 'tpamb-homologacao',
    });
  });

  it('enqueues a created-already-approved doc (before undefined)', () => {
    expect(decideNfeUploadDispatch(undefined, nfeDoc())).toEqual({ action: 'enqueue' });
  });

  it('enqueues on an unchanged rewrite/poke — dedup is the task shipment gate, not here', () => {
    expect(decideNfeUploadDispatch(nfeDoc(), nfeDoc())).toEqual({ action: 'enqueue' });
  });
});

/* ---------------------------- shouldUploadForPedido ------------------------ */

describe('shouldUploadForPedido', () => {
  it('skips a missing pedido', async () => {
    const db = new FakeDb();
    await expect(shouldUploadForPedido(asDb(db), PEDIDO_ID)).resolves.toEqual({
      action: 'skip',
      reason: 'pedido-nao-encontrado',
    });
  });

  it('enqueues a Mercado Livre freteInicial', async () => {
    const db = new FakeDb();
    seedPedido(db);
    await expect(shouldUploadForPedido(asDb(db), PEDIDO_ID)).resolves.toEqual({
      action: 'enqueue',
    });
  });

  it('skips a frete owned by another integradora', async () => {
    const db = new FakeDb();
    seedPedido(db, {
      freteInicial: freteMl({ externalOptionIntegracao: INTEGRACAO_FRETE.melhorEnvios }),
    });
    await expect(shouldUploadForPedido(asDb(db), PEDIDO_ID)).resolves.toEqual({
      action: 'skip',
      reason: 'nao-mercado-livre',
    });
  });

  it('skips a local pedido (null frete, null integração ref)', async () => {
    const db = new FakeDb();
    seedPedido(db, { freteInicial: null, integracaoPedidoOuterRef: null });
    await expect(shouldUploadForPedido(asDb(db), PEDIDO_ID)).resolves.toEqual({
      action: 'skip',
      reason: 'sem-integracao',
    });
  });

  it('ENQUEUES on null frete + integração ref present (order-import race)', async () => {
    // The importer that writes freteInicial runs every 15 min; the task's
    // transient sem-frete throw + queue backoff resolves the gap.
    const db = new FakeDb();
    seedPedido(db, { freteInicial: null });
    await expect(shouldUploadForPedido(asDb(db), PEDIDO_ID)).resolves.toEqual({
      action: 'enqueue',
    });
  });
});

/* --------------------------- processNfeUploadTask -------------------------- */

describe('processNfeUploadTask — happy path + dispositions', () => {
  it('POSTs the stored XML verbatim with ZERO Firestore writes (REV-2 cost invariant)', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const pedidoBefore = structuredClone(db.docs('pedidos').get(PEDIDO_ID));
    const api = makeApi();

    const result = await processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'enviado', motivo: null });
    expect(api.sendShipmentInvoiceData).toHaveBeenCalledExactlyOnceWith(SHIPMENT_ID, XML_PROD);
    expect(allWrites(db)).toEqual([]);
    expect(db.docs('pedidos').get(PEDIDO_ID)).toEqual(pedidoBefore);
  });

  it('returns nfe-nao-encontrada with NO write when the NF-e doc is gone', async () => {
    const db = new FakeDb();

    const result = await processNfeUploadTask(makeDeps(db, makeApi()), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'nfe-nao-encontrada', motivo: null });
    expect(allWrites(db)).toEqual([]);
  });

  it('discards (zero writes) when the estado regressed since dispatch', async () => {
    const db = new FakeDb();
    seedNfe(db, { estado: ESTADO_NFE.cancelada });

    const result = await processNfeUploadTask(makeDeps(db, makeApi()), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'descartado', motivo: 'nao-aprovada' });
    expect(allWrites(db)).toEqual([]);
  });

  it('discards (zero writes) when the XML vanished', async () => {
    const db = new FakeDb();
    seedNfe(db, { xml_nfe_proc: null });

    const result = await processNfeUploadTask(makeDeps(db, makeApi()), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'descartado', motivo: 'xml-ausente' });
    expect(allWrites(db)).toEqual([]);
  });

  it('discards a homologação XML (zero writes)', async () => {
    const db = new FakeDb();
    seedNfe(db, { xml_nfe_proc: XML_HOM });

    const result = await processNfeUploadTask(makeDeps(db, makeApi()), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'descartado', motivo: 'tpamb-homologacao' });
    expect(allWrites(db)).toEqual([]);
  });

  it('returns erro-deterministico xml-invalido (zero writes) on an unparseable tpAmb', async () => {
    const db = new FakeDb();
    seedNfe(db, { xml_nfe_proc: XML_SEM_TPAMB });
    seedPedido(db);

    const result = await processNfeUploadTask(makeDeps(db, makeApi()), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'erro-deterministico', motivo: 'xml-invalido' });
    expect(allWrites(db)).toEqual([]);
  });

  it('discards when the pedido is gone (zero writes)', async () => {
    const db = new FakeDb();
    seedNfe(db);

    const result = await processNfeUploadTask(makeDeps(db, makeApi()), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'descartado', motivo: 'pedido-nao-encontrado' });
    expect(allWrites(db)).toEqual([]);
  });

  it('discards when another integradora owns the frete (zero writes)', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db, {
      freteInicial: freteMl({ externalOptionIntegracao: INTEGRACAO_FRETE.melhorEnvios }),
    });

    const result = await processNfeUploadTask(makeDeps(db, makeApi()), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'descartado', motivo: 'nao-mercado-livre' });
    expect(allWrites(db)).toEqual([]);
  });

  it('discards a local pedido (no integração, zero writes)', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db, { integracaoPedidoOuterRef: null });

    const result = await processNfeUploadTask(makeDeps(db, makeApi()), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'descartado', motivo: 'sem-integracao' });
    expect(allWrites(db)).toEqual([]);
  });
});

describe('processNfeUploadTask — NF-e-before-shipment race (transient throws)', () => {
  it('THROWS (zero writes) when the pedido has no freteInicial yet', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db, { freteInicial: null });

    await expect(processNfeUploadTask(makeDeps(db, makeApi()), PAYLOAD, 0)).rejects.toBeInstanceOf(
      NfeUploadTransientError,
    );
    expect(allWrites(db)).toEqual([]);
  });

  it('THROWS (zero writes) when the freteInicial has no externalId yet', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db, { freteInicial: freteMl({ externalId: null }) });

    await expect(processNfeUploadTask(makeDeps(db, makeApi()), PAYLOAD, 0)).rejects.toBeInstanceOf(
      NfeUploadTransientError,
    );
    expect(allWrites(db)).toEqual([]);
  });
});

describe('processNfeUploadTask — conta resolution', () => {
  it('conta not configured: returns erro-deterministico, zero writes', async () => {
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
    expect(allWrites(db)).toEqual([]);
  });

  it('conta inactive: returns erro-deterministico, zero writes', async () => {
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
    expect(allWrites(db)).toEqual([]);
  });

  it('reauth: logs, returns erro-deterministico reauth, does NOT throw, zero writes', async () => {
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
    expect(error).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('credencial morta'),
      expect.objectContaining({ pedidoId: PEDIDO_ID, nfeId: NFE_ID, error: 'refresh token morto' }),
    );
    expect(allWrites(db)).toEqual([]);
    error.mockRestore();
  });
});

describe('processNfeUploadTask — shipment gate', () => {
  it('discards on getShipment 404 (shipment permanently gone, zero writes)', async () => {
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
    expect(allWrites(db)).toEqual([]);
  });

  it('returns erro-deterministico get-shipment-<status> (zero writes) on another getShipment 4xx', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = makeApi({
      getShipment: vi.fn(async () => {
        throw httpErr(403, { code: 'forbidden' });
      }),
    });

    const result = await processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'erro-deterministico', motivo: 'get-shipment-403' });
    expect(error).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('consulta do shipment rejeitada'),
      expect.objectContaining({
        pedidoId: PEDIDO_ID,
        shipmentId: SHIPMENT_ID,
        status: 403,
        body: { code: 'forbidden' },
      }),
    );
    expect(allWrites(db)).toEqual([]);
    error.mockRestore();
  });

  it('reauth on getShipment: logs, returns erro-deterministico reauth, zero writes', async () => {
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
    expect(allWrites(db)).toEqual([]);
    error.mockRestore();
  });

  it('THROWS a TAGGED transient on getShipment 429 (zero writes)', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const api = makeApi({
      getShipment: vi.fn(async () => {
        throw httpErr(429);
      }),
    });

    // Tagged 'consulta-shipment' so exhaustion can never stamp the frete —
    // no upload was attempted (Copilot review catch).
    await expect(processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0)).rejects.toMatchObject({
      name: 'NfeUploadTransientError',
      tag: 'consulta-shipment',
      stampFreteOnExhaust: false,
    });
    expect(allWrites(db)).toEqual([]);
  });

  it('THROWS a TAGGED transient on getShipment 5xx and on network failure', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const api500 = makeApi({
      getShipment: vi.fn(async () => {
        throw httpErr(500);
      }),
    });
    await expect(processNfeUploadTask(makeDeps(db, api500), PAYLOAD, 0)).rejects.toMatchObject({
      name: 'NfeUploadTransientError',
      tag: 'consulta-shipment',
    });

    const apiNet = makeApi({
      getShipment: vi.fn(async () => {
        throw new MercadoLivreNetworkError('fetch falhou');
      }),
    });
    await expect(processNfeUploadTask(makeDeps(db, apiNet), PAYLOAD, 0)).rejects.toMatchObject({
      name: 'NfeUploadTransientError',
      tag: 'consulta-shipment',
    });
    expect(allWrites(db)).toEqual([]);
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
    expect(allWrites(db)).toEqual([]);
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
    expect(allWrites(db)).toEqual([]);
  });

  it('ja-processado: ready_to_ship past invoice_pending converges WITHOUT posting or writing', async () => {
    // THE dedup of the zero-write model: a redundant task (poke, Eventarc
    // redelivery, double enqueue) lands here once the invoice reached ML.
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
    expect(api.sendShipmentInvoiceData).not.toHaveBeenCalled();
    expect(allWrites(db)).toEqual([]);
  });

  it('discards a closed shipment (delivered, zero writes)', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const api = makeApi({
      getShipment: vi.fn(async () => ({ id: 1, status: 'delivered', substatus: null })),
    });

    const result = await processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0);

    expect(result).toEqual({ outcome: 'descartado', motivo: 'shipment-encerrado' });
    expect(allWrites(db)).toEqual([]);
  });
});

describe('processNfeUploadTask — invoice POST outcomes', () => {
  it('shipment_invoice_already_saved → ja-enviado (success-equivalent, zero writes)', async () => {
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
    expect(allWrites(db)).toEqual([]);
  });

  it('a deterministic 4xx logs the full detail and the ONLY write is the pedido TX update', async () => {
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
    // Failure DETAIL lives in Cloud Logging only (REV 2) — code + body included.
    expect(error).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('rejeição determinística'),
      expect.objectContaining({
        pedidoId: PEDIDO_ID,
        nfeId: NFE_ID,
        shipmentId: SHIPMENT_ID,
        code: 'wrong_receiver_cpf',
        message: 'ML 400',
        body: { code: 'wrong_receiver_cpf', message: 'CPF divergente' },
      }),
    );
    // The pinned cost invariant: ONE write in the whole flow, the pedido TX —
    // and NOTHING on the nfev4 doc.
    expect(allWrites(db)).toEqual([{ op: 'update', path: `pedidos/${PEDIDO_ID}` }]);
    expect(nfeWrites(db)).toEqual([]);
    const pedidoDoc = db.docs('pedidos').get(PEDIDO_ID)!;
    const frete = pedidoDoc.freteInicial as DocData;
    expect(frete.estado).toBe(ESTADO_FRETE.error);
    expect(frete.externalId).toBe(SHIPMENT_ID); // preserved
    expect(frete.printLabelId).toBe('label-1'); // preserved
    expect(pedidoDoc.lastMarketplaceUpdate).toBe(NOW_US);
    error.mockRestore();
  });

  it('stamp guard: pedido deleted mid-POST → NO write at all', async () => {
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
    expect(allWrites(db)).toEqual([]);
    logs.mockRestore();
    warn.mockRestore();
  });

  it('stamp guard: frete nulled mid-POST → NO write', async () => {
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
    expect(allWrites(db)).toEqual([]);
    logs.mockRestore();
  });

  it('stamp guard: frete reassigned to another integradora mid-POST → NO write', async () => {
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
    expect(allWrites(db)).toEqual([]);
    const frete = db.docs('pedidos').get(PEDIDO_ID)!.freteInicial as DocData;
    expect(frete.estado).not.toBe(ESTADO_FRETE.error);
    logs.mockRestore();
    warn.mockRestore();
  });

  // POST transients rethrow TAGGED with stampFreteOnExhaust — the ONE class
  // whose exhaustion may stamp the frete (a real upload attempt failed).
  const POST_TRANSIENTS: Array<[string, () => Error]> = [
    ['POST 429 (queue backoff covers the rate limit)', () => httpErr(429)],
    ['POST 5xx', () => httpErr(500)],
    [
      'shipment_already_being_processed (transient despite 4xx)',
      () => httpErr(409, { code: 'shipment_already_being_processed' }),
    ],
    ['a network failure', () => new MercadoLivreNetworkError('fetch falhou')],
  ];
  for (const [title, make] of POST_TRANSIENTS) {
    it(`THROWS a stamp-armed TAGGED transient on ${title} (zero writes)`, async () => {
      const db = new FakeDb();
      seedNfe(db);
      seedPedido(db);
      const api = makeApi({
        sendShipmentInvoiceData: vi.fn(async () => {
          throw make();
        }),
      });

      await expect(processNfeUploadTask(makeDeps(db, api), PAYLOAD, 0)).rejects.toMatchObject({
        name: 'NfeUploadTransientError',
        tag: 'tentativas-esgotadas',
        stampFreteOnExhaust: true,
      });
      expect(allWrites(db)).toEqual([]);
    });
  }
});

describe('processNfeUploadTask — final attempt', () => {
  it('POST transient exhausted: logs, stamps the frete (the ONLY write), returns erro-final', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
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
    expect(error).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('tentativas esgotadas'),
      expect.objectContaining({
        pedidoId: PEDIDO_ID,
        nfeId: NFE_ID,
        shipmentId: SHIPMENT_ID,
        retryCount: NFE_UPLOAD_MAX_ATTEMPTS - 1,
        motivo: 'tentativas-esgotadas',
        error: expect.stringContaining('ML 500'),
      }),
    );
    // The pinned cost invariant: ONE write, the pedido TX update — nothing
    // on the nfev4 doc.
    expect(allWrites(db)).toEqual([{ op: 'update', path: `pedidos/${PEDIDO_ID}` }]);
    expect(nfeWrites(db)).toEqual([]);
    const pedidoDoc = db.docs('pedidos').get(PEDIDO_ID)!;
    expect((pedidoDoc.freteInicial as DocData).estado).toBe(ESTADO_FRETE.error);
    expect(pedidoDoc.lastMarketplaceUpdate).toBe(NOW_US);
    error.mockRestore();
  });

  it('sem-frete exhausted keeps its tag as motivo and writes NOTHING', async () => {
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db, { freteInicial: null });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await processNfeUploadTask(
      makeDeps(db, makeApi()),
      PAYLOAD,
      NFE_UPLOAD_MAX_ATTEMPTS - 1,
    );

    expect(result).toEqual({ outcome: 'erro-final', motivo: 'sem-frete' });
    expect(allWrites(db)).toEqual([]);
    error.mockRestore();
  });

  it('shipment-pendente exhausted: NO frete stamp BY DESIGN despite a frete existing', async () => {
    // The frete exists here — the skipped stamp is the tagged-transient rule,
    // not a missing-frete accident: false-stamping freteInicial 'error' would
    // flag a healthy pedido whose shipment simply never opened invoice_pending.
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const pedidoBefore = structuredClone(db.docs('pedidos').get(PEDIDO_ID));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = makeApi({
      getShipment: vi.fn(async () => ({ id: 1, status: 'pending', substatus: null })),
    });

    const result = await processNfeUploadTask(
      makeDeps(db, api),
      PAYLOAD,
      NFE_UPLOAD_MAX_ATTEMPTS - 1,
    );

    expect(result).toEqual({ outcome: 'erro-final', motivo: 'shipment-pendente' });
    expect(allWrites(db)).toEqual([]);
    expect(db.docs('pedidos').get(PEDIDO_ID)).toEqual(pedidoBefore);
    error.mockRestore();
  });

  it('getShipment 5xx exhausted: NO frete stamp — no upload was ever attempted', async () => {
    // The Copilot review catch: a pre-POST ML transient (shipment GET
    // 429/5xx/network) exhausting its retries must not produce a frete
    // 'error' — the shipment state is unknown and the invoice POST never ran.
    const db = new FakeDb();
    seedNfe(db);
    seedPedido(db);
    const pedidoBefore = structuredClone(db.docs('pedidos').get(PEDIDO_ID));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = makeApi({
      getShipment: vi.fn(async () => {
        throw httpErr(500);
      }),
    });

    const result = await processNfeUploadTask(
      makeDeps(db, api),
      PAYLOAD,
      NFE_UPLOAD_MAX_ATTEMPTS - 1,
    );

    expect(result).toEqual({ outcome: 'erro-final', motivo: 'consulta-shipment' });
    expect(allWrites(db)).toEqual([]);
    expect(db.docs('pedidos').get(PEDIDO_ID)).toEqual(pedidoBefore);
    error.mockRestore();
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
