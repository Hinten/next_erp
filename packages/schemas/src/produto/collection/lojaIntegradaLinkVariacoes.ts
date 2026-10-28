import { z } from 'zod';

/**
 * The `grupoDeVariacoes.linksVariacoesli[]` element: the typed contract of one Loja Integrada
 * variation link (master plan step 10, #1821). One entry ties an ERP variation group, for ONE Loja
 * Integrada conta, to ONE grade of that store, and each of the grade's options to the ERP variantes
 * it stands for.
 *
 * ## Typed here, enforced where a link is WRITTEN: the field itself stays tolerant
 *
 * `grupoDeVariacoesSchema.linksVariacoesli` deliberately stays `z.array(z.json())`. The variation
 * screen's form validates the WHOLE document on every save, so typing the field there would let one
 * half-made stored entry block renaming the grupo or adding a size, over data that save never
 * touches (the Loja Integrada conta screen already hit that trap). Instead:
 *  - every reader goes through {@link lerLinksVariacoesLi}, the one typed view, which never throws;
 *  - every WRITER checks what it writes through {@link conflitosLinksVariacoesLi}: the web linker
 *    (the entries edited in the form, decided by VALUE against what the form loaded, never by object
 *    identity, and failing closed: an entry it cannot classify counts as edited), the product import
 *    (step 9, every entry it creates) and the publish pre-flight (step 11, the entries a family
 *    uses);
 *  - an entry nobody touched is written back EXACTLY as stored, valid or not, and shown as such.
 *
 * ⚠️ Both levels are `.passthrough()` on purpose, unlike `shopeeLinkVariacoes.ts` (strict at both
 * levels): a stored key this schema does not model is carried back unchanged, never refused.
 *
 * ## ⚠️ Three traps, each a real field of the stored shape
 *  1. `integracaoLiId` is a BARE conta doc id, stored verbatim — never a `documents/integracao/<id>`
 *     path. A path-shaped value is not rewritten: it matches no conta (exact equality) and the
 *     linker shows it under "conta não reconhecida".
 *  2. `arakene_variation_id` is a LIST: one Loja Integrada option may stand for several ERP variantes.
 *     That is allowed, with a warning ({@link TIPO_CONFLITO_LINK_LI}`.opcaoComVariasVariantes`): a
 *     product holding two of those variantes cannot be published (step 11 refuses it by name), and
 *     the import (step 9) never guesses which variante a store option means.
 *  3. `name` holds the grade's `nome` (never its `nome_visivel`) and `li_option_name` the option's
 *     `nome`: LABELS copied when the operator linked, shown while the store cannot be read. Either
 *     may be `null` or absent in a stored entry, and an absent one READS as `null`
 *     (`.nullable().default(null)`: a writer building an entry from the parsed type can never put
 *     an `undefined` label on it, which the Firebase SDK refuses). No decision ever keys on a name
 *     (the public document's own examples list several different grades all named "Tamanho").
 *
 * ## Identity is the ids, compared exactly
 * `grade_id` and `li_option_id` are STORED Firestore numbers — `z.number().int().positive()`, never
 * the wire's tolerant integer reader: a stored `'8946'` (a string) is an INVALID entry, reported as
 * such, never coerced. Every comparison in this file is exact: no case, trim or number↔string fold,
 * so `'v1'`, `'V1'` and `'v1 '` are three variantes and `'conta1'` is not `'CONTA1'`.
 *
 * Pure and total: no clock, no network, no Firestore, and no input throws.
 */

/** One Loja Integrada OPTION of a {@link linkVariacoesLiSchema} entry. */
export const linkVariacaoOpcaoLiSchema = z
  .object({
    /** The option id: `variacoes[].id` of `GET /v1/grades/{id}`. */
    li_option_id: z.number().int().positive(),
    /** The option's `nome` when it was linked: a LABEL, never an identity (trap 3). */
    li_option_name: z.string().nullable().default(null),
    /** Bare ERP Variante ids: a LIST (trap 2). */
    arakene_variation_id: z.array(z.string().min(1)),
  })
  .passthrough();
