/**
 * Cache-aware single-file download. Mirrors Flutter
 * `downloadArquivoUsingLocalCache`: IDB hit → trigger download from bytes;
 * miss → fetch `arquivo.url`, cache, then download.
 *
 * Uses object-URL `saveBlob` (not data: base64) so large attachments are not
 * truncated by browser data-URL length caps.
 */
import { saveBlob } from '@/lib/nfe/saveBlob';

import type { ArquivoCache, CachedArquivo } from './localArquivoCache';
import { createIdbArquivoCache } from './localArquivoCache';

export interface ArquivoDownloadMeta {
  readonly id: string;
  readonly url: string;
  readonly contentType: string;
  readonly fileName: string;
}

export interface DownloadArquivoDeps {
  readonly cache?: ArquivoCache;
  readonly fetchImpl?: typeof fetch;
  readonly save?: (blob: Blob, fileName: string) => void;
  readonly now?: () => number;
}

export type DownloadArquivoResult =
  | { readonly ok: true; readonly fromCache: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Download one arquivo. Returns a structured result so the bulk orchestrator
 * can skip + continue instead of aborting the whole batch (legacy bug).
 */
export async function downloadArquivo(
  meta: ArquivoDownloadMeta,
  deps: DownloadArquivoDeps = {},
): Promise<DownloadArquivoResult> {
  const cache = deps.cache ?? createIdbArquivoCache();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const save = deps.save ?? saveBlob;
  const now = deps.now ?? Date.now;

  let cached: CachedArquivo | null = null;
  try {
    cached = await cache.get(meta.id);
  } catch (err) {
    // Private mode / disabled storage — treat as miss; rethrow anything else.
    if (!(err instanceof DOMException)) throw err;
  }

  if (cached) {
    save(new Blob([cached.bytes], { type: cached.contentType }), meta.fileName || cached.fileName);
    return { ok: true, fromCache: true };
  }

  if (!meta.url) {
    return { ok: false, reason: `Arquivo ${meta.id} sem URL` };
  }

  let res: Response;
  try {
    res = await fetchImpl(meta.url);
  } catch (err) {
    // `fetch` rejects with TypeError on network failure / invalid URL.
    if (err instanceof TypeError) {
      return { ok: false, reason: `Erro ao baixar ${meta.fileName}: ${err.message}` };
    }
    throw err;
  }

  if (!res.ok) {
    return { ok: false, reason: `Falha ao baixar ${meta.fileName} (HTTP ${res.status})` };
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await res.arrayBuffer();
  } catch (err) {
    if (err instanceof TypeError) {
      return { ok: false, reason: `Erro ao ler ${meta.fileName}: ${err.message}` };
    }
    throw err;
  }

  const contentType =
    meta.contentType ||
    res.headers.get('content-type')?.split(';')[0]?.trim() ||
    'application/octet-stream';
  const entry: CachedArquivo = {
    contentType,
    fileName: meta.fileName,
    bytes,
    cachedAt: now(),
  };
  try {
    await cache.put(meta.id, entry);
  } catch (err) {
    // Cache write is best-effort (quota / private mode) — still deliver download.
    if (!(err instanceof DOMException)) throw err;
  }

  save(new Blob([bytes], { type: contentType }), meta.fileName);
  return { ok: true, fromCache: false };
}
