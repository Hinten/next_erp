/**
 * Ask Mercado Livre whether it still sends what `__wire__/` says it sends.
 *
 *   pnpm --filter @delfrance/mercado-livre-app verify:wire \
 *     --project veste-france-debug --integracaoId 1WXplQLpUO8hcL3xQ4D0
 *
 * ⚠️ No `--` separator before the flags — pnpm forwards it into the script,
 * which then rejects it (`pnpm-run-args.test.js`).
 *
 * ## What this is, and what it deliberately is not
 * It re-fetches exactly the endpoints the committed corpus was captured from,
 * digests each live body, and diffs the shape against the committed one. It is
 * the human-triggered half of the #1087 CI work: **GETs only**, no writes, no
 * listing creation, no test-user consumption.
 *
 * ⚠️ **It is deliberately NOT in any CI lane.** It needs the SELLER credential,
 * and the run measured why an automated live lane fails: two of three buyer test
 * users were blocked by ML unprompted (slots capped at 10 forever), the
 * credential rotates on every invocation, ML acts on its own clock, and ML
 * changed behaviour mid-run. Run it when the weekly watch opens an issue, or
 * before trusting a fixture that has sat still for months.
 *
 * ## It takes no id flags
 * The ids come from the corpus filenames (`corpusIds.ts`), so the comparison is
 * apples-to-apples by construction. A hand-typed list would drift from what is
 * committed and report differences that are really just a different selection.
 *
 * ## Read-only, with one honest exception
 * Same as `capture:fixtures`: resolving the channel context refreshes an expired
 * OAuth token, and ML's `refresh_token` is single-use and rotating, so the new
 * credential is persisted to `tokenDuravel` exactly as the backend would. That is
 * the shared "one wins" path, not a side effect invented here — but it is a
 * write, so it is stated rather than hidden behind the word "read-only".
 */
import { getAdminFirestore } from '../lib/firebase/admin';
import { countIds, idsFromCorpus } from '../lib/marketplace/fixtures/corpusIds';
import {
  FixtureCaptureHttpError,
  buildCapturePlan,
  captureAll,
  fixtureFileName,
} from '../lib/marketplace/fixtures/fixtureCapture';
import { type WireValue, redactWireBody } from '../lib/marketplace/fixtures/redact';
import { diffShapes, ehQuebra, renderShapeDiff } from '../lib/marketplace/fixtures/shapeDiff';
import { listWireFixtures, readWireFixture } from '../lib/marketplace/fixtures/wireCorpus';
import { wireShape } from '../lib/marketplace/fixtures/wireDigest';
import { loadMercadoLivreContext } from '../lib/marketplace/core/mercadoLivre';

function log(message: string): void {
  // eslint-disable-next-line no-console -- CLI output
  console.log(message);
}

class VerifyArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifyArgError';
  }
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function required(name: string): string {
  const value = arg(name);
  if (value === null || value.startsWith('--')) {
    throw new VerifyArgError(`--${name} é obrigatório.`);
  }
  return value;
}

/** The committed body for a slug, whatever status it was filed under. */
function baselineFor(slug: string): { file: string; body: WireValue } | null {
  const file = listWireFixtures().find(
    (f) => f === `${slug}.json` || /^\d{3}\.json$/.test(f.slice(slug.length + 1)),
  );
  return file === undefined ? null : { file, body: readWireFixture(file) };
}

async function main(): Promise<void> {
  const projectId = required('project');
  const integracaoId = required('integracaoId');
  process.env.FIREBASE_PROJECT_ID = projectId;

  const ids = idsFromCorpus();
  if (countIds(ids) === 0) {
    throw new VerifyArgError(
      'O corpus __wire__/ não produziu nenhum id. Sem isso não há o que verificar — rode promote:fixtures antes.',
    );
  }

  const db = getAdminFirestore();
  const ctx = await loadMercadoLivreContext(db, integracaoId);
  const channelCtx = await ctx.resolveChannelContext();

  const plan = buildCapturePlan(ids);
  log(`[verify:wire] project=${projectId} integracao=${integracaoId}`);
  log(`  ${countIds(ids)} id(s) do corpus → ${plan.length} chamada(s), somente GET`);
  log('');

  let quebras = 0;
  let novidades = 0;
  let limpos = 0;
  let semBaseline = 0;
  let statusMudou = 0;

  await captureAll(
    plan,
    { fetchImpl: globalThis.fetch, accessToken: channelCtx.accessToken },
    (r) => {
      const baseline = baselineFor(r.target.slug);
      if (baseline === null) {
        // A path the plan produces but the corpus never captured. Counted and
        // named, never silently skipped — an uncounted skip reads as a pass.
        semBaseline += 1;
        log(`ⓘ ${r.target.slug} — sem baseline no corpus (não capturado em #1087)`);
        return;
      }

      // ⚠️ The live body is REDACTED before digesting. The corpus is redacted, and
      // redaction is type-preserving, so the two shapes are directly comparable —
      // comparing a raw body would report every personal field as a difference.
      const vivo = redactWireBody(JSON.parse(r.body === '' ? 'null' : r.body) as WireValue);
      const deltas = diffShapes(wireShape(baseline.body), wireShape(vivo));

      const esperado = fixtureFileName({ target: r.target, status: r.status });
      if (esperado !== baseline.file) {
        statusMudou += 1;
        log(`⚠️ ${baseline.file} — ML respondeu ${r.status} agora (era ${baseline.file})`);
      }

      if (deltas.length === 0) {
        limpos += 1;
        return;
      }
      if (deltas.some(ehQuebra)) quebras += 1;
      else novidades += 1;
      log(renderShapeDiff(baseline.file, deltas));
    },
  );

  log('');
  log(`iguais ....................... ${limpos}`);
  log(`só com campos novos .......... ${novidades}`);
  log(`com QUEBRA (removido/tipo) ... ${quebras}`);
  log(`status HTTP mudou ............ ${statusMudou}`);
  log(`sem baseline ................. ${semBaseline}`);
  log('');

  if (quebras > 0 || statusMudou > 0) {
    log('⛔ O Mercado Livre mudou o que envia. Confira antes de regenerar as fixtures.');
    process.exitCode = 1;
    return;
  }
  log(
    novidades > 0
      ? 'ⓘ Só adições — nada quebrou. Vale reler o diff para ver se há campo novo que interessa.'
      : '✅ O corpus continua descrevendo o que o Mercado Livre envia.',
  );
}

main().catch((err: unknown) => {
  // ⚠️ `message` alone: a FixtureCaptureHttpError carries the ML body on a
  // non-enumerable property precisely so it cannot reach a log stream (#1015).
  if (err instanceof FixtureCaptureHttpError || err instanceof VerifyArgError) {
    console.error(err.message);
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exitCode = 1;
});
