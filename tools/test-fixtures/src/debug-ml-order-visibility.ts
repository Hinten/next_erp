/**
 * Mercado Livre order-visibility probe (issue #1087).
 *
 * READ-ONLY. Answers ONE question the whole payment→pedido bootstrap design
 * rests on: **can the seller's access token read an order that is not yet
 * visible to the seller?**
 *
 * Why it matters. ML's Orders reference says `orders_v2` only fires for
 * "vendas confirmadas", and the seller-scoped `/orders/search` filters on
 * `hidden_for_seller` — so a `payment_in_process` order notifies nothing and
 * searches empty, while its Mercado Pago payment notifies immediately. If
 * `GET /orders/{id}` still answers for the seller (its documented failure is
 * `not_owned_order`, i.e. an OWNERSHIP check, not a visibility one), the ERP can
 * bootstrap the pedido from `payment.order_id` and hold the stock reservation.
 * If it does not, no meaningful reservation can be built — the payment carries
 * only `reason` (the item title), no item id and no quantity.
 *
 * Usage (from the REPO ROOT — not a worktree; `FIREBASE_SERVICE_ACCOUNT_PATH` is
 * repo-root-relative and `admin.ts`'s two-level-up fallback lands outside a
 * worktree). Same env as the seeds, incl. the Norton CA via NODE_EXTRA_CA_CERTS
 * so the ML HTTPS call passes:
 *
 *   ML_PROBE_PAYMENT_ID=175442430874 pnpm --filter @delfrance/test-fixtures debug:ml-order-visibility
 *   ML_PROBE_ORDER_ID=<orderId>      pnpm ... debug:ml-order-visibility   # skip the payment hop
 *   ML_PROBE_INT_ID=<integracaoId>   pnpm ... debug:ml-order-visibility   # pin the account
 *
 * ⚠️ NEVER REFRESHES. ML has no sandbox and its `refresh_token` is single-use and
 * rotating, so a refresh from a developer machine would invalidate the token the
 * DEPLOYED staging backend is holding. An expired credential fails loudly here
 * and asks a human to reconnect the account instead.
 *
 * No writes, no schema/rules change.
 */
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import { db } from './admin';

/* eslint-disable no-console */

const ML_BASE = 'https://api.mercadolibre.com';

const PAYMENT_ID = process.env.ML_PROBE_PAYMENT_ID ?? null;
const ORDER_ID = process.env.ML_PROBE_ORDER_ID ?? null;
const INT_ID = process.env.ML_PROBE_INT_ID ?? null;

/**
 * The connected ML account to probe with. An explicit `ML_PROBE_INT_ID` wins;
 * otherwise the same predicates `resolveIntegracaoByUserId` queries on
 * (tipo == mercadoLivre, ativo == true).
 */
async function resolveIntegracaoId(): Promise<string> {
  if (INT_ID) return INT_ID;
  const snap = await db()
    .collection('integracao')
    .where('tipo', '==', INTEGRACAO_TIPO.mercadoLivre)
    .where('ativo', '==', true)
    .limit(2)
    .get();
  const first = snap.docs[0];
  if (!first) {
    throw new Error(
      'No active Mercado Livre integração found. Connect one, or pass ML_PROBE_INT_ID=<id>.',
    );
  }
  if (snap.docs.length > 1) {
    console.warn(
      `⚠️  More than one active ML integração; probing ${first.id}. Pin one with ML_PROBE_INT_ID.`,
    );
  }
  return first.id;
}

/**
 * Newest `access_token` across BOTH credential lineages — Flutter's auto-id docs
 * and this app's fixed `current`. Reading only `current` would miss a newer
 * token, which is exactly why `createTokenDuravelStore` orders the whole
 * collection instead of reading a known id.
 *
 * ⚠️ `expires_in` is ABSOLUTE epoch milliseconds despite the OAuth-style name
 * (`tokenDuravelFromResponse` stores `now + expires_in * 1000 - guard`).
 */
