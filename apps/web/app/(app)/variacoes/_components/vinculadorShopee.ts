/**
 * The Shopee variation linker's pure rules (#1911 P14): what the tab edits in
 * `grupoDeVariacoes.linksVariacoesShopee`, what a save of the grupo checks, and
 * how a conflicting save merges. No React, no clock, no I/O.
 *
 * The staging marks, "edited or untouched" and the merge are the shared machinery
 * in `vinculosDeCanal.ts` (its header states the rules); this module names
 * Shopee's mark and key, and adds the channel's own reading of an entry.
 *
 * ## The key and its fold (`chaveDaEntradaShopee`, `resolverEntradaShopeeDoGrupo`)
 *
 * An entry belongs to a (conta, LEAF category) pair, read through the SHARED key
 * the publisher and the import read, so the tab cannot group an entry under one
 * conta while the publisher binds it to another. What that fold treats as equal:
 * `documents/integracao/int-1`, `integracao/int-1`, `int-1/` and `int-1` are ONE
 * conta. What stays distinct: `int-12` and `int-1`, another case (`Int-1`), any
 * whitespace (` int-1`), and a category stored as the string `'100352'`, which
 * names nothing. An element the schema refuses still names its key.
 *
 * ## Identity of an option: the id; a custom option: its byte-exact name
 *
 * A standard row is matched by `shopee_option_id` whatever the name says, so two
 * options Shopee names alike are two rows. A custom row (`id 0`) has only its
 * name, and a row is matched by it byte-exact: this module never lowers a name or
 * compares one loosely to pick a row. A STANDARD name and any STORED row reach
 * storage verbatim (`' Azul '` stays so). A NEW custom row stores the variante's
 * name ends-trimmed through `nomeDeTierShopee` (#1911 P14b), the fold the
 * publisher sends a custom option with and the import reads it back with, so the
 * import's byte-exact merge finds the row instead of adding a twin. Display copy
 * trims too; nothing decides on it.
 *
 * ## The one fold that decides something: a staged removal's warning
 *
 * `avisosDaRemocaoShopee` predicts what the publisher does once a staged entry is
 * gone, so it compares names exactly as the publisher pairs them: both sides
 * through `nomeDeTierShopee` (the ends trimmed; case and inner whitespace kept).
 * It decides only whether a warning shows; nothing is written from it.
 *
 * ## What never leaves
 *
 * A stored option id the current tree lacks stays: a published listing may be
 * using it, and it is a warning, never a refusal or a drop. A row stored empty
 * stays; only a row THIS edit emptied is dropped. An unreadable element is carried
 * back as it is until the operator stages its removal.
 *
 * ## What blocks
 *
 * A blocking finding blocks only through an entry this save creates or changes,
 * so a stored defect never stops renaming the grupo. The exception is not ours: an
 * unreadable element fails the field's strict schema on every save of the grupo,
 * and the tab makes it visible and removable.
 *
 * ## Rule 7
 *
 * Two writers: this page (ObjectView's dirty key in the grupo's guarded save, tier
 * 3) and the product import (tier 1, one re-plan). The operator losing gets the
 * conflict modal and {@link rebaseVinculosShopee}, except in ObjectView's documented
 * fail-open (above its create-mode effect): an edit made while the form still shows
 * a cache paint, before server truth arrives, saves with no baseline, so the array
 * written whole from the cached copy can drop an entry the import appended since,
 * with no modal; the next import run re-adds a binding the live listing still uses.
 * The import re-adds a live binding the operator removed; that is documented on the
 * tab, not prevented. One more residual, until ObjectView re-seeds the untouched
 * fields on «Salvar mesmo assim»: after it, the tab keeps the `variacoes` it loaded,
 * so a variante the import created in the same write reads as `variante-inexistente`
 * until the page is reloaded (the merge itself keeps the import's entry).
 */
import {
  camposRecusados,
  chaveDaEntradaShopee,
  descreverFaixaShopee,
  linkVariacoesShopeeSchema,
  nomeDeTierShopee,
  resolverEntradaShopeeDoGrupo,
  textoNaFaixaShopee,
  type FaixaDto,
  type LinkVariacaoOpcaoShopee,
  type LinkVariacoesShopee,
} from '@delfrance/schemas';
import type { ValidationIssue } from '@delfrance/ui';

import {
  CONFLITO_VINCULO,
  criarNucleoDeVinculos,
  ehObjeto,
  idsDasVariantes,
  nomesDasVariantes,
  proprio,
  valorAposEsvaziar,
  type ConflitoVinculo,
  type Registro,
  type SeedDeVinculos,
} from './vinculosDeCanal';

/** The transient key a conflict merge sets on an entry (`vinculosDeCanal.ts`). */
export const MARCA_CONFLITO_VINCULO_SHOPEE = '_conflitoVinculoShopee';

export const CONFLITO_VINCULO_SHOPEE = CONFLITO_VINCULO;
export type ConflitoVinculoShopee = ConflitoVinculo;

/** Where a staged non-object element waits; a save drops the wrapper. */
const VALOR_ILEGIVEL_SHOPEE = '_valorIlegivelShopee';

function chaveDoRegistro(entrada: Registro): string | null {
  const chave = chaveDaEntradaShopee(entrada);
  return chave === null ? null : JSON.stringify(chave);
}

const nucleo = criarNucleoDeVinculos({
  marcaConflito: MARCA_CONFLITO_VINCULO_SHOPEE,
  chaveValorIlegivel: VALOR_ILEGIVEL_SHOPEE,
  chaveDe: chaveDoRegistro,
});

/** Whether the operator staged this entry for removal. */
export const removidaNoFormularioShopee = nucleo.removidaNoFormulario;

/** The conflict merge's note on an entry, or `null`. */
export const marcaDeConflitoShopee = nucleo.marcaDeConflito;

/** The entry as it would be STORED: marks stripped, a wrapped element unwrapped. */
export const normalizarEntradaShopee = nucleo.normalizarEntrada;

/** {@link prepararVinculosShopee} plus, for each written entry, its index in the form's value. */
export const prepararVinculosShopeeComOrigem = nucleo.prepararComOrigem;

