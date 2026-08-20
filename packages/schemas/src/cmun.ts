import { z } from 'zod';
import { ufSchema } from './endereco';
import { millisSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';

// Permission bits live in @delfrance/auth. Duplicating literal values here
// would create a circular dep; mirror the bit positions instead.
const PERM_CMUN_READ = 1n << 104n;
const PERM_CMUN_WRITE = 1n << 105n;
const PERM_CMUN_DELETE = 1n << 106n;

/**
 * Where a row came from. Rows imported from the legacy CSV-derived tabelão are
 * `tabelao`; rows the resolver learned from ViaCEP and wrote back are `viacep`.
 * Kept so a future refresh can tell "authoritative faixa" from "single CEP we
 * discovered ourselves" and consolidate the latter.
 */
export const origemCmunSchema = z.enum(['tabelao', 'viacep']);
export type OrigemCmun = z.infer<typeof origemCmunSchema>;

/** Named members of {@link origemCmunSchema} — see `delfrance/prefer-schema-enum`. */
export const ORIGEM_CMUN = {
  tabelao: 'tabelao',
  viacep: 'viacep',
} as const satisfies Record<string, OrigemCmun>;

/**
 * `TabelaoCmun` — CEP faixa → IBGE município code (`cMun`).
 *
 * Ports the legacy Flutter model at
 * `.old/packages/clientes/lib/src/models.dart:1112-1158`, keeping the legacy
 * field names and the literal UPPERCASE collection id (see `cmunMeta`).
 *
 * **This table is a cache that heals itself, not a static snapshot.** NF-e
 * emission resolves `cMun` from here; a CEP the table does not cover is
 * resolved through ViaCEP *once* and then written back as a new row, so the
 * next emission is a local lookup. That write-back is why this is a Firestore
 * collection and not a committed data file — a file cannot grow, and ViaCEP
 * rate-limits (HTTP 429) far too aggressively to be on the routine path.
 *
 * ⚠️ `cepInicial` / `cepFinal` are **integers**, not zero-padded strings — the
 * legacy CSV import ran `int.parse`, so `01310100` is stored as `1310100`.
 * Compare against `Number(cep)`, never against the 8-digit string.
 */
export const cmunSchema = z.object({
  cepInicial: z.number().int().describe('CEP inicial da faixa'),
  cepFinal: z.number().int().describe('CEP final da faixa'),
  cMun: z
    .string()
    .regex(/^\d{7}$/, 'código IBGE deve ter 7 dígitos')
    .describe('Código do Município (IBGE)'),
  nomeMunicipio: z.string().min(1).max(150).describe('Município'),
  estado: ufSchema.describe('Estado (UF)'),
  origem: origemCmunSchema.nullable().default(null).describe('Origem do registro'),
  timestamp: millisSinceEpoch().nullable().default(null),
  ultimaModificacao: millisSinceEpoch('Última modificação').nullable().optional(),
});

export type Cmun = z.infer<typeof cmunSchema>;

export const cmunMeta: CollectionMetadata = {
  // Literally uppercase `CMUN` — the legacy Flutter wire name
  // (`.old/packages/clientes/lib/src/models.dart:20`), and the only uppercase
  // collection path in this repo. Deliberate: production already holds this
  // data under that exact id, and the migrated corpus arrives under it, so the
  // legacy name is kept rather than modernised — the same reasoning as
  // `integracao/{id}/tokenDuravel`. It also
  // means production needs no import; only staging does.
  collectionPath: 'CMUN',
  permissions: {
    read: PERM_CMUN_READ,
    write: PERM_CMUN_WRITE,
    delete: PERM_CMUN_DELETE,
  },
  // Admin SDK only. The sole writer is the NF-e resolver's ViaCEP write-back;
  // no client may create or edit a faixa. Reads stay open to `PERM.cmun.read`
  // so the Flutter app's own `Endereco.cMun` query keeps working — dropping
  // that would deny the collection outright the moment the ruleset deploys.
  serverOwned: true,
};

export const cmun = { schema: cmunSchema, meta: cmunMeta };

/**
 * Firestore document id for a faixa: the zero-padded 8-digit `cepInicial`.
 *
 * Deterministic on purpose. The legacy seeder used auto-ids, so re-running it
 * duplicated every row; this makes both the import and the ViaCEP write-back
 * idempotent, and lets two concurrent emissions of the same CEP converge on one
 * document (`create` → ALREADY_EXISTS → fine).
 */
export function cmunDocId(cepInicial: number): string {
  return String(cepInicial).padStart(8, '0');
}
