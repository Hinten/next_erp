/**
 * Document-level NF-e rules of NT 2025.002 that SEFAZ would reject — decided
 * from primitives, so the SAME verdicts drive the pedido editor (non-blocking
 * warnings, apps/web) and the emission pre-flight (apps/nfe refuses a nota
 * with a `bloqueia` violation before a número is consumed).
 *
 * Pure and total: no clock, no network, no Firestore. Every verdict is DATA
 * (`ViolacaoDocumento`) with its SEFAZ cStat when there is one; the wording is
 * one shared pt-BR text per rule ({@link descreverViolacaoDocumento}).
 *
 * This first slice covers the item-level reference of Grupo VC
 * (`det/DFeReferenciado`, #330). Severity is deliberate:
 *  - `bloqueia` — SEFAZ rejects it, and this module can tell for sure;
 *  - `aviso` — SEFAZ rejects it too, but this module cannot see everything the
 *    rule depends on (e.g. a Nota Fiscal Avulsa carries the SEFAZ CNPJ in its
 *    chave, the MOC's own exception to 1193/1194), so refusing could turn away
 *    a valid nota. Warn, and let SEFAZ decide.
 */
import { normalizeDocumento } from '@delfrance/core/documents';

import { chaveAcessoValida, decomporChaveAcesso } from '../chaveAcesso';

export const SEVERIDADE_VIOLACAO = {
  bloqueia: 'bloqueia',
  aviso: 'aviso',
} as const;
export type SeveridadeViolacao = (typeof SEVERIDADE_VIOLACAO)[keyof typeof SEVERIDADE_VIOLACAO];

export const REGRA_DOCUMENTO = {
  /** Policy: item references ride only with the Reforma Tributária on (NT 2025.002). */
  refItemSemReformaTributaria: 'refItemSemReformaTributaria',
  /** The referenced chave is not a 44-character chave with a valid check digit. */
  refItemChaveInvalida: 'refItemChaveInvalida',
  /** `nItem` outside the XSD's 1–990. */
  refItemNItemInvalido: 'refItemNItemInvalido',
  /** 1048 (VC03-20) — an item reference without the original item's `nItem`. */
  refItemSemNItem: 'refItemSemNItem',
  /** 1010 (VC02-05) — note-level `NFref` AND item-level references together. */
  refItemComRefNota: 'refItemComRefNota',
  /** 1072 (VC02-20) — the same chave + nItem referenced twice. */
  refItemDuplicada: 'refItemDuplicada',
  /** 1130 (VC02-30) — items referencing more than one document. */
  refItemMaisDeUmaChave: 'refItemMaisDeUmaChave',
  /** 1193 (VC02-40) — devolução: items referencing notas of different emitentes. */
  devolucaoEmitentesDiferentes: 'devolucaoEmitentesDiferentes',
  /** 1194 (VC02-50) — devolução de saída: the referenced emitente is not the destinatário. */
  devolucaoEmitenteNaoEhDestinatario: 'devolucaoEmitenteNaoEhDestinatario',
} as const;
export type RegraDocumento = (typeof REGRA_DOCUMENTO)[keyof typeof REGRA_DOCUMENTO];

