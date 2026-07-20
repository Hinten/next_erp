/**
 * `POST /api/whatsapp/registro`   — register the account's number with its
 *                                   6-digit two-step PIN.
 * `DELETE /api/whatsapp/registro` — deregister the number.
 *
 * Both require PERM.integracao.write. Body (POST): `{ integracaoId, pin? }`.
 * When `pin` is present it must be 6 digits; when absent the previously-stored
 * pin is reused (Meta requires the SAME pin to re-register once 2FA is set).
 * On a successful register the pin is persisted into the admin-only
 * `credenciaisWhatsapp` doc (never onto the client-readable account doc — the
 * pin is a secret). DELETE takes `?integracaoId=` and keeps the stored pin so a
 * later re-register still has it. Ported from legacy `registrarPin` /
 * `RegistrarPinDialog` (`.old/lib/whatsapp/pages/conta.dart:535`).
 *
 * The pin is NEVER logged, echoed in a response, or placed in a URL/error text.
 */
import { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadWhatsappContext } from '@/lib/whatsapp/whatsapp';
import { isWhatsappError, whatsappErrorResponse } from '@/lib/whatsapp/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PIN_RE = /^\d{6}$/;

interface RegistroBody {
  integracaoId?: unknown;
  pin?: unknown;
}

async function readJsonBody(req: Request): Promise<RegistroBody> {
  try {
    return (await req.json()) as RegistroBody;
  } catch (err) {
    if (err instanceof SyntaxError) return {};
    throw err;
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const body = await readJsonBody(req);
  const integracaoId = typeof body.integracaoId === 'string' ? body.integracaoId : '';
  const bodyPin = typeof body.pin === 'string' ? body.pin : '';
  if (!integracaoId) {
    return NextResponse.json({ error: 'integracaoId é obrigatório.' }, { status: 400 });
  }
  if (bodyPin && !PIN_RE.test(bodyPin)) {
    return NextResponse.json({ error: 'PIN inválido — informe 6 dígitos.' }, { status: 400 });
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadWhatsappContext(db, integracaoId);
    const existing = await ctx.store.load();

    // Resolve the pin to register with: an explicit body pin wins; otherwise
    // reuse the stored one (re-register). Neither present → 400.
    let usedPin: string;
    if (bodyPin) {
      usedPin = bodyPin;
    } else if (existing?.pin) {
      usedPin = existing.pin;
    } else {
      return NextResponse.json(
        { error: 'PIN não cadastrado. Informe o PIN de 6 dígitos.' },
        { status: 400 },
      );
    }

    const client = await ctx.buildClient();
    await client.register({ pin: usedPin });
    // Persist the pin used (carrying the token + identity forward). `existing`
    // is non-null here — `buildClient` above would have thrown a TokenMissing
    // (→ 409) if no credential doc existed.
    if (existing) {
      await ctx.store.save({ ...existing, pin: usedPin });
    }
    // Never echo the pin back.
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (isWhatsappError(err)) return whatsappErrorResponse(err);
    throw err;
  }
}

export async function DELETE(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const integracaoId = new URL(req.url).searchParams.get('integracaoId');
  if (!integracaoId) {
    return NextResponse.json({ error: 'integracaoId é obrigatório.' }, { status: 400 });
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadWhatsappContext(db, integracaoId);
    const client = await ctx.buildClient();
    await client.deregister();
    // The stored pin is intentionally kept — a later re-register needs it.
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (isWhatsappError(err)) return whatsappErrorResponse(err);
    throw err;
  }
}
