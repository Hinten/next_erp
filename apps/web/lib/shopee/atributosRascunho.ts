/**
 * The produto's Shopee tab — the listing draft's ATTRIBUTE EDITOR model (#1911
 * P13): which control an attribute of the category's tree gets
 * ({@link controleDoAtributoShopee}), what one operator edit does to the draft's
 * attribute list ({@link aplicarEdicaoDoAtributoShopee}), what the «Atributos»
 * section shows ({@link linhasDoEditorDeAtributosShopee}) and whether a typing
 * still blocks «Salvar rascunho» ({@link digitacoesBloqueiam}). `./rascunho.ts`
 * composes these into the draft entry and its plan; the tab's
 * `AtributosRascunhoShopee.tsx` renders the rows; the sentences live with the
 * component and `./anuncioProduto.ts` — this module answers DATA only (a
 * «não suportado» row carries its motivo, never its text).
 *
 * ⚠️ PURE: no React, no clock, no I/O.
 *
 * ## Every rule is the schemas' (#1369)
 *
 * `@delfrance/schemas`' `atributosShopee.ts` holds the ONE copy of each rule the
 * publisher also decides with, and this file calls them, never re-states them:
 *
 * - what a stored list HOLDS — the decoder (`lerAtributosArmazenadosShopee`):
 *   every list read here goes through it, so an import's READ shape and a
 *   legacy no-`value_id` value are shown as the request values the publisher
 *   sends, and are never written back in the shape they were stored in;
 * - which attributes the chosen values SHOW — the walk (`atributosVisiveisShopee`);
 * - what is wrong with a list — the validator (`validarAtributosShopee`): the
 *   rows' problems, AND the edit-time check (below);
 * - which attributes a SAVE keeps — `atributosParaGravarShopee`, by id;
 * - an attribute's input type — `tipoDeEntradaShopee`, never the raw number;
 * - a typed decimal — `decimalShopeeDaTela` / `decimalShopeeParaTela`.
 *
 * What this file adds is the editor's own: which control renders an attribute,
 * the ORDER of a saved list, and the typing state.
 *
 * ## One edit, in order
 *
 * 1. **Candidate**: the edited attribute's values replaced in the entry's list
 *    (an attribute left with no value leaves the list).
 * 2. **Edit-time check = the shared validator.** A value the operator TYPES is
 *    run through `validarAtributosShopee`; a `tipo-de-valor`,
 *    `unidade-invalida`, `personalizado-nao-permitido` or `valores-demais` it
 *    raises on the edited attribute makes the single input's typing BLOCKING
 *    (the list keeps its previous value) and makes the composer REFUSE (nothing
 *    changes). ⚠️ **The editor never AUTHORS a value the validator flags; it may
 *    CARRY a stored one untouched** — a stored flagged value is shown with its
 *    problem, never blocks, and is never rewritten while nobody touches it.
 * 3. **Visible filter**: keep exactly the attribute ids
 *    `atributosParaGravarShopee` answers for the candidate, with the operator's
 *    OWN value objects (the decoder trims, so re-encoding on every keystroke
 *    would eat the space being typed). A parent value change therefore drops the
 *    children it no longer shows, and a stored orphan goes with the first edit;
 *    on a TRUNCATED tree the hidden stored attributes are kept (the schemas'
 *    rule: a save never deletes from missing knowledge).
 * 4. **Base-relative order** (no phantom dirty): attributes the held base holds
 *    keep the base's order, new ones follow in the save filter's order (walk
 *    order); inside an attribute, values the base holds keep the base's order
 *    and new ones follow in edit order — and a list value the base holds is the
 *    BASE's object (an import's `{value_id: 640, value_unit: 'kg'}` keeps its
 *    unit). So pick → unpick → re-pick, or remove → re-add, comes back
 *    byte-equal to the base. It is an ORDER, never an equality: whether the list
 *    is dirty is `./rascunho.ts`'s WRITE question, positional, untouched here.
 * 5. **Empty ⇒ `null`**, unless the held base is itself an empty list: a pick
 *    then an unpick on a draft that stored nothing reads clean, and a list
 *    emptied by the operator clears what is stored, like a category change.
 *
 * ## Typing — the digitações
 *
 * A single typed input (control `texto`, or `lista-ou-texto`'s «Outro valor»)
 * writes its text into the list as soon as it is valid: RAW for a text (never
 * trimmed at edit time — the write schema trims at plan time), the WIRE form
 * for a decimal (`'1,5'` ⇒ `'1.5'`). When it is not valid the list keeps its
 * previous value and a {@link DigitacaoAtributoShopee} keeps the raw text on
 * screen with its {@link MotivoDigitacaoShopee}; that typing BLOCKS the save
 * ({@link digitacoesBloqueiam}). A blank text clears the value; on a unit
 * attribute a chosen unit is remembered (a non-blocking digitação) while the
 * number is typed. ⚠️ A unit is NEVER defaulted (`ML` vs `L` is a ×1000 error):
 * a number with no unit is a blocking typing. A multi-value composer's text and
 * unit live in the component — nothing un-added is work — and only
 * {@link aplicarEdicaoDoAtributoShopee}'s answer says whether it may be added
 * (the component can ask it before enabling «Adicionar»: it is pure).
 *
 * ## What decides "the same value" here (fold scope)
 *
 * - **The decimal** is the schemas' lexical pair: typed `1,5` over a stored
 *   `1.5` writes the stored bytes; typed `1,50` writes `1.50`, an edit — never
 *   through a number (#1372). A typed DOT (`1.5`, `1.500`) is refused (D-9).
 * - **A value's identity** ({@link chaveDoValor}) — a list value is its
 *   `value_id`; a custom value is the decoder's reading of it (name trimmed,
 *   unit as stored). EQUAL: `'Algodão '` and `'Algodão'`. DISTINCT: `'algodão'`
 *   (case), the same name with another unit or none, `'1.50'` and `'1.5'`. It
 *   decides the base-relative ORDER, which stored values are «Serão removidos ao
 *   salvar», and the composer's `repetido` — never whether the list is dirty.
 * - **Units** match exactly, as the validator does: `'cm'` is not `'CM'`.
 */
import {
  FORMAT_TYPE_COM_UNIDADE_SHOPEE,
  INPUT_VALIDATION_TYPE_ATRIBUTO_SHOPEE,
  TIPO_PROBLEMA_ATRIBUTO_SHOPEE,
  atributosParaGravarShopee,
  atributosVisiveisShopee,
  decimalShopeeDaTela,
  decimalShopeeParaTela,
  lerAtributosArmazenadosShopee,
  tipoDeEntradaShopee,
  validarAtributosShopee,
  type ArvoreAtributosShopee,
  type AtributoDto,
  type AtributoLidoShopee,
  type AtributoShopeeRequisicao,
  type AtributoValorDto,
  type AtributoVisivelShopee,
  type ProblemaAtributoShopee,
  type TipoProblemaAtributoShopee,
  type ValorAtributoShopee,
} from '@delfrance/schemas';

/* -------------------------------------------------------------------------- */
/*                                 The control                                 */
/* -------------------------------------------------------------------------- */

/**
 * Why an attribute renders as «não suportado» (the row shows what is stored and
 * edits nothing):
 *
 * - `data` — `input_validation_type` 4: the ERP edits no date (no BR attribute
 *   is one; Lucas 2026-11-04: no date picker);
 * - `desconhecido` — an `input_type` this repo does not know (or no
 *   `attribute_info`);
 * - `busca` — the values come from Shopee's SEARCH and no custom value is
 *   accepted: the ERP cannot list them;
 * - `unidade-sem-lista` — the attribute needs a unit (`format_type` 2) and
 *   Shopee sent no unit list;
 * - `lista-sem-valores` — a list-only attribute whose list came empty.
 *
 * A MANDATORY one blocks «Publicar» through the existing `atributo-obrigatorio`
 * pendência while it holds NO value (`obrigatorio-ausente`); a stored value is
 * carried and published (D-7). An optional one blocks nothing (D-8).
 */
