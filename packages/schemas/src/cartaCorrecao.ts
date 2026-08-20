import { z } from 'zod';
import type { CollectionMetadata } from './types';
import { microsSinceEpoch, millisSinceEpoch } from './shared/datetime';
import { estadoEnviNFeMsgSchema } from './enviNfeMsg';
import { ESTADO_ENVI_NFE_MSG } from './enviNfeMsg';

// Mirror `PERM.fiscal` (byte 9, bits 72-74) from @delfrance/auth — same audit
// surface as `EnviNFeMsg` / `InutNumeracao`. The old Flutter `CartaDeCorrecao`
// was declared `permCode: 'cco'`, read by the fiscal role.
const PERM_FISCAL_READ = 1n << 72n;
const PERM_FISCAL_WRITE = 1n << 73n;
const PERM_FISCAL_DELETE = 1n << 74n;

// SEFAZ limits for the CC-e correction text (`xCorrecao`), from the e110110
// detEvento XSD (`minLength 15` / `maxLength 1000`).
const XCORRECAO_MIN = 15;
const XCORRECAO_MAX = 1000;

/**
 * `CartaDeCorrecao` — one persisted Carta de Correção Eletrônica round-trip
 * (CC-e, `RecepcaoEvento` `tpEvento=110110`). Subcollection of the NF-e
 * (`pedidos/{pedidoId}/nfev4/{nfeId}/cartacorrecao`) so a single NF-e can carry
 * **many** corrections, each with its own `nSeqEvento`. **Append-only**: every
 * CC-e attempt writes a new doc (registrada or rejeitada), never mutated
 * afterwards — the operator can always retrieve old corrections (audit,
 * reprint), mirroring the old Flutter `CartaDeCorrecao` model
 * (`.old/packages/pedido_nfe/lib/src/models.dart:406`) and its
 * `CartaCorrecaoTableView` list.
 *
 * `estado` reuses `EstadoEnviNFeMsg` (Flutter parity): `concluido` ('3') when
 * SEFAZ registrou e vinculou (cStat 135), `error` ('e') otherwise. `cStat` /
 * `xMotivo` / `nProt` are extracted up-front for cheap list rendering.
 *
 * Field-name note: we keep the SEFAZ wire name `xCorrecao` (not the old Flutter
 * `justificativa`) — this collection has no legacy corpus behind it, so
 * unlike the ported models it carries no stored wire shape to
 * satisfy during the migration window.
 */
export const cartaCorrecaoSchema = z.object({
  /** Correction text sent as `<xCorrecao>` — SEFAZ requires 15–1000 chars. */
  xCorrecao: z.string().min(XCORRECAO_MIN).max(XCORRECAO_MAX),
  /** Event sequence number (1, 2, 3, …). Increments per accepted CC-e. */
  nSeqEvento: z.number().int().min(1),

  /** Signed `<evento>` sent to SEFAZ. */
  xml_enviado: z.string().min(1).nullable(),
  /** Raw `retEnvEvento` reply from SEFAZ. */
  xml_retorno: z.string().min(1).nullable(),
  /** SEFAZ `retEvento.infEvento.cStat` — '135' = registrado e vinculado. */
  cStat: z.string().nullable(),
  /** Human-readable motivo. */
  xMotivo: z.string().nullable(),
  /** Event protocolo returned on cStat=135. */
  nProt: z.string().min(1).nullable(),
  /** Transport/error message when the round-trip failed before a SEFAZ reply. */
  error: z.string().nullable(),
  /** SEFAZ `tpEmis` for the event. */
  tpEmis: z.number().int().nullable(),

  /**
   * Async re-check gate (µs since epoch) — earliest a cStat-136 CC-e
   * (`estado='v'` aguardandoVinculo) may be re-sent. `null` on terminal records
   * (concluido / error). Mirrors `nfeSchema.proximaConsultaEm`. #81.
   */
  proximaConsultaEm: microsSinceEpoch().nullable().default(null),
  /** Re-send attempts for a pending CC-e; `null` on terminal records. #81. */
  retries: z.number().int().nullable().default(null),

  estado: estadoEnviNFeMsgSchema.default(ESTADO_ENVI_NFE_MSG.iniciado),
  timestamp: millisSinceEpoch().nullable().default(null),
  ultima_modificacao: millisSinceEpoch().nullable().default(null),
});

export type CartaCorrecao = z.infer<typeof cartaCorrecaoSchema>;

export const cartaCorrecaoMeta: CollectionMetadata = {
  collectionPath: 'pedidos/{pedidoId}/nfev4/{nfeId}/cartacorrecao',
  permissions: {
    read: PERM_FISCAL_READ,
    write: PERM_FISCAL_WRITE,
    delete: PERM_FISCAL_DELETE,
  },
};

export const cartaCorrecao = { schema: cartaCorrecaoSchema, meta: cartaCorrecaoMeta };