/**
 * The field's `prepareForSave`: drops staged and `removido` entries, strips every
 * mark. An untouched entry, unreadable or not, is written back as the same value.
 */
export const prepararVinculosShopee = nucleo.preparar;

/** The indices of a WRITTEN list this save creates or changes, by value against the seed. */
export const editadasPorValorShopee = nucleo.editadasPorValor;

/** Stage the element at `indice` for removal, or undo it: a NEW list. */
export const alternarRemocaoShopee = nucleo.alternarRemocao;

/** The element at `indice` replaced by `nova`: a NEW list. */
export const substituirEntradaShopee = nucleo.substituirEntrada;

/**
 * The field's `rebaseOnConflict` merge (ADR 0011 tier 3), keyed by
 * {@link chaveDoVinculoShopee}: `NucleoDeVinculos.rebasePorChave` states the rules.
 */
export const rebaseVinculosShopee = nucleo.rebasePorChave;

/** The (conta, category) key of an element as a string, or `null`. Marks do not count. */
export function chaveDoVinculoShopee(entrada: unknown): string | null {
  const armazenada = normalizarEntradaShopee(entrada);
  return ehObjeto(armazenada) ? chaveDoRegistro(armazenada) : null;
}

/**
 * The form's seed for the linker: the values its two fields were last reset to.
 * Published by the tab; `null` (never published) fails closed everywhere.
 */
export type SeedVinculadorShopee = SeedDeVinculos;

/* -------------------------------------------------------------------------- */
/*                            What a stored entry is                           */
/* -------------------------------------------------------------------------- */

export const TIPO_ITEM_VINCULO_SHOPEE = {
  /** A readable standard entry (`variation_id !== 0`): a card. */
  padrao: 'padrao',
  /** A readable custom entry (`variation_id: 0`, import-written): read-only rows. */
  personalizada: 'personalizada',
  /** An element the strict schema refuses, or not an object at all. */
  ilegivel: 'ilegivel',
} as const;

interface BaseDoItemVinculoShopee {
  /** Its index in the form's value. */
  readonly indice: number;
  /** The element itself, marks included. */
  readonly bruto: unknown;
  /** The shared key it names, read off the stored shape; `null` when it names none. */
  readonly chave: ReturnType<typeof chaveDaEntradaShopee>;
  readonly removida: boolean;
  readonly conflito: ConflitoVinculoShopee | null;
}

export type ItemVinculoShopee = BaseDoItemVinculoShopee &
  (
    | {
        readonly tipo:
          | typeof TIPO_ITEM_VINCULO_SHOPEE.padrao
          | typeof TIPO_ITEM_VINCULO_SHOPEE.personalizada;
        /** The parsed entry, marks gone. */
        readonly link: LinkVariacoesShopee;
        /**
         * Another element of the same key comes first in what this save would write,
         * so the publisher never reads this one («Não lido pela publicação»).
         */
        readonly gemea: boolean;
      }
    | {
        readonly tipo: typeof TIPO_ITEM_VINCULO_SHOPEE.ilegivel;
        /**
         * The refused fields as dotted paths, through the resolver's own
         * `camposRecusados`. Diagnostic text: no decision reads it.
         */
        readonly campos: readonly string[];
      }
  );

export interface GruposVinculadorShopee {
  /** Every element whose key names an ACTIVE conta, unreadable ones included. */
  readonly porConta: ReadonlyMap<string, readonly ItemVinculoShopee[]>;
  /** Everything else: an inactive or unknown conta, and an element that names none. */
  readonly outras: readonly ItemVinculoShopee[];
  /** A value is stored and it is not a list. */
  readonly formatoInvalido: boolean;
}

/**
 * Split the form's value for the tab through the SHARED key (see the module
 * header): a path-form conta id groups under the conta it names, `int-12` never
 * under `int-1`. Nothing is dropped. `contasAtivas` holds bare doc ids.
 */
export function agruparVinculosShopee(
  valor: unknown,
  contasAtivas: ReadonlySet<string>,
): GruposVinculadorShopee {
  const porConta = new Map<string, ItemVinculoShopee[]>();
  const outras: ItemVinculoShopee[] = [];
  if (!Array.isArray(valor)) {
    return { porConta, outras, formatoInvalido: valor !== null && valor !== undefined };
  }
  const elementos: readonly unknown[] = valor;
  const { lista, origem } = prepararVinculosShopeeComOrigem(elementos);
  elementos.forEach((bruto, indice) => {
    const armazenada = normalizarEntradaShopee(bruto);
    const chave = ehObjeto(armazenada) ? chaveDaEntradaShopee(armazenada) : null;
    const base: BaseDoItemVinculoShopee = {
      indice,
      bruto,
      chave,
      removida: removidaNoFormularioShopee(bruto),
      conflito: marcaDeConflitoShopee(bruto),
    };
    const lido = linkVariacoesShopeeSchema.safeParse(armazenada);
    let item: ItemVinculoShopee;
    if (lido.success) {
      // Only what this save writes competes: a first twin staged for removal
      // promotes the next one, exactly as the publisher will read the list.
      let gemea = false;
      if (chave !== null && origem.includes(indice)) {
        const lida = resolverEntradaShopeeDoGrupo(lista, chave.integracaoId, chave.categoryId);
        gemea = lida.tipo === 'armazenada' && origem[lida.indice] !== indice;
      }
      item = {
        ...base,
        tipo:
          lido.data.variation_id === 0
            ? TIPO_ITEM_VINCULO_SHOPEE.personalizada
            : TIPO_ITEM_VINCULO_SHOPEE.padrao,
        link: lido.data,
        gemea,
      };
    } else {
      item = {
        ...base,
        tipo: TIPO_ITEM_VINCULO_SHOPEE.ilegivel,
        campos: camposRecusados(lido.error),
      };
    }
    if (chave !== null && contasAtivas.has(chave.integracaoId)) {
      const daConta = porConta.get(chave.integracaoId) ?? [];
      daConta.push(item);
      porConta.set(chave.integracaoId, daConta);
    } else {
      outras.push(item);
    }
  });
  return { porConta, outras, formatoInvalido: false };
}

