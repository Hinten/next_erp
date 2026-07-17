/**
 * Process-level NF-e runtime — cert, mTLS agent, SEFAZ endpoints.
 *
 * The expensive setup (PFX decode + agent construction + chain file read)
 * happens once per process; subsequent route hits reuse the cached
 * runtime. **No request should call `loadCertificateFromEnv` directly** —
 * always go through `getNFeRuntime`.
 *
 * Boot fails hard if:
 *   - the A1 cert is missing or expired
 *   - the SEFAZ TLS chain isn't vendored under
 *     `packages/integrations/nfe/ca/sefaz-<uf>-<ambiente>.pem`
 *
 * `warnIfCertNearExpiry` fires automatically inside
 * `loadCertificateFromEnv` and writes to `console.warn` — the App
 * Hosting logger captures it.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type https from 'node:https';

import {
  assertCertNotExpired,
  createSefazAgent,
  getAnEndpoints,
  getEndpoints,
  getSvcEndpoints,
  hasNFeCertEnv,
  loadCertificateFromEnv,
  type AnServiceUrls,
  type NFeCertificate,
  type NfeServiceUrls,
  type SvcServiceUrls,
} from '@delfrance/integrations-nfe';

export type Ambiente = 'producao' | 'homologacao';
export type TpAmb = '1' | '2';

/**
 * NF-e runtime configuration/boot failure — a bad `NFE_AMBIENTE` or a missing
 * / unreadable vendored SEFAZ TLS chain. Thrown by `getNFeRuntime` (eagerly)
 * and by the lazy chain loads (`svc()` / `an()` / `envRuntime()`), so routes
 * can narrow "the runtime is misconfigured" (→ 503) without a bare
 * `instanceof Error` check.
 */
export class NFeRuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFeRuntimeConfigError';
  }
}

/** A contingency authorizer's resolved transport: its URLs + an mTLS agent pinned to ITS chain. */
export interface ContingencyTarget {
  readonly endpoints: SvcServiceUrls;
  readonly agent: https.Agent;
}

export interface NFeRuntime {
  readonly cert: NFeCertificate;
  readonly agent: https.Agent;
  readonly ambiente: Ambiente;
  readonly uf: string;
  readonly tpAmb: TpAmb;
  readonly endpoints: NfeServiceUrls;
  /**
   * Resolve an SVC authorizer's endpoints + agent. **Lazy** — the SVC TLS
   * chain (`ca/sefaz-svc-an-<ambiente>.pem`) is only read on first use, so a
   * deploy without the SVC chain boots fine and only fails if contingency is
   * actually activated. Cached per authorizer for the process lifetime.
   */
  readonly svc: (authorizer: 'svc-an' | 'svc-rs') => ContingencyTarget;
  /**
   * Resolve the Ambiente Nacional transport (EPEC evento drop-box). Lazy and
   * cached exactly like `svc` — chain at `ca/sefaz-an-<ambiente>.pem`.
   */
  readonly an: () => { readonly endpoints: AnServiceUrls; readonly agent: https.Agent };
  /** Subject CN of the loaded cert, plus its notAfter — surfaced by /api/health. */
  readonly diagnostics: {
    readonly subjectCommonName: string;
    readonly notAfter: string;
    readonly chainSource: string;
  };
}

/**
 * Cert-INDEPENDENT base runtime returned by `getNFeRuntime`. The process boots
 * with NO signing cert: every SEFAZ call derives a per-filial `NFeRuntime` via
 * `deriveRuntimeForCert` (see `lib/nfe/filial-cert.ts`). The env cert
 * (`NFE_CERT_*`) is **optional** — `envRuntime()` builds it lazily as the
 * `NFE_CERT_ENV_FALLBACK` signing cert + the `/api/health` diagnostics; it is
 * `null` when no env cert is configured.
 */
export interface NFeBaseRuntime {
  readonly ambiente: Ambiente;
  readonly uf: string;
  readonly tpAmb: TpAmb;
  readonly endpoints: NfeServiceUrls;
  /**
   * The env-cert runtime, built lazily on first call (fallback + health).
   * `null` when `NFE_CERT_*` is unset. Throws on a malformed/expired env cert,
   * but only when actually accessed — so boot never depends on the env cert.
   */
  readonly envRuntime: () => NFeRuntime | null;
}

