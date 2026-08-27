/**
 * #1342 — **capture what Mercado Livre actually sent, byte for byte.**
 *
 * Every offline test in this repo runs on hand-written fixtures, and `payments[]`
 * / `discounts[]` are read through `as unknown as` passthrough casts, so Zod never
 * validates them and a shape change from ML is silent. This script is the missing
 * half: real response bodies on disk, from which a later test can assert "our Zod
 * schema parses this REAL body without loss".
 *
 *   pnpm --filter @delfrance/mercado-livre-app capture:fixtures \
 *     --project <id> --integracaoId <id> \
 *     --orderId 2000018143664980 --shipmentId 47868202073 --paymentId 174911485053
 *
 * `--orderId`, `--itemId`, `--shipmentId`, `--paymentId` and `--claimId` are all
 * REPEATABLE; every id fans out to the endpoints listed in `buildCapturePlan`.
 * One raw response body per file under `out/fixtures/`.
 *
 * ---- ⚠️ Why this does NOT use `createMercadoLivreApi` ----------------------
 * Every typed method runs its response through `parseOk(res, schema)` — Zod
 * (`api.ts:784`). So `api.getShipment()` returns a PARSED object, and every field
 * declared `.nullable().default(null)` comes back materialised as an explicit
 * `null` whether or not ML sent the key. A fixture built that way cannot
 * distinguish "ML sent null" from "ML omitted it" — which is the entire point of
 * a wire fixture, and exactly the mistake #1342 Finding 1 documents about the
 * `orderML` mirror (`buildOrderMLWire` is a curated 19-key projection that DROPS
 * `mediations`, `fulfilled`, `cancel_detail`, `feedback`, `taxes`, `seller` and
 * `context`, and hardcodes `date_last_updated: null` for a field ML does send
 * under another name).
 *
 * So this issues a plain `fetch` per endpoint and writes `await res.text()`
 * straight to disk: no mapping, no normalisation, no key materialisation. The
 * endpoint table and the capture loop live in
 * `lib/marketplace/fixtures/fixtureCapture.ts`, which is driven from a stubbed
 * `fetch` in its test sibling — the only way any of this can be verified, since no
 * CI lane may ever hold a real ML credential.
 *
 * ---- ⚠️ Read-only, with one honest exception ------------------------------
 * It issues no write to Mercado Livre and no write to any business collection. It
 * CAN cause one write: resolving the channel context refreshes an expired OAuth
 * token, and ML's `refresh_token` is single-use and rotating, so the new
 * credential is persisted to `tokenDuravel` exactly as the backend would. That is
 * the normal shared "one wins" path, not a side effect this script invented — but
 * it is a write, so it is stated rather than hidden behind the word "read-only".
 *
 * ⚠️ `--project` is REQUIRED and never inferred — the same discipline as
 * `inspect-anuncio.ts`, `snapshot-produto.ts` and `tools/migrations`, so a stray
 * `FIREBASE_PROJECT_ID` cannot point it at production by accident.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getAdminFirestore } from '../lib/firebase/admin';
import { loadMercadoLivreContext } from '../lib/marketplace/core/mercadoLivre';
import {
  buildCapturePlan,
  captureAll,
  fixtureFileName,
  type CaptureIds,
  type CaptureResult,
} from '../lib/marketplace/fixtures/fixtureCapture';

function log(message: string): void {
  // eslint-disable-next-line no-console -- CLI output
  console.log(message);
}

class CaptureArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptureArgError';
  }
}

interface Args extends CaptureIds {
  projectId: string;
  integracaoId: string;
}

function valueOf(name: string, inline: string | undefined, next: string | undefined): string {
  const raw = inline ?? next;
  if (raw == null || raw.startsWith('--')) {
    throw new CaptureArgError(`--${name} exige um valor.`);
  }
  return raw;
}

function parseArgs(argv: readonly string[]): Args {
  let projectId: string | undefined;
  let integracaoId: string | undefined;
  const orderIds: string[] = [];
  const itemIds: string[] = [];
  const shipmentIds: string[] = [];
  const paymentIds: string[] = [];
  const claimIds: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    switch (name) {
      case 'project':
        projectId = valueOf(name, inline, argv[i + 1]);
        break;
      case 'integracaoId':
        integracaoId = valueOf(name, inline, argv[i + 1]);
        break;
      case 'orderId':
        orderIds.push(valueOf(name, inline, argv[i + 1]));
        break;
      case 'itemId':
        itemIds.push(valueOf(name, inline, argv[i + 1]));
        break;
      case 'shipmentId':
        shipmentIds.push(valueOf(name, inline, argv[i + 1]));
        break;
      case 'paymentId':
        paymentIds.push(valueOf(name, inline, argv[i + 1]));
        break;
      case 'claimId':
        claimIds.push(valueOf(name, inline, argv[i + 1]));
        break;
      default:
        throw new CaptureArgError(`Opção desconhecida: --${name}`);
    }
  }

  if (!projectId?.trim()) throw new CaptureArgError('--project é obrigatório.');
  if (!integracaoId?.trim()) throw new CaptureArgError('--integracaoId é obrigatório.');

  return {
    projectId: projectId.trim(),
    integracaoId: integracaoId.trim(),
    orderIds: orderIds.map((s) => s.trim()),
    itemIds: itemIds.map((s) => s.trim()),
    shipmentIds: shipmentIds.map((s) => s.trim()),
    paymentIds: paymentIds.map((s) => s.trim()),
    claimIds: claimIds.map((s) => s.trim()),
  };
}

/* ---------------------------------- output --------------------------------- */