export type LinkVariacaoOpcaoLi = z.infer<typeof linkVariacaoOpcaoLiSchema>;

/** One `(conta, grade)` link on a `grupoDeVariacoes` doc. */
export const linkVariacoesLiSchema = z
  .object({
    /** The grade's `nome` (never `nome_visivel`) when it was linked: a LABEL (trap 3). */
    name: z.string().nullable().default(null),
    /** The Loja Integrada grade id. */
    grade_id: z.number().int().positive(),
    /** A BARE conta doc id, stored verbatim (trap 1). */
    integracaoLiId: z.string().min(1),
    variationOptions: z.array(linkVariacaoOpcaoLiSchema).default([]),
  })
  .passthrough();
export type LinkVariacoesLi = z.infer<typeof linkVariacoesLiSchema>;

/* -------------------------------------------------------------------------- */
/*                         The reader: never throws                            */
/* -------------------------------------------------------------------------- */

/** Whether one stored element parses as a {@link linkVariacoesLiSchema} entry. */
export const tipoEntradaLinkLiSchema = z.enum(['valida', 'invalida']);
export type TipoEntradaLinkLi = z.infer<typeof tipoEntradaLinkLiSchema>;
export const TIPO_ENTRADA_LINK_LI = {
  valida: 'valida',
  invalida: 'invalida',
} as const satisfies Record<string, TipoEntradaLinkLi>;

/**
 * One element of the stored array, at its own index. `bruto` is the stored value itself, so a
 * writer can carry an untouched entry back exactly as it was.
 *
 * `campos` (invalid only): the dotted path of every field that failed, in order, without repeats —
 * `grade_id`, `variationOptions.0.arakene_variation_id`. Empty when the element is not an object at
 * all (there is no field to blame).
 */
export type EntradaLinkVariacoesLi =
  | {
      readonly indice: number;
      readonly tipo: typeof TIPO_ENTRADA_LINK_LI.valida;
      readonly link: LinkVariacoesLi;
      readonly bruto: unknown;
    }
  | {
      readonly indice: number;
      readonly tipo: typeof TIPO_ENTRADA_LINK_LI.invalida;
      readonly bruto: unknown;
      readonly campos: readonly string[];
    };

export interface LeituraLinksVariacoesLi {
  /** One per stored element, in order; empty for `null`, absent, an empty list or a non-list. */
  readonly entradas: readonly EntradaLinkVariacoesLi[];
  /**
   * `true` when a value is stored and it is NOT a list: one finding for the whole field, since
   * nothing inside it can be read.
   */
  readonly formatoInvalido: boolean;
}

function camposDoErro(erro: z.ZodError): string[] {
  const campos: string[] = [];
  for (const issue of erro.issues) {
    const caminho = issue.path.map(String).join('.');
    if (caminho !== '' && !campos.includes(caminho)) campos.push(caminho);
  }
  return campos;
}

/**
 * THE typed view of a stored `linksVariacoesli` value. Total: `null` or absent ⇒ no entries; a
 * value that is not a list ⇒ `formatoInvalido`; each element ⇒ `valida` (parsed) or `invalida`
 * (with the fields that failed). An invalid element is REPORTED, never skipped, so the number of
 * entries always equals the number of stored elements.
 */
