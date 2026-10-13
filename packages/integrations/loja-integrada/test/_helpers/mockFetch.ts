import { vi } from 'vitest';

export type FetchArgs = Parameters<typeof globalThis.fetch>;

/**
 * A synthetic Personal Token: 40 characters of visible ASCII, shaped like
 * nothing real. It must not occur by accident inside any fixture body, or the
 * scrub assertions would prove nothing.
 */
export const TOKEN = 'tok-TESTE-0000-sintetico-1111-naoreal-22';

/** A second synthetic token, for the credential-getter tests. */
export const TOKEN_2 = 'tok-TESTE-3333-sintetico-4444-naoreal-55';

/**
 * A `fetch` mock whose `.mock.calls` are typed as `[input, init?]` (the real
 * fetch params), so tests can assert on the URL and the `RequestInit`. The
 * factory runs per call, so each call gets a fresh `Response` (bodies are
 * single-read). Precedent: `freight-br/test/_helpers/mockFetch.ts`.
 */
export function mockFetch(factory: (...args: FetchArgs) => Response | Promise<Response>) {
  return vi.fn(async (...args: FetchArgs) => {
    registrar(args);
    return factory(...args);
  });
}

/**
 * Every request any mock in this file's suite saw, so one `afterEach` can assert
 * the package's structural promise over ALL of them: a `GET` with no body.
 */
const vistas: RequestInit[] = [];

function registrar([, init]: FetchArgs): void {
  vistas.push(init ?? {});
}

/**
 * `afterEach(verificarSoGet)`: every request the test made was a `GET` with no
 * body. Clears the record for the next test.
 */
export function verificarSoGet(): void {
  const fora = vistas.filter((init) => init.method !== 'GET' || init.body != null);
  const total = vistas.length;
  vistas.length = 0;
  if (fora.length > 0) {
    throw new Error(
      `${String(fora.length)} de ${String(total)} requisição(ões) não foram GET sem corpo.`,
    );
  }
}

/** A JSON response. */
export function json(corpo: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A text (or empty) response. */
export function texto(
  corpo: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(corpo === '' ? null : corpo, { status, headers });
}

/**
 * A server that accepts the connection and never answers. Rejects the way real
 * `fetch` does when its signal aborts: with the signal's reason, as-is.
 */
export function fetchQueNuncaResponde() {
  return vi.fn(
    (...args: FetchArgs) =>
      new Promise<Response>((_resolve, reject) => {
        registrar(args);
        const signal = args[1]?.signal;
        if (signal?.aborted === true) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
}

/**
 * 200 headers, then a stall mid-body. A user-built `Response` body is NOT
 * cancelled by the request signal, so the stub wires the abort into the stream —
 * which is what a real network body does.
 */
export function fetchQueTravaNoCorpo() {
  return vi.fn(async (...args: FetchArgs) => {
    registrar(args);
    const signal = args[1]?.signal;
    const corpo = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    });
    return new Response(corpo, { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

/** The request a mock saw, normalised for assertions. */
export function requisicao(
  mock: { mock: { calls: FetchArgs[] } },
  i = 0,
): { url: URL; init: RequestInit; headers: Headers } {
  const chamada = mock.mock.calls[i];
  if (chamada === undefined) throw new Error(`fetch não foi chamado ${String(i + 1)} vez(es)`);
  const [input, init] = chamada;
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return { url: new URL(href), init: init ?? {}, headers: new Headers(init?.headers) };
}

/** Start `promise` and record when it settles, without awaiting it. */
export function observar(promise: Promise<unknown>) {
  const estado: { settled: boolean; valor?: unknown } = { settled: false };
  const pronto = promise.then(
    (v) => {
      estado.settled = true;
      estado.valor = v;
    },
    (e: unknown) => {
      estado.settled = true;
      estado.valor = e;
    },
  );
  return { estado, pronto };
}

/** Every `message` along an error's `cause` chain. */
export function mensagensDaCadeia(err: unknown): string[] {
  const out: string[] = [];
  let atual: unknown = err;
  for (let i = 0; i < 10 && atual instanceof Error; i++) {
    out.push(atual.message);
    atual = atual.cause;
  }
  return out;
}
