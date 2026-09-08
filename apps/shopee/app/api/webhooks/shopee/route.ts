/**
 * `POST /api/webhooks/shopee` — the Shopee Open Platform push receiver (step 3).
 *
 * The raw body is read ONCE (`req.text()`) and its `Authorization` HMAC is
 * verified over those exact bytes BEFORE anything else — byte-for-byte, never a
 * re-serialized JSON (`guide 18`: "json.loads(response.content) … is not
 * recommended"). Verification is MANDATORY: unconfigured → 503, a mismatch →
 * 401 before any enqueue. The receiver then answers **204 with an EMPTY body**
 * and ENQUEUEs the lean payload onto the `processShopeeNotification` Cloud
 * Tasks queue — NO Firestore write on the happy path.
 *
 * ⚠️⚠️ **The ack shape is not a style choice.** `guide 18` defines a FAILED push
 * as "not receiving an HTTP response with a status code of 2xx **and an empty
 * body**". So the JSON ack every other provider accepts — `200 {"received":
 * true}` — counts as a failure here, and a sustained failure rate first warns
 * (>600 pushes/6 h, <70 % success) and then **auto-disables the subscription**
 * (<30 %). Every answer below is `new NextResponse(null, { status })`, and a
 * test asserts the body is genuinely empty on all three 2xx exits.
 *
 * Resilience: if an enqueue fails (IAM not yet granted / transport / the
 * `SHOPEE_TASKS_DISABLED` valve) we FALL BACK to persisting the push as
 * `failed` so the reprocess sweep drains it — never a 5xx, for the same reason.
 * Only a TRANSIENT persist failure throws → 5xx so Shopee redelivers (+5 min,
 * +30 min, +3 h); a deterministic (validation) persist failure is dropped.
 *
 * No Bearer token and OUT of the `proxy.ts` CORS matcher (`/api/marketplace/*`)
 * — it is a server→server call from Shopee, not a browser request. There is no
 * GET handshake: Shopee verifies a callback URL by POSTing to it.
 */
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { getAdminFirestore } from '@/lib/firebase/admin';
import { ShopeeConfigError, shopeeConfig, shopeePushCallbackUrl } from '@/lib/shopee/env';
import {
  parseNotificationBody,
  persistNotificationFailure,
} from '@/lib/shopee/notificacoes/notificacao';
import {
  type PushSignatureConfig,
  ShopeePushConfigError,
  expectedPushSignature,
  verifyShopeePushSignature,
} from '@/lib/shopee/notificacoes/pushSignature';
import { createShopeeTaskScheduler } from '@/lib/shopee/shopeeTasks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * How many deliveries this instance logs in full before going quiet. The log
 * exists to answer ONE open question — **which url string Shopee actually
 * signs** — from live traffic rather than from a guess (`guide 18` says only
 * "URL", with no scheme, port or trailing-slash rule). A mismatch is always
 * logged, however many have gone by, because that is the case the answer is
 * hiding in.
 */
const MAX_ENTREGAS_LOGADAS = 5;
let entregasLogadas = 0;

/** Only for tests — the counter is per instance and never resets in production. */
export function __resetContadorDeEntregasParaTestes(): void {
  entregasLogadas = 0;
}

/**
 * The two values the push HMAC needs.
 *
 * ⚠️ ANY `ShopeeConfigError` degrades to `partnerKey: null` rather than
 * propagating — no partner id, a malformed one, no partner key, and also a
 * malformed `SHOPEE_API_HOST`/`SHOPEE_AUTH_HOST` override, which
 * `shopeeConfig()` validates AFTER the partner key. The verifier then raises
 * the ONE error class this route maps to 503, so an unconfigured backend has
 * exactly one exit instead of two that could drift apart.
 *
 * ⚠️ Which means `err.variavel` on that 503 always reads `SHOPEE_PARTNER_KEY`
 * and is NOT necessarily the variable at fault: the caught message rides along
 * as `detalhe` and is the one that names it. No message raised inside
 * `shopeeConfig()` itself carries a value; the two host overrides quote theirs,
 * and neither of those is a credential.
 */
function lerConfigDeAssinatura(): { config: PushSignatureConfig; detalhe: string | null } {
  let partnerKey: string | null = null;
  let detalhe: string | null = null;
  try {
    partnerKey = shopeeConfig().partnerKey;
  } catch (err) {
    if (!(err instanceof ShopeeConfigError)) throw err;
    detalhe = err.message;
  }
  return { config: { partnerKey, callbackUrl: shopeePushCallbackUrl() }, detalhe };
}

/**
 * The configured-vs-received evidence line.
 *
 * ⚠️ **Never the body, never `data`, never the full header, never the partner
 * key.** The digests are truncated to 8 characters: that is enough to tell two
 * digests apart at a glance and useless as a forgery, while a full digest IS a
 * valid credential for that one body.
 */