export type MotivoNaoSuportadoAtributoShopee =
  | 'data'
  | 'busca'
  | 'lista-sem-valores'
  | 'desconhecido'
  | 'unidade-sem-lista';
export const MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE = {
  data: 'data',
  busca: 'busca',
  listaSemValores: 'lista-sem-valores',
  desconhecido: 'desconhecido',
  unidadeSemLista: 'unidade-sem-lista',
} as const satisfies Record<string, MotivoNaoSuportadoAtributoShopee>;

/**
 * The control one attribute renders as (ATTR §3.4), decided from
 * `tipoDeEntradaShopee`'s flags and the tree's own facts:
 *
 * | `tipo` | when | the component renders |
 * |---|---|---|
 * | `lista-unica` | single, list only, with values (input 1) | a clearable `Select` |
 * | `lista-ou-texto` | single, custom allowed, with values (input 2) | a `Select` + «Outro valor…» ⇒ a text input (+ unit) |
 * | `texto` | single, custom allowed, no values (input 3; a list-less input 2) | a text input (+ unit) |
 * | `lista-multipla` | multiple, list only, with values (input 4) | a `MultiSelect` capped at `max` |
 * | `lista-multipla-ou-texto` | multiple, custom allowed, with values (input 5) | a `MultiSelect` capped at `max` minus the custom values, + custom chips and a composer |
 * | `textos-multiplos` | multiple, custom allowed, no values (a list-less input 5) | custom chips + a composer, at most `max` |
 * | `nao-suportado` | see {@link MotivoNaoSuportadoAtributoShopee} | what is stored, read-only |
 *
 * `max` is `max_value_count`, inclusive; `null` = no cap.
 */
export type ControleAtributoShopee =
  | { readonly tipo: 'lista-unica' }
  | { readonly tipo: 'lista-ou-texto' }
  | { readonly tipo: 'texto' }
  | { readonly tipo: 'lista-multipla'; readonly max: number | null }
  | { readonly tipo: 'lista-multipla-ou-texto'; readonly max: number | null }
  | { readonly tipo: 'textos-multiplos'; readonly max: number | null }
  | { readonly tipo: 'nao-suportado'; readonly motivo: MotivoNaoSuportadoAtributoShopee };
export type TipoControleAtributoShopee = ControleAtributoShopee['tipo'];
export const TIPO_CONTROLE_ATRIBUTO_SHOPEE = {
  listaUnica: 'lista-unica',
  listaOuTexto: 'lista-ou-texto',
  texto: 'texto',
  listaMultipla: 'lista-multipla',
  listaMultiplaOuTexto: 'lista-multipla-ou-texto',
  textosMultiplos: 'textos-multiplos',
  naoSuportado: 'nao-suportado',
} as const satisfies Record<string, TipoControleAtributoShopee>;

function naoSuportado(motivo: MotivoNaoSuportadoAtributoShopee): ControleAtributoShopee {
  return { tipo: 'nao-suportado', motivo };
}

/**
 * The values of the attribute's list an operator may PICK: every value of the
 * tree's list except an id ≤ 0 — `0` is the custom sentinel (a pick of it is no
 * list value, and the walk never unlocks children from it) and a write refuses
 * a negative id.
 */
function valoresEscolhiveis(no: AtributoDto): readonly AtributoValorDto[] {
  return no.attributeValueList.filter((v) => v.valueId > 0);
}

/**
 * **The control of one attribute** (ATTR §3.4) — the first rule that holds, in
 * this order:
 *
 * 1. `input_validation_type` 4 (a date) ⇒ `nao-suportado` `data`, whatever the
 *    input type;
 * 2. an unknown input type (`tipoDeEntradaShopee` says `conhecida: false`, or
 *    no `attribute_info`) ⇒ `desconhecido`;
 * 3. values served by Shopee's search and no custom value accepted ⇒ `busca`;
 * 4. `format_type` 2 with no unit list (absent or empty) ⇒ `unidade-sem-lista`;
 * 5. no custom value accepted and no value to pick ⇒ `lista-sem-valores`;
 * 6. – 11. the six editable controls of {@link ControleAtributoShopee}, by
 *    "multiple?", "custom allowed?" and "values to pick?".
 *
 * ⚠️ Never on the raw `input_type` number: a list-less input 2 is a TEXT input
 * (16 BR attributes ship no inline values), while a list-less input 1 is
 * unsupported. Pure, total.
 */
export function controleDoAtributoShopee(no: AtributoDto): ControleAtributoShopee {
  const info = no.attributeInfo;
  if (info !== null && info.inputValidationType === INPUT_VALIDATION_TYPE_ATRIBUTO_SHOPEE.data) {
    return naoSuportado(MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.data);
  }
  const entrada = tipoDeEntradaShopee(info);
  if (!entrada.conhecida || info === null) {
    return naoSuportado(MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.desconhecido);
  }
  if (info.supportSearchValue === true && !entrada.aceitaPersonalizado) {
    return naoSuportado(MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.busca);
  }
  if (
    info.formatType === FORMAT_TYPE_COM_UNIDADE_SHOPEE &&
    (info.attributeUnitList ?? []).length === 0
  ) {
    return naoSuportado(MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.unidadeSemLista);
  }
  const comValores = valoresEscolhiveis(no).length > 0;
  if (!entrada.aceitaPersonalizado && !comValores) {
    return naoSuportado(MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.listaSemValores);
  }
  const max = info.maxValueCount;
  if (!entrada.multipla) {
    if (!entrada.aceitaPersonalizado) return { tipo: 'lista-unica' };
    return comValores ? { tipo: 'lista-ou-texto' } : { tipo: 'texto' };
  }
  if (!entrada.aceitaPersonalizado) return { tipo: 'lista-multipla', max };
  return comValores ? { tipo: 'lista-multipla-ou-texto', max } : { tipo: 'textos-multiplos', max };
}

/** A control with ONE value (a single `Select` and/or one text input). */
function ehControleUnico(controle: ControleAtributoShopee): boolean {
  return (
    controle.tipo === 'lista-unica' ||
    controle.tipo === 'lista-ou-texto' ||
    controle.tipo === 'texto'
  );
}

/** A control that picks from the tree's list. */
function ehControleDeLista(controle: ControleAtributoShopee): boolean {
  return (
    controle.tipo === 'lista-unica' ||
    controle.tipo === 'lista-ou-texto' ||
    controle.tipo === 'lista-multipla' ||
    controle.tipo === 'lista-multipla-ou-texto'
  );
}

/** A control whose custom values are chips added by a composer. */
function ehControleDeChips(
  controle: ControleAtributoShopee,
): controle is Extract<
  ControleAtributoShopee,
  { readonly tipo: 'lista-multipla-ou-texto' | 'textos-multiplos' }
> {
  return controle.tipo === 'lista-multipla-ou-texto' || controle.tipo === 'textos-multiplos';
}

/** The attribute's unit list, VERBATIM (Shopee's order, case-exact), when it needs one; else `null`. */
function unidadesDoAtributo(no: AtributoDto): readonly string[] | null {
  const info = no.attributeInfo;
  if (info === null || info.formatType !== FORMAT_TYPE_COM_UNIDADE_SHOPEE) return null;
  const unidades = info.attributeUnitList;
  return unidades !== null && unidades.length > 0 ? unidades : null;
}

