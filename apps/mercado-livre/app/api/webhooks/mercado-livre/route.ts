/**
 * `POST /api/webhooks/mercado-livre` — #290
 *
 * Mercado Livre notification receiver. ML posts unauthenticated `topic` +
 * `resource` callbacks to the URL registered per connected account (the legacy
 * `distribuidorDeNotificacoes` ran `--allow-unauthenticated`); the security is
 * the obscure callback URL plus re-fetching the resource from the ML API with
 * the account token before acting on it — ML does NOT HMAC-sign the body
 * (contrast Shopee, which does — see lib/signatures/hmac.ts for that path).
 *
 * The receiver must answer `200` FAST so ML stops retrying, and do the heavy
 * work asynchronously. Phase 5 (#290 + #360): persist the raw notification keyed
 * on its `_id` (natural dedup) and dispatch a Cloud Function/Task
 * (apps/mercado-livre/functions) to pull + reconcile the resource.
 *
 * No Bearer token and OUT of the `proxy.ts` CORS matcher — it's a server→server
 * call from ML, not a browser request.
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface MlNotification {
  _id?: unknown;
  resource?: unknown;
  topic?: unknown;
  user_id?: unknown;
}

export async function POST(req: Request): Promise<NextResponse> {
  const raw = await req.text();

  let body: MlNotification;
  try {
    body = raw ? (JSON.parse(raw) as MlNotification) : {};
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: 'Body JSON inválido.' }, { status: 400 });
    }
    throw err;
  }

  const notificationId = typeof body._id === 'string' ? body._id : null;
  const resource = typeof body.resource === 'string' ? body.resource : null;
  const topic = typeof body.topic === 'string' ? body.topic : null;

  // A well-formed ML notification always carries a topic + resource. Anything
  // else is noise (or a health ping) — ack so ML doesn't retry.
  if (!resource || !topic) {
    return NextResponse.json({ ok: true, accepted: false });
  }

  // TODO(#290/#360): persist the raw notification at a fixed doc id derived from
  // `notificationId` (natural dedup — a retry upserts the same doc), then
  // dispatch the per-account order/resource pull to the nested Cloud Functions
  // codebase. Ack fast in the meantime so ML stops retrying.
  return NextResponse.json({ ok: true, accepted: true, topic, notificationId });
}
