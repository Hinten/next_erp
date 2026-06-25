import { z } from 'zod';
import { millisSinceEpoch } from './datetime';
import { idRefSchema } from './outerRef';
import type { CollectionMetadata } from './types';

const PERM_IMPOSTO_PRODUTO_READ = 1n << 75n;
const PERM_IMPOSTO_PRODUTO_WRITE = 1n << 76n;
const PERM_IMPOSTO_PRODUTO_DELETE = 1n << 77n;

/**
 * Origem da mercadoria (ICMS) — single-digit codes 0–8 (Flutter
 * `OrigemProdutoImposto`). Exposed for the Dados Gerais select.
 */
export const ORIGEM_PRODUTO_LABELS: Record<string, string> = {
  '0': '0 - Nacional',
  '1': '1 - Estrangeira - Importação direta',
  '2': '2 - Estrangeira - Adquirida no mercado interno',
  '3': '3 - Nacional, conteúdo de importação 40%–70%',
  '4': '4 - Nacional, processos produtivos básicos',
  '5': '5 - Nacional, conteúdo de importação ≤ 40%',
  '6': '6 - Estrangeira - Importação direta, sem similar nacional',
  '7': '7 - Estrangeira - Adquirida no mercado interno, sem similar nacional',
  '8': '8 - Nacional, conteúdo de importação > 70%',
};

/**
 * ImpostoProduto — subcoleção `produtos/{produtoId}/imposto/{operacaoId}`.
 * Per-produto Imposto override, looked up by the orchestrator's
 * `resolveItemImposto` cascade when a pedido item lacks pre-stamped `imposto`.
 * Doc id is the operação id (Flutter `copyWithParent(docIdString: operacaoId)`),
 * so re-saving an operação's imposto is idempotent.
 *
 * Wire shape mirrors the Flutter `Imposto` generated JSON
 * (`packages/produtos/lib/src/models.g.dart:_$ImpostoToJson`):
 *   - `impostoOpercaoOuterRef` — the scope pointer, Flutter's **typo** key
 *     preserved verbatim for coexistence: `null` = default fallback (any
 *     operação), else `operacao/<id>` (`pathNoDocuments`).
 *   - the **Dados Gerais** scalars (`origem`, `cfop`, `cfopInterestadual`,
 *     `NCM`, `NVE`, `CEST`, `indEscala`, `CNPJFab`, `cBenef`, `extipi`,
 *     `unidade`, `compoeValorTotalDaNFe`) are typed but lenient — length/format
 *     rules (NCM = 8, CEST = 7) live in `produtoPageIssues` so a slightly-off
 *     legacy doc still READS; the form enforces them on write.
 *   - `timestamp` is a ms-epoch int (`dateTimeToJson`).
 *
 * The deep tribute configs (`configuracaoICMS`, `configuracaoIPI`,
 * `configuracaoPIS`, `configuracaoPISST`) stay **pass-through** — owned and
 * validated by integrations-nfe's tribute engine (NF-e Regime Normal), keeping
 * packages/schemas free of a circular dep.
 */
export const impostoProdutoSchema = z
  .object({
    id: z.string().nullable().default(null),
    impostoOpercaoOuterRef: idRefSchema.nullable().default(null),
    origem: z.string().nullable().default(null),
    cfop: z.string().nullable().default(null),
    cfopInterestadual: z.string().nullable().default(null),
    NCM: z.string().nullable().default(null),
    NVE: z.string().nullable().default(null),
    CEST: z.string().nullable().default(null),
    indEscala: z.string().nullable().default(null),
    CNPJFab: z.string().nullable().default(null),
    cBenef: z.string().nullable().default(null),
    extipi: z.string().nullable().default(null),
    unidade: z.string().nullable().default(null),
    compoeValorTotalDaNFe: z.boolean().nullable().default(null),
    timestamp: millisSinceEpoch().nullable().default(null),
  })
  .passthrough();

export type ImpostoProduto = z.infer<typeof impostoProdutoSchema>;

/** Operação id from an `operacao/<id>` (or `documents/operacao/<id>`) scope ref. */
export function operacaoIdFromImpostoRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  return ref.split('/').filter(Boolean).pop() ?? null;
}

export const impostoProdutoMeta: CollectionMetadata = {
  collectionPath: 'produtos/{produtoId}/imposto',
  permissions: {
    read: PERM_IMPOSTO_PRODUTO_READ,
    write: PERM_IMPOSTO_PRODUTO_WRITE,
    delete: PERM_IMPOSTO_PRODUTO_DELETE,
  },
};

export const impostoProduto = {
  schema: impostoProdutoSchema,
  meta: impostoProdutoMeta,
};
