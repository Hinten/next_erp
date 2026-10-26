import { z } from 'zod';

import { textoUtilizavelShopee } from './faixaShopee';
import type { AtributoDto, AtributoInfoDto, AtributoValorDto } from './taxonomiaShopeeDto';

/**
 * **The Shopee listing ATTRIBUTES — one decoder, one validator** (#1911, D9,
 * P6). The ONE copy of the rules that read a listing's stored `attributes`,
 * turn them into what `add_item` / `update_item` send, and judge them against
 * the category's attribute tree. The publisher (`apps/shopee`'s
 * `montarAnuncio`), the draft route (`anuncios/rascunho.ts`) and the draft
 * projection (`./produto/collection/shopeeRascunho.ts`) decide with these, and
 * the produto's Shopee tab in `apps/web` renders with them — `apps/web` has no
 * dependency edge to `apps/shopee`, so the alternative is a browser copy that
 * drifts toward plausible while both read correct (#1369).
 *
 * Pure and total — no clock, no network, no Firestore.
 *
 * ## The three stored shapes, ONE decoder
 *
 * A `prodshopee` document's `attributes` holds whichever writer wrote it last:
 *
 * | writer | element shape |
 * |---|---|
 * | the publish's read-back and this module's writes | the REQUEST shape `{attribute_id, attribute_value_list: [{value_id, original_value_name?, value_unit?}]}` |
 * | the product import (`produtos/mapeamento.ts`, the item read VERBATIM) | the READ shape — every value carries all three keys, `null` when unset, plus whatever Shopee added |
 * | the legacy Flutter app | a custom value with NO `value_id` at all, only `original_value_name` |
 *
 * {@link lerAtributosArmazenadosShopee} reads all three and answers the
 * REQUEST shape, always; every writer here writes the request shape (D9). No
 * migration: the publish's read-back rewrites the field on every publish.
 *
 * ⚠️ **A legacy value with no `value_id` is SENT** — as a custom value
 * `{value_id: 0, original_value_name}` (Lucas, #1911 Round 3 Q1: the legacy app
 * sent it too). Before P6 the publisher dropped it in silence; a refusal by name
 * is now routable to the attribute editor, while a dropped value on a mandatory
 * attribute only ever read as "missing". A blank name is still dropped — there
 * is nothing to send.
 *
 * ## The tree and what is VISIBLE
 *
 * The hierarchy exists only in the category's tree (`get_attribute_tree`, guide
 * 209 §2.5): a VALUE carries the attributes it unlocks. On the wire parent and
 * child are siblings. {@link atributosVisiveisShopee} is the one walk that says
 * which attributes a given set of chosen values shows; the validator, the
 * draft save and the editor all ask it.
 */

/* -------------------------------------------------------------------------- */
/*                         The request shape (what is sent)                    */
/* -------------------------------------------------------------------------- */

/**
 * One attribute value in the REQUEST shape — what `add_item` / `update_item`
 * send and what every writer stores. Structurally assignable to the package's
 * `ShopeeAttributeValueRequest`.
 *
 * - `value_id: 0` is Shopee's CUSTOM sentinel (guide 211 §2.2), never "absent";
 *   it always carries a non-blank `original_value_name`.
 * - A non-zero `value_id` names a value of the category's list and carries NO
 *   name (the read's name is dropped: the id is the value).
 * - `value_unit` only when there is one.
 */
export interface ValorAtributoShopee {
  readonly value_id: number;
  readonly original_value_name?: string;
  readonly value_unit?: string;
}

/** One attribute in the REQUEST shape, values in stored order. Never an empty list. */
export interface AtributoShopeeRequisicao {
  readonly attribute_id: number;
  readonly attribute_value_list: readonly ValorAtributoShopee[];
}

/* -------------------------------------------------------------------------- */
/*                                The decoder                                  */
/* -------------------------------------------------------------------------- */

/**
 * Which stored shape a decoded value came from. Informational except for
 * `legado-sem-value-id` — the publisher SENDS every origem alike (Q1).
 *
 * - `requisicao` — the request shape;
 * - `leitura` — the import's READ shape: a name beside a non-zero `value_id`,
 *   or a key the request never writes holding `null`;
 * - `legado-sem-value-id` — no `value_id` (absent or `null`) and a usable name:
 *   decoded as a CUSTOM value.
 */
export const origemValorAtributoShopeeSchema = z.enum([
  'requisicao',
  'leitura',
  'legado-sem-value-id',
]);
export type OrigemValorAtributoShopee = z.infer<typeof origemValorAtributoShopeeSchema>;
export const ORIGEM_VALOR_ATRIBUTO_SHOPEE = {
  requisicao: 'requisicao',
  leitura: 'leitura',
  legadoSemValueId: 'legado-sem-value-id',
} as const satisfies Record<string, OrigemValorAtributoShopee>;

/** One decoded value: the request-shape value, and where it came from. */
export interface ValorAtributoLidoShopee {
  readonly valor: ValorAtributoShopee;
  readonly origem: OrigemValorAtributoShopee;
}

/** One decoded attribute: its id and its usable values (never empty). */
export interface AtributoLidoShopee {
  readonly attributeId: number;
  readonly valores: readonly ValorAtributoLidoShopee[];
}

