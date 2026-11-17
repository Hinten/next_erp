/**
 * The Loja Integrada variation linker's pure rules (master plan step 10): what
 * the tab edits in `grupoDeVariacoes.linksVariacoesli`, what a save of the grupo
 * checks, and how a conflicting save merges. No React, no clock, no I/O.
 *
 * The staging marks, "edited or untouched" and the conflict merge are the shared
 * machinery in `vinculosDeCanal.ts` (its header states the rules); this module
 * names Loja Integrada's mark and key, and adds the channel's own reading.
 *
 * The field stays tolerant (`z.array(z.json())`): a stored entry nobody touched
 * is carried back as it is — valid or not, of an active conta or not — and a
 * defect among untouched entries is SHOWN, never blocking a save that does not
 * touch them (renaming the grupo, adding a size). Every entry the operator
 * creates or changes must be complete and break no uniqueness rule. The shared
 * validator (`conflitosLinksVariacoesLi`) decides both; `vinculosDeCanal.ts`
 * decides which entries are EDITED.
 *
 * The conflict mark ({@link MARCA_CONFLITO_VINCULO_LI}) and the staged deletion
 * are stripped on save by {@link prepararVinculosLi}.
 *
 * Every comparison is exact: no case, trim or number↔string fold.
 */
import type { ValidationIssue } from '@delfrance/ui';
import {
  TIPO_CONFLITO_LINK_LI,
  TIPO_ENTRADA_LINK_LI,
  conflitosLinksVariacoesLi,
  lerLinksVariacoesLi,
  type ConflitoLinkLi,
  type EntradaLinkVariacoesLi,
} from '@delfrance/schemas';
import {
  CONFLITO_VINCULO,
  criarNucleoDeVinculos,
  ehObjeto,
  idsDasVariantes,
  nomesDasVariantes,
  proprio,
  type ConflitoVinculo,
  type Registro,
  type SeedDeVinculos,
} from './vinculosDeCanal';

/** The transient key a conflict merge sets on an entry (see the module header). */
export const MARCA_CONFLITO_VINCULO_LI = '_conflitoVinculoLi';

export const CONFLITO_VINCULO_LI = CONFLITO_VINCULO;
export type ConflitoVinculoLi = ConflitoVinculo;

/**
 * Where an element that is NOT an object waits while staged for removal: it is
 * wrapped as `{ [DELETE_MARK]: true, [VALOR_ILEGIVEL_LI]: elemento }`, and the
 * undo unwraps it. A save drops the wrapper with the rest of the marked entries.
 */
const VALOR_ILEGIVEL_LI = '_valorIlegivelLi';

const nucleo = criarNucleoDeVinculos({
  marcaConflito: MARCA_CONFLITO_VINCULO_LI,
  chaveValorIlegivel: VALOR_ILEGIVEL_LI,
  /** The (conta, grade) key of an element, or `null` when it has none. Exact. */
  chaveDe: (entrada) => {
    const conta = proprio(entrada, 'integracaoLiId');
    const grade = proprio(entrada, 'grade_id');
    return typeof conta === 'string' && typeof grade === 'number'
      ? JSON.stringify([conta, grade])
      : null;
  },
});

/** Whether the operator staged this entry for removal. */
export const removidaNoFormularioLi = nucleo.removidaNoFormulario;

/** The conflict merge's note on an entry, or `null`. */
export const marcaDeConflitoLi = nucleo.marcaDeConflito;

/** The entry as it would be STORED: marks stripped, a wrapped element unwrapped. */
export const normalizarEntradaLi = nucleo.normalizarEntrada;

/** {@link prepararVinculosLi} plus, for each written entry, its index in the form's value. */
export const prepararVinculosLiComOrigem = nucleo.prepararComOrigem;

/** The field's `prepareForSave`: drops staged and `removido` entries, strips every mark. */
export const prepararVinculosLi = nucleo.preparar;

/**
 * The form's seed for the linker: the values its two fields were last reset to.
 * Published by the tab; `null` (never published) fails closed everywhere.
 */
export type SeedVinculadorLi = SeedDeVinculos;

/** The indices of a WRITTEN list this save creates or changes, by value against the seed. */
export const editadasPorValorLi = nucleo.editadasPorValor;

/** The ids of a `variacoes` value, minus any staged for deletion. Exact, no fold. */
export const idsDasVariantesLi = idsDasVariantes;

/** `id → nome` over one or more `variacoes` values; the first name wins. */
export const nomesDasVariantesLi = nomesDasVariantes;

