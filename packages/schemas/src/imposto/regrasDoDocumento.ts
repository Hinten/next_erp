/**
 * Document-level NF-e rules of NT 2025.002 that SEFAZ would reject — decided
 * from primitives, so the SAME verdicts drive the pedido editor (non-blocking
 * warnings, apps/web), the operação form, and the emission pre-flight
 * (apps/nfe refuses a nota with a `bloqueia` violation before a número is
 * consumed).
 *
 * Pure and total: no clock, no network, no Firestore. Every verdict is DATA
 * (`ViolacaoDocumento`) with its SEFAZ cStat when there is one; the wording is
 * one shared pt-BR text per rule ({@link descreverViolacaoDocumento}). An input
 * the caller does not know (the editor has no emission date, no filial, no
 * resolved imposto) is `null` / absent, and every rule that needs it stays
 * silent rather than guessing.
 *
 * Coverage (#330):
 *  - Grupo VC — the item-level reference (`det/DFeReferenciado`);
 *  - Grupo B — the finalidade crédito/débito (finNFe 5/6) and its tipo
 *    (B25-110/120, B25.1, B25.2), and the `NFref` a nota de crédito needs
 *    (B25-30/40/50/60/65, B25-100);
 *  - Grupo UB — the cClassTrib a tipo binds (UB14-60/70/80), and the amounts
 *    of the adjustment group that tipo puts on each item (UB106-40, UB112-30,
 *    UB113).
 * ⚠️ B25-30/40/50/60 also bind finNFe 2 (complementar). That is pre-RTC
 * behaviour this module deliberately does not take over: it covers the
 * crédito half only.
 *
 * Severity is deliberate:
 *  - `bloqueia` — SEFAZ rejects it, and this module can tell for sure (or it is
 *    our own policy, `cStat: null`);
 *  - `aviso` — SEFAZ may reject it, but this module cannot see everything the
 *    rule depends on (e.g. a Nota Fiscal Avulsa carries the SEFAZ CNPJ in its
 *    chave, the MOC's own exception to 1193/1194), so refusing could turn away
 *    a valid nota. Warn, and let SEFAZ decide.
 */
import { normalizeDocumento } from '@delfrance/core/documents';

import { chaveAcessoValida, decomporChaveAcesso } from '../chaveAcesso';
import {
  FIN_NFE_OPERACAO,
  TP_NF_CREDITO,
  TP_NF_DEBITO,
  type TpNFCredito,
  type TpNFDebito,
} from '../operacao';
import {
  CCLASSTRIB_DO_TP_NF_CREDITO,
  CCLASSTRIB_DO_TP_NF_DEBITO,
  COMPETENCIA_AAAA_MM,
  GRUPO_AJUSTE_RTC,
  cClassTribCompativelComTipo,
  grupoDeAjusteDoTipo,
  type TipoNotaAjuste,
} from './notaCreditoDebito';

export const SEVERIDADE_VIOLACAO = {
  bloqueia: 'bloqueia',
  aviso: 'aviso',
} as const;
export type SeveridadeViolacao = (typeof SEVERIDADE_VIOLACAO)[keyof typeof SEVERIDADE_VIOLACAO];

