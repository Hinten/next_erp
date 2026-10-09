/**
 * Helpers for the ROUTE suites under `app/api/marketplace/loja-integrada/`,
 * **for tests only** — the same rule as `fakeDb.ts`: nothing outside a
 * `*.test.ts` imports this.
 *
 * The route suites mock exactly two seams — `@/lib/firebase/admin` (the Admin
 * singleton: `verifyIdToken` and the Firestore handle, which becomes a
 * {@link FakeDb}) and `firebase-admin/firestore`'s `FieldValue.increment` (so
 * the aviso counter is the fake's sentinel) — and stub the global `fetch`, so
 * the REAL `validarPersonalToken` runs and maps the stubbed answer. Everything
 * between the request and the fake is real code.
 */
import { vi } from 'vitest';
import { PERM } from '@delfrance/auth';

/** Where the conta routes live (the host is irrelevant; the path is not). */
export const URL_CONTAS = 'http://localhost:3010/api/marketplace/loja-integrada/conta';

/** A caller that may read and write integrações. */
export const ESCRITOR = {
  uid: 'u-escritor',
  permissions: (PERM.integracao.read | PERM.integracao.write).toString(),
};
/** A caller that may only read them. */
export const LEITOR = { uid: 'u-leitor', permissions: PERM.integracao.read.toString() };
/** A caller with no integração permission at all. */
export const ESTRANHO = { uid: 'u-estranho', permissions: '0' };

export interface OpcoesRequisicao {
  /** Serialized with `JSON.stringify`. */
  readonly corpo?: unknown;
  /** Sent verbatim — for a body that is NOT valid JSON. */
  readonly corpoBruto?: string;
  readonly sinal?: AbortSignal;
  /** Omit the `Authorization` header. */
  readonly semAuth?: boolean;
}

/** A request to `<URL_CONTAS>/<sufixo>`. */
export function requisicao(metodo: string, sufixo: string, opts: OpcoesRequisicao = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.semAuth !== true) headers.authorization = 'Bearer id-token-de-teste';
  let body: string | undefined;
  if (opts.corpoBruto !== undefined) body = opts.corpoBruto;
  else if (opts.corpo !== undefined) body = JSON.stringify(opts.corpo);
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`${URL_CONTAS}/${sufixo}`, {
    method: metodo,
    headers,
    body,
    signal: opts.sinal,
  });
}

/** The route's second argument: Next hands `params` over as a promise. */
export function contexto(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

/** A valid Tastypie envelope — what the validating GET reads as `aceito`. */
export const ENVELOPE_VAZIO = {
  meta: { limit: 1, next: null, offset: 0, previous: null, total_count: 0 },
  objects: [],
};

/** A JSON `Response` as Loja Integrada would send it. */
export function respostaJson(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** One call the stubbed `fetch` received. */
export interface ChamadaFetch {
  readonly url: string;
  readonly authorization: string | null;
  readonly correlationId: string | null;
}

/**
 * Stub the global `fetch` with `responder` and record every call. The package
 * resolves `globalThis.fetch` at call time, so the stub is what it uses.
 */
export function stubFetch(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
): ChamadaFetch[] {
  const chamadas: ChamadaFetch[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init.headers);
      chamadas.push({
        url,
        authorization: headers.get('authorization'),
        correlationId: headers.get('x-correlation-id'),
      });
      return Promise.resolve(responder(url, init));
    }),
  );
  return chamadas;
}

/**
 * Spy on every console method, silencing them, and expose every argument they
 * were called with — what a hygiene assertion searches for a token.
 */
export function espiarConsole(): { argumentos: () => unknown[][]; restaurar: () => void } {
  const metodos = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const espioes = metodos.map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  return {
    argumentos: () => espioes.flatMap((e) => e.mock.calls as unknown[][]),
    restaurar: () => {
      for (const e of espioes) e.mockRestore();
    },
  };
}

/**
 * Everything a value could show a reader, as one string: an `Error` by name,
 * message, stack and `cause`, anything else through `JSON.stringify` (with
 * `String` as the fallback for what it cannot serialize).
 */
export function textoDe(valor: unknown): string {
  if (valor instanceof Error) {
    return [valor.name, valor.message, valor.stack ?? '', textoDe(valor.cause)].join(' ');
  }
  if (typeof valor === 'string') return valor;
  try {
    return JSON.stringify(valor) ?? String(valor);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    return String(valor);
  }
}