/**
 * Why the decoder dropped something:
 *
 * - `entrada-ilegivel` — an element that is not an object, or carries no
 *   integer `attribute_id`;
 * - `valor-ilegivel` — a value that is not an object, or whose `value_id` is
 *   present but not an integer ≥ 0 (`'55'`, `1.5`, `-1`, `true`) — never
 *   coerced;
 * - `personalizado-sem-nome` — a custom value (`value_id: 0`, or the legacy
 *   one with none) whose name is absent or blank: nothing to send;
 * - `sem-valores` — an attribute left with no usable value (Shopee reads an
 *   empty `attribute_value_list` as a DELETION, so it is never sent empty);
 * - `atributo-repetido` — a later element for an id already read (FIRST wins).
 */
export const motivoDescarteAtributoShopeeSchema = z.enum([
  'entrada-ilegivel',
  'valor-ilegivel',
  'personalizado-sem-nome',
  'sem-valores',
  'atributo-repetido',
]);
export type MotivoDescarteAtributoShopee = z.infer<typeof motivoDescarteAtributoShopeeSchema>;
export const MOTIVO_DESCARTE_ATRIBUTO_SHOPEE = {
  entradaIlegivel: 'entrada-ilegivel',
  valorIlegivel: 'valor-ilegivel',
  personalizadoSemNome: 'personalizado-sem-nome',
  semValores: 'sem-valores',
  atributoRepetido: 'atributo-repetido',
} as const satisfies Record<string, MotivoDescarteAtributoShopee>;

/**
 * One thing the decoder dropped. `posicao` is the element's index in the
 * stored list; `posicaoValor` the value's index inside it (`null` when the
 * whole element went); `attributeId` `null` when the element had none.
 */
export interface DescarteAtributoShopee {
  readonly posicao: number;
  readonly posicaoValor: number | null;
  readonly attributeId: number | null;
  readonly motivo: MotivoDescarteAtributoShopee;
}

/** What {@link lerAtributosArmazenadosShopee} answers. */
export interface AtributosLidosShopee {
  readonly atributos: readonly AtributoLidoShopee[];
  readonly descartes: readonly DescarteAtributoShopee[];
}

type LeituraDeValor =
  | { readonly lido: ValorAtributoLidoShopee }
  | { readonly motivo: MotivoDescarteAtributoShopee };

function ehRegistro(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/**
 * One stored value, read tolerantly — THE value rule, shared by the decoder
 * and the write schema's normalisation, so what is written is exactly what is
 * read back.
 *
 * Name and unit go through {@link textoUtilizavelShopee} (trimmed, blank ⇒
 * absent). `value_id` must be an integer ≥ 0 — a NUMBER: `'55'` is dropped,
 * never coerced. Absent or `null` with a usable name is the legacy custom
 * value (Q1).
 */
function lerValor(bruto: unknown): LeituraDeValor {
  if (!ehRegistro(bruto)) return { motivo: MOTIVO_DESCARTE_ATRIBUTO_SHOPEE.valorIlegivel };
  const bruta = bruto.value_id;
  const nome = textoUtilizavelShopee(bruto.original_value_name as string | null | undefined);
  const unidade = textoUtilizavelShopee(bruto.value_unit as string | null | undefined);
  const comUnidade = unidade !== null ? { value_unit: unidade } : {};

  if (bruta === undefined || bruta === null) {
    if (nome === null) return { motivo: MOTIVO_DESCARTE_ATRIBUTO_SHOPEE.personalizadoSemNome };
    return {
      lido: {
        valor: { value_id: 0, original_value_name: nome, ...comUnidade },
        origem: ORIGEM_VALOR_ATRIBUTO_SHOPEE.legadoSemValueId,
      },
    };
  }
  if (typeof bruta !== 'number' || !Number.isInteger(bruta) || bruta < 0) {
    return { motivo: MOTIVO_DESCARTE_ATRIBUTO_SHOPEE.valorIlegivel };
  }
  // `0` is the CUSTOM sentinel and then the name is REQUIRED: a custom value
  // with no name is a value Shopee refuses, so it is dropped here and the
  // attribute may end up missing — which is how it reaches the publisher's
  // `atributo-obrigatorio` instead of a wire rejection.
  if (bruta === 0 && nome === null) {
    return { motivo: MOTIVO_DESCARTE_ATRIBUTO_SHOPEE.personalizadoSemNome };
  }
  const deLeitura =
    (bruta !== 0 && 'original_value_name' in bruto) ||
    bruto.original_value_name === null ||
    bruto.value_unit === null;
  return {
    lido: {
      valor: {
        value_id: bruta,
        ...(bruta === 0 && nome !== null ? { original_value_name: nome } : {}),
        ...comUnidade,
      },
      origem: deLeitura
        ? ORIGEM_VALOR_ATRIBUTO_SHOPEE.leitura
        : ORIGEM_VALOR_ATRIBUTO_SHOPEE.requisicao,
    },
  };
}

/**
 * **THE decoder** of a link's stored `attributes` (#1911, D9) — total over any
 * value (a non-array reads as empty).
 *
 * | stored | decoded |
 * |---|---|
 * | a value `{value_id ≥ 1, …}` (request or read shape) | `{value_id}` + `value_unit` when usable; a read's name is DROPPED |
 * | `{value_id: 0, original_value_name: non-blank}` | `{0, name (trimmed), unit?}` |
 * | `{value_id: 0}` with a blank or absent name | dropped (`personalizado-sem-nome`) |
 * | NO `value_id` (absent / `null`) + a non-blank name — the legacy custom value | **`{value_id: 0, original_value_name, value_unit?}`**, origem `legado-sem-value-id` (Q1: SENT) |
 * | `value_id` not an integer ≥ 0 (`'55'`, `1.5`, `-1`) | dropped, never coerced |
 * | an element with no integer `attribute_id`, a non-object | dropped |
 * | an attribute left with no usable value | dropped — never sent empty |
 * | two elements with one `attribute_id` | the FIRST that has a usable value wins |
 *
 * Stored order is kept. For every input the publisher accepted before P6, the
 * request list ({@link atributosParaRequisicaoShopee}) is byte-identical to
 * what it sent; the one change is the legacy row above.
 */
export function lerAtributosArmazenadosShopee(bruto: unknown): AtributosLidosShopee {
  const atributos: AtributoLidoShopee[] = [];
  const descartes: DescarteAtributoShopee[] = [];
  const vistos = new Set<number>();
  const lista: readonly unknown[] = Array.isArray(bruto) ? bruto : [];

  lista.forEach((elemento, posicao) => {
    if (!ehRegistro(elemento)) {
      descartes.push({
        posicao,
        posicaoValor: null,
        attributeId: null,
        motivo: MOTIVO_DESCARTE_ATRIBUTO_SHOPEE.entradaIlegivel,
      });
      return;
    }
    const id = elemento.attribute_id;
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      descartes.push({
        posicao,
        posicaoValor: null,
        attributeId: null,
        motivo: MOTIVO_DESCARTE_ATRIBUTO_SHOPEE.entradaIlegivel,
      });
      return;
    }
    const brutos: readonly unknown[] = Array.isArray(elemento.attribute_value_list)
      ? elemento.attribute_value_list
      : [];
    const valores: ValorAtributoLidoShopee[] = [];
    brutos.forEach((valorBruto, posicaoValor) => {
      const leitura = lerValor(valorBruto);
      if ('lido' in leitura) valores.push(leitura.lido);
      else descartes.push({ posicao, posicaoValor, attributeId: id, motivo: leitura.motivo });
    });
    // An element with nothing usable never claims its id: a later element for
    // the same attribute that DOES carry a value is the one sent.
    if (valores.length === 0) {
      descartes.push({
        posicao,
        posicaoValor: null,
        attributeId: id,
        motivo: MOTIVO_DESCARTE_ATRIBUTO_SHOPEE.semValores,
      });
      return;
    }
    if (vistos.has(id)) {
      descartes.push({
        posicao,
        posicaoValor: null,
        attributeId: id,
        motivo: MOTIVO_DESCARTE_ATRIBUTO_SHOPEE.atributoRepetido,
      });
      return;
    }
    vistos.add(id);
    atributos.push({ attributeId: id, valores });
  });

  return { atributos, descartes };
}

