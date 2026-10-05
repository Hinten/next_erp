'use client';

/**
 * `useShopeeClient()` — a memoized typed client bound to the current Firebase
 * auth state, talking to the `apps/shopee` marketplace routes on their own App
 * Hosting backend. Mirrors `useMercadoPagoClient` (`lib/mercado-pago/client.ts`):
 * returns `null` while logged out so components can disable their buttons, and
 * passes `() => user.getIdToken()` so token refreshes propagate.
 *
 * The client is defined here and not in `@delfrance/integrations-shopee` on
 * purpose: that package signs every request with the partner key, which must
 * never be bundled into a browser. The browser never sees a Shopee access or
 * refresh token — it reads the connection STATUS, mints a consent URL, since
 * step 15 fetches a pedido's shipping LABEL and, since step 17, reads a
 * return's live state and runs one seller action on it. Every one is answered
 * by `apps/shopee` over an authenticated cross-origin call (its `proxy.ts`
 * allows exactly `/api/marketplace/*`).
 *
 * ⚠️ The three error classes carry a `Client` infix. `@delfrance/integrations-shopee`
 * already exports `ShopeeHttpError` and `ShopeeNetworkError` for Shopee's own
 * wire, and those names mean something different — a failure talking to SHOPEE,
 * not to our backend. Two classes with one name in one repo is a narrowing bug
 * waiting to happen.
 */
import { useMemo } from 'react';
import type { z } from 'zod';

import { envelopeDeErro, lerRespostaJson, resumirCampos } from '@delfrance/core/wire';

import { useAuth } from '@/lib/auth/useAuth';
import { filenameFromDisposition } from '@/lib/http/filenameFromDisposition';

import {
  ACAO_RECLAMACAO_SHOPEE,
  oauthStartResponseSchema,
  shopeeContaStatusSchema,
  shopeeEtiquetaPendenteSchema,
  shopeeReclamacaoAcaoRespostaSchema,
  shopeeReclamacaoEstadoSchema,
  type EscolhaDeEnvio,
  type ShopeeContaStatus,
  type ShopeeEtiquetaPendente,
  type ShopeeOauthStart,
  type ShopeeReclamacaoAcaoResposta,
  type ShopeeReclamacaoEstado,
  type SolucaoDevolucaoShopee,
} from './wire';

const DEFAULT_SHOPEE_URL = 'http://localhost:3009';

/** Non-2xx response from the `apps/shopee` backend. */
export class ShopeeClientHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Machine code from the backend (`SHOPEE_NETWORK_ERROR`, `SHOPEE_BAD_RESPONSE`, …). */
    readonly code: string | null,
    /**
     * SHOPEE's own error code, when a label refusal carries one (the
     * `recusa-desconhecida` 409's optional `shopeeCode`) — for a caller or a
     * console that wants it on a support screenshot. `message` stays the
     * backend's sentence either way; `null` whenever the body has none.
     */
    readonly shopeeCode: string | null = null,
  ) {
    super(message);
    this.name = 'ShopeeClientHttpError';
  }
}

/**
 * The backend answered 2xx and the body was not the shape this app claims — the
 * wrong fields, no body at all, or not JSON.
 *
 * ⚠️ Nothing here describes what WE send: it is a browser-side `Error` that
 * never leaves the tab, and `status` records the 2xx the backend sent US. That
 * combination — transport fine, payload unusable — is exactly what a
 * `return parsed as T` used to report as a success (#1295 → #1302).
 *
 * ⚠️ A SUBCLASS of {@link ShopeeClientHttpError}, matching both siblings for the
 * same reason: catch sites narrow to that class and `throw err` for anything
 * else, so a brand-new sibling class would sail past every one of them and land
 * as an unhandled rejection instead of a message. `code === 'RESPOSTA_INVALIDA'`
 * is what tells the two apart where it matters.
 */
export class ShopeeClientRespostaInvalidaError extends ShopeeClientHttpError {
  constructor(
    message: string,
    /** The real 2xx the backend sent — never a hardcoded 200. */
    status: number,
    /**
     * The field paths that failed, de-duplicated with array indices collapsed.
     * ⚠️ Paths only, never values: an OAuth response body is a live credential
     * often enough that the rule has to hold unconditionally (#1015).
     */
    readonly campos: string[],
  ) {
    super(message, status, 'RESPOSTA_INVALIDA');
    this.name = 'ShopeeClientRespostaInvalidaError';
  }
}

