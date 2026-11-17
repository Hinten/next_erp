import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  CODIGO_ERRO_AMAZON,
  CODIGO_ERRO_ETIQUETA_AMAZON,
  MOTIVO_ETIQUETA_AMAZON,
  type StatusContaAmazon,
} from '@delfrance/schemas';

/**
 * The browser client for `apps/amazon`'s conta routes.
 *
 * Pinned here, each with its near miss:
 *
 *  1. the WIRE — method, path, percent-encoded id, the ID-token header, no body
 *     — against the routes PR b shipped;
 *  2. EVERY answer is read against the shared contract (`@delfrance/schemas`,
 *     `contaAmazon.ts`), the error envelope included — nothing is cast, so an
 *     HTML body is a typed error and never a truthy object;
 *  3. the fail-closed rule: an `https:` page never gets a client for an `http:`
 *     backend, keyed on the PAGE protocol, not on `NODE_ENV`.
 */

const h = vi.hoisted(() => ({
  user: null as null | { getIdToken: () => Promise<string> },
}));

vi.mock('@/lib/auth/useAuth', () => ({ useAuth: () => ({ user: h.user }) }));

const {
  DEFAULT_AMAZON_URL,
  NOME_ETIQUETA_AMAZON_PADRAO,
  criarClienteAmazon,
  ehTipoEtiquetaAmazon,
  resolverBackendAmazon,
  useAmazonClient,
  useBackendAmazon,
} = await import('./client');
const {
  AmazonBackendError,
  AmazonRedeError,
  AmazonRespostaInvalidaError,
  MENSAGEM_ETIQUETA_AMAZON_AGUARDE,
  MENSAGEM_MOTIVO_ETIQUETA_AMAZON_DESCONHECIDO,
  MENSAGENS_CODIGO_ERRO_ETIQUETA_AMAZON,
  MENSAGENS_MOTIVO_ETIQUETA_AMAZON,
  mensagemErroEtiquetaAmazon,
  mensagemHttpAmazon,
  mensagemHttpEtiquetaAmazon,
} = await import('./erros');

const BASE = 'https://amazon.backend.test';

interface Chamada {
  readonly url: string;
  readonly init: RequestInit;
}

function cliente(responder: (c: Chamada) => Promise<Response> | Response) {
  const chamadas: Chamada[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const chamada = { url: String(input), init: init ?? {} };
    chamadas.push(chamada);
    return responder(chamada);
  });
  const c = criarClienteAmazon(`${BASE}/`, async () => 'id-token-firebase', fetchImpl);
  return { c, chamadas };
}

function json(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function html(status: number): Response {
  return new Response('<!doctype html><html><body>Proxy error</body></html>', {
    status,
    headers: { 'content-type': 'text/html' },
  });
}

const STATUS: StatusContaAmazon = {
  connected: true,
  credencialInvalida: false,
  autorizadoEm: '2026-03-10',
  reautorizarAte: '2027-03-10',
  diasParaReautorizar: 146,
  reconexaoPendente: null,
  chamadasLigadas: false,
};

const CONSENTIMENTO = 'https://consentimento.test/apps/authorize/consent?state=s';

/** Swallow the console line a non-JSON body logs, so the run stays quiet. */
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function falhaDe(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('esperava uma falha');
    },
    (err: unknown) => err,
  );
}

describe('the wire, route by route', () => {
  it('conta(id) is a GET on …/conta/{id}, with the ID token and no body', async () => {
    const { c, chamadas } = cliente(() => json(200, STATUS));

    await c.conta('conta-1');

    expect(chamadas).toHaveLength(1);
    const [ch] = chamadas;
    expect(ch?.url).toBe(`${BASE}/api/marketplace/amazon/conta/conta-1`);
    expect(ch?.init.method).toBe('GET');
    expect(ch?.init.body).toBeUndefined();
    expect(ch?.init.headers).toEqual({
      Authorization: 'Bearer id-token-firebase',
      Accept: 'application/json',
    });
  });

  it('oauthStart(id) is a POST on …/conta/{id}/oauth/start, with no body', async () => {
    const { c, chamadas } = cliente(() => json(200, { authorizeUrl: CONSENTIMENTO }));

    await expect(c.oauthStart('conta-1')).resolves.toEqual({ authorizeUrl: CONSENTIMENTO });

    const [ch] = chamadas;
    expect(ch?.url).toBe(`${BASE}/api/marketplace/amazon/conta/conta-1/oauth/start`);
    expect(ch?.init.method).toBe('POST');
    // Minting the state is a write on the backend; nothing travels in a body.
    expect(ch?.init.body).toBeUndefined();
    expect(ch?.init.headers).toEqual({
      Authorization: 'Bearer id-token-firebase',
      Accept: 'application/json',
    });
  });

  it('percent-encodes the id as ONE path segment', async () => {
    const { c, chamadas } = cliente(() => json(200, STATUS));

    await c.conta('a/b?c#d');

    expect(chamadas[0]?.url).toBe(`${BASE}/api/marketplace/amazon/conta/a%2Fb%3Fc%23d`);
  });

  it('reads the ID token per call, so a refreshed token propagates', async () => {
    const tokens = ['t1', 't2'];
    const fetchImpl = vi.fn(async () => json(200, STATUS));
    const c = criarClienteAmazon(BASE, async () => tokens.shift() ?? 'fim', fetchImpl);

    await c.conta('x');
    await c.conta('x');

    const auth = fetchImpl.mock.calls.map(
      (args: unknown[]) => (args[1] as { headers: Record<string, string> }).headers.Authorization,
    );
    expect(auth).toEqual(['Bearer t1', 'Bearer t2']);
  });
});