export const REGRA_DOCUMENTO = {
  // ── Grupo VC — item-level references ────────────────────────────────────
  /** Policy: item references ride only with the Reforma Tributária on (NT 2025.002). */
  refItemSemReformaTributaria: 'refItemSemReformaTributaria',
  /** The referenced chave is not a 44-character chave with a valid check digit. */
  refItemChaveInvalida: 'refItemChaveInvalida',
  /** `nItem` outside the XSD's 1–990. */
  refItemNItemInvalido: 'refItemNItemInvalido',
  /** 1048 (VC03-20) — an item reference without the original item's `nItem`. */
  refItemSemNItem: 'refItemSemNItem',
  /** 1039 (VC03-10) — débito 03 references whole notas: `nItem` is forbidden. */
  refItemNItemIndevido: 'refItemNItemIndevido',
  /** 1010 (VC02-05) — note-level `NFref` AND item-level references together. */
  refItemComRefNota: 'refItemComRefNota',
  /** 1042 (VC02-07) — a nota de crédito referencing by item. */
  refItemEmNotaDeCredito: 'refItemEmNotaDeCredito',
  /** 1038 (VC02-10) — débito 03/04 without any item reference. */
  refItemAusenteNoDebito: 'refItemAusenteNoDebito',
  /** 1038 (VC02-10) — débito 03/04: this item has none while others do (per item: uncertain). */
  refItemAusenteNoItemDoDebito: 'refItemAusenteNoItemDoDebito',
  /** 1072 (VC02-20) — the same chave + nItem referenced twice. */
  refItemDuplicada: 'refItemDuplicada',
  /** 1130 (VC02-30) — items referencing more than one document. */
  refItemMaisDeUmaChave: 'refItemMaisDeUmaChave',
  /** 1193 (VC02-40) — devolução: items referencing notas of different emitentes. */
  devolucaoEmitentesDiferentes: 'devolucaoEmitentesDiferentes',
  /** 1194 (VC02-50) — devolução de saída: the referenced emitente is not the destinatário. */
  devolucaoEmitenteNaoEhDestinatario: 'devolucaoEmitenteNaoEhDestinatario',

  // ── Grupo B — finalidade crédito/débito and its tipo ────────────────────
  /** 1161 (B25-110) — a nota de crédito must be an entrada. */
  creditoNaoEhEntrada: 'creditoNaoEhEntrada',
  /** 1162 (B25-120) — a nota de débito must be a saída. */
  debitoNaoEhSaida: 'debitoNaoEhSaida',
  /** 1139 (B25.1-10) — `tpNFDebito` on a nota that is not de débito. */
  tpNFDebitoIndevido: 'tpNFDebitoIndevido',
  /** 1009 (B25.1-20) — a nota de débito without its `tpNFDebito`. */
  tpNFDebitoAusente: 'tpNFDebitoAusente',
  /** 1163 (B25.2-10) — `tpNFCredito` on a nota that is not de crédito. */
  tpNFCreditoIndevido: 'tpNFCreditoIndevido',
  /** 1164 (B25.2-20) — a nota de crédito without its `tpNFCredito`. */
  tpNFCreditoAusente: 'tpNFCreditoAusente',
  /** 1145 (B25.2-30) — crédito 02 (crédito presumido ZFM) only from 2029. */
  creditoZfmAntesDe2029: 'creditoZfmAntesDe2029',
  /** 1152 (B25.2-40) — crédito 03 (retorno) must be an entrada. */
  creditoRetornoNaoEhEntrada: 'creditoRetornoNaoEhEntrada',

  // ── Grupo B — the NFref of a nota de crédito ────────────────────────────
  /** 254 (B25-30) — crédito 01/03/04 without a referenced NF. */
  creditoSemNFref: 'creditoSemNFref',
  /** 255 (B25-40) — crédito 01/03/04 with more than one referenced NF. */
  creditoMaisDeUmaNFref: 'creditoMaisDeUmaNFref',
  /** 269 (B25-50) — crédito 03/04 referencing a nota of another emitente. */
  creditoNFrefOutroEmitente: 'creditoNFrefOutroEmitente',
  /** 678 (B25-60) — crédito 03/04 referencing a nota of another UF. */
  creditoNFrefOutraUF: 'creditoNFrefOutraUF',
  /** 1027 (B25-65) — crédito 02 must not reference a nota. */
  creditoNFrefIndevida: 'creditoNFrefIndevida',
  /** 1003 (B25-100) — a nota de crédito references only modelo 55 (65 too for crédito 03). */
  creditoNFrefModeloInvalido: 'creditoNFrefModeloInvalido',

  // ── Grupo UB — the cClassTrib a tipo binds ──────────────────────────────
  /** 1202 (UB14-60) — a cClassTrib only another tipo of nota may carry. */
  cClassTribIncompativelComTipoNota: 'cClassTribIncompativelComTipoNota',
  /** 1200 (UB14-70) — the tipo de débito binds another cClassTrib. */
  cClassTribIncompativelComDebito: 'cClassTribIncompativelComDebito',
  /** 1201 (UB14-80) — the tipo de crédito binds another cClassTrib. */
  cClassTribIncompativelComCredito: 'cClassTribIncompativelComCredito',

  // ── Policy — what this ERP emits of finNFe 5/6 ──────────────────────────
  /** A nota de crédito/débito is an IBS/CBS document: the filial must emit the RTC. */
  notaAjusteSemReformaTributaria: 'notaAjusteSemReformaTributaria',
  /** Crédito 02 (ZFM) and 05 (sucessão): not emitted — see {@link tipoAindaNaoEmitido}. */
  notaAjusteTipoNaoSuportado: 'notaAjusteTipoNaoSuportado',
  /** Every item of a nota de crédito/débito carries IBS/CBS. */
  notaAjusteItemSemIbsCbs: 'notaAjusteItemSemIbsCbs',

  // ── The adjustment amounts (gTransfCred / gAjusteCompet / gEstornoCred) ──
  /** A tipo with an adjustment group, and an item without its amounts. */
  ajusteAusente: 'ajusteAusente',
  /** An amount that is not a finite, non-negative number. */
  ajusteValorInvalido: 'ajusteValorInvalido',
  /** 1129 (UB106-40) — gTransfCred with neither IBS nor CBS above zero. */
  ajusteTransfCredZerado: 'ajusteTransfCredZerado',
  /** 1171 (UB112-30) — gAjusteCompet with neither IBS nor CBS above zero. */
  ajusteCompetZerado: 'ajusteCompetZerado',
  /** gAjusteCompet without a valid `competApur` (UB113, AAAA-MM). */
  ajusteCompetenciaInvalida: 'ajusteCompetenciaInvalida',
  /** UB113 — `competApur` is "período atual ou retroativo", never a later month. */
  ajusteCompetenciaFutura: 'ajusteCompetenciaFutura',
  /** Amounts on an item of a nota whose tipo has no adjustment group: ignored. */
  ajusteIndevido: 'ajusteIndevido',
} as const;
export type RegraDocumento = (typeof REGRA_DOCUMENTO)[keyof typeof REGRA_DOCUMENTO];

