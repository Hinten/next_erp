import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
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
  // ⚠️ `[0-9A-Z]`, not `\d`: this is `<card><CNPJ>`, the credenciadora / payment
  // institution — a COUNTERPARTY, and RFB IN 2.229/2024 issues alphanumeric
  // CNPJs to newly registered establishments. The NF-e `cardSchema` takes a bare
  // string and the XSD facet does the checking, so nothing downstream had to
  // move.
  // ⚠️ This field is the STRICTER of two spellings of the same value:
  // `pedido/collection/pagamento.ts`'s `cartao.cnpj_instituicao` carries no
  // regex at all, so a value this catalogue refuses can still reach a pedido.
  // Widening here narrows that gap rather than closing it — closing it means
  // deciding which of the two is authoritative, which is not this change.
  // ⚠️ Letters only in the ALFA CNPJ SHAPE, not everywhere. `^[0-9A-Z]*$` — the
  // spelling `cliente.cpf_cnpj` uses — would also accept `ABCDEFGHIJK` and
  // `12ABC34501DEFG`, and `cliente` can afford that because it carries a
  // `validateCpfCnpj` refine behind it. This field does NOT (see below), so the
  // regex is the whole guard, and the old `\d*` at least guaranteed a 14-char
  // value was numeric. The `\d*` alternative keeps every legacy value — empty,
  // partial, full — so rule 8 read-tolerance is untouched; the second branch
  // adds exactly `[0-9A-Z]{12}[0-9]{2}` and nothing wider.
  // ⚠️ It matters more here than elsewhere: `generator-input.ts` copies this
  // value into `<card><CNPJ>` VERBATIM, with no re-check, so a letter in a DV
  // position would store cleanly in the catalogue and first surface at XSD
  // validation or at SEFAZ — at emission time rather than at the form.
  cnpj_instituicao: z
    .string()
    .max(14)
    .regex(/^(\d*|[0-9A-Z]{12}\d{2})$/, 'apenas números, ou um CNPJ alfanumérico')
    .nullable()
    .describe('CNPJ da instituição'),
  bandeira: bandeiraSchema.nullable().describe('Bandeira'),
  tarifa: z.number().min(0).default(0).describe('Tarifa (%)'),
  tarifaFixa: z.number().min(0).default(0).describe('Tarifa fixa'),
  maxParcelas: z.number().int().min(1).default(1).describe('Máximo de parcelas'),
  prazoRecebimento: z.number().int().min(0).default(0).describe('Prazo de recebimento (dias)'),
  dataCadastro: millisSinceEpoch().nullable().optional(),
  // `.default(null)`, never a bare `.optional()`: the TableView update-
  // monitor runs a CLASSIC `orderBy(ultimaModificacao, 'desc').limit(1)`,
  // which EXCLUDES documents missing the key — so a dropped key hides the
  // row from the staleness check, silently. Pinned by
  // `defaultQuery.sortKeyPresence.test.ts`.
  ultimaModificacao: millisSinceEpoch().nullable().default(null),
});

export type BandeiraCartao = z.infer<typeof bandeiraCartaoSchema>;

export const bandeiraCartaoMeta: CollectionMetadata = {
  collectionPath: 'bandeirasCartao',
  permissions: {
    read: PERM_PAGAMENTO_READ,
    write: PERM_PAGAMENTO_WRITE,
    delete: PERM_PAGAMENTO_DELETE,
  },
  defaultQuery: {
    orderBy: [{ field: 'nome', direction: 'asc' }],
    limit: 50,
    columns: ['nome', 'bandeira', 'ehCredito', 'maxParcelas'],
  },
};

export const bandeiraCartao = {
  schema: bandeiraCartaoSchema,
  meta: bandeiraCartaoMeta,
};