/**
 * Whether «Adicionar vínculo» may add this (conta, category): `vinculada` when a
 * readable element would be read for it, `ilegivel` when only a refused one names
 * it, `livre` otherwise. Over what this save would write, so a staged removal frees
 * the key for its replacement.
 */
export function situacaoDaChaveShopee(
  valor: unknown,
  integracaoId: string,
  categoryId: number,
): 'livre' | 'vinculada' | 'ilegivel' {
  const { lista } = prepararVinculosShopeeComOrigem(valor);
  const lida = resolverEntradaShopeeDoGrupo(lista, integracaoId, categoryId);
  if (lida.tipo === 'armazenada') return 'vinculada';
  return lida.tipo === 'ilegivel' ? 'ilegivel' : 'livre';
}

/* -------------------------------------------------------------------------- */
/*                                  The edits                                  */
/* -------------------------------------------------------------------------- */

/** What the operator picked for one variante of an entry. */
export type EscolhaDaVarianteShopee =
  | { readonly tipo: 'nenhuma' }
  /** An option of the tree or a stored row: `nome` is Shopee's string, verbatim. */
  | { readonly tipo: 'padrao'; readonly optionId: number; readonly nome: string }
  /**
   * A custom row: `nome` is a stored row's, verbatim, or a NEW row's — the
   * variante's name ends-trimmed ({@link escolhaPersonalizadaDaVarianteShopee}).
   */
  | { readonly tipo: 'personalizada'; readonly nome: string };

/** Which stored rows hold a variante now; the `Select`'s current value derives from it. */
export type EscolhaAtualDaVarianteShopee =
  | { readonly tipo: 'nenhuma' }
  | { readonly tipo: 'uma'; readonly linha: LinkVariacaoOpcaoShopee }
  /** Two or more: the `Select` shows no value and the finding says so. */
  | { readonly tipo: 'varias'; readonly linhas: readonly LinkVariacaoOpcaoShopee[] };

/** The rows of a parsed entry that hold `varianteId`, read by exact id. */
export function escolhaAtualDaVariante(
  link: Pick<LinkVariacoesShopee, 'variationOptions'>,
  varianteId: string,
): EscolhaAtualDaVarianteShopee {
  const linhas = link.variationOptions.filter((o) => o.arakene_variation_id.includes(varianteId));
  const [primeira] = linhas;
  if (primeira === undefined) return { tipo: 'nenhuma' };
  return linhas.length === 1 ? { tipo: 'uma', linha: primeira } : { tipo: 'varias', linhas };
}

/**
 * The `Select` value of a stored row: its id, or a custom row's byte-exact name
 * under a prefix, since several custom rows all carry id `0` and Mantine throws on
 * a repeated value.
 */
export function valorDaLinhaShopee(
  linha: Pick<LinkVariacaoOpcaoShopee, 'shopee_option_id' | 'shopee_option_name'>,
): string {
  return linha.shopee_option_id === 0
    ? `personalizada:${linha.shopee_option_name}`
    : String(linha.shopee_option_id);
}

/** The choice that re-selects a stored row: its name verbatim, never re-spelled. */
export function escolhaDaLinhaShopee(
  linha: Pick<LinkVariacaoOpcaoShopee, 'shopee_option_id' | 'shopee_option_name'>,
): EscolhaDaVarianteShopee {
  return linha.shopee_option_id === 0
    ? { tipo: 'personalizada', nome: linha.shopee_option_name }
    : { tipo: 'padrao', optionId: linha.shopee_option_id, nome: linha.shopee_option_name };
}

/**
 * The choice «Personalizada» offers a variante (#1911 P14b, P14 Q1): its name through
 * `nomeDeTierShopee` — the fold the publisher sends a custom option with and the
 * import reads it back with — so a NEW custom row stores the string Shopee will hold
 * and the import's byte-exact merge finds it (no twin). Case and inner whitespace stay
 * as typed. `null` when nothing is left (the item is offered disabled). A STORED row is
 * never re-spelled: {@link escolhaDaLinhaShopee} keeps its name verbatim.
 */
export function escolhaPersonalizadaDaVarianteShopee(
  nome: string,
): Extract<EscolhaDaVarianteShopee, { readonly tipo: 'personalizada' }> | null {
  const aparado = nomeDeTierShopee(nome);
  return aparado === '' ? null : { tipo: 'personalizada', nome: aparado };
}

/** A row is the choice: the same non-zero id, or id `0` and the byte-exact name. */
function linhaEhDaEscolha(linha: Registro, escolha: EscolhaDaVarianteShopee): boolean {
  if (escolha.tipo === 'nenhuma') return false;
  const id = escolha.tipo === 'padrao' ? escolha.optionId : 0;
  if (proprio(linha, 'shopee_option_id') !== id) return false;
  return id !== 0 || proprio(linha, 'shopee_option_name') === escolha.nome;
}

/**
 * Put `varianteId` on the row of `escolha`, and off every other row. The rebuild
 * rule, in order:
 *
 *  1. A row is the choice's by {@link linhaEhDaEscolha}. Only the FIRST such row
 *     takes the variante: a row stored twice would otherwise keep it in two rows,
 *     the very finding the operator came to clear.
 *  2. That row gets the variante appended when absent; every other row loses it.
 *  3. No row is the choice's and it is not `nenhuma` ⇒ a new row, the choice's name
 *     as it came (a custom choice is already trimmed by
 *     {@link escolhaPersonalizadaDaVarianteShopee}; nothing is trimmed here).
 *  4. A row THIS call emptied is dropped; a row stored empty stays.
 *  5. Nothing changed ⇒ the SAME object, marks included, so re-choosing the current
 *     option is not an edit. A change is one: the conflict note goes with the rest.
 *
 * Every other key and row stays as stored, a row the current tree lacks included.
 */