/** One decoded attribute in the request shape. */
function requisicaoDe(lido: AtributoLidoShopee): AtributoShopeeRequisicao {
  return {
    attribute_id: lido.attributeId,
    attribute_value_list: lido.valores.map((v) => v.valor),
  };
}

/**
 * The decoded attributes as the REQUEST list `add_item` / `update_item` send,
 * in the given order. Every origem is sent alike — the legacy no-`value_id`
 * value included (Q1).
 */
export function atributosParaRequisicaoShopee(
  lidos: readonly AtributoLidoShopee[],
): AtributoShopeeRequisicao[] {
  return lidos.map(requisicaoDe);
}

/* -------------------------------------------------------------------------- */
/*                     The WRITE schema (the draft route's body)               */
/* -------------------------------------------------------------------------- */

/** The 400 when a custom value (`value_id: 0`) has no usable name. */
export const MSG_PERSONALIZADO_SEM_NOME_ATRIBUTO_SHOPEE =
  'um valor personalizado (value_id 0) precisa de original_value_name não vazio.';

/** The 400 when a value of the list (`value_id` ≠ 0) carries a name — the READ shape sent as a write. */
export const MSG_NOME_EM_VALOR_DA_LISTA_ATRIBUTO_SHOPEE =
  'original_value_name só acompanha um valor personalizado (value_id 0): um valor da lista é o seu value_id.';

/** The 400 when two entries of one list name the same attribute. */
export const MSG_ATRIBUTO_REPETIDO_SHOPEE =
  'cada attribute_id aparece uma única vez na lista de atributos.';

const valorAtributoShopeeRequisicaoSchema = z
  .strictObject({
    value_id: z.number().int().nonnegative(),
    // `null` ≡ absent: normalised away below, never stored.
    original_value_name: z.string().nullable().optional(),
    value_unit: z.string().nullable().optional(),
  })
  .superRefine((valor, ctx) => {
    if (valor.value_id === 0) {
      if (textoUtilizavelShopee(valor.original_value_name) === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['original_value_name'],
          message: MSG_PERSONALIZADO_SEM_NOME_ATRIBUTO_SHOPEE,
        });
      }
    } else if (valor.original_value_name !== undefined && valor.original_value_name !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['original_value_name'],
        message: MSG_NOME_EM_VALOR_DA_LISTA_ATRIBUTO_SHOPEE,
      });
    }
  })
  .transform((valor, ctx): ValorAtributoShopee => {
    // THE value rule ({@link lerValor}): the stored value is exactly what the
    // decoder reads back — the name trimmed, a blank or `null` unit omitted.
    const leitura = lerValor(valor);
    if ('lido' in leitura) return leitura.lido.valor;
    // Unreachable (the checks above refuse every value the rule drops) — and
    // closed if it ever is: a value the decoder would drop is never written.
    ctx.addIssue({ code: 'custom', message: MSG_PERSONALIZADO_SEM_NOME_ATRIBUTO_SHOPEE });
    return z.NEVER;
  });

