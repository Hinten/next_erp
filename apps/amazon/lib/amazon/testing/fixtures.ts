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

import type { CamposLogAmazon, LoggerAmazon, criarObservadorAmazon } from '../core/log';
import type { ClasseFalsaAmazon, FalsificadorAmazon } from '../core/redacao';
import { fingerprintDoRefreshToken, montarRef } from '../core/refCredencial';
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
/** Two relay secrets of the receiver (step 3): 32+ visible-ASCII characters, synthetic. */
export const SEGREDO_RELAY = 'relay|TESTE-segredo-sintetico-naoreal-09';
export const SEGREDO_RELAY_ANTERIOR = 'relay|TESTE-anterior-sintetico-naoreal-10';

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
  readonly meta: CamposLogAmazon | undefined;
}

/** A {@link LoggerAmazon} that keeps every line, in order. */
export function loggerEspiao(): { logger: LoggerAmazon; linhas: LinhaDeLog[] } {
  const linhas: LinhaDeLog[] = [];
  const gravar =
    (nivel: LinhaDeLog['nivel']) =>
    (mensagem: string, meta?: CamposLogAmazon): void => {
      linhas.push({ nivel, mensagem, meta });
    };
  return { logger: { info: gravar('info'), warn: gravar('warn'), error: gravar('error') }, linhas };
}

/** Only the call lines (`evento: 'chamada'`) a spy recorded, in order. */
export function linhasDeChamada(linhas: readonly LinhaDeLog[]): CamposLogAmazon[] {
  return linhas
    .map((l) => l.meta)
    .filter((m): m is CamposLogAmazon => m !== undefined && m.evento === 'chamada');
}

/**
 * The package's call event, as the observer receives it. Named through the
 * observer's own parameter: only `core/log.ts` names the raw type
 * (`estrutura.test.ts`).
 */
export type EventoDeChamada = Parameters<ReturnType<typeof criarObservadorAmazon>>[0];

/** A versioned ref of the default grant, for an SP-API event. */
export const REF_VERSIONADA = montarRef('0123456789abcdef', AGORA_MS - 10 * 24 * 60 * 60 * 1000);

/**
 * One call event for the log tests: a 200 `getOrder` with an empty JSON object,
 * under a versioned ref, unless `over` says otherwise.
 */
