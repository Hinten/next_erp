import { vi } from 'vitest';

import { URL_BASE_SP_API } from '../../src/client';
import { URL_TOKEN_LWA } from '../../src/lwa';

export type FetchArgs = Parameters<typeof globalThis.fetch>;

/*
 * Synthetic secrets, shaped like nothing real: no Amazon prefix (`Atza|`,
 * `Atzr|`, `amzn1.`), so neither a reader nor a secret scanner mistakes them
 * for a credential. Each contains a `|`, which the form encoding turns into
 * `%7C` — a raw-text search of the form body for the secret would miss it, and
 * the tests decode the body before comparing.
 *
 * ⚠️ None may occur by accident inside an SP-API or error fixture body, or the
 * scrub assertions would prove nothing — `types.test.ts` checks it. Only the
 * LWA 200 fixtures carry them, on purpose: a token pair IS that response.
 */
export const ACCESS_TOKEN = 'tok|TESTE-acesso-0000-sintetico-naoreal-11';
export const ACCESS_TOKEN_2 = 'tok|TESTE-acesso-5555-sintetico-naoreal-66';
export const REFRESH_TOKEN = 'tok|TESTE-refresh-2222-sintetico-naoreal-33';
export const CODIGO_AUTORIZACAO = 'cod|TESTE-codigo-7777-sintetico-naoreal-88';
export const CLIENT_ID = 'cli-TESTE-sintetico-0000';
export const CLIENT_SECRET = 'sec-TESTE-sintetico-4444-naoreal';
export const USER_AGENT = 'TesteSintetico/0.0 (Language=TypeScript)';

/** Every synthetic secret, for the "nowhere on the error" sweeps. */
export const SEGREDOS = [ACCESS_TOKEN, REFRESH_TOKEN, CODIGO_AUTORIZACAO, CLIENT_SECRET] as const;

/**
 * A `fetch` mock whose `.mock.calls` are typed as `[input, init?]` (the real
 * fetch params), so tests can assert on the URL and the `RequestInit`. The
 * factory runs per call, so each call gets a fresh `Response` (bodies are
 * single-read). Precedent: `loja-integrada/test/_helpers/mockFetch.ts`.
 */
export function mockFetch(factory: (...args: FetchArgs) => Response | Promise<Response>) {
  return vi.fn(async (...args: FetchArgs) => {
    registrar(args);
    return factory(...args);
  });
}

/**
 * Every request any mock in this file's suite saw, so one `afterEach` can assert
 * the package's structural promise over ALL of them.
 */
const vistas: FetchArgs[] = [];

function registrar(args: FetchArgs): void {
  vistas.push(args);
}

function hrefDe(input: FetchArgs[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/**
 * `afterEach(verificarFormaDasRequisicoes)`: every request the test made was
 * EITHER a `GET` with no body to the SP-API host, OR a `POST` with a string
 * (form) body to exactly the LWA token endpoint. Anything else — another host,
 * another method, a GET with a body — fails. Clears the record for the next
 * test.
 */
export function verificarFormaDasRequisicoes(): void {
  const fora = vistas.filter(([input, init]) => {
    const url = new URL(hrefDe(input));
    const metodo = init?.method;
    const leituraSpApi = metodo === 'GET' && init?.body == null && url.origin === URL_BASE_SP_API;
    const trocaLwa =
      metodo === 'POST' &&
      typeof init?.body === 'string' &&
      `${url.origin}${url.pathname}` === URL_TOKEN_LWA &&
      url.search === '';
    return !leituraSpApi && !trocaLwa;
  });
  const total = vistas.length;
  vistas.length = 0;
  if (fora.length > 0) {
    throw new Error(
      `${String(fora.length)} de ${String(total)} requisição(ões) não foram nem GET sem corpo à SP-API nem POST de formulário ao LWA.`,
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
export function fetchQueTravaNoCorpo(headers: Record<string, string> = {}) {
  return vi.fn(async (...args: FetchArgs) => {
    registrar(args);
    const signal = args[1]?.signal;
    const corpo = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    });
    return new Response(corpo, {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    });
  });
}

/** The request a mock saw, normalised for assertions. */
export function requisicao(
  mock: { mock: { calls: FetchArgs[] } },
  i = 0,
): { url: URL; init: RequestInit; headers: Headers; formulario: URLSearchParams } {
  const chamada = mock.mock.calls[i];
  if (chamada === undefined) throw new Error(`fetch não foi chamado ${String(i + 1)} vez(es)`);
  const [input, init] = chamada;
  const body = init?.body;
  return {
    url: new URL(hrefDe(input)),
    init: init ?? {},
    headers: new Headers(init?.headers),
    formulario: new URLSearchParams(typeof body === 'string' ? body : ''),
  };
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

/** Resolve to the rejection of `p`; fail if it fulfils. */
export async function falha(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('esperava uma rejeição');
    },
    (e: unknown) => e,
  );
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

/**
 * Every place an error could carry text: its message, its own enumerable
 * properties (`JSON.stringify`), and every message along its `cause` chain.
 */
export function textosDoErro(err: unknown): string[] {
  return [JSON.stringify(err), ...mensagensDaCadeia(err)];
}
