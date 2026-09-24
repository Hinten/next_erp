/**
 * Production-safety guard — TWO tiers, because the two boundaries differ in what
 * they can actually cause.
 *
 * The default is **homologação only**: any call that asks SEFAZ to act on
 * `tpAmb='1'` (produção) is rejected unless the caller has explicitly opted in via
 * `NFE_ALLOW_PRODUCAO=true`.
 *
 * ⚠️ `assertSafeTpAmb` lets Vitest through automatically (it sets
 * `NODE_ENV='test'`), so the generator tests that exercise the produção branch keep
 * working without ceremony. That passthrough is fine where produção XML is merely
 * BUILT — no socket opens — and it is exactly wrong at the point of transport: the
 * `nfe-live` CI job is itself Vitest, so `NODE_ENV='test'` holds for the entire live
 * suite and this guard was a no-op in the one place it had to hold. The header used
 * to claim it made production traffic from "a test harness" impossible; a test
 * harness was the single case it did not block.
 *
 * So anything that can reach the network calls {@link assertSafeTpAmbForTransport}
 * instead, which honours `NFE_ALLOW_PRODUCAO` and nothing else.
 *
 * ⚠️ That guard judges the call's `tpAmb` LABEL, and the label and the URL are
 * independent fields of `SefazCall`: `{ tpAmb: '2', url: <produção host> }` sails
 * through it. {@link assertSafeEndpointForTransport} closes that by judging the
 * destination itself.
 *
 *   assertSafeTpAmb                 — the NF-e generator, before any work.
 *   assertSafeTpAmbForTransport     — every SOAP operation, immediately before the POST.
 *   assertSafeEndpointForTransport  — the same boundaries, on the URL rather than the label.
 */

import { sefazHostsFor } from '../endpoints';

export class NFeProductionGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFeProductionGuardError';
  }
}

/** SEFAZ `tpAmb` literal — `'1'` produção, `'2'` homologação. */
export type TpAmb = '1' | '2';

/**
 * Reject a `tpAmb='1'` (produção) call unless either:
 *   - `process.env.NFE_ALLOW_PRODUCAO === 'true'` (explicit opt-in), or
 *   - `process.env.NODE_ENV === 'test'` (Vitest sets this).
 *
 * `tpAmb='2'` (homologação) always passes through without checks.
 *
 * Wired at exactly one place: `generateNFe` (`src/generator/index.ts`), where
 * produção XML can legitimately be built under test without anything being sent.
 *
 * ⚠️ NOT at a boundary that can open a socket — use
 * {@link assertSafeTpAmbForTransport} there, or the guard evaporates under any
 * Vitest-driven live suite. And if you add a second call site, say where: this
 * docstring claimed the generator boundary for months while the function had **zero**
 * production callers, which is precisely the kind of drift that let the transport
 * hole survive.
 */
export function assertSafeTpAmb(tpAmb: TpAmb): void {
  if (tpAmb === '2') return;
  if (process.env.NFE_ALLOW_PRODUCAO === 'true') return;
  if (process.env.NODE_ENV === 'test') return;
  throw new NFeProductionGuardError(
    "tpAmb='1' (produção) requires NFE_ALLOW_PRODUCAO=true. " +
      "Use tpAmb='2' (homologação) for non-production work.",
  );
}

/**
 * The same guard with **no test passthrough** — `NFE_ALLOW_PRODUCAO=true` is the
 * only thing that clears it, ever.
 *
 * Call this immediately before anything that can put bytes on the wire to SEFAZ.
 *
 * ⚠️ Do not "simplify" this back into {@link assertSafeTpAmb}. The whole point is
 * that `NODE_ENV='test'` is not evidence of safety at this boundary: `nfe-live`
 * runs the live homologação suites through Vitest against the real SEFAZ endpoints,
 * so the test passthrough covered precisely the traffic the guard existed to stop.
 * What keeps CI on homologação today — `*.homologacao` suite names, hardcoded
 * `tpAmb: '2'`, `getEndpoints(uf, 'homologacao')` — is convention. This is the
 * enforcement.
 */
export function assertSafeTpAmbForTransport(tpAmb: TpAmb): void {
  if (tpAmb === '2') return;
  if (process.env.NFE_ALLOW_PRODUCAO === 'true') return;
  throw new NFeProductionGuardError(
    "tpAmb='1' (produção) transport requires NFE_ALLOW_PRODUCAO=true. " +
      "Use tpAmb='2' (homologação) for non-production work. " +
      'NODE_ENV=test does NOT clear this guard: the live CI suites are themselves ' +
      'Vitest, so a test passthrough here would be no guard at all.',
  );
}

let producaoOnlyHosts: ReadonlySet<string> | null = null;

/**
 * Hostnames that serve ONLY produção: every produção host in the endpoint
 * tables minus any host a homologação table also routes to. Lazy + memoised —
 * the tables are static.
 *
 * The subtraction is load-bearing: `cad.svrs.rs.gov.br` answers Consulta Cadastro
 * for BOTH ambientes (see `sefazHostsFor`), so treating it as produção would block
 * legitimate homologação traffic. On such a shared host only the `tpAmb` label —
 * {@link assertSafeTpAmbForTransport} — can tell the two apart.
 */
export function producaoOnlySefazHosts(): ReadonlySet<string> {
  if (producaoOnlyHosts == null) {
    const homologacao = sefazHostsFor('homologacao');
    producaoOnlyHosts = new Set(
      [...sefazHostsFor('producao')].filter((host) => !homologacao.has(host)),
    );
  }
  return producaoOnlyHosts;
}

/** Lower-cased hostname without a trailing root dot, or `null` when `url` is not a URL. */
function sefazHostOf(url: string): string | null {
  if (!URL.canParse(url)) return null;
  return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
}

/**
 * The transport guard on the DESTINATION rather than the label. Call it next to
 * {@link assertSafeTpAmbForTransport}, immediately before anything that can put
 * bytes on the wire to SEFAZ.
 *
 * For a produção-only SEFAZ host ({@link producaoOnlySefazHosts}):
 *   - `tpAmb='2'` always throws — the label says homologação while the URL says
 *     produção, and no env var makes that disagreement safe to send;
 *   - `tpAmb='1'` throws unless `NFE_ALLOW_PRODUCAO === 'true'` (the same opt-in
 *     as the label guard, and likewise no `NODE_ENV='test'` passthrough).
 *
 * Any other URL (homologação hosts, the shared dual-ambiente host, test fakes
 * such as `https://example/…`) is left to the label guard.
 */
export function assertSafeEndpointForTransport(url: string, tpAmb: TpAmb): void {
  const host = sefazHostOf(url);
  if (host == null || !producaoOnlySefazHosts().has(host)) return;
  if (tpAmb === '2') {
    throw new NFeProductionGuardError(
      `tpAmb='2' (homologação) aimed at the produção-only SEFAZ host '${host}': ` +
        'the ambiente label and the URL disagree, refusing to send.',
    );
  }
  if (process.env.NFE_ALLOW_PRODUCAO === 'true') return;
  throw new NFeProductionGuardError(
    `The produção-only SEFAZ host '${host}' requires NFE_ALLOW_PRODUCAO=true. ` +
      'NODE_ENV=test does NOT clear this guard.',
  );
}

/** Map a generator `ambiente` value to the SEFAZ `tpAmb` literal. */
export function tpAmbFromAmbiente(ambiente: 'producao' | 'homologacao'): TpAmb {
  return ambiente === 'producao' ? '1' : '2';
}
