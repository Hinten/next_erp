import { z } from 'zod';
import { validateCNPJ, validateCPF, validateCpfCnpj } from '@delfrance/core/documents';
import { isValidTelefone } from '@delfrance/core/phone';
import { millisSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';

// Permission bits live in @delfrance/auth. Duplicating the literal values
// here would create a circular dep; instead we encode the bit positions and
// let consumers compose with PERM at use sites if they want symbolic names.
const PERM_CLIENTE_READ = 1n << 0n;
const PERM_CLIENTE_WRITE = 1n << 1n;
const PERM_CLIENTE_DELETE = 1n << 2n;

/**
 * Tipo de cliente — wire format mirrors the Flutter `tipoCliente` enum
 * (string codes '0'/'1'/'2'). Preserving the wire format is required for
 * coexistence with the live app.
 */
export const TIPO_CLIENTE_LABELS = {
  '0': 'Pessoa Física',
  '1': 'Pessoa Jurídica',
  '2': 'Estrangeiro',
} as const;

export const tipoClienteSchema = z.enum(['0', '1', '2']).meta({ labels: TIPO_CLIENTE_LABELS });
export type TipoCliente = z.infer<typeof tipoClienteSchema>;

/**
 * Named members of {@link tipoClienteSchema} — a readable name for each wire
 * code, taken from what {@link TIPO_CLIENTE_LABELS} calls it. (That map is keyed
 * by the code, so its keys are the values here, not the names.)
 *
 * The cross-field document rule below turns on these codes — `'0'` requires a
 * CPF, `'1'` a CNPJ — so reading them wrong is a validation bug, not a cosmetic
 * one.
 *
 * Enforced by the `delfrance/prefer-schema-enum` lint rule, which fires for any
 * Zod enum that has a companion constant like this one.
 */
export const TIPO_CLIENTE = {
  pessoaFisica: '0',
  pessoaJuridica: '1',
  estrangeiro: '2',
} as const satisfies Record<string, TipoCliente>;

/**
 * The two sentinels `ie` carries instead of a real inscrição estadual —
 * uppercase and UNACCENTED, the canonical spelling every writer must store.
 *
 * `ie` is free text (see the field below), so the vocabulary has to live
 * somewhere both ends can see it: the NF-e generator reads it to derive
 * `dest.indIEDest` (`packages/integrations/nfe/src/generator/parties.ts`) and
 * the Mercado Livre order import writes it
 * (`apps/mercado-livre/lib/marketplace/orderCliente.ts`). Leaving it an
 * implicit contract between those two files is exactly how they drifted apart:
 * the port carried the legacy writer and never carried the legacy reader.
 *
 * These literals are the ones the legacy Flutter NF-e reader compares against
 * after its own normalization (`.old/packages/pedido_nfe/lib/src/
 * pedido_nfe_base.dart:675-678`), so a cliente we write matches the still-
 * running Flutter app with no normalization on its side. Both fit `ie`'s
 * `max(16)` — `NAO CONTRIBUINTE` is exactly 16 characters.
 *
 * A sentinel is a CLAIM, and worth making explicitly: `isento` in particular
 * drives `indIEDest='2'`, which SEFAZ only accepts in the narrow circumstances
 * NT 2025.001 rule E16a-30 left open. A blank `ie` is not a synonym for either
 * sentinel — it means nobody has classified the cliente yet.
 */
export const IE_SENTINELA = {
  isento: 'ISENTO',
  naoContribuinte: 'NAO CONTRIBUINTE',
} as const satisfies Record<string, string>;

/**
 * Canonical form of an `ie` value for comparison against {@link IE_SENTINELA}:
 * strip diacritics (NFD decomposition, same as the NF-e package's
 * `removerAcentos` — inlined because `schemas` cannot depend on
 * `integrations/nfe`), uppercase, trim, collapse internal whitespace runs.
 * Blank input collapses to `null`, the schema's own "unset" shape.
 *
 * Readers MUST normalize before classifying rather than assume the stored value
 * is canonical: the existing base holds years of hand-typed values
 * (`Não contribuinte`, `NÃO CONTRIBUINTE`, stray whitespace) and the cadastro
 * screen still accepts free text. Writers use it to decide, then store the
 * {@link IE_SENTINELA} literal itself.
 *
 * Not for real inscrições estaduais — those are stored verbatim and the NF-e
 * generator strips them to digits at emission (the XSD's `[0-9]{2,14}`).
 */
export function normalizarIe(ie: string | null | undefined): string | null {
  if (ie == null) return null;
  const normalized = ie
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  return normalized === '' ? null : normalized;
}

/**
 * Cross-field rule: the document must match the tipo. A Pessoa Física (tipo
 * '0') requires a CPF; a Pessoa Jurídica (tipo '1') requires a CNPJ. The
 * field-level refine already guarantees `cpf_cnpj` is a valid CPF *or* CNPJ —
 * this ties it to the selected tipo (without it, a PF could save a CNPJ).
 * Estrangeiro (tipo '2') is NOT constrained here — its foreign id lives in
 * `idEstrangeiro` and the quick-create modal already nulls `cpf_cnpj` for it.
 * Shared by the full cliente form and the quick-create modal.
 */
export function refineClienteTipoDocumento(
  data: { tipo?: string | null; cpf_cnpj?: string | null },
  ctx: z.RefinementCtx,
): void {
  const doc = data.cpf_cnpj;
  if (!doc) return;
  if (data.tipo === '0' && !validateCPF(doc)) {
    ctx.addIssue({
      code: 'custom',
      path: ['cpf_cnpj'],
      message: 'Pessoa Física exige um CPF válido (11 dígitos).',
    });
  } else if (data.tipo === '1' && !validateCNPJ(doc)) {
    ctx.addIssue({
      code: 'custom',
      path: ['cpf_cnpj'],
      message: 'Pessoa Jurídica exige um CNPJ válido (14 caracteres).',
    });
  }
}

/**
 * Cliente schema. Fields mirror `packages/clientes/lib/src/models.dart`
 * shape so the Flutter app and this app share the same Firestore documents.
 *
 * `.describe()` strings are the source of truth for UI labels — consumed
 * by `extractFieldsFromSchema()` in `@delfrance/ui`. Plain strings become
 * the label; JSON objects encode richer hints (kind overrides, reference
 * collection ids, etc.).
 *
 * Vector embeddings (`nome_embedding`, `telefone_embedding`) are written by
 * server-side code (Functions). They aren't part of the form schema; the
 * runtime treats them as opaque pass-through.
 */
export const clienteSchema = z.object({
  tipo: tipoClienteSchema.nullable().default(null).describe('Tipo'),
  nome: z.string().max(255).nullable().default(null).describe('Nome'),
  // Letters allowed: the alphanumeric CNPJ (IN RFB 2.229/2024) has 12
  // alphanumeric positions + 2 numeric check digits. CPF stays numeric.
  cpf_cnpj: z
    .string()
    .max(18)
    .regex(/^[0-9A-Z]*$/, 'apenas números e letras maiúsculas')
    .refine((v) => v === '' || validateCpfCnpj(v), 'CPF/CNPJ inválido')
    .nullable()
    .default(null)
    .describe('CPF / CNPJ'),
  idEstrangeiro: z.string().max(20).nullable().default(null).describe('ID estrangeiro'),
  // Free text, and deliberately so — besides a real inscrição estadual it
  // carries the two sentinels in IE_SENTINELA above, which drive the NF-e
  // `dest.indIEDest`. Anything reading this field must go through
  // `normalizarIe` first; anything writing a sentinel must store the
  // IE_SENTINELA literal.
  ie: z.string().max(16).nullable().default(null).describe('Inscrição estadual'),
  imun: z
    .string()
    .max(15)
    .regex(/^\d*$/, 'apenas números')
    .nullable()
    .default(null)
    .describe('Inscrição municipal'),
  isUF: z
    .string()
    .min(8)
    .max(9)
    .regex(/^\d+$/, 'apenas números')
    .nullable()
    .default(null)
    .describe('IS UF'),
  email: z.string().max(255).email().nullable().default(null).describe('E-mail'),
  // Standardized wire format: digits-only E.164 without '+' (WhatsApp
  // wa_id compatible — see @delfrance/core/phone). Lenient bounds so
  // foreign phones (tipo Estrangeiro) and legacy Flutter-written raw
  // 10/11-digit BR numbers both stay valid; forms normalize on write.
  telefone: z
    .string()
    .max(16)
    .regex(/^\d*$/, 'apenas números')
    .refine((v) => v === '' || isValidTelefone(v), 'telefone inválido (10 a 15 dígitos, com DDD)')
    .nullable()
    .default(null)
    .describe('Telefone'),
  observacoesInternas: z
    .string()
    .max(255)
    .nullable()
    .default(null)
    .describe('Observações internas'),
  // Milliseconds since epoch (the numeric-epoch standard). The builder reads
  // tolerantly, so legacy ISO-string docs still render until the backfill.
  timestamp: millisSinceEpoch().nullable().default(null),
  // System field — creation stays in `timestamp`; this is stamped by
  // `saveRecord` on every write so the TableView update-monitor sees edits.
  // Labelled so it renders as "Última modificação" in the list (the builder
  // already carries the datetime/ms hint that formats the epoch as a date).
  ultimaModificacao: millisSinceEpoch('Última modificação').nullable().optional(),
  // Embeddings are server-managed; treat as opaque on the client.
  nome_embedding: z.unknown().nullable().default(null),
  telefone_embedding: z.unknown().nullable().default(null),
  // userCliente outer reference: stored as a Firestore document path string
  // (`users/<uid>`) on writes from this app. Phase 1 keeps it pass-through.
  userCliente: z.string().nullable().default(null),
});

export type Cliente = z.infer<typeof clienteSchema>;

/**
 * Form-validation variant of {@link clienteSchema} adding the tipo ↔ document
 * cross-field rule. Kept SEPARATE because Zod 4's `.pick()` throws at runtime
 * on a schema carrying refinements ("`.pick()` cannot be used on object
 * schemas containing refinements"). The registry / rules-gen use the plain
 * `clienteSchema`, the quick-create modal `.pick()`s it, and only the cliente
 * FORM (ObjectView) validates with this refined variant.
 */
export const clienteFormSchema = clienteSchema.superRefine(refineClienteTipoDocumento);

export const clienteMeta: CollectionMetadata = {
  collectionPath: 'clientes',
  permissions: {
    read: PERM_CLIENTE_READ,
    write: PERM_CLIENTE_WRITE,
    delete: PERM_CLIENTE_DELETE,
  },
  // ⚠️ DECLARED BUT DELIBERATELY NOT ENFORCED — no `onClienteDeleted` cascade
  // trigger, same call as `pedidoMeta` (owner, 2026-08). An endereço is NOT a
  // disposable child row: a pedido keeps `enderecoFiscalOuterRef` and the
  // address is read LIVE by ref, never snapshotted — by the NF-e orchestrator
  // (`apps/nfe/lib/nfe/orchestrator/bundle.ts`, which throws
  // `enderecoFiscalOuterRef missing` without it) and by the pedido printer
  // (`apps/web/lib/pedido-print/assemble.ts`). Cascading here would break NF-e
  // emission and reprinting for every historical pedido of that customer, so
  // enderecos are orphaned on purpose.
  cascade: [{ path: 'clientes/{clienteId}/enderecos', onDelete: 'cascade' }],
  // Surface the most-recently-modified clients first. The matching
  // `clientes → ultimaModificacao DESCENDING` index already exists in
  // firestore.indexes.json (it also serves the TableView update-monitor).
  defaultQuery: {
    orderBy: [{ field: 'ultimaModificacao', direction: 'desc' }],
    limit: 50,
  },
};

export const cliente = { schema: clienteSchema, meta: clienteMeta };
