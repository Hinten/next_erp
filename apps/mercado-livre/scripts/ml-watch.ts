/**
 * The weekly Mercado Livre integration watch — IO shell.
 *
 *   pnpm --filter @delfrance/mercado-livre-app watch:ml \
 *     --report out/ml-watch-report.md \
 *     --baseline-out out/ml-watch-baseline.json \
 *     --token-out out/ml-new-refresh-token.txt
 *
 * ⚠️ No `--` separator before the flags. pnpm forwards the literal `--` INTO the
 * script, which then rejects it — verified on the pinned pnpm and guarded by
 * `packages/config-eslint/rules/pnpm-run-args.test.js`, which has caught this
 * exact defect three times.
 *
 * All decision logic is pure and unit-tested in `lib/marketplace/watch/`; this
 * file only fetches, reads and writes. Run by
 * `.github/workflows/ml-integration-watch.yml` and locally against the same
 * credentials.
 *
 * ## Credential
 * Uses the **application owner's** grant, not a seller integração — a different
 * ML account, held by no deployed backend, so refreshing it here cannot race the
 * backend's single-use token. That is what makes this the one place a CI job may
 * legitimately hold an ML credential.
 *
 * ⚠️ **ML has no `client_credentials` grant** (only `authorization_code` and
 * `refresh_token`), so the token rotates on every run and the NEW one must be
 * persisted or the next run dies with `invalid_grant`. The rotation is written
 * to `--token-out` as the very first thing after the refresh, before any other
 * work, and the file is the workflow's to store and delete.
 *
 * ⚠️ **The token is never logged, never echoed and never put in a URL.** ML's
 * own integrator notice is precisely about query-parameter tokens; it goes in
 * the `Authorization` header. #1015 is this repo's worked example of a
 * credential reaching a log stream.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  BASELINE_VAZIA,
  type WatchBaseline,
  type WatchSignals,
  diffWatch,
  proximaBaseline,
  renderReport,
  temNovidade,
} from '../lib/marketplace/watch/watchDiff';
import {
  parseApplication,
  parseConsumption,
  parseNotices,
} from '../lib/marketplace/watch/watchSignals';

const API = 'https://api.mercadolibre.com';
const USER_AGENT = '@delfrance/erp-next';

function log(message: string): void {
  // eslint-disable-next-line no-console -- CLI output
  console.log(message);
}

class WatchArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatchArgError';
  }
}

/**
 * A non-2xx from any watch endpoint.
 *
 * ⚠️ `body` is NON-ENUMERABLE, mirroring `FixtureCaptureHttpError`. An uncaught
 * throw becomes an unhandled rejection, and Node's handler `util.inspect`s the
 * error — appending every own ENUMERABLE property. On the `/oauth/token` call
 * that body is a credential response.
 */
class WatchHttpError extends Error {
  readonly endpoint: string;
  readonly status: number;
  readonly body!: string;

  constructor(endpoint: string, status: number, body: string) {
    super(`Mercado Livre respondeu ${status} em ${endpoint}.`);
    this.name = 'WatchHttpError';
    this.endpoint = endpoint;
    this.status = status;
    Object.defineProperty(this, 'body', { value: body, enumerable: false });
  }
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new WatchArgError(
      `${name} não está definido. O watch precisa do grant do usuário OWNER da aplicação.`,
    );
  }
  return value;
}

async function get(path: string, accessToken: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      // ⚠️ Header, never a query parameter — see the module header.
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': USER_AGENT,
    },
  });
  const texto = await res.text();
  if (!res.ok) throw new WatchHttpError(path, res.status, texto);
  return JSON.parse(texto) as unknown;
}

interface RefreshResult {
  readonly accessToken: string;
  readonly refreshToken: string;
}

async function refresh(): Promise<RefreshResult> {
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: requiredEnv('MERCADO_LIVRE_CLIENT_ID'),
      client_secret: requiredEnv('MERCADO_LIVRE_CLIENT_SECRET'),
      refresh_token: requiredEnv('ML_OWNER_REFRESH_TOKEN'),
    }),
  });

  const texto = await res.text();
  if (!res.ok) {
    // ⚠️ `invalid_grant` is not a transient failure — the grant is gone and a
    // human has to re-consent. Say so in the message; the body never surfaces.
    const dica = texto.includes('invalid_grant')
      ? ' O grant do owner expirou ou já foi usado — refaça o consentimento da aplicação com a conta dona.'
      : '';
    throw new WatchHttpError(`/oauth/token${dica}`, res.status, texto);
  }

  // ⚠️ `as unknown`, then narrow — never `as Record<…>`. On a 2xx the caller
  // would otherwise get whatever arrived wearing a type nobody checked, and an
  // empty body, a proxy's HTML and a real token response are indistinguishable
  // (`delfrance/no-unvalidated-response`, #1295).
  const parsed: unknown = JSON.parse(texto);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new WatchHttpError('/oauth/token', res.status, texto);
  }
  const { access_token: accessToken, refresh_token: refreshToken } = parsed as {
    access_token?: unknown;
    refresh_token?: unknown;
  };
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
    throw new WatchHttpError('/oauth/token', res.status, texto);
  }
  return { accessToken, refreshToken };
}

