import { z } from 'zod';

/** Carrier URLs can use HTTP (ML's documented Total Express example does). */
export const mercadoLivreRastreioResultSchema = z.object({
  name: z.string().nullable(),
  url: z.string().refine(
    (value) => {
      if (!/^https?:\/\//i.test(value)) return false;
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch (err) {
        if (err instanceof TypeError) return false;
        throw err;
      }
    },
    { message: 'URL de rastreio deve ser absoluta e usar HTTP ou HTTPS.' },
  ),
});

export type MercadoLivreRastreioResult = z.infer<typeof mercadoLivreRastreioResultSchema>;
