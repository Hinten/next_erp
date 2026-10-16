/**
 * Shared fixtures for the `lib/amazon` and route suites, **for tests only** —
 * the same rule as `fakeDb.ts`: nothing outside a `*.test.ts` imports this.
 *
 * ⚠️ PLACEHOLDERS ONLY (the repository is public). The seller ids are the
 * models' own sandbox placeholder shape (`AXXXXXXXXXXXXX`), the application id
 * is the all-zero `amzn1.sp.solution.…`, and every token, code and secret is a
 * synthetic `tok|TESTE-…` / `cod|…` / `sec-…` value with no Amazon token prefix
 * (the package's convention), so neither a reader nor a secret scanner mistakes
 * one for a credential. A suite asserting hygiene searches responses, errors,
 * log arguments and redirect URLs for these strings.
 *
 * D11: nothing here reaches Amazon. {@link espiaoDeFetch} is the only `fetch`
 * a suite hands over, and it answers from a script.
 */
import { vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import { fingerprintDoRefreshToken, montarRef } from '../core/refCredencial';
import type { LoggerAmazon } from '../core/valvulas';
import type { AmbienteAmazon } from '../env';
import type { DocData, FakeDb } from './fakeDb';

/** The models' sandbox placeholder seller id, and a second one. */
export const SPID_A = 'AXXXXXXXXXXXXX';
export const SPID_B = 'AYYYYYYYYYYYYY';
/** The all-zero application id placeholder. */
export const APPLICATION_ID = 'amzn1.sp.solution.00000000-0000-0000-0000-000000000000';
export const CLIENT_ID = 'cli-TESTE-sintetico-0000';
export const CLIENT_SECRET = 'sec-TESTE-sintetico-naoreal-07';
export const STATE_SECRET = 'sec-TESTE-state-sintetico-naoreal-08';
export const REDIRECT_URI = 'https://amazon.erp.example/api/oauth/amazon/callback';
export const WEB_APP_URL = 'https://app.erp.example';
export const REFRESH_TOKEN_A = 'tok|TESTE-refresh-AAAA-sintetico-naoreal-01';
export const REFRESH_TOKEN_B = 'tok|TESTE-refresh-BBBB-sintetico-naoreal-02';
export const ACCESS_TOKEN_A = 'tok|TESTE-acesso-AAAA-sintetico-naoreal-03';
export const ACCESS_TOKEN_B = 'tok|TESTE-acesso-BBBB-sintetico-naoreal-04';
export const ACCESS_TOKEN_NOVO = 'tok|TESTE-acesso-NOVO-sintetico-naoreal-05';
export const CODIGO = 'cod|TESTE-codigo-sintetico-naoreal-06';

/** 2027-01-15T15:00:00Z — noon in São Paulo. */
export const AGORA_MS = Date.UTC(2027, 0, 15, 15, 0, 0);
export const DIA_MS = 24 * 60 * 60 * 1000;
export const HORA_MS = 60 * 60 * 1000;

/** Every connect-flow key set, and the read switch ON. */
export const AMBIENTE_LIGADO: AmbienteAmazon = Object.freeze({
  AMAZON_LWA_CLIENT_ID: CLIENT_ID,
  AMAZON_LWA_CLIENT_SECRET: CLIENT_SECRET,
  AMAZON_APPLICATION_ID: APPLICATION_ID,
  AMAZON_OAUTH_REDIRECT_URI: REDIRECT_URI,
  AMAZON_OAUTH_STATE_SECRET: STATE_SECRET,
  WEB_APP_URL,
  AMAZON_CHAMADAS: 'on',
});

/** The same, with the read switch unset — the state of every environment before W5. */
export const AMBIENTE_DESLIGADO: AmbienteAmazon = Object.freeze({
  ...AMBIENTE_LIGADO,
  AMAZON_CHAMADAS: undefined,
});

export function caminhoConta(integracaoId: string): string {
  return `integracao/${integracaoId}`;
}

export function caminhoCredencial(integracaoId: string): string {
  return `integracao/${integracaoId}/credenciais/current`;
}

export function caminhoAviso(chave: string): string {
  return `avisos/${chave}`;
}

/** An Amazon conta document, as the browser writes one. */
export function seedConta(
  db: FakeDb,
  integracaoId: string,
  over: Partial<{
    nome: string;
    ativo: boolean;
    tipo: number;
    selling_partner_id: string | null;
  }> = {},
) {
  return db.seed(caminhoConta(integracaoId), {
    tipo: INTEGRACAO_TIPO.amazon,
    nome: `Conta ${integracaoId}`,
    ativo: true,
    padrao: false,
    selling_partner_id: null,
    ...over,
  });
}

/** The ref a credential with this grant has. */
export function refDe(refreshToken: string, autorizadoEmMs: number): string {
  return montarRef(fingerprintDoRefreshToken(refreshToken), autorizadoEmMs);
}

/** When the default credential was authorized: ten days before {@link AGORA_MS}. */
export const AUTORIZADO_EM_MS = AGORA_MS - 10 * DIA_MS;

/** A complete, valid credential: a fresh access token minted from its own grant. */
export function credencialDoc(over: Partial<DocData> = {}): DocData {
  const refresh = typeof over.refresh_token === 'string' ? over.refresh_token : REFRESH_TOKEN_A;
  const autorizadoEmMs =
    typeof over.autorizadoEmMs === 'number' ? over.autorizadoEmMs : AUTORIZADO_EM_MS;
  return {
    access_token: ACCESS_TOKEN_A,
    refresh_token: refresh,
    expirationDate: AGORA_MS + 30 * 60 * 1000,
    autorizadoEmMs,
    acessoRef: refDe(refresh, autorizadoEmMs),
    reconexaoPendente: null,
    ...over,
  };
}

export function seedCredencial(db: FakeDb, integracaoId: string, over: Partial<DocData> = {}) {
  return db.seed(caminhoCredencial(integracaoId), credencialDoc(over));
}

/* -------------------------------------------------------------------------- */
/*                                The fetch spy                               */
/* -------------------------------------------------------------------------- */

/** One call the spy received. */
export interface ChamadaFetch {
  readonly url: string;
  readonly metodo: string;
  readonly cabecalhos: Headers;
  /** The form body, parsed — the LWA POST's fields. Empty for a GET. */
  readonly formulario: URLSearchParams;
  /** The request's abort signal — the package's deadline. */
  readonly sinal: AbortSignal | undefined;
}

/**
 * A `fetch` that records every call and answers through `responder`. Hand it
 * over as `deps.fetch`; nothing else reaches a network.
 */
export function espiaoDeFetch(
  responder: (c: ChamadaFetch) => Response | Promise<Response> = () => {
    throw new Error('o espião de fetch não esperava nenhuma chamada');
  },
): { fetch: typeof globalThis.fetch; chamadas: ChamadaFetch[] } {
  const chamadas: ChamadaFetch[] = [];
  const fetch = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const chamada: ChamadaFetch = {
      url,
      metodo: init.method ?? 'GET',
      cabecalhos: new Headers(init.headers),
      formulario: new URLSearchParams(typeof init.body === 'string' ? init.body : ''),
      sinal: init.signal ?? undefined,
    };
    chamadas.push(chamada);
    return Promise.resolve().then(() => responder(chamada));
  };
  return { fetch: fetch as typeof globalThis.fetch, chamadas };
}

