import { inflateRawSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { PERM } from '@delfrance/auth';
import { ESTADO_FRETE, ESTADO_PEDIDO, INTEGRACAO_FRETE } from '@delfrance/schemas';

// verifyCaller / loadMercadoLivreContext / the ML api factory are mocked; the
// route's own logic (query validation, the strict pedido ladder, byte sniffing,
// the error-mapping ORDER) plus the REAL pedidoCollection path+parse and the
// REAL removeZplDanfeFromZip / error classes (spread-actual package mock) run real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  get: vi.fn(),
  docPaths: [] as string[],
  loadCtx: vi.fn(),
  getLabels: vi.fn(),
  apiConfigs: [] as Array<{ getAccessToken: () => Promise<string> }>,
}));

// Fake Firestore exposing only the collection().doc().get() chain the route
// exercises — the real pedidoCollection handle resolves the path against it.
vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => ({
    collection: (path: string) => ({
      doc: (id: string) => ({
        get: () => {
          h.docPaths.push(`${path}/${id}`);
          return h.get();
        },
      }),
    }),
  }),
}));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/marketplace/core/mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/core/mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadCtx };
});

// Spread-actual keeps the error classes AND removeZplDanfeFromZip real (the
// zpl2 test proves the strip is wired, not mocked); only the api factory is
// replaced, capturing its config so the getAccessToken wiring is assertable.
vi.mock('@delfrance/integrations-mercado-livre', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/integrations-mercado-livre')>();
  return {
    ...actual,
    createMercadoLivreApi: (config: { getAccessToken: () => Promise<string> }) => {
      h.apiConfigs.push(config);
      return { getShipmentLabels: h.getLabels };
    },
  };
});

const { GET } = await import('./route');
const {
  MercadoLivreHttpError,
  MercadoLivreLabelUnavailableError,
  MercadoLivreReauthRequiredError,
} = await import('@delfrance/integrations-mercado-livre');

/* --------------------------- minimal ZIP fixtures --------------------------- */
// fflate is not a dependency of this app (only of the integrations package), so
// the fixture ZIP is built by hand as a STORED (method 0) archive and the
// route's re-zipped (deflate) response is read back via the central directory +
// node:zlib — no extra dependency, same wire format.

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

const u16 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff];
const u32 = (v: number): number[] => [
  v & 0xff,
  (v >>> 8) & 0xff,
  (v >>> 16) & 0xff,
  (v >>> 24) & 0xff,
];

/** Build a valid STORED ZIP from name → text content. */
function storedZip(entries: Record<string, string>): Uint8Array {
  const out: number[] = [];
  const central: number[] = [];
  let count = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameB = Array.from(new TextEncoder().encode(name));
    const data = new TextEncoder().encode(content);
    const crc = crc32(data);
    const offset = out.length;
    // Local file header (30 bytes) + name + stored data.
    out.push(0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0));
    out.push(
      ...u32(crc),
      ...u32(data.length),
      ...u32(data.length),
      ...u16(nameB.length),
      ...u16(0),
    );
    out.push(...nameB, ...Array.from(data));
    // Central directory header (46 bytes) + name.
    central.push(0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(0));
    central.push(...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length));
    central.push(...u16(nameB.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0));
    central.push(...u32(offset), ...nameB);
    count++;
  }
  const cdOffset = out.length;
  out.push(...central);
  out.push(0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(count), ...u16(count));
  out.push(...u32(central.length), ...u32(cdOffset), ...u16(0));
  return new Uint8Array(out);
}

/** Read every entry (stored or deflate) of a ZIP via its central directory. */
function readZipEntries(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('EOCD not found — not a ZIP');
  const count = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);
  const out: Record<string, string> = {};
  for (let n = 0; n < count; n++) {
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOff = view.getUint32(ptr + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    // The local header's own name/extra lengths locate the data (fflate's
    // streaming writer uses data descriptors, so central sizes are the truth).
    const dataStart =
      localOff + 30 + view.getUint16(localOff + 26, true) + view.getUint16(localOff + 28, true);
    const comp = bytes.subarray(dataStart, dataStart + compSize);
    const raw = method === 8 ? new Uint8Array(inflateRawSync(comp)) : comp;
    out[name] = new TextDecoder().decode(raw);
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* --------------------------------- fixtures -------------------------------- */

const PEDIDO_ID = 'ped-1';
const SHIPMENT_ID = '44440001';
const TRANSPORT_ZPL = '^XA\n^FO50,50^FDMercado Envios 44440001^FS\n^XZ';
const DANFE_ZPL = '^XA\n^FO20,20^FDDANFE SIMPLIFICADO^FS\n^XZ';
const PDF_BYTES = new TextEncoder().encode('%PDF-1.7 etiqueta-fake');

function freteMl(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    estado: ESTADO_FRETE.aguardandoNFe,
    externalId: SHIPMENT_ID,
    externalOptionIntegracao: INTEGRACAO_FRETE.mercadoLivre,
    printLabelId: 'label-1',
    ultimaModificacao: Date.parse('2026-06-01T00:00:00.000Z') * 1000,
    ...over,
  };
}

// Raw doc as stored — the route parseReads it through the REAL pedido schema.
function pedidoDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    numero: '1234',
    estado: ESTADO_PEDIDO.pago,
    integracaoPedidoOuterRef: 'documents/integracao/conta-A',
    freteInicial: freteMl(),
    ...over,
  };
}

