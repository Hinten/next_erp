import { z } from 'zod';
import type { CollectionMetadata } from './types';
import { millisSinceEpoch } from './shared/datetime';
import { estadoEnviNFeMsgSchema, ESTADO_ENVI_NFE_MSG } from './enviNfeMsg';
import type { UF } from './endereco';

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
 * `inicio` / `fim`) — nothing is migrated into this collection, so there is no
 * legacy corpus behind it and no wire-compat constraint to satisfy.
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

  estado: estadoEnviNFeMsgSchema.default(ESTADO_ENVI_NFE_MSG.iniciado),
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

/**
 * First instant (epoch ms) from which a UF's emitters may no longer file a
 * Pedido de Inutilização: 00:00 of 01/11/2026 in that UF's legal time (Acre
 * −05:00, Bahia and São Paulo −03:00 — permanent since Lei 13.985/2019 ended
 * DST). A UF absent from this table keeps the pedido.
 *
 * Ajuste SINIEF nº 40/2026 (CONFAZ, DOU 14/09/2026), cláusula segunda II, adds
 * § 6º to cláusula décima quarta of Ajuste SINIEF 7/05: "O Pedido de
 * Inutilização de Número da NF-e previsto no 'caput' não se aplica aos Estados
 * do Acre, Bahia e São Paulo." Cláusula terceira: effects "a partir do primeiro
 * dia do segundo mês subsequente ao da publicação" — 01/11/2026. Source:
 * confaz.fazenda.gov.br/legislacao/ajustes/2026/AJ040_26. SEFAZ-SP homologação
 * already answers every pedido with cStat 998 "Serviço Desativado" (#2030).
 */
const INUTILIZACAO_ENCERRADA_EM: Partial<Record<UF, number>> = {
  AC: Date.UTC(2026, 10, 1, 5),
  BA: Date.UTC(2026, 10, 1, 3),
  SP: Date.UTC(2026, 10, 1, 3),
};

const NOME_DA_UF: Partial<Record<UF, string>> = {
  AC: 'do Acre',
  BA: 'da Bahia',
  SP: 'de São Paulo',
};

/**
 * `true` when an emitter in `uf` may file a Pedido de Inutilização de Número
 * da NF-e at `instanteMs` — `false` for AC, BA and SP from 01/11/2026 (see
 * {@link INUTILIZACAO_ENCERRADA_EM}). Pure: the caller passes the clock.
 *
 * The one rule both surfaces read: `apps/nfe` refuses the request before any
 * SEFAZ call, and `apps/web` disables the inutilização form.
 */
export function inutilizacaoSeAplica(uf: UF, instanteMs: number): boolean {
  const encerradaEm = INUTILIZACAO_ENCERRADA_EM[uf];
  return encerradaEm === undefined || instanteMs < encerradaEm;
}

/**
 * The pt-BR explanation shown when {@link inutilizacaoSeAplica} is `false` —
 * the same sentence on the route's refusal and on the disabled form. A gap is
 * left as it is: the Ajuste sets no replacement procedure, and the numeração
 * stays sequential.
 */
export function motivoInutilizacaoNaoSeAplica(uf: UF): string {
  const nome = NOME_DA_UF[uf] ?? `de ${uf}`;
  return (
    `A inutilização de numeração não se aplica às filiais ${nome} desde 01/11/2026 ` +
    `(Ajuste SINIEF nº 40/2026). Um número que nunca foi autorizado simplesmente ` +
    `fica sem uso — não há pedido a enviar à SEFAZ.`
  );
}