export function definirOpcaoDaVarianteShopee(
  entrada: unknown,
  varianteId: string,
  escolha: EscolhaDaVarianteShopee,
): unknown {
  const armazenada = normalizarEntradaShopee(entrada);
  const registro: Registro = ehObjeto(armazenada) ? armazenada : {};
  const valorOpcoes = proprio(registro, 'variationOptions');
  const opcoes: readonly unknown[] = Array.isArray(valorOpcoes) ? valorOpcoes : [];
  const novas: unknown[] = [];
  let mudou = false;
  let casou = false;
  for (const linha of opcoes) {
    if (!ehObjeto(linha)) {
      novas.push(linha);
      continue;
    }
    const valorIds = proprio(linha, 'arakene_variation_id');
    const ids: readonly unknown[] = Array.isArray(valorIds) ? valorIds : [];
    const tem = ids.includes(varianteId);
    if (!casou && linhaEhDaEscolha(linha, escolha)) {
      casou = true;
      if (tem) {
        novas.push(linha);
      } else {
        mudou = true;
        novas.push({ ...linha, arakene_variation_id: [...ids, varianteId] });
      }
      continue;
    }
    if (!tem) {
      novas.push(linha);
      continue;
    }
    mudou = true;
    const restantes = ids.filter((id) => id !== varianteId);
    if (restantes.length > 0) novas.push({ ...linha, arakene_variation_id: restantes });
  }
  if (!casou && escolha.tipo !== 'nenhuma') {
    mudou = true;
    novas.push({
      shopee_option_id: escolha.tipo === 'padrao' ? escolha.optionId : 0,
      shopee_option_name: escolha.nome,
      arakene_variation_id: [varianteId],
    });
  }
  return mudou ? { ...registro, variationOptions: novas } : entrada;
}

/**
 * A new entry of the BARE conta doc id (the schema's trap 2) for a leaf category,
 * with no option yet, parsed before it enters the form. `categoria.rotulo` is the
 * browser's `rotuloCategoriaShopee(categoria)`; `grupoId` is `0` for the
 * single-level sentinel, else the group the operator chose.
 *
 * @throws {ZodError} only on values the taxonomy DTOs already exclude.
 */
export function novoVinculoShopee(
  contaId: string,
  categoria: { readonly categoryId: number; readonly rotulo: string },
  variationId: number,
  grupoId: number,
): LinkVariacoesShopee {
  return linkVariacoesShopeeSchema.parse({
    name: categoria.rotulo,
    category_id: categoria.categoryId,
    variation_id: variationId,
    variation_group_list: grupoId,
    integracaoShopeeId: contaId,
    variationOptions: [],
  });
}

/**
 * Record the group on a stored entry whose group is `0` — the one exception to a
 * stored entry's variation and group being read-only. A stored non-zero group is
 * never overwritten, and neither case is an edit (the SAME object comes back).
 */
export function definirGrupoDoVinculoShopee(entrada: unknown, grupoId: number): unknown {
  const armazenada = normalizarEntradaShopee(entrada);
  if (!ehObjeto(armazenada) || grupoId === 0) return entrada;
  if (proprio(armazenada, 'variation_group_list') !== 0) return entrada;
  return { ...armazenada, variation_group_list: grupoId };
}

/**
 * Whether «Remover vínculo» on the element at `indice` deletes it outright: it is
 * NEW (unsaved and not staged), the SURPLUS of its key beyond what the form's seed
 * holds. The seed's count of that key are stored entries, and the
 * modal only appends, so the elements of the key past that count (in list order)
 * are the ones this form added — an entry added after staging the stored one of
 * the same key («Para trocar a variação, remova este vínculo e adicione outro»)
 * included. A staged element still counts as one of its key. Everything else is
 * staged (`apps/web` rule 7), an edited stored entry and a key-less element too.
 */
export function ehVinculoNovoShopee(
  lista: readonly unknown[],
  indice: number,
  seedLinks: unknown,
): boolean {
  const entrada = lista[indice];
  if (removidaNoFormularioShopee(entrada)) return false;
  const chave = chaveDoVinculoShopee(entrada);
  if (chave === null) return false;
  const guardados: readonly unknown[] = Array.isArray(seedLinks) ? seedLinks : [];
  const noSeed = guardados.filter((g) => chaveDoVinculoShopee(g) === chave).length;
  const antes = lista.slice(0, indice).filter((e) => chaveDoVinculoShopee(e) === chave).length;
  return antes >= noSeed;
}

/**
 * The stored entry a card stands for: the first readable, unmarked element of the
 * form's seed with the same key AND the same `variation_id`, else `null` (a new
 * entry, or a replacement of another variation under the same key). Its rows stay
 * offered in the card's `Select`s, so a stored option the current tree lacks can be
 * chosen again after an edit took it off its last variante (the rebuild drops a row
 * THIS edit emptied). Nothing is written until a pick.
 */
export function linkDoSeedShopee(seedLinks: unknown, entrada: unknown): LinkVariacoesShopee | null {
  if (!Array.isArray(seedLinks)) return null;
  const chave = chaveDoVinculoShopee(entrada);
  if (chave === null) return null;
  const armazenada = normalizarEntradaShopee(entrada);
  const variationId = ehObjeto(armazenada) ? proprio(armazenada, 'variation_id') : undefined;
  for (const guardado of seedLinks as readonly unknown[]) {
    if (removidaNoFormularioShopee(guardado)) continue;
    if (chaveDoVinculoShopee(guardado) !== chave) continue;
    const lido = linkVariacoesShopeeSchema.safeParse(normalizarEntradaShopee(guardado));
    if (lido.success && lido.data.variation_id === variationId) return lido.data;
  }
  return null;
}

/**
 * The field's next value after «Remover vínculo» or «Desfazer remoção» on the
 * element at `indice`: a new entry leaves the list (and an emptied list goes back
 * to the seed, `valorAposEsvaziar`, #1787); anything else toggles its staged mark.
 */
export function removerVinculoShopee(
  lista: readonly unknown[],
  indice: number,
  seedLinks: unknown,
): unknown {
  if (!ehVinculoNovoShopee(lista, indice, seedLinks)) return alternarRemocaoShopee(lista, indice);
  return valorAposEsvaziar(
    lista.filter((_, i) => i !== indice),
    seedLinks,
  );
}

