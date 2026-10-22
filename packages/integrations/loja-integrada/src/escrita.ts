/**
 * The Loja Integrada WRITE client, `criarClienteEscritaLi`: the package's only
 * writer, kept apart from the read client (`client.ts`) on purpose.
 *
 * ## Two methods, named for the one place that may call them
 *
 *  - {@link LiEscritaClient.lerAntesDeEscreverLi} — the `GET` a write decides
 *    on, and its read-back. Read semantics throughout (a body that fails its
 *    schema throws `LiSchemaError`; a cut body throws), plus the response TEXT
 *    with the token already scrubbed, which exists for the caller's restore
 *    snapshot only.
 *  - {@link LiEscritaClient.enviarEscritaLi} — one `PUT`.
 *
 * Neither name, nor the factory's, nor `LiEscritaClient`, is used anywhere else,
 * so the app can guard by name that a single module of its own calls them. The
 * two operations of master-plan step 7 are in `pedidosEscrita.ts`.
 *
 * ## What `enviarEscritaLi` sends
 *
 *  - The body is `corpoSchema`'s OUTPUT, never the caller's object: a key the
 *    schema does not declare never travels (a strict schema refuses it, a
 *    stripping one drops it). A body the schema refuses is
 *    `LiConfigError('corpo')`, raised before the credential is read.
 *  - Bodies hold strings only (`Readonly<Record<string, string>>`), so nothing
 *    numeric is coerced on the way out.
 *  - The serialised body is refused when it carries the token
 *    (`LiConfigError('token-no-corpo')`), checked on the exact text sent.
 *  - `Content-Type: application/json`, `redirect: 'manual'`: a 3xx is a visible
 *    `LiHttpError` and the body is never re-sent anywhere.
 *
 * ## What a write's answer means
 *
 * ⚠️ **Any 2xx resolves: the write landed.** Nothing after a landed write may
 * throw, or a retry would write again — and every status write may e-mail the
 * buyer. So, on a 2xx:
 *
 *  - an empty, non-JSON or malformed echo is REPORTED (`leituraEco`), never
 *    thrown. The echo is diagnostic only: whether the write took effect is the
 *    caller's to establish with a fresh read;
 *  - a body read then cut by the deadline or by a dropped connection resolves
 *    too, with `leituraEco: 'falhou'`, narrowed exactly as the read path
 *    narrows (the deadline first, then a `TypeError`). The caller's own abort is
 *    still rethrown as itself;
 *  - **202 is `aplicada: 'pendente'`** — accepted, perhaps not applied yet;
 *    every other 2xx is `'sim'`.
 *
 * A non-2xx classifies exactly as a `GET` does (`LiAuthError`, `LiNotFoundError`,
 * `LiThrottleError`, `LiHttpError`), its message naming the `PUT`. A timeout
 * before any answer is `LiTimeoutError`, and a cut write MAY HAVE LANDED
 * (`prazos.ts`): the caller re-derives from a fresh read, never assuming either
 * outcome.
 */
import { lerRespostaJson } from '@delfrance/core/wire';
import type { z } from 'zod';

import {
  type Corte2xxLi,
  executarLi,
  lerComSchemaLi,
  type OpcoesClienteLi,
  type PedidoGetLi,
} from './client';
import { LiConfigError } from './errors';

/** The status Loja Integrada would answer for "accepted, maybe not applied yet". */
const STATUS_ACEITO = 202;

/** Whether a 2xx write took effect, as far as its status says. */
export type AplicacaoEscritaLi = 'sim' | 'pendente';

/**
 * How the echo of a 2xx write read:
 * `ok` — parsed by its schema; `vazio` — no body; `nao-json` — not JSON (an
 * HTML page, say); `formato` — JSON its schema refused; `falhou` — the body read
 * was cut after the 2xx arrived.
 */
export type LeituraEcoLi = 'ok' | 'vazio' | 'nao-json' | 'formato' | 'falhou';

