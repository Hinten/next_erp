import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, gitLsFiles } from './lib/repo-scan.js';

/**
 * Repo invariant (#1094): every HTTP client budget that must never fire BEFORE
 * its backend gives up — the `longo` tier — waits past that backend's request
 * ceiling plus a margin.
 *
 * Why the invariant is load-bearing. No route in this repo observes a client
 * abort, and Cloud Run keeps processing a request even after its own 504. So a
 * client deadline that fires while the server is still running a
 * non-idempotent operation (an NF-e emission mid-SOAP with SEFAZ, a Melhor Envio
 * label purchase) frees the operator to repeat it OVER the live run. The
 * `longo` tier is the set of methods where that overlap duplicates an effect,
 * and its whole safety argument is ONE inequality: it outlasts the platform's
 * own 504, so it opens no window that 504 does not already open.
 *
 * That inequality spans two files nobody edits together — a client constant in
 * `packages/integrations/*` and `runConfig.timeoutSeconds` in
 * `apps/<backend>/apphosting.yaml`. Raising the backend's timeout (say, so a
 * slow `verificar` loop can finish) silently reopens the overlap, and nothing
 * else would fail. This file is that signal.
 *
 * The margin covers what the CLIENT clock sees before the server's clock starts:
 * the CORS preflight and a cold start of a scale-to-zero backend.
 *
 * ⚠️ When `apphosting.yaml` pins no `timeoutSeconds`, the ceiling is App
 * Hosting's documented default, 5 min (Firebase blog, 2024-09, "The request
 * timeout limit is now 5m"). Whether App Hosting honours the field at all is
 * undocumented (its configure page does not list it); the #1094 program reads
 * the deployed value with `gcloud run services describe` before relying on a
 * pin. Either way the guard compares against the LARGER of the two, so a pin
 * the platform ignores can only make this stricter, never looser.
 *
 * A test rather than an ESLint rule because it compares TypeScript constants
 * against YAML, which ESLint (one JS/TS file at a time) never sees.
 */

/** App Hosting's documented default request timeout, when a backend pins none. */
const TETO_APP_HOSTING_PADRAO_S = 300;

/** Client-side time before the server's clock starts: CORS preflight + cold start. */
const MARGEM_MS = 60_000;

/**
 * One row per budget that must outlast a backend. `constante` names an exported
 * `{ curto, longo }` object in `cliente`; its `longo` is the value checked.
 *
 * ⚠️ Every HTTP client that grows a `longo` tier adds a row here (the #1094
 * program's F3 sweep adds the channel clients). Server LEASES go in `LEASES`
 * below (the comprar claim, #1677).
 */
const LINHAS = [
  {
    cliente: 'packages/integrations/freight-br/src/http-client/client.ts',
    constante: 'FREIGHT_PRAZO_MS',
    backend: 'apps/melhor-envio',
  },
  {
    cliente: 'packages/integrations/nfe/src/http-provider/client.ts',
    constante: 'NFE_PRAZO_MS',
    backend: 'apps/nfe',
  },
];

/**
 * One row per server-side LEASE that must outlast its backend's ceiling (#1677).
 * `constante` names an exported scalar `export const X = <ms>;` in `arquivo`.
 *
 * The inequality is the same one as the client rows', for the same reason seen
 * from the server: a lease that expires while the request that holds it can
 * still be running lets a SECOND request take over a non-idempotent operation
 * the first is still performing — for the comprar claim, paying for a second
 * label. So the lease must outlive the platform's own 504 plus the margin.
 */
const LEASES = [
  {
    arquivo: 'apps/melhor-envio/lib/freight/compraEtiqueta.ts',
    constante: 'COMPRA_ETIQUETA_LEASE_MS',
    backend: 'apps/melhor-envio',
  },
];

/**
 * One row per server-side PAID WINDOW (#1677): the latest a non-idempotent step
 * may START inside a request. It is the INVERSE inequality — the window must
 * close at least {@link MARGEM_JANELA_MS} before the platform gives up, so a paid
 * step is never begun in a request about to be abandoned — and therefore uses
 * the SMALLEST pinned ceiling, not the largest.
 */
const JANELAS = [
  {
    arquivo: 'apps/melhor-envio/lib/freight/compraEtiqueta.ts',
    constante: 'COMPRA_ETIQUETA_JANELA_PAGA_MS',
    backend: 'apps/melhor-envio',
  },
];