export function lerLinksVariacoesLi(bruto: unknown): LeituraLinksVariacoesLi {
  if (bruto === null || bruto === undefined) return { entradas: [], formatoInvalido: false };
  if (!Array.isArray(bruto)) return { entradas: [], formatoInvalido: true };
  const lista: readonly unknown[] = bruto;
  const entradas: EntradaLinkVariacoesLi[] = [];
  for (let indice = 0; indice < lista.length; indice += 1) {
    const elemento = lista[indice];
    const lido = linkVariacoesLiSchema.safeParse(elemento);
    entradas.push(
      lido.success
        ? { indice, tipo: TIPO_ENTRADA_LINK_LI.valida, link: lido.data, bruto: elemento }
        : {
            indice,
            tipo: TIPO_ENTRADA_LINK_LI.invalida,
            bruto: elemento,
            campos: camposDoErro(lido.error),
          },
    );
  }
  return { entradas, formatoInvalido: false };
}

/* -------------------------------------------------------------------------- */
/*                     The validator: one copy for every writer                */
/* -------------------------------------------------------------------------- */

/**
 * What a finding is about. The order of this list is the order the findings come in.
 *
 *  - `entradaInvalida`: an element that fails {@link linkVariacoesLiSchema}.
 *  - `gradeRepetidaNaConta`: two links of ONE conta naming the same `grade_id`.
 *  - `opcaoRepetidaNoVinculo`: the same `li_option_id` twice inside one link.
 *  - `varianteEmDuasOpcoes`: one variante held by two DIFFERENT store options of ONE conta, in one
 *    link or across two links of that conta: per store, one ERP variante points at one store option.
 *  - `varianteRemovidaVinculada`: a variante THIS save removes from the grupo, still named by an
 *    entry (edited or not). Its message belongs on the variantes, where the removal happened.
 *  - `varianteInexistente`: a variante id the grupo does not have and this save did not remove (one
 *    deleted earlier).
 *  - `opcaoComVariasVariantes`: one store option holding several variantes. A WARNING: it never
 *    blocks a save.
 */
export const tipoConflitoLinkLiSchema = z.enum([
  'entradaInvalida',
  'gradeRepetidaNaConta',
  'opcaoRepetidaNoVinculo',
  'varianteEmDuasOpcoes',
  'varianteRemovidaVinculada',
  'varianteInexistente',
  'opcaoComVariasVariantes',
]);
export type TipoConflitoLinkLi = z.infer<typeof tipoConflitoLinkLiSchema>;
export const TIPO_CONFLITO_LINK_LI = {
  entradaInvalida: 'entradaInvalida',
  gradeRepetidaNaConta: 'gradeRepetidaNaConta',
  opcaoRepetidaNoVinculo: 'opcaoRepetidaNoVinculo',
  varianteEmDuasOpcoes: 'varianteEmDuasOpcoes',
  varianteRemovidaVinculada: 'varianteRemovidaVinculada',
  varianteInexistente: 'varianteInexistente',
  opcaoComVariasVariantes: 'opcaoComVariasVariantes',
} as const satisfies Record<string, TipoConflitoLinkLi>;

/**
 * One finding. The location fields are `null` where the finding has no single such value (a
 * variante finding spans links, a grade finding spans options).
 */
export interface ConflitoLinkLi {
  readonly tipo: TipoConflitoLinkLi;
  /** Whether a write carrying this finding must be refused (see {@link conflitosLinksVariacoesLi}). */
  readonly bloqueia: boolean;
  /** The entries involved, by index in the stored array: ascending, no repeats. */
  readonly indices: readonly number[];
  readonly integracaoLiId: string | null;
  readonly gradeId: number | null;
  readonly opcaoId: number | null;
  readonly varianteId: string | null;
  /** `entradaInvalida` only: the fields that failed (see {@link EntradaLinkVariacoesLi}). */
  readonly campos: readonly string[];
}

export interface EntradaConflitosLinksVariacoesLi {
  /** The grupo's variante ids as this write leaves them (the prepared `variacoes[].id`). */
  readonly variantesIds: readonly string[];
  /** Variante ids the form was loaded with that THIS write removes from the grupo. */
  readonly variantesRemovidasNestaGravacao: readonly string[];
  /** {@link lerLinksVariacoesLi}'s entries for the value being written. */
  readonly entradas: readonly EntradaLinkVariacoesLi[];
  /**
   * The indices of the entries this write creates or changes. The caller classifies them BY VALUE
   * (an entry equal to one it loaded is untouched), never by object identity, and counts an entry
   * it cannot classify as edited.
   */
  readonly editadas: ReadonlySet<number>;
}

