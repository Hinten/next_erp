import { NextResponse } from 'next/server';
import { FirebaseAuthError } from 'firebase-admin/auth';
import { FirebaseAppError } from 'firebase-admin/app';
import { ZodError } from 'zod';
import { AccessError } from '@delfrance/data/admin/cargo-claims';
import { getAdminAuth } from '../firebase/admin';

export async function accessCaller(req: Request) {
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer '))
    throw new AccessError(401, 'AUTH_REQUIRED', 'Authorization Bearer token ausente.');
  const decoded = await getAdminAuth().verifyIdToken(header.slice(7), true);
  let bits = 0n;
  if (typeof decoded.permissions === 'string' && /^\d+$/.test(decoded.permissions)) {
    try {
      bits = BigInt(decoded.permissions);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
  }
  return { uid: decoded.uid, bits };
}
export async function accessResponse(work: () => Promise<Response>) {
  try {
    return await work();
  } catch (err) {
    if (err instanceof AccessError)
      return NextResponse.json(
        { error: err.message, code: err.code, operationId: err.operationId },
        { status: err.status },
      );
    if (err instanceof ZodError || err instanceof SyntaxError)
      return NextResponse.json(
        { error: 'Dados inválidos.', code: 'INVALID_INPUT' },
        { status: 400 },
      );
    if (err instanceof FirebaseAuthError) {
      const tokenError = [
        'auth/id-token-expired',
        'auth/id-token-revoked',
        'auth/argument-error',
        'auth/user-disabled',
        'auth/invalid-id-token',
      ].includes(err.code);
      return NextResponse.json(
        {
          error: tokenError ? 'Token inválido ou expirado.' : 'Falha no serviço de autenticação.',
          code: err.code,
        },
        { status: tokenError ? 401 : 502 },
      );
    }
    if (err instanceof FirebaseAppError)
      return NextResponse.json(
        { error: 'Falha ao inicializar Firebase Admin.', code: err.code },
        { status: 500 },
      );
    throw err;
  }
}
