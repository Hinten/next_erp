import { NextResponse } from 'next/server';
import { withSignature } from '@/lib/signatures/withSignature';

export const dynamic = 'force-dynamic';

/**
 * Wiring smoke test — exercises `withSignature` end to end. Real webhook
 * receivers (Phase 5+) follow the same pattern but extract the signature
 * header per channel and dispatch heavy work via `lib/queue/dispatch`.
 */
export const POST = withSignature(
  {
    secret: process.env.WEBHOOK_TEST_SECRET,
    getSignature: (req) => req.headers.get('x-signature'),
  },
  async ({ json }) => NextResponse.json({ ok: true, received: json ?? null }),
);