export interface PedidoPutLi<S extends z.ZodType> {
  /** The caller's label for the call; it names the call in messages and events. */
  readonly operacao: string;
  /** A path under `/v1/`, without a query. */
  readonly caminho: string;
  /** The body as the caller has it; only `corpoSchema`'s output is sent. */
  readonly corpo: unknown;
  /** The body's schema. Strings only; `.strict()` so a stray key is refused. */
  readonly corpoSchema: z.ZodType<Readonly<Record<string, string>>>;
  /** The echo's schema: tolerant, read for diagnosis only. */
  readonly ecoSchema: S;
  /** The caller's cancellation; its abort is rethrown as itself. */
  readonly sinal?: AbortSignal;
}

export interface RespostaEscritaLi<T> {
  /** The 2xx Loja Integrada answered. */
  readonly status: number;
  readonly aplicada: AplicacaoEscritaLi;
  /** The parsed echo, or `null` whenever `leituraEco` is not `'ok'`. */
  readonly eco: T | null;
  readonly leituraEco: LeituraEcoLi;
  readonly correlationId: string;
  /** The `ref` of the credential THIS write used. */
  readonly refCredencial: string;
}

export interface RespostaLeituraEscritaLi<T> {
  readonly dados: T;
  /** The response text with the token replaced by `TOKEN_REMOVIDO`; for the restore snapshot only. */
  readonly texto: string;
  readonly status: number;
  readonly correlationId: string;
  /** The `ref` of the credential THIS read used. */
  readonly refCredencial: string;
}

/** The write client. Its method names are deliberately used nowhere else. */
export interface LiEscritaClient {
  lerAntesDeEscreverLi<S extends z.ZodType>(
    p: PedidoGetLi<S>,
  ): Promise<RespostaLeituraEscritaLi<z.infer<S>>>;
  enviarEscritaLi<S extends z.ZodType>(p: PedidoPutLi<S>): Promise<RespostaEscritaLi<z.infer<S>>>;
}

function aplicacaoDoStatus(status: number): AplicacaoEscritaLi {
  return status === STATUS_ACEITO ? 'pendente' : 'sim';
}

export function criarClienteEscritaLi(opts: OpcoesClienteLi): LiEscritaClient {
  async function lerAntesDeEscreverLi<S extends z.ZodType>(
    p: PedidoGetLi<S>,
  ): Promise<RespostaLeituraEscritaLi<z.infer<S>>> {
    return executarLi(opts, {
      metodo: 'GET',
      operacao: p.operacao,
      caminho: p.caminho,
      query: p.query,
      sinal: p.sinal,
      ler2xx: lerComSchemaLi(p.schema, (dados, r) => ({
        dados,
        texto: r.corpo,
        status: r.status,
        correlationId: r.correlationId,
        refCredencial: r.refCredencial,
      })),
    });
  }

  async function enviarEscritaLi<S extends z.ZodType>(
    p: PedidoPutLi<S>,
  ): Promise<RespostaEscritaLi<z.infer<S>>> {
    const { operacao } = p;
    // The schema's OUTPUT is the body: the caller's object never travels.
    const corpo = p.corpoSchema.safeParse(p.corpo);
    if (!corpo.success) throw new LiConfigError('corpo', { operacao, refCredencial: null });

    const semEco = (c: Corte2xxLi): RespostaEscritaLi<z.infer<S>> => ({
      status: c.status,
      aplicada: aplicacaoDoStatus(c.status),
      eco: null,
      leituraEco: 'falhou',
      correlationId: c.correlationId,
      refCredencial: c.refCredencial,
    });

    return executarLi(opts, {
      metodo: 'PUT',
      operacao,
      caminho: p.caminho,
      corpo: corpo.data,
      sinal: p.sinal,
      // Any 2xx is a landed write: the echo is reported, never thrown.
      ler2xx: (r) => {
        const eco = lerRespostaJson(r.texto, p.ecoSchema);
        return {
          resultado: 'ok',
          valor: {
            status: r.status,
            aplicada: aplicacaoDoStatus(r.status),
            eco: eco.ok ? eco.data : null,
            leituraEco: eco.ok ? 'ok' : eco.motivo,
            correlationId: r.correlationId,
            refCredencial: r.refCredencial,
          },
        };
      },
      corte2xx: semEco,
    });
  }

  return { lerAntesDeEscreverLi, enviarEscritaLi };
}