function ehDecimal(no: AtributoDto | null): boolean {
  return no?.attributeInfo?.inputValidationType === INPUT_VALIDATION_TYPE_ATRIBUTO_SHOPEE.decimal;
}

/* -------------------------------------------------------------------------- */
/*                         The typing and the edits                            */
/* -------------------------------------------------------------------------- */

/**
 * Why a typed value is not (yet) in the list — the validator's own kinds when
 * it is the validator that flags it, plus the composer's two:
 *
 * - `tipo-de-valor` — not of the attribute's value type: a decimal the pair
 *   cannot read (`'1,'`, a DOT `'1.5'` / `'1.500'`, `'1.234,5'`, `'1,5 kg'`),
 *   an integer the validator refuses;
 * - `unidade-invalida` — a unit attribute with no unit chosen (the typing
 *   copy is «Escolha a unidade.»), or one outside its list;
 * - `personalizado-nao-permitido` — a custom value where the input type takes
 *   none (closed: no editable control offers one there);
 * - `valores-demais` — beyond `max_value_count`;
 * - `vazio` — the composer's text is blank: nothing to add;
 * - `repetido` — the composer's value is one the attribute already holds
 *   ({@link chaveDoValor}).
 */
export type MotivoDigitacaoShopee =
  | typeof TIPO_PROBLEMA_ATRIBUTO_SHOPEE.tipoDeValor
  | typeof TIPO_PROBLEMA_ATRIBUTO_SHOPEE.unidadeInvalida
  | typeof TIPO_PROBLEMA_ATRIBUTO_SHOPEE.personalizadoNaoPermitido
  | typeof TIPO_PROBLEMA_ATRIBUTO_SHOPEE.valoresDemais
  | 'vazio'
  | 'repetido';
export const MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE = {
  tipoDeValor: TIPO_PROBLEMA_ATRIBUTO_SHOPEE.tipoDeValor,
  unidadeInvalida: TIPO_PROBLEMA_ATRIBUTO_SHOPEE.unidadeInvalida,
  personalizadoNaoPermitido: TIPO_PROBLEMA_ATRIBUTO_SHOPEE.personalizadoNaoPermitido,
  valoresDemais: TIPO_PROBLEMA_ATRIBUTO_SHOPEE.valoresDemais,
  vazio: 'vazio',
  repetido: 'repetido',
} as const satisfies Record<string, MotivoDigitacaoShopee>;

/**
 * What a single typed input shows that the list does not hold: the RAW text
 * and the chosen unit.
 *
 * - `motivo` non-null ⇔ the text is non-blank and NOT in the list (a BLOCKING
 *   typing — the list keeps its previous value);
 * - `motivo: null` ⇔ a blank text with a chosen unit, remembered while the
 *   number is typed (blocks nothing).
 *
 * A valid typing leaves no digitação: its value is in the list.
 */
export interface DigitacaoAtributoShopee {
  readonly texto: string;
  readonly unidade: string | null;
  readonly motivo: MotivoDigitacaoShopee | null;
}

/** The digitações of one draft entry, keyed by `String(attributeId)`. */
export type DigitacoesAtributosShopee = Readonly<Record<string, DigitacaoAtributoShopee>>;

/**
 * One operator edit of one attribute:
 *
 * - `lista` — the `Select` / `MultiSelect` picks, the WHOLE pick set. On a
 *   single control it is the attribute's whole value (a custom value goes); on
 *   a multiple one the custom values stay. An id that is neither in the tree's
 *   list nor already held is ignored — never authored. ⚠️ Choosing «Outro
 *   valor…» sends nothing by itself; the component may send `valueIds: []` to
 *   drop a held list value, and the text input then sends `texto`.
 * - `texto` — the single typed input (+ its unit); blank clears the value.
 * - `adicionar-personalizado` — the composer's «Adicionar» (+ its unit).
 * - `remover-personalizado` — a chip's remove: `indice` among the attribute's
 *   CUSTOM values, in list order ({@link ValorExibidoAtributoShopee.indicePersonalizado}).
 *   Also on a `lista-multipla` (list only): a STORED custom value there is
 *   flagged and a list pick keeps it, so its chip's remove is the one way out
 *   (removing authors nothing; nothing adds one there).
 * - `remover-sem-lugar` — «Marcar para remover»: stage every stored attribute
 *   the walk hides (the edit's `attributeId` is not read).
 */
export type EdicaoDoAtributoShopee =
  | { readonly tipo: 'lista'; readonly valueIds: readonly number[] }
  | { readonly tipo: 'texto'; readonly texto: string; readonly unidade: string | null }
  | {
      readonly tipo: 'adicionar-personalizado';
      readonly texto: string;
      readonly unidade: string | null;
    }
  | { readonly tipo: 'remover-personalizado'; readonly indice: number }
  | { readonly tipo: 'remover-sem-lugar' };

/**
 * What the editor reads:
 *
 * - `arvore` — the EDITED category's tree (`leaf: false` reads as an empty,
 *   complete tree);
 * - `lista` — the entry's attributes (`atual.attributes`), the operator's own
 *   value objects;
 * - `guardados` — the HELD base's attributes (`base.attributes`, the
 *   projection the operator loaded) — the reference of the order and of what
 *   «Serão removidos ao salvar»;
 * - `digitacoes` — the entry's typings.
 */
export interface ArgsDoEditorDeAtributosShopee {
  readonly arvore: ArvoreAtributosShopee;
  readonly lista: readonly AtributoShopeeRequisicao[] | null;
  readonly guardados: readonly AtributoShopeeRequisicao[] | null;
  readonly digitacoes: DigitacoesAtributosShopee;
}

/** {@link aplicarEdicaoDoAtributoShopee}'s input: the editor's state, the attribute and the edit. */
export interface ArgsDaEdicaoDoAtributoShopee extends ArgsDoEditorDeAtributosShopee {
  readonly attributeId: number;
  readonly edicao: EdicaoDoAtributoShopee;
}

/**
 * What one edit does: the new list and typings (`ok: true`, possibly the very
 * same `lista` — a blocking typing, or an edit that does not apply), or a
 * REFUSAL that changes nothing (`ok: false`: the composer, and a pick set beyond
 * the cap).
 */
export type ResultadoDaEdicaoDoAtributoShopee =
  | {
      readonly ok: true;
      readonly lista: readonly AtributoShopeeRequisicao[] | null;
      readonly digitacoes: DigitacoesAtributosShopee;
    }
  | { readonly ok: false; readonly motivo: MotivoDigitacaoShopee };

/* -------------------------------------------------------------------------- */
/*                    The entry's list, read through the decoder               */
/* -------------------------------------------------------------------------- */

/** One value of the entry: the decoder's reading of it, and the object this module writes back. */
interface ValorDaEntrada {
  /** The decoder's reading — what is shown, walked and validated. */
  readonly lido: ValorAtributoShopee;
  /**
   * What an edit writes back for it: the reading itself, except that a custom
   * value keeps the operator's RAW name (the reading trims). Always the
   * REQUEST shape — never the import's read shape.
   */
  readonly objeto: ValorAtributoShopee;
}

/** One attribute of the entry, as the decoder keeps it (first usable element per id, usable values). */
interface AtributoDaEntrada {
  readonly attributeId: number;
  readonly valores: readonly ValorDaEntrada[];
}

function objetoDoValor(bruto: unknown, lido: ValorAtributoShopee): ValorAtributoShopee {
  if (lido.value_id !== 0 || typeof bruto !== 'object' || bruto === null) return lido;
  const nome: unknown = (bruto as { readonly original_value_name?: unknown }).original_value_name;
  return typeof nome === 'string' ? { ...lido, original_value_name: nome } : lido;
}