async function loadAccessToken(integracaoId: string): Promise<string> {
  const snap = await db()
    .collection('integracao')
    .doc(integracaoId)
    .collection('tokenDuravel')
    .orderBy('expires_in', 'desc')
    .limit(1)
    .get();

  const doc = snap.docs[0];
  if (!doc) {
    throw new Error(`No tokenDuravel under integracao/${integracaoId} — is the account connected?`);
  }
  const data = doc.data() as { access_token?: string; expires_in?: number };
  const token = data.access_token;
  if (!token) throw new Error(`tokenDuravel/${doc.id} carries no access_token.`);

  const expiraEm = typeof data.expires_in === 'number' ? data.expires_in : null;
  if (expiraEm != null && expiraEm <= Date.now()) {
    throw new Error(
      [
        `The newest credential expired at ${new Date(expiraEm).toISOString()}.`,
        'This probe deliberately does NOT refresh: ML refresh_tokens are single-use and',
        'rotating, so refreshing here would invalidate the token the deployed backend holds.',
        'Reconnect the account in the ERP, then re-run.',
      ].join(' '),
    );
  }
  console.log(
    `token: integracao/${integracaoId}/tokenDuravel/${doc.id}, expires ${
      expiraEm != null ? new Date(expiraEm).toISOString() : '(unknown)'
    }`,
  );
  return token;
}

interface ProbeResult {
  status: number;
  body: unknown;
}

async function get(path: string, token: string): Promise<ProbeResult> {
  const res = await fetch(`${ML_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch (err) {
    // A non-JSON error page keeps its raw text — that IS the evidence here.
    // Anything other than a parse failure is not ours to swallow.
    if (!(err instanceof SyntaxError)) throw err;
  }
  return { status: res.status, body };
}

function field(body: unknown, key: string): unknown {
  return body != null && typeof body === 'object' ? (body as Record<string, unknown>)[key] : null;
}

async function main(): Promise<void> {
  if (!PAYMENT_ID && !ORDER_ID) {
    throw new Error('Set ML_PROBE_PAYMENT_ID=<collectionId> (and/or ML_PROBE_ORDER_ID=<orderId>).');
  }

  const integracaoId = await resolveIntegracaoId();
  const token = await loadAccessToken(integracaoId);

  let orderId = ORDER_ID;

  if (PAYMENT_ID) {
    console.log(`\n── GET /collections/${PAYMENT_ID} ──`);
    const pay = await get(`/collections/${PAYMENT_ID}`, token);
    console.log(`HTTP ${pay.status}`);
    if (pay.status === 200) {
      console.log({
        order_id: field(pay.body, 'order_id'),
        external_reference: field(pay.body, 'external_reference'),
        status: field(pay.body, 'status'),
        marketplace: field(pay.body, 'marketplace'),
        date_created: field(pay.body, 'date_created'),
      });
      const fromPayment = field(pay.body, 'order_id');
      if (orderId == null && fromPayment != null) orderId = String(fromPayment);
    } else {
      console.log(pay.body);
    }
  }

  if (orderId == null) {
    console.log('\nNo order_id available — cannot probe the order. Set ML_PROBE_ORDER_ID.');
    return;
  }

  console.log(`\n── GET /orders/${orderId} ──`);
  const order = await get(`/orders/${orderId}`, token);
  console.log(`HTTP ${order.status}`);

  if (order.status === 200 || order.status === 206) {
    const itens = field(order.body, 'order_items');
    console.log({
      id: field(order.body, 'id'),
      status: field(order.body, 'status'),
      status_detail: field(order.body, 'status_detail'),
      pack_id: field(order.body, 'pack_id'),
      date_created: field(order.body, 'date_created'),
      order_items: Array.isArray(itens) ? itens.length : null,
    });
    console.log(
      '\n✅ READABLE — the seller token reads the order by id. The bootstrap can import it.',
    );
  } else {
    console.log(order.body);
    console.log(
      [
        `\n❌ NOT READABLE (HTTP ${order.status}) — a reservation cannot be built from the payment`,
        'alone (it carries only `reason`, no item id and no quantity). Report this rather than',
        'synthesising a pedido.',
      ].join(' '),
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
