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
 * work asynchronously. Step 6 (#290/#360): persist the raw notification BLIND
 * (no account lookup in the hot path) at a fixed doc id = the ML `_id` (natural
 * cross-delivery dedup — a retry upserts the same doc) in the TOP-LEVEL
 * `notificacoesMercadoLivre` collection, then ack. The nested Cloud Functions
 * (`onDocumentCreated` + an `onSchedule` sweep) resolve the account and apply
 * the resource. If the persist itself fails we throw → 5xx so ML redelivers.
 *
 * No Bearer token and OUT of the `proxy.ts` CORS matcher — it's a server→server
 * call from ML, not a browser request.
 *
 * ⚠️ DUAL-RUN: this writes EVERY notification to the top-level
 * `notificacoesMercadoLivre` collection the still-running Flutter app also
 * triggers on. Switching a seller's ML callback URL here MUST be paired with
 * disabling the legacy Flutter notification functions (see functions/DEPLOY.md)
 * or every notification is double-processed.
 */
import { NextResponse } from 'next/server';
import { notificacaoMercadoLivreCollection } from '@delfrance/data/admin/collections';

import { getAdminFirestore } from '@/lib/firebase/admin';
import { parseNotificationBody } from '@/lib/marketplace/notificacao';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const raw = await req.text();

  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch (err) {
    if (err instanceof SyntaxError) {
      // Ack 200 (not 4xx) so ML stops retrying — a malformed body won't parse
      // on a retry either. Logged for observability.
      console.warn('[mercado-livre/webhook] ignoring unparseable body');
      return NextResponse.json({ ok: true, accepted: false });
    }
    throw err;
  }

  // Noise (health ping / missing topic+resource) → ack without persisting.
  const parsed = parseNotificationBody(body);
  if (!parsed) {
    return NextResponse.json({ ok: true, accepted: false });
  }

  // Persist keyed by the ML notification id, CREATE-ONLY (no account lookup in
  // the hot path — the processor resolves it). `create` is the true dedup: the
  // FIRST delivery creates the doc (firing `onDocumentCreated`), and a
  // redelivery of the same `_id` throws ALREADY_EXISTS → we ack without
  // touching the doc, so an already-processed notification's terminal state
  // (`done`/`parked`/`tentativas`) is never reset back to `pending`. Any other
  // write failure propagates → 5xx so ML redelivers (never ack-lost).
  const db = getAdminFirestore();
  const docId = parsed.id ?? notificacaoMercadoLivreCollection.newDocId(db, {});
  try {
    await notificacaoMercadoLivreCollection
      .docRef(db, {}, docId)
      .create(notificacaoMercadoLivreCollection.parse(parsed.fields));
  } catch (err) {
    // gRPC ALREADY_EXISTS (code 6) — a duplicate delivery; the doc is already
    // persisted (and possibly processed). Ack; never rewrite it.
    if (err instanceof Error && (err as { code?: unknown }).code === 6) {
      return NextResponse.json({ ok: true, accepted: true, duplicate: true });
    }
    throw err;
  }

  return NextResponse.json({ ok: true, accepted: true });
}