function valoresBrutosDe(elemento: unknown): readonly unknown[] {
  if (typeof elemento !== 'object' || elemento === null) return [];
  const lista: unknown = (elemento as { readonly attribute_value_list?: unknown })
    .attribute_value_list;
  return Array.isArray(lista) ? (lista as readonly unknown[]) : [];
}

/**
 * The entry's list through THE decoder, each kept value paired with the
 * operator's own object. The pairing reads the decoder's own report
 * (`descartes`: which element and which value it dropped), so the kept raw
 * elements and values line up one to one with what it answers.
 */
function lerEntrada(lista: readonly AtributoShopeeRequisicao[] | null): AtributoDaEntrada[] {
  const brutos: readonly unknown[] = lista ?? [];
  const { atributos, descartes } = lerAtributosArmazenadosShopee(brutos);
  const elementosFora = new Set<number>();
  const valoresFora = new Set<string>();
  for (const d of descartes) {
    if (d.posicaoValor === null) elementosFora.add(d.posicao);
    else valoresFora.add(`${String(d.posicao)}:${String(d.posicaoValor)}`);
  }
  const mantidos: { readonly elemento: unknown; readonly posicao: number }[] = [];
  brutos.forEach((elemento, posicao) => {
    if (!elementosFora.has(posicao)) mantidos.push({ elemento, posicao });
  });
  return atributos.map((lido, i) => {
    const mantido = mantidos[i];
    const brutosDoAtributo =
      mantido === undefined
        ? []
        : valoresBrutosDe(mantido.elemento).filter(
            (_, j) => !valoresFora.has(`${String(mantido.posicao)}:${String(j)}`),
          );
    return {
      attributeId: lido.attributeId,
      valores: lido.valores.map((v, j) => ({
        lido: v.valor,
        objeto: objetoDoValor(brutosDoAtributo[j], v.valor),
      })),
    };
  });
}

/** The entry as a request list (each value's {@link ValorDaEntrada.objeto}). */
function paraLista(entrada: readonly AtributoDaEntrada[]): AtributoShopeeRequisicao[] {
  return entrada.map((a) => ({
    attribute_id: a.attributeId,
    attribute_value_list: a.valores.map((v) => v.objeto),
  }));
}

/** A request list through THE decoder — what the walk and the validator are asked about. */
function lidosDe(lista: readonly AtributoShopeeRequisicao[] | null): readonly AtributoLidoShopee[] {
  return lerAtributosArmazenadosShopee(lista ?? []).atributos;
}

/** The decoder's reading of ONE value, or `null` when it would drop it. */
function lidoDoValor(valor: ValorAtributoShopee): ValorAtributoShopee | null {
  const lido = lerAtributosArmazenadosShopee([{ attribute_id: 1, attribute_value_list: [valor] }]);
  return lido.atributos[0]?.valores[0]?.valor ?? null;
}

/** The entry with one attribute's values replaced (appended when absent; gone when `valores` is empty). */
function comValores(
  entrada: readonly AtributoDaEntrada[],
  attributeId: number,
  valores: readonly ValorDaEntrada[],
): AtributoDaEntrada[] {
  const existe = entrada.some((a) => a.attributeId === attributeId);
  const trocada = existe
    ? entrada.map((a) => (a.attributeId === attributeId ? { attributeId, valores } : a))
    : [...entrada, { attributeId, valores }];
  return trocada.filter((a) => a.valores.length > 0);
}

/* -------------------------------------------------------------------------- */
/*                        A value's identity, and the order                    */
/* -------------------------------------------------------------------------- */

/**
 * **The identity of one value inside one attribute** — what the base-relative
 * order, «Serão removidos ao salvar» and the composer's `repetido` ask; never
 * the dirty question. Over the decoder's reading:
 *
 * - a list value is its `value_id` (a unit beside it does not count — the base's
 *   own object is the one kept);
 * - a custom value is its name AND its unit, as the decoder reads them: the name
 *   trimmed, nothing else folded. `'Algodão '` ≡ `'Algodão'`; `'algodão'`, a
 *   name with another unit or none, and `'1.50'` vs `'1.5'` stay DISTINCT.
 */
function chaveDoValor(lido: ValorAtributoShopee): string {
  if (lido.value_id !== 0) return `lista:${String(lido.value_id)}`;
  return `personalizado:${JSON.stringify([lido.original_value_name ?? null, lido.value_unit ?? null])}`;
}

/** The values of `de` that `sem` does not hold — each matched at most once (a multiset). */
function valoresAusentes(
  de: readonly ValorDaEntrada[],
  sem: readonly ValorDaEntrada[],
): ValorDaEntrada[] {
  const restantes = sem.map((v) => chaveDoValor(v.lido));
  const ausentes: ValorDaEntrada[] = [];
  for (const v of de) {
    const i = restantes.indexOf(chaveDoValor(v.lido));
    if (i < 0) ausentes.push(v);
    else restantes.splice(i, 1);
  }
  return ausentes;
}

/**
 * One attribute's values in the base-relative order: those the base holds, in
 * the base's order (a list value as the BASE's object), then the new ones in
 * edit order.
 */
function valoresNaOrdemDaBase(
  valores: readonly ValorDaEntrada[],
  daBase: readonly ValorDaEntrada[] | undefined,
): ValorDaEntrada[] {
  if (daBase === undefined) return [...valores];
  const restantes = [...valores];
  const saida: ValorDaEntrada[] = [];
  for (const b of daBase) {
    const i = restantes.findIndex((v) => chaveDoValor(v.lido) === chaveDoValor(b.lido));
    if (i < 0) continue;
    const [achado] = restantes.splice(i, 1);
    if (achado === undefined) continue;
    saida.push(achado.lido.value_id !== 0 ? b : achado);
  }
  return [...saida, ...restantes];
}

/**
 * The candidate after the visible filter, the base-relative order and the
 * empty rule; the typings kept are those of attributes still shown.
 */
function concluir(
  a: ArgsDoEditorDeAtributosShopee,
  candidato: readonly AtributoDaEntrada[],
  digitacoes: DigitacoesAtributosShopee,
): ResultadoDaEdicaoDoAtributoShopee {
  const ordemDoGravar = atributosParaGravarShopee(a.arvore, lidosDe(paraLista(candidato))).map(
    (x) => x.attribute_id,
  );
  const porId = new Map<number, AtributoDaEntrada>();
  for (const atributo of candidato) {
    if (ordemDoGravar.includes(atributo.attributeId) && !porId.has(atributo.attributeId)) {
      porId.set(atributo.attributeId, atributo);
    }
  }
  const base = lerEntrada(a.guardados);
  const daBase = base.map((b) => b.attributeId).filter((id) => porId.has(id));
  const ids = [...daBase, ...ordemDoGravar.filter((id) => porId.has(id) && !daBase.includes(id))];
  const ordenada: AtributoDaEntrada[] = [];
  for (const id of ids) {
    const atributo = porId.get(id);
    if (atributo === undefined) continue;
    ordenada.push({
      attributeId: id,
      valores: valoresNaOrdemDaBase(
        atributo.valores,
        base.find((b) => b.attributeId === id)?.valores,
      ),
    });
  }
  const lista =
    ordenada.length > 0
      ? paraLista(ordenada)
      : a.guardados !== null && a.guardados.length === 0
        ? []
        : null;

  const mostrados = atributosVisiveisShopee(a.arvore, lidosDe(lista));
  const mantidas: Record<string, DigitacaoAtributoShopee> = {};
  for (const { atributo } of mostrados) {
    const chave = String(atributo.attributeId);
    const digitacao = digitacoes[chave];
    if (digitacao !== undefined) mantidas[chave] = digitacao;
  }
  return { ok: true, lista, digitacoes: mantidas };
}

