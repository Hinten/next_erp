const DOC_ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Mint a Firestore-style 20-char doc id client-side. `defineCollection` has no
 * auto-id helper and raw `doc(collection(...))` refs are lint-forbidden in
 * apps/web, so callers generate the id and go through a handle's `docRef`.
 */
export function newDocId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let id = '';
  for (const b of bytes) id += DOC_ID_CHARS[b % DOC_ID_CHARS.length];
  return id;
}
