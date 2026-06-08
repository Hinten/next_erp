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

export type SignedHandler<T> = (input: {
  req: Request;
  payload: string;
  json: T | undefined;
}) => Promise<Response> | Response;

export function withSignature<T = unknown>(
  options: WithSignatureOptions,
  handler: SignedHandler<T>,
) {
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
    let json: T | undefined;
    try {
      json = payload ? (JSON.parse(payload) as T) : undefined;
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
