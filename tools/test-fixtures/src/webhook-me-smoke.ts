import { createHmac } from 'node:crypto';
import { db } from './admin';

/**
 * Smoke-test the Melhor Envio order-status **webhook**
 * (`apps/melhor-envio/app/api/webhooks/melhor-envio/route.ts`) against staging —
 * WITHOUT waiting for Melhor Envio to push a real event (the ME sandbox doesn't
 * physically post/deliver a parcel, so most lifecycle events never fire there).
 *
 * It crafts the exact envelope ME sends (`{ event, data: { id, status,
 * tracking } }`), signs it with `X-ME-Signature = HMAC-SHA256(rawBody,
 * MELHOR_ENVIO_CLIENT_SECRET)` (hex — the same the route's `verifyHmac` checks),
 * POSTs it to the running app, then reads the targeted pedido back so you can see
 * `freteInicial.estado` / `codRastreio` change. The route's guards still apply
 * (terminal estados never regress; unmapped status → no-op).
 *
 * Self-contained: if the target pedido has no `printLabelId`, it stamps a
 * synthetic one (+ estado `aguardandoPostagem`) so the webhook's
 * find-by-`printLabelId` lookup matches and the transition is visible. Use
 * `reset:frete-me` afterwards to re-arm the dev pedido.
 *
 * Prereqs:
 *   - `apps/melhor-envio` running — `pnpm --filter @delfrance/melhor-envio-app dev` (:3005);
 *   - `MELHOR_ENVIO_CLIENT_SECRET` in `.env.local` (the SAME secret the app verifies with);
 *   - staging admin creds (FIREBASE_SERVICE_ACCOUNT* + FIREBASE_PROJECT_ID); under Norton
 *     set `NODE_EXTRA_CA_CERTS`.
 *
 * Usage (from the repo root):
 *   pnpm --filter @delfrance/test-fixtures webhook:me-smoke
 *   ME_WEBHOOK_STATUS=delivered pnpm ... webhook:me-smoke    # posted|received|delivered|canceled|suspended|undelivered
 *   ME_WEBHOOK_PEDIDO_ID=dev-frete-me-02 pnpm ... webhook:me-smoke
 *   ME_WEBHOOK_LABEL_ID=<real printLabelId> pnpm ... webhook:me-smoke   # don't stamp; target an existing label
 *   ME_WEBHOOK_URL=https://<deployed>/api/webhooks/melhor-envio pnpm ... webhook:me-smoke
 */

/* eslint-disable no-console */

const SECRET = process.env.MELHOR_ENVIO_CLIENT_SECRET?.trim();
const PEDIDO_ID = process.env.ME_WEBHOOK_PEDIDO_ID?.trim() || 'dev-frete-me-01';
const STATUS = process.env.ME_WEBHOOK_STATUS?.trim() || 'posted';
// Stable by default (derived from the pedido) so repeated runs are predictable;
// pass ME_WEBHOOK_TRACKING when you want a unique code.
const TRACKING = process.env.ME_WEBHOOK_TRACKING?.trim() || `SMOKE-${PEDIDO_ID}`;
const EXPLICIT_LABEL = process.env.ME_WEBHOOK_LABEL_ID?.trim() || null;

function webhookUrl(): string {
  const explicit = process.env.ME_WEBHOOK_URL?.trim();
  if (explicit) return explicit;
  const base = (
    process.env.MELHOR_ENVIO_PUBLIC_URL?.trim() ||
    process.env.NEXT_PUBLIC_MELHOR_ENVIO_URL?.trim() ||
    'http://localhost:3005'
  ).replace(/\/$/, '');
  return `${base}/api/webhooks/melhor-envio`;
}

/** ms → µs — frete datetime fields are microseconds since epoch. */
const us = (ms: number): number => ms * 1000;

interface FreteShape {
  printLabelId?: string | null;
  estado?: string | null;
  codRastreio?: string | null;
}

