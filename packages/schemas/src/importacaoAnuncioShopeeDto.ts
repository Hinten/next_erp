import { z } from 'zod';

export const MODO_BUSCA_ANUNCIO_SHOPEE = {
  id: 'id',
  sku: 'sku',
  nome: 'nome',
} as const;

export type ModoBuscaAnuncioShopee =
  (typeof MODO_BUSCA_ANUNCIO_SHOPEE)[keyof typeof MODO_BUSCA_ANUNCIO_SHOPEE];

const idDoAnuncio = z.int().positive();
const termoDeBusca = z.string().trim().min(1);

export const buscaAnuncioShopeeTermoSchema = z.discriminatedUnion('modo', [
  z.object({
    modo: z.literal(MODO_BUSCA_ANUNCIO_SHOPEE.id),
    termo: termoDeBusca.regex(/^\d+$/).transform(Number).pipe(idDoAnuncio),
  }),
  z.object({ modo: z.literal(MODO_BUSCA_ANUNCIO_SHOPEE.sku), termo: termoDeBusca }),
  z.object({ modo: z.literal(MODO_BUSCA_ANUNCIO_SHOPEE.nome), termo: termoDeBusca }),
]);

export const respostaBuscaAnunciosShopeeSchema = z.object({
  resultados: z.array(
    z.object({ itemId: idDoAnuncio, nome: z.string().nullable(), sku: z.string().nullable() }),
  ),
  proximoCursor: z.string().min(1).nullable(),
});

export type RespostaBuscaAnunciosShopee = z.infer<typeof respostaBuscaAnunciosShopeeSchema>;

export const respostaImportarAnuncioShopeeSchema = z.object({
  produtoId: z.string().min(1),
  criado: z.boolean(),
  nome: z.string(),
});

export type RespostaImportarAnuncioShopee = z.infer<typeof respostaImportarAnuncioShopeeSchema>;