const B = SEVERIDADE_VIOLACAO.bloqueia;

/** The fixed facts of each rule: SEFAZ's cStat (null = our own policy/shape), severity, text. */
export const REGRAS_DOCUMENTO = {
  refItemSemReformaTributaria: {
    cStat: null,
    severidade: B,
    texto:
      'A referência por item (DF-e referenciado) só é emitida com a Reforma Tributária ativa nesta filial.',
  },
  refItemChaveInvalida: {
    cStat: null,
    severidade: B,
    texto:
      'Chave de acesso referenciada inválida: 44 caracteres com dígito verificador correto (letras A-Z só nas posições 7 a 18).',
  },
  refItemNItemInvalido: {
    cStat: null,
    severidade: B,
    texto: 'O item da nota referenciada deve ser um número de 1 a 990.',
  },
  refItemSemNItem: {
    cStat: '1048',
    severidade: B,
    texto: 'Informe o número do item da nota referenciada (nItem).',
  },
  refItemNItemIndevido: {
    cStat: '1039',
    severidade: B,
    texto:
      'Na nota de débito de notas não processadas na apuração, referencie a nota inteira: não informe o item (nItem).',
  },
  refItemComRefNota: {
    cStat: '1010',
    severidade: B,
    texto:
      'A nota não pode referenciar documentos por nota (chaves referenciadas) e por item ao mesmo tempo.',
  },
  refItemEmNotaDeCredito: {
    cStat: '1042',
    severidade: B,
    texto: 'A nota de crédito referencia a nota original pelas chaves referenciadas, não por item.',
  },
  refItemAusenteNoDebito: {
    cStat: '1038',
    severidade: B,
    texto:
      'Este tipo de nota de débito exige a referência por item (DF-e referenciado) à nota de origem.',
  },
  refItemAusenteNoItemDoDebito: {
    cStat: '1038',
    severidade: SEVERIDADE_VIOLACAO.aviso,
    texto: 'Este item da nota de débito está sem referência (DF-e referenciado).',
  },
  refItemDuplicada: {
    cStat: '1072',
    severidade: B,
    texto: 'O mesmo item de nota referenciada aparece em mais de um item.',
  },
  refItemMaisDeUmaChave: {
    cStat: '1130',
    severidade: B,
    texto: 'Os itens devem referenciar uma única nota.',
  },
  devolucaoEmitentesDiferentes: {
    cStat: '1193',
    severidade: SEVERIDADE_VIOLACAO.aviso,
    texto: 'Na devolução, todas as notas referenciadas devem ser do mesmo emitente.',
  },
  devolucaoEmitenteNaoEhDestinatario: {
    cStat: '1194',
    severidade: SEVERIDADE_VIOLACAO.aviso,
    texto:
      'Na devolução de saída, o emitente da nota referenciada deve ser o destinatário desta nota.',
  },
  creditoNaoEhEntrada: {
    cStat: '1161',
    severidade: B,
    texto: 'A nota de crédito deve ser uma operação de entrada.',
  },
  debitoNaoEhSaida: {
    cStat: '1162',
    severidade: B,
    texto: 'A nota de débito deve ser uma operação de saída.',
  },
  tpNFDebitoIndevido: {
    cStat: '1139',
    severidade: B,
    texto: 'O tipo de nota de débito só se informa com a finalidade "Nota de débito".',
  },
  tpNFDebitoAusente: {
    cStat: '1009',
    severidade: B,
    texto: 'Informe o tipo da nota de débito.',
  },
  tpNFCreditoIndevido: {
    cStat: '1163',
    severidade: B,
    texto: 'O tipo de nota de crédito só se informa com a finalidade "Nota de crédito".',
  },
  tpNFCreditoAusente: {
    cStat: '1164',
    severidade: B,
    texto: 'Informe o tipo da nota de crédito.',
  },
  creditoZfmAntesDe2029: {
    cStat: '1145',
    severidade: B,
    texto: 'A nota de crédito presumido de IBS na ZFM só pode ser emitida a partir de 2029.',
  },
  creditoRetornoNaoEhEntrada: {
    cStat: '1152',
    severidade: B,
    texto: 'A nota de crédito de retorno deve ser uma operação de entrada.',
  },
  creditoSemNFref: {
    cStat: '254',
    severidade: B,
    texto: 'Este tipo de nota de crédito exige a chave da nota original (chaves referenciadas).',
  },
  creditoMaisDeUmaNFref: {
    cStat: '255',
    severidade: B,
    texto: 'Este tipo de nota de crédito referencia uma única nota.',
  },
  creditoNFrefOutroEmitente: {
    cStat: '269',
    severidade: B,
    texto: 'A nota referenciada deve ter sido emitida por esta mesma empresa (CNPJ).',
  },
  creditoNFrefOutraUF: {
    cStat: '678',
    severidade: B,
    texto: 'A nota referenciada deve ser da mesma UF do emitente.',
  },
  creditoNFrefIndevida: {
    cStat: '1027',
    severidade: B,
    texto: 'A nota de crédito presumido de IBS na ZFM não referencia outra nota.',
  },
  creditoNFrefModeloInvalido: {
    cStat: '1003',
    severidade: B,
    texto: 'A nota de crédito só referencia NF-e modelo 55 (e NFC-e modelo 65 no tipo "Retorno").',
  },
  cClassTribIncompativelComTipoNota: {
    cStat: '1202',
    severidade: B,
    texto:
      'A classificação tributária (cClassTrib) deste item é exclusiva de outro tipo de nota de crédito/débito.',
  },
  cClassTribIncompativelComDebito: {
    cStat: '1200',
    severidade: B,
    texto:
      'A classificação tributária (cClassTrib) deste item não é a exigida por este tipo de nota de débito.',
  },
  cClassTribIncompativelComCredito: {
    cStat: '1201',
    severidade: B,
    texto:
      'A classificação tributária (cClassTrib) deste item não é a exigida por este tipo de nota de crédito.',
  },
  notaAjusteSemReformaTributaria: {
    cStat: null,
    severidade: B,
    texto:
      'Nota de crédito/débito só é emitida com a Reforma Tributária (IBS/CBS) ativa nesta filial.',
  },
  notaAjusteTipoNaoSuportado: {
    cStat: null,
    severidade: B,
    texto: 'Este tipo de nota de crédito ainda não é emitido pelo ERP.',
  },
  notaAjusteItemSemIbsCbs: {
    cStat: null,
    severidade: B,
    texto:
      'Todo item de nota de crédito/débito precisa da configuração de IBS/CBS (CST e cClassTrib).',
  },
  ajusteAusente: {
    cStat: null,
    severidade: B,
    texto: 'Informe os valores de IBS e CBS do ajuste deste item (aba Fiscal).',
  },
  ajusteValorInvalido: {
    cStat: null,
    severidade: B,
    texto: 'Os valores de IBS e CBS do ajuste devem ser iguais ou maiores que zero.',
  },
  ajusteTransfCredZerado: {
    cStat: '1129',
    severidade: B,
    texto: 'Na transferência de crédito, o valor do IBS ou da CBS deve ser maior que zero.',
  },
  ajusteCompetZerado: {
    cStat: '1171',
    severidade: B,
    texto: 'No ajuste de competência, o valor do IBS ou da CBS deve ser maior que zero.',
  },
  ajusteCompetenciaInvalida: {
    cStat: null,
    severidade: B,
    texto: 'Informe a competência do ajuste no formato AAAA-MM (ex.: 2026-09).',
  },
  ajusteCompetenciaFutura: {
    cStat: null,
    severidade: B,
    texto: 'A competência do ajuste deve ser o mês da emissão ou um mês anterior.',
  },
  ajusteIndevido: {
    cStat: null,
    severidade: SEVERIDADE_VIOLACAO.aviso,
    texto:
      'Este item tem valores de ajuste de IBS/CBS, mas o tipo desta nota não os usa — serão ignorados.',
  },
} as const satisfies Record<
  RegraDocumento,
  { readonly cStat: string | null; readonly severidade: SeveridadeViolacao; readonly texto: string }
