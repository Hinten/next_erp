import { z } from 'zod';
import type { CollectionMetadata } from './types';
import { millisSinceEpoch } from './datetime';
import { estadoEnviNFeMsgSchema } from './enviNfeMsg';

// Mirror `PERM.fiscal` (byte 9, bits 72-74) from @delfrance/auth — same audit
// surface as `EnviNFeMsg` (`.old/packages/nfe_client/lib/src/models.dart`
// `InutNumeracao` declared `permCode: 'inu'`, read by the fiscal role).
const PERM_FISCAL_READ = 1n << 72n;
const PERM_FISCAL_WRITE = 1n << 73n;
const PERM_FISCAL_DELETE = 1n << 74n;

const XJUST_MIN = 15;
const XJUST_MAX = 255;

/**
 * `InutNumeracao` — one persisted inutilização de numeração round-trip
 * (`NfeInutilizacao4`). Subcollection of Filial so each company's burned
 * ranges + their SEFAZ communications stay isolated and auditable.
 * **Append-only**: every inutilização attempt writes a new doc (homologada or
 * rejeitada), never mutated afterwards — the operator can always retrieve old
 * inutilizações (audit, recovery, debugging), mirroring the old Flutter
 * `InutNFeTable` list at `filiais/{filialId}/inutilizacao`.
 *
 * `estado` reuses `EstadoEnviNFeMsg` (Flutter parity): `concluido` ('3') when
 * SEFAZ homologou (cStat 102), `error` ('e') otherwise. `cStat` / `xMotivo` /
 * `nProt` are extracted up-front for cheap list rendering (the old model parsed
 * them from `xml_retorno` on demand; we store them flat).
 *
 * Field-name note: keep our wire names `nNFIni` / `nNFFin` (not the old
 * `inicio` / `fim`) — this is a fresh TS-only collection, no Flutter reader to
 * satisfy during the migration window.
 */
export const inutNumeracaoSchema = z.object({
  /** NF-e série the range belongs to. */
  serie: z.number().int().min(0),
  /** First número burned (inclusive). */
  nNFIni: z.number().int().min(1),
  /** Last número burned (inclusive). */
  nNFFin: z.number().int().min(1),
  /** Justificativa — SEFAZ requires 15–255 chars. */
  xJust: z.string().min(XJUST_MIN).max(XJUST_MAX),

  /** Signed `<inutNFe>` sent to SEFAZ. */
  xml_enviado: z.string().min(1).nullable(),
  /** Raw `retInutNFe` reply from SEFAZ. */
  xml_retorno: z.string().min(1).nullable(),
  /** SEFAZ `infInut.cStat` — '102' = homologada. */
  cStat: z.string().nullable(),
  /** Human-readable motivo. */
  xMotivo: z.string().nullable(),
  /** Protocolo returned on cStat=102. */
  nProt: z.string().min(1).nullable(),
  /** Transport/error message when the round-trip failed before a SEFAZ reply. */
  error: z.string().nullable(),

  estado: estadoEnviNFeMsgSchema.default('0'),
  timestamp: millisSinceEpoch().nullable().default(null),
  ultima_modificacao: millisSinceEpoch().nullable().default(null),
});

export type InutNumeracao = z.infer<typeof inutNumeracaoSchema>;

export const inutNumeracaoMeta: CollectionMetadata = {
  collectionPath: 'filiais/{filialId}/inutilizacao',
  permissions: {
    read: PERM_FISCAL_READ,
    write: PERM_FISCAL_WRITE,
    delete: PERM_FISCAL_DELETE,
  },
};

export const inutNumeracao = { schema: inutNumeracaoSchema, meta: inutNumeracaoMeta };