describe('every 2xx is read against the shared schema', () => {
  it('returns the status the schema parsed — unknown keys stripped, never refused', async () => {
    const { c } = cliente(() => json(200, { ...STATUS, campoDeUmPassoFuturo: 1 }));

    await expect(c.conta('conta-1')).resolves.toEqual(STATUS);
  });

  it('⭐ an HTML 200 is a typed error, NOT a truthy object whose `connected` is undefined', async () => {
    const { c } = cliente(() => html(200));

    const err = await falhaDe(c.conta('conta-1'));

    expect(err).toBeInstanceOf(AmazonRespostaInvalidaError);
    const e = err as InstanceType<typeof AmazonRespostaInvalidaError>;
    expect(e.status).toBe(200);
    expect(e.codigo).toBeNull();
    // The page stays on the console, never in the message.
    expect(e.message).not.toContain('Proxy error');
    expect(e.message).toContain('sem um corpo JSON');
  });

  it('an EMPTY 200 is the same "never reached the route" error, not version skew', async () => {
    const { c } = cliente(() => new Response('', { status: 200 }));

    const err = await falhaDe(c.conta('conta-1'));

    expect(err).toBeInstanceOf(AmazonRespostaInvalidaError);
    expect((err as Error).message).not.toContain('deploy');
  });

  it('a wrong shape names the field PATHS and says what to do', async () => {
    const { c } = cliente(() =>
      json(200, { ...STATUS, connected: 'sim', autorizadoEm: '10/03/2026' }),
    );

    const err = await falhaDe(c.conta('conta-1'));

    expect(err).toBeInstanceOf(AmazonRespostaInvalidaError);
    const e = err as InstanceType<typeof AmazonRespostaInvalidaError>;
    expect([...e.campos].sort()).toEqual(['autorizadoEm', 'connected']);
    expect(e.message).toContain('connected');
    // Paths only — the offending VALUE never reaches the message.
    expect(e.message).not.toContain('10/03/2026');
  });

  it('a start answer without a URL is refused', async () => {
    const { c } = cliente(() => json(200, { authorizeUrl: 'não é url' }));

    const err = await falhaDe(c.oauthStart('conta-1'));

    expect(err).toBeInstanceOf(AmazonRespostaInvalidaError);
    expect((err as InstanceType<typeof AmazonRespostaInvalidaError>).campos).toEqual([
      'authorizeUrl',
    ]);
  });

  it.each(['javascript:alert(1)', 'data:text/html,<b>x</b>'])(
    '⭐ a schema-valid start URL with the scheme %j is never handed to the navigation',
    async (authorizeUrl) => {
      const { c } = cliente(() => json(200, { authorizeUrl }));

      const err = await falhaDe(c.oauthStart('conta-1'));

      expect(err).toBeInstanceOf(AmazonRespostaInvalidaError);
      expect((err as InstanceType<typeof AmazonRespostaInvalidaError>).campos).toEqual([
        'authorizeUrl',
      ]);
    },
  );

  it('the near miss: an http: start URL (a local stub) is accepted', async () => {
    const local = 'http://localhost:3000/__e2e__/consentimento-amazon';
    const { c } = cliente(() => json(200, { authorizeUrl: local }));

    await expect(c.oauthStart('conta-1')).resolves.toEqual({ authorizeUrl: local });
  });
});