>;

export interface DfeReferenciadoEntrada {
  readonly chaveAcesso: string;
  readonly nItem: number | null;
}

export interface ItemRegrasDocumento {
  /** The det's own `nItem` in the nota being built (1-based). */
  readonly nItem: number;
  readonly dfeReferenciado: DfeReferenciadoEntrada | null;
  /**
   * The item's IBS/CBS `cClassTrib`: `null` = the item carries no IBS/CBS
   * configuration; ABSENT = not known here (the editor, before the imposto
   * cascade resolves it) — every rule that needs it stays silent.
   */
  readonly cClassTrib?: string | null;
  /**
   * The item's adjustment amounts (`itens[*].ajusteRtc`): `null` = none
   * entered; ABSENT = not known here — the rules that need them stay silent.
   */
  readonly ajusteRtc?: AjusteRtcEntrada | null;
}

export interface AjusteRtcEntrada {
  readonly vIBS: number;
  readonly vCBS: number;
  readonly competApur: string | null;
}

/** The operação-level facts (`ide`) of a nota — also all the operação form knows. */
export interface EntradaRegrasOperacao {
  /** `ide.finNFe` (1 normal … 4 devolução, 5 crédito, 6 débito). */
  readonly finNFe: number;
  /** `ide.tpNF`: '1' saída, '0' entrada. */
  readonly tpNF: '0' | '1';
  readonly tpNFDebito: TpNFDebito | null;
  readonly tpNFCredito: TpNFCredito | null;
  /** Year of `dhEmi` in the emitente's time zone; `null` when unknown (the forms). */
  readonly anoEmissao: number | null;
}