/** Find the pedido the webhook would match (by `freteInicial.printLabelId`). */
async function readByLabel(labelId: string): Promise<{ id: string; frete: FreteShape } | null> {
  const snap = await db()
    .collection('pedidos')
    .where('freteInicial.printLabelId', '==', labelId)
    .limit(1)
    .get();
  const doc = snap.docs[0];
  if (!doc) return null;
  return { id: doc.id, frete: (doc.data().freteInicial ?? {}) as FreteShape };
}

/** Resolve the printLabelId to fire against — an explicit one, the pedido's
 *  existing one, or a **stable** synthetic one derived from the pedido id (so
 *  re-runs target the same label instead of a new one each time). */
async function resolveLabelId(): Promise<string> {
  if (EXPLICIT_LABEL) return EXPLICIT_LABEL;

  const ref = db().collection('pedidos').doc(PEDIDO_ID);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new Error(
      `pedidos/${PEDIDO_ID} not found — run \`seed:frete-me\` first, or pass ME_WEBHOOK_LABEL_ID.`,
    );
  }
  const frete = (snap.data()?.freteInicial ?? null) as FreteShape | null;
  if (frete?.printLabelId) {
    console.log(
      `[webhook-smoke] using existing printLabelId "${frete.printLabelId}" on ${PEDIDO_ID}`,
    );
    return frete.printLabelId;
  }

  const labelId = `smoke-webhook-${PEDIDO_ID}`;
  await ref.update({
    'freteInicial.printLabelId': labelId,
    'freteInicial.estado': 'aguardandoPostagem',
    'freteInicial.ultimaModificacao': us(Date.now()),
  });
  console.log(
    `[webhook-smoke] stamped synthetic printLabelId "${labelId}" on ${PEDIDO_ID} (estado=aguardandoPostagem)`,
  );
  return labelId;
}

async function main(): Promise<void> {
  if (!SECRET) {
    throw new Error(
      'MELHOR_ENVIO_CLIENT_SECRET not set — required to sign the webhook (must match the app).',
    );
  }
  const url = webhookUrl();
  const labelId = await resolveLabelId();

  const before = await readByLabel(labelId);
  console.log(
    `[webhook-smoke] BEFORE: pedido=${before?.id ?? '(none)'} estado=${before?.frete.estado ?? '—'} codRastreio=${before?.frete.codRastreio ?? '—'}`,
  );

  const body = {
    event: `order.${STATUS}`,
    data: { id: labelId, status: STATUS, tracking: TRACKING },
  };
  const raw = JSON.stringify(body);
  const signature = createHmac('sha256', SECRET).update(raw).digest('hex');

  console.log(`[webhook-smoke] POST ${url}  (status=${STATUS}, tracking=${TRACKING})`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-me-signature': signature },
    body: raw,
  }).catch((err: unknown) => {
    if (err instanceof TypeError) {
      throw new Error(
        `Could not reach ${url} — is apps/melhor-envio running? (pnpm --filter @delfrance/melhor-envio-app dev)`,
      );
    }
    throw err;
  });
  const text = await res.text();
  console.log(`[webhook-smoke] RESPONSE ${res.status}: ${text}`);

  const after = await readByLabel(labelId);
  console.log(
    `[webhook-smoke] AFTER:  pedido=${after?.id ?? '(none)'} estado=${after?.frete.estado ?? '—'} codRastreio=${after?.frete.codRastreio ?? '—'}`,
  );

  if (res.ok) {
    console.log(
      '[webhook-smoke] ✅ webhook accepted — compare BEFORE/AFTER above. ' +
        '`applied:false` means the status was unmapped or the estado was terminal (both correct).',
    );
  } else {
    console.log(
      '[webhook-smoke] ⚠️ non-2xx — check that MELHOR_ENVIO_CLIENT_SECRET matches the app and that the label exists on a pedido.',
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