describe('the error envelope', () => {
  it('a coded envelope becomes an AmazonBackendError carrying the code and status', async () => {
    const { c } = cliente(() =>
      json(503, {
        error: 'As chamadas à Amazon estão desligadas neste backend.',
        code: CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS,
      }),
    );

    const err = await falhaDe(c.oauthStart('conta-1'));

    expect(err).toBeInstanceOf(AmazonBackendError);
    expect(err).not.toBeInstanceOf(AmazonRespostaInvalidaError);
    const e = err as InstanceType<typeof AmazonBackendError>;
    expect(e.status).toBe(503);
    expect(e.codigo).toBe(CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS);
    expect(e.message).toBe('As chamadas à Amazon estão desligadas neste backend.');
  });

  it('keeps `issues` as field paths', async () => {
    const { c } = cliente(() =>
      json(500, {
        error: 'Configuração ausente.',
        code: CODIGO_ERRO_AMAZON.CONFIG_AUSENTE,
        issues: ['AMAZON_APPLICATION_ID'],
      }),
    );

    const err = (await falhaDe(c.oauthStart('conta-1'))) as InstanceType<typeof AmazonBackendError>;

    expect(err.campos).toEqual(['AMAZON_APPLICATION_ID']);
  });

  it("verifyCaller's CODED 401 (a Firebase Auth code) keeps its code", async () => {
    const { c } = cliente(() =>
      json(401, {
        error: 'Token inválido ou expirado (auth/id-token-expired).',
        code: 'auth/id-token-expired',
      }),
    );

    const err = (await falhaDe(c.conta('conta-1'))) as InstanceType<typeof AmazonBackendError>;

    expect(err.codigo).toBe('auth/id-token-expired');
    expect(err.status).toBe(401);
  });

  it("verifyCaller's CODELESS 403 is not the envelope: no code, copy from the status", async () => {
    const { c } = cliente(() => json(403, { error: 'Sem permissão para esta operação.' }));

    const err = (await falhaDe(c.conta('conta-1'))) as InstanceType<typeof AmazonBackendError>;

    expect(err).toBeInstanceOf(AmazonBackendError);
    expect(err.codigo).toBeNull();
    expect(err.status).toBe(403);
    expect(err.message).toContain('permissão');
  });

  it('a proxy HTML 502 is an AmazonBackendError with no code, the page kept off the message', async () => {
    const { c } = cliente(() => html(502));

    const err = (await falhaDe(c.conta('conta-1'))) as InstanceType<typeof AmazonBackendError>;

    expect(err).toBeInstanceOf(AmazonBackendError);
    expect(err).not.toBeInstanceOf(AmazonRespostaInvalidaError);
    expect(err.codigo).toBeNull();
    expect(err.status).toBe(502);
    expect(err.message).not.toContain('Proxy error');
    expect(err.message).toContain('HTTP 502');
  });

  it('a JSON array on a 4xx is not read as the envelope', async () => {
    const { c } = cliente(() => json(400, ['error', 'code']));

    const err = (await falhaDe(c.conta('conta-1'))) as InstanceType<typeof AmazonBackendError>;

    expect(err.codigo).toBeNull();
    expect(err.status).toBe(400);
  });
});