export interface EntradaRegrasDocumento extends EntradaRegrasOperacao {
  /** `nfeConfig.emitirReformaTributaria` of the emitting filial. */
  readonly emitRtc: boolean;
  /** Note-level references (`NFref`), non-empty entries only. */
  readonly chNFeReferenciadas: readonly string[];
  /** The destinatário's CPF/CNPJ, any punctuation (null when unknown). */
  readonly destinatarioDocumento: string | null;
  /** The emitente's CNPJ, any punctuation (null when unknown). */
  readonly emitenteDocumento: string | null;
  /** The emitente's UF as its 2-digit IBGE code (`ide.cUF`), null when unknown. */
  readonly emitenteCUF: string | null;
  /** Month (1–12) of `dhEmi` in the emitente's time zone; `null` when unknown. */
  readonly mesEmissao: number | null;
  readonly itens: readonly ItemRegrasDocumento[];
}

export interface ViolacaoDocumento {
  readonly regra: RegraDocumento;
  readonly cStat: string | null;
  readonly severidade: SeveridadeViolacao;
  /** The offending det (1-based), or null for a document-level violation. */
  readonly nItem: number | null;
}

function violacao(regra: RegraDocumento, nItem: number | null): ViolacaoDocumento {
  const { cStat, severidade } = REGRAS_DOCUMENTO[regra];
  return { regra, cStat, severidade, nItem };
}

/** A chave's emitente field is 14 characters; a CPF sits in it left-padded with zeros. */
function documentoNaChave(documento: string | null): string | null {
  const d = normalizeDocumento(documento ?? '');
  return d.length > 0 ? d.padStart(14, '0') : null;
}

/**
 * Grupo B rules an operação alone decides (B25-110/120, B25.1, B25.2) — what
 * the operação form checks, and the first thing {@link violacoesDoDocumento}
 * checks.
 */
export function violacoesDaOperacao(e: EntradaRegrasOperacao): ViolacaoDocumento[] {
  const out: ViolacaoDocumento[] = [];
  const credito = e.finNFe === FIN_NFE_OPERACAO.credito;
  const debito = e.finNFe === FIN_NFE_OPERACAO.debito;
  if (credito && e.tpNF !== '0') out.push(violacao(REGRA_DOCUMENTO.creditoNaoEhEntrada, null));
  if (debito && e.tpNF !== '1') out.push(violacao(REGRA_DOCUMENTO.debitoNaoEhSaida, null));
  if (e.tpNFDebito != null && !debito) {
    out.push(violacao(REGRA_DOCUMENTO.tpNFDebitoIndevido, null));
  }
  if (debito && e.tpNFDebito == null) out.push(violacao(REGRA_DOCUMENTO.tpNFDebitoAusente, null));
  if (e.tpNFCredito != null && !credito) {
    out.push(violacao(REGRA_DOCUMENTO.tpNFCreditoIndevido, null));
  }
  if (credito && e.tpNFCredito == null) {
    out.push(violacao(REGRA_DOCUMENTO.tpNFCreditoAusente, null));
  }
  if (
    e.tpNFCredito === TP_NF_CREDITO.creditoPresumidoZfm &&
    e.anoEmissao != null &&
    e.anoEmissao < 2029
  ) {
    out.push(violacao(REGRA_DOCUMENTO.creditoZfmAntesDe2029, null));
  }
  if (e.tpNFCredito === TP_NF_CREDITO.retornoRecusaTotal && e.tpNF !== '0') {
    out.push(violacao(REGRA_DOCUMENTO.creditoRetornoNaoEhEntrada, null));
  }
  return out;
}

