import { z } from 'zod';

import { ARQUIVOS_COLLECTION } from '../../../storage/arquivo';

/**
 * One element of `produto.anexos` — a generic file attachment (manuals, certs,
 * datasheets…). Mirrors the Flutter `Anexo` model
 * (`packages/produtos/lib/src/models.dart:3899`): a single required
 * `arquivoOuterRef`, a plain `arquivos/<id>` document-path **string** (the same
 * bare arquivo-ref shape as `Foto.arquivoOuterRef`, not the
 * `documents/<col>/<id>` form used for cross-model references).
 *
 * `.passthrough()` keeps any extra fields the Flutter app may write.
 */
export const anexoSchema = z
  .object({
    arquivoOuterRef: z.string().min(1),
  })
  .passthrough();

export type Anexo = z.infer<typeof anexoSchema>;

/**
 * Build an `Anexo` from an uploaded arquivo doc id — the attachment counterpart
 * of `buildFotoRefs`. Centralizes the bare `arquivos/<id>` ref shape so callers
 * (the AnexoManager) never hand-build it.
 */
export function buildAnexo(arquivoId: string): Anexo {
  return { arquivoOuterRef: `${ARQUIVOS_COLLECTION}/${arquivoId}` };
}
