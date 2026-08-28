import { NextResponse } from 'next/server';
import { type HmacVerifyInput, verifyHmac } from './hmac';

/**
 * Higher-order route handler: parses the request body once, verifies the
 * signature against the configured secret, and forwards the parsed
 * payload (string + already-decoded JSON if applicable) to the inner
 * handler. Rejects with 401 on mismatch.
 *
 * Each marketplace has its own header convention; the caller passes
 * `getSignature(req)` to extract the value before verification.
 */
export interface WithSignatureOptions {
  secret: string | undefined;
  /**
   * How to extract the raw signature string from the incoming request.
   * Examples:
   *   - Mercado Livre: req.headers.get('x-meli-signature')
   *   - Shopee:        req.headers.get('authorization')?.split(' ')[1]
   *   - Generic HMAC:  req.headers.get('x-signature')
   */
  getSignature: (req: Request) => string | null | undefined;
  /** Override defaults from `verifyHmac` (algorithm, encoding). */
  algorithm?: HmacVerifyInput['algorithm'];
  encoding?: HmacVerifyInput['encoding'];
}

/**
 * ⚠️ `json` is `unknown`, not a caller-chosen `T`.
 *
 * It used to be `SignedHandler<T>` with `JSON.parse(payload) as T` below — an
 * unsound cast on the one body in the repo an ATTACKER can shape. The HMAC
 * above proves the sender knew the secret; it proves nothing about the shape,
 * and a handler reading `json.data.id` off a verified-but-arbitrary payload is
 * the same silent-nothing this sweep exists to remove.
 *
 * The handler narrows it — a Zod schema, or the `typeof` checks the melhor-envio
 * receiver uses. There are no call sites today, so this costs nobody anything
 * and stops the next channel inheriting the cast.
 */
export type SignedHandler = (input: {
  req: Request;
  payload: string;
  json: unknown;
}) => Promise<Response> | Response;

export function withSignature(options: WithSignatureOptions, handler: SignedHandler) {
  return async function POST(req: Request): Promise<Response> {
    if (!options.secret) {
      return NextResponse.json({ error: 'webhook secret is not configured' }, { status: 500 });
    }
    const signature = options.getSignature(req) ?? '';
    if (!signature) {
      return NextResponse.json({ error: 'missing signature' }, { status: 401 });
    }
    const payload = await req.text();
    const ok = verifyHmac({
      payload,
      signature,
      secret: options.secret,
      algorithm: options.algorithm,
      encoding: options.encoding,
    });
    if (!ok) {
      return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
    }
    let json: unknown;
    try {
      json = payload ? (JSON.parse(payload) as unknown) : undefined;
    } catch (err) {
      if (err instanceof SyntaxError) {
        // Some webhook providers send form-encoded bodies; the inner handler
        // gets the raw payload either way and can parse as it sees fit.
        json = undefined;
      } else {
        throw err;
      }
    }
    return handler({ req, payload, json });
  };
}