/** Every rule this module knows, evaluated over one prospective nota. */
export function violacoesDoDocumento(e: EntradaRegrasDocumento): ViolacaoDocumento[] {
  return [
    ...violacoesDaOperacao(e),
    ...violacoesDaNotaDeAjuste(e),
    ...violacoesDoCClassTrib(e),
    ...violacoesDaNFrefDoCredito(e),
    ...violacoesDaReferenciaPorItem(e),
  ];
}

/**
 * The two tipos this ERP does not emit, each for a reason in the NT itself
 * (v1.40 — re-check both against v1.50):
 *  - crédito 02 (crédito presumido de IBS na ZFM) cannot be emitted before
 *    2029 (1145), and needs the item-level `prod/tpCredPresIBSZFM` (I05k) this
 *    ERP does not model;
 *  - crédito 05 (sucessão) binds 800001, whose CST 800 REQUIRES `gTransfCred`
 *    (1132), while UB106-30 accepts `gTransfCred` only on a nota de DÉBITO
 *    (1133). No item can satisfy both.
 */
export function tipoAindaNaoEmitido(t: TipoNotaAjuste): boolean {
  return (
    t.finNFe === FIN_NFE_OPERACAO.credito &&
    (t.tpNFCredito === TP_NF_CREDITO.creditoPresumidoZfm ||
      t.tpNFCredito === TP_NF_CREDITO.transferenciaCreditoSucessao)
  );
}

/** Policy: what this ERP emits of a nota de crédito/débito (finNFe 5/6). */
function violacoesDaNotaDeAjuste(e: EntradaRegrasDocumento): ViolacaoDocumento[] {
  const grupo = grupoDeAjusteDoTipo(e);
  if (e.finNFe !== FIN_NFE_OPERACAO.credito && e.finNFe !== FIN_NFE_OPERACAO.debito) {
    return violacoesDeAjusteIndevido(e);
  }
  const out: ViolacaoDocumento[] = [];
  if (!e.emitRtc) out.push(violacao(REGRA_DOCUMENTO.notaAjusteSemReformaTributaria, null));
  if (tipoAindaNaoEmitido(e)) {
    out.push(violacao(REGRA_DOCUMENTO.notaAjusteTipoNaoSuportado, null));
    return out;
  }
  if (grupo == null) {
    // An ordinary gIBSCBS item: its classification comes from its own config.
    if (e.emitRtc) {
      for (const item of e.itens) {
        if (item.cClassTrib === null) {
          out.push(violacao(REGRA_DOCUMENTO.notaAjusteItemSemIbsCbs, item.nItem));
        }
      }
    }
    return [...out, ...violacoesDeAjusteIndevido(e)];
  }
  // An adjustment item: the tipo supplies CST + cClassTrib, the item the amounts.
  for (const item of e.itens) {
    const a = item.ajusteRtc;
    if (a === undefined) continue;
    if (a === null) {
      out.push(violacao(REGRA_DOCUMENTO.ajusteAusente, item.nItem));
      continue;
    }
    if (!valorValido(a.vIBS) || !valorValido(a.vCBS)) {
      out.push(violacao(REGRA_DOCUMENTO.ajusteValorInvalido, item.nItem));
      continue;
    }
    const algumPositivo = a.vIBS > 0 || a.vCBS > 0;
    if (grupo === GRUPO_AJUSTE_RTC.transfCred && !algumPositivo) {
      out.push(violacao(REGRA_DOCUMENTO.ajusteTransfCredZerado, item.nItem));
    }
    if (grupo === GRUPO_AJUSTE_RTC.ajusteCompet) {
      if (!algumPositivo) out.push(violacao(REGRA_DOCUMENTO.ajusteCompetZerado, item.nItem));
      if (a.competApur == null || !COMPETENCIA_AAAA_MM.test(a.competApur)) {
        out.push(violacao(REGRA_DOCUMENTO.ajusteCompetenciaInvalida, item.nItem));
      } else if (competenciaPosterior(a.competApur, e.anoEmissao, e.mesEmissao)) {
        out.push(violacao(REGRA_DOCUMENTO.ajusteCompetenciaFutura, item.nItem));
      }
    }
    // gEstornoCred: 1174's "IBS or CBS above zero" does not apply to débito 07,
    // the only tipo that carries it (UB116-30's own exception).
  }
  return out;
}