/**
 * **One attribute as a draft WRITE accepts it** (#1911, D9) — strictly the
 * REQUEST shape, normalised to exactly what {@link lerAtributosArmazenadosShopee}
 * reads back:
 *
 * - `attribute_id` a positive safe integer; `attribute_value_list` at least ONE
 *   value (an empty list is a deletion at Shopee, never a write);
 * - each value: `value_id` a safe integer ≥ 0 (a NUMBER — `'55'` is a 400);
 *   `value_id: 0` REQUIRES a non-blank `original_value_name`
 *   ({@link MSG_PERSONALIZADO_SEM_NOME_ATRIBUTO_SHOPEE}); a non-zero one
 *   REFUSES any name ({@link MSG_NOME_EM_VALOR_DA_LISTA_ATRIBUTO_SHOPEE} — the
 *   import's READ shape, which names every value, is not a write);
 *   `value_unit` a string; a `null` name or unit reads as ABSENT;
 * - strict at both levels: an unknown key (the read's `original_attribute_name`,
 *   `is_mandatory`, …) is a 400; a value with no `value_id` (the legacy one) is
 *   a 400 — a write always names the custom sentinel `0`;
 * - stored as: the name TRIMMED, a blank or `null` `value_unit` OMITTED, a
 *   `null` name OMITTED.
 */
export const atributoShopeeRequisicaoSchema = z.strictObject({
  attribute_id: z.number().int().positive(),
  attribute_value_list: z.array(valorAtributoShopeeRequisicaoSchema).min(1),
});

/**
 * A whole attribute LIST as a draft write accepts it — every element through
 * {@link atributoShopeeRequisicaoSchema}, and each `attribute_id` once
 * ({@link MSG_ATRIBUTO_REPETIDO_SHOPEE}): the decoder keeps only the first of
 * two, so a repeated id would be written and then silently not read.
 */
export const atributosShopeeRequisicaoSchema = z
  .array(atributoShopeeRequisicaoSchema)
  .superRefine((lista, ctx) => {
    const vistos = new Set<number>();
    lista.forEach((atributo, i) => {
      if (vistos.has(atributo.attribute_id)) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'attribute_id'],
          message: MSG_ATRIBUTO_REPETIDO_SHOPEE,
        });
      }
      vistos.add(atributo.attribute_id);
    });
  });

/* -------------------------------------------------------------------------- */
/*                          The input type (guide 209 §2.2)                    */
/* -------------------------------------------------------------------------- */

/** Shopee's `input_type` values (guide 209 §2.2). */
export const INPUT_TYPE_ATRIBUTO_SHOPEE = {
  listaUnica: 1,
  listaUnicaOuPersonalizado: 2,
  textoLivre: 3,
  listaMultipla: 4,
  listaMultiplaOuPersonalizado: 5,
} as const;

/** Shopee's `format_type` meaning "the value needs a unit" (guide 209 §2.4). */
export const FORMAT_TYPE_COM_UNIDADE_SHOPEE = 2;

/** Shopee's `input_validation_type` values the validator reads (guide 209 §2.3). */
export const INPUT_VALIDATION_TYPE_ATRIBUTO_SHOPEE = {
  inteiro: 1,
  decimal: 3,
  data: 4,
} as const;

/**
 * What an attribute's `input_type` allows — ONE reading of guide 209 §2.2:
 *
 * | `inputType` | múltipla | aceita personalizado | lista fornecida |
 * |---|---|---|---|
 * | 1 | não | não | sim |
 * | 2 | não | sim | sim |
 * | 3 | não | sim (só) | não |
 * | 4 | sim | não | sim |
 * | 5 | sim | sim | sim |
 *
 * Anything else (`null`, absent `attributeInfo`, an undocumented number) is
 * `{conhecida: false}`: the validator then checks only that a mandatory
 * attribute has a value.
 */
export type EntradaAtributoShopee =
  | {
      readonly conhecida: true;
      readonly multipla: boolean;
      readonly aceitaPersonalizado: boolean;
      readonly listaFornecida: boolean;
    }
  | { readonly conhecida: false };

const DESCONHECIDA: EntradaAtributoShopee = { conhecida: false };

/** {@link EntradaAtributoShopee} of one attribute's `attributeInfo`. Pure, total. */
export function tipoDeEntradaShopee(
  info: AtributoInfoDto | null | undefined,
): EntradaAtributoShopee {
  const inputType = info?.inputType;
  if (inputType === null || inputType === undefined) return DESCONHECIDA;
  switch (inputType) {
    case INPUT_TYPE_ATRIBUTO_SHOPEE.listaUnica:
      return { conhecida: true, multipla: false, aceitaPersonalizado: false, listaFornecida: true };
    case INPUT_TYPE_ATRIBUTO_SHOPEE.listaUnicaOuPersonalizado:
      return { conhecida: true, multipla: false, aceitaPersonalizado: true, listaFornecida: true };
    case INPUT_TYPE_ATRIBUTO_SHOPEE.textoLivre:
      return { conhecida: true, multipla: false, aceitaPersonalizado: true, listaFornecida: false };
    case INPUT_TYPE_ATRIBUTO_SHOPEE.listaMultipla:
      return { conhecida: true, multipla: true, aceitaPersonalizado: false, listaFornecida: true };
    case INPUT_TYPE_ATRIBUTO_SHOPEE.listaMultiplaOuPersonalizado:
      return { conhecida: true, multipla: true, aceitaPersonalizado: true, listaFornecida: true };
    default:
      return DESCONHECIDA;
  }
}