/** A JSON `Response`. */
export function respostaJson(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** LWA's 200 for a refresh exchange. */
export function tokenDeAcesso(accessToken = ACCESS_TOKEN_NOVO, expiresIn = 3600): Response {
  return respostaJson(200, {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: expiresIn,
  });
}

/** LWA's 200 for a code exchange. */
export function tokensDeAutorizacao(
  refreshToken = REFRESH_TOKEN_B,
  accessToken = ACCESS_TOKEN_B,
  expiresIn = 3600,
): Response {
  return respostaJson(200, {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'bearer',
    expires_in: expiresIn,
  });
}

/**
 * A `fetch` answer that never comes: it settles only when the request's own
 * deadline aborts it — the package's `AmazonTimeoutError` path, driven by fake
 * timers.
 */
export function nuncaResponde(c: ChamadaFetch): Promise<Response> {
  return new Promise((_resolve, reject) => {
    c.sinal?.addEventListener('abort', () => {
      reject(c.sinal?.reason);
    });
  });
}

/** An LWA error answer. */
export function erroLwa(status: number, error: string): Response {
  return respostaJson(status, { error, error_description: 'descrição-sentinela' });
}

/* -------------------------------------------------------------------------- */
/*                                The logger spy                              */
/* -------------------------------------------------------------------------- */

export interface LinhaDeLog {
  readonly nivel: 'info' | 'warn' | 'error';
  readonly mensagem: string;
  readonly meta: Record<string, unknown> | undefined;
}

/** A {@link LoggerAmazon} that keeps every line, in order. */
export function loggerEspiao(): { logger: LoggerAmazon; linhas: LinhaDeLog[] } {
  const linhas: LinhaDeLog[] = [];
  const gravar =
    (nivel: LinhaDeLog['nivel']) =>
    (mensagem: string, meta?: Record<string, unknown>): void => {
      linhas.push({ nivel, mensagem, meta });
    };
  return { logger: { info: gravar('info'), warn: gravar('warn'), error: gravar('error') }, linhas };
}

/**
 * Everything a value could show a reader, as one string: an `Error` by name,
 * message, stack and `cause`, anything else through `JSON.stringify`.
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

/** The secrets no answer, log line or URL may ever carry. */
export const SEGREDOS = [
  CLIENT_SECRET,
  STATE_SECRET,
  REFRESH_TOKEN_A,
  REFRESH_TOKEN_B,
  ACCESS_TOKEN_A,
  ACCESS_TOKEN_B,
  ACCESS_TOKEN_NOVO,
  CODIGO,
] as const;

/* -------------------------------------------------------------------------- */
/*                        The route suites' request kit                        */
/* -------------------------------------------------------------------------- */

/** Where the conta routes live (the host is irrelevant; the path is not). */
export const URL_CONTAS = 'http://localhost:3011/api/marketplace/amazon/conta';
/** The public callback. */
export const URL_CALLBACK = 'http://localhost:3011/api/oauth/amazon/callback';

/** A caller that may read and write integrações. */
export const ESCRITOR = {
  uid: 'u-escritor',
  permissions: (PERM.integracao.read | PERM.integracao.write).toString(),
};
/** A caller that may only read them. */
export const LEITOR = { uid: 'u-leitor', permissions: PERM.integracao.read.toString() };
/** A caller with no integração permission at all. */
export const ESTRANHO = { uid: 'u-estranho', permissions: '0' };

/** A request to `<URL_CONTAS>/<sufixo>`, with a Bearer token unless told otherwise. */
export function requisicao(
  metodo: string,
  sufixo: string,
  opts: { readonly semAuth?: boolean } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.semAuth !== true) headers.authorization = 'Bearer id-token-de-teste';
  return new Request(`${URL_CONTAS}/${sufixo}`, { method: metodo, headers });
}

/** The route's second argument: Next hands `params` over as a promise. */
export function contexto(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

/** Stub every key of `ambiente` into the process environment (a route reads the real one). */
export function stubAmbiente(ambiente: AmbienteAmazon): void {
  for (const [chave, valor] of Object.entries(ambiente)) vi.stubEnv(chave, valor);
}

/**
 * Silence `process.stdout.write` (the routes' log sink) and expose every line
 * written, as text — what a hygiene assertion searches.
 */
export function espiarStdout(): { linhas: () => string[]; restaurar: () => void } {
  const espiao = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return {
    linhas: () => espiao.mock.calls.map(([chunk]) => String(chunk)),
    restaurar: () => {
      espiao.mockRestore();
    },
  };
}
