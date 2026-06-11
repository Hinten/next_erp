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
  loadCertificateFromEnv,
  type AnServiceUrls,
  type NFeCertificate,
  type NfeServiceUrls,
  type SvcServiceUrls,
} from '@delfrance/integrations-nfe';

export type Ambiente = 'producao' | 'homologacao';
export type TpAmb = '1' | '2';

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

let cached: NFeRuntime | undefined;

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
      throw new Error(
        `Could not read the SEFAZ TLS chain at ${path}: ${err.message}. ` +
          'Run `pnpm --filter @delfrance/integrations-nfe fetch:sefaz-ca` ' +
          'to vendor it for this (UF, ambiente).',
      );
    }
    throw err;
  }
}

/**
 * Build (or return the cached) NF-e runtime. Throws on missing env vars,
 * malformed cert, expired cert, or missing TLS chain — boot-time failure
 * is the right semantics for any of these.
 */
export function getNFeRuntime(env: NodeJS.ProcessEnv = process.env): NFeRuntime {
  if (cached) return cached;

  const ambienteRaw = (env.NFE_AMBIENTE ?? 'homologacao').toLowerCase();
  if (ambienteRaw !== 'producao' && ambienteRaw !== 'homologacao') {
    throw new Error(`NFE_AMBIENTE must be 'producao' or 'homologacao', got '${ambienteRaw}'`);
  }
  const ambiente = ambienteRaw as Ambiente;
  const uf = (env.NFE_UF ?? 'SP').toUpperCase();

  const cert = loadCertificateFromEnv(env);
  assertCertNotExpired(cert); // belt + suspenders — loadCertificateFromEnv warns; we throw

  const { ca, source: chainSource } = loadChain(uf, ambiente);
  const agent = createSefazAgent(cert, { ca });

  const endpoints = getEndpoints(uf, ambiente);
  const tpAmb: TpAmb = ambiente === 'producao' ? '1' : '2';

  // Lazy per-authorizer SVC transport. `loadChain` reuses the
  // `sefaz-<slot>-<ambiente>.pem` naming with the authorizer in the UF slot.
  const svcCache = new Map<string, ContingencyTarget>();
  const svc = (authorizer: 'svc-an' | 'svc-rs'): ContingencyTarget => {
    let entry = svcCache.get(authorizer);
    if (!entry) {
      const { ca } = loadChain(authorizer, ambiente);
      entry = {
        endpoints: getSvcEndpoints(authorizer, ambiente),
        agent: createSefazAgent(cert, { ca }),
      };
      svcCache.set(authorizer, entry);
    }
    return entry;
  };

  // Lazy Ambiente Nacional transport (EPEC). Same chain-naming convention.
  let anCache: { endpoints: AnServiceUrls; agent: https.Agent } | undefined;
  const an = (): { endpoints: AnServiceUrls; agent: https.Agent } => {
    if (!anCache) {
      const { ca } = loadChain('an', ambiente);
      anCache = { endpoints: getAnEndpoints(ambiente), agent: createSefazAgent(cert, { ca }) };
    }
    return anCache;
  };

  cached = {
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
  return cached;
}

/** Test-only: clear the singleton so each test sees a fresh boot. */
export function __resetNFeRuntimeForTests(): void {
  cached = undefined;
}