function registrarEntrega(
  req: Request,
  raw: string,
  header: string | null,
  assinaturaOk: boolean,
  config: PushSignatureConfig,
): void {
  if (assinaturaOk && entregasLogadas >= MAX_ENTREGAS_LOGADAS) return;
  entregasLogadas += 1;
  // `console.warn` rather than `info`: this is temporary instrumentation for an
  // OPEN contradiction in Shopee's own documentation, not a routine trace, and
  // the repo's `no-console` rule allows only `warn`/`error` anyway.
  console.warn('[shopee/webhook] entrega recebida', {
    urlConfigurada: config.callbackUrl,
    urlRecebida: req.url,
    forwardedProto: req.headers.get('x-forwarded-proto'),
    forwardedHost: req.headers.get('x-forwarded-host'),
    host: req.headers.get('host'),
    contentType: req.headers.get('content-type'),
    bytes: Buffer.byteLength(raw, 'utf8'),
    assinaturaOk,
    digestRecebido: header == null ? null : header.trim().toLowerCase().slice(0, 8),
    digestEsperado: expectedPushSignature(raw, config).slice(0, 8),
  });
}

/**
 * The operator-facing message of an enqueue failure, read STRUCTURALLY.
 *
 * ⚠️ Deliberately not `err instanceof Error`: root CLAUDE.md rule 6 is right
 * that `Error` narrows nothing, and here there is nothing to narrow TO — the
 * catch below is total on purpose. Reading the message off the shape keeps the
 * intent honest instead of dressing a total catch as a narrow one.
 */
function mensagemDoErro(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  return String(err);
}

export async function POST(req: Request): Promise<NextResponse> {
  const raw = await req.text();

  const { config, detalhe } = lerConfigDeAssinatura();

  // Signature gate over the RAW body. Unconfigured → 503 (mandatory policy):
  // an unconfigured verifier must never silently accept an unsigned push.
  let assinaturaOk: boolean;
  try {
    assinaturaOk = verifyShopeePushSignature(raw, req.headers.get('authorization'), config);
  } catch (err) {
    if (err instanceof ShopeePushConfigError) {
      console.error('[shopee/webhook] verificação de push não configurada — 503', {
        variavel: err.variavel,
        detalhe,
      });
      return new NextResponse(null, { status: 503 });
    }
    throw err;
  }

  registrarEntrega(req, raw, req.headers.get('authorization'), assinaturaOk, config);

  if (!assinaturaOk) {
    console.warn('[shopee/webhook] rejeitando push com Authorization inválida');
    return new NextResponse(null, { status: 401 });
  }

  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch (err) {
    if (err instanceof SyntaxError) {
      // Ack (not 4xx) so Shopee stops retrying — a malformed body will not
      // parse on a retry either, and three more non-2xx answers only push the
      // success rate toward the auto-disable threshold.
      console.warn('[shopee/webhook] ignorando body não-parseável');
      return new NextResponse(null, { status: 204 });
    }
    throw err;
  }

  const payload = parseNotificationBody(body);
  if (payload == null) {
    // Signed by Shopee and unreadable by us — structure only, never the body.
    console.warn('[shopee/webhook] body assinado sem push_code inteiro — ack sem enfileirar', {
      tipo: body === null ? 'null' : Array.isArray(body) ? 'array' : typeof body,
      bytes: Buffer.byteLength(raw, 'utf8'),
    });
    return new NextResponse(null, { status: 204 });
  }

  try {
    await createShopeeTaskScheduler().enqueue(payload);
  } catch (err) {
    // ⚠️ Deliberately TOTAL, and this is the one place in the app where that is
    // right (root CLAUDE.md rule 6 is about SWALLOWING, and nothing is
    // swallowed here). Whatever the enqueue threw — the `SHOPEE_TASKS_DISABLED`
    // valve, a missing IAM grant, a transport failure — answering non-2xx would
    // count against Shopee's push success rate, and a sustained run of those
    // DISABLES the subscription. So every failure funnels into the same
    // fallback: the push becomes a `failed` document the sweep re-drives.
    const motivo = mensagemDoErro(err);
    console.warn('[shopee/webhook] enqueue falhou — persistindo para o sweep', {
      code: payload.code,
      message: motivo,
    });
    try {
      await persistNotificationFailure(getAdminFirestore(), payload, `enqueue falhou: ${motivo}`);
    } catch (persistErr) {
      // Deterministic (validation) → drop (acked); a transient Firestore error
      // is genuinely retryable → 5xx so Shopee redelivers.
      if (persistErr instanceof ZodError) {
        console.warn('[shopee/webhook] descartando push não-persistível', {
          code: payload.code,
          message: persistErr.message,
        });
        return new NextResponse(null, { status: 204 });
      }
      throw persistErr;
    }
  }

  return new NextResponse(null, { status: 204 });
}
