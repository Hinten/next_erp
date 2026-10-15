/**
 * NT 2025.002 `ide` / `emit` fields beyond the tax groups (#331): the delivery
 * forecast (`ide/dPrevEntrega`, B10a) and the SUFRAMA municipalities an
 * emitente's `emit/ISUFEmit` (C22) is valid from. Pure and total; the rules
 * that refuse a nota are in `regrasDoDocumento.ts`.
 */
import { FIN_NFE_OPERACAO } from '../operacao';
import { MODALIDADE_FRETE, type ModalidadeFrete } from '../shared/frete';

/**
 * C22-10 (cStat 1185) — the municipalities whose emitente may inform
 * `ISUFEmit`: the Zona Franca de Manaus and the Áreas de Livre Comércio, as
 * NT 2025.002 v1.51 lists them (IBGE codes).
 */
export const MUNICIPIOS_SUFRAMA_EMITENTE: ReadonlySet<string> = new Set([
  '1302603', // Manaus (ZFM)
  '1303569', // Rio Preto da Eva (ZFM)
  '1301902', // Itacoatiara (ZFM)
  '1304062', // Tabatinga (AM, ALC)
  '1600303', // Macapá (AP, ALC)
  '1600600', // Santana (AP, ALC)
  '1100106', // Guajará-Mirim (RO, ALC)
  '1400100', // Boa Vista (RR, ALC)
  '1400159', // Bonfim (RR, ALC)
  '1200104', // Brasiléia (AC, ALC)
  '1200252', // Epitaciolândia (AC, ALC)
  '1200203', // Cruzeiro do Sul (AC, ALC)
]);

/** `emit/ISUFEmit` (C22): 8 or 9 digits. */
export const ISUF_EMIT_REGEX = /^\d{8,9}$/;

const DATA_AAAA_MM_DD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `AAAA-MM-DD` plus `meses` calendar months, the day clamped to the month's end. */
export function somarMeses(data: string, meses: number): string | null {
  const m = DATA_AAAA_MM_DD.exec(data);
  if (m == null) return null;
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + meses;
  const ano = Math.floor(total / 12);
  const mes = (total % 12) + 1;
  const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  const dia = Math.min(Number(m[3]), ultimoDia);
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/** B10a-50: the freight modes that forbid a delivery forecast. */
const MODFRETE_SEM_PREVISAO: ReadonlySet<ModalidadeFrete> = new Set([
  MODALIDADE_FRETE.fob,
  MODALIDADE_FRETE.proprioDestinatario,
  MODALIDADE_FRETE.semTransporte,
]);

/**
 * `ide/dPrevEntrega` for this nota, or `null` when the nota must not carry it.
 *
 * The forecast is information the ERP already has (the pedido's
 * `freteInicial.dataPrevisaoEntrega`), not something the operator types for
 * the nota — so a value SEFAZ would refuse is OMITTED, never a reason to refuse
 * the nota. The windows are B10a-20…50: finalidade 1 or 4 only; not with
 * freight FOB / próprio do destinatário / sem transporte; never before the
 * emission date (the nota emits no `dhSaiEnt`, so `dhEmi` is the reference, per
 * the rule's own note) and at most 3 calendar months after it. Dates only —
 * B10a-30 ignores the time, and so does this.
 */
export function dPrevEntregaParaEmissao(e: {
  /** `AAAA-MM-DD` in the emitente's time zone, or null when there is none. */
  readonly previsao: string | null;
  /** `dhEmi`'s date, `AAAA-MM-DD`, in the emitente's time zone. */
  readonly emissao: string;
  readonly finNFe: number;
  readonly modFrete: ModalidadeFrete | null;
}): string | null {
  if (e.previsao == null || !DATA_AAAA_MM_DD.test(e.previsao)) return null;
  if (e.finNFe !== FIN_NFE_OPERACAO.normal && e.finNFe !== FIN_NFE_OPERACAO.devolucao) return null;
  if (e.modFrete != null && MODFRETE_SEM_PREVISAO.has(e.modFrete)) return null;
  const limite = somarMeses(e.emissao, 3);
  if (limite == null) return null;
  // `AAAA-MM-DD` strings order as dates.
  if (e.previsao < e.emissao || e.previsao > limite) return null;
  return e.previsao;
}