/** The fixed facts of each rule: SEFAZ's cStat (null = our own policy/shape), severity, text. */
export const REGRAS_DOCUMENTO = {
  refItemSemReformaTributaria: {
    cStat: null,
    severidade: SEVERIDADE_VIOLACAO.bloqueia,
    texto:
      'A referência por item (DF-e referenciado) só é emitida com a Reforma Tributária ativa nesta filial.',
  },
  refItemChaveInvalida: {
    cStat: null,
    severidade: SEVERIDADE_VIOLACAO.bloqueia,
    texto:
      'Chave de acesso referenciada inválida: 44 caracteres com dígito verificador correto (letras A-Z só nas posições 7 a 18).',
  },
  refItemNItemInvalido: {
    cStat: null,
    severidade: SEVERIDADE_VIOLACAO.bloqueia,
    texto: 'O item da nota referenciada deve ser um número de 1 a 990.',
  },
  refItemSemNItem: {
    cStat: '1048',
    severidade: SEVERIDADE_VIOLACAO.bloqueia,
    texto: 'Informe o número do item da nota referenciada (nItem).',
  },
  refItemComRefNota: {
    cStat: '1010',
    severidade: SEVERIDADE_VIOLACAO.bloqueia,
    texto:
      'A nota não pode referenciar documentos por nota (chaves referenciadas) e por item ao mesmo tempo.',
  },
  refItemDuplicada: {
    cStat: '1072',
    severidade: SEVERIDADE_VIOLACAO.bloqueia,
    texto: 'O mesmo item de nota referenciada aparece em mais de um item.',
  },
  refItemMaisDeUmaChave: {
    cStat: '1130',
    severidade: SEVERIDADE_VIOLACAO.bloqueia,
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
}

export interface EntradaRegrasDocumento {
  /** `nfeConfig.emitirReformaTributaria` of the emitting filial. */
  readonly emitRtc: boolean;
  /** `ide.finNFe` (1 normal … 4 devolução). */
  readonly finNFe: number;
  /** `ide.tpNF`: '1' saída, '0' entrada. */
  readonly tpNF: '0' | '1';
  /** Note-level references (`NFref`), non-empty entries only. */
  readonly chNFeReferenciadas: readonly string[];
  /** The destinatário's CPF/CNPJ, any punctuation (null when unknown). */
  readonly destinatarioDocumento: string | null;
  readonly itens: readonly ItemRegrasDocumento[];
}

export interface ViolacaoDocumento {
  readonly regra: RegraDocumento;
  readonly cStat: string | null;
  readonly severidade: SeveridadeViolacao;
  /** The offending det (1-based), or null for a document-level violation. */
  readonly nItem: number | null;
}

const FIN_NFE_DEVOLUCAO = 4;

function violacao(regra: RegraDocumento, nItem: number | null): ViolacaoDocumento {
  const { cStat, severidade } = REGRAS_DOCUMENTO[regra];
  return { regra, cStat, severidade, nItem };
}

/** Every rule this module knows, evaluated over one prospective nota. */
export function violacoesDoDocumento(e: EntradaRegrasDocumento): ViolacaoDocumento[] {
  const out: ViolacaoDocumento[] = [];
  const comRef = e.itens.filter(
    (i): i is ItemRegrasDocumento & { dfeReferenciado: DfeReferenciadoEntrada } =>
      i.dfeReferenciado != null,
  );
  if (comRef.length === 0) return out;

  if (!e.emitRtc) out.push(violacao(REGRA_DOCUMENTO.refItemSemReformaTributaria, null));
  if (e.chNFeReferenciadas.length > 0) out.push(violacao(REGRA_DOCUMENTO.refItemComRefNota, null));

  const vistos = new Set<string>();
  const chavesValidas = new Set<string>();
  for (const item of comRef) {
    const { chaveAcesso, nItem } = item.dfeReferenciado;
    const chaveOk = chaveAcessoValida(chaveAcesso);
    if (!chaveOk) out.push(violacao(REGRA_DOCUMENTO.refItemChaveInvalida, item.nItem));
    else chavesValidas.add(chaveAcesso);

    if (nItem === null) {
      out.push(violacao(REGRA_DOCUMENTO.refItemSemNItem, item.nItem));
    } else if (!Number.isInteger(nItem) || nItem < 1 || nItem > 990) {
      out.push(violacao(REGRA_DOCUMENTO.refItemNItemInvalido, item.nItem));
    }

    // VC02-20: "caso nItem não informado, considerar somente a chaveAcesso".
    const chave = `${chaveAcesso}#${nItem ?? ''}`;
    if (vistos.has(chave)) out.push(violacao(REGRA_DOCUMENTO.refItemDuplicada, item.nItem));
    vistos.add(chave);
  }

  const devolucao = e.finNFe === FIN_NFE_DEVOLUCAO;
  if (chavesValidas.size > 1 && !devolucao) {
    out.push(violacao(REGRA_DOCUMENTO.refItemMaisDeUmaChave, null));
  }

  if (devolucao && chavesValidas.size > 0) {
    const emitentes = new Set(
      [...chavesValidas].map((c) => decomporChaveAcesso(c)!.cnpjCpfEmitente),
    );
    if (emitentes.size > 1) out.push(violacao(REGRA_DOCUMENTO.devolucaoEmitentesDiferentes, null));
    const dest = normalizeDocumento(e.destinatarioDocumento ?? '');
    if (e.tpNF === '1' && dest.length > 0) {
      // A CPF emitente sits in the chave's 14-character field left-padded with zeros.
      const destNaChave = dest.padStart(14, '0');
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