/* -------------------------------------------------------------------------- */
/*                         The visible-given-values walk                       */
/* -------------------------------------------------------------------------- */

/**
 * A category's attribute tree as the attribute route answers it (the shape
 * `apps/shopee`'s `projetarAtributos` builds). `truncated: true` ⇒ the
 * projection's depth cap dropped a level: the tree is NOT complete.
 */
export interface ArvoreAtributosShopee {
  readonly atributos: readonly AtributoDto[];
  readonly truncated: boolean;
}

/** One attribute the chosen values make visible, with the value that unlocked it. */
export interface AtributoVisivelShopee {
  readonly atributo: AtributoDto;
  /** `null` for a ROOT; else the parent attribute and the CHOSEN value that unlocked this one. */
  readonly pai: { readonly atributo: AtributoDto; readonly valor: AtributoValorDto } | null;
  /**
   * The name an operator reads: a root's `name`, else `#<attributeId>`; a
   * child's `"<filho> (em <pai>: <valor>)"`, each part named the same way
   * (`#<valueId>` for an unnamed value). The publisher's refusal and the
   * editor's pendência both print THIS.
   */
  readonly nome: string;
}

function nomeDoAtributo(atributo: AtributoDto): string {
  return atributo.name ?? `#${String(atributo.attributeId)}`;
}

function nomeDoValor(valor: AtributoValorDto): string {
  return valor.name ?? `#${String(valor.valueId)}`;
}

/** The FIRST decoded entry per attribute id (the decoder's own rule, for hand-built lists too). */
function primeiroPorId(lidos: readonly AtributoLidoShopee[]): Map<number, AtributoLidoShopee> {
  const porId = new Map<number, AtributoLidoShopee>();
  for (const lido of lidos) {
    if (!porId.has(lido.attributeId)) porId.set(lido.attributeId, lido);
  }
  return porId;
}

/**
 * **The visible-given-values walk** (#1911, D9; guide 209 §2.5) — which
 * attributes of the category the decoded values SHOW, in tree order:
 *
 * - every ROOT attribute is visible (a repeated root id: the first);
 * - for each visible attribute, each value of the tree that is CHOSEN — a
 *   decoded value with that `value_id`, never the custom `0` — makes its
 *   `childAttributeList` visible, recursively; a multi-select unions the
 *   children of every chosen value;
 * - the children of an UNCHOSEN value are invisible;
 * - an id is visible ONCE: the first occurrence wins (a root is always a
 *   root), which is also what bounds the walk.
 *
 * Order: depth first — a root, then what its chosen values unlock (in the
 * tree's value order), then the next root. Pure, total.
 */
export function atributosVisiveisShopee(
  arvore: ArvoreAtributosShopee,
  lidos: readonly AtributoLidoShopee[],
): AtributoVisivelShopee[] {
  const escolhidos = new Map<number, Set<number>>();
  for (const lido of primeiroPorId(lidos).values()) {
    escolhidos.set(
      lido.attributeId,
      new Set(lido.valores.map((v) => v.valor.value_id).filter((id) => id !== 0)),
    );
  }

  const saida: AtributoVisivelShopee[] = [];
  const vistos = new Set<number>(arvore.atributos.map((a) => a.attributeId));

  const visitar = (atributo: AtributoDto, pai: AtributoVisivelShopee['pai']): void => {
    const nome =
      pai === null
        ? nomeDoAtributo(atributo)
        : `${nomeDoAtributo(atributo)} (em ${nomeDoAtributo(pai.atributo)}: ${nomeDoValor(pai.valor)})`;
    saida.push({ atributo, pai, nome });
    const doAtributo = escolhidos.get(atributo.attributeId);
    if (doAtributo === undefined) return;
    for (const valor of atributo.attributeValueList) {
      if (valor.valueId === 0 || !doAtributo.has(valor.valueId)) continue;
      for (const filho of valor.childAttributeList) {
        if (vistos.has(filho.attributeId)) continue;
        vistos.add(filho.attributeId);
        visitar(filho, { atributo, valor });
      }
    }
  };

  const raizes = new Set<number>();
  for (const raiz of arvore.atributos) {
    if (raizes.has(raiz.attributeId)) continue;
    raizes.add(raiz.attributeId);
    visitar(raiz, null);
  }
  return saida;
}