/** The shared rules over a WRITTEN list, with the variantes this save leaves. */
function avaliar(
  lista: readonly unknown[],
  variantesIds: readonly string[],
  seed: SeedVinculadorLi | null,
): ConflitoLinkLi[] {
  const doGrupo = new Set(variantesIds);
  // Without a seed nothing can be said to be removed BY THIS save; the stale ids
  // are still caught, as `varianteInexistente` on entries that all count as edited.
  const removidas =
    seed === null ? [] : idsDasVariantesLi(seed.variacoes).filter((id) => !doGrupo.has(id));
  return conflitosLinksVariacoesLi({
    variantesIds,
    variantesRemovidasNestaGravacao: removidas,
    entradas: lerLinksVariacoesLi(lista).entradas,
    editadas: editadasPorValorLi(lista, seed),
  });
}

/** The operator's copy of one finding (pt-BR). `nomeDaVariante` labels a variante id. */
export function mensagemDoConflitoLi(
  conflito: ConflitoLinkLi,
  nomeDaVariante: (id: string) => string,
): string {
  const variante = `"${nomeDaVariante(conflito.varianteId ?? '')}"`;
  switch (conflito.tipo) {
    case TIPO_CONFLITO_LINK_LI.entradaInvalida:
      return (
        'um vínculo está incompleto ou inválido' +
        (conflito.campos.length === 0 ? '' : ` (campos: ${conflito.campos.join(', ')})`)
      );
    case TIPO_CONFLITO_LINK_LI.gradeRepetidaNaConta:
      return `a grade #${String(conflito.gradeId)} aparece em mais de um vínculo desta loja`;
    case TIPO_CONFLITO_LINK_LI.opcaoRepetidaNoVinculo:
      return `a opção #${String(conflito.opcaoId)} aparece duas vezes no mesmo vínculo`;
    case TIPO_CONFLITO_LINK_LI.varianteEmDuasOpcoes:
      return (
        `a variante ${variante} está em mais de uma opção desta loja; cada variante aponta ` +
        'para uma só opção por loja'
      );
    case TIPO_CONFLITO_LINK_LI.varianteRemovidaVinculada:
      return `a variante ${variante} está vinculada à Loja Integrada; desvincule-a antes de excluir`;
    case TIPO_CONFLITO_LINK_LI.varianteInexistente:
      return `a variante ${variante} não existe mais neste grupo; desvincule-a`;
    case TIPO_CONFLITO_LINK_LI.opcaoComVariasVariantes:
      return (
        'duas variantes usam a mesma opção; um produto que tenha as duas não poderá ser ' +
        'enviado'
      );
  }
}

/**
 * The page's `validate` body: the issues that BLOCK this save. Runs on the
 * PREPARED values (`ObjectView` applies every `prepareForSave` first), so
 * `linksVariacoesli` is the list about to be written.
 *
 * A finding blocks only through an edited entry, or because this save removes a
 * variante an entry still names — that one sits under `variacoes`, where
 * the removal happened. One issue per field, every message joined.
 */
export function validarVinculosLi(
  values: Readonly<Record<string, unknown>>,
  seed: SeedVinculadorLi | null,
): ValidationIssue[] {
  const valor = values.linksVariacoesli;
  // Not a list: the schema's own error speaks for it.
  if (!Array.isArray(valor)) return [];
  const lista: readonly unknown[] = valor;
  if (lista.length === 0) return [];
  const nomes = nomesDasVariantesLi(values.variacoes, seed?.variacoes);
  const nome = (id: string) => nomes.get(id) ?? id;
  const doVinculo: string[] = [];
  const dasVariantes: string[] = [];
  for (const conflito of avaliar(lista, idsDasVariantesLi(values.variacoes), seed)) {
    if (!conflito.bloqueia) continue;
    const mensagem = mensagemDoConflitoLi(conflito, nome);
    if (conflito.tipo === TIPO_CONFLITO_LINK_LI.varianteRemovidaVinculada)
      dasVariantes.push(mensagem);
    else doVinculo.push(mensagem);
  }
  const issues: ValidationIssue[] = [];
  if (doVinculo.length > 0) {
    issues.push({
      path: 'linksVariacoesli',
      message: `Vínculos da Loja Integrada: ${doVinculo.join('; ')}.`,
    });
  }
  if (dasVariantes.length > 0) issues.push({ path: 'variacoes', message: dasVariantes.join('; ') });
  return issues;
}

/**
 * The tab's findings over the form's CURRENT value: the same rules as the save,
 * on what the save would write, with the indices mapped back to the form's
 * value. `variacoesVivas` is the form's live `variacoes` (a variante staged for
 * deletion already counts as removed).
 */
export function achadosDoVinculadorLi(
  valor: unknown,
  variacoesVivas: unknown,
  seed: SeedVinculadorLi | null,
): ConflitoLinkLi[] {
  const { lista, origem } = prepararVinculosLiComOrigem(valor);
  return avaliar(lista, idsDasVariantesLi(variacoesVivas), seed).map((c) => ({
    ...c,
    indices: c.indices.map((i) => origem[i] ?? i),
  }));
}