let cachedBase: NFeBaseRuntime | undefined;

/**
 * Resolve the vendored chain path inside the workspace package.
 *
 * Three strategies, tried in order — first hit wins:
 *   1. `NFE_CA_DIR` env override — for production / non-standard layouts.
 *   2. `createRequire(import.meta.url).resolve(...)` — the original
 *      "find the library's own ca/" approach. Works in plain Node and
 *      production builds, but Turbopack dev rewrites `import.meta.url`
 *      to a virtual `[project]/...` path; `require.resolve` returns
 *      that virtual path verbatim, and Node treats it as relative —
 *      `readFileSync` then prepends `process.cwd()` and ENOENTs. We
 *      validate with `existsSync` and fall through on a miss.
 *   3. Cwd-relative — `apps/nfe` runs from `<repo>/apps/nfe/` in dev,
 *      and the chain lives at `<repo>/packages/integrations/nfe/ca/`.
 *      Walk two levels up. Brittle to repo layout but reliable in dev.
 */
function resolveChainPath(uf: string, ambiente: Ambiente): string {
  const filename = `sefaz-${uf.toLowerCase()}-${ambiente}.pem`;

  const overrideDir = process.env.NFE_CA_DIR;
  if (overrideDir) return join(overrideDir, filename);

  try {
    const require_ = createRequire(import.meta.url);
    const pkgJsonPath = require_.resolve('@delfrance/integrations-nfe/package.json');
    const candidate = join(dirname(pkgJsonPath), 'ca', filename);
    if (existsSync(candidate)) return candidate;
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    // require.resolve failures fall through to the cwd-relative walk.
  }

  return resolve(process.cwd(), '..', '..', 'packages', 'integrations', 'nfe', 'ca', filename);
}

function loadChain(uf: string, ambiente: Ambiente): { ca: string; source: string } {
  const path = resolveChainPath(uf, ambiente);
  try {
    return { ca: readFileSync(path, 'utf8'), source: path };
  } catch (err) {
    if (err instanceof Error) {
      throw new NFeRuntimeConfigError(
        `Could not read the SEFAZ TLS chain at ${path}: ${err.message}. ` +
          'Run `pnpm --filter @delfrance/integrations-nfe fetch:sefaz-ca` ' +
          'to vendor it for this (UF, ambiente).',
      );
    }
    throw err;
  }
}

/**
 * Process-level cache of vendored TLS chains, keyed `${slot}-${ambiente}`.
 * The chain bytes are cert-independent, so deriving a per-filial runtime
 * reuses them instead of re-reading the .pem off disk on every emission.
 */
const chainCache = new Map<string, { ca: string; source: string }>();
function loadChainCached(uf: string, ambiente: Ambiente): { ca: string; source: string } {
  const key = `${uf.toLowerCase()}-${ambiente}`;
  let entry = chainCache.get(key);
  if (!entry) {
    entry = loadChain(uf, ambiente);
    chainCache.set(key, entry);
  }
  return entry;
}

/**
 * Assemble an `NFeRuntime` for a specific certificate over the (cached) TLS
 * chains for `(uf, ambiente)`. The home + SVC + AN mTLS agents are all bound
 * to THIS cert — so swapping the cert (per filial) is enough to make every
 * SEFAZ call present and sign with the right identity. The chains are
 * cert-independent and shared via `loadChainCached`. Pure of `process.env`.
 */
