import { z } from 'zod';
import type { CollectionMetadata } from './types';

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

  chave: z.string().min(1).nullable(),
  idLote: z.string().min(1).nullable(),
  infNFe: z.string().min(1).nullable(),
  xml_nfe_proc: z.string().min(1).nullable(),
  xml_epec_proc: z.string().min(1).nullable(),

  cStat: z.string().nullable(),
  xMotivo: z.string().nullable(),
  cMsg: z.string().nullable().optional(),
  xMsg: z.string().nullable().optional(),

  data_emissao: z.string().datetime().nullable().optional(),
  data_autorizacao: z.string().datetime().nullable().optional(),
  dataContingencia: z.string().datetime().nullable().optional(),
  justificativaContingencia: z.string().min(15).max(255).nullable(),

  error: z.string().nullable(),
  ultima_modificacao: z.string().datetime().nullable().optional(),
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
