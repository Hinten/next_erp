/**
 * The checks a CAPTURED Shopee body must pass before `reproduzir:pedido` serves
 * it — the ONE copy, read by two callers that must agree:
 *
 *  - the replay engine (`reproduzirPedido.ts`), which refuses a file that fails
 *    them before anything reaches the importer;
 *  - `capturar:pedido` (`capturarPedidoCli.ts`), which must not SAVE an escrow
 *    the replay would refuse, nor print a next-step command with an `--escrow`
 *    that then fails.
 *
 * Two copies of "what the replay accepts" would drift toward plausible while
 * disagreeing (root CLAUDE.md, #1369) — the capture once judged an escrow by a
 * looser "is it an envelope at all" test, saved `{"error":"","response":null}`
 * and recommended a replay that refused it. One copy cannot.
 *
 * Pure: no clock, no env, no Firestore, no network. It imports only the CLI
 * module's error class, so the capture can read it without loading the
 * importer's graph.
 */
import { CapturaInvalidaError } from './reproduzirPedidoCli';

/** A UTF-8 BOM — what a Windows editor or PowerShell's `Out-File` writes first. */
const BOM = '﻿';

/** A top-level key we are willing to NAME in a refusal: identifier-shaped, short. */
const CHAVE_NOMEAVEL = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

/** A Shopee error code worth naming: a lowercase dotted/underscored token. */
const CODIGO_DE_ERRO = /^[A-Za-z0-9_.]{1,64}$/;

export function objetoSimples(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** The texts as the replay serves them: the BOM dropped, nothing else touched. */
export function semBom(texto: string): string {
  return texto.startsWith(BOM) ? texto.slice(BOM.length) : texto;
}

/**
 * The top-level key NAMES of a parsed capture, for a refusal — never a value.
 * A key that is not identifier-shaped is counted, not printed: a file that is
 * not a Shopee body can carry anything as a key.
 */
function chavesParaRecusa(objeto: Record<string, unknown>): string {
  const chaves = Object.keys(objeto);
  const nomeaveis = chaves.filter((c) => CHAVE_NOMEAVEL.test(c)).slice(0, 12);
  const resto = chaves.length - nomeaveis.length;
  const lista = nomeaveis.length === 0 ? '(nenhuma nomeável)' : nomeaveis.join(', ');
  return resto > 0 ? `${lista} (+${String(resto)} outra(s))` : lista;
}

/**
 * Parse one capture and check it is a Shopee ENVELOPE (`{ error, message,
 * response }`) — before anything reaches the client, so a wrong file fails here
 * with a sentence instead of deep inside the wire schema.
 *
 * ⚠️ `JSON.parse`'s own message can quote the input, so it is never forwarded.
 */
export function lerEnvelope(
  papel: '--detalhe' | '--escrow',
  texto: string,
): Record<string, unknown> {
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto) as unknown;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new CapturaInvalidaError(
        `${papel} não é um JSON válido. O arquivo tem de ser o corpo CRU da resposta da Shopee ` +
          '(o JSON inteiro, como veio), salvo em UTF-8.',
      );
    }
    throw err;
  }
  const envelope = objetoSimples(bruto);
  if (envelope === null) {
    throw new CapturaInvalidaError(
      `${papel} não é um objeto JSON (veio ${Array.isArray(bruto) ? 'uma lista' : typeof bruto}). ` +
        'O arquivo tem de ser o corpo CRU da resposta da Shopee: { "error", "message", "response" }.',
    );
  }
  if (!('response' in envelope) && !('error' in envelope)) {
    throw new CapturaInvalidaError(
      `${papel} não é o envelope da Shopee: nenhuma chave "response" nem "error" no topo ` +
        `(chaves vistas: ${chavesParaRecusa(envelope)}). O arquivo tem de ser o corpo CRU da ` +
        'resposta — não só o "response", nem a saída de outra ferramenta.',
    );
  }
  return envelope;
}

/** The envelope's `error` as a nameable code, or a description of why it is not one. */
export function codigoDoEnvelope(envelope: Record<string, unknown>): string {
  const erro = envelope.error;
  if (erro === undefined || erro === null || erro === '') return '(vazio)';
  return typeof erro === 'string' && CODIGO_DE_ERRO.test(erro) ? erro : '(formato inesperado)';
}

/** What the escrow capture turned out to be. */
export type EscrowCapturado =
  /** No `--escrow`: the escrow call is REFUSED like a network failure. */
  | 'ausente'
  /** A success body for the chosen order. */
  | 'resposta'
  /** A Shopee error envelope (an unpaid order, say): served as-is. */
  | 'erro';

/**
 * The escrow capture must be the SAME order's. Compared, never printed.
 *
 * ⚠️ An error envelope (no `response`, a non-empty `error`) is accepted and
 * served verbatim: it is a legitimate capture of "Shopee has no escrow for
 * this order yet", and the importer contains it exactly as it would live.
 */
export function conferirEscrow(
  envelope: Record<string, unknown>,
  orderSn: string,
): { readonly tipo: EscrowCapturado; readonly resposta: Record<string, unknown> | null } {
  const resposta = objetoSimples(envelope.response);
  if (resposta === null) {
    if (codigoDoEnvelope(envelope) !== '(vazio)') return { tipo: 'erro', resposta: null };
    throw new CapturaInvalidaError(
      '--escrow não traz "response" e o "error" do envelope está vazio — não é uma resposta ' +
        'do get_escrow_detail.',
    );
  }
  if (resposta.order_sn !== orderSn) {
    throw new CapturaInvalidaError(
      'O par não confere: o order_sn do --escrow não é o da order escolhida no --detalhe. ' +
        'Capture os dois para a MESMA order.',
    );
  }
  return { tipo: 'resposta', resposta };
}

/**
 * Why `reproduzir:pedido` would REFUSE this escrow text for this order — the
 * refusal's own sentence (value-free by construction: it names roles, keys and
 * codes, never a value) — or `null` when it would serve it. Exactly the two
 * checks the engine runs on `--escrow`, in its order: {@link lerEnvelope}, then
 * {@link conferirEscrow}.
 */
export function recusaDoEscrowNaReproducao(texto: string, orderSn: string): string | null {
  try {
    conferirEscrow(lerEnvelope('--escrow', semBom(texto)), orderSn);
    return null;
  } catch (err) {
    if (err instanceof CapturaInvalidaError) return err.message;
    throw err;
  }
}
