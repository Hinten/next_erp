/**
 * The receiver's bounded body read (step 3, PR 3-c): Web Streams only, so it is
 * Next-free and runs on any `Request` (a test hands in a plain stream).
 *
 * The receiver is public and reads its body only AFTER the relay key matched,
 * but a key holder (the relay) can still send anything, so the read is bounded.
 * ⚠️ The bound exists to stop an UNBOUNDED read, never to filter Amazon's
 * input: it must sit above anything the relay delivers, or a valid
 * notification is dropped with a 200 (`corpo-grande`) and its order is left to
 * the 15-minute poll.
 *
 * - An SQS message is at most {@link MAX_MENSAGEM_SQS_BYTES} (1 MiB since AWS
 *   raised the maximum in August 2025), and the relay's queue
 *   (`infra/amazon-relay`) sets no smaller `maxMessageSizeBytes`.
 * - The Pipe wraps that body as `{"body": <$.body>}` (`envelope.ts`). As an
 *   OBJECT the wrapper adds 10 bytes. As a JSON STRING, JSON's escaping turns
 *   each `"`, `\`, tab, CR and LF into two bytes (no other character of valid
 *   JSON text must be escaped) and the wrapper adds about a dozen: at most
 *   twice the body, plus the wrapper, minus the body's unescaped bytes — and
 *   a notification's type key alone has 16 of those.
 * - So {@link MAX_CORPO_RECEPTOR_BYTES}, twice the SQS maximum, holds both
 *   forms of the largest message the queue accepts. Only an encoder escaping
 *   beyond what JSON requires (`\uXXXX` for every non-ASCII character) could
 *   pass it, and only for a body close to that maximum.
 *
 * The read STOPS at the bound — it never buffers the rest — and the stream is
 * cancelled. A declared `content-length` above the bound is refused before a
 * single chunk is read.
 */

/** SQS's maximum message size: 1 MiB (1,048,576 bytes), raised from 256 KiB in August 2025. */
export const MAX_MENSAGEM_SQS_BYTES = 1024 * 1024;

/**
 * The largest body the receiver reads: 2 MiB, twice SQS's maximum (the relay
 * wrapper and its JSON-string escaping included; see above).
 */
export const MAX_CORPO_RECEPTOR_BYTES = 2 * MAX_MENSAGEM_SQS_BYTES;

/** A `content-length` the read can trust: plain digits, nothing else. */
const COMPRIMENTO_DECLARADO = /^\d{1,15}$/;

export type LeituraCorpoAmazon =
  /** The whole body, at most `maxBytes`. */
  | { readonly tipo: 'lido'; readonly dados: Uint8Array; readonly bytes: number }
  /**
   * Over the bound: nothing is returned. `bytes` is what the read counted when it
   * stopped (one chunk past the bound at most), or the declared length when the
   * header alone refused it.
   */
  | { readonly tipo: 'grande'; readonly bytes: number };

/**
 * Read `stream` up to `maxBytes`.
 *
 * - `stream` null (no body) ⇒ an empty read.
 * - `contentLength` that parses as digits and exceeds `maxBytes` ⇒ `grande`
 *   with ZERO chunks read (the stream is cancelled). A missing or unparseable
 *   header is ignored: the count while reading decides.
 * - Chunks are counted as they arrive; the first one that takes the total past
 *   `maxBytes` stops the read and cancels the stream.
 *
 * A stream error (the client went away) propagates: it is the caller's 5xx.
 */
export async function lerCorpoLimitado(
  stream: ReadableStream<Uint8Array> | null,
  contentLength: string | null,
  maxBytes: number,
): Promise<LeituraCorpoAmazon> {
  if (stream === null) return { tipo: 'lido', dados: new Uint8Array(0), bytes: 0 };
  if (contentLength !== null && COMPRIMENTO_DECLARADO.test(contentLength)) {
    const declarado = Number(contentLength);
    if (declarado > maxBytes) {
      await stream.cancel();
      return { tipo: 'grande', bytes: declarado };
    }
  }
  const leitor = stream.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await leitor.cancel();
      return { tipo: 'grande', bytes: total };
    }
    partes.push(value);
  }
  const dados = new Uint8Array(total);
  let posicao = 0;
  for (const parte of partes) {
    dados.set(parte, posicao);
    posicao += parte.byteLength;
  }
  return { tipo: 'lido', dados, bytes: total };
}