/** Network-level failure reaching the `apps/shopee` backend. */
export class ShopeeClientNetworkError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ShopeeClientNetworkError';
  }
}

/**
 * Read a response BODY, turning a connection that dies mid-body into the same
 * {@link ShopeeClientNetworkError} a failed `fetch` becomes.
 *
 * ⚠️ Wrapping only `fetch` is not enough: the headers can arrive and the socket
 * still drop while the body streams, and `text()` / `blob()` then reject with a
 * bare `TypeError` ("terminated" in Node, "network error" in Chrome). Unwrapped,
 * that escaped every handler in the label loop — an unhandled rejection on the
 * `/pedidos` row and a skipped reset on the checkout (#1748 review). The loop
 * reads one body per poll for up to two minutes, so the window is wide.
 *
 * An abort WE asked for rethrows untouched: the caller tells its own deadline
 * apart by `signal.aborted`, and must keep seeing the abort itself. Any error
 * that is not a `TypeError` is not a transport failure and rethrows too.
 */
async function lerCorpo<T>(ler: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await ler();
  } catch (err) {
    if (signal?.aborted === true) throw err;
    if (err instanceof TypeError) throw new ShopeeClientNetworkError(err.message, err);
    throw err;
  }
}

/**
 * What to say when the backend answered a non-2xx WITHOUT our JSON envelope —
 * the case where the request never reached one of its routes at all.
 *
 * Written for the OPERATOR, who cannot inspect a deployment: it says what to do,
 * and carries the status only so support can act on a screenshot. The four
 * branches match the statuses `apps/shopee/lib/shopee/core/respond.ts` actually
 * emits (400 / 404 / 500 / 502 / 503) plus the auth failures `verifyCaller`
 * answers before any route body runs.
 */
export function shopeeHttpFallbackMessage(status: number): string {
  if (status === 401 || status === 403) {
    return 'Sem permissão para esta operação na Shopee.';
  }
  if (status === 404) {
    return `A integração com a Shopee não respondeu (HTTP ${String(status)}). Atualize a página e, se continuar, avise o suporte.`;
  }
  if (status >= 500) {
    return `A integração com a Shopee falhou (HTTP ${String(status)}). Tente novamente em instantes.`;
  }
  return `Falha na comunicação com a Shopee (HTTP ${String(status)}).`;
}

/**
 * One call of the label flow (`POST /api/marketplace/shopee/etiqueta`, #1523).
 *
 * - `pacote` — only after a `baixar-por-pacote` answer: the ONE package this
 *   call downloads.
 * - `envio` — only on the call right after an `escolher-envio` answer: the
 *   operator's choice for that question's package.
 *
 * Absent keys are OMITTED from the body — the route's body is strict, and so is
 * each `envio` shape's key set, which is why the client rebuilds both by name.
 */
export interface ShopeeEtiquetaPedido {
  pedidoId: string;
  formato: 'pdf' | 'zpl2';
  pacote?: string;
  envio?: EscolhaDeEnvio;
}

/**
 * What one label call answered: the file (200), or a wait / a question (202).
 * A refusal (409), a permission gap (403) and every other non-2xx THROW
 * {@link ShopeeClientHttpError}, whose `message` is the backend's own sentence.
 *
 * `contentType` is the response header VERBATIM (a proxy may append a charset);
 * deciding what a type means is the caller's job, not the transport's.
 */
export type ShopeeEtiquetaResposta =
  | { tipo: 'arquivo'; blob: Blob; filename: string; contentType: string }
  | ({ tipo: 'pendente' } & ShopeeEtiquetaPendente);

/** Which return a seller action is about — every action carries all three. */
interface AlvoDaReclamacaoShopee {
  integracaoId: string;
  /**
   * The pedido the operator is LOOKING AT. The backend refuses (409
   * `pedido-divergente`) when the return's order maps to another one, so a
   * stale tab can never act on return X from pedido Y.
   */
  pedidoId: string;
  returnSn: string;
}

/**
 * One seller action on a Shopee return (`POST …/reclamacao/acao`), typed PER
 * ACTION so a missing "what you saw" echo is a compile error rather than a 400:
 *
 * - `confirmar` — refund without the item back; echoes the refund the panel
 *   showed, in integer centavos (`valorExibidoMinor`);
 * - `ofertar` — propose a solution; `valorReembolsoMinor` (centavos) only for an
 *   adjustable one, and ABSENT — never `0` — otherwise;
 * - `aceitar-oferta` — accept the buyer's offer; echoes the amount AND the
 *   solution the panel showed.
 *
 * The backend refuses with 409 when the live return no longer matches an echo,
 * so a buyer counter-offer landing between the read and the click is never
 * accepted unseen. Money travels as integer centavos, never a browser float.
 */