/* -------------------------------------------------------------------------- */
/*                   What a staged removal changes in a publish                */
/* -------------------------------------------------------------------------- */

export const TIPO_AVISO_REMOCAO_SHOPEE = {
  /** A custom entry's live option will be re-appended under a variante's name (P14 Q2). */
  opcaoAcrescentada: 'opcao-acrescentada',
  /** A listing of this standard variation will be refused on republish (P14 Q3b). */
  variacaoRecusada: 'variacao-recusada',
} as const;

/** One warning on a staged removal; names are folded through `nomeDeTierShopee`. */
export type AvisoDeRemocaoShopee =
  | {
      readonly tipo: typeof TIPO_AVISO_REMOCAO_SHOPEE.opcaoAcrescentada;
      readonly variante: string;
      readonly opcao: string;
    }
  | {
      readonly tipo: typeof TIPO_AVISO_REMOCAO_SHOPEE.variacaoRecusada;
      readonly variationId: number;
    };

/**
 * What the publisher does differently once the STAGED element at `indice` is gone
 * (#1911 P14b, P14 Q2 and Q3b). Form only: no read, so it says what a published
 * listing in this (conta, category) WOULD meet, never whether one exists.
 *
 *  1. Nothing unless the element is staged, readable and names a key.
 *  2. Nothing unless it is the element the publisher reads for that key today: a twin
 *     behind another one was never read, so dropping it changes nothing.
 *  3. A STANDARD entry: a warning unless what this save writes still answers the key
 *     with an entry of the SAME `variation_id` (a later twin of it). Anything else — no
 *     entry, another variation, an unreadable one — refuses a listing that uses it.
 *  4. A CUSTOM entry: only when nothing answers the key afterwards (the publisher falls
 *     back to the implicit custom tier, which pairs live options with variantes BY
 *     NAME). For each id-`0` row, each variante of the grupo it binds whose folded name
 *     is not the name of ANY id-`0` row of this entry (that variante re-pairs a live
 *     option by name, so nothing is appended) is appended as a new option and takes
 *     the model, leaving the row's option without one. A nameless variante is refused
 *     by the publisher (it moves nothing); a variante the grupo no longer offers is
 *     never published. One warning per distinct (variante, opção) pair.
 *
 * `variantes` is the form's live list (`id`, `nome` verbatim); names are compared
 * through `nomeDeTierShopee` on both sides, exactly as the publisher pairs them: the
 * ends fold, case and inner whitespace do not. See the module header.
 */
export function avisosDaRemocaoShopee(
  valor: unknown,
  indice: number,
  variantes: readonly { readonly id: string; readonly nome: string }[],
): AvisoDeRemocaoShopee[] {
  if (!Array.isArray(valor)) return [];
  const lista: readonly unknown[] = valor;
  const bruto = lista[indice];
  if (!removidaNoFormularioShopee(bruto)) return [];
  const lido = linkVariacoesShopeeSchema.safeParse(normalizarEntradaShopee(bruto));
  if (!lido.success) return [];
  const link = lido.data;
  const chave = chaveDaEntradaShopee(link);
  if (chave === null) return [];

  const antes = prepararVinculosShopeeComOrigem(alternarRemocaoShopee(lista, indice));
  const lidaAntes = resolverEntradaShopeeDoGrupo(antes.lista, chave.integracaoId, chave.categoryId);
  if (lidaAntes.tipo !== 'armazenada' || antes.origem[lidaAntes.indice] !== indice) return [];
  const depois = resolverEntradaShopeeDoGrupo(
    prepararVinculosShopeeComOrigem(lista).lista,
    chave.integracaoId,
    chave.categoryId,
  );

  if (link.variation_id !== 0) {
    const mesmaVariacao =
      depois.tipo === 'armazenada' && depois.entrada.variation_id === link.variation_id;
    return mesmaVariacao
      ? []
      : [{ tipo: TIPO_AVISO_REMOCAO_SHOPEE.variacaoRecusada, variationId: link.variation_id }];
  }
  if (depois.tipo !== 'personalizada-implicita') return [];

  const nomesDasVariantesDoGrupo = new Map<string, string>();
  for (const v of variantes) {
    if (!nomesDasVariantesDoGrupo.has(v.id))
      nomesDasVariantesDoGrupo.set(v.id, nomeDeTierShopee(v.nome));
  }
  // The import's record of the live custom options. It holds this row's own option
  // too, so "the variante re-pairs the option it is on" is the same test.
  const vivas = new Set(
    link.variationOptions
      .filter((o) => o.shopee_option_id === 0)
      .map((o) => nomeDeTierShopee(o.shopee_option_name)),
  );
  const avisos: AvisoDeRemocaoShopee[] = [];
  const vistos = new Set<string>();
  for (const linha of link.variationOptions) {
    if (linha.shopee_option_id !== 0) continue;
    const opcao = nomeDeTierShopee(linha.shopee_option_name);
    if (opcao === '') continue;
    for (const id of linha.arakene_variation_id) {
      const variante = nomesDasVariantesDoGrupo.get(id);
      if (variante === undefined || variante === '' || vivas.has(variante)) continue;
      const par = JSON.stringify([variante, opcao]);
      if (vistos.has(par)) continue;
      vistos.add(par);
      avisos.push({ tipo: TIPO_AVISO_REMOCAO_SHOPEE.opcaoAcrescentada, variante, opcao });
    }
  }
  return avisos;
}

/** The card's copy of one staged-removal warning (pt-BR, decided verbatim). */
export function mensagemDoAvisoDeRemocaoShopee(aviso: AvisoDeRemocaoShopee): string {
  switch (aviso.tipo) {
    case TIPO_AVISO_REMOCAO_SHOPEE.opcaoAcrescentada:
      return (
        `Ao remover este vínculo, a próxima publicação acrescenta a opção «${aviso.variante}» ` +
        `e move o modelo para ela; «${aviso.opcao}» fica sem modelo.`
      );
    case TIPO_AVISO_REMOCAO_SHOPEE.variacaoRecusada:
      return (
        `Um anúncio publicado nesta categoria que use a variação ${String(aviso.variationId)} ` +
        'será recusado ao republicar até que este vínculo seja recriado.'
      );
  }
}