/** The first node of the tree with this id, anywhere in it (visible or not), depth first. */
function noDaArvore(atributos: readonly AtributoDto[], id: number): AtributoDto | null {
  for (const atributo of atributos) {
    if (atributo.attributeId === id) return atributo;
    for (const valor of atributo.attributeValueList) {
      const achado = noDaArvore(valor.childAttributeList, id);
      if (achado !== null) return achado;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*                                The dates                                    */
/* -------------------------------------------------------------------------- */

/** Shopee's `date_format_type` (`get_attribute_tree`): `0` = DD/MM/YYYY, `1` = MM/YYYY. */
export const DATE_FORMAT_TYPE_ATRIBUTO_SHOPEE = {
  diaMesAno: 0,
  mesAno: 1,
} as const;

/**
 * A date attribute's value, read: the calendar date and the FORM it was
 * stored in — `timestamp` (Unix SECONDS, the form a write must send, guide 209
 * §2.3) or `leitura` (`MM/YYYY` / `DD/MM/YYYY`, the form `get_item_base_info`
 * answers). `dia` is `null` for a month-only date.
 */
export interface DataDeAtributoShopee {
  readonly ano: number;
  readonly mes: number;
  readonly dia: number | null;
  readonly forma: 'timestamp' | 'leitura';
}

function bissexto(ano: number): boolean {
  return (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0;
}

const DIAS_NO_MES = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** A real calendar date (year ≥ 1). Pure arithmetic — no `Date`, no zone. */
function dataCivilValida(ano: number, mes: number, dia: number): boolean {
  if (![ano, mes, dia].every(Number.isInteger) || ano < 1 || mes < 1 || mes > 12 || dia < 1) {
    return false;
  }
  const dias = mes === 2 && bissexto(ano) ? 29 : (DIAS_NO_MES[mes - 1] ?? 0);
  return dia <= dias;
}

/**
 * ⚠️ **THE date convention — ONE place, UNVERIFIED** until Lucas's BR captures
 * (guide captures 1–3) show a stored date's `original_value_name` and the
 * timestamp Seller Centre writes. Guide 209 §2.3 says a write sends a Unix
 * timestamp and a read answers `MM/YYYY` / `DD/MM/YYYY`; it does not say WHICH
 * instant of the day.
 *
 * Chosen: **12:00 UTC** of the date (day 1 for a month-only one) — the same
 * calendar date in every zone from UTC−11 to UTC+11 (BRT, UTC, Shopee's SG),
 * so no zone is ever read. A timestamp is read back as the UTC calendar date of
 * its instant. A capture that says otherwise amends THESE TWO functions and
 * nothing else.
 */
const HORA_UTC_DA_DATA_SHOPEE = 12;

function segundosDaDataCivil(ano: number, mes: number, dia: number): number {
  return Date.UTC(ano, mes - 1, dia, HORA_UTC_DA_DATA_SHOPEE) / 1000;
}

function dataCivilDosSegundos(
  segundos: number,
): { readonly ano: number; readonly mes: number; readonly dia: number } | null {
  const instante = new Date(segundos * 1000);
  if (Number.isNaN(instante.getTime())) return null;
  return {
    ano: instante.getUTCFullYear(),
    mes: instante.getUTCMonth() + 1,
    dia: instante.getUTCDate(),
  };
}

const PADRAO_TIMESTAMP = /^\d+$/;
const PADRAO_MES_ANO = /^(\d{2})\/(\d{4})$/;
const PADRAO_DIA_MES_ANO = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/**
 * Read a date attribute's value (its `original_value_name`) — the editor's
 * reading; the publisher sends a stored date VERBATIM (Q-DB2, until the
 * captures settle the write form).
 *
 * - digits only ⇒ `timestamp`, Unix SECONDS, read as the UTC calendar date
 *   (`dia: null` when `dateFormatType` is month-only);
 * - `MM/YYYY` ⇒ `leitura`, `dia: null`; `DD/MM/YYYY` ⇒ `leitura`;
 * - anything else — and a date that is not a real calendar date
 *   (`31/06/2021`) — ⇒ `null`.
 *
 * The text is trimmed first ({@link textoUtilizavelShopee}). Pure, total.
 */
export function lerDataDeAtributoShopee(
  nome: string | null | undefined,
  dateFormatType: number | null | undefined,
): DataDeAtributoShopee | null {
  const texto = textoUtilizavelShopee(nome);
  if (texto === null) return null;

  if (PADRAO_TIMESTAMP.test(texto)) {
    const segundos = Number(texto);
    if (!Number.isSafeInteger(segundos)) return null;
    const civil = dataCivilDosSegundos(segundos);
    if (civil === null) return null;
    return {
      ano: civil.ano,
      mes: civil.mes,
      dia: dateFormatType === DATE_FORMAT_TYPE_ATRIBUTO_SHOPEE.mesAno ? null : civil.dia,
      forma: 'timestamp',
    };
  }

  const mesAno = PADRAO_MES_ANO.exec(texto);
  if (mesAno !== null) {
    const mes = Number(mesAno[1]);
    const ano = Number(mesAno[2]);
    return dataCivilValida(ano, mes, 1) ? { ano, mes, dia: null, forma: 'leitura' } : null;
  }

  const diaMesAno = PADRAO_DIA_MES_ANO.exec(texto);
  if (diaMesAno !== null) {
    const dia = Number(diaMesAno[1]);
    const mes = Number(diaMesAno[2]);
    const ano = Number(diaMesAno[3]);
    return dataCivilValida(ano, mes, dia) ? { ano, mes, dia, forma: 'leitura' } : null;
  }

  return null;
}

/**
 * The WRITE form of a date attribute's value: the Unix SECONDS, as a string, of
 * 12:00 UTC of that date (day 1 when `dia` is `null`) — see the convention
 * above (UNVERIFIED until the BR captures).
 *
 * `null` when the date is not a real calendar date, or is before 1970 (a
 * negative timestamp is no form Shopee documents) or after 9999. Pure, total.
 */
export function timestampDeDataShopee(data: {
  readonly ano: number;
  readonly mes: number;
  readonly dia: number | null;
}): string | null {
  const dia = data.dia ?? 1;
  if (!dataCivilValida(data.ano, data.mes, dia) || data.ano < 1970 || data.ano > 9999) {
    return null;
  }
  return String(segundosDaDataCivil(data.ano, data.mes, dia));
}

/* -------------------------------------------------------------------------- */
/*                                The validator                                */
/* -------------------------------------------------------------------------- */

/**
 * What the validator can find wrong with one attribute:
 *
 * | `tipo` | rule |
 * |---|---|
 * | `obrigatorio-ausente` | VISIBLE ∧ `mandatory` ∧ no decoded value — a root, or a CHILD under a chosen value (B1) |
 * | `obrigatorio-requer-busca` | an EXTRA row beside `obrigatorio-ausente` (never instead of it) when the attribute takes no custom value and Shopee serves its values by SEARCH (`supportSearchValue`) — the ERP cannot list them: Seller Centre |
 * | `personalizado-nao-permitido` | a custom value (`value_id 0`) where the input type takes none (1, 4) |
 * | `valor-fora-da-lista` | a `value_id ≠ 0` not in the tree's list — NOT checked when `supportSearchValue` (the inline list is not the value source) |
 * | `valores-demais` | a single-select with > 1 value; a multi-select with > `maxValueCount` (inclusive; `null` = no cap) |
 * | `unidade-invalida` | `formatType` 2 ∧ a custom value whose `value_unit` is absent or not in `attributeUnitList` — EXACT match (`'cm'` ≠ `'CM'`) |
 * | `tipo-de-valor` | a custom name that is not an integer (`inputValidationType` 1, `^-?\d+$`), a decimal (3, `^-?\d+(\.\d+)?$`, dot) or a date (4) |
 * | `data-em-formato-de-leitura` | a date (4) stored in the READ form (`06/2021`) — a write sends a timestamp |
 * | `filho-sem-pai` | a stored attribute of the tree that the chosen values do not show |
 * | `fora-da-categoria` | a stored attribute the tree does not hold at all |
 */
export const tipoProblemaAtributoShopeeSchema = z.enum([
  'obrigatorio-ausente',
  'obrigatorio-requer-busca',
  'personalizado-nao-permitido',
  'valor-fora-da-lista',
  'valores-demais',
  'unidade-invalida',
  'tipo-de-valor',
  'data-em-formato-de-leitura',
  'filho-sem-pai',
  'fora-da-categoria',
]);
export type TipoProblemaAtributoShopee = z.infer<typeof tipoProblemaAtributoShopeeSchema>;
export const TIPO_PROBLEMA_ATRIBUTO_SHOPEE = {
  obrigatorioAusente: 'obrigatorio-ausente',
  obrigatorioRequerBusca: 'obrigatorio-requer-busca',
  personalizadoNaoPermitido: 'personalizado-nao-permitido',
  valorForaDaLista: 'valor-fora-da-lista',
  valoresDemais: 'valores-demais',
  unidadeInvalida: 'unidade-invalida',
  tipoDeValor: 'tipo-de-valor',
  dataEmFormatoDeLeitura: 'data-em-formato-de-leitura',
  filhoSemPai: 'filho-sem-pai',
  foraDaCategoria: 'fora-da-categoria',
} as const satisfies Record<string, TipoProblemaAtributoShopee>;

/** One problem: the attribute, the name an operator reads ({@link AtributoVisivelShopee}'s `nome`), and what is wrong. */
export interface ProblemaAtributoShopee {
  readonly attributeId: number;
  readonly nome: string;
  readonly tipo: TipoProblemaAtributoShopee;
}

const PADRAO_INTEIRO = /^-?\d+$/;
const PADRAO_DECIMAL = /^-?\d+(\.\d+)?$/;

/** Is a custom value's NAME of the attribute's declared value type? `null` = it is. */
function problemaDoTipoDeValor(
  nome: string,
  info: AtributoInfoDto,
): TipoProblemaAtributoShopee | null {
  const tipo = info.inputValidationType;
  if (tipo === null) return null;
  switch (tipo) {
    case INPUT_VALIDATION_TYPE_ATRIBUTO_SHOPEE.inteiro:
      return PADRAO_INTEIRO.test(nome) ? null : TIPO_PROBLEMA_ATRIBUTO_SHOPEE.tipoDeValor;
    case INPUT_VALIDATION_TYPE_ATRIBUTO_SHOPEE.decimal:
      return PADRAO_DECIMAL.test(nome) ? null : TIPO_PROBLEMA_ATRIBUTO_SHOPEE.tipoDeValor;
    case INPUT_VALIDATION_TYPE_ATRIBUTO_SHOPEE.data: {
      const data = lerDataDeAtributoShopee(nome, info.dateFormatType);
      if (data === null) return TIPO_PROBLEMA_ATRIBUTO_SHOPEE.tipoDeValor;
      return data.forma === 'leitura' ? TIPO_PROBLEMA_ATRIBUTO_SHOPEE.dataEmFormatoDeLeitura : null;
    }
    default:
      return null;
  }
}

/**
 * **THE validator** (#1911, D9) — every problem of the decoded attributes
 * against the category's tree, as {@link tipoProblemaAtributoShopeeSchema}'s
 * table says, at most one row per (attribute, `tipo`), visible attributes in
 * walk order ({@link atributosVisiveisShopee}) and then the stored ones the
 * walk does not show, in stored order.
 *
 * - An attribute whose input type is unknown ({@link tipoDeEntradaShopee}) is
 *   checked ONLY for "mandatory has a value".
 * - ⚠️ **A truncated tree (`truncated: true`) is judged LENIENTLY**: no
 *   `filho-sem-pai` / `fora-da-categoria` (the attribute may sit below the
 *   cut), and nothing below the cut is visible to be found missing — a
 *   problem is never raised from missing knowledge.
 *
 * Two callers act on DIFFERENT subsets of ONE rule set (not a #1369 copy): the
 * publisher refuses only `obrigatorio-ausente` (`atributo-obrigatorio`) — every
 * other kind reaches Shopee, which names it — while the editor shows them all.
 * Pure, total.
 */
export function validarAtributosShopee(
  arvore: ArvoreAtributosShopee,
  lidos: readonly AtributoLidoShopee[],
): ProblemaAtributoShopee[] {
  const porId = primeiroPorId(lidos);
  const problemas: ProblemaAtributoShopee[] = [];
  const visiveis = new Set<number>();

  for (const { atributo, nome } of atributosVisiveisShopee(arvore, lidos)) {
    visiveis.add(atributo.attributeId);
    const tipos = new Set<TipoProblemaAtributoShopee>();
    const valores = (porId.get(atributo.attributeId)?.valores ?? []).map((v) => v.valor);
    const info = atributo.attributeInfo;
    const entrada = tipoDeEntradaShopee(info);

    if (valores.length === 0) {
      if (atributo.mandatory) {
        tipos.add(TIPO_PROBLEMA_ATRIBUTO_SHOPEE.obrigatorioAusente);
        if (
          entrada.conhecida &&
          !entrada.aceitaPersonalizado &&
          info?.supportSearchValue === true
        ) {
          tipos.add(TIPO_PROBLEMA_ATRIBUTO_SHOPEE.obrigatorioRequerBusca);
        }
      }
    } else if (entrada.conhecida && info !== null) {
      const personalizados = valores.filter((v) => v.value_id === 0);

      if (!entrada.aceitaPersonalizado && personalizados.length > 0) {
        tipos.add(TIPO_PROBLEMA_ATRIBUTO_SHOPEE.personalizadoNaoPermitido);
      }
      if (info.supportSearchValue !== true) {
        const daLista = new Set(atributo.attributeValueList.map((v) => v.valueId));
        if (valores.some((v) => v.value_id !== 0 && !daLista.has(v.value_id))) {
          tipos.add(TIPO_PROBLEMA_ATRIBUTO_SHOPEE.valorForaDaLista);
        }
      }
      const demais = entrada.multipla
        ? info.maxValueCount !== null && valores.length > info.maxValueCount
        : valores.length > 1;
      if (demais) tipos.add(TIPO_PROBLEMA_ATRIBUTO_SHOPEE.valoresDemais);

      if (info.formatType === FORMAT_TYPE_COM_UNIDADE_SHOPEE) {
        const unidades = info.attributeUnitList;
        const semUnidadeValida = personalizados.some(
          (v) =>
            v.value_unit === undefined || (unidades !== null && !unidades.includes(v.value_unit)),
        );
        if (semUnidadeValida) tipos.add(TIPO_PROBLEMA_ATRIBUTO_SHOPEE.unidadeInvalida);
      }
      for (const v of personalizados) {
        const problema = problemaDoTipoDeValor(v.original_value_name ?? '', info);
        if (problema !== null) tipos.add(problema);
      }
    }

    for (const tipo of tipos) problemas.push({ attributeId: atributo.attributeId, nome, tipo });
  }

  if (!arvore.truncated) {
    for (const lido of porId.values()) {
      if (visiveis.has(lido.attributeId) || lido.valores.length === 0) continue;
      const no = noDaArvore(arvore.atributos, lido.attributeId);
      problemas.push({
        attributeId: lido.attributeId,
        nome: no === null ? `#${String(lido.attributeId)}` : nomeDoAtributo(no),
        tipo:
          no === null
            ? TIPO_PROBLEMA_ATRIBUTO_SHOPEE.foraDaCategoria
            : TIPO_PROBLEMA_ATRIBUTO_SHOPEE.filhoSemPai,
      });
    }
  }

  return problemas;
}

/* -------------------------------------------------------------------------- */
/*                        What a draft save writes                             */
/* -------------------------------------------------------------------------- */

/**
 * The attribute list a draft SAVE writes (#1911, D9) — the editor's `patch`:
 * the REQUEST shape, VISIBLE attributes only ({@link atributosVisiveisShopee}),
 * in walk order. This is where an attribute whose parent value was unchosen,
 * and another category's attributes, are dropped — never in the publisher,
 * which sends what is stored.
 *
 * ⚠️ On a TRUNCATED tree the stored attributes the walk does not show are KEPT
 * (appended, in stored order): they may sit below the cut, and a save never
 * deletes from missing knowledge.
 *
 * Pure, total.
 */
export function atributosParaGravarShopee(
  arvore: ArvoreAtributosShopee,
  lidos: readonly AtributoLidoShopee[],
): AtributoShopeeRequisicao[] {
  const porId = primeiroPorId(lidos);
  const saida: AtributoShopeeRequisicao[] = [];
  const gravados = new Set<number>();
  for (const { atributo } of atributosVisiveisShopee(arvore, lidos)) {
    const lido = porId.get(atributo.attributeId);
    if (lido === undefined || lido.valores.length === 0) continue;
    gravados.add(lido.attributeId);
    saida.push(requisicaoDe(lido));
  }
  if (arvore.truncated) {
    for (const lido of porId.values()) {
      if (gravados.has(lido.attributeId) || lido.valores.length === 0) continue;
      saida.push(requisicaoDe(lido));
    }
  }
  return saida;
}
