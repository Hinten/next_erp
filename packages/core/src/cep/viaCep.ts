/**
 * ViaCEP lookup — resolves a Brazilian CEP to its address parts so the endereço
 * forms can autofill logradouro/bairro/cidade/estado/codigoMunicipio, and so
 * server paths have a last-resort source for `codigoMunicipio` (#785).
 * Public API, no key: `GET https://viacep.com.br/ws/{cep}/json/`.
 *
 * Lives in `@delfrance/core` rather than `apps/web` because three server-side
 * callers need it — the Mercado Livre order import, the NF-e bundle loader and
 * the shared endereço builder (#789) — and none of them can import from
 * `apps/web`. Nothing here touches the DOM; the module is universal.
 *
 * `buscarCep` returns `null` for the three *expected* misses (a malformed CEP,
 * a non-OK response, ViaCEP's `{ "erro": true }`) and throws `ViaCepError` for
 * the *unexpected* ones (network failure, timeout, malformed JSON) so callers
 * can tell "this CEP does not exist" from "we could not ask".
 */
import { cleanCep } from './cep';

export interface EnderecoViaCep {
  logradouro: string;
  bairro: string;
  cidade: string;
  estado: string;
  /** IBGE município code (maps to `codigoMunicipio`). */
  codigoMunicipio: string;
}

interface ViaCepResponse {
  logradouro?: string;
  bairro?: string;
  localidade?: string;
  uf?: string;
  ibge?: string;
  erro?: boolean | string;
}

/**
 * ViaCEP could not be reached or did not answer with usable JSON. Carries the
 * originating failure as `cause`.
 *
 * This class exists because the timeout below rejects with a `DOMException`,
 * which no caller would think to narrow on — the previous `apps/web` module let
 * bare `TypeError`/`SyntaxError` escape and each caller re-narrowed them, which
 * also swallowed genuine `TypeError` bugs (CLAUDE.md rule 6).
 */
export class ViaCepError extends Error {
  readonly cep: string;

  constructor(message: string, cep: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ViaCepError';
    this.cep = cep;
  }
}

export interface ViaCepConfig {
  /** Test seam; resolved per request so a `vi.spyOn(globalThis, 'fetch')` is honoured. */
  readonly fetch?: typeof globalThis.fetch;
  /** Defaults to `https://viacep.com.br/ws`. No trailing slash. */
  readonly baseUrl?: string;
  /** Request timeout. Defaults to 5000 ms. */
  readonly timeoutMs?: number;
  /** Max memoized CEPs; `0` disables memoization. Defaults to 2000. */
  readonly cacheMax?: number;
}

export interface ViaCepClient {
  buscarCep(cep: string): Promise<EnderecoViaCep | null>;
}

const DEFAULT_BASE_URL = 'https://viacep.com.br/ws';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_MAX = 2_000;

/**
 * Build a ViaCEP client.
 *
 * Memoizes per client instance: CEP → município is static data, so there is no
 * staleness to manage, and the NF-e lote path and the ML importer both hammer
 * repeated CEPs against a service that rate-limits without documenting its
 * limit. Concurrent lookups of the same CEP share one in-flight request.
 */
export function createViaCepClient(config: ViaCepConfig = {}): ViaCepClient {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheMax = config.cacheMax ?? DEFAULT_CACHE_MAX;

  const cache = new Map<string, EnderecoViaCep | null>();
  const inFlight = new Map<string, Promise<EnderecoViaCep | null>>();

  function remember(clean: string, value: EnderecoViaCep | null): void {
    if (cacheMax <= 0) return;
    // FIFO eviction — `Map` iterates in insertion order.
    if (cache.size >= cacheMax) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(clean, value);
  }

  async function request(clean: string): Promise<EnderecoViaCep | null> {
    const doFetch = config.fetch ?? globalThis.fetch;

    let res: Response;
    try {
      res = await doFetch(`${baseUrl}/${clean}/json/`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // `fetch` rejects with TypeError on a network failure and DOMException
      // ('TimeoutError'/'AbortError') when the signal fires. Anything else is
      // a bug, not a transport problem — let it through.
      if (err instanceof DOMException) {
        throw new ViaCepError(`Tempo esgotado ao consultar o CEP ${clean}.`, clean, { cause: err });
      }
      if (err instanceof TypeError) {
        throw new ViaCepError(`Falha de rede ao consultar o CEP ${clean}.`, clean, { cause: err });
      }
      throw err;
    }

    // A non-OK response is transient often enough (429/5xx) that memoizing it
    // would poison the cache for the process lifetime — return without caching.
    if (!res.ok) return null;

    let data: ViaCepResponse;
    try {
      data = (await res.json()) as ViaCepResponse;
    } catch (err) {
      if (err instanceof SyntaxError || err instanceof TypeError) {
        throw new ViaCepError(`Resposta inválida do ViaCEP para o CEP ${clean}.`, clean, {
          cause: err,
        });
      }
      throw err;
    }

    // ViaCEP signals "not found" with `{ "erro": true }` (sometimes the string
    // "true") and HTTP 200 — both are truthy here. This one IS definitive, so
    // it is worth remembering.
    if (data.erro) {
      remember(clean, null);
      return null;
    }

    const endereco: EnderecoViaCep = {
      logradouro: data.logradouro ?? '',
      bairro: data.bairro ?? '',
      cidade: data.localidade ?? '',
      estado: data.uf ?? '',
      codigoMunicipio: data.ibge ?? '',
    };
    remember(clean, endereco);
    return endereco;
  }

  return {
    async buscarCep(cep: string): Promise<EnderecoViaCep | null> {
      const clean = cleanCep(cep);
      if (clean.length !== 8) return null;

      const cached = cache.get(clean);
      if (cached !== undefined) return cached;

      const pending = inFlight.get(clean);
      if (pending) return pending;

      const promise = request(clean).finally(() => inFlight.delete(clean));
      inFlight.set(clean, promise);
      return promise;
    },
  };
}

let defaultClient: ViaCepClient | undefined;

/**
 * Look a CEP up through a lazily-created, process-wide memoizing client.
 *
 * Convenience for callers with nothing to configure (the endereço forms). Code
 * that needs isolation — tests, or anything wanting its own cache or timeout —
 * should build its own client with {@link createViaCepClient}.
 */
export function buscarCep(cep: string): Promise<EnderecoViaCep | null> {
  defaultClient ??= createViaCepClient();
  return defaultClient.buscarCep(cep);
}
