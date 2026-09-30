/**
 * Read + validate a JSON request body for a payment-link route (#367).
 *
 * The three `links/*` routes share this instead of carrying three copies: a body
 * that is not JSON is a 400, a body that fails its schema is a 400 that names the
 * offending FIELD PATHS, and anything else rethrows. Precedent:
 * `apps/mercado-livre/.../enviar-nfe/route.ts` (`SyntaxError` → 400, `safeParse` → 400).
 *
 * ⚠️ The 400 message carries PATHS, never values. The body holds payer names and
 * money, and Zod's own messages can echo the offending input, so the response is
 * built from `issue.path` alone (plus the KEY names of an `unrecognized_keys`
 * issue, which are the caller's own field names, not data).
 *
 * ⚠️ ROUTE-ONLY: this imports `next/server`. Nothing the functions codebase
 * bundles (`lib/payments/notificacao.ts` and its imports) may import this file.
 */
import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { CODIGO_ERRO_LINK } from '@delfrance/schemas';

/** How many offending paths one 400 lists — enough to fix a form, bounded for a hostile body. */
const MAX_CAMINHOS = 10;
/** A path segment is a field name; anything longer is not one. */
const MAX_CHARS_CAMINHO = 80;

/** The distinct, bounded, value-free list of paths a failed parse complains about. */
export function caminhosDoErro(erro: z.ZodError): string[] {
  const caminhos = new Set<string>();
  for (const issue of erro.issues) {
    const base = issue.path.map(String);
    // A strict object reports an unknown key at its PARENT's path, which alone
    // ("corpo") would not say which key to remove — list each key under it.
    const completos =
      issue.code === 'unrecognized_keys' ? issue.keys.map((chave) => [...base, chave]) : [base];
    for (const partes of completos) {
      const caminho = partes.length > 0 ? partes.join('.') : 'corpo';
      caminhos.add(caminho.slice(0, MAX_CHARS_CAMINHO));
    }
  }
  return [...caminhos].slice(0, MAX_CAMINHOS);
}

function corpoInvalido(mensagem: string): NextResponse {
  return NextResponse.json(
    { error: mensagem, code: CODIGO_ERRO_LINK.corpoInvalido },
    { status: 400 },
  );
}

export type CorpoLido<T> = { ok: true; data: T } | { ok: false; response: NextResponse };

export async function lerCorpo<T>(req: Request, schema: z.ZodType<T>): Promise<CorpoLido<T>> {
  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch (err) {
    // Not JSON (or an empty body). Anything that is not a `SyntaxError` is not
    // ours to swallow.
    if (err instanceof SyntaxError) {
      return { ok: false, response: corpoInvalido('Body JSON inválido.') };
    }
    throw err;
  }
  const analise = schema.safeParse(bruto);
  if (!analise.success) {
    return {
      ok: false,
      response: corpoInvalido(`Body inválido: ${caminhosDoErro(analise.error).join(', ')}.`),
    };
  }
  return { ok: true, data: analise.data };
}
