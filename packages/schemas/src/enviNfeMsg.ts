import { z } from 'zod';
import type { CollectionMetadata } from './types';

// Mirror `PERM.fiscal` (byte 9, bits 72-74) from @delfrance/auth, matching
// the Flutter `EasyFirebase` declaration `perm: 'nf1'` on `EnviNFeMsg`
// (`.old/packages/nfe_client/lib/src/models.dart:210`).
const PERM_FISCAL_READ = 1n << 72n;
const PERM_FISCAL_WRITE = 1n << 73n;
const PERM_FISCAL_DELETE = 1n << 74n;

/**
 * `EstadoEnviNFeMsg` — string-coded state of one SEFAZ envio message.
 * Mirrors `EstadoEnviNFeMsg` enum at
 * `.old/packages/nfe_client/lib/src/models.dart:151`. Wire values
 * match Flutter so a TS-written doc reads correctly in the Flutter UI
 * during the migration window.
 *
 * Phase A only writes a small subset (`respondido`, `concluido`,
 * `error`); the rest are accepted on the wire (Zod) for forward
 * compat with future EPEC / contingência paths.
 */
export const estadoEnviNFeMsgSchema = z.enum([
  'e', // error
  '0', // iniciado
  '1', // aguardando_envio
  'a', // aguardando_envio_pos_epec_apenas_periodico
  'c', // aguardando_epec
  'n', // aguardando_envio_pos_epec
  '2', // respondido
  '4', // respondido_apenas_periodico
  't', // respondido_apenas_tasks
  '3', // concluido
  'i', // semMaisAcoes
  'v', // aguardando_vinculo — CC-e registered but not yet linked (cStat 136), #81
]);
export type EstadoEnviNFeMsg = z.infer<typeof estadoEnviNFeMsgSchema>;

/**
 * Ergonomic alias map exposing only the Phase A states. Other Flutter
 * states stay accepted on the wire (see `estadoEnviNFeMsgSchema`) but
 * aren't surfaced here until contingência paths are wired.
 */
export const ESTADO_ENVI_NFE_MSG = {
  error: 'e',
  iniciado: '0',
  aguardandoEnvio: '1',
  respondido: '2',
  concluido: '3',
  /** CC-e registered at SEFAZ but not yet linked to the NF-e (cStat 136) — a
   *  non-terminal pending state that an async re-send resolves to concluido (#81). */
  aguardandoVinculo: 'v',
} as const satisfies Record<string, EstadoEnviNFeMsg>;

/**
 * `EnviNFeMsg` — one persisted SEFAZ round-trip (lote send,
 * `consReciNFe`, `consSitNFe`). Subcollection of Filial so each
 * company's audit log is isolated. **Append-only**: every SOAP call
 * writes a new doc; nothing is mutated after creation, so we can
 * always retrieve old communications (operator audit, recovery,
 * debugging).
 *
 * Mirrors `EnviNFeMsg` at
 * `.old/packages/nfe_client/lib/src/models.dart:215`. Phase A fields
 * only — EPEC / contingência metadata
 * (`dataContingencia` / `justificativaContingencia` / `previsaoResposta`)
 * comes later when those flows are wired.
 */
export const enviNfeMsgSchema = z.object({
  /** Chaves this msg covers. Phase A always single-element; batch is N. */
  targetsChnfe: z.array(z.string().length(44)).default([]),
  /** SEFAZ lote id. Set on autorizarLote messages; null on cons*. */
  idLote: z.number().int().nullable(),
  /** '0' async / '1' sync. Set on autorizarLote messages. */
  indSinc: z.enum(['0', '1']).nullable(),
  /** Request body sent to SEFAZ (signed NFe XML for autorizarLote; null for cons*). */
  xml_enviado: z.string().min(1).nullable(),
  /** Response body from SEFAZ — JSON-stringified parsed object for Phase A. */
  xml_retorno: z.string().min(1).nullable(),
  /** Lote receipt number. Carried forward across consult messages. */
  nRec: z.string().min(1).nullable(),
  /** Last cStat SEFAZ reported on this msg. */
  cStat: z.string().nullable(),
  /** Human-readable motivo. */
  xMotivo: z.string().nullable(),
  /** Error message (if SOAP transport failed). */
  error: z.string().nullable(),
  /** Mirrors `EnviNFeMsg.codEmissao` — SEFAZ `tpEmis` for this msg. */
  tpEmis: z.number().int().nullable(),
  estado: estadoEnviNFeMsgSchema.default('2'),
  timestamp: z.string().datetime().nullable().optional(),
  ultima_modificacao: z.string().datetime().nullable().optional(),
});

export type EnviNFeMsg = z.infer<typeof enviNfeMsgSchema>;

export const enviNfeMsgMeta: CollectionMetadata = {
  collectionPath: 'filiais/{filialId}/enviNfe',
  permissions: {
    read: PERM_FISCAL_READ,
    write: PERM_FISCAL_WRITE,
    delete: PERM_FISCAL_DELETE,
  },
};

export const enviNfeMsg = { schema: enviNfeMsgSchema, meta: enviNfeMsgMeta };
