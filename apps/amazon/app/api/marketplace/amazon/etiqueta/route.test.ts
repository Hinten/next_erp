/**
 * `POST /api/marketplace/amazon/etiqueta` — the thin route over
 * `imprimirEtiquetaAmazon` (whose ladder `etiquetaAmazon.test.ts` covers rung by
 * rung). Here: the permission split, the bindings END TO END through the process
 * environment and the Admin singleton, what the HTTP answers carry, and that a
 * caller's uid reaches no line.
 *
 * Mocked: the Admin singleton (the fake db, a token verifier). D11: the route hands
 * the body no `fetch`, so the global one is what it reaches; here that global is a
 * script, and the read switch is `on` only through `vi.stubEnv`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  CODIGO_ERRO_AMAZON,
  CODIGO_ERRO_ETIQUETA_AMAZON,
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  erroEtiquetaAmazonSchema,
} from '@delfrance/schemas';

import { ConfigAmazonAusenteError } from '@/lib/amazon/core/erros';
import { makePedidoIdAmazon } from '@/lib/amazon/pedidos/orderIds';
import { FakeDb, asDb } from '@/lib/amazon/testing/fakeDb';
import {
  AMBIENTE_LIGADO,
  SPID_A,
  espiarStdout,
  respostaJson,
  seedConta,
  seedCredencial,
  stubAmbiente,
} from '@/lib/amazon/testing/fixtures';
import {
  ATUALIZADO_US,
  ORDER_ID_TESTE,
  pacoteAmazon,
  pedidoAmazon,
} from '@/lib/amazon/testing/pedidoWireAmazon';
import { bytesDe, zipDeTeste } from '@/lib/amazon/testing/zipEtiqueta';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  db: undefined as unknown,
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db,
  getAdminApp: () => ({ name: 'app-de-teste' }),
}));

const { POST } = await import('./route');

const CONTA = 'conta-amz-etiqueta';
const ORDER = ORDER_ID_TESTE;
const PEDIDO_ID = makePedidoIdAmazon(CONTA, ORDER);
const URL_ROTA = 'http://localhost:3011/api/marketplace/amazon/etiqueta';
const URL_DOCUMENTO =
  'https://example-bucket.s3.amazonaws.com/etiqueta.zip?X-Amz-Signature=0000sentinela';
const ZPL = bytesDe('^XA^FO50,50^FDETIQUETA DE TESTE^FS^XZ\n');
const CAMINHO_MINT = '/tokens/2021-03-01/restrictedDataToken';
const CAMINHO_BULK = '/easyShip/2022-03-23/packages/bulk';
const GET_ORDER = `GET /orders/2026-01-01/orders/${ORDER}`;
const POST_MINT = `POST ${CAMINHO_MINT}`;
const POST_BULK = `POST ${CAMINHO_BULK}`;
const GET_DOCUMENTO = 'GET DOCUMENTO';

/** The uids, as sentinels a line must never carry. */
const LEITOR_DE_FRETE = { uid: 'u-sentinela-leitor', permissions: PERM.frete.read.toString() };
const ESCRITOR_DE_FRETE = {
  uid: 'u-sentinela-escritor',
  permissions: (PERM.frete.read | PERM.frete.write).toString(),
};
const SO_ESCRITA_DE_FRETE = {
  uid: 'u-sentinela-so-escrita',
  permissions: PERM.frete.write.toString(),
};
const EXPEDICAO = { uid: 'u-sentinela-expedicao', permissions: PERM.pedido.write.toString() };

let db: FakeDb;
let stdout: ReturnType<typeof espiarStdout>;
let chamadas: string[];
/** The `detailedStatus` getOrder answers for the order's one package. */
let detalhe: string;

function post(corpo: unknown, opts: { semAuth?: boolean } = {}): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (opts.semAuth !== true) headers.set('authorization', 'Bearer id-token-de-teste');
  return POST(new Request(URL_ROTA, { method: 'POST', headers, body: JSON.stringify(corpo) }));
}

function cabecalhosOk(res: Response) {
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
}

function semear() {
  seedConta(db, CONTA, { nome: 'Conta etiqueta', selling_partner_id: SPID_A });
  // The route binds no clock: the credential is fresh against the real one.
  seedCredencial(db, CONTA, { expirationDate: Date.now() + 30 * 60 * 1000 });
  db.seed(`pedidos/${PEDIDO_ID}`, {
    numero: ORDER,
    integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
    estado: ESTADO_PEDIDO.pago,
    lastMarketplaceUpdate: ATUALIZADO_US,
    marketplace: { tipo: 'amazon', fulfilledBy: 'MERCHANT', programs: ['DELIVERY_BY_AMAZON'] },
    freteInicial: {
      externalOptionIntegracao: 'amz',
      estado: ESTADO_FRETE.aguardandoAgendamento,
    },
  });
}

