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
 * The per-app proxy copies are deliberate (independent deploys), so this pins
 * each one against its OWN routes rather than extracting a shared helper — the
 * same "pin" style as the still-open #1431 decision for `verifyCaller`/hmac. It
 * does not compare the copies with each other.
 *
 * Routes are found by URL, not by folder: every `route.{ts,tsx,js,mjs}` under
 * `apps/<app>/app`, with route-group `(…)` and parallel-slot `@…` segments
 * dropped (Next serves `app/(x)/api/nfe/foo/route.ts` at `/api/nfe/foo`), kept
 * when that URL falls under a matcher prefix.
 *
 * It fails LOUDLY instead of skipping whenever it cannot read something — a
 * matcher that is not `/<prefix>/:path*`, an Allow-Methods that is not a string
 * literal, a route whose handlers are re-exported, star-exported or
 * destructured, or a route file that yields no verb at all — because a guard
 * that silently reads nothing passes for ever.
 */

/** CORS-safelisted methods: a cross-origin request with one of these needs no preflight. */
const SAFELISTED = new Set(['GET', 'HEAD', 'POST']);
/** What every browser client of these backends sends. */
const CABECALHOS_EXIGIDOS = ['authorization', 'content-type'];

const ARQUIVO_DE_ROTA = /\/route\.(?:ts|tsx|js|mjs)$/;
const VERBO =
  /export\s+(?:async\s+)?(?:function|const|let|var)\s+(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b/g;
/** Export shapes whose verbs this text scan cannot read — each one fails loudly. */
const ILEGIVEIS = [
  ['re-exports its handlers', /export\s*\{[^}]*\b(GET|HEAD|POST|PUT|PATCH|DELETE)\b[^}]*\}/],
  ['star-exports another module', /export\s*\*/],
  ['exports destructured bindings', /export\s+(?:const|let|var)\s*[{[]/],
];

/** The URL path Next serves `apps/<app>/app/<…>/route.ts` at, without slashes at the ends. */
function caminhoDaRota(rota, app) {
  return rota
    .slice(`apps/${app}/app/`.length)
    .split('/')
    .slice(0, -1)
    .filter((seg) => !/^\(.*\)$/.test(seg) && !seg.startsWith('@'))
    .join('/');
}

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
    const rotas = gitLsFiles(`:(glob)apps/${app}/app/**/route.*`)
      .filter((rota) => ARQUIVO_DE_ROTA.test(rota))
      .filter((rota) => {
        const caminho = caminhoDaRota(rota, app);
        return prefixos.some((p) => caminho === p || caminho.startsWith(`${p}/`));
      });
    const verbos = rotas.flatMap((rota) => {
      const texto = readFileSync(resolve(REPO_ROOT, rota), 'utf8');
      for (const [motivo, padrao] of ILEGIVEIS) {
        if (padrao.test(texto)) {
          throw new Error(`${rota}: ${motivo} — the guard cannot read its verbs`);
        }
      }
      const achados = [...texto.matchAll(VERBO)].map((m) => ({ rota, verbo: m[1] }));
      if (achados.length === 0) {
        throw new Error(`${rota}: no \`export function|const VERB\` found — cannot read its verbs`);
      }
      return achados;
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

describe('the readers the guard rests on', () => {
  it('maps a route file to the URL Next serves it at', () => {
    expect(caminhoDaRota('apps/nfe/app/api/nfe/certificado/route.ts', 'nfe')).toBe(
      'api/nfe/certificado',
    );
    // Route groups and parallel slots are not URL segments.
    expect(caminhoDaRota('apps/nfe/app/(interno)/api/nfe/foo/route.ts', 'nfe')).toBe('api/nfe/foo');
    expect(caminhoDaRota('apps/nfe/app/api/@slot/nfe/bar/route.tsx', 'nfe')).toBe('api/nfe/bar');
  });

  it.each([
    ['export async function DELETE(req) {}', ['DELETE']],
    ['export const PATCH = handler;', ['PATCH']],
    ['export let DELETE = h;', ['DELETE']],
    ["export const dynamic = 'force-dynamic';\nexport function GET() {}", ['GET']],
  ])('reads the verbs of %j', (texto, esperados) => {
    expect([...texto.matchAll(VERBO)].map((m) => m[1])).toEqual(esperados);
  });

  it.each([
    'export { handler as DELETE };',
    "export * from './impl';",
    'export const { GET, DELETE } = handlers;',
    'export let [GET] = pair;',
  ])('refuses to guess at %j', (texto) => {
    expect(ILEGIVEIS.some(([, padrao]) => padrao.test(texto))).toBe(true);
  });
});

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