/** Amounts on the items of a nota whose tipo carries no adjustment group. */
function violacoesDeAjusteIndevido(e: EntradaRegrasDocumento): ViolacaoDocumento[] {
  return e.itens
    .filter((item) => item.ajusteRtc != null)
    .map((item) => violacao(REGRA_DOCUMENTO.ajusteIndevido, item.nItem));
}

function valorValido(v: number): boolean {
  return Number.isFinite(v) && v >= 0;
}

/** `AAAA-MM` strictly after the emission month; `false` when the month is unknown. */
function competenciaPosterior(competApur: string, ano: number | null, mes: number | null): boolean {
  if (ano == null || mes == null) return false;
  const [a, m] = competApur.split('-').map(Number) as [number, number];
  return a > ano || (a === ano && m > mes);
}

/** UB14-60/70/80 — only with the IBS/CBS group on the wire, i.e. the RTC on. */
function violacoesDoCClassTrib(e: EntradaRegrasDocumento): ViolacaoDocumento[] {
  if (!e.emitRtc) return [];
  const out: ViolacaoDocumento[] = [];
  const exigidoDebito = e.tpNFDebito != null ? CCLASSTRIB_DO_TP_NF_DEBITO[e.tpNFDebito] : undefined;
  const exigidoCredito =
    e.tpNFCredito != null ? CCLASSTRIB_DO_TP_NF_CREDITO[e.tpNFCredito] : undefined;
  for (const item of e.itens) {
    const c = item.cClassTrib;
    if (typeof c !== 'string') continue;
    if (!cClassTribCompativelComTipo(c, e)) {
      out.push(violacao(REGRA_DOCUMENTO.cClassTribIncompativelComTipoNota, item.nItem));
    }
    if (exigidoDebito !== undefined && c !== exigidoDebito) {
      out.push(violacao(REGRA_DOCUMENTO.cClassTribIncompativelComDebito, item.nItem));
    }
    if (exigidoCredito !== undefined && c !== exigidoCredito) {
      out.push(violacao(REGRA_DOCUMENTO.cClassTribIncompativelComCredito, item.nItem));
    }
  }
  return out;
}

/** B25-30/40/50/60/65 and B25-100 — the note-level `NFref` of a nota de crédito. */
function violacoesDaNFrefDoCredito(e: EntradaRegrasDocumento): ViolacaoDocumento[] {
  if (e.finNFe !== FIN_NFE_OPERACAO.credito) return [];
  const out: ViolacaoDocumento[] = [];
  const tp = e.tpNFCredito;
  const refs = e.chNFeReferenciadas;
  const retornoOuReducao =
    tp === TP_NF_CREDITO.retornoRecusaTotal || tp === TP_NF_CREDITO.reducaoValores;
  if (tp === TP_NF_CREDITO.multaJuros || retornoOuReducao) {
    if (refs.length === 0) out.push(violacao(REGRA_DOCUMENTO.creditoSemNFref, null));
    if (refs.length > 1) out.push(violacao(REGRA_DOCUMENTO.creditoMaisDeUmaNFref, null));
  }
  if (tp === TP_NF_CREDITO.creditoPresumidoZfm && refs.length > 0) {
    out.push(violacao(REGRA_DOCUMENTO.creditoNFrefIndevida, null));
  }

  // The chave-derived rules read only chaves that decompose (valid DV): a
  // malformed one is `ide`'s to refuse, and guessing its fields would invent
  // a second violation out of the first.
  const partes = refs.map(decomporChaveAcesso).filter((p) => p != null);
  const modelosAceitos = tp === TP_NF_CREDITO.retornoRecusaTotal ? ['55', '65'] : ['55'];
  if (partes.some((p) => !modelosAceitos.includes(p.mod))) {
    out.push(violacao(REGRA_DOCUMENTO.creditoNFrefModeloInvalido, null));
  }
  if (retornoOuReducao) {
    const emitente = documentoNaChave(e.emitenteDocumento);
    if (emitente != null && partes.some((p) => p.cnpjCpfEmitente !== emitente)) {
      out.push(violacao(REGRA_DOCUMENTO.creditoNFrefOutroEmitente, null));
    }
    if (e.emitenteCUF != null && partes.some((p) => p.cUF !== e.emitenteCUF)) {
      out.push(violacao(REGRA_DOCUMENTO.creditoNFrefOutraUF, null));
    }
  }
  return out;
}