export function eventoDeChamada(over: Partial<EventoDeChamada> = {}): EventoDeChamada {
  return {
    destino: 'sp-api',
    operacao: 'getOrder',
    metodo: 'GET',
    caminho: '/orders/2026-01-01/orders/123-4567890-1234567',
    query: [['includedData', 'BUYER,RECIPIENT']],
    correlationId: '00000000-0000-4000-8000-000000000001',
    requestIdAmazon: 'req-teste-1',
    refCredencial: REF_VERSIONADA,
    status: 200,
    latenciaMs: 12,
    resultado: 'ok',
    limiteTaxa: 0.5,
    codigosErro: [],
    codigoLwa: null,
    corpo: '{}',
    ...over,
  };
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
  SEGREDO_RELAY,
  SEGREDO_RELAY_ANTERIOR,
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

/* -------------------------------------------------------------------------- */
/*                          The fixture-profile faker                          */
/* -------------------------------------------------------------------------- */

/** The DV of a 43-digit chave prefix (mod 11, weights 2..9 from the right). */
function dvDaChave(c43: string): number {
  let soma = 0;
  let peso = 2;
  for (let i = c43.length - 1; i >= 0; i--) {
    soma += Number(c43[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

const hex8 = (n: number) => n.toString(16).padStart(8, '0');
const uuidDe = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

/** The test faker's own fake formats: each passes its leaf's predicate. */
export const FORMATO_FALSO_TESTE: Readonly<Record<ClasseFalsaAmazon, RegExp>> = {
  pedido: /^000-0000000-\d{7}$/,
  itemPedido: /^00000\d{9}$/,
  alias: /^ALIAS-Z[0-9a-f]{8}$/,
  pacote: /^PKG-Z[0-9a-f]{8}$/,
  asin: /^B0ZZ\d{6}$/,
  sku: /^SKU-Z[0-9a-f]{8}$/,
  rastreio: /^TRKZ\d{8}$/,
  chaveNfe: /^0{20}55000\d{9}0{9}\d$/,
  slot: /^SLOT-Z[0-9a-f]{8}$/,
  promocao: /^PROMO-Z[0-9a-f]{8}$/,
  aplicacao: /^amzn1\.sp\.solution\.00000000-0000-0000-0000-000000000000$/,
  assinatura: /^00000000-0000-0000-0000-\d{12}$/,
  notificacao: /^00000000-0000-0000-0000-\d{12}$/,
  mensagem: /^00000000-0000-0000-0000-\d{12}$/,
  remessa: /^SHP-Z[0-9a-f]{8}$/,
  regiao: /^xx-regiao-1$/,
};

/**
 * A counter faker for the `fixture` profile (2b-b's is a keyed hash): the same
 * value gets the same fake, and a value already in its class's fake format is a
 * FIXPOINT — the contract that makes the profile idempotent.
 */
export function falsificadorDeTeste(): FalsificadorAmazon & { readonly chamadas: number } {
  const mapa = new Map<string, string>();
  let n = 0;
  const gerar = (classe: ClasseFalsaAmazon, i: number): string => {
    switch (classe) {
      case 'pedido':
        return `000-0000000-${String(i).padStart(7, '0')}`;
      case 'itemPedido':
        return `00000${String(i).padStart(9, '0')}`;
      case 'alias':
        return `ALIAS-Z${hex8(i)}`;
      case 'pacote':
        return `PKG-Z${hex8(i)}`;
      case 'asin':
        return `B0ZZ${String(i).padStart(6, '0')}`;
      case 'sku':
        return `SKU-Z${hex8(i)}`;
      case 'rastreio':
        return `TRKZ${String(i).padStart(8, '0')}`;
      case 'chaveNfe': {
        const c43 = `${'0'.repeat(20)}55000${String(i).padStart(9, '0')}${'0'.repeat(9)}`;
        return `${c43}${String(dvDaChave(c43))}`;
      }
      case 'slot':
        return `SLOT-Z${hex8(i)}`;
      case 'promocao':
        return `PROMO-Z${hex8(i)}`;
      case 'aplicacao':
        return 'amzn1.sp.solution.00000000-0000-0000-0000-000000000000';
      case 'assinatura':
      case 'notificacao':
      case 'mensagem':
        return uuidDe(i);
      case 'remessa':
        return `SHP-Z${hex8(i)}`;
      case 'regiao':
        return 'xx-regiao-1';
    }
  };
  const f = (classe: ClasseFalsaAmazon, valor: string): string => {
    if (FORMATO_FALSO_TESTE[classe].test(valor)) return valor;
    const chave = `${classe}:${valor}`;
    const existente = mapa.get(chave);
    if (existente !== undefined) return existente;
    n += 1;
    const falso = gerar(classe, n);
    mapa.set(chave, falso);
    return falso;
  };
  return Object.defineProperty(f, 'chamadas', { get: () => n }) as FalsificadorAmazon & {
    readonly chamadas: number;
  };
}

/* -------------------------------------------------------------------------- */
/*                       The receiver's body stream spy                       */
/* -------------------------------------------------------------------------- */

/** A body stream that counts what was pulled from it, and whether it was cancelled. */
export interface FluxoEspiao {
  readonly stream: ReadableStream<Uint8Array>;
  /** How many chunks were PULLED (handed to a reader): 0 = the body was never read. */
  readonly puxados: () => number;
  readonly cancelado: () => boolean;
}

/**
 * A pull-driven stream over `partes` (`highWaterMark: 0`, so nothing is pulled
 * before a reader asks): the receiver's "the body was never read" and "the read
 * stopped at the bound" assertions count its pulls.
 */
export function fluxoEspiao(partes: readonly (string | Uint8Array)[]): FluxoEspiao {
  let puxados = 0;
  let cancelado = false;
  const codificador = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controle) {
        const parte = partes[puxados];
        if (parte === undefined) {
          controle.close();
          return;
        }
        puxados += 1;
        controle.enqueue(typeof parte === 'string' ? codificador.encode(parte) : parte);
      },
      cancel() {
        cancelado = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, puxados: () => puxados, cancelado: () => cancelado };
}