interface Achado {
  readonly integracaoLiId?: string;
  readonly gradeId?: number;
  readonly opcaoId?: number;
  readonly varianteId?: string;
  readonly campos?: readonly string[];
}

function conflito(
  tipo: TipoConflitoLinkLi,
  bloqueia: boolean,
  indices: Iterable<number>,
  achado: Achado,
): ConflitoLinkLi {
  return {
    tipo,
    bloqueia,
    indices: [...new Set(indices)].sort((a, b) => a - b),
    integracaoLiId: achado.integracaoLiId ?? null,
    gradeId: achado.gradeId ?? null,
    opcaoId: achado.opcaoId ?? null,
    varianteId: achado.varianteId ?? null,
    campos: achado.campos ?? [],
  };
}

/** `mapa.get(chave)`, creating the value with `criar` on the first call. */
function obter<K, V>(mapa: Map<K, V>, chave: K, criar: () => NoInfer<V>): V {
  const atual = mapa.get(chave);
  if (atual !== undefined) return atual;
  const novo = criar();
  mapa.set(chave, novo);
  return novo;
}

/**
 * THE uniqueness rules of a grupo's Loja Integrada links, shared by every writer: the web linker's
 * save, the product import (step 9) and the publish pre-flight (step 11). Returns every finding, in
 * the order of {@link TIPO_CONFLITO_LINK_LI}, then by first entry index.
 *
 * Only VALID entries take part in the uniqueness rules: an invalid one resolves nothing (it yields
 * its own `entradaInvalida` finding and nothing else). Scopes:
 *  - per conta (`integracaoLiId`, exact): a grade linked twice; a variante in two different options
 *    (an option is the pair `(grade_id, li_option_id)`, so the same option id repeated inside one
 *    link is that link's repeat, not a second option);
 *  - per link: an option id twice; an option holding several variantes (a warning);
 *  - per grupo: a variante id the grupo does not have, split into "removed by this write" and
 *    "deleted earlier".
 *
 * `bloqueia`: a finding blocks only through an entry this write creates or changes (`editadas`), so
 * a finding among untouched entries is shown and never blocks a save that does not touch them.
 * Two exceptions: `varianteRemovidaVinculada` ALWAYS blocks (this write is what breaks the link),
 * and `opcaoComVariasVariantes` NEVER blocks (a warning).
 *
 * Exact everywhere: no case, trim or number↔string fold.
 */