/* -------------------------------------------------------------------------- */
/*                                 The findings                                */
/* -------------------------------------------------------------------------- */

export const TIPO_ACHADO_SHOPEE = {
  chaveRepetida: 'chave-repetida',
  varianteEmDuasOpcoes: 'variante-em-duas-opcoes',
  opcaoPersonalizadaSemNome: 'opcao-personalizada-sem-nome',
  opcaoComVariasVariantes: 'opcao-com-varias-variantes',
  varianteInexistente: 'variante-inexistente',
  varianteRemovidaNestaGravacao: 'variante-removida-nesta-gravacao',
  opcaoForaDaArvore: 'opcao-fora-da-arvore',
  grupoAusente: 'grupo-ausente',
  nomeForaDaFaixa: 'nome-fora-da-faixa',
} as const;

/** One stored row, as a finding names it: the stored name, verbatim. */
export interface OpcaoDoAchadoShopee {
  readonly id: number;
  readonly nome: string;
}

/**
 * One finding, on the form's indices. `bloqueia` is `true` only through an entry
 * this save creates or changes; the warnings are `false` by their type.
 */
export type AchadoVinculoShopee = { readonly indices: readonly number[] } & (
  | {
      readonly tipo: typeof TIPO_ACHADO_SHOPEE.chaveRepetida;
      readonly bloqueia: boolean;
      readonly integracaoId: string;
      readonly categoryId: number;
    }
  | {
      readonly tipo: typeof TIPO_ACHADO_SHOPEE.varianteEmDuasOpcoes;
      readonly bloqueia: boolean;
      readonly varianteId: string;
      readonly categoryId: number;
      readonly opcoes: readonly OpcaoDoAchadoShopee[];
    }
  | {
      readonly tipo: typeof TIPO_ACHADO_SHOPEE.opcaoPersonalizadaSemNome;
      readonly bloqueia: boolean;
      readonly varianteId: string;
    }
  | {
      readonly tipo: typeof TIPO_ACHADO_SHOPEE.opcaoComVariasVariantes;
      readonly bloqueia: false;
      readonly opcao: OpcaoDoAchadoShopee;
      readonly variantes: readonly string[];
    }
  | {
      readonly tipo:
        | typeof TIPO_ACHADO_SHOPEE.varianteInexistente
        | typeof TIPO_ACHADO_SHOPEE.varianteRemovidaNestaGravacao;
      readonly bloqueia: false;
      readonly opcao: OpcaoDoAchadoShopee;
      readonly varianteId: string;
    }
  | {
      readonly tipo: typeof TIPO_ACHADO_SHOPEE.opcaoForaDaArvore;
      readonly bloqueia: false;
      readonly opcao: OpcaoDoAchadoShopee;
    }
  | { readonly tipo: typeof TIPO_ACHADO_SHOPEE.grupoAusente; readonly bloqueia: false }
  | {
      readonly tipo: typeof TIPO_ACHADO_SHOPEE.nomeForaDaFaixa;
      readonly bloqueia: false;
      readonly nome: string;
      readonly comprimento: number;
      readonly faixa: string;
    }
);

function opcaoDaLinha(linha: LinkVariacaoOpcaoShopee): OpcaoDoAchadoShopee {
  return { id: linha.shopee_option_id, nome: linha.shopee_option_name };
}

/**
 * Whether a custom option named `nome` would have no name: blank through
 * `textoNaFaixaShopee`, the publisher's own measure (only the ends are trimmed).
 * The finding `opcao-personalizada-sem-nome` reads a stored row through it, and the
 * card refuses to author such a row: a variante with no name yet offers its
 * «Personalizada» item disabled.
 */
export function nomePersonalizadoAusenteShopee(nome: string): boolean {
  return textoNaFaixaShopee(nome, null).estado === 'ausente';
}

/**
 * The rules that need no tree, over a WRITTEN list. An unreadable element yields
 * nothing: the strict schema refuses it on its own. Variantes the grupo does not
 * hold are inert for the publisher, so they count only as a warning of their own:
 * a blocking finding about one would leave the operator nothing to choose.
 */
function avaliar(
  lista: readonly unknown[],
  variantesIds: readonly string[],
  seed: SeedVinculadorShopee | null,
): AchadoVinculoShopee[] {
  const editadas = editadasPorValorShopee(lista, seed);
  const doGrupo = new Set(variantesIds);
  // Without a seed nothing can be said to be removed BY THIS save.
  const removidas = new Set(
    seed === null ? [] : idsDasVariantes(seed.variacoes).filter((id) => !doGrupo.has(id)),
  );
  const achados: AchadoVinculoShopee[] = [];
  const porChave = new Map<
    string,
    { readonly integracaoId: string; readonly categoryId: number; readonly indices: number[] }
  >();

  lista.forEach((bruto, indice) => {
    const lido = linkVariacoesShopeeSchema.safeParse(bruto);
    if (!lido.success) return;
    const link = lido.data;
    const bloqueia = editadas.has(indice);
    const chave = chaveDaEntradaShopee(link);
    if (chave !== null) {
      const k = JSON.stringify(chave);
      const doGrupoDaChave = porChave.get(k) ?? { ...chave, indices: [] };
      doGrupoDaChave.indices.push(indice);
      porChave.set(k, doGrupoDaChave);
    }

    const linhasDaVariante = new Map<string, LinkVariacaoOpcaoShopee[]>();
    for (const linha of link.variationOptions) {
      const opcao = opcaoDaLinha(linha);
      const nestaLinha = [...new Set(linha.arakene_variation_id)];
      const vivos = nestaLinha.filter((id) => doGrupo.has(id));
      for (const id of vivos) {
        const daVariante = linhasDaVariante.get(id) ?? [];
        daVariante.push(linha);
        linhasDaVariante.set(id, daVariante);
      }
      for (const id of nestaLinha) {
        if (doGrupo.has(id)) continue;
        achados.push({
          tipo: removidas.has(id)
            ? TIPO_ACHADO_SHOPEE.varianteRemovidaNestaGravacao
            : TIPO_ACHADO_SHOPEE.varianteInexistente,
          bloqueia: false,
          indices: [indice],
          opcao,
          varianteId: id,
        });
      }
      if (vivos.length >= 2) {
        achados.push({
          tipo: TIPO_ACHADO_SHOPEE.opcaoComVariasVariantes,
          bloqueia: false,
          indices: [indice],
          opcao,
          variantes: vivos,
        });
      }
      const [primeiraViva] = vivos;
      if (
        primeiraViva !== undefined &&
        linha.shopee_option_id === 0 &&
        nomePersonalizadoAusenteShopee(linha.shopee_option_name)
      ) {
        achados.push({
          tipo: TIPO_ACHADO_SHOPEE.opcaoPersonalizadaSemNome,
          bloqueia,
          indices: [indice],
          varianteId: primeiraViva,
        });
      }
    }
    for (const [varianteId, linhas] of linhasDaVariante) {
      if (linhas.length < 2) continue;
      achados.push({
        tipo: TIPO_ACHADO_SHOPEE.varianteEmDuasOpcoes,
        bloqueia,
        indices: [indice],
        varianteId,
        categoryId: link.category_id,
        opcoes: linhas.map(opcaoDaLinha),
      });
    }
  });

  for (const { integracaoId, categoryId, indices } of porChave.values()) {
    if (indices.length < 2) continue;
    achados.push({
      tipo: TIPO_ACHADO_SHOPEE.chaveRepetida,
      bloqueia: indices.some((i) => editadas.has(i)),
      indices,
      integracaoId,
      categoryId,
    });
  }
  return achados;
}