/**
 * Load the previous baseline.
 *
 * ⚠️ **`ML_WATCH_BASELINE` (a repo VARIABLE) is the durable store, not the
 * file.** The first version of this script read and wrote
 * `.github/ml-watch-baseline.json` in the runner's checkout — which nothing ever
 * committed. Every run therefore started from an empty baseline, `temNovidade`
 * was always false, and the AI step would never once have fired: a watch that
 * runs weekly, costs a workflow, and is silent by construction. Exactly the
 * failure this whole design keeps guarding against, reached by accident.
 *
 * The variable is set by the workflow through the same PAT that stores the
 * rotated token. Losing it is self-healing: one noisy run that re-reports
 * everything, then quiet again.
 *
 * The file path stays as a LOCAL fallback so the script is runnable by hand.
 */
function readBaseline(path: string): WatchBaseline {
  const doAmbiente = process.env.ML_WATCH_BASELINE;
  if (doAmbiente !== undefined && doAmbiente.trim() !== '') {
    log('ⓘ baseline lida da variável ML_WATCH_BASELINE.');
    return JSON.parse(doAmbiente) as WatchBaseline;
  }

  try {
    const texto = readFileSync(path, 'utf8');
    log(`ⓘ baseline lida de ${path}.`);
    return JSON.parse(texto) as WatchBaseline;
  } catch (err) {
    if (err instanceof SyntaxError) throw err;
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      log(
        `ⓘ sem baseline (nem ML_WATCH_BASELINE, nem ${path}) — primeira execução, tudo vira baseline sem alarme.`,
      );
      return BASELINE_VAZIA;
    }
    throw err;
  }
}

function write(path: string, content: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function emitOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file === undefined || file === '') return;
  writeFileSync(file, `${name}=${value}\n`, { flag: 'a' });
}

async function main(): Promise<void> {
  const baselinePath = arg('baseline') ?? '.github/ml-watch-baseline.json';
  const reportPath = arg('report') ?? 'out/ml-watch-report.md';
  const tokenOutPath = arg('token-out');

  const appId = requiredEnv('MERCADO_LIVRE_CLIENT_ID');
  const { accessToken, refreshToken } = await refresh();

  // ⚠️ FIRST, before anything else can throw. ML rotated the token the moment
  // the refresh succeeded; if this run dies before the new one is stored, the
  // next run has no valid grant and a human has to re-consent.
  if (tokenOutPath !== null) {
    write(tokenOutPath, refreshToken);
    log('🔑 refresh_token rotacionado e gravado (o valor nunca é logado).');
  } else {
    log('⚠️ --token-out ausente: o refresh_token rotacionado NÃO foi persistido.');
  }

  const signals: WatchSignals = {
    application: parseApplication(await get(`/applications/${appId}`, accessToken)),
    consumption: parseConsumption(
      await get(`/applications/v1/${appId}/consumed-applications`, accessToken),
    ),
    notices: parseNotices(await get('/communications/notices?limit=50', accessToken)),
  };

  const baseline = readBaseline(baselinePath);
  const findings = diffWatch(baseline, signals);
  const novidade = temNovidade(findings);

  // ⚠️ Compact, not pretty-printed: this is stored in a GitHub repo VARIABLE,
  // which caps at 48 KB. `seenNoticeIds` only grows, so the cheap encoding is
  // what keeps that ceiling far away.
  const baselineOut = arg('baseline-out') ?? baselinePath;
  write(baselineOut, JSON.stringify(proximaBaseline(baseline, signals)));
  write(reportPath, renderReport(findings, signals));

  log('');
  log(`comunicados no feed .......... ${signals.notices.length}`);
  log(`  já triados ................. ${findings.noticesJaVistas}`);
  log(`  novos ...................... ${findings.novasNotices.length}`);
  log(`mudanças na aplicação ........ ${findings.mudancasApp.length}`);
  log(`status HTTP inéditos ......... ${findings.novosStatus.length}`);
  log(`desvios de consumo ........... ${findings.desviosStatus.length}`);
  log('');
  log(
    novidade ? '📣 há novidades — a análise por IA vai rodar.' : '😴 nada mudou — a IA não roda.',
  );

  emitOutput('has_new', novidade ? 'true' : 'false');
  emitOutput('report_path', reportPath);
  emitOutput('baseline_path', baselinePath);
}

main().catch((err: unknown) => {
  // ⚠️ `message` alone. A WatchHttpError's body is non-enumerable precisely so
  // that letting the rejection reach Node's default handler cannot print it —
  // but narrowing here means it is never even close.
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