const OUT_DIR = resolve('out/fixtures');

interface ManifestEntry {
  readonly path: string;
  readonly status: number;
  readonly arquivo: string;
  readonly bytes: number;
}

/**
 * ⚠️ Only a **200** takes the bare slug. A `206 Partial Content` order body omits
 * fields rather than nulling them, so under a complete body's name it would later
 * read as "ML returns this for an order" — the rule, and the 204 case, are
 * asserted in `fixtureCapture.test.ts`.
 */
function gravar(result: CaptureResult): ManifestEntry {
  const arquivo = fixtureFileName(result);
  // The body goes to disk VERBATIM — no `JSON.parse`, no re-serialisation, no
  // pretty-printing. Byte-faithfulness is the product.
  writeFileSync(resolve(OUT_DIR, arquivo), result.body, 'utf-8');
  return {
    path: result.target.path,
    status: result.status,
    arquivo,
    bytes: Buffer.byteLength(result.body, 'utf-8'),
  };
}

/** 206 and an empty 2xx are flagged in the run output, never left looking complete. */
function marcaDe(entrada: ManifestEntry): string {
  if (entrada.status === 404) return '✗ ';
  if (entrada.status === 206) return '◐ ';
  if (entrada.bytes === 0) return '⚠️ ';
  return '  ';
}

/* ----------------------------------- main ---------------------------------- */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  process.env.FIREBASE_PROJECT_ID = args.projectId;

  const db = getAdminFirestore();
  const ctx = await loadMercadoLivreContext(db, args.integracaoId);
  const channelCtx = await ctx.resolveChannelContext();

  const plan = buildCapturePlan(args);
  log(`[capture:fixtures] project=${args.projectId} integracao=${args.integracaoId}`);
  log(`  ${plan.length} chamada(s) → ${OUT_DIR}`);
  if (plan.length === 1) {
    log('  ⓘ Nenhum id informado — só a busca de claims será capturada.');
  }
  log('');

  mkdirSync(OUT_DIR, { recursive: true });

  const manifesto: ManifestEntry[] = [];
  const manifestoPath = resolve(OUT_DIR, '_manifest.json');
  // Rewritten after EVERY capture, so a run that dies on a 5xx still leaves an
  // accurate record of what did land — the partial capture is the useful part.
  const persistirManifesto = (): void => {
    writeFileSync(
      manifestoPath,
      JSON.stringify(
        {
          versao: 1,
          capturadoEm: new Date().toISOString(),
          projectId: args.projectId,
          integracaoId: args.integracaoId,
          capturas: manifesto,
        },
        null,
        2,
      ),
      'utf-8',
    );
  };

  await captureAll(
    plan,
    { fetchImpl: globalThis.fetch, accessToken: channelCtx.accessToken },
    (r) => {
      const entrada = gravar(r);
      manifesto.push(entrada);
      persistirManifesto();

      const marca = marcaDe(entrada);
      log(
        `${marca}${String(r.status).padEnd(3)}  ${entrada.path}  → ${entrada.arquivo} (${entrada.bytes} B)`,
      );
    },
  );

  log('');
  const completos = manifesto.filter((m) => m.status === 200);
  const parciais = manifesto.filter((m) => m.status === 206);
  const faltando = manifesto.filter((m) => m.status === 404);
  const vazios = manifesto.filter((m) => m.status !== 404 && m.bytes === 0);
  log(
    `✅ ${completos.length} corpo(s) completo(s); ${parciais.length} parcial(is) (206); ` +
      `${faltando.length} 404.`,
  );
  if (faltando.length > 0) {
    log('   Um 404 é DADO — ficou gravado como `<slug>.404.json` e nunca como um corpo válido.');
  }
  if (parciais.length > 0) {
    log('   ⚠️ Um 206 OMITE campos em vez de anulá-los, e as omissões são');
    log('      indistinguíveis das omissões reais do ML. Gravado como `<slug>.206.json` —');
    log('      NÃO use como fixture de "corpo completo do pedido":');
    for (const parcial of parciais) log(`      ${parcial.path}`);
  }
  if (vazios.length > 0) {
    log(
      `   ⚠️ ${vazios.length} resposta(s) 2xx com corpo VAZIO — confira antes de usar como fixture:`,
    );
    for (const v of vazios) log(`      ${v.path}`);
  }
  log(`   manifesto: ${manifestoPath}`);
  log('');
  log('⚠️ Os corpos carregam dados reais do comprador de teste. `out/` é gitignored —');
  log('   não anexe nada disso a uma issue sem revisar.');
}

await main();