/** The one network this suite has: getOrder, the mint, the bulk and the document. */
const fetchRoteirizado = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : String(input));
  const metodo = init?.method ?? 'GET';
  if (url.hostname.endsWith('.amazonaws.com')) {
    chamadas.push(GET_DOCUMENTO);
    return Promise.resolve(
      new Response(zipDeTeste({ 'a.zpl': ZPL }) as BodyInit, {
        status: 200,
        headers: {
          // ★ (mutation 10) Amazon's own file name, which must never reach the answer.
          'content-disposition': 'attachment; filename="nome-da-amazon.zip"',
          'content-type': 'application/zip',
        },
      }),
    );
  }
  chamadas.push(`${metodo} ${url.pathname}`);
  if (url.pathname === CAMINHO_MINT) {
    return Promise.resolve(
      respostaJson(200, { restrictedDataToken: 'Atz.TESTE-rdt-sintetico', expiresIn: 3600 }),
    );
  }
  if (url.pathname === CAMINHO_BULK) {
    return Promise.resolve(
      respostaJson(200, {
        scheduledPackages: [
          { scheduledPackageId: { amazonOrderId: ORDER, packageId: 'PKG-1' }, packageStatus: 'X' },
        ],
        printableDocumentsUrl: URL_DOCUMENTO,
      }),
    );
  }
  return Promise.resolve(
    respostaJson(200, {
      order: JSON.parse(
        JSON.stringify(
          pedidoAmazon({
            status: 'UNSHIPPED',
            programs: ['DELIVERY_BY_AMAZON'],
            invoiceStatus: 'ACCEPTED',
            pacotesBrutos: [pacoteAmazon('PKG-1', detalhe, { status: 'PENDING' })],
          }),
        ),
      ) as unknown,
    }),
  );
}) as typeof globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  __resetAllReadCaches();
  db = new FakeDb();
  h.db = asDb(db);
  chamadas = [];
  detalhe = 'PENDING_SCHEDULE';
  h.verifyIdToken.mockResolvedValue(ESCRITOR_DE_FRETE);
  stubAmbiente({
    ...AMBIENTE_LIGADO,
    AMAZON_MODO_AGENDAMENTO: 'on',
    AMAZON_CANARIO_AGENDAMENTO: '*',
  });
  stdout = espiarStdout();
  vi.stubGlobal('fetch', fetchRoteirizado);
});

afterEach(() => {
  // ★ (mutation 3) No arm writes Firestore (a fresh stored token).
  expect(db.escritas).toEqual([]);
  // ★ The caller's uid reaches no line, and neither does the link.
  const linhas = stdout.linhas().join('\n');
  expect(linhas).not.toContain('u-sentinela');
  expect(linhas).not.toContain('X-Amz-');
  stdout.restaurar();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  __resetAllReadCaches();
});