/** Room between a paid window closing and the platform's 504. */
const MARGEM_JANELA_MS = 30_000;

/** The SMALLEST ceiling a backend can run under, in seconds (the default when unpinned). */
function menorTetoDoBackendS(backend) {
  const { pinados } = tetoDoBackendS(backend);
  return pinados.length > 0 ? Math.min(...pinados) : TETO_APP_HOSTING_PADRAO_S;
}

/**
 * The value of `export const <constante> = 360_000;`. Numeric separators are
 * allowed; anything the regex cannot read is `null` and fails the anti-vacuity
 * assertion rather than passing silently.
 */
function lerEscalarMs(fonte, constante) {
  const m = new RegExp(`export const ${constante}\\s*=\\s*([\\d_]+)\\s*;`).exec(fonte);
  if (m === null) return null;
  const ms = Number(m[1].replaceAll('_', ''));
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * The `longo` value of `export const <constante> = { …, longo: 360_000 } …`.
 * Numeric separators are allowed; anything the regex cannot read is `null` and
 * fails the anti-vacuity assertion rather than passing silently.
 */
function lerLongoMs(fonte, constante) {
  const bloco = new RegExp(`export const ${constante}\\s*=\\s*\\{([^}]*)\\}`).exec(fonte);
  if (bloco === null) return null;
  const longo = /\blongo\s*:\s*([\d_]+)/.exec(bloco[1]);
  if (longo === null) return null;
  const ms = Number(longo[1].replaceAll('_', ''));
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** One `timeoutSeconds: <int>` line, optionally commented. */
const TIMEOUT_SECONDS_LINHA = /^\s*timeoutSeconds\s*:\s*(\d+)\s*(?:#.*)?$/;

/**
 * Every `timeoutSeconds` pinned in these YAML texts, plus every line that
 * MENTIONS the key but could not be read as one.
 *
 * ⚠️ Fails CLOSED: a pin the parser cannot read (`timeoutSeconds: "900"`, a
 * flow mapping `runConfig: { timeoutSeconds: 900 }`) is reported as
 * `ilegiveis` and fails the guard, instead of being dropped — dropping it would
 * compare against the 300 s default while the platform runs 900 s.
 */
function pinsDeTimeout(textos) {
  const pinados = [];
  const ilegiveis = [];
  for (const texto of textos) {
    for (const linha of texto.split(/\r?\n/)) {
      const semComentario = linha.replace(/#.*$/, '');
      if (!/timeoutSeconds/.test(semComentario)) continue;
      const m = TIMEOUT_SECONDS_LINHA.exec(linha);
      if (m === null) ilegiveis.push(linha.trim());
      else pinados.push(Number(m[1]));
    }
  }
  return { pinados, ilegiveis };
}

/**
 * The backend's request ceiling in seconds: the LARGEST `timeoutSeconds` across
 * its `apphosting*.yaml` files (per-environment overrides included), or the
 * platform default when none pins one — whichever is larger.
 */
function tetoDoBackendS(backend) {
  const arquivos = gitLsFiles(`:(glob)${backend}/apphosting*.yaml`);
  const { pinados, ilegiveis } = pinsDeTimeout(
    arquivos.map((arquivo) => readFileSync(resolve(REPO_ROOT, arquivo), 'utf8')),
  );
  return { arquivos, pinados, ilegiveis, tetoS: Math.max(TETO_APP_HOSTING_PADRAO_S, ...pinados) };
}

describe('HTTP client `longo` budgets outlast their backend ceiling (#1094)', () => {
  it('finds every client constant and backend config (anti-vacuity)', () => {
    expect(LINHAS.length).toBeGreaterThanOrEqual(2);
    for (const { cliente, constante, backend } of LINHAS) {
      const fonte = readFileSync(resolve(REPO_ROOT, cliente), 'utf8');
      expect(lerLongoMs(fonte, constante), `${cliente}: ${constante}.longo`).not.toBeNull();
      expect(
        tetoDoBackendS(backend).arquivos.length,
        `${backend}/apphosting*.yaml`,
      ).toBeGreaterThan(0);
    }
  });

  it.each(LINHAS)(
    '$constante.longo ≥ the $backend ceiling + margin',
    ({ cliente, constante, backend }) => {
      const longoMs = lerLongoMs(readFileSync(resolve(REPO_ROOT, cliente), 'utf8'), constante);
      const { tetoS } = tetoDoBackendS(backend);
      expect(
        longoMs,
        `${constante}.longo (${String(longoMs)} ms) must be ≥ ${backend}'s ceiling ` +
          `(${String(tetoS)} s) + ${String(MARGEM_MS)} ms — otherwise the client can abort a ` +
          'non-idempotent request the server is still running, and the operator repeats it over the live run.',
      ).toBeGreaterThanOrEqual(tetoS * 1000 + MARGEM_MS);
    },
  );

  it.each(LINHAS)('$backend has no timeoutSeconds line the parser cannot read', ({ backend }) => {
    expect(tetoDoBackendS(backend).ilegiveis).toEqual([]);
  });

  it('reads the real pins through the SAME parser the comparison uses (not vacuous)', () => {
    // apps/mercado-livre and apps/shopee pin 180 today. Their `tetoS` is still
    // 300 (the default is larger), so assert what was PARSED, not the ceiling.
    expect(tetoDoBackendS('apps/mercado-livre').pinados).toEqual([180]);
    expect(tetoDoBackendS('apps/shopee').pinados).toEqual([180]);
  });

  it('finds every server lease constant (anti-vacuity)', () => {
    expect(LEASES.length).toBeGreaterThanOrEqual(1);
    for (const { arquivo, constante } of LEASES) {
      const fonte = readFileSync(resolve(REPO_ROOT, arquivo), 'utf8');
      expect(lerEscalarMs(fonte, constante), `${arquivo}: ${constante}`).not.toBeNull();
    }
  });

  it.each(LEASES)(
    '$constante (server lease) ≥ the $backend ceiling + margin (#1677)',
    ({ arquivo, constante, backend }) => {
      const leaseMs = lerEscalarMs(readFileSync(resolve(REPO_ROOT, arquivo), 'utf8'), constante);
      const { tetoS } = tetoDoBackendS(backend);
      expect(
        leaseMs,
        `${constante} (${String(leaseMs)} ms) must be ≥ ${backend}'s ceiling (${String(tetoS)} s) + ` +
          `${String(MARGEM_MS)} ms — otherwise the lease expires while its own request can still be ` +
          'running, and a second request takes over a purchase that is still in progress.',
      ).toBeGreaterThanOrEqual(tetoS * 1000 + MARGEM_MS);
    },
  );

  it.each(JANELAS)(
    '$constante (paid window) closes ≥ 30 s before the SMALLEST $backend ceiling (#1677)',
    ({ arquivo, constante, backend }) => {
      const janelaMs = lerEscalarMs(readFileSync(resolve(REPO_ROOT, arquivo), 'utf8'), constante);
      expect(janelaMs, `${arquivo}: ${constante}`).not.toBeNull();
      const tetoS = menorTetoDoBackendS(backend);
      expect(
        janelaMs + MARGEM_JANELA_MS,
        `${constante} (${String(janelaMs)} ms) + ${String(MARGEM_JANELA_MS)} ms must be ≤ ` +
          `${backend}'s smallest ceiling (${String(tetoS)} s) — otherwise a paid step can start ` +
          'in a request the platform is about to abandon.',
      ).toBeLessThanOrEqual(tetoS * 1000);
    },
  );

  it('the scalar reader parses separators and refuses anything else', () => {
    expect(lerEscalarMs('export const X = 360_000;', 'X')).toBe(360_000);
    expect(lerEscalarMs('export const X = 5 * 60_000;', 'X')).toBeNull();
    expect(lerEscalarMs('export const Y = 1;', 'X')).toBeNull();
  });

  it('a pin above the default raises the ceiling, and an unreadable one fails closed', () => {
    const acima = pinsDeTimeout(['runConfig:\n  cpu: 1\n  timeoutSeconds: 900 # slow verificar\n']);
    expect(acima).toEqual({ pinados: [900], ilegiveis: [] });
    expect(Math.max(TETO_APP_HOSTING_PADRAO_S, ...acima.pinados)).toBe(900);

    expect(pinsDeTimeout(['runConfig:\n  timeoutSeconds: "900"\n']).ilegiveis).toEqual([
      'timeoutSeconds: "900"',
    ]);
    expect(pinsDeTimeout(['runConfig: { timeoutSeconds: 900 }\n']).ilegiveis).toHaveLength(1);
    // A comment that merely mentions the key is not a pin.
    expect(pinsDeTimeout(['# timeoutSeconds is not set on purpose\n'])).toEqual({
      pinados: [],
      ilegiveis: [],
    });
  });
});
