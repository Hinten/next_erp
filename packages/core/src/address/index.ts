import { z } from 'zod';

const brAddress = z.object({
  kind: z.literal('br'),
  cep: z.string().regex(/^\d{5}-?\d{3}$/),
  logradouro: z.string().min(1),
  numero: z.string().min(1),
  complemento: z.string().optional(),
  bairro: z.string().min(1),
  cidade: z.string().min(1),
  uf: z.string().length(2),
});

const intlAddress = z.object({
  kind: z.literal('intl'),
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().length(2), // ISO 3166-1 alpha-2
});

export const addressSchema = z.discriminatedUnion('kind', [brAddress, intlAddress]);

export type Address = z.infer<typeof addressSchema>;
export type BrAddress = z.infer<typeof brAddress>;
export type IntlAddress = z.infer<typeof intlAddress>;