/* -------------------------------------------------------------------------- */
/*                        The edit-time check (the validator)                  */
/* -------------------------------------------------------------------------- */

/** The validator's kinds the editor refuses to AUTHOR, in the order a typing reports them. */
const AUTORADOS_RECUSADOS: readonly (MotivoDigitacaoShopee & TipoProblemaAtributoShopee)[] = [
  TIPO_PROBLEMA_ATRIBUTO_SHOPEE.tipoDeValor,
  TIPO_PROBLEMA_ATRIBUTO_SHOPEE.unidadeInvalida,
  TIPO_PROBLEMA_ATRIBUTO_SHOPEE.personalizadoNaoPermitido,
];

/** The validator's kinds on ONE attribute of a request list. */
function tiposDoAtributo(
  arvore: ArvoreAtributosShopee,
  lista: readonly AtributoShopeeRequisicao[],
  attributeId: number,
): Set<TipoProblemaAtributoShopee> {
  return new Set(
    validarAtributosShopee(arvore, lidosDe(lista))
      .filter((p) => p.attributeId === attributeId)
      .map((p) => p.tipo),
  );
}

/**
 * The validator's kinds that ONE value raises alone: the list with the
 * attribute holding only that value (the attribute's own visibility depends on
 * its ancestors, never on its values, so it is judged where it stands).
 */
function tiposDoValor(
  arvore: ArvoreAtributosShopee,
  entrada: readonly AtributoDaEntrada[],
  attributeId: number,
  valor: ValorDaEntrada,
): Set<TipoProblemaAtributoShopee> {
  return tiposDoAtributo(arvore, paraLista(comValores(entrada, attributeId, [valor])), attributeId);
}

function primeiroRecusado(
  tipos: ReadonlySet<TipoProblemaAtributoShopee>,
): MotivoDigitacaoShopee | null {
  return AUTORADOS_RECUSADOS.find((t) => tipos.has(t)) ?? null;
}

/**
 * Does the candidate EXCEED the cap because of this edit? Only an edit that
 * adds values can: a stored list already over the cap may still be reduced
 * (it is carried, not authored).
 */
function excessoIntroduzido(
  arvore: ArvoreAtributosShopee,
  candidato: readonly AtributoDaEntrada[],
  attributeId: number,
  antes: number,
  depois: number,
): boolean {
  return (
    depois > antes &&
    tiposDoAtributo(arvore, paraLista(candidato), attributeId).has(
      TIPO_PROBLEMA_ATRIBUTO_SHOPEE.valoresDemais,
    )
  );
}

/**
 * The custom value a typed text makes: a decimal through `decimalShopeeDaTela`
 * (the WIRE form; `null` ⇒ `tipo-de-valor`), any other text RAW; the unit as
 * chosen, only on a unit attribute.
 */
function valorDigitado(
  no: AtributoDto,
  texto: string,
  unidade: string | null,
): { readonly valor: ValorDaEntrada } | { readonly motivo: MotivoDigitacaoShopee } {
  const nome = ehDecimal(no) ? decimalShopeeDaTela(texto) : texto;
  if (nome === null) return { motivo: TIPO_PROBLEMA_ATRIBUTO_SHOPEE.tipoDeValor };
  const objeto: ValorAtributoShopee =
    unidade !== null
      ? { value_id: 0, original_value_name: nome, value_unit: unidade }
      : { value_id: 0, original_value_name: nome };
  const lido = lidoDoValor(objeto);
  // Unreachable for a non-blank text (the decoder keeps a non-blank custom
  // name) — and closed if it ever is: nothing the decoder drops is written.
  if (lido === null) return { motivo: MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.vazio };
  return { valor: { lido, objeto } };
}

/** The chosen unit as an edit carries it: only on a unit attribute, `''` read as none. */
function unidadeDaEdicao(no: AtributoDto, unidade: string | null): string | null {
  if (unidadesDoAtributo(no) === null || unidade === null || unidade === '') return null;
  return unidade;
}

function semDigitacao(d: DigitacoesAtributosShopee, chave: string): DigitacoesAtributosShopee {
  if (!(chave in d)) return d;
  const resto: Record<string, DigitacaoAtributoShopee> = { ...d };
  delete resto[chave];
  return resto;
}

function comDigitacao(
  d: DigitacoesAtributosShopee,
  chave: string,
  digitacao: DigitacaoAtributoShopee,
): DigitacoesAtributosShopee {
  return { ...d, [chave]: digitacao };
}

/* -------------------------------------------------------------------------- */
/*                                  The edit                                   */
/* -------------------------------------------------------------------------- */

/**
 * **One operator edit of one attribute** (ATTR §3.5–3.6) — the steps of this
 * module's header: candidate, edit-time check, visible filter, base-relative
 * order, empty rule.
 *
 * The edit applies only to an attribute the walk SHOWS for the current list,
 * through the control {@link controleDoAtributoShopee} gives it (a `texto` on a
 * list-only attribute, any edit of a «não suportado» one, an id the walk does
 * not show): otherwise the answer is the input, unchanged — nothing is filtered
 * by an edit that did not happen.
 *
 * - **`lista`** ⇒ the picks (dedup, ids from the tree's list or already held);
 *   a single control's typing is dropped. Refused (`valores-demais`) when the
 *   picks push the attribute beyond its cap.
 * - **`texto`** ⇒ blank: the value goes (a chosen unit is remembered); else the
 *   typed value replaces it when the decimal pair reads it AND the validator
 *   raises nothing on it — otherwise a BLOCKING typing, the list unchanged.
 * - **`adicionar-personalizado`** ⇒ the same value rule, plus `vazio`,
 *   `repetido` and the cap — REFUSED (`ok: false`, nothing changes) when any
 *   holds.
 * - **`remover-personalizado`** ⇒ that custom value goes (an index out of range
 *   changes nothing) — on the chip controls and on a `lista-multipla`.
 * - **`remover-sem-lugar`** ⇒ just the visible filter.
 *
 * Every typing of an attribute the result no longer shows is dropped (it would
 * block a save with no row to fix it on). Pure, total.
 */
