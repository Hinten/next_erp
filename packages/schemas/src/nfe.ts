import { z } from 'zod';
import type { CollectionMetadata } from './types';
import { microsSinceEpoch, millisSinceEpoch } from './shared/datetime';

// Mirror `PERM.nfe` from @delfrance/auth.
const PERM_NFE_READ = 1n << 32n;
const PERM_NFE_WRITE = 1n << 33n;
const PERM_NFE_DELETE = 1n << 34n;

/**
 * EstadoNotaFiscalEletronica — string-coded estado da NF-e.
 * Wire values match Flutter's `EstadoNotaFiscalEletronica.value`.
 */
export const estadoNFeSchema = z.enum([
  '0', // gerado
  '1', // enviando
  '2', // aguardandoResposta
  '3', // processamentoCompleto
  '4', // processamentoCancelado
  'a', // aprovada
  'p', // epecAprovado
  'n', // rejeitada
  'c', // cancelada
  'i', // numeracaoInutilizada
  'e', // error
]);
export type EstadoNFe = z.infer<typeof estadoNFeSchema>;

export const ESTADO_NFE = {
  gerado: '0',
  enviando: '1',
  aguardandoResposta: '2',
  processamentoCompleto: '3',
  processamentoCancelado: '4',
  aprovada: 'a',
  epecAprovado: 'p',
  rejeitada: 'n',
  cancelada: 'c',
  numeracaoInutilizada: 'i',
  error: 'e',
} as const satisfies Record<string, EstadoNFe>;

export const ESTADO_NFE_LABELS: Record<EstadoNFe, string> = {
  '0': 'Gerado',
  '1': 'Enviando',
  '2': 'Aguardando resposta',
  '3': 'Processamento completo',
  '4': 'Processamento cancelado',
  a: 'Aprovada',
  p: 'EPEC aprovado',
  n: 'Rejeitada',
  c: 'Cancelada',
  i: 'Numeração inutilizada',
  e: 'Erro',
};

/**
 * NotaFiscalEletronica — documento fiscal eletrônico. Subcoleção de Pedido
 * (`pedidos/{pedidoId}/nfev4` — wire name original do Flutter). Read-only na
 * UI Next; emissão fica no `apps/integrations`/Cloud Functions (Phase 5).
 * Mirrors `NotaFiscalEletronica` em `.old/packages/pedido_nfe/lib/src/models.dart`.
 */
export const nfeSchema = z.object({
  numeracao: z.number().int(),
  serie: z.number().int(),
  tpEmis: z.number().int().default(1),
  estado: estadoNFeSchema.default('0'),

  /**
   * Denormalized owning-filial id (the parent pedido's filial). Lets a
   * `collectionGroup('nfev4')` range query be scoped to one filial — used by
   * the inutilização pre-check + reconciliation. `.optional()` only for
   * read-tolerance of legacy docs written before this field existed; the
   * orchestrator's writers always set a concrete string (never `undefined`),
   * so no Firebase `undefined`-write issue arises.
   */
  filialId: z.string().min(1).nullable().optional(),

  chave: z.string().min(1).nullable(),
  idLote: z.string().min(1).nullable(),
  infNFe: z.string().min(1).nullable(),
  xml_nfe_proc: z.string().min(1).nullable(),
  xml_epec_proc: z.string().min(1).nullable(),
  /**
   * Signed NF-e XML archived **before** the SOAP send (the anti-loss anchor).
   * The poller / recovery flow re-queries SEFAZ with this, never regenerates.
   * Set to `null` in the same write that persists `xml_nfe_proc` — the
   * nfeProc embeds the signed NFe, so keeping both would double the XML
   * payload (#128). EPEC docs (estado `'p'`) keep it until the pós-EPEC
   * transmission lands the proc.
   */
  xml_assinado: z.string().min(1).nullable(),
  /**
   * SEFAZ receipt number returned with `cStat=103` (lote async) and the
   * duplicidade codes (204/205/218/539). Used to poll `consReciNFe` and as
   * a hint when the chave is uncertain.
   */
  nRec: z.string().min(1).nullable(),
  /**
   * Bounded retry counter for the lote-pendente (cStat=105) poll loop.
   * The state machine resets this on every non-105 outcome. Also the
   * attempt counter the async reconciler caps at `MAX_RECONCILE_ATTEMPTS`.
   */
  retries: z.number().int().min(0).nullable(),
  /**
   * Earliest time the async reconciler may consult this lote again — the
   * consumo-indevido gate (avoids SEFAZ rejection 656). Seeded at emit time
   * to `now + tMed` (SEFAZ's estimate), then pushed out by the per-attempt
   * backoff (`nextConsultaDelayMs`). The Cloud Task is scheduled for this
   * instant; the backstop sweep skips docs whose `proximaConsultaEm` is in
   * the future. Cleared to `null` on any terminal outcome. Microseconds
   * since epoch (the project datetime standard — see `@delfrance/core/datetime`).
   */
  proximaConsultaEm: microsSinceEpoch().nullable().default(null),

  cStat: z.string().nullable(),
  xMotivo: z.string().nullable(),
  cMsg: z.string().nullable().optional(),
  xMsg: z.string().nullable().optional(),

  data_emissao: millisSinceEpoch().nullable().default(null),
  data_autorizacao: millisSinceEpoch().nullable().default(null),
  dataContingencia: millisSinceEpoch().nullable().default(null),
  justificativaContingencia: z.string().min(15).max(255).nullable(),

  error: z.string().nullable(),
  ultima_modificacao: millisSinceEpoch().nullable().default(null),
});

export type NotaFiscalEletronica = z.infer<typeof nfeSchema>;

export const nfeMeta: CollectionMetadata = {
  collectionPath: 'pedidos/{pedidoId}/nfev4',
  permissions: {
    read: PERM_NFE_READ,
    write: PERM_NFE_WRITE,
    delete: PERM_NFE_DELETE,
  },
};

export const nfe = { schema: nfeSchema, meta: nfeMeta };
