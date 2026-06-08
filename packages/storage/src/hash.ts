/**
 * Content-addressing hash. Files are stored under their `sha512` hex digest so
 * re-uploading identical bytes de-dups to the same object + `Arquivo` doc.
 * Parity with the Flutter `Arquivo.hexFromBytes` (also sha512).
 *
 * Uses the Web Crypto `SubtleCrypto` available in browsers and Node ≥ 18.
 */
export async function sha512Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer so the digest input is a plain (non-shared)
  // BufferSource — satisfies TS 6's stricter typed-array buffer generics.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const digest = await crypto.subtle.digest('SHA-512', ab);
  let out = '';
  for (const b of new Uint8Array(digest)) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

/** Normalize an upload input to `Uint8Array` for hashing + upload. */
export async function toBytes(
  input: Uint8Array | ArrayBuffer | Blob,
): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(await input.arrayBuffer());
}