export type ReclamacaoAcaoShopeeInput =
  | (AlvoDaReclamacaoShopee & {
      acao: typeof ACAO_RECLAMACAO_SHOPEE.confirmar;
      valorExibidoMinor: number | null;
    })
  | (AlvoDaReclamacaoShopee & {
      acao: typeof ACAO_RECLAMACAO_SHOPEE.ofertar;
      solucao: SolucaoDevolucaoShopee;
      valorReembolsoMinor?: number;
    })
  | (AlvoDaReclamacaoShopee & {
      acao: typeof ACAO_RECLAMACAO_SHOPEE.aceitarOferta;
      valorExibidoMinor: number | null;
      solucaoExibida: SolucaoDevolucaoShopee | null;
    });

export interface ShopeeClient {
  /** Mint the Shopee consent URL for an `integracao` conta (PERM.integracao.write). */
  oauthStart(integracaoId: string): Promise<ShopeeOauthStart>;
  /** Connection status — the two clocks. Always 200 (PERM.integracao.read). */
  conta(integracaoId: string): Promise<ShopeeContaStatus>;
  /**
   * ONE call of the label flow (PERM.frete.read; an arrange needs frete.write,
   * answered as a 403 otherwise). Stateless on both sides: the caller loops on
   * the 202s, and re-calling IS the resume path.
   *
   * ⚠️ An abort through `opts.signal` surfaces like every other transport
   * failure — a {@link ShopeeClientNetworkError} whose `cause` is the
   * `DOMException` — while the request is in flight; an abort during the BODY
   * read rejects with that `DOMException` itself. A caller telling its own
   * deadline apart reads `signal.aborted`, which covers both. A connection that
   * drops mid-body WITHOUT an abort is a {@link ShopeeClientNetworkError} too
   * (`lerCorpo`), never a bare `TypeError`.
   */
  etiqueta(
    p: ShopeeEtiquetaPedido,
    opts?: { signal?: AbortSignal },
  ): Promise<ShopeeEtiquetaResposta>;
  /**
   * Live state of one Shopee return (`PERM.incidenteResolucao.read`).
   *
   * ⚠️ Never cache the result: `acoesDisponiveis` is stale the moment it
   * leaves the backend, so the panel refetches rather than remembering.
   */
  reclamacaoEstado(input: {
    integracaoId: string;
    returnSn: string;
  }): Promise<ShopeeReclamacaoEstado>;
  /**
   * Run one seller action on a Shopee return (`PERM.incidenteResolucao.write`).
   *
   * ⚠️ **Irreversible, and it moves money.** Writes NOTHING locally — the
   * returns importer stays the single writer of the incidente, so the caller
   * learns the outcome by refetching {@link reclamacaoEstado}.
   *
   * ⚠️ A {@link ShopeeClientNetworkError} here means the outcome is UNKNOWN,
   * not that the action failed: a gateway timeout reaches the browser as a
   * network error with no CORS headers. Never retry it automatically.
   */
  reclamacaoAcao(input: ReclamacaoAcaoShopeeInput): Promise<ShopeeReclamacaoAcaoResposta>;
}

/** The label route. */
const ETIQUETA_PATH = '/api/marketplace/shopee/etiqueta';

/** The two returns routes (#1525, step 17). */
const RECLAMACAO_ESTADO_PATH = '/api/marketplace/shopee/reclamacao/estado';
const RECLAMACAO_ACAO_PATH = '/api/marketplace/shopee/reclamacao/acao';

/**
 * Log a body the operator will never see, capped so a whole HTML document
 * cannot flood the console.
 */
function logarCorpoNaoJson(path: string, status: number, corpo: string): void {
  console.error(
    `[shopee] resposta não-JSON em ${path} (HTTP ${String(status)})`,
    corpo.slice(0, 500),
  );
}

/**
 * The error for a non-2xx — the ONE copy, shared by every route of this client.
 * Our JSON envelope's `error` and `code` when the backend sent one, the status
 * fallback otherwise. A label refusal's `error` IS its `mensagem` (truth:
 * `apps/shopee/lib/shopee/etiqueta/respostaEtiqueta.ts`); its `shopeeCode`, when
 * a string, is carried on the error WITHOUT touching the message, and every
 * other key of that body (`motivo`, `nfe`, `tentarApos`) is tolerated and
 * ignored here.
 */
