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
 * refresh token — it reads the connection STATUS, mints a consent URL and,
 * since step 15, fetches a pedido's shipping LABEL, and all three are answered
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
  oauthStartResponseSchema,
  shopeeContaStatusSchema,
  shopeeEtiquetaPendenteSchema,
  type EscolhaDeEnvio,
  type ShopeeContaStatus,
  type ShopeeEtiquetaPendente,
  type ShopeeOauthStart,
} from './wire';

const DEFAULT_SHOPEE_URL = 'http://localhost:3009';

/** Non-2xx response from the `apps/shopee` backend. */
export class ShopeeClientHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Machine code from the backend (`SHOPEE_NETWORK_ERROR`, `SHOPEE_BAD_RESPONSE`, …). */
    readonly code: string | null,
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
   * deadline apart reads `signal.aborted`, which covers both.
   */
  etiqueta(
    p: ShopeeEtiquetaPedido,
    opts?: { signal?: AbortSignal },
  ): Promise<ShopeeEtiquetaResposta>;
}

/** The label route. */
const ETIQUETA_PATH = '/api/marketplace/shopee/etiqueta';

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
 * Our JSON envelope's `error` and `code` when the backend sent one (a label
 * refusal's `error` IS its `mensagem`; every other key of that body, `motivo`
 * and `shopeeCode` included, is tolerated and ignored here), the status
 * fallback otherwise.
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
  );
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

export function createShopeeClient(config: {
  baseUrl: string;
  getAuthToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
}): ShopeeClient {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const doFetch = config.fetch ?? globalThis.fetch;

  async function call<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
    const token = await config.getAuthToken();
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });
    } catch (err) {
      throw new ShopeeClientNetworkError(err instanceof Error ? err.message : 'fetch falhou', err);
    }

    const text = await res.text();
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

    if (!res.ok) throw erroHttp(ETIQUETA_PATH, res, await res.text());

    // ---- 202: a wait or a question — JSON only. ----
    if (res.status === 202) {
      const pendente = lerCorpoJson(
        ETIQUETA_PATH,
        res.status,
        await res.text(),
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
      logarCorpoNaoJson(ETIQUETA_PATH, res.status, await res.text());
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

    const blob = await res.blob();
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

    // The ONLY place this client names a file type: the fallbacks for a header
    // the browser cannot see (a backend whose proxy predates the Expose
    // header). The route byte-sniffs the real type and names the real file.
    const fallback =
      p.formato === 'pdf'
        ? { filename: `etiqueta-${p.pedidoId}.pdf`, contentType: 'application/pdf' }
        : { filename: `etiqueta-${p.pedidoId}.zip`, contentType: 'application/zip' };
    return {
      tipo: 'arquivo',
      blob,
      filename:
        filenameFromDisposition(res.headers.get('content-disposition')) ?? fallback.filename,
      contentType: contentType ?? fallback.contentType,
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
