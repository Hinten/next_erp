/**
 * Firebase-user Bearer/permission guard shared by the API backends (#1431).
 *
 * Apps inject their lazy Admin getter and the concrete SDK error constructors:
 * this subtree has no runtime Firebase imports (adminBundleSafety.test.ts).
 * HTTP response construction stays with the app, so this module needs no Next.
 */
import type { Auth } from 'firebase-admin/auth';
import { hasPerm } from '@delfrance/auth';

export interface VerifiedCaller {
  readonly uid: string;
  readonly permissions: string | undefined;
}

export type CallerVerificationResult =
  | { readonly caller: VerifiedCaller }
  | {
      readonly error: {
        readonly status: 401 | 403 | 500;
        readonly body: { readonly error: string; readonly code?: string };
      };
    };

/** Same constructor-injection seam as admin/cargoClaims/claims.ts. */
type CodedErrorType = abstract new (...args: never[]) => Error & { readonly code: string };

export interface CallerVerifierOptions {
  readonly getAdminAuth: () => Pick<Auth, 'verifyIdToken'>;
  readonly authErrorType: CodedErrorType;
  readonly appErrorType: CodedErrorType;
  /** The label inside brackets, e.g. 'mercado-livre/auth'. */
  readonly logPrefix: string;
  readonly includeAuthErrorMessageInLog?: boolean;
  readonly includeAdminErrorMessageInResponse?: boolean;
}

export function createCallerVerifier(options: CallerVerifierOptions) {
  return async (req: Request, required: bigint): Promise<CallerVerificationResult> => {
    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return {
        error: { status: 401, body: { error: 'Authorization Bearer token ausente.' } },
      };
    }
    const idToken = authHeader.slice('Bearer '.length);
    try {
      // Keep initialization lazy AND inside the error boundary. An invalid header
      // needs no Admin client, and a synchronous FirebaseAppError is a 500.
      const decoded = await options.getAdminAuth().verifyIdToken(idToken);
      const permissions = decoded.permissions as string | undefined;
      if (!hasPerm(permissions, required)) {
        return {
          error: { status: 403, body: { error: 'Sem permissão para esta operação.' } },
        };
      }
      return { caller: { uid: decoded.uid, permissions } };
    } catch (err) {
      if (err instanceof options.authErrorType) {
        const code = err.code;
        const detail = options.includeAuthErrorMessageInLog ? ` - ${err.message}` : '';
        console.warn(`[${options.logPrefix}] verifyIdToken rejected: ${code}${detail}`);
        return {
          error: {
            status: 401,
            body: { error: `Token inválido ou expirado (${code}).`, code },
          },
        };
      }
      if (err instanceof options.appErrorType) {
        const code = err.code;
        console.error(`[${options.logPrefix}] admin init failed: ${code} - ${err.message}`);
        const detail = options.includeAdminErrorMessageInResponse ? `: ${err.message}` : '.';
        return {
          error: {
            status: 500,
            body: { error: `Falha ao inicializar Firebase Admin (${code})${detail}`, code },
          },
        };
      }
      throw err;
    }
  };
}