function erroHttp(path: string, res: Response, text: string): ShopeeClientHttpError {
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      // ⚠️ The body must NOT become `{ error: text }`: a proxy's whole HTML
      // document would then end up verbatim in `err.message` and bury the
      // real cause behind a wall of markup. It stays reachable on the
      // console instead.
      if (err instanceof SyntaxError) {
        logarCorpoNaoJson(path, res.status, text);
      } else throw err;
    }
  }
  const errBody = envelopeDeErro(parsed);
  return new ShopeeClientHttpError(
    errBody?.error ?? shopeeHttpFallbackMessage(res.status),
    res.status,
    errBody?.code ?? null,
    codigoShopeeDoCorpo(parsed),
  );
}

/** A non-empty string `shopeeCode` off an error body, else `null` — nothing is coerced. */
function codigoShopeeDoCorpo(parsed: unknown): string | null {
  if (parsed === null || typeof parsed !== 'object' || !('shopeeCode' in parsed)) return null;
  const { shopeeCode } = parsed;
  return typeof shopeeCode === 'string' && shopeeCode.length > 0 ? shopeeCode : null;
}

/** A 2xx JSON body read against its schema, or the one error each failure earns. */
function lerCorpoJson<S extends z.ZodType>(
  path: string,
  status: number,
  text: string,
  schema: S,
): z.infer<S> {
  const leitura = lerRespostaJson(text, schema);
  if (leitura.ok) return leitura.data;

  if (leitura.motivo !== 'formato') {
    // ⚠️ EMPTY and NON-JSON share this branch, and they must: neither is
    // version skew — in both, the request failed to reach a route that
    // answers JSON. Sending someone to deploy a backend that was never the
    // problem is the defect this wording exists to avoid.
    logarCorpoNaoJson(
      path,
      status,
      leitura.motivo === 'nao-json' ? leitura.texto : '(corpo vazio)',
    );
    throw new ShopeeClientRespostaInvalidaError(
      `A integração com a Shopee respondeu HTTP ${String(status)} sem um corpo JSON — ` +
        'o pedido não chegou à rota esperada. Atualize a página e, se continuar, avise o ' +
        'suporte.',
      status,
      [],
    );
  }

  throw new ShopeeClientRespostaInvalidaError(
    'O backend da Shopee respondeu num formato que este aplicativo não reconhece. ' +
      `Campos inválidos: ${resumirCampos(leitura.campos)}. Normalmente isso significa que o ` +
      'backend e esta tela estão em versões diferentes — faça o deploy de `apps/shopee` e ' +
      'recarregue a página.',
    status,
    leitura.campos,
  );
}