/**
 * The tab's findings that need no tree, over the form's CURRENT value: the same
 * rules as the save, on what the save would write, with the indices mapped back to
 * the form's value. `variacoesVivas` is the form's live `variacoes` (a variante
 * staged for deletion already counts as removed).
 */
export function achadosDoVinculadorShopee(
  valor: unknown,
  variacoesVivas: unknown,
  seed: SeedVinculadorShopee | null,
): AchadoVinculoShopee[] {
  const { lista, origem } = prepararVinculosShopeeComOrigem(valor);
  return avaliar(lista, idsDasVariantes(variacoesVivas), seed).map((achado) => ({
    ...achado,
    indices: achado.indices.map((i) => origem[i] ?? i),
  }));
}

/** What one card learned from Shopee; each piece is absent until its read answers. */
export interface LeituraDoCartaoShopee {
  /**
   * The option ids the current tree lists for this entry: the chosen group's, or
   * every group's while none is chosen. `null` when the tree was not read.
   */
  readonly idsDaArvore: ReadonlySet<number> | null;
  /** How many groups of this entry's variation have options. `null` when not read. */
  readonly gruposComOpcoes: number | null;
  /** `tierVariationOptionLengthLimit`; `null` or absent is no band. */
  readonly faixaDoNome: FaixaDto | null | undefined;
}

/**
 * A two-level variation with no group recorded: the option `Select`s stay disabled
 * until one is chosen. Group `0` on a variation with fewer than two option-bearing
 * groups is the single-level sentinel, and a custom entry has no group at all.
 */
export function grupoAusenteShopee(
  link: Pick<LinkVariacoesShopee, 'variation_id' | 'variation_group_list'>,
  gruposComOpcoes: number | null,
): boolean {
  return (
    link.variation_id !== 0 &&
    link.variation_group_list === 0 &&
    gruposComOpcoes !== null &&
    gruposComOpcoes >= 2
  );
}

/**
 * The findings that need a Shopee read, on one readable entry at the form's
 * `indice`. All warnings. The band applies to CUSTOM names only and measures the
 * name as the publisher sends it (`textoNaFaixaShopee` trims): a standard name is
 * Shopee's own and never checked, a row no variante holds is never sent, and a
 * blank name is `opcao-personalizada-sem-nome`'s.
 */
export function achadosDaLeituraShopee(
  link: LinkVariacoesShopee,
  indice: number,
  leitura: LeituraDoCartaoShopee,
): AchadoVinculoShopee[] {
  const achados: AchadoVinculoShopee[] = [];
  if (grupoAusenteShopee(link, leitura.gruposComOpcoes)) {
    achados.push({ tipo: TIPO_ACHADO_SHOPEE.grupoAusente, bloqueia: false, indices: [indice] });
  }
  for (const linha of link.variationOptions) {
    if (linha.shopee_option_id !== 0) {
      if (
        link.variation_id !== 0 &&
        leitura.idsDaArvore !== null &&
        !leitura.idsDaArvore.has(linha.shopee_option_id)
      ) {
        achados.push({
          tipo: TIPO_ACHADO_SHOPEE.opcaoForaDaArvore,
          bloqueia: false,
          indices: [indice],
          opcao: opcaoDaLinha(linha),
        });
      }
      continue;
    }
    if (linha.arakene_variation_id.length === 0) continue;
    const veredito = textoNaFaixaShopee(linha.shopee_option_name, leitura.faixaDoNome);
    if (veredito.estado !== 'fora-da-faixa') continue;
    achados.push({
      tipo: TIPO_ACHADO_SHOPEE.nomeForaDaFaixa,
      bloqueia: false,
      indices: [indice],
      nome: linha.shopee_option_name,
      comprimento: veredito.comprimento,
      faixa: descreverFaixaShopee(leitura.faixaDoNome),
    });
  }
  return achados;
}

/** A name as copy shows it: trimmed for display only, never for a comparison. */
function nomeParaExibir(nome: string): string {
  const limpo = nome.trim();
  return limpo === '' ? 'Sem nome' : limpo;
}

function rotuloDaOpcao(opcao: OpcaoDoAchadoShopee): string {
  const nome = nomeParaExibir(opcao.nome);
  return opcao.id === 0 ? nome : `${nome} (${String(opcao.id)})`;
}

