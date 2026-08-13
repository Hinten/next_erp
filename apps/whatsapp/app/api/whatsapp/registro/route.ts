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

import { isFailedPrecondition } from '@delfrance/data/admin/grpcErrors';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadWhatsappContext } from '@/lib/whatsapp/whatsapp';
import type { CredentialStore } from '@/lib/whatsapp/credentialStore';
import { isWhatsappError, whatsappErrorResponse } from '@/lib/whatsapp/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PIN_RE = /^\d{6}$/;

/**
 * Attempts for {@link persistPin}. A persistent loser is a real contention
 * problem and should surface rather than spin (`grpcErrors.ts`); three attempts
 * is generous for a doc only two routes ever write.
 */
const PIN_SAVE_ATTEMPTS = 3;

/**
 * Store the pin that {@link https://developers.facebook.com/docs/whatsapp Graph}
 * just registered with, WITHOUT reverting a token another request stored while
 * we were blocked on that call.
 *
 * ADR 0011 tier 1. The route reads the credential, `await`s a Meta Graph
 * round-trip, then writes it back — the textbook stale-closure shape, and here
 * `save()` REPLACES the whole doc, so re-applying the pre-Graph read would
 * revert `permanent_token` to a value the operator has already replaced. That
 * failure is close to invisible: the reverted token is a well-formed string, so
 * nothing throws until Graph answers 401, which `dispatchOutbound` treats as
 * TERMINAL and patches to `estadoEnvio = erro` — a state the stale-outbound
 * sweep never re-drives.
 *
 * Every attempt re-READS and re-DERIVES; only `pin` is ours to impose. Retrying
 * the same patch would reintroduce exactly the overwrite the precondition just
 * prevented.
 */
async function persistPin(store: CredentialStore, pin: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const stored = await store.loadForUpdate();
    // Revoked between the register call and here. Nothing to carry the pin on,
    // and re-creating the doc would resurrect a credential the operator just
    // disconnected — the register itself succeeded, so this is not an error.
    if (!stored) return;
    try {
      await store.save({ ...stored.cred, pin }, { expectedVersion: stored.version });
      return;
    } catch (err) {
      if (!isFailedPrecondition(err)) throw err;
      if (attempt >= PIN_SAVE_ATTEMPTS) {
        // Surface rather than spin. Losing this many times on a document only
        // two routes ever write is a real contention problem, and the caller
        // needs to know the two halves came apart: Graph accepted the
        // registration, Firestore did not keep the pin.
        throw new Error(
          'O número foi registrado no Graph, mas o PIN não pôde ser gravado após ' +
            `${PIN_SAVE_ATTEMPTS} tentativas — outra gravação venceu a corrida em todas. ` +
            'Reenvie o PIN para armazená-lo; o registro em si já está feito.',
        );
      }
      // Someone else wrote `current` first — loop to re-read their value and
      // re-apply only the pin on top of it.
    }
  }
}

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
    // Persist the pin used. NOT `save({ ...existing, pin })` — `existing` was
    // read before the Graph round-trip above, and `save` replaces the whole
    // doc, so a token stored meanwhile would be reverted. `persistPin` re-reads
    // and writes conditionally instead; see its docblock.
    await persistPin(ctx.store, usedPin);
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
