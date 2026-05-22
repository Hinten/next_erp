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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type https from 'node:https';

import {
  assertCertNotExpired,
  createSefazAgent,
  getEndpoints,
  loadCertificateFromEnv,
  type NFeCertificate,
  type NfeServiceUrls,
} from '@delfrance/integrations-nfe';

export type Ambiente = 'producao' | 'homologacao';
export type TpAmb = '1' | '2';

export interface NFeRuntime {
  readonly cert: NFeCertificate;
  readonly agent: https.Agent;
  readonly ambiente: Ambiente;
  readonly uf: string;
  readonly tpAmb: TpAmb;
  readonly endpoints: NfeServiceUrls;
  /** Subject CN of the loaded cert, plus its notAfter — surfaced by /api/health. */
  readonly diagnostics: {
    readonly subjectCommonName: string;
    readonly notAfter: string;
    readonly chainSource: string;
  };
}

let cached: NFeRuntime | undefined;

/** Resolve the vendored chain path inside the workspace package. */
function resolveChainPath(uf: string, ambiente: Ambiente): string {
  // `createRequire` lets us resolve a workspace package's own files
  // without depending on `import.meta.resolve` (which Next's build may
  // not preserve). We look up the library's package.json, then read
  // sibling ca/*.pem files.
  const require_ = createRequire(import.meta.url);
  const pkgJsonPath = require_.resolve('@delfrance/integrations-nfe/package.json');
  const pkgDir = dirname(pkgJsonPath);
  return join(pkgDir, 'ca', `sefaz-${uf.toLowerCase()}-${ambiente}.pem`);
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

  cached = {
    cert,
    agent,
    ambiente,
    uf,
    tpAmb,
    endpoints,
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
