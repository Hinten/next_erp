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
 * SEFAZ-final estados — another consulta can never legitimately change them.
 * Consultation flows (`consultarPedido`, the manual "Verificar novamente"
 * action) must short-circuit on these WITHOUT calling SEFAZ: `consSitNFe` for
 * a cancelada NF-e still returns the ORIGINAL authorization protNFe (cStat
 * 100), which would regress the doc to `aprovada`. `rejeitada`/`error` are
 * deliberately absent — re-verifying a possibly-stale local failure is the
 * whole point of the manual consulta.
 */
export const ESTADOS_FINAIS_NFE: ReadonlySet<EstadoNFe> = new Set<EstadoNFe>([
  ESTADO_NFE.aprovada,
  ESTADO_NFE.cancelada,
  ESTADO_NFE.numeracaoInutilizada,
]);

/** `true` when the estado is SEFAZ-final (see {@link ESTADOS_FINAIS_NFE}). */
export function isEstadoFinalNFe(estado: EstadoNFe | null | undefined): boolean {
  return estado != null && ESTADOS_FINAIS_NFE.has(estado);
}

/**
 * Estado do envio da NF-e ao Mercado Livre (Step 12, issue #739) — lifecycle
 * of the `mlEnvio` upload marker on the NF-e doc.
 * `pendente` = task enqueued, upload in flight; `enviado` = ML accepted the
 * nfeProc XML; `erro` = attempts exhausted or a deterministic rejection;
 * `descartado` = upload not applicable (e.g. shipment already resolved).
 */
export const mlEnvioEstadoSchema = z.enum(['pendente', 'enviado', 'erro', 'descartado']);
export type MlEnvioEstado = z.infer<typeof mlEnvioEstadoSchema>;

export const ML_ENVIO_ESTADO = {
  pendente: 'pendente',
  enviado: 'enviado',
  erro: 'erro',
  descartado: 'descartado',
} as const satisfies Record<string, MlEnvioEstado>;

/**
 * Marker block for the Mercado Livre invoice upload (Step 12, issue #739):
 * one attempt-tracking record per NF-e doc, written only by the ML upload
 * task. `shipmentId` is the ML shipment the XML was (or will be) posted to;
 * `motivo` explains a `descartado`; `ultimoErro`/`ultimoErroCodigo` capture
 * the last failure for triage. `atualizadoEm` is MILLIS since epoch (matches
 * the doc's other `data_*`/`ultima_modificacao` fields, not the micros
 * standard used by `proximaConsultaEm`).
 */
export const mlEnvioSchema = z.object({
  estado: mlEnvioEstadoSchema,
  tentativas: z.number().int().min(0).default(0),
  shipmentId: z.string().min(1).nullable().default(null),
  motivo: z.string().nullable().default(null),
  ultimoErro: z.string().nullable().default(null),
  ultimoErroCodigo: z.string().nullable().default(null),
  atualizadoEm: millisSinceEpoch().nullable().default(null),
});
export type MlEnvio = z.infer<typeof mlEnvioSchema>;

/**
 * NF-e chave de acesso: exactly 44 digits. Shared source for every place
 * that validates a chave string (pedido `chNFeReferenciadas`, UI inputs).
 * Keep byte-identical to the pattern historically inlined at those call
 * sites (`/^\d{44}$/`) — see the anchor test in `nfe.test.ts`.
 */
export const CHAVE_NFE_REGEX = /^\d{44}$/;

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
  estado: estadoNFeSchema.default(ESTADO_NFE.gerado),

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

  /**
   * Mercado Livre invoice-upload marker (Step 12, issue #739): tracks the
   * POST of this NF-e's signed nfeProc XML to
   * `/shipments/{shipmentId}/invoice_data` so the ML shipment leaves
   * `invoice_pending`. `.optional()` exists ONLY for read-tolerance of docs
   * written before Step 12 (same rationale as `filialId` above); writers
   * always set the full block or `null`, never `undefined`.
   * Dual-run caveat: the legacy Flutter model ignores unknown keys on read
   * but DROPS them on a full-doc save — an erased marker just re-arms the
   * upload trigger, which is safe because the task re-gates everything
   * (estado, XML presence, tpAmb, shipment status) before sending.
   */
  mlEnvio: mlEnvioSchema.nullable().optional(),
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