/** Where a finding's sentence is shown (#1911 P14b, P14 Q4). */
export interface CartaoDoAchadoShopee {
  /**
   * The card offers no `Select` to act on: a custom entry, another conta's, an unknown
   * category, or a form the operator may not edit. `variante-em-duas-opcoes` then drops
   * its imperative «Escolha uma.»; every other sentence is the same on both cards.
   */
  readonly somenteLeitura: boolean;
}

/**
 * The card's copy of one finding (pt-BR). `nomeDaVariante` labels a variante id.
 * ⚠️ `chave-repetida`'s sentence says another entry comes FIRST, so it belongs on
 * the element `agruparVinculosShopee` marks `gemea`, not on the first one.
 */
export function mensagemDoAchadoShopee(
  achado: AchadoVinculoShopee,
  nomeDaVariante: (id: string) => string,
  cartao: CartaoDoAchadoShopee,
): string {
  switch (achado.tipo) {
    case TIPO_ACHADO_SHOPEE.chaveRepetida:
      return (
        'Outro vínculo deste grupo com esta conta e categoria vem antes na lista; a publicação ' +
        'lê só aquele. Remova um dos dois.'
      );
    case TIPO_ACHADO_SHOPEE.varianteEmDuasOpcoes:
      return (
        `A variante «${nomeDaVariante(achado.varianteId)}» está em mais de uma opção ` +
        `(${achado.opcoes.map(rotuloDaOpcao).join(', ')}) — a publicação pode usar qualquer ` +
        'uma delas, ou recusar o anúncio.' +
        (cartao.somenteLeitura ? '' : ' Escolha uma.')
      );
    case TIPO_ACHADO_SHOPEE.opcaoPersonalizadaSemNome:
      return (
        `A opção personalizada da variante «${nomeDaVariante(achado.varianteId)}» está sem ` +
        'nome. Dê um nome à variante (aba Variantes), se ela ainda não tiver, e escolha de ' +
        'novo a opção personalizada dela aqui.'
      );
    case TIPO_ACHADO_SHOPEE.opcaoComVariasVariantes:
      return (
        `As variantes ${achado.variantes.map((id) => `«${nomeDaVariante(id)}»`).join(', ')} ` +
        `estão na mesma opção «${nomeParaExibir(achado.opcao.nome)}»: um produto que tenha mais ` +
        'de uma delas não poderá ser publicado.'
      );
    case TIPO_ACHADO_SHOPEE.varianteInexistente:
      return (
        `A opção «${nomeParaExibir(achado.opcao.nome)}» está vinculada a uma variante que não ` +
        `existe mais neste grupo (${achado.varianteId}); a publicação a ignora.`
      );
    case TIPO_ACHADO_SHOPEE.varianteRemovidaNestaGravacao:
      return (
        `A variante «${nomeDaVariante(achado.varianteId)}» está vinculada à opção ` +
        `«${nomeParaExibir(achado.opcao.nome)}» da Shopee; ao salvar, o vínculo fica sem efeito.`
      );
    case TIPO_ACHADO_SHOPEE.opcaoForaDaArvore:
      return (
        `A opção ${rotuloDaOpcao(achado.opcao)} não está entre as opções atuais da Shopee ` +
        'para a variação e o grupo deste vínculo. O vínculo é mantido: um anúncio publicado ' +
        'pode estar usando essa opção.'
      );
    case TIPO_ACHADO_SHOPEE.grupoAusente:
      return (
        'A Shopee exige o grupo de opções desta variação, e este vínculo não o registra. ' +
        'Escolha o grupo — ou reimporte o anúncio, que o registra.'
      );
    case TIPO_ACHADO_SHOPEE.nomeForaDaFaixa:
      return (
        `A opção personalizada «${nomeParaExibir(achado.nome)}» tem ` +
        `${String(achado.comprimento)} caracteres e a Shopee aceita ${achado.faixa} — encurte o ` +
        'nome da variante (aba Variantes) e escolha de novo a opção personalizada dela aqui.'
      );
  }
}

/** The save's copy of a blocking finding; a warning has none. */
function mensagemDeBloqueio(
  achado: AchadoVinculoShopee,
  nomeDaVariante: (id: string) => string,
): string | null {
  if (!achado.bloqueia) return null;
  switch (achado.tipo) {
    case TIPO_ACHADO_SHOPEE.chaveRepetida:
      return (
        `o vínculo com a conta ${achado.integracaoId} na categoria ` +
        `${String(achado.categoryId)} aparece mais de uma vez`
      );
    case TIPO_ACHADO_SHOPEE.varianteEmDuasOpcoes:
      return (
        `a variante «${nomeDaVariante(achado.varianteId)}» está em mais de uma opção do vínculo ` +
        `da categoria ${String(achado.categoryId)}`
      );
    case TIPO_ACHADO_SHOPEE.opcaoPersonalizadaSemNome:
      return `a opção personalizada da variante «${nomeDaVariante(achado.varianteId)}» está sem nome`;
  }
}

/**
 * The page's `validate` body: the issues that BLOCK this save. Runs on the PREPARED
 * values (`ObjectView` applies every `prepareForSave` first), so
 * `linksVariacoesShopee` is the list about to be written. A finding blocks only
 * through an edited entry; with no published seed every entry counts as edited.
 */
export function validarVinculosShopee(
  values: Readonly<Record<string, unknown>>,
  seed: SeedVinculadorShopee | null,
): ValidationIssue[] {
  const valor = values.linksVariacoesShopee;
  // Not a list: the schema's own error speaks for it.
  if (!Array.isArray(valor)) return [];
  const lista: readonly unknown[] = valor;
  if (lista.length === 0) return [];
  const nomes = nomesDasVariantes(values.variacoes, seed?.variacoes);
  const nome = (id: string) => nomes.get(id) ?? id;
  const mensagens = avaliar(lista, idsDasVariantes(values.variacoes), seed).flatMap((achado) => {
    const mensagem = mensagemDeBloqueio(achado, nome);
    return mensagem === null ? [] : [mensagem];
  });
  if (mensagens.length === 0) return [];
  return [{ path: 'linksVariacoesShopee', message: `Vínculos Shopee: ${mensagens.join('; ')}.` }];
}
