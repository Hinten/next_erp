import { z } from 'zod';
import { opcaoDoRecursoLi } from '../../catalogoLojaIntegrada';
import { idFromRefOrNull } from '../../shared/outerRef';

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
 *    identity, and failing closed: an entry it cannot classify counts as edited) and the product
 *    import (step 9, every entry it creates). The publish pre-flight (step 11) writes no link: it
 *    runs the same function over the entries a family uses, and refuses that family through them;
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
 *    entry (edited or not, valid or not). Its message belongs on the variantes, where the removal
 *    happened.
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

/** A plain object in the Firestore sense: not `null`, not an array, not a primitive. */
function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An OWN property only: an inherited one is not stored data. */
function proprio(o: Record<string, unknown>, chave: string): unknown {
  return Object.hasOwn(o, chave) ? o[chave] : undefined;
}

/**
 * The variante ids an INVALID stored entry still names: every string of
 * `variationOptions[*].arakene_variation_id[*]`, read through plain objects and lists only and
 * kept exactly as stored (no fold). Anything shaped otherwise names nothing: a bare string where
 * the list belongs, a number id, an option that is not an object.
 */
function variantesNomeadasPorInvalida(bruto: unknown): Set<string> {
  const ids = new Set<string>();
  if (!ehObjeto(bruto)) return ids;
  const valorOpcoes = proprio(bruto, 'variationOptions');
  if (!Array.isArray(valorOpcoes)) return ids;
  const opcoes: readonly unknown[] = valorOpcoes;
  for (const opcao of opcoes) {
    if (!ehObjeto(opcao)) continue;
    const valorVariantes = proprio(opcao, 'arakene_variation_id');
    if (!Array.isArray(valorVariantes)) continue;
    const variantes: readonly unknown[] = valorVariantes;
    for (const id of variantes) if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

/**
 * THE uniqueness rules of a grupo's Loja Integrada links, shared by every writer (the web linker's
 * save, the product import of step 9) and run again by the publish pre-flight (step 11) over the
 * entries a family uses. Returns every finding, in the order of {@link TIPO_CONFLITO_LINK_LI}, then
 * by first entry index.
 *
 * Only VALID entries take part in the uniqueness rules: an invalid one resolves nothing (it yields
 * its own `entradaInvalida` finding), with ONE exception. A variante THIS write removes that an
 * invalid entry still names (read by `variantesNomeadasPorInvalida`) joins the
 * `varianteRemovidaVinculada` finding under that entry's index, exactly as a valid entry's would:
 * the removal would otherwise leave the stored entry naming a variante that no longer exists.
 *
 * Scopes:
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

  // variante not in the grupo → entries naming it
  const foraDoGrupo = new Map<string, number[]>();

  const invalidas: ConflitoLinkLi[] = [];
  const validas: { readonly indice: number; readonly link: LinkVariacoesLi }[] = [];
  for (const e of entradas) {
    if (e.tipo === TIPO_ENTRADA_LINK_LI.valida) {
      validas.push({ indice: e.indice, link: e.link });
      continue;
    }
    invalidas.push(
      conflito(TIPO_CONFLITO_LINK_LI.entradaInvalida, editadas.has(e.indice), [e.indice], {
        campos: e.campos,
      }),
    );
    // The one rule an invalid entry takes part in: a variante THIS write removes.
    for (const varianteId of variantesNomeadasPorInvalida(e.bruto))
      if (removidas.has(varianteId) && !doGrupo.has(varianteId))
        obter(foraDoGrupo, varianteId, () => []).push(e.indice);
  }

  // conta → grade → entries
  const gradesPorConta = new Map<string, Map<number, number[]>>();
  // conta → variante → option key `grade:option` → entries
  const opcoesDaVariantePorConta = new Map<string, Map<string, Map<string, number[]>>>();

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

/* -------------------------------------------------------------------------- */
/*            The product import's helpers (step 9): resolve, learn            */
/* -------------------------------------------------------------------------- */

/*
 * The product import (step 9) reads these links in three ways, each below:
 *  - it RESOLVES a variation's store options to ERP variantes ({@link resolverOpcoesDoFilhoLi});
 *  - it LEARNS a missing option link only from unanimous exact-SKU evidence
 *    ({@link decidirAprendizadoLi}), written through a merge that never drops anything
 *    ({@link fundirLinksVariacoesLi});
 *  - it refuses a `(conta, grade)` or `(conta, option)` linked in two grupos
 *    ({@link conflitosEntreGruposLi}, shared with the publish pre-flight of step 11).
 *
 * It never creates a grupo or a variante: a store option the ERP does not have yet is linked by
 * the operator in the variation screen, and the next import run picks it up.
 */

/** One grupo of the import's memo: its id, its variante ids, and its RAW `linksVariacoesli`. */
export interface GrupoComLinksLi {
  readonly id: string;
  readonly variantesIds: readonly string[];
  readonly linksVariacoesli: unknown;
}

/** The VALID entries of a grupo that belong to conta `contaId` (bare id, exact). */
function validasDaConta(grupo: GrupoComLinksLi, contaId: string): LinkVariacoesLi[] {
  const saida: LinkVariacoesLi[] = [];
  for (const e of lerLinksVariacoesLi(grupo.linksVariacoesli).entradas)
    if (e.tipo === TIPO_ENTRADA_LINK_LI.valida && e.link.integracaoLiId === contaId)
      saida.push(e.link);
  return saida;
}

/** What became of one store option of a variation — see {@link resolverOpcoesDoFilhoLi}. */
export const tipoResolucaoOpcaoLiSchema = z.enum([
  'resolvida',
  'ilegivel',
  'grade-sem-vinculo',
  'grade-em-dois-grupos',
  'opcao-sem-vinculo',
  'opcao-em-dois-grupos',
  'variacao-ambigua',
]);
export type TipoResolucaoOpcaoLi = z.infer<typeof tipoResolucaoOpcaoLiSchema>;

/** Named members of {@link tipoResolucaoOpcaoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const TIPO_RESOLUCAO_OPCAO_LI = {
  resolvida: 'resolvida',
  ilegivel: 'ilegivel',
  gradeSemVinculo: 'grade-sem-vinculo',
  gradeEmDoisGrupos: 'grade-em-dois-grupos',
  opcaoSemVinculo: 'opcao-sem-vinculo',
  opcaoEmDoisGrupos: 'opcao-em-dois-grupos',
  variacaoAmbigua: 'variacao-ambigua',
} as const satisfies Record<string, TipoResolucaoOpcaoLi>;

/**
 * One option's verdict. `gradeId`/`opcaoId` are `null` only for `ilegivel` (the URI did not read).
 * `grupoIds` names the grupo(s) involved and `varianteIds` the variante(s) the link names: exactly
 * one of each for `resolvida`.
 */
export interface ResolucaoOpcaoLi {
  readonly tipo: TipoResolucaoOpcaoLi;
  readonly gradeId: number | null;
  readonly opcaoId: number | null;
  readonly grupoIds: readonly string[];
  readonly varianteIds: readonly string[];
}

/**
 * Resolve each store option of a variation (its `variacoes` URIs, read by `opcaoDoRecursoLi`) to
 * ONE ERP variante, for conta `contaId`, over every grupo of the memo. Per option `(g, v)`:
 *
 *  - the VALID links of the conta (`integracaoLiId === contaId`, exact and bare) for grade `g`:
 *    none ⇒ `grade-sem-vinculo`; more than one — in two grupos, or repeated inside one —
 *    ⇒ `grade-em-dois-grupos` (the grade is linked more than once for this conta);
 *  - in that one link, the options with `li_option_id === v`: none ⇒ `opcao-sem-vinculo`; `v`
 *    also linked in ANOTHER grupo of the conta ⇒ `opcao-em-dois-grupos`;
 *  - the variante ids they hold that name a variante OF THAT GRUPO: exactly one ⇒ `resolvida`;
 *    several ⇒ `variacao-ambigua` (the store option stands for several ERP variantes, and the
 *    import never guesses which one is meant); none — or only stale ids ⇒ `opcao-sem-vinculo`.
 *
 * An INVALID stored entry resolves nothing (and is never dropped by anything here). A URI that is
 * not an option URI ⇒ `ilegivel`.
 *
 * Equal (resolved): one option, one variante, one grupo.
 * Distinct (not resolved): two variantes; `(C, g)` in two grupos; `(C, v)` in two grupos; the same
 * `(g, v)` linked for another conta only; a stored `integracaoLiId: 'documents/integracao/C1'`
 * (not the bare id) for conta `C1`.
 */
export function resolverOpcoesDoFilhoLi(entrada: {
  readonly contaId: string;
  readonly opcoesUris: readonly unknown[];
  readonly grupos: readonly GrupoComLinksLi[];
}): ResolucaoOpcaoLi[] {
  const lidos = entrada.grupos.map((grupo) => ({
    grupo,
    validas: validasDaConta(grupo, entrada.contaId),
  }));
  const veredito = (
    tipo: TipoResolucaoOpcaoLi,
    gradeId: number | null,
    opcaoId: number | null,
    grupoIds: readonly string[] = [],
    varianteIds: readonly string[] = [],
  ): ResolucaoOpcaoLi => ({ tipo, gradeId, opcaoId, grupoIds, varianteIds });

  return entrada.opcoesUris.map((uri) => {
    const opcao = opcaoDoRecursoLi(uri);
    if (opcao === null) return veredito(TIPO_RESOLUCAO_OPCAO_LI.ilegivel, null, null);
    const { gradeId, opcaoId } = opcao;

    const daGrade = lidos.flatMap(({ grupo, validas }) =>
      validas.filter((l) => l.grade_id === gradeId).map((link) => ({ grupo, link })),
    );
    if (daGrade.length === 0) {
      return veredito(TIPO_RESOLUCAO_OPCAO_LI.gradeSemVinculo, gradeId, opcaoId);
    }
    if (daGrade.length > 1) {
      const grupoIds = [...new Set(daGrade.map((d) => d.grupo.id))];
      return veredito(TIPO_RESOLUCAO_OPCAO_LI.gradeEmDoisGrupos, gradeId, opcaoId, grupoIds);
    }
    const { grupo, link } = daGrade[0]!;

    const opcoes = link.variationOptions.filter((o) => o.li_option_id === opcaoId);
    if (opcoes.length === 0) {
      return veredito(TIPO_RESOLUCAO_OPCAO_LI.opcaoSemVinculo, gradeId, opcaoId, [grupo.id]);
    }
    const outros = lidos
      .filter(
        (l) =>
          l.grupo.id !== grupo.id &&
          l.validas.some((v) => v.variationOptions.some((o) => o.li_option_id === opcaoId)),
      )
      .map((l) => l.grupo.id);
    if (outros.length > 0) {
      return veredito(TIPO_RESOLUCAO_OPCAO_LI.opcaoEmDoisGrupos, gradeId, opcaoId, [
        grupo.id,
        ...outros,
      ]);
    }

    const doGrupo = new Set(grupo.variantesIds);
    const variantes = [...new Set(opcoes.flatMap((o) => o.arakene_variation_id))].filter((id) =>
      doGrupo.has(id),
    );
    if (variantes.length === 1) {
      return veredito(TIPO_RESOLUCAO_OPCAO_LI.resolvida, gradeId, opcaoId, [grupo.id], variantes);
    }
    if (variantes.length > 1) {
      return veredito(
        TIPO_RESOLUCAO_OPCAO_LI.variacaoAmbigua,
        gradeId,
        opcaoId,
        [grupo.id],
        variantes,
      );
    }
    return veredito(TIPO_RESOLUCAO_OPCAO_LI.opcaoSemVinculo, gradeId, opcaoId, [grupo.id]);
  });
}

/** A cross-grupo finding of one conta — see {@link conflitosEntreGruposLi}. */
export const tipoConflitoEntreGruposLiSchema = z.enum([
  'grade-em-dois-grupos',
  'opcao-em-dois-grupos',
]);
export type TipoConflitoEntreGruposLi = z.infer<typeof tipoConflitoEntreGruposLiSchema>;

/** Named members of {@link tipoConflitoEntreGruposLiSchema} — see `delfrance/prefer-schema-enum`. */
export const TIPO_CONFLITO_ENTRE_GRUPOS_LI = {
  gradeEmDoisGrupos: 'grade-em-dois-grupos',
  opcaoEmDoisGrupos: 'opcao-em-dois-grupos',
} as const satisfies Record<string, TipoConflitoEntreGruposLi>;

export interface ConflitoEntreGruposLi {
  readonly tipo: TipoConflitoEntreGruposLi;
  /** The grade (`grade-em-dois-grupos`) or `null`. */
  readonly gradeId: number | null;
  /** The option (`opcao-em-dois-grupos`) or `null`. */
  readonly opcaoId: number | null;
  /** The grupos holding it, in memo order, without repeats (at least two). */
  readonly grupoIds: readonly string[];
}

/**
 * The CROSS-GRUPO rule {@link conflitosLinksVariacoesLi} cannot see, since it reads one grupo: per
 * conta, one grade is linked in ONE grupo, and one option in ONE grupo. Returns every
 * `(contaId, grade)` and every `(contaId, option)` held by valid links of two or more grupos —
 * grades first, then options, each by ascending id.
 *
 * An option is keyed by its `li_option_id` ALONE, whatever grade the link names: the store's
 * option ids are its own ids, and keying on the pair would let the same option hide under two
 * grades in two grupos. Only VALID entries of `contaId` (bare, exact) take part. A grade or
 * option repeated inside ONE grupo is that grupo's own finding, not this one.
 *
 * Shared by the import's learning (run over the WHOLE memo with the merge applied, before every
 * write) and the publish pre-flight of step 11.
 */
export function conflitosEntreGruposLi(
  grupos: readonly GrupoComLinksLi[],
  contaId: string,
): ConflitoEntreGruposLi[] {
  const porGrade = new Map<number, string[]>();
  const porOpcao = new Map<number, string[]>();
  for (const grupo of grupos) {
    for (const link of validasDaConta(grupo, contaId)) {
      const g = obter(porGrade, link.grade_id, () => []);
      if (!g.includes(grupo.id)) g.push(grupo.id);
      for (const opcao of link.variationOptions) {
        const o = obter(porOpcao, opcao.li_option_id, () => []);
        if (!o.includes(grupo.id)) o.push(grupo.id);
      }
    }
  }
  const saida: ConflitoEntreGruposLi[] = [];
  for (const [gradeId, grupoIds] of [...porGrade].sort((a, b) => a[0] - b[0]))
    if (grupoIds.length > 1)
      saida.push({
        tipo: TIPO_CONFLITO_ENTRE_GRUPOS_LI.gradeEmDoisGrupos,
        gradeId,
        opcaoId: null,
        grupoIds,
      });
  for (const [opcaoId, grupoIds] of [...porOpcao].sort((a, b) => a[0] - b[0]))
    if (grupoIds.length > 1)
      saida.push({
        tipo: TIPO_CONFLITO_ENTRE_GRUPOS_LI.opcaoEmDoisGrupos,
        gradeId: null,
        opcaoId,
        grupoIds,
      });
  return saida;
}

/** One option link the import learned: `(conta, grade, option) → variante`. */
export interface AprendizadoLinkLi {
  /** The BARE conta id, written verbatim. */
  readonly integracaoLiId: string;
  readonly gradeId: number;
  readonly opcaoId: number;
  readonly varianteId: string;
  /** Labels, when known: written only where the stored one is `null` or absent. */
  readonly nomeGrade?: string | null;
  readonly nomeOpcao?: string | null;
}

/** {@link fundirLinksVariacoesLi}'s answer. */
export type FusaoLinksVariacoesLi =
  /** The stored value is neither absent nor a list: nothing can be merged into it without dropping it. */
  | { readonly ok: false }
  | {
      readonly ok: true;
      /** The whole array to write. */
      readonly array: unknown[];
      /** `false` ⇒ nothing changed: write nothing. */
      readonly mudou: boolean;
      /** The indices this merge created or changed, ascending. */
      readonly editadas: readonly number[];
    };

/** The stored option with the learning folded in (its label, its variante list), or `null`. */
function fundirOpcao(
  opcao: Record<string, unknown>,
  a: AprendizadoLinkLi,
): Record<string, unknown> | null {
  const mudancas: Record<string, unknown> = {};
  const atuais = proprio(opcao, 'arakene_variation_id');
  const lista: readonly unknown[] = Array.isArray(atuais) ? atuais : [];
  if (!lista.includes(a.varianteId)) mudancas.arakene_variation_id = [...lista, a.varianteId];
  const nome = proprio(opcao, 'li_option_name');
  if ((nome === null || nome === undefined) && a.nomeOpcao != null) {
    mudancas.li_option_name = a.nomeOpcao;
  }
  return Object.keys(mudancas).length === 0 ? null : { ...opcao, ...mudancas };
}

/** The stored entry with one learning folded in, or `null` when nothing changes. */
function fundirEntrada(
  bruto: Record<string, unknown>,
  a: AprendizadoLinkLi,
): Record<string, unknown> | null {
  const mudancas: Record<string, unknown> = {};
  const nome = proprio(bruto, 'name');
  if ((nome === null || nome === undefined) && a.nomeGrade != null) mudancas.name = a.nomeGrade;

  const valor = proprio(bruto, 'variationOptions');
  const armazenadas: readonly unknown[] = Array.isArray(valor) ? valor : [];
  const opcoes: unknown[] = [...armazenadas];
  const indice = opcoes.findIndex((o) => ehObjeto(o) && proprio(o, 'li_option_id') === a.opcaoId);
  if (indice === -1) {
    opcoes.push({
      li_option_id: a.opcaoId,
      li_option_name: a.nomeOpcao ?? null,
      arakene_variation_id: [a.varianteId],
    });
    mudancas.variationOptions = opcoes;
  } else {
    const atual = opcoes[indice];
    const fundida = ehObjeto(atual) ? fundirOpcao(atual, a) : null;
    if (fundida !== null) {
      opcoes[indice] = fundida;
      mudancas.variationOptions = opcoes;
    }
  }
  return Object.keys(mudancas).length === 0 ? null : { ...bruto, ...mudancas };
}

/**
 * Merge the import's learned option links into a grupo's stored `linksVariacoesli` WITHOUT
 * dropping anything (the Shopee importer's never-drop rule, with this channel's key):
 *
 *  - a stored element that fails {@link linkVariacoesLiSchema} is kept VERBATIM, in place;
 *  - an element of another conta, and every element no learning touches, is kept as the SAME
 *    value — byte for byte;
 *  - the touched element is keyed by the EXACT `(integracaoLiId, grade_id)` of a VALID entry (no
 *    ref fold: a stored `documents/integracao/<id>` is another key, and the learning refuses
 *    before reaching here when one exists); its `name` and an option's `li_option_name` are filled
 *    only when `null` or absent; a new option is appended; an option's variante list is
 *    extended only by union, in the stored order;
 *  - no matching entry ⇒ a new entry is appended;
 *  - nothing changed ⇒ `mudou: false`, and the caller writes nothing.
 *
 * Several learnings are applied in order. The merge itself checks no rule: the caller runs
 * {@link conflitosLinksVariacoesLi} on the result (the indices in `editadas`) and
 * {@link conflitosEntreGruposLi} over the memo before writing.
 */
export function fundirLinksVariacoesLi(
  armazenado: unknown,
  aprendizados: readonly AprendizadoLinkLi[],
): FusaoLinksVariacoesLi {
  if (armazenado !== null && armazenado !== undefined && !Array.isArray(armazenado)) {
    return { ok: false };
  }
  const lista: readonly unknown[] = Array.isArray(armazenado) ? armazenado : [];
  const saida: unknown[] = [...lista];
  const editadas = new Set<number>();
  for (const a of aprendizados) {
    const indice = saida.findIndex((elemento) => {
      const lido = linkVariacoesLiSchema.safeParse(elemento);
      return (
        lido.success &&
        lido.data.integracaoLiId === a.integracaoLiId &&
        lido.data.grade_id === a.gradeId
      );
    });
    if (indice === -1) {
      saida.push({
        name: a.nomeGrade ?? null,
        grade_id: a.gradeId,
        integracaoLiId: a.integracaoLiId,
        variationOptions: [
          {
            li_option_id: a.opcaoId,
            li_option_name: a.nomeOpcao ?? null,
            arakene_variation_id: [a.varianteId],
          },
        ],
      });
      editadas.add(saida.length - 1);
      continue;
    }
    const atual = saida[indice];
    const fundida = ehObjeto(atual) ? fundirEntrada(atual, a) : null;
    if (fundida !== null) {
      saida[indice] = fundida;
      editadas.add(indice);
    }
  }
  return {
    ok: true,
    array: saida,
    mudou: editadas.size > 0,
    editadas: [...editadas].sort((x, y) => x - y),
  };
}

/** One distinct claim of the evidence pass: "option `(g, v)` of the conta = variante X of grupo G". */
export interface AlegacaoAprendizadoLi {
  readonly grupoId: string;
  readonly varianteId: string;
  /** Every claim of this pair came from a family with ONE axis on both sides. */
  readonly todasDeEixoUnico: boolean;
}

/** Every claim the whole job collected for one store option. */
export interface EvidenciaAprendizadoLi {
  readonly gradeId: number;
  readonly opcaoId: number;
  readonly alegacoes: readonly AlegacaoAprendizadoLi[];
  readonly nomeGrade?: string | null;
  readonly nomeOpcao?: string | null;
}

/**
 * Why a learning was refused. The import reports `divergente` as `evidencia-divergente` and every
 * other motivo as `variacao-sem-vinculo`; the motivo itself is the diagnosis.
 *
 *  - `divergente`: the claims for the option name two different `(grupo, variante)`;
 *  - `grupo-desconhecido` / `variante-fora-do-grupo`: the claim names a grupo the memo lacks, or a
 *    variante that grupo does not have (stale evidence);
 *  - `formato-invalido`: the grupo's stored value is not a list (nothing can be merged into it);
 *  - `grade-em-outro-grupo`: another grupo already holds an entry for `(conta, grade)`;
 *  - `grade-repetida`: the grupo holds more than one entry for `(conta, grade)`, or one that is
 *    not the conta's VALID bare entry (fail closed: an invalid or non-bare entry naming the conta
 *    still "holds" the grade, so a second entry is never added beside it);
 *  - `grupos-divergentes-na-grade`: a NEW entry was proposed, but the claims for the grade's
 *    options name two grupos — none is created, so no processing order picks a winner;
 *  - `eixos-multiplos`: a NEW entry needs every claim to come from a family with ONE axis on both
 *    sides (several axes with no linked grade cannot tell which axis the grade is);
 *  - `variante-em-outra-opcao`: the variante is already held by another option of the conta;
 *  - `conflito-no-grupo`: the merged grupo carries a blocking {@link conflitosLinksVariacoesLi}
 *    finding on an edited entry;
 *  - `conflito-entre-grupos`: with the merge applied, {@link conflitosEntreGruposLi} names this
 *    grade or option.
 */
export const motivoRecusaAprendizadoLiSchema = z.enum([
  'divergente',
  'grupo-desconhecido',
  'variante-fora-do-grupo',
  'formato-invalido',
  'grade-em-outro-grupo',
  'grade-repetida',
  'grupos-divergentes-na-grade',
  'eixos-multiplos',
  'variante-em-outra-opcao',
  'conflito-no-grupo',
  'conflito-entre-grupos',
]);
export type MotivoRecusaAprendizadoLi = z.infer<typeof motivoRecusaAprendizadoLiSchema>;

/** Named members of {@link motivoRecusaAprendizadoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const MOTIVO_RECUSA_APRENDIZADO_LI = {
  divergente: 'divergente',
  grupoDesconhecido: 'grupo-desconhecido',
  varianteForaDoGrupo: 'variante-fora-do-grupo',
  formatoInvalido: 'formato-invalido',
  gradeEmOutroGrupo: 'grade-em-outro-grupo',
  gradeRepetida: 'grade-repetida',
  gruposDivergentesNaGrade: 'grupos-divergentes-na-grade',
  eixosMultiplos: 'eixos-multiplos',
  varianteEmOutraOpcao: 'variante-em-outra-opcao',
  conflitoNoGrupo: 'conflito-no-grupo',
  conflitoEntreGrupos: 'conflito-entre-grupos',
} as const satisfies Record<string, MotivoRecusaAprendizadoLi>;

export interface DecisaoAprendizadoLi {
  /** The learnings to write, in decision order. */
  readonly aprendidos: readonly {
    readonly gradeId: number;
    readonly opcaoId: number;
    readonly grupoId: string;
    readonly varianteId: string;
    /** A new `(conta, grade)` entry was created for it. */
    readonly novaEntrada: boolean;
  }[];
  readonly recusados: readonly {
    readonly gradeId: number;
    readonly opcaoId: number;
    readonly motivo: MotivoRecusaAprendizadoLi;
  }[];
  /** Options already linked in the grupo the claims name: nothing to learn. */
  readonly jaVinculadas: readonly { readonly gradeId: number; readonly opcaoId: number }[];
  /** Each grupo the learnings change, with its whole merged array to write, in memo order. */
  readonly grupos: readonly { readonly grupoId: string; readonly linksVariacoesli: unknown[] }[];
}

/** Does a stored `integracaoLiId` name conta `contaId` in ANY form (bare, a path, edge spaces)? */
function nomeiaConta(valor: unknown, contaId: string): boolean {
  return typeof valor === 'string' && idFromRefOrNull(valor.trim()) === contaId;
}

/** Does a stored `grade_id` name grade `gradeId`, or not read at all (fail closed)? */
function podeSerGrade(valor: unknown, gradeId: number): boolean {
  if (typeof valor === 'number') return valor === gradeId;
  if (typeof valor === 'string' && /^[0-9]+$/.test(valor)) return Number(valor) === gradeId;
  return true;
}

/**
 * Every stored element, in every grupo, that HOLDS `(contaId, gradeId)` — failing CLOSED: an
 * element naming the conta in any form whose grade is that grade or does not read. `exata`: the
 * conta's VALID bare entry for exactly that grade, the only kind a learning may extend.
 */
function detentoresDaGrade(
  grupos: readonly { readonly id: string; readonly links: unknown }[],
  contaId: string,
  gradeId: number,
): { readonly grupoId: string; readonly exata: boolean }[] {
  const saida: { grupoId: string; exata: boolean }[] = [];
  for (const g of grupos) {
    if (!Array.isArray(g.links)) continue;
    const lista: readonly unknown[] = g.links;
    for (const elemento of lista) {
      if (!ehObjeto(elemento)) continue;
      if (!nomeiaConta(proprio(elemento, 'integracaoLiId'), contaId)) continue;
      if (!podeSerGrade(proprio(elemento, 'grade_id'), gradeId)) continue;
      const lido = linkVariacoesLiSchema.safeParse(elemento);
      saida.push({
        grupoId: g.id,
        exata:
          lido.success && lido.data.integracaoLiId === contaId && lido.data.grade_id === gradeId,
      });
    }
  }
  return saida;
}

/** Is variante `varianteId` held by an option of the conta (any form) other than `(g, v)`? */
function varianteEmOutraOpcao(
  links: unknown,
  contaId: string,
  gradeId: number,
  opcaoId: number,
  varianteId: string,
): boolean {
  if (!Array.isArray(links)) return false;
  const lista: readonly unknown[] = links;
  for (const elemento of lista) {
    if (!ehObjeto(elemento) || !nomeiaConta(proprio(elemento, 'integracaoLiId'), contaId)) continue;
    const mesmaGrade = proprio(elemento, 'grade_id') === gradeId;
    const valorOpcoes = proprio(elemento, 'variationOptions');
    if (!Array.isArray(valorOpcoes)) continue;
    const opcoes: readonly unknown[] = valorOpcoes;
    for (const opcao of opcoes) {
      if (!ehObjeto(opcao)) continue;
      if (mesmaGrade && proprio(opcao, 'li_option_id') === opcaoId) continue;
      const valorVariantes = proprio(opcao, 'arakene_variation_id');
      if (!Array.isArray(valorVariantes)) continue;
      const variantes: readonly unknown[] = valorVariantes;
      if (variantes.includes(varianteId)) return true;
    }
  }
  return false;
}

/**
 * The LEARNING pass of the product import (step 9): which missing option links the job's evidence
 * proves, merged into which grupos. It changes no product and no variante; it only records links.
 * Pure: the caller writes `grupos` (tier 1, on its own read of each), or — under Simular — keeps
 * the same decisions as an overlay and writes nothing.
 *
 * A link `(conta, g, v) → (G, X)` is learned only when ALL of these hold:
 *  - every claim for `(g, v)` across the whole job names the same `(G, X)` (unanimity —
 *    otherwise `divergente`, and nothing is learned for it);
 *  - X is a variante of G;
 *  - either G holds the conta's VALID bare entry for grade `g` and nothing else anywhere holds
 *    `(conta, g)` — then `v` is appended to it, unless already there (`jaVinculadas`) — or NOTHING
 *    in any grupo holds `(conta, g)` in any form, every claim for the grade's options names G, and
 *    every claim came from a family with one axis on both sides — then a new entry is created;
 *  - X is not held by another option of the conta in G;
 *  - with the merge applied, {@link conflitosLinksVariacoesLi} finds no blocking finding in G and
 *    {@link conflitosEntreGruposLi} over the WHOLE memo names neither `g` nor `v`.
 *
 * Decided in ascending `(gradeId, opcaoId)` order, each learning applied to the memo before the
 * next is decided; the per-grade grupo check is made over ALL claims first, so a new entry is
 * never won by whichever family came first.
 *
 * Equal (learned): two claims for `(C, g, v)` naming the same `(G, X)`.
 * Distinct (refused): claims naming two variantes; family A on G1 and family B on G2 both proposing
 * a new `(C, g)`; an invalid entry naming C for `g` in G (G "holds", no second entry is added).
 */
export function decidirAprendizadoLi(entrada: {
  readonly contaId: string;
  readonly evidencias: readonly EvidenciaAprendizadoLi[];
  readonly grupos: readonly GrupoComLinksLi[];
}): DecisaoAprendizadoLi {
  const { contaId } = entrada;
  const memo = entrada.grupos.map((g) => ({ grupo: g, id: g.id, links: g.linksVariacoesli }));
  const fundidos = new Map<string, unknown[]>();
  const aprendidos: DecisaoAprendizadoLi['aprendidos'][number][] = [];
  const recusados: DecisaoAprendizadoLi['recusados'][number][] = [];
  const jaVinculadas: { gradeId: number; opcaoId: number }[] = [];

  const evidencias = [...entrada.evidencias].sort(
    (a, b) => a.gradeId - b.gradeId || a.opcaoId - b.opcaoId,
  );
  // Every grupo ANY claim names for a grade, divergent claims included.
  const gruposPorGrade = new Map<number, Set<string>>();
  for (const ev of evidencias)
    for (const a of ev.alegacoes) obter(gruposPorGrade, ev.gradeId, () => new Set()).add(a.grupoId);

  for (const ev of evidencias) {
    const { gradeId, opcaoId } = ev;
    const recusar = (motivo: MotivoRecusaAprendizadoLi): void => {
      recusados.push({ gradeId, opcaoId, motivo });
    };
    const pares = new Map<string, AlegacaoAprendizadoLi[]>();
    for (const a of ev.alegacoes)
      obter(pares, JSON.stringify([a.grupoId, a.varianteId]), () => []).push(a);
    if (pares.size === 0) continue;
    if (pares.size > 1) {
      recusar(MOTIVO_RECUSA_APRENDIZADO_LI.divergente);
      continue;
    }
    const alegacoes = [...pares.values()][0]!;
    const { grupoId, varianteId } = alegacoes[0]!;
    const eixoUnico = alegacoes.every((a) => a.todasDeEixoUnico);

    const alvo = memo.find((m) => m.id === grupoId);
    if (alvo === undefined) {
      recusar(MOTIVO_RECUSA_APRENDIZADO_LI.grupoDesconhecido);
      continue;
    }
    if (!alvo.grupo.variantesIds.includes(varianteId)) {
      recusar(MOTIVO_RECUSA_APRENDIZADO_LI.varianteForaDoGrupo);
      continue;
    }
    if (lerLinksVariacoesLi(alvo.links).formatoInvalido) {
      recusar(MOTIVO_RECUSA_APRENDIZADO_LI.formatoInvalido);
      continue;
    }

    const detentores = detentoresDaGrade(memo, contaId, gradeId);
    let novaEntrada: boolean;
    if (detentores.length === 0) {
      if ((gruposPorGrade.get(gradeId)?.size ?? 0) > 1) {
        recusar(MOTIVO_RECUSA_APRENDIZADO_LI.gruposDivergentesNaGrade);
        continue;
      }
      if (!eixoUnico) {
        recusar(MOTIVO_RECUSA_APRENDIZADO_LI.eixosMultiplos);
        continue;
      }
      novaEntrada = true;
    } else if (detentores.some((d) => d.grupoId !== grupoId)) {
      recusar(MOTIVO_RECUSA_APRENDIZADO_LI.gradeEmOutroGrupo);
      continue;
    } else if (detentores.length > 1 || !detentores[0]!.exata) {
      recusar(MOTIVO_RECUSA_APRENDIZADO_LI.gradeRepetida);
      continue;
    } else {
      const link = validasDaConta({ ...alvo.grupo, linksVariacoesli: alvo.links }, contaId).find(
        (l) => l.grade_id === gradeId,
      );
      if (link?.variationOptions.some((o) => o.li_option_id === opcaoId) === true) {
        jaVinculadas.push({ gradeId, opcaoId });
        continue;
      }
      novaEntrada = false;
    }

    if (varianteEmOutraOpcao(alvo.links, contaId, gradeId, opcaoId, varianteId)) {
      recusar(MOTIVO_RECUSA_APRENDIZADO_LI.varianteEmOutraOpcao);
      continue;
    }

    const fusao = fundirLinksVariacoesLi(alvo.links, [
      {
        integracaoLiId: contaId,
        gradeId,
        opcaoId,
        varianteId,
        nomeGrade: ev.nomeGrade ?? null,
        nomeOpcao: ev.nomeOpcao ?? null,
      },
    ]);
    if (!fusao.ok) {
      recusar(MOTIVO_RECUSA_APRENDIZADO_LI.formatoInvalido);
      continue;
    }
    const achados = conflitosLinksVariacoesLi({
      variantesIds: alvo.grupo.variantesIds,
      variantesRemovidasNestaGravacao: [],
      entradas: lerLinksVariacoesLi(fusao.array).entradas,
      editadas: new Set(fusao.editadas),
    });
    if (achados.some((a) => a.bloqueia)) {
      recusar(MOTIVO_RECUSA_APRENDIZADO_LI.conflitoNoGrupo);
      continue;
    }
    const comFusao = memo.map((m) => ({
      id: m.id,
      variantesIds: m.grupo.variantesIds,
      linksVariacoesli: m.id === grupoId ? fusao.array : m.links,
    }));
    const cruzados = conflitosEntreGruposLi(comFusao, contaId);
    if (cruzados.some((c) => c.gradeId === gradeId || c.opcaoId === opcaoId)) {
      recusar(MOTIVO_RECUSA_APRENDIZADO_LI.conflitoEntreGrupos);
      continue;
    }

    alvo.links = fusao.array;
    fundidos.set(grupoId, fusao.array);
    aprendidos.push({ gradeId, opcaoId, grupoId, varianteId, novaEntrada });
  }

  return {
    aprendidos,
    recusados,
    jaVinculadas,
    grupos: memo.flatMap((m) => {
      const array = fundidos.get(m.id);
      return array === undefined ? [] : [{ grupoId: m.id, linksVariacoesli: array }];
    }),
  };
}