describe('transport failures', () => {
  it('a rejected fetch is an AmazonRedeError with a FIXED message, the cause kept', async () => {
    const causa = new TypeError('Failed to fetch');
    const { c } = cliente(() => Promise.reject(causa));

    const err = (await falhaDe(c.conta('conta-1'))) as InstanceType<typeof AmazonRedeError>;

    expect(err).toBeInstanceOf(AmazonRedeError);
    expect(err.message).toBe('Falha de rede ao contatar o backend da Amazon.');
    expect(err.cause).toBe(causa);
  });

  it('a body that drops MID-READ is an AmazonRedeError, never a bare TypeError', async () => {
    const quebrado = new Response('x', { status: 200 });
    vi.spyOn(quebrado, 'text').mockRejectedValue(new TypeError('terminated'));
    const { c } = cliente(() => quebrado);

    await expect(c.conta('conta-1')).rejects.toBeInstanceOf(AmazonRedeError);
  });

  it('a body read failing with anything else propagates as itself', async () => {
    const quebrado = new Response('x', { status: 200 });
    const outro = new RangeError('outra coisa');
    vi.spyOn(quebrado, 'text').mockRejectedValue(outro);
    const { c } = cliente(() => quebrado);

    await expect(c.conta('conta-1')).rejects.toBe(outro);
  });

  it('an ID-token failure is NOT relabelled a network error, and nothing is sent', async () => {
    const falhaDeSessao = new Error('auth/network-request-failed');
    const fetchImpl = vi.fn();
    const c = criarClienteAmazon(BASE, () => Promise.reject(falhaDeSessao), fetchImpl);

    await expect(c.oauthStart('conta-1')).rejects.toBe(falhaDeSessao);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------ */
/*                    etiqueta(pedidoId) — the label route                   */
/* ------------------------------------------------------------------------ */

/** The ERP pedido DOCUMENT id the route's strict body takes (64 hex). */
const PEDIDO_ID = 'ab'.repeat(32);
const NOME = 'amazon-111-2222222-3333333.zpl';

/** A ZPL label with a byte that is NOT valid UTF-8 (0xFF) and a two-byte `ç`. */
const ZPL = new Uint8Array([
  ...new TextEncoder().encode('^XA^FO50,50^FDCaixa '),
  0xff,
  0xc3,
  0xa7,
  ...new TextEncoder().encode('^FS^XZ\n'),
]);

const codificar = (texto: string) => new TextEncoder().encode(texto);

/**
 * A 200 with BYTES (a `Uint8Array` body: a string body would get a
 * `text/plain;charset=UTF-8` type by itself). `null` drops a header.
 */
function rotulo(
  corpo: Uint8Array<ArrayBuffer>,
  headers: { tipo?: string | null; disposicao?: string | null } = {},
  status = 200,
): Response {
  const h: Record<string, string> = {};
  const tipo = headers.tipo === undefined ? 'text/plain' : headers.tipo;
  const disposicao =
    headers.disposicao === undefined ? `attachment; filename="${NOME}"` : headers.disposicao;
  if (tipo !== null) h['content-type'] = tipo;
  if (disposicao !== null) h['content-disposition'] = disposicao;
  return new Response(corpo, { status, headers: h });
}

async function bytesDe(blob: Blob): Promise<number[]> {
  return [...new Uint8Array(await blob.arrayBuffer())];
}

describe('etiqueta(pedidoId) — the wire', () => {
  it('is a POST on …/etiqueta with the ID token, a JSON type and EXACTLY { pedidoId }', async () => {
    const { c, chamadas } = cliente(() => rotulo(ZPL));
    const controle = new AbortController();

    await c.etiqueta(PEDIDO_ID, { signal: controle.signal });

    expect(chamadas).toHaveLength(1);
    const [ch] = chamadas;
    expect(ch?.url).toBe(`${BASE}/api/marketplace/amazon/etiqueta`);
    expect(ch?.init.method).toBe('POST');
    expect(ch?.init.headers).toEqual({
      Authorization: 'Bearer id-token-firebase',
      'Content-Type': 'application/json',
    });
    // The route's body is strict: one more key (a format, say) is a 400.
    expect(ch?.init.body).toBe(JSON.stringify({ pedidoId: PEDIDO_ID }));
    expect(ch?.init.signal).toBe(controle.signal);
  });

  it('an ID-token failure is NOT relabelled a network error, and nothing is sent', async () => {
    const falhaDeSessao = new Error('auth/network-request-failed');
    const fetchImpl = vi.fn();
    const c = criarClienteAmazon(BASE, () => Promise.reject(falhaDeSessao), fetchImpl);

    await expect(c.etiqueta(PEDIDO_ID)).rejects.toBe(falhaDeSessao);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('etiqueta(pedidoId) — the 200 is the label, byte for byte', () => {
  it('returns the bytes untouched, the route’s file name and the type as received', async () => {
    const { c } = cliente(() => rotulo(ZPL));

    const etiqueta = await c.etiqueta(PEDIDO_ID);

    expect(await bytesDe(etiqueta.bytes)).toEqual([...ZPL]);
    expect(etiqueta.nomeArquivo).toBe(NOME);
    expect(etiqueta.tipo).toBe('text/plain');
  });

  it('⭐ a byte that is not valid UTF-8 survives (read with blob(), never text())', async () => {
    const { c } = cliente(() => rotulo(ZPL));

    const etiqueta = await c.etiqueta(PEDIDO_ID);

    const recebidos = await bytesDe(etiqueta.bytes);
    expect(recebidos).toContain(0xff);
    expect(recebidos).toEqual([...ZPL]);
    // NEAR-MISS: the same answer read through text() and re-encoded is NOT the
    // same bytes — 0xFF becomes U+FFFD (EF BF BD). Proof the sentinel can tell.
    const viaTexto = codificar(await rotulo(ZPL).text());
    expect([...viaTexto]).not.toEqual([...ZPL]);
  });

  it('a charset a proxy appended is accepted, and kept in `tipo` as received', async () => {
    const { c } = cliente(() => rotulo(ZPL, { tipo: 'text/plain;charset=UTF-8' }));

    const etiqueta = await c.etiqueta(PEDIDO_ID);

    expect(etiqueta.tipo).toBe('text/plain;charset=UTF-8');
    expect(await bytesDe(etiqueta.bytes)).toEqual([...ZPL]);
  });

  it('a ZPL with leading blank lines is still a label (only markup is refused)', async () => {
    const corpo = new Uint8Array([0x0d, 0x0a, 0x20, 0x09, ...ZPL]);
    const { c } = cliente(() => rotulo(corpo));

    expect(await bytesDe((await c.etiqueta(PEDIDO_ID)).bytes)).toEqual([...corpo]);
  });

  it.each([
    ['absent', null],
    ['present but naming no file', 'attachment'],
  ])(
    'with a Content-Disposition %s the name falls back to amazon-etiqueta.zpl',
    async (_caso, disposicao) => {
      const { c } = cliente(() => rotulo(ZPL, { disposicao }));

      const etiqueta = await c.etiqueta(PEDIDO_ID);

      expect(etiqueta.nomeArquivo).toBe(NOME_ETIQUETA_AMAZON_PADRAO);
      expect(NOME_ETIQUETA_AMAZON_PADRAO).toBe('amazon-etiqueta.zpl');
    },
  );
});

/** "Try again" in any spelling — a refused label is never a retry. */
const TENTE_DE_NOVO = /tente|novamente|de novo/i;

/** Every argument `console.error` got, as text (the spy is set in `beforeEach`). */
function argumentosDoConsole(): string[] {
  return vi
    .mocked(console.error)
    .mock.calls.flat()
    .map((arg) => String(arg));
}

/**
 * What every refused 200 must hold: the client's own sentence, which the
 * operator reads WORD FOR WORD (`mensagemErroEtiquetaAmazon` keeps it), names
 * the way out and never invites a retry; and no byte of a body that HAS one
 * (`trechoDoCorpo`, `null` for an empty or blank body) reaches the message or
 * a log line.
 */
function exigirRecusa(err: unknown, status: number, trechoDoCorpo: string | null): void {
  expect(err).toBeInstanceOf(AmazonRespostaInvalidaError);
  const recusa = err as InstanceType<typeof AmazonRespostaInvalidaError>;
  expect(recusa.status).toBe(status);
  expect(recusa.message).toContain('Seller Central');
  expect(recusa.message).not.toMatch(TENTE_DE_NOVO);
  if (trechoDoCorpo === null) return;
  expect(recusa.message).not.toContain(trechoDoCorpo);
  for (const arg of argumentosDoConsole()) expect(arg).not.toContain(trechoDoCorpo);
}

describe('etiqueta(pedidoId) — a 2xx that is not a label is refused, never printed', () => {
  it.each([
    ['text/html', 'an HTML page'],
    ['application/json', 'a JSON body'],
    ['application/octet-stream', 'opaque bytes'],
    ['text/plainx', 'a type that only LOOKS like plain text'],
    ['application/pdf', 'a PDF'],
  ])('a 200 typed %s (%s) is an AmazonRespostaInvalidaError', async (tipo) => {
    const { c } = cliente(() => rotulo(ZPL, { tipo }));

    exigirRecusa(await falhaDe(c.etiqueta(PEDIDO_ID)), 200, '^XA');
  });

  it('a 200 with NO Content-Type is refused', async () => {
    const { c } = cliente(() => rotulo(ZPL, { tipo: null }));

    exigirRecusa(await falhaDe(c.etiqueta(PEDIDO_ID)), 200, '^XA');
  });

  it.each([
    ['empty', new Uint8Array(), null],
    ['blank', codificar(' \r\n\t \n'), null],
    ['an HTML page served as text', codificar('\n  <!doctype html><html>Proxy</html>'), 'Proxy'],
    ['a JSON body served as text', codificar('{"error":"x","code":"y"}'), '"code"'],
  ])('a text/plain 200 that is %s is refused', async (_caso, corpo, trechoDoCorpo) => {
    const { c } = cliente(() => rotulo(corpo));

    // Nothing of the body reaches the message or a log: a label carries an address.
    exigirRecusa(await falhaDe(c.etiqueta(PEDIDO_ID)), 200, trechoDoCorpo);
  });

  it('a 2xx other than 200 is refused, with its real status', async () => {
    const { c } = cliente(() => rotulo(ZPL, {}, 202));

    exigirRecusa(await falhaDe(c.etiqueta(PEDIDO_ID)), 202, '^XA');
  });

  it('ehTipoEtiquetaAmazon — the essence, folded: equal pairs and near-misses', () => {
    expect(ehTipoEtiquetaAmazon('text/plain')).toBe(true);
    expect(ehTipoEtiquetaAmazon('TEXT/PLAIN; charset=utf-8')).toBe(true);
    expect(ehTipoEtiquetaAmazon(' text/plain ;x=y')).toBe(true);
    expect(ehTipoEtiquetaAmazon('text/plainx')).toBe(false);
    expect(ehTipoEtiquetaAmazon('text/plai')).toBe(false);
    expect(ehTipoEtiquetaAmazon('text/html')).toBe(false);
    expect(ehTipoEtiquetaAmazon('')).toBe(false);
    expect(ehTipoEtiquetaAmazon(null)).toBe(false);
  });
});

describe('etiqueta(pedidoId) — the error envelope carries the motivo', () => {
  it('⭐ a 409 NAO_ELEGIVEL + nfe-ambigua through the REAL client shows the motivo’s sentence', async () => {
    const { c } = cliente(() =>
      json(409, {
        error: 'A etiqueta deste pedido não pode ser impressa agora.',
        code: CODIGO_ERRO_ETIQUETA_AMAZON.NAO_ELEGIVEL,
        motivo: MOTIVO_ETIQUETA_AMAZON.nfeAmbigua,
      }),
    );

    const err = (await falhaDe(c.etiqueta(PEDIDO_ID))) as InstanceType<typeof AmazonBackendError>;

    expect(err).toBeInstanceOf(AmazonBackendError);
    expect(err.status).toBe(409);
    expect(err.codigo).toBe(CODIGO_ERRO_ETIQUETA_AMAZON.NAO_ELEGIVEL);
    expect(err.motivo).toBe(MOTIVO_ETIQUETA_AMAZON.nfeAmbigua);
    expect(mensagemErroEtiquetaAmazon(err)).toBe(
      MENSAGENS_MOTIVO_ETIQUETA_AMAZON[MOTIVO_ETIQUETA_AMAZON.nfeAmbigua],
    );
  });

  it('NEAR-MISS: the same 409 WITHOUT a motivo gives the code’s generic sentence', async () => {
    const { c } = cliente(() =>
      json(409, {
        error: 'A etiqueta deste pedido não pode ser impressa agora.',
        code: CODIGO_ERRO_ETIQUETA_AMAZON.NAO_ELEGIVEL,
      }),
    );

    const err = (await falhaDe(c.etiqueta(PEDIDO_ID))) as InstanceType<typeof AmazonBackendError>;

    expect(err.motivo).toBeNull();
    expect(mensagemErroEtiquetaAmazon(err)).toBe(
      MENSAGENS_CODIGO_ERRO_ETIQUETA_AMAZON[CODIGO_ERRO_ETIQUETA_AMAZON.NAO_ELEGIVEL],
    );
  });

  it('a motivo slug a newer backend added still parses, and reads as the neutral sentence', async () => {
    const { c } = cliente(() =>
      json(409, {
        error: 'Recusado.',
        code: CODIGO_ERRO_ETIQUETA_AMAZON.RECUSADA,
        motivo: 'motivo-de-um-backend-novo',
      }),
    );

    const err = (await falhaDe(c.etiqueta(PEDIDO_ID))) as InstanceType<typeof AmazonBackendError>;

    expect(err.codigo).toBe(CODIGO_ERRO_ETIQUETA_AMAZON.RECUSADA);
    expect(err.motivo).toBe('motivo-de-um-backend-novo');
    expect(mensagemErroEtiquetaAmazon(err)).toBe(MENSAGEM_MOTIVO_ETIQUETA_AMAZON_DESCONHECIDO);
  });

  it('NEAR-MISS: a conta route’s envelope never carries a motivo (its schema strips it)', async () => {
    const { c } = cliente(() =>
      json(409, {
        error: 'Algo.',
        code: CODIGO_ERRO_AMAZON.CONTA_NAO_ENCONTRADA,
        motivo: MOTIVO_ETIQUETA_AMAZON.nfeAmbigua,
      }),
    );

    const err = (await falhaDe(c.conta('conta-1'))) as InstanceType<typeof AmazonBackendError>;

    expect(err.codigo).toBe(CODIGO_ERRO_AMAZON.CONTA_NAO_ENCONTRADA);
    expect(err.motivo).toBeNull();
  });

  it('a numeric motivo is not the envelope: no code, the label call’s status copy', async () => {
    const { c } = cliente(() =>
      json(409, { error: 'x', code: CODIGO_ERRO_ETIQUETA_AMAZON.NAO_ELEGIVEL, motivo: 5 }),
    );

    const err = (await falhaDe(c.etiqueta(PEDIDO_ID))) as InstanceType<typeof AmazonBackendError>;

    expect(err.codigo).toBeNull();
    expect(err.motivo).toBeNull();
    // The label call's OWN status sentence, never the conta routes' one.
    expect(err.message).toBe(mensagemHttpEtiquetaAmazon(409));
    expect(err.message).not.toBe(mensagemHttpAmazon(409));
    expect(mensagemErroEtiquetaAmazon(err)).toBe(mensagemHttpEtiquetaAmazon(409));
  });

  it('⚠️ a codeless proxy 504 is the WAIT sentence, never the conta routes’ "Tente novamente"', async () => {
    const { c } = cliente(() => html(504));

    const err = (await falhaDe(c.etiqueta(PEDIDO_ID))) as InstanceType<typeof AmazonBackendError>;

    expect(err).toBeInstanceOf(AmazonBackendError);
    expect(err.codigo).toBeNull();
    expect(err.status).toBe(504);
    expect(err.message).toBe(MENSAGEM_ETIQUETA_AMAZON_AGUARDE);
    expect(err.message).not.toContain('Proxy error');
    expect(mensagemErroEtiquetaAmazon(err)).toBe(MENSAGEM_ETIQUETA_AMAZON_AGUARDE);
    // The page itself (an error page, never a label) goes to the console, with
    // the route and the status, so someone can see what answered.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('/api/marketplace/amazon/etiqueta (HTTP 504)'),
      expect.stringContaining('Proxy error'),
    );
  });

  it('a 400 CORPO_INVALIDO keeps its `issues` as field paths, and no motivo', async () => {
    const { c } = cliente(() =>
      json(400, {
        error: 'Corpo inválido.',
        code: CODIGO_ERRO_ETIQUETA_AMAZON.CORPO_INVALIDO,
        issues: ['pedidoId'],
      }),
    );

    const err = (await falhaDe(c.etiqueta(PEDIDO_ID))) as InstanceType<typeof AmazonBackendError>;

    expect(err.codigo).toBe(CODIGO_ERRO_ETIQUETA_AMAZON.CORPO_INVALIDO);
    expect(err.campos).toEqual(['pedidoId']);
    expect(err.motivo).toBeNull();
  });

  it("a code this build does not know shows the backend's own sentence, through the REAL client", async () => {
    const frase = 'Uma recusa que um backend mais novo descreve.';
    const { c } = cliente(() => json(409, { error: frase, code: 'AMAZON_ETIQUETA_NOVO' }));

    const err = (await falhaDe(c.etiqueta(PEDIDO_ID))) as InstanceType<typeof AmazonBackendError>;

    expect(err.codigo).toBe('AMAZON_ETIQUETA_NOVO');
    expect(err.message).toBe(frase);
    expect(mensagemErroEtiquetaAmazon(err)).toBe(frase);
  });

  it("verifyCaller's CODELESS 403 names the frete permission, never the integrações one", async () => {
    const { c } = cliente(() => json(403, { error: 'Sem permissão para esta operação.' }));

    const err = (await falhaDe(c.etiqueta(PEDIDO_ID))) as InstanceType<typeof AmazonBackendError>;

    expect(err.codigo).toBeNull();
    expect(err.status).toBe(403);
    expect(err.message).toBe(mensagemHttpEtiquetaAmazon(403));
    expect(mensagemErroEtiquetaAmazon(err)).toContain('permissão de frete');
    expect(mensagemErroEtiquetaAmazon(err)).not.toContain('integrações');
  });
});

describe('etiqueta(pedidoId) — transport failures and aborts', () => {
  it('a rejected fetch is an AmazonRedeError, the cause kept', async () => {
    const causa = new TypeError('Failed to fetch');
    const { c } = cliente(() => Promise.reject(causa));

    const err = (await falhaDe(c.etiqueta(PEDIDO_ID))) as InstanceType<typeof AmazonRedeError>;

    expect(err).toBeInstanceOf(AmazonRedeError);
    expect(err.cause).toBe(causa);
  });

  it('a label body that drops MID-READ is an AmazonRedeError, never a bare TypeError', async () => {
    const quebrado = rotulo(ZPL);
    vi.spyOn(quebrado, 'blob').mockRejectedValue(new TypeError('terminated'));
    const { c } = cliente(() => quebrado);

    await expect(c.etiqueta(PEDIDO_ID)).rejects.toBeInstanceOf(AmazonRedeError);
  });

  it('an error body that drops MID-READ is an AmazonRedeError too', async () => {
    const quebrado = json(503, { error: 'x', code: 'y' });
    vi.spyOn(quebrado, 'text').mockRejectedValue(new TypeError('terminated'));
    const { c } = cliente(() => quebrado);

    await expect(c.etiqueta(PEDIDO_ID)).rejects.toBeInstanceOf(AmazonRedeError);
  });

  it('⭐ an abort IN FLIGHT rejects with the abort itself, never an AmazonRedeError', async () => {
    const controle = new AbortController();
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason);
          });
        }),
    );
    const c = criarClienteAmazon(BASE, async () => 'id-token-firebase', fetchImpl);

    const p = falhaDe(c.etiqueta(PEDIDO_ID, { signal: controle.signal }));
    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    controle.abort();
    const err = await p;

    expect(err).toBe(controle.signal.reason);
    expect((err as Error).name).toBe('AbortError');
    expect(err).not.toBeInstanceOf(AmazonRedeError);
  });

  it('⭐ an abort DURING the body read rejects with the abort itself', async () => {
    const controle = new AbortController();
    const resposta = rotulo(ZPL);
    vi.spyOn(resposta, 'blob').mockImplementation(() => {
      controle.abort();
      return Promise.reject(controle.signal.reason);
    });
    const { c } = cliente(() => resposta);

    const err = await falhaDe(c.etiqueta(PEDIDO_ID, { signal: controle.signal }));

    expect(err).toBe(controle.signal.reason);
    expect(err).not.toBeInstanceOf(AmazonRedeError);
  });

  it('⭐ a TypeError mid-read AFTER the caller aborted is rethrown as itself, never relabelled', async () => {
    // A runtime may surface the abort as the connection's own failure; the
    // caller owns that outcome and tells it apart by its signal.
    const controle = new AbortController();
    const rasgado = new TypeError('terminated');
    const resposta = rotulo(ZPL);
    vi.spyOn(resposta, 'blob').mockImplementation(() => {
      controle.abort();
      return Promise.reject(rasgado);
    });
    const { c } = cliente(() => resposta);

    const err = await falhaDe(c.etiqueta(PEDIDO_ID, { signal: controle.signal }));

    expect(err).toBe(rasgado);
    expect(err).not.toBeInstanceOf(AmazonRedeError);
  });

  it('⭐ its ERROR-body twin: a TypeError mid-read of a non-2xx AFTER the caller aborted is rethrown as itself', async () => {
    const controle = new AbortController();
    const rasgado = new TypeError('terminated');
    const resposta = json(503, { error: 'x', code: 'y' });
    vi.spyOn(resposta, 'text').mockImplementation(() => {
      controle.abort();
      return Promise.reject(rasgado);
    });
    const { c } = cliente(() => resposta);

    const err = await falhaDe(c.etiqueta(PEDIDO_ID, { signal: controle.signal }));

    expect(err).toBe(rasgado);
    expect(err).not.toBeInstanceOf(AmazonRedeError);
  });

  it('NEAR-MISS: the same mid-read rejection as a TypeError with NO abort is a network error', async () => {
    const controle = new AbortController();
    const resposta = rotulo(ZPL);
    vi.spyOn(resposta, 'blob').mockRejectedValue(new TypeError('terminated'));
    const { c } = cliente(() => resposta);

    await expect(c.etiqueta(PEDIDO_ID, { signal: controle.signal })).rejects.toBeInstanceOf(
      AmazonRedeError,
    );
  });
});

describe('resolverBackendAmazon — fail closed from an https page', () => {
  it('⭐ refuses an http: backend from an https: page', () => {
    expect(resolverBackendAmazon('https:', 'http://amazon.backend.test')).toEqual({
      ok: false,
      motivo: 'inseguro',
    });
  });

  it('⭐ refuses the localhost FALLBACK from an https: page (a build missing the variable)', () => {
    expect(resolverBackendAmazon('https:', undefined)).toEqual({ ok: false, motivo: 'inseguro' });
    expect(resolverBackendAmazon('https:', '   ')).toEqual({ ok: false, motivo: 'inseguro' });
  });

  it('the near miss: an https: page with an https: backend is allowed', () => {
    expect(resolverBackendAmazon('https:', 'https://amazon.backend.test')).toEqual({
      ok: true,
      baseUrl: 'https://amazon.backend.test',
    });
  });

  it('an http: page may use the http: fallback (local dev, the CI e2e build)', () => {
    expect(resolverBackendAmazon('http:', undefined)).toEqual({
      ok: true,
      baseUrl: DEFAULT_AMAZON_URL,
    });
    expect(DEFAULT_AMAZON_URL).toBe('http://localhost:3011');
  });

  it.each(['não é url', 'ftp://amazon.backend.test', 'javascript:alert(1)'])(
    'refuses %j as url-invalida, from either page protocol',
    (valor) => {
      expect(resolverBackendAmazon('http:', valor)).toEqual({ ok: false, motivo: 'url-invalida' });
      expect(resolverBackendAmazon('https:', valor)).toEqual({
        ok: false,
        motivo: 'url-invalida',
      });
    },
  );
});

describe('useAmazonClient — the hook applies the rule to the real page', () => {
  const jsdom = (globalThis as unknown as { jsdom: { reconfigure(o: { url: string }): void } })
    .jsdom;
  const URL_ORIGINAL = window.location.href;

  beforeEach(() => {
    h.user = { getIdToken: async () => 'id-token-firebase' };
  });

  afterEach(() => {
    jsdom.reconfigure({ url: URL_ORIGINAL });
    vi.unstubAllEnvs();
    h.user = null;
  });

  it('⭐ returns null on an https: page with an http: base URL, and says why', () => {
    jsdom.reconfigure({ url: 'https://erp.test/canais/amazon/c1' });
    vi.stubEnv('NEXT_PUBLIC_AMAZON_URL', 'http://amazon.backend.test');

    expect(renderHook(() => useAmazonClient()).result.current).toBeNull();
    expect(renderHook(() => useBackendAmazon()).result.current.indisponivel).toBe('inseguro');
  });

  it('the near miss: returns a client on an http: page with the same base URL', () => {
    jsdom.reconfigure({ url: 'http://localhost:3000/canais/amazon/c1' });
    vi.stubEnv('NEXT_PUBLIC_AMAZON_URL', 'http://amazon.backend.test');

    const { result } = renderHook(() => useBackendAmazon());

    expect(result.current.client).not.toBeNull();
    expect(result.current.indisponivel).toBeNull();
  });

  it('returns null with NO reason while logged out — still signing in, not misconfiguration', () => {
    h.user = null;
    jsdom.reconfigure({ url: 'https://erp.test/' });
    vi.stubEnv('NEXT_PUBLIC_AMAZON_URL', 'http://amazon.backend.test');

    expect(renderHook(() => useBackendAmazon()).result.current).toEqual({
      client: null,
      indisponivel: null,
    });
  });
});
