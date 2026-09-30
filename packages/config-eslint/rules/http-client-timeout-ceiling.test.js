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
 * program's F3 sweep adds the channel clients, F1a/F2 add their leases).
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