export function aplicarEdicaoDoAtributoShopee(
  a: ArgsDaEdicaoDoAtributoShopee,
): ResultadoDaEdicaoDoAtributoShopee {
  const semMudanca: ResultadoDaEdicaoDoAtributoShopee = {
    ok: true,
    lista: a.lista,
    digitacoes: a.digitacoes,
  };
  const entrada = lerEntrada(a.lista);
  const edicao = a.edicao;
  if (edicao.tipo === 'remover-sem-lugar') {
    return a.lista === null ? semMudanca : concluir(a, entrada, a.digitacoes);
  }

  const visivel = atributosVisiveisShopee(a.arvore, lidosDe(a.lista)).find(
    (v) => v.atributo.attributeId === a.attributeId,
  );
  if (visivel === undefined) return semMudanca;
  const no = visivel.atributo;
  const controle = controleDoAtributoShopee(no);
  const chave = String(a.attributeId);
  const atuais = entrada.find((x) => x.attributeId === a.attributeId)?.valores ?? [];

  switch (edicao.tipo) {
    case 'lista': {
      if (!ehControleDeLista(controle)) return semMudanca;
      const daLista = new Set(valoresEscolhiveis(no).map((v) => v.valueId));
      const daEntrada = new Map<number, ValorDaEntrada>();
      for (const v of atuais) {
        if (v.lido.value_id !== 0 && !daEntrada.has(v.lido.value_id)) {
          daEntrada.set(v.lido.value_id, v);
        }
      }
      const escolhidos = [...new Set(edicao.valueIds)].filter(
        (id) => daLista.has(id) || daEntrada.has(id),
      );
      const escolhido = (id: number): ValorDaEntrada =>
        daEntrada.get(id) ?? { lido: { value_id: id }, objeto: { value_id: id } };
      const novos = ehControleUnico(controle)
        ? escolhidos.map(escolhido)
        : [
            ...atuais.filter((v) => v.lido.value_id === 0 || escolhidos.includes(v.lido.value_id)),
            ...escolhidos
              .filter((id) => !atuais.some((v) => v.lido.value_id === id))
              .map(escolhido),
          ];
      const candidato = comValores(entrada, a.attributeId, novos);
      if (excessoIntroduzido(a.arvore, candidato, a.attributeId, atuais.length, novos.length)) {
        return { ok: false, motivo: TIPO_PROBLEMA_ATRIBUTO_SHOPEE.valoresDemais };
      }
      const digitacoes = ehControleUnico(controle)
        ? semDigitacao(a.digitacoes, chave)
        : a.digitacoes;
      return concluir(a, candidato, digitacoes);
    }

    case 'texto': {
      if (controle.tipo !== 'texto' && controle.tipo !== 'lista-ou-texto') return semMudanca;
      const unidade = unidadeDaEdicao(no, edicao.unidade);
      if (edicao.texto.trim() === '') {
        const digitacoes =
          unidade !== null
            ? comDigitacao(a.digitacoes, chave, { texto: edicao.texto, unidade, motivo: null })
            : semDigitacao(a.digitacoes, chave);
        return concluir(a, comValores(entrada, a.attributeId, []), digitacoes);
      }
      const bloqueia = (motivo: MotivoDigitacaoShopee): ResultadoDaEdicaoDoAtributoShopee => ({
        ok: true,
        lista: a.lista,
        digitacoes: comDigitacao(a.digitacoes, chave, { texto: edicao.texto, unidade, motivo }),
      });
      const digitado = valorDigitado(no, edicao.texto, unidade);
      if ('motivo' in digitado) return bloqueia(digitado.motivo);
      const motivo = primeiroRecusado(
        tiposDoValor(a.arvore, entrada, a.attributeId, digitado.valor),
      );
      if (motivo !== null) return bloqueia(motivo);
      return concluir(
        a,
        comValores(entrada, a.attributeId, [digitado.valor]),
        semDigitacao(a.digitacoes, chave),
      );
    }

    case 'adicionar-personalizado': {
      if (!ehControleDeChips(controle)) return semMudanca;
      if (edicao.texto.trim() === '') {
        return { ok: false, motivo: MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.vazio };
      }
      const digitado = valorDigitado(no, edicao.texto, unidadeDaEdicao(no, edicao.unidade));
      if ('motivo' in digitado) return { ok: false, motivo: digitado.motivo };
      const motivo = primeiroRecusado(
        tiposDoValor(a.arvore, entrada, a.attributeId, digitado.valor),
      );
      if (motivo !== null) return { ok: false, motivo };
      const chaveNova = chaveDoValor(digitado.valor.lido);
      if (atuais.some((v) => chaveDoValor(v.lido) === chaveNova)) {
        return { ok: false, motivo: MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.repetido };
      }
      const novos = [...atuais, digitado.valor];
      const candidato = comValores(entrada, a.attributeId, novos);
      if (excessoIntroduzido(a.arvore, candidato, a.attributeId, atuais.length, novos.length)) {
        return { ok: false, motivo: TIPO_PROBLEMA_ATRIBUTO_SHOPEE.valoresDemais };
      }
      return concluir(a, candidato, a.digitacoes);
    }

    case 'remover-personalizado': {
      if (!ehControleDeChips(controle) && controle.tipo !== 'lista-multipla') return semMudanca;
      const posicoes = atuais.flatMap((v, i) => (v.lido.value_id === 0 ? [i] : []));
      const alvo = posicoes[edicao.indice];
      if (alvo === undefined) return semMudanca;
      return concluir(
        a,
        comValores(
          entrada,
          a.attributeId,
          atuais.filter((_, i) => i !== alvo),
        ),
        a.digitacoes,
      );
    }
  }
}

/** Does any typing still BLOCK the save? — some entry with a non-blank text (see {@link DigitacaoAtributoShopee}). */
export function digitacoesBloqueiam(d: DigitacoesAtributosShopee): boolean {
  return Object.values(d).some((digitacao) => digitacao.texto.trim() !== '');
}

/* -------------------------------------------------------------------------- */
/*                                 The rows                                    */
/* -------------------------------------------------------------------------- */

/** One option of a `Select` / `MultiSelect` — its value is `String(valueId)`; the label decides nothing. */
export interface OpcaoAtributoShopee {
  readonly valueId: number;
  /** The tree's `name` (pt-BR since P13a), else `#<valueId>`. */
  readonly rotulo: string;
}

/** One value as the screen shows it. */
export interface ValorExibidoAtributoShopee {
  /** The decoder's reading — the request shape (an import's read-shape name is never here). */
  readonly valor: ValorAtributoShopee;
  /** A custom value (`value_id: 0`). */
  readonly personalizado: boolean;
  /**
   * What the screen prints: a list value's label from the TREE (else
   * `#<valueId>`) — never a stored name; a custom value's name, a decimal
   * attribute's through `decimalShopeeParaTela` (`'0.125'` ⇒ `'0,125'`).
   */
  readonly rotulo: string;
  /** The value's unit as stored (`null` when none). */
  readonly unidade: string | null;
  /**
   * A custom value's index among the attribute's custom values — what
   * `remover-personalizado` names; `null` for a list value and in
   * {@link ItemDeAtributoShopee}.
   */
  readonly indicePersonalizado: number | null;
}

/**
 * One problem of a row, as data (the sentence is the component's):
 *
 * - `tipo` — the validator's kind;
 * - `valor` — for a kind ONE value raises (`personalizado-nao-permitido`,
 *   `valor-fora-da-lista`, `unidade-invalida`, `tipo-de-valor`,
 *   `data-em-formato-de-leitura`): the first such value's
 *   {@link ValorExibidoAtributoShopee.rotulo}, the validator asked about each
 *   value alone; else `null`;
 * - `unidade` — `unidade-invalida`: that value's stored unit (`null` = none,
 *   «nenhuma»); else `null`;
 * - `maximo` — `valores-demais`: the cap (1 on a single choice); else `null`.
 */
export interface MensagemAtributoShopee {
  readonly tipo: TipoProblemaAtributoShopee;
  readonly valor: string | null;
  readonly unidade: string | null;
  readonly maximo: number | null;
}

/** The parent of a child row: its attribute's label and the CHOSEN value that shows the row. */
export interface PaiDaLinhaAtributoShopee {
  readonly attributeId: number;
  readonly rotulo: string;
  readonly valueId: number;
  readonly valor: string;
}

/** A typed value's type, for the input's description: `null` = text. */
export type TipoDoValorAtributoShopee = 'inteiro' | 'decimal';