describe('POST /api/marketplace/amazon/etiqueta', () => {
  it('exports POST only, on the node runtime, never cached', async () => {
    const rota = await import('./route');
    expect(Object.keys(rota).sort()).toEqual(['POST', 'dynamic', 'runtime']);
    expect(rota.dynamic).toBe('force-dynamic');
    expect(rota.runtime).toBe('nodejs');
  });

  it('no Bearer token ⇒ 401, with both headers, nothing read or called', async () => {
    semear();
    const res = await post({ pedidoId: PEDIDO_ID }, { semAuth: true });
    expect(res.status).toBe(401);
    cabecalhosOk(res);
    expect(db.operacoes).toBe(0);
    expect(chamadas).toEqual([]);
  });

  it.each([
    ['a caller who handles orders (pedido.write only)', EXPEDICAO],
    ['frete.write WITHOUT frete.read', SO_ESCRITA_DE_FRETE],
  ])('★ %s ⇒ 403, with both headers, nothing read or called', async (_titulo, caller) => {
    semear();
    h.verifyIdToken.mockResolvedValue(caller);
    const res = await post({ pedidoId: PEDIDO_ID });
    expect(res.status).toBe(403);
    cabecalhosOk(res);
    expect(db.operacoes).toBe(0);
    expect(chamadas).toEqual([]);
  });

  it('★ (mutations 9, 10) the 200 end to end: Content-Type EXACTLY text/plain, our own file name (never Amazon’s), no-store, and the entry’s bytes', async () => {
    semear();
    const res = await post({ pedidoId: PEDIDO_ID });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="amazon-${ORDER}.zpl"`,
    );
    cabecalhosOk(res);
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(ZPL))).toBe(true);
    expect(chamadas).toEqual([GET_ORDER, POST_MINT, POST_BULK, GET_DOCUMENTO]);
  });

  it('★ (mutation 1) a frete.read-only caller on a first schedule ⇒ 403 SEM_PERMISSAO, with both headers, zero POSTs', async () => {
    semear();
    h.verifyIdToken.mockResolvedValue(LEITOR_DE_FRETE);
    const res = await post({ pedidoId: PEDIDO_ID });
    expect(res.status).toBe(403);
    cabecalhosOk(res);
    expect(erroEtiquetaAmazonSchema.parse(await res.json()).code).toBe(
      CODIGO_ERRO_ETIQUETA_AMAZON.SEM_PERMISSAO,
    );
    expect(chamadas).toEqual([GET_ORDER]);
  });

  it('★ a frete.read-only caller on an EXISTING schedule ⇒ the label: two POSTs and one document GET', async () => {
    semear();
    detalhe = 'PENDING_PICK_UP';
    h.verifyIdToken.mockResolvedValue(LEITOR_DE_FRETE);
    const res = await post({ pedidoId: PEDIDO_ID });
    expect(res.status).toBe(200);
    expect(chamadas).toEqual([GET_ORDER, POST_MINT, POST_BULK, GET_DOCUMENTO]);
  });

  it('a 409 carries its motivo through the envelope, with both headers and as JSON', async () => {
    db.seed(`pedidos/${PEDIDO_ID}`, { numero: ORDER, integracaoPedidoOuterRef: null });
    const res = await post({ pedidoId: PEDIDO_ID });
    expect(res.status).toBe(409);
    cabecalhosOk(res);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(erroEtiquetaAmazonSchema.parse(await res.json())).toMatchObject({
      code: CODIGO_ERRO_ETIQUETA_AMAZON.NAO_ELEGIVEL,
      motivo: 'nao-amazon',
    });
    expect(chamadas).toEqual([]);
  });

  it('★ (mutation 4) the read switch off ⇒ 503 AMAZON_CHAMADAS_DESLIGADAS, with both headers, ZERO Firestore operations', async () => {
    semear();
    vi.stubEnv('AMAZON_CHAMADAS', '');
    const res = await post({ pedidoId: PEDIDO_ID });
    expect(res.status).toBe(503);
    cabecalhosOk(res);
    expect(await res.json()).toMatchObject({ code: CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS });
    expect(db.operacoes).toBe(0);
    expect(chamadas).toEqual([]);
  });

  it('★ (mutation 2) the valve unset ⇒ 503 DESLIGADA, with both headers, zero Amazon calls', async () => {
    semear();
    vi.stubEnv('AMAZON_MODO_AGENDAMENTO', '');
    const res = await post({ pedidoId: PEDIDO_ID });
    expect(res.status).toBe(503);
    cabecalhosOk(res);
    expect(erroEtiquetaAmazonSchema.parse(await res.json()).code).toBe(
      CODIGO_ERRO_ETIQUETA_AMAZON.DESLIGADA,
    );
    expect(chamadas).toEqual([]);
  });

  it('★ a body with a `formato` ⇒ 400 with its field path, and both headers', async () => {
    semear();
    const res = await post({ pedidoId: PEDIDO_ID, formato: 'PDF' });
    expect(res.status).toBe(400);
    cabecalhosOk(res);
    expect(await res.json()).toMatchObject({
      code: CODIGO_ERRO_ETIQUETA_AMAZON.CORPO_INVALIDO,
      issues: ['formato'],
    });
    expect(db.operacoes).toBe(0);
  });

  it('★ the LWA pair missing from the deploy PROPAGATES (the platform’s 500), after ONE ERROR line, zero Amazon calls', async () => {
    semear();
    vi.stubEnv('AMAZON_LWA_CLIENT_ID', '');
    await expect(post({ pedidoId: PEDIDO_ID })).rejects.toBeInstanceOf(ConfigAmazonAusenteError);
    const erros = stdout
      .linhas()
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.severity === 'ERROR');
    expect(erros).toEqual([
      expect.objectContaining({
        evento: 'agendamento',
        rota: 'etiqueta',
        resultado: 'falhou',
        motivo: 'ConfigAmazonAusenteError',
      }),
    ]);
    expect(chamadas).toEqual([]);
  });
});
