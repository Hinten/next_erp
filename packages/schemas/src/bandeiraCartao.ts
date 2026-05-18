import { z } from 'zod';
import type { CollectionMetadata } from './types';

// Mirror `PERM.pagamento` from @delfrance/auth.
const PERM_PAGAMENTO_READ = 1n << 24n;
const PERM_PAGAMENTO_WRITE = 1n << 25n;
const PERM_PAGAMENTO_DELETE = 1n << 26n;

// Human-readable labels keyed by wire value. Declared before `bandeiraSchema`
// so it can be attached via `.meta({ labels })` — the schema-driven UI
// (`@delfrance/ui`) reads that to render the Select / Badge.
const BANDEIRA_LABEL_MAP = {
  '01': 'Visa',
  '02': 'Mastercard',
  '03': 'American Express',
  '04': 'Sorocred',
  '05': 'Diners',
  '06': 'Elo',
  '07': 'Hipercard',
  '08': 'Aura',
  '09': 'Cabal',
  '99': 'Outros',
} as const;

/**
 * bandeiraEnum — string-coded ('01'..'09', '99'). Wire format matches
 * Flutter's `bandeiraEnum.value` exactly.
 */
export const bandeiraSchema = z
  .enum([
    '01', // visa
    '02', // mastercard
    '03', // american_express
    '04', // sorocred
    '05', // diners
    '06', // elo
    '07', // hipercard
    '08', // aura
    '09', // cabal
    '99', // outros
  ])
  .meta({ labels: BANDEIRA_LABEL_MAP });
export type Bandeira = z.infer<typeof bandeiraSchema>;

export const BANDEIRA = {
  visa: '01',
  mastercard: '02',
  american_express: '03',
  sorocred: '04',
  diners: '05',
  elo: '06',
  hipercard: '07',
  aura: '08',
  cabal: '09',
  outros: '99',
} as const satisfies Record<string, Bandeira>;

export const BANDEIRA_LABELS: Record<Bandeira, string> = BANDEIRA_LABEL_MAP;

/**
 * BandeiraCartao — bandeira de cartão aceita pela loja (Visa, Master, Elo…).
 * Mirrors `BandeiraCartao` em `.old/packages/pedido/lib/src/models.dart`.
 */
export const bandeiraCartaoSchema = z.object({
  ehCredito: z.boolean().describe('Cartão de crédito'),
  nome: z.string().min(1).max(255).describe('Nome'),
  cnpj_instituicao: z
    .string()
    .max(14)
    .regex(/^\d*$/, 'apenas números')
    .nullable()
    .describe('CNPJ da instituição'),
  bandeira: bandeiraSchema.nullable().describe('Bandeira'),
  tarifa: z.number().min(0).default(0).describe('Tarifa (%)'),
  tarifaFixa: z.number().min(0).default(0).describe('Tarifa fixa'),
  maxParcelas: z.number().int().min(1).default(1).describe('Máximo de parcelas'),
  prazoRecebimento: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Prazo de recebimento (dias)'),
  dataCadastro: z.string().datetime().nullable().optional(),
  ultimaModificacao: z.string().datetime().nullable().optional(),
});

export type BandeiraCartao = z.infer<typeof bandeiraCartaoSchema>;

export const bandeiraCartaoMeta: CollectionMetadata = {
  collectionPath: 'bandeirasCartao',
  permissions: {
    read: PERM_PAGAMENTO_READ,
    write: PERM_PAGAMENTO_WRITE,
    delete: PERM_PAGAMENTO_DELETE,
  },
};

export const bandeiraCartao = {
  schema: bandeiraCartaoSchema,
  meta: bandeiraCartaoMeta,
};