export function conflitosLinksVariacoesLi(
  entrada: EntradaConflitosLinksVariacoesLi,
): ConflitoLinkLi[] {
  const { entradas, editadas } = entrada;
  const doGrupo = new Set(entrada.variantesIds);
  const removidas = new Set(entrada.variantesRemovidasNestaGravacao);
  const algumaEditada = (indices: Iterable<number>): boolean => {
    for (const i of indices) if (editadas.has(i)) return true;
    return false;
  };

  const invalidas: ConflitoLinkLi[] = [];
  const validas: { readonly indice: number; readonly link: LinkVariacoesLi }[] = [];
  for (const e of entradas) {
    if (e.tipo === TIPO_ENTRADA_LINK_LI.valida) validas.push({ indice: e.indice, link: e.link });
    else
      invalidas.push(
        conflito(TIPO_CONFLITO_LINK_LI.entradaInvalida, editadas.has(e.indice), [e.indice], {
          campos: e.campos,
        }),
      );
  }

  // conta → grade → entries
  const gradesPorConta = new Map<string, Map<number, number[]>>();
  // conta → variante → option key `grade:option` → entries
  const opcoesDaVariantePorConta = new Map<string, Map<string, Map<string, number[]>>>();
  // variante not in the grupo → entries naming it
  const foraDoGrupo = new Map<string, number[]>();

  const opcoesRepetidas: ConflitoLinkLi[] = [];
  const avisos: ConflitoLinkLi[] = [];

  for (const { indice, link } of validas) {
    const conta = link.integracaoLiId;
    const gradeId = link.grade_id;
    obter(
      obter(gradesPorConta, conta, () => new Map()),
      gradeId,
      () => [],
    ).push(indice);

    const vistas = new Map<number, number>();
    for (const opcao of link.variationOptions) {
      const opcaoId = opcao.li_option_id;
      vistas.set(opcaoId, (vistas.get(opcaoId) ?? 0) + 1);
      const variantes = new Set(opcao.arakene_variation_id);
      const chaveOpcao = `${gradeId}:${opcaoId}`;
      for (const varianteId of variantes) {
        const porVariante = obter(opcoesDaVariantePorConta, conta, () => new Map());
        obter(
          obter(porVariante, varianteId, () => new Map()),
          chaveOpcao,
          () => [],
        ).push(indice);
        if (!doGrupo.has(varianteId)) obter(foraDoGrupo, varianteId, () => []).push(indice);
      }
      if (variantes.size > 1)
        avisos.push(
          conflito(TIPO_CONFLITO_LINK_LI.opcaoComVariasVariantes, false, [indice], {
            integracaoLiId: conta,
            gradeId,
            opcaoId,
          }),
        );
    }
    for (const [opcaoId, vezes] of vistas)
      if (vezes > 1)
        opcoesRepetidas.push(
          conflito(TIPO_CONFLITO_LINK_LI.opcaoRepetidaNoVinculo, editadas.has(indice), [indice], {
            integracaoLiId: conta,
            gradeId,
            opcaoId,
          }),
        );
  }

  const gradesRepetidas: ConflitoLinkLi[] = [];
  for (const [conta, porGrade] of gradesPorConta)
    for (const [gradeId, indices] of porGrade)
      if (indices.length > 1)
        gradesRepetidas.push(
          conflito(TIPO_CONFLITO_LINK_LI.gradeRepetidaNaConta, algumaEditada(indices), indices, {
            integracaoLiId: conta,
            gradeId,
          }),
        );

  const emDuasOpcoes: ConflitoLinkLi[] = [];
  for (const [conta, porVariante] of opcoesDaVariantePorConta)
    for (const [varianteId, porOpcao] of porVariante) {
      if (porOpcao.size < 2) continue;
      const indices = [...porOpcao.values()].flat();
      emDuasOpcoes.push(
        conflito(TIPO_CONFLITO_LINK_LI.varianteEmDuasOpcoes, algumaEditada(indices), indices, {
          integracaoLiId: conta,
          varianteId,
        }),
      );
    }

  const removidasVinculadas: ConflitoLinkLi[] = [];
  const inexistentes: ConflitoLinkLi[] = [];
  for (const [varianteId, indices] of foraDoGrupo) {
    if (removidas.has(varianteId))
      removidasVinculadas.push(
        conflito(TIPO_CONFLITO_LINK_LI.varianteRemovidaVinculada, true, indices, { varianteId }),
      );
    else
      inexistentes.push(
        conflito(TIPO_CONFLITO_LINK_LI.varianteInexistente, algumaEditada(indices), indices, {
          varianteId,
        }),
      );
  }

  const porPrimeiroIndice = (a: ConflitoLinkLi, b: ConflitoLinkLi): number =>
    (a.indices[0] ?? 0) - (b.indices[0] ?? 0);
  return [
    invalidas,
    gradesRepetidas,
    opcoesRepetidas,
    emDuasOpcoes,
    removidasVinculadas,
    inexistentes,
    avisos,
  ].flatMap((grupo) => [...grupo].sort(porPrimeiroIndice));
}
