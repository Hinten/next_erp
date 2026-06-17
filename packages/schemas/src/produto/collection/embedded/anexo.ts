import { z } from 'zod';

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
