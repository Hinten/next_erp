import { z } from 'zod';
import { validateCNPJ } from '@delfrance/core/documents';
import { millisSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';
import { enderecoSchema } from './endereco';
import { certificadoFilialInfoSchema } from './certificadoFilial';

// Mirror `PERM.configuracoes` from @delfrance/auth.
const PERM_CONFIG_READ = 1n << 40n;
const PERM_CONFIG_WRITE = 1n << 41n;

/**
 * Filial — unidade fiscal (CNPJ) dentro de um grupo econômico. Mirrors
 * `Filial` em `.old/packages/grupo_economico/lib/src/models.dart`.
 * Reuses the shared `enderecoSchema` for `sede`.
 */
export const filialSchema = z.object({
  razaoSocial: z.string().min(1).max(1000).describe('Razão Social'),
  // `.nullable()` (no `.default`) keeps the field required-present — the
  // Firebase JS SDK rejects `undefined`, and forms supply `null` themselves.
  fantasia: z.string().max(1000).nullable().describe('Nome Fantasia'),
  cnae: z
    .string()
    .max(255)
    .nullable()
    .describe(
      '{"label":"CNAE","hint":"Classificação Nacional de Atividades Econômicas, informado pelo contador"}',
    ),
  // ⚠️ Letters only in the ALFA CNPJ SHAPE — the same narrow spelling as
  // `endereco.cpf_cnpj`, `bandeiraCartao.cnpj_instituicao` and
  // `integracao.cpf_cnpj`, never `cliente.ts`'s wider `^[0-9A-Z]*$` (that one
  // can afford it only because a `validateCpfCnpj` refine sits behind it).
  //
  // ⚠️ This regex IS the canonical-form guarantee for our own emitente, not
  // merely input validation. `[0-9A-Z]` excludes lowercase and punctuation on
  // READ as well as write, and two consumers compare this value byte-for-byte
  // against a CNPJ sliced straight out of a chave — which the XSD facet
  // guarantees is uppercase:
  //   · `apps/nfe/lib/nfe/orchestrator/inutilizar.ts` — `chave.slice(6, 20) ===
  //     filial.cnpj`, the OWNERSHIP check for legacy pre-`filialId` docs. A
  //     non-canonical row answers "not ours", the already-authorized pre-check
  //     passes, and we inutilizar a range containing an authorized NF-e.
  //   · `apps/nfe/lib/nfe/filial-cert.ts` — `where('cnpj', '==', …)` is exact,
  //     so a non-canonical row resolves no A1 certificate.
  // Neither failure names the case mismatch as its cause. Widening this to
  // accept lowercase would reopen both.
  //
  // The CHECKSUM lives on `filialFormSchema` instead, not here: this is also
  // the READ schema (root CLAUDE.md rule 8 — read-tolerance for stored shapes),
  // and `CnpjInput` used to truncate a pasted alfa CNPJ, so a short value may
  // already be stored. `.max(18)` stays: rules-gen emits maxLength and drops
  // regex patterns, so keeping it leaves both rulesets untouched.
  cnpj: z
    .string()
    .max(18)
    .regex(/^(\d*|[0-9A-Z]{12}\d{2})$/, 'apenas números, ou um CNPJ alfanumérico')
    .describe('CNPJ'),
  ie: z.string().regex(/^\d*$/, 'apenas números').describe('Inscrição Estadual'),
  iest: z
    .string()
    .regex(/^\d*$/, 'apenas números')
    .nullable()
    .describe(
      '{"label":"IEST","hint":"Inscrição Estadual do substituto tributário, quando houver"}',
    ),
  imun: z.string().regex(/^\d*$/, 'apenas números').nullable().describe('Inscrição Municipal'),
  sede: enderecoSchema.describe('Endereço sede'),
  // Public A1 cert metadata, managed by the cert upload endpoint (apps/nfe),
  // NOT by this form — it is excluded from the Dados ObjectView. `.optional()`
  // keeps legacy/never-uploaded docs parseable, and because edits write only
  // dirty fields (`saveRecord` → `tx.update(pickDirty(...))`), a Dados save
  // never wipes it. The secret key lives in the admin-only
  // `certificadoSecreto` subcollection; this is just the public badge data.
  certificado: certificadoFilialInfoSchema.nullable().optional().describe('Certificado Digital'),
  timestamp: millisSinceEpoch().nullable().optional(),
  // Update-monitor field — `saveRecord` stamps it on every write. Legacy
  // (Flutter-written) docs lack it; pipeline sorts treat the missing field
  // as null (sorted last on desc) instead of excluding the doc, which is
  // what FilialPicker's recency ordering relies on.
  // `.default(null)`, never a bare `.optional()`: the TableView update-
  // monitor runs a CLASSIC `orderBy(ultimaModificacao, 'desc').limit(1)`,
  // which EXCLUDES documents missing the key — so a dropped key hides the
  // row from the staleness check, silently. Pinned by
  // `defaultQuery.sortKeyPresence.test.ts`.
  ultimaModificacao: millisSinceEpoch().nullable().default(null),
});

export type Filial = z.infer<typeof filialSchema>;

/**
 * Cross-field rule: our own emitente CNPJ must be present and checksum-valid.
 *
 * ⚠️ Deliberately NOT on `filialSchema` itself, exactly as
 * `refineClienteTipoDocumento` is kept off `clienteSchema`. `filialSchema` is
 * also the READ schema, and the filial `CnpjInput` used to `replace(/\D/g,'')`
 * a pasted alphanumeric CNPJ — which `max(18)` with no minimum and no checksum
 * saved cleanly — so a truncated value may already be stored. A refine on the
 * base schema would make `parseRead` throw on that row, including inside the
 * A1-certificate resolution path. Read-tolerance for stored shapes is root
 * CLAUDE.md rule 8; the form simply refuses to save it again.
 *
 * ⚠️ The empty-string case is load-bearing, not defensive: `cnpj` is a required
 * string whose `^(\d*|…)$` regex accepts `''`, so today a filial saves with no
 * CNPJ at all and the only complaint arrives from
 * `packages/integrations/nfe/src/generator/index.ts` at EMISSION time.
 */
export function refineFilialCnpj(data: { cnpj?: string | null }, ctx: z.RefinementCtx): void {
  const cnpj = data.cnpj;
  if (cnpj === undefined || cnpj === null) return;
  if (cnpj === '') {
    ctx.addIssue({
      code: 'custom',
      path: ['cnpj'],
      message: 'Informe o CNPJ da filial.',
    });
    return;
  }
  if (!validateCNPJ(cnpj)) {
    ctx.addIssue({
      code: 'custom',
      path: ['cnpj'],
      message: 'CNPJ inválido (14 caracteres; pode conter letras maiúsculas).',
    });
  }
}

/**
 * Filial schema **for the ObjectView form only** — `filialSchema` plus the
 * checksum refine above. The registry / rules-gen use the plain `filialSchema`
 * (a `ZodEffects` has no `.shape`), and only the filial FORM validates with
 * this variant. Mirrors `clienteFormSchema` / `clienteSchema`.
 */
export const filialFormSchema = filialSchema.superRefine(refineFilialCnpj);

export const filialMeta: CollectionMetadata = {
  collectionPath: 'filiais',
  permissions: {
    read: PERM_CONFIG_READ,
    write: PERM_CONFIG_WRITE,
    delete: PERM_CONFIG_WRITE,
  },
  defaultQuery: {
    orderBy: [{ field: 'razaoSocial', direction: 'asc' }],
    limit: 50,
    columns: ['razaoSocial', 'fantasia', 'cnpj', 'timestamp'],
  },
  // FilialPicker (CollectionSelect) orders its option list by RECENCY_SORT
  // (`ultimaModificacao desc, timestamp desc`) — see the composite index in
  // firestore.indexes.json, asserted by the defaultQuery.indexes meta-test.
  pickerRecencySort: true,
};

export const filial = { schema: filialSchema, meta: filialMeta };
