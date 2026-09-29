import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, gitLsFiles } from './lib/repo-scan.js';

/**
 * Repo invariant (#1680): every CORS proxy (`apps/<app>/proxy.ts`) admits every
 * HTTP verb its own routes export under its matcher.
 *
 * Why it needs a guard. `apps/web` calls each API backend CROSS-ORIGIN, so any
 * verb outside the CORS-safelisted GET/HEAD/POST triggers a preflight, and the
 * preflight answer is a hand-written literal in each proxy. `apps/nfe` exported
 * `DELETE /api/nfe/certificado` while its proxy answered
 * `Access-Control-Allow-Methods: GET, POST, OPTIONS` — so removing a filial's
 * certificate never left the browser, from the day it shipped (#162) until
 * #1680. Nothing failed: the route test calls `DELETE()` directly, the client
 * test mocks `fetch`, and the proxy test only checked origins. The two literals
 * live in different files nobody edits together, which is exactly what this
 * file compares.
 *
 * The per-app copies are deliberate (independent deploys, #1431 keeps them
 * pinned rather than extracted), so this is a drift PIN, not a refactor.
 *
 * It fails LOUDLY instead of skipping whenever it cannot read something — a
 * matcher that is not `/<prefix>/:path*`, an Allow-Methods that is not a string
 * literal, or a route re-exporting its handlers — because a guard that silently
 * reads nothing passes for ever.
 */

/** CORS-safelisted methods: a cross-origin request with one of these needs no preflight. */
const SAFELISTED = new Set(['GET', 'HEAD', 'POST']);
/** What every browser client of these backends sends. */
const CABECALHOS_EXIGIDOS = ['authorization', 'content-type'];

const VERBO =
  /export\s+(?:async\s+)?(?:function|const)\s+(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b/g;
const REEXPORT = /export\s*\{[^}]*\b(GET|HEAD|POST|PUT|PATCH|DELETE)\b[^}]*\}/;

function lerLista(fonte, cabecalho, proxy) {
  const m = new RegExp(`'${cabecalho}',\\s*'([^']+)'`).exec(fonte);
  if (m === null) throw new Error(`${proxy}: no string-literal ${cabecalho} found`);
  return m[1].split(',').map((v) => v.trim());
}

function lerMatchers(fonte, proxy) {
  const bloco = /matcher:\s*(\[[^\]]*\]|'[^']*')/.exec(fonte);
  if (bloco === null) throw new Error(`${proxy}: no matcher found`);
  const matchers = [...bloco[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  if (matchers.length === 0) throw new Error(`${proxy}: empty matcher`);
  return matchers.map((matcher) => {
    const m = /^\/([\w/-]+)\/:path\*$/.exec(matcher);
    if (m === null) {
      throw new Error(`${proxy}: matcher '${matcher}' is not of the form '/<prefix>/:path*'`);
    }
    return m[1];
  });
}

function lerProxies() {
  return gitLsFiles(':(glob)apps/*/proxy.ts').map((proxy) => {
    const app = proxy.split('/')[1];
    const fonte = readFileSync(resolve(REPO_ROOT, proxy), 'utf8');
    const prefixos = lerMatchers(fonte, proxy);
    const rotas = prefixos.flatMap((prefixo) =>
      gitLsFiles(`:(glob)apps/${app}/app/${prefixo}/**/route.ts`),
    );
    const verbos = rotas.flatMap((rota) => {
      const texto = readFileSync(resolve(REPO_ROOT, rota), 'utf8');
      if (REEXPORT.test(texto)) {
        throw new Error(`${rota}: re-exports its handlers — the guard cannot read its verbs`);
      }
      return [...texto.matchAll(VERBO)].map((m) => ({ rota, verbo: m[1] }));
    });
    return {
      proxy,
      metodos: lerLista(fonte, 'Access-Control-Allow-Methods', proxy).map((m) => m.toUpperCase()),
      cabecalhos: lerLista(fonte, 'Access-Control-Allow-Headers', proxy).map((h) =>
        h.toLowerCase(),
      ),
      rotas,
      verbos,
    };
  });
}

describe('CORS proxies admit every verb their routes export (#1680)', () => {
  const proxies = lerProxies();

  it('reads every proxy, and the scan is not vacuous', () => {
    expect(proxies.length).toBeGreaterThanOrEqual(7);
    for (const p of proxies)
      expect(p.rotas.length, `${p.proxy}: routes under its matcher`).toBeGreaterThan(0);
    const todos = proxies.flatMap((p) => p.verbos.map((v) => v.verbo));
    // Anchors: the verbs that NEED a preflight exist somewhere, so a broken
    // verb regex cannot pass by finding only GETs and POSTs.
    expect(todos).toContain('DELETE');
    expect(todos).toContain('PATCH');
  });

  it.each(proxies.map((p) => [p.proxy, p]))('%s admits every non-safelisted verb', (_nome, p) => {
    const faltando = p.verbos
      .filter(({ verbo }) => !SAFELISTED.has(verbo) && verbo !== 'OPTIONS')
      .filter(({ verbo }) => !p.metodos.includes(verbo))
      .map(({ rota, verbo }) => `${verbo} ${rota}`);
    expect(
      faltando,
      `${p.proxy} answers the preflight with "${p.metodos.join(', ')}", so the browser refuses ` +
        'these cross-origin requests before they are sent',
    ).toEqual([]);
  });

  it.each(proxies.map((p) => [p.proxy, p]))(
    '%s admits the Authorization and Content-Type headers',
    (_nome, p) => {
      expect(p.cabecalhos).toEqual(expect.arrayContaining(CABECALHOS_EXIGIDOS));
    },
  );
});