/** One row of the «Atributos» section — one attribute the walk shows, in walk order. */
export interface LinhaAtributoShopee {
  readonly attributeId: number;
  /** The tree's node. */
  readonly atributo: AtributoDto;
  /** The attribute's own label: its `name` (pt-BR since P13a), else `#<attributeId>`. */
  readonly rotulo: string;
  /** The walk's name — a child's reads `"<filho> (em <pai>: <valor>)"`; what a pendência prints. */
  readonly nome: string;
  readonly obrigatorio: boolean;
  /** 0 for a root; a child is its parent's + 1. */
  readonly profundidade: number;
  /** `null` for a root. A mandatory child reads «Exigido quando…», an optional one «Aparece quando…». */
  readonly pai: PaiDaLinhaAtributoShopee | null;
  readonly controle: ControleAtributoShopee;
  /** Shopee's `introduction`, when it sent one. */
  readonly descricao: string | null;
  readonly tipoDoValor: TipoDoValorAtributoShopee | null;
  /** Shopee also serves this attribute's values by SEARCH (the ERP does not search: the value is typed). */
  readonly buscaNaShopee: boolean;
  /** The tree's pickable values, tree order. */
  readonly opcoes: readonly OpcaoAtributoShopee[];
  /** The unit list VERBATIM (Shopee's order, case-exact) on a unit attribute; else `null`. No default. */
  readonly unidades: readonly string[] | null;
  /** Every value the list holds for the attribute, list order. */
  readonly valores: readonly ValorExibidoAtributoShopee[];
  /** The list values' ids, list order — a `Select`'s / `MultiSelect`'s value (a held id may be outside {@link opcoes}). */
  readonly escolhidos: readonly number[];
  /** `lista-ou-texto`: the attribute holds a custom value, or a typing — the text input is shown. */
  readonly outroValor: boolean;
  /**
   * The single text input's text (`texto` / `lista-ou-texto`): the typing's
   * raw text, else the custom value's RAW name (a decimal through
   * `decimalShopeeParaTela`), else `''`. `''` on every other control.
   */
  readonly textoDigitado: string;
  /** The single text input's unit: the typing's, else the custom value's, else `null`. */
  readonly unidadeDigitada: string | null;
  /** The single text input's blocking reason, or `null`. */
  readonly digitacao: MotivoDigitacaoShopee | null;
  /**
   * The `MultiSelect`'s `maxValues`: on `lista-multipla` and
   * `lista-multipla-ou-texto`, `max` minus the custom values (≥ 0 — a stored
   * custom value on a `lista-multipla` counts, so the control never offers a
   * pick the cap refuses); `null` = no cap (and on every other control).
   */
  readonly maxEscolhas: number | null;
  /** The composer may add (`lista-multipla-ou-texto` / `textos-multiplos`): fewer values than `max`. */
  readonly podeAdicionar: boolean;
  /** The validator's rows on this attribute, over the list (carried values included). */
  readonly problemas: readonly MensagemAtributoShopee[];
}

/**
 * A stored attribute outside the rows:
 *
 * - in `semLugar`: one the list holds and the walk hides — `motivo` is the
 *   validator's `filho-sem-pai` / `fora-da-categoria`; `inteiro: true`;
 * - in `removidosAoSalvar`: one the HELD base holds that the list no longer
 *   does (`inteiro: true`, every stored value), or — on a multiple attribute —
 *   the stored values the list dropped (`inteiro: false`); `motivo: null`.
 */
export interface ItemDeAtributoShopee {
  readonly attributeId: number;
  /** The tree's name of the attribute anywhere in the tree, else `#<attributeId>`. */
  readonly rotulo: string;
  readonly valores: readonly ValorExibidoAtributoShopee[];
  readonly inteiro: boolean;
  readonly motivo:
    | typeof TIPO_PROBLEMA_ATRIBUTO_SHOPEE.filhoSemPai
    | typeof TIPO_PROBLEMA_ATRIBUTO_SHOPEE.foraDaCategoria
    | null;
}

/** What the «Atributos» section renders. */
export interface EditorDeAtributosShopee {
  /** One per attribute the walk shows, in walk order. */
  readonly linhas: readonly LinhaAtributoShopee[];
  /** «Gravados, mas sem lugar nesta categoria» — never removed by opening the screen. On a truncated tree only a stored id no write accepts (the save keeps every other hidden one there). */
  readonly semLugar: readonly ItemDeAtributoShopee[];
  /** «Serão removidos ao salvar» — staged (apps/web rule 7); «Desfazer alterações» is the undo. */
  readonly removidosAoSalvar: readonly ItemDeAtributoShopee[];
}

function rotuloDoAtributo(no: AtributoDto): string {
  return no.name ?? `#${String(no.attributeId)}`;
}

function rotuloDeValor(valor: AtributoValorDto): string {
  return valor.name ?? `#${String(valor.valueId)}`;
}

/**
 * The first node with this id anywhere in the tree, depth first — for a LABEL
 * only (a hidden or removed attribute's name); it decides nothing.
 */
function noNaArvore(atributos: readonly AtributoDto[], id: number): AtributoDto | null {
  for (const atributo of atributos) {
    if (atributo.attributeId === id) return atributo;
    for (const valor of atributo.attributeValueList) {
      const achado = noNaArvore(valor.childAttributeList, id);
      if (achado !== null) return achado;
    }
  }
  return null;
}

function exibir(
  no: AtributoDto | null,
  valores: readonly ValorDaEntrada[],
  comIndices: boolean,
): ValorExibidoAtributoShopee[] {
  const decimal = ehDecimal(no);
  let indice = 0;
  return valores.map(({ lido }) => {
    const personalizado = lido.value_id === 0;
    const nome = lido.original_value_name ?? '';
    const daLista = no?.attributeValueList.find((v) => v.valueId === lido.value_id);
    const rotulo = personalizado
      ? decimal
        ? decimalShopeeParaTela(nome)
        : nome
      : daLista !== undefined
        ? rotuloDeValor(daLista)
        : `#${String(lido.value_id)}`;
    const indicePersonalizado = comIndices && personalizado ? indice : null;
    if (personalizado) indice += 1;
    return {
      valor: lido,
      personalizado,
      rotulo,
      unidade: lido.value_unit ?? null,
      indicePersonalizado,
    };
  });
}

/** The kinds a single VALUE raises (so a row names which one). */
const TIPOS_DE_UM_VALOR: ReadonlySet<TipoProblemaAtributoShopee> =
  new Set<TipoProblemaAtributoShopee>([
    TIPO_PROBLEMA_ATRIBUTO_SHOPEE.personalizadoNaoPermitido,
    TIPO_PROBLEMA_ATRIBUTO_SHOPEE.valorForaDaLista,
    TIPO_PROBLEMA_ATRIBUTO_SHOPEE.unidadeInvalida,
    TIPO_PROBLEMA_ATRIBUTO_SHOPEE.tipoDeValor,
    TIPO_PROBLEMA_ATRIBUTO_SHOPEE.dataEmFormatoDeLeitura,
  ]);

function mensagensDoAtributo(
  arvore: ArvoreAtributosShopee,
  entrada: readonly AtributoDaEntrada[],
  no: AtributoDto,
  valores: readonly ValorDaEntrada[],
  exibidos: readonly ValorExibidoAtributoShopee[],
  problemas: readonly ProblemaAtributoShopee[],
): MensagemAtributoShopee[] {
  const info = no.attributeInfo;
  const entradaDoTipo = tipoDeEntradaShopee(info);
  return problemas.map((p) => {
    if (p.tipo === TIPO_PROBLEMA_ATRIBUTO_SHOPEE.valoresDemais) {
      const maximo =
        entradaDoTipo.conhecida && entradaDoTipo.multipla ? (info?.maxValueCount ?? null) : 1;
      return { tipo: p.tipo, valor: null, unidade: null, maximo };
    }
    if (!TIPOS_DE_UM_VALOR.has(p.tipo)) {
      return { tipo: p.tipo, valor: null, unidade: null, maximo: null };
    }
    const i = valores.findIndex((v) =>
      tiposDoValor(arvore, entrada, no.attributeId, v).has(p.tipo),
    );
    const exibido = exibidos[i];
    if (exibido === undefined) return { tipo: p.tipo, valor: null, unidade: null, maximo: null };
    return {
      tipo: p.tipo,
      valor: exibido.rotulo,
      unidade: p.tipo === TIPO_PROBLEMA_ATRIBUTO_SHOPEE.unidadeInvalida ? exibido.unidade : null,
      maximo: null,
    };
  });
}