/** One element of the form's value, as the tab shows it. */
export interface ItemVinculoLi {
  /** Its index in the form's value. */
  readonly indice: number;
  /** The element itself, marks included. */
  readonly bruto: unknown;
  /** The reader's view of the element as it would be stored. */
  readonly entrada: EntradaLinkVariacoesLi;
  readonly removida: boolean;
  readonly conflito: ConflitoVinculoLi | null;
}

export interface GruposVinculadorLi {
  /** The valid entries of each ACTIVE conta, keyed by the conta id exactly. */
  readonly porConta: ReadonlyMap<string, readonly ItemVinculoLi[]>;
  /** Everything else: another or unknown conta, and every invalid entry. */
  readonly outras: readonly ItemVinculoLi[];
  /** A value is stored and it is not a list. */
  readonly formatoInvalido: boolean;
}

/**
 * Split the form's value for the tab. A conta is matched by EXACT equality of
 * `integracaoLiId` with an active conta's doc id — a path, another case or a
 * trailing space is "conta não reconhecida", never folded in. Nothing is dropped.
 */
export function agruparVinculosLi(
  valor: unknown,
  contasAtivas: ReadonlySet<string>,
): GruposVinculadorLi {
  const porConta = new Map<string, ItemVinculoLi[]>();
  const outras: ItemVinculoLi[] = [];
  if (!Array.isArray(valor)) {
    return { porConta, outras, formatoInvalido: valor !== null && valor !== undefined };
  }
  const elementos: readonly unknown[] = valor;
  const leitura = lerLinksVariacoesLi(elementos.map(normalizarEntradaLi));
  for (const entrada of leitura.entradas) {
    const bruto = elementos[entrada.indice];
    const item: ItemVinculoLi = {
      indice: entrada.indice,
      bruto,
      entrada,
      removida: removidaNoFormularioLi(bruto),
      conflito: marcaDeConflitoLi(bruto),
    };
    const conta = entrada.tipo === TIPO_ENTRADA_LINK_LI.valida ? entrada.link.integracaoLiId : null;
    if (conta !== null && contasAtivas.has(conta)) {
      const doGrupo = porConta.get(conta) ?? [];
      doGrupo.push(item);
      porConta.set(conta, doGrupo);
    } else {
      outras.push(item);
    }
  }
  return { porConta, outras, formatoInvalido: false };
}

/** A store option, as the tab offers it. */
export interface OpcaoDoVinculadorLi {
  readonly id: number;
  /** The store's `nome` (or the stored label); `null` when neither is known. */
  readonly nome: string | null;
}

/**
 * The entry with `opcao` now holding exactly `variantes` — a NEW object, the
 * input untouched, every other key and option kept as stored. An option left
 * with no variante is DROPPED here, as it is edited (never by the save). An edit
 * redoes a link a conflict marked, so the mark goes.
 */
export function definirVariantesDaOpcaoLi(
  entrada: unknown,
  opcao: OpcaoDoVinculadorLi,
  variantes: readonly string[],
): Registro {
  const base = normalizarEntradaLi(entrada);
  const registro: Registro = ehObjeto(base) ? { ...base } : {};
  const valorOpcoes = proprio(registro, 'variationOptions');
  const opcoes: readonly unknown[] = Array.isArray(valorOpcoes) ? valorOpcoes : [];
  const novas: unknown[] = [];
  let encontrada = false;
  for (const o of opcoes) {
    if (!encontrada && ehObjeto(o) && proprio(o, 'li_option_id') === opcao.id) {
      encontrada = true;
      if (variantes.length > 0) novas.push({ ...o, arakene_variation_id: [...variantes] });
      continue;
    }
    novas.push(o);
  }
  if (!encontrada && variantes.length > 0) {
    novas.push({
      li_option_id: opcao.id,
      li_option_name: opcao.nome,
      arakene_variation_id: [...variantes],
    });
  }
  registro.variationOptions = novas;
  return registro;
}

/** Stage the element at `indice` for removal, or undo it: a NEW list. */
export const alternarRemocaoLi = nucleo.alternarRemocao;

/** The element at `indice` replaced by `nova`: a NEW list. */
export const substituirEntradaLi = nucleo.substituirEntrada;

/**
 * A new link of `contaId` (stored verbatim) to `grade`, with no option yet. The
 * grade's `nome` is its label — never `nome_visivel`.
 */
export function novoVinculoLi(contaId: string, grade: { id: number; nome: string }): Registro {
  return { name: grade.nome, grade_id: grade.id, integracaoLiId: contaId, variationOptions: [] };
}

/**
 * The field's `rebaseOnConflict` merge (ADR 0011 tier 3), keyed by
 * `(integracaoLiId, grade_id)`: `NucleoDeVinculos.rebasePorChave` states the rules.
 */
export const rebaseVinculosLi = nucleo.rebasePorChave;