/** The MIME essence of a `Content-Type` — lower-cased, parameters dropped. */
function essenciaDoTipo(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * The extension of each type the label route serves, keyed by MIME essence —
 * the three its byte sniff can name (truth:
 * `packages/integrations/shopee/src/arquivo.ts`). A `Map`, not an object: an
 * essence is a string off the wire, and `'constructor'` must not resolve.
 */
const EXTENSAO_DA_ETIQUETA: ReadonlyMap<string, string> = new Map([
  ['application/pdf', 'pdf'],
  ['application/zip', 'zip'],
  ['text/plain', 'txt'],
]);

/**
 * The label request body, rebuilt BY NAME: absent keys omitted, and each
 * `envio` shape with exactly its own keys. The route refuses any other key
 * (400), so a caller's object carrying one more field must not reach it.
 */
function corpoDaEtiqueta(p: ShopeeEtiquetaPedido): Record<string, unknown> {
  const envio: EscolhaDeEnvio | undefined =
    p.envio === undefined
      ? undefined
      : p.envio.modo === 'dropoff'
        ? { pacote: p.envio.pacote, modo: 'dropoff' }
        : {
            pacote: p.envio.pacote,
            modo: 'pickup',
            enderecoId: p.envio.enderecoId,
            horarioId: p.envio.horarioId,
          };
  return {
    pedidoId: p.pedidoId,
    formato: p.formato,
    ...(p.pacote === undefined ? {} : { pacote: p.pacote }),
    ...(envio === undefined ? {} : { envio }),
  };
}

/**
 * The returns action body, rebuilt BY NAME and per action: exactly the keys
 * that action carries, an absent optional one OMITTED (never `null`-filled).
 * The route's body is strict and forbids each key outside its own action
 * (400), so a caller object carrying one more field — a `solucao` left over on
 * a `confirmar` — must not reach it.
 */
function corpoDaReclamacao(p: ReclamacaoAcaoShopeeInput): Record<string, unknown> {
  const alvo = { integracaoId: p.integracaoId, pedidoId: p.pedidoId, returnSn: p.returnSn };
  switch (p.acao) {
    case ACAO_RECLAMACAO_SHOPEE.confirmar:
      return { ...alvo, acao: p.acao, valorExibidoMinor: p.valorExibidoMinor };
    case ACAO_RECLAMACAO_SHOPEE.ofertar:
      return {
        ...alvo,
        acao: p.acao,
        solucao: p.solucao,
        ...(p.valorReembolsoMinor === undefined
          ? {}
          : { valorReembolsoMinor: p.valorReembolsoMinor }),
      };
    case ACAO_RECLAMACAO_SHOPEE.aceitarOferta:
      return {
        ...alvo,
        acao: p.acao,
        valorExibidoMinor: p.valorExibidoMinor,
        solucaoExibida: p.solucaoExibida,
      };
    default: {
      // Exhaustive: a fourth action is a compile error here, never a body
      // sent with whatever keys the caller happened to pass.
      const nunca: never = p;
      throw new TypeError(`ação de devolução desconhecida: ${JSON.stringify(nunca)}`);
    }
  }
}

export function createShopeeClient(config: {
  baseUrl: string;
  getAuthToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
}): ShopeeClient {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const doFetch = config.fetch ?? globalThis.fetch;

  /**
   * One JSON round trip: a GET, or a POST exactly when `body` is given.
   *
   * ⚠️ `getAuthToken()` stays OUTSIDE the try, on purpose: a token failure is
   * a `FirebaseError`, not a transport failure, and the caller narrows it on
   * its own (the returns panel does, so an irreversible confirm never ends in
   * silence). Wrapping it here would relabel it a network error.
   */
  async function call<S extends z.ZodType>(
    path: string,
    schema: S,
    body?: Record<string, unknown>,
  ): Promise<z.infer<S>> {
    const token = await config.getAuthToken();
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new ShopeeClientNetworkError(err instanceof Error ? err.message : 'fetch falhou', err);
    }

    const text = await lerCorpo(() => res.text());
    if (!res.ok) throw erroHttp(path, res, text);
    return lerCorpoJson(path, res.status, text, schema);
  }

  /**
   * The label call: 200 = the file's bytes, 202 = JSON, anything else fails.
   *
   * ⚠️ The 200 is the one success path a schema cannot reach — the body is
   * bytes — so what can still go wrong is checked by hand: a 200 that is not
   * the label at all. Each of those becomes {@link ShopeeClientRespostaInvalidaError},
   * NEVER a `Blob` the caller would print: a blank label, or a printer fed a
   * chunk of markup.
   */
  async function etiqueta(
    p: ShopeeEtiquetaPedido,
    opts?: { signal?: AbortSignal },
  ): Promise<ShopeeEtiquetaResposta> {
    const token = await config.getAuthToken();
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${ETIQUETA_PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(corpoDaEtiqueta(p)),
        ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
      });
    } catch (err) {
      throw new ShopeeClientNetworkError(err instanceof Error ? err.message : 'fetch falhou', err);
    }

    const sinal = opts?.signal;
    if (!res.ok) {
      throw erroHttp(ETIQUETA_PATH, res, await lerCorpo(() => res.text(), sinal));
    }

    // ---- 202: a wait or a question — JSON only. ----
    if (res.status === 202) {
      const pendente = lerCorpoJson(
        ETIQUETA_PATH,
        res.status,
        await lerCorpo(() => res.text(), sinal),
        shopeeEtiquetaPendenteSchema,
      );
      return { ...pendente, tipo: 'pendente' };
    }

    // ---- Any 2xx that is neither: the route answers exactly 200 or 202 (W16). ----
    if (res.status !== 200) {
      throw new ShopeeClientRespostaInvalidaError(
        `A integração com a Shopee respondeu HTTP ${String(res.status)} em vez da etiqueta — ` +
          'o pedido não chegou à rota esperada. Atualize a página e, se continuar, avise o ' +
          'suporte.',
        res.status,
        [],
      );
    }

    // ---- 200: the bytes. ----
    const contentType = res.headers.get('content-type');
    const essencia = contentType === null ? null : essenciaDoTipo(contentType);
    // A proxy login page or an App Hosting error page arrives as HTML: the
    // request never reached the route, which answers a label or nothing.
    if (essencia === 'text/html') {
      logarCorpoNaoJson(ETIQUETA_PATH, res.status, await lerCorpo(() => res.text(), sinal));
      throw new ShopeeClientRespostaInvalidaError(
        `A integração com a Shopee respondeu HTTP ${String(res.status)} com uma página HTML ` +
          'em vez da etiqueta — o pedido não chegou à rota esperada. Atualize a página e, se ' +
          'continuar, avise o suporte.',
        res.status,
        [],
      );
    }
    // ⚠️ A JSON 200 is a contract breach, never a label (W16): the route answers
    // JSON only on a 202. Its body is not logged — it would be a question
    // carrying the seller's addresses, or something newer than this build.
    if (essencia === 'application/json') {
      throw new ShopeeClientRespostaInvalidaError(
        `A integração com a Shopee respondeu HTTP ${String(res.status)} com JSON em vez da ` +
          'etiqueta. Normalmente isso significa que o backend e esta tela estão em versões ' +
          'diferentes — faça o deploy de `apps/shopee` e recarregue a página.',
        res.status,
        [],
      );
    }

    const blob = await lerCorpo(() => res.blob(), sinal);
    // "A 2xx with an empty body is a failed label" — never a blank print.
    if (blob.size === 0) {
      logarCorpoNaoJson(ETIQUETA_PATH, res.status, '(corpo vazio)');
      throw new ShopeeClientRespostaInvalidaError(
        `A integração com a Shopee respondeu HTTP ${String(res.status)} sem a etiqueta (corpo ` +
          'vazio). Tente de novo e, se continuar, avise o suporte.',
        res.status,
        [],
      );
    }

    // The fallback name, for a `Content-Disposition` the browser cannot see (a
    // backend whose proxy predates the Expose header). The route byte-sniffs
    // the real type and names the real file.
    //
    // ⚠️ The extension follows the RESPONSE's `Content-Type`, never the
    // requested `formato`: Shopee may answer a zpl2 request with a PDF (R-u),
    // and a PDF saved as `.zip` is ML #1680's defect. `Content-Type` is
    // CORS-safelisted, so it is readable exactly when the disposition is not.
    // The `formato` guess is left only for a type the route never serves
    // (absent, or not one of its three).
    const extensao =
      (essencia === null ? undefined : EXTENSAO_DA_ETIQUETA.get(essencia)) ??
      (p.formato === 'pdf' ? 'pdf' : 'zip');
    return {
      tipo: 'arquivo',
      blob,
      filename:
        filenameFromDisposition(res.headers.get('content-disposition')) ??
        `etiqueta-${p.pedidoId}.${extensao}`,
      contentType: contentType ?? (p.formato === 'pdf' ? 'application/pdf' : 'application/zip'),
    };
  }

  return {
    oauthStart: (integracaoId) =>
      call(
        `/api/marketplace/shopee/oauth/start?integracaoId=${encodeURIComponent(integracaoId)}`,
        oauthStartResponseSchema,
      ),
    conta: (integracaoId) =>
      call(
        `/api/marketplace/shopee/conta?integracaoId=${encodeURIComponent(integracaoId)}`,
        shopeeContaStatusSchema,
      ),
    etiqueta,
    reclamacaoEstado: (input) =>
      call(
        `${RECLAMACAO_ESTADO_PATH}?integracaoId=${encodeURIComponent(input.integracaoId)}` +
          `&returnSn=${encodeURIComponent(input.returnSn)}`,
        shopeeReclamacaoEstadoSchema,
      ),
    reclamacaoAcao: (input) =>
      call(RECLAMACAO_ACAO_PATH, shopeeReclamacaoAcaoRespostaSchema, corpoDaReclamacao(input)),
  };
}

export function useShopeeClient(): ShopeeClient | null {
  const { user } = useAuth();
  return useMemo(() => {
    if (!user) return null;
    const baseUrl = process.env.NEXT_PUBLIC_SHOPEE_URL ?? DEFAULT_SHOPEE_URL;
    return createShopeeClient({
      baseUrl,
      getAuthToken: () => user.getIdToken(),
    });
  }, [user]);
}