/** Grupo VC — the item-level reference (`det/DFeReferenciado`). */
function violacoesDaReferenciaPorItem(e: EntradaRegrasDocumento): ViolacaoDocumento[] {
  const out: ViolacaoDocumento[] = [];
  const comRef = e.itens.filter(
    (i): i is ItemRegrasDocumento & { dfeReferenciado: DfeReferenciadoEntrada } =>
      i.dfeReferenciado != null,
  );
  // VC02-10 is keyed on tpNFDebito alone (a finNFe mismatch is B25.1-10's).
  const debitoNaoProcessado = e.tpNFDebito === TP_NF_DEBITO.debitoNotaNaoProcessada;
  if (debitoNaoProcessado || e.tpNFDebito === TP_NF_DEBITO.multaJuros) {
    if (comRef.length === 0) {
      out.push(violacao(REGRA_DOCUMENTO.refItemAusenteNoDebito, null));
    } else {
      // Whether SEFAZ judges VC02-10 per item or per nota the NT does not say,
      // so an item left out of a partly-referenced nota is only a warning.
      for (const item of e.itens) {
        if (item.dfeReferenciado == null) {
          out.push(violacao(REGRA_DOCUMENTO.refItemAusenteNoItemDoDebito, item.nItem));
        }
      }
    }
  }
  if (comRef.length === 0) return out;

  if (!e.emitRtc) out.push(violacao(REGRA_DOCUMENTO.refItemSemReformaTributaria, null));
  if (e.chNFeReferenciadas.length > 0) out.push(violacao(REGRA_DOCUMENTO.refItemComRefNota, null));
  // VC02-07 — the tpNFCredito 06 exception arrives with that code (PL_010f).
  if (e.finNFe === FIN_NFE_OPERACAO.credito) {
    out.push(violacao(REGRA_DOCUMENTO.refItemEmNotaDeCredito, null));
  }

  const vistos = new Set<string>();
  const chavesValidas = new Set<string>();
  for (const item of comRef) {
    const { chaveAcesso, nItem } = item.dfeReferenciado;
    const chaveOk = chaveAcessoValida(chaveAcesso);
    if (!chaveOk) out.push(violacao(REGRA_DOCUMENTO.refItemChaveInvalida, item.nItem));
    else chavesValidas.add(chaveAcesso);

    if (debitoNaoProcessado) {
      // VC03-10 forbids it; VC03-20 (1048) exempts exactly this tipo.
      if (nItem !== null) out.push(violacao(REGRA_DOCUMENTO.refItemNItemIndevido, item.nItem));
    } else if (nItem === null) {
      out.push(violacao(REGRA_DOCUMENTO.refItemSemNItem, item.nItem));
    } else if (!Number.isInteger(nItem) || nItem < 1 || nItem > 990) {
      out.push(violacao(REGRA_DOCUMENTO.refItemNItemInvalido, item.nItem));
    }

    // VC02-20: "caso nItem não informado, considerar somente a chaveAcesso".
    const chave = `${chaveAcesso}#${nItem ?? ''}`;
    if (vistos.has(chave)) out.push(violacao(REGRA_DOCUMENTO.refItemDuplicada, item.nItem));
    vistos.add(chave);
  }

  const devolucao = e.finNFe === FIN_NFE_OPERACAO.devolucao;
  // VC02-30 exceptions: devolução, and débito 03 (one nota per unprocessed document).
  if (chavesValidas.size > 1 && !devolucao && !debitoNaoProcessado) {
    out.push(violacao(REGRA_DOCUMENTO.refItemMaisDeUmaChave, null));
  }

  if (devolucao && chavesValidas.size > 0) {
    const emitentes = new Set(
      [...chavesValidas].map((c) => decomporChaveAcesso(c)!.cnpjCpfEmitente),
    );
    if (emitentes.size > 1) out.push(violacao(REGRA_DOCUMENTO.devolucaoEmitentesDiferentes, null));
    const destNaChave = documentoNaChave(e.destinatarioDocumento);
    if (e.tpNF === '1' && destNaChave != null) {
      if ([...emitentes].some((em) => em !== destNaChave)) {
        out.push(violacao(REGRA_DOCUMENTO.devolucaoEmitenteNaoEhDestinatario, null));
      }
    }
  }
  return out;
}

/** True when any violation must stop the emission. */
export function bloqueiaEmissao(violacoes: readonly ViolacaoDocumento[]): boolean {
  return violacoes.some((v) => v.severidade === SEVERIDADE_VIOLACAO.bloqueia);
}

/** One line of pt-BR text for a violation — shared by the editor and the emission error. */
export function descreverViolacaoDocumento(v: ViolacaoDocumento): string {
  const base = REGRAS_DOCUMENTO[v.regra].texto;
  const onde = v.nItem === null ? '' : `Item ${v.nItem}: `;
  const codigo = v.cStat === null ? '' : ` (SEFAZ ${v.cStat})`;
  return `${onde}${base}${codigo}`;
}