function mlContext(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    integracaoId: 'conta-A',
    conta: { ativo: true },
    resolveChannelContext: async () => ({
      integracaoId: 'conta-A',
      accessToken: 'tok',
      account: {},
    }),
    ...over,
  };
}

function req(query: string): Request {
  return new Request(`http://localhost:3006/api/marketplace/mercado-livre/etiqueta${query}`, {
    method: 'GET',
  });
}

const QUERY = `?pedidoId=${PEDIDO_ID}&formato=pdf`;

beforeEach(() => {
  vi.clearAllMocks();
  h.docPaths.length = 0;
  h.apiConfigs.length = 0;
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1', permissions: undefined } });
  h.get.mockResolvedValue({ exists: true, data: () => pedidoDoc() });
  h.loadCtx.mockResolvedValue(mlContext());
  h.getLabels.mockResolvedValue({ bytes: PDF_BYTES, contentType: 'application/pdf' });
});

describe('GET /api/marketplace/mercado-livre/etiqueta', () => {
  it('propagates verifyCaller failures (401/403) and pins PERM.frete.read', async () => {
    h.verifyCaller.mockResolvedValueOnce({ error: new NextResponse(null, { status: 401 }) });
    expect((await GET(req(QUERY))).status).toBe(401);
    h.verifyCaller.mockResolvedValueOnce({ error: new NextResponse(null, { status: 403 }) });
    expect((await GET(req(QUERY))).status).toBe(403);
    // Read-only label fetch (no checkout) — the ME imprimir precedent.
    expect(h.verifyCaller).toHaveBeenCalledWith(expect.anything(), PERM.frete.read);
    expect(h.get).not.toHaveBeenCalled();
  });

  it('400s QUERY_INVALIDA on missing or invalid query params', async () => {
    for (const q of [
      '',
      '?formato=pdf',
      `?pedidoId=${PEDIDO_ID}`,
      `?pedidoId=&formato=pdf`,
      `?pedidoId=${PEDIDO_ID}&formato=png`,
    ]) {
      const res = await GET(req(q));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('QUERY_INVALIDA');
    }
    expect(h.get).not.toHaveBeenCalled();
  });

  it('404s PEDIDO_NAO_ENCONTRADO when the pedido does not exist', async () => {
    h.get.mockResolvedValue({ exists: false, data: () => undefined });
    const res = await GET(req(QUERY));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('PEDIDO_NAO_ENCONTRADO');
    expect(h.docPaths).toEqual([`pedidos/${PEDIDO_ID}`]);
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('409s FRETE_NAO_MERCADO_LIVRE when the frete is missing or owned by another integradora', async () => {
    for (const freteInicial of [
      null,
      freteMl({ externalOptionIntegracao: INTEGRACAO_FRETE.melhorEnvios }),
    ]) {
      h.get.mockResolvedValue({ exists: true, data: () => pedidoDoc({ freteInicial }) });
      const res = await GET(req(QUERY));
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('FRETE_NAO_MERCADO_LIVRE');
    }
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('409s FRETE_SEM_EXTERNAL_ID with the legacy support message', async () => {
    for (const externalId of [null, '']) {
      h.get.mockResolvedValue({
        exists: true,
        data: () => pedidoDoc({ freteInicial: freteMl({ externalId }) }),
      });
      const res = await GET(req(QUERY));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('FRETE_SEM_EXTERNAL_ID');
      expect(body.error).toBe(
        'Não foi possível encontrar o frete no Mercado Livre deste pedido. ' +
          'Entre em contato com o suporte para que o problema possa ser verificado.',
      );
    }
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('409s FRETE_NAO_MERCADO_LIVRE when a ML frete has no integração ref to resolve the conta', async () => {
    h.get.mockResolvedValue({
      exists: true,
      data: () => pedidoDoc({ integracaoPedidoOuterRef: null }),
    });
    const res = await GET(req(QUERY));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('FRETE_NAO_MERCADO_LIVRE');
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('409s ML_CONTA_INATIVA when the conta is flagged inactive', async () => {
    h.loadCtx.mockResolvedValue(mlContext({ conta: { ativo: false } }));
    const res = await GET(req(QUERY));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ML_CONTA_INATIVA');
    expect(h.getLabels).not.toHaveBeenCalled();
  });

  it('200 pdf: streams the bytes with sniffed content-type and pinned disposition', async () => {
    const res = await GET(req(QUERY));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="etiqueta-1234.pdf"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF_BYTES);
    // Conta resolution rides the pedido's integração ref; the api factory gets
    // the resolved channel token.
    expect(h.loadCtx).toHaveBeenCalledWith(expect.anything(), 'conta-A');
    expect(h.getLabels).toHaveBeenCalledWith(SHIPMENT_ID, 'pdf');
    expect(await h.apiConfigs[0]?.getAccessToken()).toBe('tok');
  });

  it('falls back to the pedidoId in the filename when the pedido has no numero', async () => {
    h.get.mockResolvedValue({ exists: true, data: () => pedidoDoc({ numero: null }) });
    const res = await GET(req(QUERY));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="etiqueta-${PEDIDO_ID}.pdf"`,
    );
  });

  it('200 zpl2: strips DANFE blocks through the REAL removeZplDanfeFromZip', async () => {
    const zip = storedZip({ 'etiqueta.zpl': `${TRANSPORT_ZPL}\n${DANFE_ZPL}` });
    h.getLabels.mockResolvedValue({ bytes: zip, contentType: 'application/zip' });
    const res = await GET(req(`?pedidoId=${PEDIDO_ID}&formato=zpl2`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="etiqueta-1234.zip"');
    // The re-zipped response's entry lost the DANFE block but kept transport —
    // the strip ran for real, it was not mocked away.
    const entries = readZipEntries(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(entries)).toEqual(['etiqueta.zpl']);
    expect(entries['etiqueta.zpl']).toBe(TRANSPORT_ZPL);
    expect(entries['etiqueta.zpl']).not.toContain('DANFE');
    expect(h.getLabels).toHaveBeenCalledWith(SHIPMENT_ID, 'zpl2');
  });

  it('200 zpl2 fail-safe: a ZIP without DANFE passes through byte-identical', async () => {
    const zip = storedZip({ 'etiqueta.zpl': TRANSPORT_ZPL });
    h.getLabels.mockResolvedValue({ bytes: zip, contentType: null });
    const res = await GET(req(`?pedidoId=${PEDIDO_ID}&formato=zpl2`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(zip);
  });

  it('200 zpl2 fail-safe: non-ZIP bytes pass through as octet-stream with .zip name', async () => {
    const raw = new TextEncoder().encode(TRANSPORT_ZPL);
    h.getLabels.mockResolvedValue({ bytes: raw, contentType: null });
    const res = await GET(req(`?pedidoId=${PEDIDO_ID}&formato=zpl2`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="etiqueta-1234.zip"');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(raw);
  });

  it('409s ML_INVOICE_PENDING when ML refuses with invoice_pending (caught BEFORE the generic mapper)', async () => {
    // The class extends MercadoLivreError, so a wrong catch order would bury
    // this as respond.ts's generic 500 — the 409 pins the order.
    h.getLabels.mockRejectedValue(
      new MercadoLivreLabelUnavailableError(
        'Etiqueta indisponível no Mercado Livre: invoice_pending',
        'Shipment 44440001 is in invoice_pending substatus',
      ),
    );
    const res = await GET(req(QUERY));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ML_INVOICE_PENDING');
  });

  it('409s ML_ETIQUETA_INDISPONIVEL with the ML message for other label refusals', async () => {
    h.getLabels.mockRejectedValue(
      new MercadoLivreLabelUnavailableError(
        'Etiqueta indisponível no Mercado Livre: not ready',
        'Shipment 44440001 not ready_to_print',
      ),
    );
    const res = await GET(req(QUERY));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('ML_ETIQUETA_INDISPONIVEL');
    expect(body.error).toBe('Shipment 44440001 not ready_to_print');

    // Empty mlMessage (the 2xx-empty-body legacy guard) still carries a reason.
    h.getLabels.mockRejectedValue(
      new MercadoLivreLabelUnavailableError('O Mercado Livre retornou uma etiqueta vazia.', ''),
    );
    const res2 = await GET(req(QUERY));
    expect(res2.status).toBe(409);
    expect((await res2.json()).error).toBe('O Mercado Livre retornou uma etiqueta vazia.');
  });

  it('maps other known ML errors through respond.ts (token / upstream HTTP)', async () => {
    h.getLabels.mockRejectedValue(new MercadoLivreHttpError('ML 500', 500, null));
    const res = await GET(req(QUERY));
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('ML_HTTP_ERROR');

    h.getLabels.mockRejectedValue(
      new MercadoLivreReauthRequiredError('refresh_failed', 'reconecte a conta'),
    );
    const res2 = await GET(req(QUERY));
    expect(res2.status).toBe(409);
    expect((await res2.json()).code).toBe('ML_REAUTH_REQUIRED');
  });

  it('rethrows unexpected errors instead of masking them', async () => {
    h.getLabels.mockRejectedValue(new Error('boom'));
    await expect(GET(req(QUERY))).rejects.toThrow('boom');
  });
});
