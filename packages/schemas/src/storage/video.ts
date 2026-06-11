import { z } from 'zod';

/** Aspect-ratio bucket. `quadrado` ≈ 1:1 (0.8–1.2), else `retangular`. */
export const videoFormatoSchema = z.enum(['quadrado', 'retangular']);
export type VideoFormato = z.infer<typeof videoFormatoSchema>;

/**
 * A product video, embedded as an element of `Produto.videos`. Mirrors the
 * Flutter `VideoProduto` wire shape (`packages/produtos/lib/src/models.g.dart`
 * → `_$VideoProdutoToJson`): `arquivoOuterRef` is a plain `arquivos/<id>`
 * document-path string. Videos are **not** resized — there are no derivatives;
 * the metadata (`formato`, dimensions, duração, marketplace-compat flags) is
 * computed client-side at upload time.
 *
 * Only `arquivoOuterRef` is required; the rest are nullable/defaulted so a
 * Flutter-written video — or a slightly-off one — never breaks the whole Produto
 * parse. `.passthrough()` keeps any extra fields the Flutter app may write.
 */
export const videoSchema = z
  .object({
    arquivoOuterRef: z.string().min(1),
    formato: videoFormatoSchema.nullable().default(null),
    duracaoSegundos: z.number().int().nullable().default(null),
    larguraPx: z.number().int().nullable().default(null),
    alturaPx: z.number().int().nullable().default(null),
    // Null-tolerant: the Flutter wire reads `as bool? ?? false`, so the stored
    // value may be null/absent — coerce both to `false` (always boolean out) so
    // a legacy/null flag can't break the whole Produto parse.
    usarMercadoLivre: z.preprocess((v) => v ?? false, z.boolean()),
    usarShopee: z.preprocess((v) => v ?? false, z.boolean()),
    dataCadastro: z.number().int().nullable().default(null),
    nomeArquivo: z.string().nullable().default(null),
  })
  .passthrough();

export type Video = z.infer<typeof videoSchema>;