function buildRuntime(cert: NFeCertificate, ambiente: Ambiente, uf: string): NFeRuntime {
  const { ca, source: chainSource } = loadChainCached(uf, ambiente);
  const agent = createSefazAgent(cert, { ca });

  const endpoints = getEndpoints(uf, ambiente);
  const tpAmb: TpAmb = ambiente === 'producao' ? '1' : '2';

  // Lazy per-authorizer SVC transport. `loadChainCached` reuses the
  // `sefaz-<slot>-<ambiente>.pem` naming with the authorizer in the UF slot.
  const svcCache = new Map<string, ContingencyTarget>();
  const svc = (authorizer: 'svc-an' | 'svc-rs'): ContingencyTarget => {
    let entry = svcCache.get(authorizer);
    if (!entry) {
      const chain = loadChainCached(authorizer, ambiente);
      entry = {
        endpoints: getSvcEndpoints(authorizer, ambiente),
        agent: createSefazAgent(cert, { ca: chain.ca }),
      };
      svcCache.set(authorizer, entry);
    }
    return entry;
  };

  // Lazy Ambiente Nacional transport (EPEC). Same chain-naming convention.
  let anCache: { endpoints: AnServiceUrls; agent: https.Agent } | undefined;
  const an = (): { endpoints: AnServiceUrls; agent: https.Agent } => {
    if (!anCache) {
      const chain = loadChainCached('an', ambiente);
      anCache = {
        endpoints: getAnEndpoints(ambiente),
        agent: createSefazAgent(cert, { ca: chain.ca }),
      };
    }
    return anCache;
  };

  return {
    cert,
    agent,
    ambiente,
    uf,
    tpAmb,
    endpoints,
    svc,
    an,
    diagnostics: {
      subjectCommonName: cert.subjectCommonName,
      notAfter: cert.notAfter.toISOString(),
      chainSource,
    },
  };
}

/**
 * Build (or return the cached) BASE NF-e runtime. **Boots without a signing
 * cert** — per-filial emission derives its own runtime via `deriveRuntimeForCert`
 * (see `lib/nfe/filial-cert.ts`). The env cert (`NFE_CERT_*`) is OPTIONAL: it's
 * loaded lazily by `envRuntime()` as the `NFE_CERT_ENV_FALLBACK` signing cert +
 * the `/api/health` diagnostics. Throws on a bad `NFE_AMBIENTE` or a missing TLS
 * chain (validated eagerly, cert-free), but NOT on a missing/expired env cert.
 */
export function getNFeRuntime(env: NodeJS.ProcessEnv = process.env): NFeBaseRuntime {
  if (cachedBase) return cachedBase;

  const ambienteRaw = (env.NFE_AMBIENTE ?? 'homologacao').toLowerCase();
  if (ambienteRaw !== 'producao' && ambienteRaw !== 'homologacao') {
    throw new NFeRuntimeConfigError(
      `NFE_AMBIENTE must be 'producao' or 'homologacao', got '${ambienteRaw}'`,
    );
  }
  const ambiente = ambienteRaw as Ambiente;
  const uf = (env.NFE_UF ?? 'SP').toUpperCase();

  // Boot-time guard: the home TLS chain must be vendored (cert not needed).
  loadChainCached(uf, ambiente);

  // Lazy env-cert runtime — `undefined` = not yet resolved, `null` = no env cert.
  let envRt: NFeRuntime | null | undefined;
  const envRuntime = (): NFeRuntime | null => {
    if (envRt === undefined) {
      if (hasNFeCertEnv(env)) {
        const cert = loadCertificateFromEnv(env);
        assertCertNotExpired(cert);
        envRt = buildRuntime(cert, ambiente, uf);
      } else {
        envRt = null;
      }
    }
    return envRt;
  };

  cachedBase = {
    ambiente,
    uf,
    tpAmb: ambiente === 'producao' ? '1' : '2',
    endpoints: getEndpoints(uf, ambiente),
    envRuntime,
  };
  return cachedBase;
}

/**
 * Derive a runtime that signs + transmits with `cert` (a filial's A1), reusing
 * the base runtime's ambiente/uf and the cached TLS chains. The caller
 * (`resolveFilialRuntime`) runs the expiry check on `cert` first.
 */
export function deriveRuntimeForCert(base: NFeBaseRuntime, cert: NFeCertificate): NFeRuntime {
  return buildRuntime(cert, base.ambiente, base.uf);
}

/** Test-only: clear the base singleton + chain cache so each test sees a fresh boot. */
export function __resetNFeRuntimeForTests(): void {
  cachedBase = undefined;
  chainCache.clear();
}