function linhaDe(
  a: ArgsDoEditorDeAtributosShopee,
  entrada: readonly AtributoDaEntrada[],
  visivel: AtributoVisivelShopee,
  profundidade: number,
  problemas: readonly ProblemaAtributoShopee[],
): LinhaAtributoShopee {
  const no = visivel.atributo;
  const info = no.attributeInfo;
  const controle = controleDoAtributoShopee(no);
  const valores = entrada.find((x) => x.attributeId === no.attributeId)?.valores ?? [];
  const exibidos = exibir(no, valores, true);
  const personalizados = valores.filter((v) => v.lido.value_id === 0);

  const unico = controle.tipo === 'texto' || controle.tipo === 'lista-ou-texto';
  const digitacao = unico ? a.digitacoes[String(no.attributeId)] : undefined;
  const primeiro = personalizados[0];
  const nomeGuardado = primeiro?.objeto.original_value_name ?? '';
  const textoDigitado = !unico
    ? ''
    : digitacao !== undefined
      ? digitacao.texto
      : primeiro === undefined
        ? ''
        : ehDecimal(no)
          ? decimalShopeeParaTela(nomeGuardado)
          : nomeGuardado;
  const unidadeDigitada = !unico
    ? null
    : digitacao !== undefined
      ? digitacao.unidade
      : (primeiro?.lido.value_unit ?? null);

  const ivt = info?.inputValidationType ?? null;
  const tipoDoValor: TipoDoValorAtributoShopee | null =
    ivt === INPUT_VALIDATION_TYPE_ATRIBUTO_SHOPEE.decimal
      ? 'decimal'
      : ivt === INPUT_VALIDATION_TYPE_ATRIBUTO_SHOPEE.inteiro
        ? 'inteiro'
        : null;

  const maxEscolhas =
    (controle.tipo === 'lista-multipla' || controle.tipo === 'lista-multipla-ou-texto') &&
    controle.max !== null
      ? Math.max(0, controle.max - personalizados.length)
      : null;
  const podeAdicionar =
    ehControleDeChips(controle) && (controle.max === null || valores.length < controle.max);

  return {
    attributeId: no.attributeId,
    atributo: no,
    rotulo: rotuloDoAtributo(no),
    nome: visivel.nome,
    obrigatorio: no.mandatory,
    profundidade,
    pai:
      visivel.pai === null
        ? null
        : {
            attributeId: visivel.pai.atributo.attributeId,
            rotulo: rotuloDoAtributo(visivel.pai.atributo),
            valueId: visivel.pai.valor.valueId,
            valor: rotuloDeValor(visivel.pai.valor),
          },
    controle,
    descricao: info?.introduction ?? null,
    tipoDoValor,
    buscaNaShopee: info?.supportSearchValue === true,
    opcoes: valoresEscolhiveis(no).map((v) => ({ valueId: v.valueId, rotulo: rotuloDeValor(v) })),
    unidades: unidadesDoAtributo(no),
    valores: exibidos,
    escolhidos: valores.filter((v) => v.lido.value_id !== 0).map((v) => v.lido.value_id),
    outroValor:
      controle.tipo === 'lista-ou-texto' && (primeiro !== undefined || digitacao !== undefined),
    textoDigitado,
    unidadeDigitada,
    digitacao: digitacao?.motivo ?? null,
    maxEscolhas,
    podeAdicionar,
    problemas: mensagensDoAtributo(a.arvore, entrada, no, valores, exibidos, problemas),
  };
}

function ehMotivoSemLugar(
  tipo: TipoProblemaAtributoShopee,
): tipo is
  | typeof TIPO_PROBLEMA_ATRIBUTO_SHOPEE.filhoSemPai
  | typeof TIPO_PROBLEMA_ATRIBUTO_SHOPEE.foraDaCategoria {
  return (
    tipo === TIPO_PROBLEMA_ATRIBUTO_SHOPEE.filhoSemPai ||
    tipo === TIPO_PROBLEMA_ATRIBUTO_SHOPEE.foraDaCategoria
  );
}

/**
 * **What the «Atributos» section shows** (ATTR §3.4–3.6) for the editor's
 * state: one {@link LinhaAtributoShopee} per attribute the walk shows over the
 * list (decoded), in walk order, with the validator's rows; the stored
 * attributes the walk hides ({@link EditorDeAtributosShopee.semLugar} — LISTED,
 * never removed by opening the screen, so a freshly loaded draft is not dirty);
 * and what a save would remove from the held base
 * ({@link EditorDeAtributosShopee.removidosAoSalvar}). Pure, total; it changes
 * nothing.
 */
export function linhasDoEditorDeAtributosShopee(
  a: ArgsDoEditorDeAtributosShopee,
): EditorDeAtributosShopee {
  const entrada = lerEntrada(a.lista);
  const lidos = lidosDe(a.lista);
  const visiveis = atributosVisiveisShopee(a.arvore, lidos);
  const problemas = validarAtributosShopee(a.arvore, lidos);

  const profundidades = new Map<number, number>();
  const linhas = visiveis.map((v) => {
    const profundidade =
      v.pai === null ? 0 : (profundidades.get(v.pai.atributo.attributeId) ?? 0) + 1;
    profundidades.set(v.atributo.attributeId, profundidade);
    return linhaDe(
      a,
      entrada,
      v,
      profundidade,
      problemas.filter((p) => p.attributeId === v.atributo.attributeId),
    );
  });

  const noVisivel = new Map(visiveis.map((v) => [v.atributo.attributeId, v.atributo]));
  const noDe = (id: number): AtributoDto | null =>
    noVisivel.get(id) ?? noNaArvore(a.arvore.atributos, id);
  const valoresDe = (id: number): readonly ValorDaEntrada[] =>
    entrada.find((x) => x.attributeId === id)?.valores ?? [];

  const semLugar: ItemDeAtributoShopee[] = [];
  for (const p of problemas) {
    if (!ehMotivoSemLugar(p.tipo)) continue;
    semLugar.push({
      attributeId: p.attributeId,
      rotulo: p.nome,
      valores: exibir(noDe(p.attributeId), valoresDe(p.attributeId), false),
      inteiro: true,
      motivo: p.tipo,
    });
  }

  const removidosAoSalvar: ItemDeAtributoShopee[] = [];
  for (const guardado of lerEntrada(a.guardados)) {
    const no = noDe(guardado.attributeId);
    const rotulo = no !== null ? rotuloDoAtributo(no) : `#${String(guardado.attributeId)}`;
    const presente = entrada.find((x) => x.attributeId === guardado.attributeId);
    if (presente === undefined) {
      removidosAoSalvar.push({
        attributeId: guardado.attributeId,
        rotulo,
        valores: exibir(no, guardado.valores, false),
        inteiro: true,
        motivo: null,
      });
      continue;
    }
    const tipo = tipoDeEntradaShopee(no?.attributeInfo);
    if (!tipo.conhecida || !tipo.multipla) continue;
    const ausentes = valoresAusentes(guardado.valores, presente.valores);
    if (ausentes.length === 0) continue;
    removidosAoSalvar.push({
      attributeId: guardado.attributeId,
      rotulo,
      valores: exibir(no, ausentes, false),
      inteiro: false,
      motivo: null,
    });
  }

  return { linhas, semLugar, removidosAoSalvar };
}
