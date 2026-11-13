/**
 * The produto's Shopee tab — the listing DRAFT's state model (#1911, P10): the
 * entry a block edits, what is DIRTY, what each of the three draft routes is
 * SENT, what each of their refusals MEANS, and what a draft block may do right
 * now. P11 adds its PUBLICAR: when it acts ({@link publicacaoDoRascunhoShopee}),
 * what it sends ({@link corpoPublicarRascunhoShopee}), what a failure means
 * ({@link falhaDaPublicacaoDoRascunhoShopee}), and what a refusal row offers —
 * its Seller-Centre exits ({@link saidasDoProblemaShopee}) and the surface its
 * `campo` routes to ({@link superficieDoCampoShopee}). The tab
 * (`app/(app)/produtos/_components/shopee/`) renders with these; the copy they
 * point at is `./anuncioProduto.ts`'s.
 *
 * ⚠️ PURE: no React, no Firestore read or write, and NO CLOCK — every instant
 * is a parameter. The tab reads `Date.now()` and reads it
 * AGAIN on a timer of {@link BlocoRascunhoShopee.releituraEmMs}: a reading taken
 * once at mount would never see `em-andamento` turn into `incerta`.
 *
 * ## Every rule here is the schemas' (#1369)
 *
 * What a draft holds is `camposDoRascunhoShopee` (THE projection); whether the
 * publish lock is live is `estadoPublicacaoRascunhoShopee` (THE reading — the
 * web never compares `publicacaoEmCurso` itself); what a write accepts is
 * `conteudoRascunhoShopeeSchema`; which fields an edit's `base` names is
 * `camposDaBaseDoRascunhoShopee`; which links make a second listing is
 * `vinculosQueExigemConfirmacaoShopee` — all `@delfrance/schemas`, the module
 * the draft route decides with. This file composes them and copies none.
 *
 * ## The two compares — called HERE and nowhere else in apps/web
 *
 * - **`mesmoValorGravadoDoRascunhoShopee`, the WRITE question** ("would this
 *   write change what is stored?") decides what is DIRTY and what a patch
 *   holds ({@link planoDoRascunhoShopee}). A legacy draft storing `brand_id`
 *   alone, re-picked WITH the brand's name, is dirty: the name is the edit.
 *   The same question says which fields the operator left UNTOUCHED (a rebase
 *   moves those, and only those, onto the stored draft —
 *   {@link rebasearEdicaoRascunhoShopee}), whether a dirty entry already holds
 *   nothing beyond what is stored ({@link conciliarEdicaoRascunhoShopee}), and
 *   whether a 409's rows still show what is stored
 *   ({@link conflitosAtualizadosDoRascunhoShopee}).
 * - **`mesmoValorDoRascunhoShopee`, the CONFLICT question** ("is what I hold
 *   still what is stored?") is the stale check only
 *   ({@link divergenciasDoServidorShopee}) — never dirtiness, which would
 *   re-create the brand-name defect the write question exists to fix.
 *
 * Both are folds (`equivalence-fold-inventory.test.js` holds this file's
 * entry); `rascunho.test.ts` pins what each treats as equal and what must stay
 * distinct.
 *
 * ## A field is in the patch only when the operator changed it AND the write
 *    would change what is stored
 *
 * Only the five fields the form renders ({@link CAMPOS_DO_FORMULARIO_RASCUNHO_SHOPEE}),
 * `attributes` among them since the attribute editor (P13). The question is
 * asked of every field alike, and it matters most for `attributes`: the
 * projection DECODES any stored list while the write schema demands positive
 * ids and re-normalises, so an UNTOUCHED legacy list (an `attribute_id` the
 * write refuses, an untrimmed custom name) is never piped through it — it
 * would fail every save of that draft, or send an `attributes` patch nobody
 * made. A list enters the patch only once the operator edited it, and then it
 * is the editor's (`./atributosRascunho.ts`: the visible filter drops what the
 * category does not show, in the base's order) — with ONE exception: a patch
 * that changes `category_id` makes the route clear `attributes` unless it
 * names them (K1-12), so after a category change a NON-EMPTY list always goes,
 * even one equal to the held list (it was filled again for the new category;
 * left out, the route would write `null` over it). Each changed field is
 * normalised ALONE, so a stored value the write schema refuses (a legacy
 * `category_id: 0`) blocks nothing while nobody touches it.
 *
 * `attributes` belong to the category: picking another category empties them
 * (they are the old category's), and putting the HELD category back restores
 * the held list ({@link comCampoRascunhoShopee}). A typing the attribute editor
 * cannot accept yet (a digitação that blocks) makes `attributes` an invalid
 * changed field, so «Salvar rascunho» waits for it
 * ({@link planoDoRascunhoShopee}). The tie runs the other way too: a list was
 * built against ONE category's tree, so a save of an edited list that does not
 * change the category still names the category in its base
 * (`camposDaBaseDoRascunhoShopee`, P13 Q1) — the route refuses a list whose
 * category moved, and the tab refuses it first, without a request
 * ({@link conflitosAntesDeSalvarShopee}).
 *
 * ## Rule 7 — the browser writes nothing
 *
 * Every draft write goes through apps/shopee's draft route (the P8 client
 * methods): a create at a client id (tier 0), an edit and a discard compared
 * against the `base` the operator saw (tier 3 — a loser is a 409 the operator
 * sees, never a silent overwrite). ⚠️ The route compares only the fields of the
 * patch's `base` — and an attributes-only patch's base names the category its
 * list was built for (`camposDaBaseDoRascunhoShopee`, P13 Q1): another
 * writer's category is a 409, never this list written onto it. The tab checks
 * that one first ({@link divergenciasDoServidorShopee} names `category_id`;
 * the save then sends nothing and opens the conflict modal with the rows the
 * route's 409 would carry), and the rebase never moves the category unseen
 * while the list is edited ({@link rebasearEdicaoRascunhoShopee}). A category
 * write landing between this tab's last snapshot and its request, which the
 * tab cannot see, is the route's 409. After a 2xx the HELD projection is never
 * rebuilt from what was sent (`gravados` may name fields the patch did not — a
 * category change clears `attributes`): the block shows what was saved,
 * read-only, until the listener brings the stored draft back
 * ({@link marcarRascunhoShopeeSalvo}, {@link conciliarEdicaoRascunhoShopee}).
 */
import {
  CAMPO_RASCUNHO_SHOPEE,
  MOTIVO_RASCUNHO_INVALIDO_SHOPEE,
  TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE,
  camposDaBaseDoRascunhoShopee,
  camposDoRascunhoShopee,
  conteudoRascunhoShopeeSchema,
  ehRascunhoShopee,
  estadoPublicacaoRascunhoShopee,
  marcaParaRascunhoShopee,
  mesmoValorDoRascunhoShopee,
  mesmoValorGravadoDoRascunhoShopee,
  pendenciasDoRascunhoShopee,
  vinculosQueExigemConfirmacaoShopee,
  type ArgsPendenciasRascunhoShopee,
  type ArvoreAtributosShopee,
  type CampoRascunhoShopee,
  type CamposRascunhoShopee,
  type ConflitoRascunhoShopee,
  type EstadoPublicacaoRascunhoShopee,
  type MarcaDaContaShopee,
  type MarcaRascunhoShopee,
  type PendenciaRascunhoShopee,
  type VinculoConflitanteShopee,
} from '@delfrance/schemas';

import { newDocId } from '@/lib/data/newDocId';
import {
  FRASE_CATEGORIA_TRAVADA_SHOPEE,
  FRASE_CONTA_NAO_ENCONTRADA_SHOPEE,
  FRASE_CORRIGIR_NO_SELLER_CENTRE_SHOPEE,
  FRASE_DESCARTE_EM_CONFLITO_SHOPEE,
  FRASE_LIMITE_NA_PUBLICACAO_DO_RASCUNHO_SHOPEE,
  FRASE_MARCA_PODE_NAO_VALER_SHOPEE,
  FRASE_PRODUTO_INEXISTENTE_SHOPEE,
  FRASE_PUBLICACAO_CONTENCAO_SHOPEE,
  FRASE_PUBLICACAO_CRIACAO_INCERTA_SEM_JANELA_SHOPEE,
  FRASE_PUBLICAR_COM_ALTERACOES_SHOPEE,
  FRASE_PUBLICAR_PRODUTO_NAO_SALVO_SHOPEE,
  FRASE_PUBLICAR_RASCUNHO_NOVO_SHOPEE,
  FRASE_PUBLICAR_SEM_ATRIBUTOS_SHOPEE,
  FRASE_PUBLICAR_SEM_FAIXAS_SHOPEE,
  FRASE_RASCUNHO_INEXISTENTE_NA_PUBLICACAO_SHOPEE,
  MOTIVO_ANUNCIO_SHOPEE,
  ROTULO_ABRIR_TABELA_DE_MEDIDAS_SHOPEE,
  ROTULO_ABRIR_VARIACOES_SHOPEE,
  ROTULO_CAMPO_RASCUNHO_SHOPEE,
  ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE,
  ROTULO_PUBLICAR_ATESTANDO_SEM_SKU_SHOPEE,
  ROTULO_PUBLICAR_SEGUNDO_DE_PROPOSITO_SHOPEE,
  avisoDoDescarteComAnuncioSemVinculoShopee,
  fraseDaPublicacaoDoRascunhoEmAndamentoShopee,
  fraseDosRascunhosIrmaosIncertosShopee,
  fraseDaPublicacaoExpiradaShopee,
  fraseDaPublicacaoInterrompidaShopee,
  rotuloDaPublicacaoQueAdotaShopee,
  FRASE_RASCUNHO_AGUARDANDO_SERVIDOR_SHOPEE,
  FRASE_RASCUNHO_CARREGANDO_SHOPEE,
  FRASE_RASCUNHO_DE_KIT_VIRTUAL_SHOPEE,
  FRASE_RASCUNHO_DE_VARIACAO_SHOPEE,
  FRASE_RASCUNHO_DESCARTADO_DURANTE_EDICAO_SHOPEE,
  FRASE_RASCUNHO_EM_KIT_VIRTUAL_SHOPEE,
  FRASE_RASCUNHO_ID_EM_USO_SHOPEE,
  FRASE_RASCUNHO_INCERTO_SHOPEE,
  FRASE_ATESTACAO_DE_RASCUNHO_JA_PUBLICADO_SHOPEE,
  FRASE_RASCUNHO_INEXISTENTE_SHOPEE,
  FRASE_RASCUNHO_JA_PUBLICADO_SHOPEE,
  FRASE_RASCUNHO_NOVO_SHOPEE,
  FRASE_RASCUNHO_PUBLICADO_DURANTE_EDICAO_SHOPEE,
  FRASE_RASCUNHO_SEM_TITULO_SHOPEE,
  fraseDaPublicacaoEmAndamentoShopee,
  fraseDaRespostaIlegivelDoRascunhoShopee,
  fraseDaRespostaIncertaDoRascunhoShopee,
  fraseDoConflitoDeConcorrenciaShopee,
  fraseDoConflitoIlegivelShopee,
  fraseDoRascunhoEmAndamentoShopee,
  type OperacaoRascunhoShopee,
} from './anuncioProduto';
import {
  aplicarEdicaoDoAtributoShopee,
  digitacoesBloqueiam,
  type DigitacoesAtributosShopee,
  type EdicaoDoAtributoShopee,
} from './atributosRascunho';
import {
  ShopeeClientNetworkError,
  ShopeeClientRespostaInvalidaError,
  shopeeHttpFallbackMessage,
  type AtualizarRascunhoShopeeInput,
  type CamposDoCorpoRascunhoShopee,
  type CriarRascunhoShopeeInput,
  type DescartarRascunhoShopeeInput,
  type PublicarShopeeInput,
  type ShopeeClientHttpError,
} from './client';
import { CODIGO_FALHA_SHOPEE, descreverFalhaShopee, motivoRascunhoInvalido } from './erros';
import type { ProblemaShopee } from './wire';

/* -------------------------------------------------------------------------- */
/*                         The fields this form renders                        */
/* -------------------------------------------------------------------------- */

/**
 * The draft fields the form renders and may put in a patch, canonical order:
 * the P10 four, and `attributes` since the attribute editor (P13).
 * `logistic_info` joins with the logistics editor (P16) — until then it is
 * never sent by an edit.
 */
export const CAMPOS_DO_FORMULARIO_RASCUNHO_SHOPEE = [
  CAMPO_RASCUNHO_SHOPEE.itemName,
  CAMPO_RASCUNHO_SHOPEE.description,
  CAMPO_RASCUNHO_SHOPEE.categoryId,
  CAMPO_RASCUNHO_SHOPEE.marca,
  CAMPO_RASCUNHO_SHOPEE.attributes,
] as const satisfies readonly CampoRascunhoShopee[];
export type CampoDoFormularioRascunhoShopee = (typeof CAMPOS_DO_FORMULARIO_RASCUNHO_SHOPEE)[number];

/**
 * The form fields a plain input sets ({@link comCampoRascunhoShopee}) — every
 * one but `attributes`, which only the attribute editor writes
 * ({@link comAtributoRascunhoShopee}: the visible filter, the base-relative
 * order and the typings). A list set through the generic path would skip all
 * three, so the type refuses it.
 */
export type CampoSimplesDoFormularioRascunhoShopee = Exclude<
  CampoDoFormularioRascunhoShopee,
  typeof CAMPO_RASCUNHO_SHOPEE.attributes
>;

/**
 * What the form holds, in the projection's types: `item_name` and
 * `description` as typed (a cleared input is `''` — never trimmed here),
 * `category_id` as picked, `marca` as the PAIR (`null` = not chosen; "Sem
 * marca" is {@link MARCA_SEM_MARCA_RASCUNHO_SHOPEE}), `attributes` in the
 * request shape the attribute editor keeps (the operator's own value objects —
 * a typed text RAW, a typed decimal in its wire form; `null` = none).
 */
export type FormularioRascunhoShopee = {
  readonly [C in CampoDoFormularioRascunhoShopee]: CamposRascunhoShopee[C];
};

/** A patch: the CHANGED form fields, each normalised as the draft route stores it. */
export type PatchDoRascunhoShopee = Partial<FormularioRascunhoShopee>;

/** The form fields of a projection — its `attributes` list VERBATIM (by reference). */
export function formularioDoRascunhoShopee(campos: CamposRascunhoShopee): FormularioRascunhoShopee {
  return {
    item_name: campos.item_name,
    description: campos.description,
    category_id: campos.category_id,
    marca: campos.marca,
    attributes: campos.attributes,
  };
}

/* -------------------------------------------------------------------------- */
/*                              The entry (DC §2.2)                            */
/* -------------------------------------------------------------------------- */

/**
 * One draft being edited on this screen — kept at the TOP of the tab, keyed by
 * `linkDocId` (React keeps a hidden Activity's state; a block's own state would
 * not survive a remount). A stored draft with NO entry renders its snapshot
 * values, which are always current; the first keystroke creates one
 * ({@link edicaoDoRascunhoGuardadoShopee}).
 */
export interface EdicaoRascunhoShopee {
  readonly linkDocId: string;
  /** The conta (`integracao` id) the draft belongs to. */
  readonly contaId: string;
  /** Local only: created on this screen, no create acknowledged yet. */
  readonly novo: boolean;
  /**
   * THE held projection — what the operator LOADED (`camposDoRascunhoShopee`
   * of the snapshot when the entry was created, or rebased). Every edit's and
   * discard's `base` is cut from it, never re-read at click time. For a `novo`
   * entry: the prefill.
   */
  readonly base: CamposRascunhoShopee;
  /** The form's current values. */
  readonly atual: FormularioRascunhoShopee;
  /**
   * The attribute editor's typings not (yet) in {@link atual}'s list
   * (`./atributosRascunho.ts`, keyed by `String(attributeId)`): a typed text
   * the editor cannot accept (a decimal with a dot, a number with no unit…)
   * stays on screen here and BLOCKS the save ({@link planoDoRascunhoShopee});
   * a blank text with a chosen unit only remembers the unit. `{}` on a new
   * entry and after a category change.
   */
  readonly digitacoesAtributos: DigitacoesAtributosShopee;
  /**
   * Set by {@link marcarRascunhoShopeeSalvo} after a 2xx: what THIS draft's
   * document looked like in the links snapshot current when the request LEFT
   * — never the one current at the answer, which may already be the route's
   * echo (then nothing would ever move again and the block would stay
   * read-only). While it shows what was saved, read-only, the entry waits for
   * THIS document's echo, never for just any newer snapshot: the query holds
   * every Shopee link of the produto, and another link's write landing first
   * would repaint the PRE-save draft ({@link conciliarEdicaoRascunhoShopee}).
   */
  readonly salvo: SalvoDoRascunhoShopee | null;
}

/** What a just-saved entry waits on (see {@link EdicaoRascunhoShopee.salvo}). */
export interface SalvoDoRascunhoShopee {
  /** The links snapshot (`linksSnap.data`, by identity) current when the request left. */
  readonly snapshot: unknown;
  /**
   * THIS draft's document in that snapshot — its `ultimaModificacao` as read
   * (raw: the draft route stamps every create and update with it) — or `null`
   * when the snapshot did not hold it (a create).
   */
  readonly documento: { readonly ultimaModificacao: unknown } | null;
}

/**
 * The id of a NEW draft: a Firestore-style auto-id (`newDocId`, the app's one
 * minting helper — a raw `doc(collection)` is lint-banned here) — exactly
 * `PADRAO_ID_RASCUNHO_SHOPEE`'s shape (20 letters or digits), never a UUID.
 * Minted locally; nothing is written. Generated ONCE per "Novo anúncio" click
 * and reused by every retry of that create, so a retry whose first answer was
 * lost reaches the same draft (200 `criado: false`).
 */
export function idDeNovoRascunhoShopee(): string {
  return newDocId();
}

/**
 * A NEW local draft (DC §2.4–2.5, D2): the title prefilled with the stored
 * produto's `nome` VERBATIM (anything that is not a string is `null` — a blank
 * title blocks Salvar), the produto's own description (`null`), no category,
 * no brand chosen, no attributes. Nothing is sent until "Salvar rascunho".
 */
export function novaEdicaoRascunhoShopee(args: {
  readonly linkDocId: string;
  readonly contaId: string;
  readonly nomeProduto: unknown;
}): EdicaoRascunhoShopee {
  const base: CamposRascunhoShopee = {
    item_name: typeof args.nomeProduto === 'string' ? args.nomeProduto : null,
    description: null,
    category_id: null,
    marca: null,
    attributes: null,
  };
  return {
    linkDocId: args.linkDocId,
    contaId: args.contaId,
    novo: true,
    base,
    atual: formularioDoRascunhoShopee(base),
    digitacoesAtributos: {},
    salvo: null,
  };
}

/**
 * The entry of a STORED draft, created by the first keystroke: `base` = the
 * projection of the snapshot document, the form = its fields. Call it only
 * under server truth (`BlocoRascunhoShopee.camposEditaveis` says when).
 */
export function edicaoDoRascunhoGuardadoShopee(args: {
  readonly linkDocId: string;
  readonly contaId: string;
  readonly link: Record<string, unknown>;
}): EdicaoRascunhoShopee {
  const base = camposDoRascunhoShopee(args.link);
  return {
    linkDocId: args.linkDocId,
    contaId: args.contaId,
    novo: false,
    base,
    atual: formularioDoRascunhoShopee(base),
    digitacoesAtributos: {},
    salvo: null,
  };
}

/**
 * One form field set. Pure; the block decides whether the field may be typed
 * into. ⚠️ Typing into a just-saved entry ends its read-only bridge: its `base`
 * is then the PRE-save projection, so the next save's baseline answers a
 * 409 the operator sees — the safe direction, never a silent overwrite.
 *
 * **A category pick carries the attributes with it** (they belong to the
 * category): a pick that CHANGES the form's category empties `attributes` and
 * drops every typing — except putting the HELD category back
 * (`base.category_id`), which restores the held list. A pick of the category
 * the form already holds changes nothing (the operator's attributes stay).
 * The picker warns first while `BlocoRascunhoShopee.atributosPreenchidos`.
 */
export function comCampoRascunhoShopee<C extends CampoSimplesDoFormularioRascunhoShopee>(
  edicao: EdicaoRascunhoShopee,
  campo: C,
  valor: FormularioRascunhoShopee[C],
): EdicaoRascunhoShopee {
  const atual: FormularioRascunhoShopee = { ...edicao.atual, [campo]: valor };
  const categoria = CAMPO_RASCUNHO_SHOPEE.categoryId;
  if (
    campo !== categoria ||
    mesmoValorGravadoDoRascunhoShopee(categoria, edicao.atual.category_id, atual.category_id)
  ) {
    return { ...edicao, atual, salvo: null };
  }
  const deVolta = mesmoValorGravadoDoRascunhoShopee(
    categoria,
    edicao.base.category_id,
    atual.category_id,
  );
  return {
    ...edicao,
    atual: { ...atual, attributes: deVolta ? edicao.base.attributes : null },
    digitacoesAtributos: {},
    salvo: null,
  };
}

/**
 * One operator edit of one attribute (`./atributosRascunho.ts`'s
 * `aplicarEdicaoDoAtributoShopee`, over the form's list, the HELD base's list
 * and the entry's typings). `arvore` is the tree of the form's category (the
 * EDITED one) — the tab calls this only once it is loaded and only while the
 * block takes typing. A refused edit (the composer's, a pick beyond the cap)
 * and an edit that changes nothing answer the entry ITSELF; any other ends a
 * just-saved bridge like {@link comCampoRascunhoShopee}.
 */
export function comAtributoRascunhoShopee(
  edicao: EdicaoRascunhoShopee,
  arvore: ArvoreAtributosShopee,
  attributeId: number,
  edicaoDoAtributo: EdicaoDoAtributoShopee,
): EdicaoRascunhoShopee {
  const resultado = aplicarEdicaoDoAtributoShopee({
    arvore,
    lista: edicao.atual.attributes,
    guardados: edicao.base.attributes,
    digitacoes: edicao.digitacoesAtributos,
    attributeId,
    edicao: edicaoDoAtributo,
  });
  if (!resultado.ok) return edicao;
  if (
    resultado.lista === edicao.atual.attributes &&
    resultado.digitacoes === edicao.digitacoesAtributos
  ) {
    return edicao;
  }
  return {
    ...edicao,
    atual: { ...edicao.atual, attributes: resultado.lista },
    digitacoesAtributos: resultado.digitacoes,
    salvo: null,
  };
}

/* -------------------------------------------------------------------------- */
/*                      The brand picked (D10, §H Q1)                          */
/* -------------------------------------------------------------------------- */

/** "Sem marca" — Shopee's No Brand, an explicit CHOICE (`brand_id: 0`, no name). */
export const MARCA_SEM_MARCA_RASCUNHO_SHOPEE: MarcaRascunhoShopee = Object.freeze({
  brand_id: 0,
  original_brand_name: null,
});

/**
 * The pair a picked shortlist row puts on the form (D10): the row's own pair
 * (`marcaParaRascunhoShopee` — its name whenever it has one), EXCEPT a row
 * with NO name whose `brand_id` equals the STORED one: then the STORED name is
 * kept (§H Q1, Lucas 2026-10-28 — the same id is the same brand, and a
 * nameless legacy row must never erase the name the import wrote; the draft
 * route writes the pair whole). `guardada` is the HELD projection's `marca`
 * ({@link projecaoGuardadaDoRascunhoShopee}); a new draft has none.
 *
 * - same id, nameless row ⇒ `{id, <stored name>}` — so the pick changes
 *   nothing and no patch carries the brand;
 * - a DIFFERENT id, nameless row ⇒ `{id, null}` (the pair as picked);
 * - same id, a NAMED row ⇒ that row's name (a re-pick is how a name arrives).
 *
 * The rule itself is {@link comNomeGuardadoDaMarca} — the ONE copy, which the
 * conflict rebase applies too (a nameless pair the form already holds meets a
 * stored name there, not at a pick).
 */
export function marcaDaLinhaParaRascunhoShopee(
  linha: MarcaDaContaShopee,
  guardada: MarcaRascunhoShopee | null,
): MarcaRascunhoShopee {
  return comNomeGuardadoDaMarca(marcaParaRascunhoShopee(linha), guardada);
}

/**
 * §H Q1 (Lucas, 2026-10-28), THE rule: a pair with NO name whose `brand_id`
 * equals the stored one takes the STORED name — the same id is the same brand,
 * and a nameless pair must never erase the name the draft holds (the route
 * writes the pair whole). Any other pair is returned as is: a different id
 * keeps its `null` name, and a named pair keeps its own name.
 */
function comNomeGuardadoDaMarca(
  par: MarcaRascunhoShopee,
  guardada: MarcaRascunhoShopee | null,
): MarcaRascunhoShopee;
function comNomeGuardadoDaMarca(
  par: MarcaRascunhoShopee | null,
  guardada: MarcaRascunhoShopee | null,
): MarcaRascunhoShopee | null;
function comNomeGuardadoDaMarca(
  par: MarcaRascunhoShopee | null,
  guardada: MarcaRascunhoShopee | null,
): MarcaRascunhoShopee | null {
  if (
    par === null ||
    par.original_brand_name !== null ||
    guardada === null ||
    guardada.brand_id !== par.brand_id
  ) {
    return par;
  }
  return { brand_id: par.brand_id, original_brand_name: guardada.original_brand_name };
}

/* -------------------------------------------------------------------------- */
/*                   Dirty, the patch and what blocks a save                   */
/* -------------------------------------------------------------------------- */

/** Why "Salvar rascunho" cannot send anything now. */
export type ImpedimentoDoRascunhoShopee =
  /** Nothing differs from what is stored (the WRITE question). */
  | 'nada-a-salvar'
  /** A changed field holds a value no write accepts (a blank title, an oversize text). */
  | 'campo-invalido'
  /** The reading is `incerta` and the patch names `category_id` (409 `rascunhoCategoriaTravada`). */
  | 'categoria-travada'
  /** The reading is `em-andamento`: every draft route answers 409 now. */
  | 'publicacao-em-andamento'
  /** Just saved: waiting for the listener to bring the stored draft back. */
  | 'aguardando-servidor';

/** What a save of one entry would send, or why it cannot. */
export interface PlanoDoRascunhoShopee {
  /**
   * The fields to WRITE, normalised (blank description ⇒ `null`, brand `0` or
   * a blank name ⇒ no name, an attribute's custom name trimmed and a blank
   * unit omitted). For a `novo` entry: all five (the create's `conteudo`); for
   * a stored one: the {@link alterados}.
   */
  readonly patch: PatchDoRascunhoShopee;
  /** The fields in {@link patch}, canonical order. */
  readonly alterados: readonly CampoDoFormularioRascunhoShopee[];
  /**
   * Fields the operator changed (all five on a `novo` entry) that no write
   * accepts — and `attributes` whenever a typing BLOCKS
   * (`digitacoesBloqueiam`), even over a list that did not change.
   */
  readonly invalidos: readonly CampoDoFormularioRascunhoShopee[];
  /** Unsaved work exists: a `novo` entry, a field to write, or a changed field still invalid. */
  readonly sujo: boolean;
  /** `null` ⇔ the save can be sent. */
  readonly impedimento: ImpedimentoDoRascunhoShopee | null;
}

type Normalizado<C extends CampoDoFormularioRascunhoShopee> =
  | { readonly ok: true; readonly valor: FormularioRascunhoShopee[C] }
  | { readonly ok: false };

/**
 * ONE form field through the draft route's write whitelist
 * (`conteudoRascunhoShopeeSchema` — every key optional, so a single key
 * parses alone). A field the schema refuses is `ok: false`; it never costs the
 * other fields.
 */
function normalizar<C extends CampoDoFormularioRascunhoShopee>(
  campo: C,
  valor: FormularioRascunhoShopee[C],
): Normalizado<C> {
  const lido = conteudoRascunhoShopeeSchema.safeParse({ [campo]: valor });
  if (!lido.success) return { ok: false };
  const saida = lido.data[campo] as FormularioRascunhoShopee[C] | undefined;
  return { ok: true, valor: saida ?? (null as FormularioRascunhoShopee[C]) };
}

/** A patch built by name, field by field — never a spread of a wider object. */
function comCampoNoPatch<C extends CampoDoFormularioRascunhoShopee>(
  patch: PatchDoRascunhoShopee,
  campo: C,
  valor: FormularioRascunhoShopee[C],
): PatchDoRascunhoShopee {
  return { ...patch, [campo]: valor };
}

/**
 * THE plan of one entry against the publish reading `estado` (the block passes
 * `estadoPublicacaoRascunhoShopee(link, now)`; a local draft reads `livre`).
 *
 * A field of a STORED draft enters the patch when (1) the operator changed it —
 * the form value differs from the held projection under the WRITE question,
 * so an untouched legacy value is never re-written nor validated — and (2) its
 * NORMALISED value still differs from the projection under that question (a
 * `'  '` description over a stored `null` normalises to `null`: no change). A
 * field changed into a value no write accepts is {@link PlanoDoRascunhoShopee.invalidos}.
 *
 * `attributes` is asked FIRST whether a typing blocks
 * (`digitacoesBloqueiam(edicao.digitacoesAtributos)`): one that does makes the
 * field invalid even when the list itself did not change — the typed text is
 * on screen, so a save that dropped it would lose visible work. A list the
 * operator edited is the attribute editor's (visible filter, base order), so
 * the generic loop then asks it the same two questions as any field — EXCEPT
 * after a category change (`category_id` is decided first, canonical order):
 * the route then clears `attributes` unless the patch names them (K1-12), so
 * a non-empty list enters the patch even when it equals the held one — under
 * question (2) the held list is not what the category write leaves stored.
 * An emptied list stays the held-list question (its `null` is what the clear
 * writes anyway).
 *
 * `dirty ⇔ patch non-empty` (rev. 2a #3) — plus a `novo` entry, and a changed
 * field still invalid (typed work the leave-guard must not lose). Never the
 * CONFLICT question: under it a legacy id-only brand re-picked with its name
 * would read clean, and the name would never be stored.
 */
export function planoDoRascunhoShopee(
  edicao: EdicaoRascunhoShopee,
  estado: EstadoPublicacaoRascunhoShopee,
): PlanoDoRascunhoShopee {
  let patch: PatchDoRascunhoShopee = {};
  const alterados: CampoDoFormularioRascunhoShopee[] = [];
  const invalidos: CampoDoFormularioRascunhoShopee[] = [];

  const considerar = <C extends CampoDoFormularioRascunhoShopee>(campo: C): void => {
    if (
      campo === CAMPO_RASCUNHO_SHOPEE.attributes &&
      digitacoesBloqueiam(edicao.digitacoesAtributos)
    ) {
      invalidos.push(campo);
      return;
    }
    const valor = edicao.atual[campo];
    // K1-12: a category write clears the stored list unless the patch names it.
    const comATrocaDeCategoria =
      campo === CAMPO_RASCUNHO_SHOPEE.attributes &&
      valor !== null &&
      alterados.includes(CAMPO_RASCUNHO_SHOPEE.categoryId);
    const comparaComABase = !edicao.novo && !comATrocaDeCategoria;
    if (comparaComABase && mesmoValorGravadoDoRascunhoShopee(campo, edicao.base[campo], valor)) {
      return;
    }
    const normalizado = normalizar(campo, valor);
    if (!normalizado.ok) {
      invalidos.push(campo);
      return;
    }
    if (
      comparaComABase &&
      mesmoValorGravadoDoRascunhoShopee(campo, edicao.base[campo], normalizado.valor)
    ) {
      return;
    }
    patch = comCampoNoPatch(patch, campo, normalizado.valor);
    alterados.push(campo);
  };
  for (const campo of CAMPOS_DO_FORMULARIO_RASCUNHO_SHOPEE) considerar(campo);

  const sujo =
    edicao.salvo === null && (edicao.novo || alterados.length > 0 || invalidos.length > 0);
  return {
    patch,
    alterados,
    invalidos,
    sujo,
    impedimento: impedimentoDoPlano(edicao, estado, alterados, invalidos),
  };
}

/** The first reason, in this order, a plan cannot be sent — or `null`. */
function impedimentoDoPlano(
  edicao: EdicaoRascunhoShopee,
  estado: EstadoPublicacaoRascunhoShopee,
  alterados: readonly CampoDoFormularioRascunhoShopee[],
  invalidos: readonly CampoDoFormularioRascunhoShopee[],
): ImpedimentoDoRascunhoShopee | null {
  if (edicao.salvo !== null) return 'aguardando-servidor';
  if (estado.tipo === 'em-andamento') return 'publicacao-em-andamento';
  if (invalidos.length > 0) return 'campo-invalido';
  if (!edicao.novo && alterados.length === 0) return 'nada-a-salvar';
  // `incerta`: the uncertain attempt may have created the listing in the
  // STORED category, so the route refuses a change (a title edit still goes).
  if (estado.tipo === 'incerta' && alterados.includes(CAMPO_RASCUNHO_SHOPEE.categoryId)) {
    return 'categoria-travada';
  }
  return null;
}

/**
 * Whether this entry holds unsaved work — the leave-guard's question (the
 * page's `extraDirty`, `exigirRascunhosShopeeSalvos`). A just-saved entry is
 * clean; a `novo` one never is.
 */
export function edicaoRascunhoShopeeSuja(edicao: EdicaoRascunhoShopee): boolean {
  return planoDoRascunhoShopee(edicao, { tipo: 'livre' }).sujo;
}

/** Whether ANY of the produto's entries holds unsaved work. */
export function algumRascunhoShopeeSujo(edicoes: Iterable<EdicaoRascunhoShopee>): boolean {
  for (const edicao of edicoes) if (edicaoRascunhoShopeeSuja(edicao)) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/*                            The three bodies (B.5)                           */
/* -------------------------------------------------------------------------- */

/**
 * `criarRascunho`'s input for a `novo` entry, or `null` when its plan has an
 * impediment (a blank title, a blocking attribute typing, …). `conteudo` names
 * EVERY field — the five normalised form values, `attributes` the list the
 * operator filled (`null` when none) — so a create retry at the same id
 * compares like for like ({@link conflitosAtualizadosDoRascunhoShopee} reads
 * what it SENT the same way).
 * `confirmarSegundoAnuncio: true` only after the operator confirmed (D15).
 */
export function corpoCriarRascunhoShopee(
  edicao: EdicaoRascunhoShopee,
  estado: EstadoPublicacaoRascunhoShopee,
  opcoes: { readonly produtoId: string; readonly confirmarSegundoAnuncio?: boolean },
): CriarRascunhoShopeeInput | null {
  if (!edicao.novo) return null;
  const plano = planoDoRascunhoShopee(edicao, estado);
  if (plano.impedimento !== null) return null;
  const { patch } = plano;
  return {
    integracaoId: edicao.contaId,
    produtoId: opcoes.produtoId,
    linkDocId: edicao.linkDocId,
    conteudo: {
      item_name: patch.item_name ?? null,
      description: patch.description ?? null,
      category_id: patch.category_id ?? null,
      marca: patch.marca ?? null,
      attributes: patch.attributes ?? null,
    },
    ...(opcoes.confirmarSegundoAnuncio === true ? { confirmarSegundoAnuncio: true } : {}),
  };
}

/** The held projection's values for exactly `campos`, verbatim — an edit's `base`. */
function recorteDaProjecao(
  projecao: CamposRascunhoShopee,
  campos: readonly CampoRascunhoShopee[],
): Partial<CamposDoCorpoRascunhoShopee> {
  const base: {
    -readonly [K in keyof CamposDoCorpoRascunhoShopee]?: CamposDoCorpoRascunhoShopee[K];
  } = {};
  for (const campo of campos) {
    switch (campo) {
      case CAMPO_RASCUNHO_SHOPEE.itemName:
        base.item_name = projecao.item_name;
        break;
      case CAMPO_RASCUNHO_SHOPEE.description:
        base.description = projecao.description;
        break;
      case CAMPO_RASCUNHO_SHOPEE.categoryId:
        base.category_id = projecao.category_id;
        break;
      case CAMPO_RASCUNHO_SHOPEE.marca:
        base.marca = projecao.marca;
        break;
      case CAMPO_RASCUNHO_SHOPEE.attributes:
        base.attributes = projecao.attributes;
        break;
      case CAMPO_RASCUNHO_SHOPEE.logisticInfo:
        // RESERVED: no body accepts it, and no patch here ever names it.
        break;
    }
  }
  return base;
}

/**
 * `atualizarRascunho`'s input for a STORED entry, or `null` when its plan has
 * an impediment. `patch` = the plan's (only the changed fields, normalised);
 * `base` = the HELD projection cut to `camposDaBaseDoRascunhoShopee(patch)` —
 * the patch's fields plus `attributes` whenever the patch changes
 * `category_id` without them (that write clears them, so it must prove the
 * operator saw them), and `category_id` whenever the patch writes `attributes`
 * without it (the list was built for that category, so it must prove the
 * category is still the one the operator saw — P13 Q1). VERBATIM: a legacy
 * `''` title is sent back as `''`.
 */
export function corpoAtualizarRascunhoShopee(
  edicao: EdicaoRascunhoShopee,
  estado: EstadoPublicacaoRascunhoShopee,
  opcoes: { readonly produtoId: string },
): AtualizarRascunhoShopeeInput | null {
  if (edicao.novo) return null;
  const plano = planoDoRascunhoShopee(edicao, estado);
  if (plano.impedimento !== null) return null;
  return {
    integracaoId: edicao.contaId,
    produtoId: opcoes.produtoId,
    linkDocId: edicao.linkDocId,
    base: recorteDaProjecao(edicao.base, camposDaBaseDoRascunhoShopee(plano.patch)),
    patch: plano.patch,
  };
}

/**
 * The projection a block HOLDS: an unsaved entry's `base` (what the operator
 * loaded, even if the snapshot moved since — a discard then answers 409, never
 * deletes an edit unseen), else the snapshot document's projection (what the
 * block shows).
 */
export function projecaoGuardadaDoRascunhoShopee(
  edicao: EdicaoRascunhoShopee | null,
  link: Record<string, unknown>,
): CamposRascunhoShopee {
  return edicao !== null && !edicao.novo && edicao.salvo === null
    ? edicao.base
    : camposDoRascunhoShopee(link);
}

/**
 * `descartarRascunho`'s input: `base` = EVERY projected field of the held
 * projection — `item_name`, `description`, `category_id`, `marca`,
 * `attributes` — verbatim (`null` allowed), NEVER `logistic_info`.
 * `confirmarCriacaoIncerta: true` only after the operator's Seller-Centre
 * attestation (the three-case dialog's (a) or (b)). A `novo` entry is dropped
 * locally and never reaches this.
 */
export function corpoDescartarRascunhoShopee(args: {
  readonly contaId: string;
  readonly linkDocId: string;
  readonly produtoId: string;
  readonly projecao: CamposRascunhoShopee;
  readonly confirmarCriacaoIncerta?: boolean;
}): DescartarRascunhoShopeeInput {
  const { projecao } = args;
  return {
    integracaoId: args.contaId,
    produtoId: args.produtoId,
    linkDocId: args.linkDocId,
    base: {
      item_name: projecao.item_name,
      description: projecao.description,
      category_id: projecao.category_id,
      marca: projecao.marca,
      attributes: projecao.attributes,
    },
    ...(args.confirmarCriacaoIncerta === true ? { confirmarCriacaoIncerta: true } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/*                 After an answer, and when the snapshot moves                */
/* -------------------------------------------------------------------------- */

/**
 * The entry after a create's or an edit's 2xx: no longer `novo`, showing what
 * was SAVED (each field normalised as the route stored it) and tied to what
 * THIS draft's document looked like in the links snapshot current when the
 * request LEFT (`snapshot` — `linksSnap.data`; the echo may land before the
 * 2xx). Its `base` is deliberately NOT rebuilt from the patch (rev. 2a #7):
 * the document's echo drops the entry and the block repaints from the stored
 * draft ({@link conciliarEdicaoRascunhoShopee}).
 */
export function marcarRascunhoShopeeSalvo(
  edicao: EdicaoRascunhoShopee,
  /** `linksSnap.data` as the request LEFT: rows of `{ id, data }` (read defensively). */
  snapshot: unknown,
): EdicaoRascunhoShopee {
  let atual: FormularioRascunhoShopee = edicao.atual;
  for (const campo of CAMPOS_DO_FORMULARIO_RASCUNHO_SHOPEE) {
    const normalizado = normalizar(campo, edicao.atual[campo]);
    if (normalizado.ok) atual = { ...atual, [campo]: normalizado.valor };
  }
  const documento = documentoNoSnapshot(snapshot, edicao.linkDocId);
  return {
    ...edicao,
    novo: false,
    atual,
    salvo: {
      snapshot,
      documento: documento === null ? null : { ultimaModificacao: documento.ultimaModificacao },
    },
  };
}

/**
 * The document `linkDocId` in a links snapshot (`linksSnap.data` — rows of
 * `{id, data}`), or `null` when it holds none. Read defensively: the tab hands
 * the snapshot over as it got it, and anything that is not such a row is no
 * document.
 */
function documentoNoSnapshot(snapshot: unknown, linkDocId: string): Record<string, unknown> | null {
  if (!Array.isArray(snapshot)) return null;
  for (const linha of snapshot as readonly unknown[]) {
    if (typeof linha !== 'object' || linha === null) continue;
    const { id, data } = linha as { readonly id?: unknown; readonly data?: unknown };
    if (id === linkDocId && typeof data === 'object' && data !== null) {
      return data as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * The entry rebased on the STORED draft at `link` — after a 409
 * `rascunhoConflito`, by the conflict modal's two buttons. `link` must be the
 * CURRENT snapshot's document.
 *
 * **A stored draft's edit** (`!edicao.novo`). Its 409 lists only the fields of
 * the patch's base that changed (the CONFLICT question), so the rebase moves
 * ONLY what the operator was shown or never touched:
 *
 * - a field the operator did NOT change (the form value is the held one under
 *   the WRITE question): its base AND its form value become the stored ones —
 *   it never enters a patch, so another writer's value there is never
 *   reverted, and the block shows it;
 * - a field in `listados` (the 409's rows, which the modal showed): its base
 *   becomes the stored value, so the re-send overwrites exactly what the
 *   operator agreed to overwrite; the typed value stays;
 * - a field in `usarDoServidor` («Usar o que está salvo»): base and form value
 *   both become the stored ones;
 * - any OTHER changed field keeps the base the operator LOADED: a writer that
 *   landed there after the 409 makes the re-send a 409 again — the safe
 *   direction, never an overwrite of a value nobody showed.
 *
 * `attributes` is a form field like the others, with two rules that tie it to
 * the category it belongs to (`attributes` comes after `category_id` in the
 * canonical order, so it is decided against the REBASED category):
 *
 * - **never "untouched" while the operator's category change survives the
 *   rebase** — the list the category pick left (emptied) IS that change, so
 *   another writer's list is never taken into the base unseen: it moves only
 *   when listed (or named in `usarDoServidor`), and the form keeps the
 *   operator's list (the new category's); nor while a typing BLOCKS (the typed
 *   text is work on screen — it survives the rebase);
 * - **the category taken from the stored draft (`usarDoServidor`) takes the
 *   stored attributes too**, base and form — the operator gave up the category
 *   change, so the list goes back to the category's own (the pick's "put the
 *   held category back" rule);
 * - **`category_id` is never "untouched" while the operator's attributes are
 *   edited** (the list differs from the held one, or a typing blocks) — the
 *   mirror of the first rule: the list was built against the LOADED category's
 *   tree, so another writer's category is never taken into the form unseen
 *   under it. It moves only when listed (base) or named in `usarDoServidor`.
 *
 * Whenever the form's list is taken from the stored draft, the typings go
 * with it (they were typed over the list that left); otherwise they stay.
 *
 * `listados` defaults to `usarDoServidor` when that is given, else to the
 * fields that diverge NOW ({@link divergenciasDoServidorShopee} against
 * `link`). ⚠️ Pass the 409's own list on «Salvar mesmo assim»: the default
 * would also rebase a changed field another writer touched AFTER the 409, and
 * the modal never showed that value — check first with
 * {@link conflitosAtualizadosDoRascunhoShopee}.
 *
 * **A create retry** (`edicao.novo`, rev. 2a #19). Its 409 lists every field
 * that differs under the WRITE question, so nothing is hidden: `base` becomes
 * the whole projection of `link` and the entry an UPDATE built like any other —
 * the patch is the form fields the stored draft does not already hold, the base
 * its projection cut to `camposDaBaseDoRascunhoShopee`; `usarDoServidor`
 * fields take the stored values. ⚠️ Never built from the 409's
 * `conflitos[].atual`, which is display-only: a list differing only in
 * `category_id` would make a base without the `attributes` that change clears —
 * a 400.
 *
 * Both arms then re-apply §H Q1 to the form's brand against the new base (a
 * nameless pair with the stored `brand_id` takes the stored name), so a rebase
 * never erases a brand name a pick would have kept.
 */
export function rebasearEdicaoRascunhoShopee(
  edicao: EdicaoRascunhoShopee,
  link: Record<string, unknown>,
  usarDoServidor: readonly CampoRascunhoShopee[] = [],
  listados?: readonly CampoRascunhoShopee[],
): EdicaoRascunhoShopee {
  const guardado = camposDoRascunhoShopee(link);
  const doServidor = formularioDoRascunhoShopee(guardado);
  const ATRIBUTOS = CAMPO_RASCUNHO_SHOPEE.attributes;
  const CATEGORIA = CAMPO_RASCUNHO_SHOPEE.categoryId;
  let base: CamposRascunhoShopee = edicao.novo ? guardado : edicao.base;
  let atual = edicao.atual;
  /** «Usar o que está salvo» for `campo` — the stored category carries its attributes. */
  const usar = (campo: CampoDoFormularioRascunhoShopee): boolean =>
    usarDoServidor.includes(campo) || (campo === ATRIBUTOS && usarDoServidor.includes(CATEGORIA));
  let digitacoesAtributos = edicao.digitacoesAtributos;
  /** The form's value of `campo` becomes the stored one — a list's typings go with the list. */
  const tomar = (campo: CampoDoFormularioRascunhoShopee): void => {
    atual = { ...atual, [campo]: doServidor[campo] };
    if (campo === ATRIBUTOS) digitacoesAtributos = {};
  };

  if (edicao.novo) {
    for (const campo of CAMPOS_DO_FORMULARIO_RASCUNHO_SHOPEE) if (usar(campo)) tomar(campo);
  } else {
    const mostrados =
      listados ??
      (usarDoServidor.length > 0 ? usarDoServidor : divergenciasDoServidorShopee(edicao, link));
    const digitacaoBloqueia = digitacoesBloqueiam(edicao.digitacoesAtributos);
    const atributosEditados =
      digitacaoBloqueia ||
      !mesmoValorGravadoDoRascunhoShopee(
        ATRIBUTOS,
        edicao.base.attributes,
        edicao.atual.attributes,
      );
    const rebasear = <C extends CampoDoFormularioRascunhoShopee>(campo: C): void => {
      // `attributes` is decided after `category_id` (canonical order): `base`
      // and `atual` already hold the rebased category here.
      const daTrocaDeCategoria =
        campo === ATRIBUTOS &&
        !mesmoValorGravadoDoRascunhoShopee(CATEGORIA, base.category_id, atual.category_id);
      const intocado =
        !daTrocaDeCategoria &&
        !(campo === ATRIBUTOS && digitacaoBloqueia) &&
        !(campo === CATEGORIA && atributosEditados) &&
        mesmoValorGravadoDoRascunhoShopee(campo, edicao.base[campo], edicao.atual[campo]);
      if (intocado || (usar(campo) && !daTrocaDeCategoria)) {
        base = { ...base, [campo]: guardado[campo] };
        tomar(campo);
      } else if (mostrados.includes(campo) || usar(campo)) {
        base = { ...base, [campo]: guardado[campo] };
      }
    };
    for (const campo of CAMPOS_DO_FORMULARIO_RASCUNHO_SHOPEE) rebasear(campo);
  }

  if (!usarDoServidor.includes(CAMPO_RASCUNHO_SHOPEE.marca)) {
    atual = { ...atual, marca: comNomeGuardadoDaMarca(atual.marca, base.marca) };
  }
  return {
    ...edicao,
    novo: false,
    base,
    atual,
    digitacoesAtributos,
    salvo: null,
  };
}

/**
 * Before «Salvar mesmo assim» re-sends: do the 409's rows (`conflitos`, what
 * the modal shows as «Salvo agora») still show what the re-send would
 * overwrite? `null` ⇔ yes — re-send, rebased with `listados` = those rows'
 * fields. Otherwise the rows the modal must show NOW (each with the stored
 * value), and NOTHING is sent: a writer landed after the 409.
 *
 * What the re-send overwrites is every field of its base that the rebase took
 * from the stored draft — the listed ones of an edit, every one of a create
 * retry ({@link rebasearEdicaoRascunhoShopee}) — except a `category_id` its
 * patch does not name: beside an attributes-only list the route only COMPARES
 * the category (P13 Q1), never writes it, so a create retry whose category is
 * still the one it sent shows no «Categoria» row. Each must be a row whose
 * value is still what is stored, under the WRITE question (a brand renamed
 * under the same id counts: the modal showed the old name). A field of an
 * edit's base whose stored value moved after the 409 is added too — that
 * base-only category included ({@link divergenciasDoServidorShopee}): the
 * re-send would only answer 409 on it.
 *
 * The refreshed rows carry the projection's own values, so the next click
 * compares like with like and goes through unless the draft moves again — a
 * row value the wire changed in shape costs one refresh, never a loop.
 */
export function conflitosAtualizadosDoRascunhoShopee(
  edicao: EdicaoRascunhoShopee,
  link: Record<string, unknown>,
  conflitos: readonly ConflitoRascunhoShopee[],
): ConflitoRascunhoShopee[] | null {
  const listados = conflitos.map((c) => c.campo);
  const rebaseada = rebasearEdicaoRascunhoShopee(edicao, link, [], listados);
  const { patch } = planoDoRascunhoShopee(rebaseada, { tipo: 'livre' });
  const guardado = camposDoRascunhoShopee(link);
  // What the re-send OVERWRITES: its base's fields (the listed ones of an edit,
  // every one of a create retry) — except a `category_id` the patch does not
  // name, which the route only COMPARES beside an attributes-only list (P13 Q1).
  const sobrescritos = camposDaBaseDoRascunhoShopee(patch).filter(
    (campo) =>
      (campo !== CAMPO_RASCUNHO_SHOPEE.categoryId || campo in patch) &&
      (edicao.novo || listados.includes(campo)),
  );
  const moveram = edicao.novo ? [] : divergenciasDoServidorShopee(rebaseada, link);
  const aindaMostrado = (campo: CampoRascunhoShopee): boolean => {
    const linha = conflitos.find((c) => c.campo === campo);
    if (linha === undefined) {
      // A create retry's unlisted `attributes`: the 409 not listing them said
      // the stored draft held what the create SENT (`corpoCriarRascunhoShopee`:
      // the form's list normalised, `null` when none) — still true now?
      if (!edicao.novo || campo !== CAMPO_RASCUNHO_SHOPEE.attributes) return false;
      const enviado = normalizar(campo, edicao.atual.attributes);
      return enviado.ok && mesmoValorGravadoDoRascunhoShopee(campo, enviado.valor, guardado[campo]);
    }
    // `atual` is the wire's (`z.unknown()`), in the projection's form; the
    // compare is total over any value, so a foreign shape only reads DISTINCT.
    return mesmoValorGravadoDoRascunhoShopee(
      campo,
      linha.atual as CamposRascunhoShopee[typeof campo] | undefined,
      guardado[campo],
    );
  };
  if (moveram.length === 0 && sobrescritos.every(aindaMostrado)) return null;
  const campos = new Set<CampoRascunhoShopee>([...sobrescritos, ...moveram]);
  return [...campos]
    .filter((campo) => listados.includes(campo) || !aindaMostrado(campo))
    .map((campo) => ({ campo, atual: guardado[campo] }));
}

/** What the tab does with an entry once the links snapshot moved. */
export type ConciliacaoDaEdicaoShopee =
  | { readonly acao: 'manter' }
  /** Drop the entry; when it held unsaved work, show `aviso` — never a silent drop. */
  | { readonly acao: 'largar'; readonly aviso: string | null };

const MANTER: ConciliacaoDaEdicaoShopee = { acao: 'manter' };
const LARGAR: ConciliacaoDaEdicaoShopee = { acao: 'largar', aviso: null };

/**
 * Reconcile one entry with the CURRENT links snapshot (DC §2.2). Pure — call
 * it on every snapshot; a `largar` is applied by the tab.
 *
 * - **Just saved** — kept until THIS draft's echo: dropped (silently) once its
 *   document's `ultimaModificacao` differs from the one in the snapshot the
 *   request left against (the route stamps every write), or — for a create —
 *   once the document is in the snapshot at all; an edit's document gone from
 *   a SERVER-truth snapshot drops it too. Another link's write is NOT the echo
 *   and keeps it. A document with no numeric stamp to compare (a legacy draft
 *   never written by the route) is dropped by any newer snapshot, and so is
 *   every entry once `saturado` says the bounded query may never return the
 *   document — never a block stuck read-only.
 * - **A stored draft that is no longer a draft** (it gained a listing) —
 *   dropped, with a notice when it held unsaved work.
 * - **A stored draft gone from a SERVER-truth snapshot** — dropped, with a
 *   notice when it held unsaved work (a cache-served snapshot proves nothing
 *   is gone).
 * - **A clean stored entry** — dropped: the block renders the snapshot, which
 *   is always current — EXCEPT one whose SCREEN the snapshot cannot repaint
 *   ({@link telaSoDaEntrada}: a typing — a unit chosen before its number — or a
 *   form value the write normalises away, like a custom value's trailing space
 *   being typed), kept while every field it loaded is still what is stored. A
 *   snapshot that moved under it drops it (never a stale base painted): only
 *   that whitespace or that unit is lost.
 * - **A `novo` entry** — kept while its document is absent (nothing was
 *   created) or still a draft (a create that landed while its answer was lost:
 *   the next Salvar is that create's retry).
 * - **A dirty entry** is never replaced by a snapshot: the operator's text
 *   survives a concurrent write, and the route's baseline is the guard —
 *   EXCEPT one holding nothing beyond what is stored (every field it would
 *   write is already stored, under the WRITE question, and none is invalid):
 *   an uncertain save that landed, or another tab saving the same text. It is
 *   dropped silently — nothing is lost — or its next Salvar would answer a 409
 *   against the operator's own write.
 */
export function conciliarEdicaoRascunhoShopee(
  edicao: EdicaoRascunhoShopee,
  agora: {
    readonly link: Record<string, unknown> | undefined;
    readonly snapshot: unknown;
    readonly servidorConfirmado: boolean;
    /** The links query hit its limit: a document may never arrive. Absent ⇒ `false`. */
    readonly saturado?: boolean;
  },
): ConciliacaoDaEdicaoShopee {
  if (edicao.salvo !== null) return conciliarSalvo(edicao.salvo, agora);
  const sujo = edicaoRascunhoShopeeSuja(edicao);
  const { link } = agora;
  if (link !== undefined && !ehRascunhoShopee(link)) {
    return { acao: 'largar', aviso: sujo ? FRASE_RASCUNHO_PUBLICADO_DURANTE_EDICAO_SHOPEE : null };
  }
  if (edicao.novo) return MANTER;
  if (link === undefined) {
    if (!agora.servidorConfirmado) return MANTER;
    return { acao: 'largar', aviso: sujo ? FRASE_RASCUNHO_DESCARTADO_DURANTE_EDICAO_SHOPEE : null };
  }
  if (!sujo) return telaSoDaEntrada(edicao, link) ? MANTER : LARGAR;
  return jaEstaGuardado(edicao, link) ? LARGAR : MANTER;
}

/**
 * A CLEAN stored entry whose form the snapshot cannot repaint — a typing (a
 * unit remembered before its number), or a form value that differs from the
 * held one only by what the write normalises (a custom value's raw text the
 * write trims) — while every field it loaded is still what `link` stores. Both
 * compares are the WRITE question: `'Alfa '` over a stored `'Alfa'` is EQUAL
 * for the write (the plan is clean) and DISTINCT for the screen (the space
 * being typed is on it).
 */
function telaSoDaEntrada(edicao: EdicaoRascunhoShopee, link: Record<string, unknown>): boolean {
  const naTela =
    Object.keys(edicao.digitacoesAtributos).length > 0 ||
    CAMPOS_DO_FORMULARIO_RASCUNHO_SHOPEE.some(
      (campo) => !mesmoValorGravadoDoRascunhoShopee(campo, edicao.base[campo], edicao.atual[campo]),
    );
  if (!naTela) return false;
  const guardado = camposDoRascunhoShopee(link);
  return CAMPOS_DO_FORMULARIO_RASCUNHO_SHOPEE.every((campo) =>
    mesmoValorGravadoDoRascunhoShopee(campo, edicao.base[campo], guardado[campo]),
  );
}

/** A just-saved entry against the current snapshot (see {@link conciliarEdicaoRascunhoShopee}). */
function conciliarSalvo(
  salvo: SalvoDoRascunhoShopee,
  agora: {
    readonly link: Record<string, unknown> | undefined;
    readonly snapshot: unknown;
    readonly servidorConfirmado: boolean;
    readonly saturado?: boolean;
  },
): ConciliacaoDaEdicaoShopee {
  if (agora.snapshot === salvo.snapshot) return MANTER;
  if (agora.saturado === true) return LARGAR;
  const { link } = agora;
  const { documento } = salvo;
  if (link === undefined) {
    // A create: its document is not here yet. An edit: gone only if the server says so.
    return documento !== null && agora.servidorConfirmado ? LARGAR : MANTER;
  }
  if (documento === null) return LARGAR;
  return mesmoCarimbo(documento.ultimaModificacao, link.ultimaModificacao) ? MANTER : LARGAR;
}

/**
 * The same `ultimaModificacao` — a plain stamp compare, no fold: only two
 * equal FINITE numbers are the same stamp; anything else (absent, a foreign
 * shape) reads as "moved", which drops the bridge — the safe direction.
 */
function mesmoCarimbo(antes: unknown, agora: unknown): boolean {
  return typeof antes === 'number' && Number.isFinite(antes) && antes === agora;
}

/**
 * A dirty STORED entry holding nothing beyond what `link` stores: no changed
 * field is invalid, and every field its patch would write is already stored
 * (the WRITE question — a brand stored id-only still differs from the same id
 * WITH a name).
 */
function jaEstaGuardado(edicao: EdicaoRascunhoShopee, link: Record<string, unknown>): boolean {
  const plano = planoDoRascunhoShopee(edicao, { tipo: 'livre' });
  if (plano.invalidos.length > 0) return false;
  const guardado = camposDoRascunhoShopee(link);
  return plano.alterados.every((campo) =>
    mesmoValorGravadoDoRascunhoShopee(campo, guardado[campo], plano.patch[campo]),
  );
}

/**
 * THE stale check: the fields this entry's next save would compare (its
 * `base`, `camposDaBaseDoRascunhoShopee` of its patch) whose STORED value is
 * no longer what the entry holds, under the CONFLICT question — e.g. another
 * tab saved the title meanwhile. Non-empty ⇒ that save will answer 409
 * `rascunhoConflito`; the block can say so before the click. `[]` for a
 * `novo` or just-saved entry, or one with nothing to save.
 *
 * That base includes `category_id` whenever the patch names `attributes`
 * WITHOUT it (P13 Q1): the list was built against the category the operator
 * loaded, so another writer's category is a divergence here exactly as it is a
 * 409 at the route. When this names `category_id` there, the tab refuses that
 * save itself ({@link conflitosAntesDeSalvarShopee}), and «Salvar mesmo assim»
 * re-checks through {@link conflitosAtualizadosDoRascunhoShopee}, whose
 * `moveram` is this.
 */
export function divergenciasDoServidorShopee(
  edicao: EdicaoRascunhoShopee,
  link: Record<string, unknown>,
): CampoRascunhoShopee[] {
  if (edicao.novo || edicao.salvo !== null) return [];
  const { patch } = planoDoRascunhoShopee(edicao, { tipo: 'livre' });
  const guardado = camposDoRascunhoShopee(link);
  return camposDaBaseDoRascunhoShopee(patch).filter(
    (campo) => !mesmoValorDoRascunhoShopee(campo, edicao.base[campo], guardado[campo]),
  );
}

/**
 * The rows the tab shows INSTEAD of sending a save the route would refuse too:
 * {@link divergenciasDoServidorShopee} names `category_id` while the patch does
 * not (an edited list whose category another writer moved). The route answers
 * that save 409 (its base names the category, P13 Q1); the tab refuses first
 * and spares the request. One row per diverging field, with its STORED value —
 * the 409's shape, so the conflict modal and «Salvar mesmo assim» treat it as
 * one. `null` ⇔ the save may go.
 */
export function conflitosAntesDeSalvarShopee(
  edicao: EdicaoRascunhoShopee,
  link: Record<string, unknown>,
): ConflitoRascunhoShopee[] | null {
  const divergencias = divergenciasDoServidorShopee(edicao, link);
  if (!divergencias.includes(CAMPO_RASCUNHO_SHOPEE.categoryId)) return null;
  const { patch } = planoDoRascunhoShopee(edicao, { tipo: 'livre' });
  if (CAMPO_RASCUNHO_SHOPEE.categoryId in patch) return null;
  const guardado = camposDoRascunhoShopee(link);
  return divergencias.map((campo) => ({ campo, atual: guardado[campo] }));
}

/* -------------------------------------------------------------------------- */
/*                         The second listing (D15)                            */
/* -------------------------------------------------------------------------- */

/**
 * How many of the produto's listings / drafts a conta already holds — the
 * confirmation's numbers. `quantidade` / `comRascunho` are the create-side
 * copy's (P10); the split (#1911 P11 review R8-copy#3) is the publish-side
 * copy's, which must not say «cria OUTRO anúncio» when every counted vínculo
 * is a draft: `naShopee` = vínculos naming a listing (`!rascunho`),
 * `rascunhos` = stored drafts plus this screen's LOCAL ones. Both counters
 * here always fill the split; a literal without it reads as an UNKNOWN split
 * (`./anuncioProduto.ts`: never "only drafts").
 *
 * `rascunhosIncertos` (review round 2) = of those stored drafts, how many
 * record a create whose outcome is unknown — their last attempt may have
 * created an unlinked listing, so «nenhum anúncio dele na Shopee» would not be
 * known. Spread ONLY when > 0 (absent = none), by
 * {@link segundoAnuncioNaContaShopee}; a 409's list never carries it (the
 * server answers that 409 only once every other link reads `livre`).
 */
export interface ExistentesNaContaShopee {
  readonly quantidade: number;
  readonly comRascunho: boolean;
  readonly naShopee?: number;
  readonly rascunhos?: number;
  readonly rascunhosIncertos?: number;
}

/**
 * THE reading ({@link estadoPublicacaoRascunhoShopee}) once every window has
 * passed (`nowMs = +∞`): `incerta` ⇔ the document records a create that was
 * SENT and whose outcome is unknown — a record, a stamped lock (running now
 * or not), or an unreadable one (the reader's doubts all go there) — and
 * `livre` ⇔ nothing was ever sent under it (no lock, or one never stamped).
 * Clock-free on purpose: the question is what the draft's attempts MAY have
 * created, not whether one is running this second.
 */
function registraCriacaoQuePodeExistir(data: Record<string, unknown>): boolean {
  return estadoPublicacaoRascunhoShopee(data, Number.POSITIVE_INFINITY).tipo === 'incerta';
}

/**
 * Of `vinculos` (a `vinculosQueExigemConfirmacaoShopee` set over `links`),
 * the STORED drafts whose document records a create that may exist
 * ({@link registraCriacaoQuePodeExistir}), in input order — THE one reading
 * behind both the D15 count (`rascunhosIncertos`) and the «Publicar» gate's
 * `irmao-incerto` ({@link rascunhosIrmaosIncertosShopee}).
 */
function rascunhosQuePodemTerCriado(
  links: readonly { readonly id: string; readonly data: Record<string, unknown> }[],
  vinculos: readonly VinculoConflitanteShopee[],
): string[] {
  const dados = new Map(links.map((l) => [l.id, l.data]));
  return vinculos
    .filter((v) => {
      const data = v.rascunho ? dados.get(v.linkDocId) : undefined;
      return data !== undefined && registraCriacaoQuePodeExistir(data);
    })
    .map((v) => v.linkDocId);
}

/**
 * The OTHER drafts of this produto on `contaId` that hold a draft's «Publicar»
 * back (#1911 P11 review round 3, R8-copy#3's sibling) — the stored drafts
 * whose last attempt may have created a listing, read by THE same reading as
 * the D15 count ({@link segundoAnuncioNaContaShopee}'s `rascunhosIncertos`),
 * `linkDocId` itself left out.
 *
 * Why it gates: the reservation's sibling scan (apps/shopee
 * `reservaRascunho.ts`, `recusarSegundoAnuncio`) refuses EVERY publish of a
 * draft — the D15 confirmation included — while any other link of the
 * produto on the conta does not read `livre` at the server's clock. Each
 * draft counted here never reads `livre` there: a record or an unreadable
 * lock is `incerta`, and a STAMPED lock (it may have sent) is `em-andamento`
 * until its grace ends and `incerta` after. So a publish opened over one
 * would only come back 409. ⚠️ The reverse does not hold, on purpose: a lock
 * never STAMPED (its run never reached the send) reads `livre` here at once
 * — §H Q3's rule, the schemas reader's own — so a sibling whose run is still
 * before the send is not counted: the server may still refuse that one,
 * briefly, and its 409 names the wait (`fraseDaPublicacaoDoRascunhoEmAndamentoShopee`).
 * The gate never closes over a sibling the server would read `livre`.
 */
export function rascunhosIrmaosIncertosShopee(
  links: readonly { readonly id: string; readonly data: Record<string, unknown> }[],
  contaId: string,
  linkDocId: string,
): readonly string[] {
  return rascunhosQuePodemTerCriado(
    links,
    vinculosQueExigemConfirmacaoShopee(links, contaId, linkDocId),
  );
}

/**
 * Before "Novo anúncio" on `contaId`: what makes the new draft a SECOND
 * listing, or `null` when nothing does. The stored links are judged by
 * `vinculosQueExigemConfirmacaoShopee` — the SAME set the draft route's create
 * and the publish re-check refuse with (a live listing, a superseded one still
 * on Shopee, or a draft; a `removido` one does not count) — plus this screen's
 * own LOCAL drafts of that conta whose document is not in the snapshot yet:
 * a `novo` one, and one JUST created (`salvo`, its echo not arrived) — a
 * saved entry of a STORED draft always has its document in the snapshot it
 * is tied to, so only a fresh create reaches this.
 *
 * `excluirLinkDocId` (#1911 P11) — the draft being PUBLISHED: the question
 * is then "does publishing it make a second listing", so it is left out of
 * both halves (the route's reservation excludes it the same way). Its local
 * drafts still count — the safe direction: one more warning, never one less.
 * A conta holding only REMOVED listings asks nothing, here as at the route.
 */
export function segundoAnuncioNaContaShopee(
  links: readonly { readonly id: string; readonly data: Record<string, unknown> }[],
  contaId: string,
  edicoes: Iterable<EdicaoRascunhoShopee>,
  excluirLinkDocId?: string,
): ExistentesNaContaShopee | null {
  const vinculos = vinculosQueExigemConfirmacaoShopee(links, contaId, excluirLinkDocId);
  const ids = new Set(links.map((l) => l.id));
  let locais = 0;
  for (const e of edicoes) {
    if (
      (e.novo || e.salvo !== null) &&
      e.contaId === contaId &&
      !ids.has(e.linkDocId) &&
      e.linkDocId !== excluirLinkDocId
    ) {
      locais++;
    }
  }
  if (vinculos.length === 0 && locais === 0) return null;
  const rascunhosGuardados = vinculos.filter((v) => v.rascunho).length;
  // A LOCAL draft was never sent: only stored ones can record an attempt.
  const rascunhosIncertos = rascunhosQuePodemTerCriado(links, vinculos).length;
  return {
    quantidade: vinculos.length + locais,
    comRascunho: locais > 0 || rascunhosGuardados > 0,
    naShopee: vinculos.length - rascunhosGuardados,
    rascunhos: rascunhosGuardados + locais,
    ...(rascunhosIncertos > 0 ? { rascunhosIncertos } : {}),
  };
}

/**
 * The confirmation's numbers from a 409 `rascunhoContaJaTemAnuncio`'s
 * `detalhes.vinculos` — an unreadable list (`[]`) splits to `0`/`0`, which
 * the copy reads as unknown, never as "only drafts". No `rascunhosIncertos`:
 * on a publish the reservation answers this 409 only after its sibling scan
 * read every OTHER link `livre` (anything else is `publicacaoEmAndamento`),
 * and a `livre` draft records no attempt (the create-side copy reads none of
 * the split).
 */
export function existentesDosVinculosShopee(
  vinculos: readonly VinculoConflitanteShopee[],
): ExistentesNaContaShopee {
  const rascunhos = vinculos.filter((v) => v.rascunho).length;
  return {
    quantidade: vinculos.length,
    comRascunho: rascunhos > 0,
    naShopee: vinculos.length - rascunhos,
    rascunhos,
  };
}

/* -------------------------------------------------------------------------- */
/*                       What a refusal means (§C.2)                           */
/* -------------------------------------------------------------------------- */

/** A failed draft operation, read for the tab. */
export type FalhaDoRascunhoShopee =
  /** 409 `rascunhoConflito` with the fields that differ: the conflict modal (create retry or edit). */
  | { readonly tipo: 'conflito'; readonly conflitos: readonly ConflitoRascunhoShopee[] }
  /** 409 `rascunhoContaJaTemAnuncio` on a create: the second-listing confirmation, then a re-send. */
  | { readonly tipo: 'segundo-anuncio'; readonly vinculos: readonly VinculoConflitanteShopee[] }
  /** 409 `rascunhoCriacaoIncerta` on a discard: the three-case dialog. */
  | { readonly tipo: 'criacao-incerta' }
  /** The draft is no longer one, or no longer exists: drop the entry and show `mensagem`. */
  | { readonly tipo: 'largar'; readonly mensagem: string }
  /**
   * Anything else: show `mensagem`, keep the entry. `incerto` ⇔ the operation
   * MAY have happened (no answer, an unreadable 2xx, a 5xx): never a success,
   * never "nada foi salvo" — the tab waits for the listener.
   */
  | { readonly tipo: 'mensagem'; readonly mensagem: string; readonly incerto: boolean };

function mensagem(texto: string, incerto = false): FalhaDoRascunhoShopee {
  return { tipo: 'mensagem', mensagem: texto, incerto };
}

/**
 * THE reading of a failed draft call — by the client's error CLASS, then the
 * backend's `code` (never the status alone: one 404 means the produto on a
 * create and the draft on an edit or a discard). The codes the draft routes
 * never answer (`publicacaoExpirada`, `rascunhoContencao` — publish only, read
 * by {@link falhaDaPublicacaoDoRascunhoShopee}) fall through to the channel's
 * ladder with the server's own sentence.
 */
export function falhaDoRascunhoShopee(
  err: ShopeeClientHttpError | ShopeeClientNetworkError,
  operacao: OperacaoRascunhoShopee,
): FalhaDoRascunhoShopee {
  if (err instanceof ShopeeClientNetworkError) {
    return mensagem(fraseDaRespostaIncertaDoRascunhoShopee(operacao), true);
  }
  // A SUBCLASS of the HTTP error: read first, or its `code` would be read.
  if (err instanceof ShopeeClientRespostaInvalidaError) {
    return mensagem(fraseDaRespostaIlegivelDoRascunhoShopee(operacao), true);
  }
  const { code, detalhes, status } = err;
  switch (code) {
    case CODIGO_FALHA_SHOPEE.rascunhoConflito: {
      const { conflitos } = detalhes;
      if (conflitos === null) return mensagem(fraseDoConflitoIlegivelShopee(operacao));
      if (conflitos.length === 0) return mensagem(fraseDoConflitoDeConcorrenciaShopee(operacao));
      if (operacao === 'descartar') return mensagem(FRASE_DESCARTE_EM_CONFLITO_SHOPEE);
      return { tipo: 'conflito', conflitos };
    }
    case CODIGO_FALHA_SHOPEE.publicacaoEmAndamento:
      return mensagem(fraseDaPublicacaoEmAndamentoShopee(detalhes.aguardarMs, operacao));
    case CODIGO_FALHA_SHOPEE.rascunhoJaPublicado:
      return { tipo: 'largar', mensagem: FRASE_RASCUNHO_JA_PUBLICADO_SHOPEE };
    case CODIGO_FALHA_SHOPEE.rascunhoInexistente:
      return operacao === 'criar'
        ? mensagem(FRASE_PRODUTO_INEXISTENTE_SHOPEE)
        : { tipo: 'largar', mensagem: FRASE_RASCUNHO_INEXISTENTE_SHOPEE };
    case CODIGO_FALHA_SHOPEE.rascunhoContaJaTemAnuncio:
      if (operacao === 'criar')
        return { tipo: 'segundo-anuncio', vinculos: detalhes.vinculos ?? [] };
      break;
    case CODIGO_FALHA_SHOPEE.rascunhoCriacaoIncerta:
      if (operacao === 'descartar') return { tipo: 'criacao-incerta' };
      break;
    case CODIGO_FALHA_SHOPEE.rascunhoCategoriaTravada:
      return mensagem(FRASE_CATEGORIA_TRAVADA_SHOPEE);
    case CODIGO_FALHA_SHOPEE.rascunhoIdEmUso:
      return mensagem(FRASE_RASCUNHO_ID_EM_USO_SHOPEE);
    case CODIGO_FALHA_SHOPEE.rascunhoProdutoInvalido: {
      const motivo = motivoRascunhoInvalido(err);
      if (motivo === MOTIVO_RASCUNHO_INVALIDO_SHOPEE.filho) {
        return mensagem(FRASE_RASCUNHO_DE_VARIACAO_SHOPEE);
      }
      if (motivo === MOTIVO_RASCUNHO_INVALIDO_SHOPEE.kitVirtual) {
        return mensagem(FRASE_RASCUNHO_DE_KIT_VIRTUAL_SHOPEE);
      }
      return mensagem(err.message);
    }
    case null:
      // The CODELESS answers. The conta's 404 carries the route's `{error}`
      // envelope; a 404 WITHOUT one (the client's fallback sentence) is a
      // route this backend LACKS — an apps/shopee build older than the draft
      // routes, or a rollback — and keeps that sentence: never "the conta".
      // The create's no-title 400 is the one codeless 400 that names the
      // draft (a schema 400 names nothing).
      if (status === 404 && err.message !== shopeeHttpFallbackMessage(404)) {
        return mensagem(FRASE_CONTA_NAO_ENCONTRADA_SHOPEE);
      }
      if (status === 400 && operacao === 'criar' && detalhes.linkDocId !== null) {
        return mensagem(FRASE_RASCUNHO_SEM_TITULO_SHOPEE);
      }
      break;
  }
  // A 5xx may follow a write the route already made — Next's codeless 500
  // when a commit that may have landed rethrows, App Hosting's 502/503/504 —
  // coded or not; 501 is a fact about the deployment.
  if (status >= 500 && status !== 501) {
    return mensagem(fraseDaRespostaIncertaDoRascunhoShopee(operacao), true);
  }
  return mensagem(
    descreverFalhaShopee(err, { desconhecido: 'Falha ao falar com a Shopee.' }).mensagem,
  );
}

/* -------------------------------------------------------------------------- */
/*                         What a draft block may do                           */
/* -------------------------------------------------------------------------- */

/**
 * MILLISECONDS added to a reading's `aguardarMs` before the tab reads the
 * clock again — past the instant the reading changes, never at it.
 */
export const MARGEM_DA_RELEITURA_DO_ESTADO_SHOPEE_MS = 1_000;

/** The facts a draft block is decided from. */
export interface EntradaDoBlocoRascunhoShopee {
  /** The stored document (`linksSnap.data[i].data`, unvalidated), or `null` for a local new draft. */
  readonly link: Record<string, unknown> | null;
  /** The block's entry, AFTER {@link conciliarEdicaoRascunhoShopee} (`null` = none). */
  readonly edicao: EdicaoRascunhoShopee | null;
  /** MILLISECONDS — `Date.now()` as of this render (never a value frozen at mount). */
  readonly nowMs: number;
  /** `ehKitVirtualEfetivo(<the stored produto>)`. */
  readonly kitVirtual: boolean;
  /** `linksSnap.fromCache === false`: the snapshot came from the server. */
  readonly servidorConfirmado: boolean;
  /** `PERM.integracao.write` ∧ `PERM.produto.write` ∧ the produto form editable. */
  readonly podeEditar: boolean;
  /**
   * The operator may DISCARD this draft — decoupled from {@link podeEditar}:
   * the discard route reads only the link (no conta document, no Shopee call),
   * so a draft whose conta was deleted can still be discarded while nothing
   * else may be done to it. Absent ⇒ {@link podeEditar}.
   */
  readonly permiteDescarte?: boolean;
  /** A write of this tab is in flight. */
  readonly ocupado: boolean;
}

/** How "Descartar" proceeds. */
export type DescarteDoRascunhoShopee =
  /** A local new draft: dropped here, nothing sent. */
  | 'local'
  /** A saved draft reading `livre`: one confirmation, then the route. */
  | 'confirmar'
  /** A saved draft reading `incerta`: the three-case Seller-Centre dialog. */
  | 'atestar';

/** What a draft block shows and offers now. */
export interface BlocoRascunhoShopee {
  /** THE publish reading at `nowMs` (`estadoPublicacaoRascunhoShopee`). */
  readonly publicacao: EstadoPublicacaoRascunhoShopee;
  /**
   * MILLISECONDS until the tab must read the clock again and re-decide
   * (`aguardarMs` + {@link MARGEM_DA_RELEITURA_DO_ESTADO_SHOPEE_MS} while
   * `em-andamento`), or `null` when time alone changes nothing.
   */
  readonly releituraEmMs: number | null;
  /** What the five fields show. */
  readonly valores: FormularioRascunhoShopee;
  /**
   * The block's draft in the projection's form — {@link valores} over the held
   * projection, so the EDITED attributes — the `campos` that
   * `pendenciasDoRascunhoShopee` (`@delfrance/schemas`) reads for the block's
   * pendências (with the EDITED category's tree, they follow the attributes as
   * the operator fills them; the «Publicar» gate itself still needs the draft
   * saved and clean, so there edited = stored).
   */
  readonly campos: CamposRascunhoShopee;
  readonly novo: boolean;
  readonly kitVirtual: boolean;
  /** The fields accept typing. */
  readonly camposEditaveis: boolean;
  /** The category picker accepts a pick (never in `incerta`). */
  readonly categoriaEditavel: boolean;
  /** The HELD projection's category — what "put the category back" restores. */
  readonly categoriaGravada: number | null;
  /**
   * `incerta` with an UNSAVED category change (picked while the draft read
   * `livre`): the change blocks every save (`categoria-travada`), the picker
   * is closed, and putting the HELD category back — a revert, never a change —
   * is the one pick still accepted ({@link categoriaAceitaNoBlocoShopee}), so
   * the other edits can be saved without «Desfazer alterações» losing them.
   */
  readonly podeVoltarCategoria: boolean;
  /** Unsaved work in this block. */
  readonly sujo: boolean;
  readonly podeSalvar: boolean;
  /** Why "Salvar rascunho" cannot send now (`null` ⇔ {@link podeSalvar}). */
  readonly impedimento: ImpedimentoDoRascunhoShopee | null;
  /** "Desfazer alterações": drop a dirty stored entry. */
  readonly podeDesfazer: boolean;
  readonly podeDescartar: boolean;
  readonly descarte: DescarteDoRascunhoShopee;
  /**
   * Attributes would be lost by a category change — warn first: the held
   * projection stores at least one (the save clears them), OR the form holds
   * at least one (a pick empties the form's list — a new draft's unsaved
   * attributes included), OR a typing still on screen blocks the save (a pick
   * drops every typing; `digitacoesBloqueiam` — a unit remembered alone is no
   * work).
   */
  readonly atributosPreenchidos: boolean;
  /**
   * «Voltar à categoria gravada» ({@link podeVoltarCategoria}) would drop
   * attribute work done for the CHANGED category — confirm first. The
   * put-back restores the held list and drops every typing, so it costs work
   * when a typing is on screen, or the form's list is non-empty and differs
   * from the held one (after a pick the list starts at `null`, so anything in
   * it was filled for the new category). Never `atributosPreenchidos`: a held
   * list alone comes BACK with the revert.
   */
  readonly voltarCategoriaApagaAtributos: boolean;
  /**
   * The HELD projection stores attributes while the form shows ANOTHER
   * category: the stored attributes belong to the saved category, and putting
   * that category back brings them back (the picker says so). Never on a local
   * new draft — it stores nothing.
   */
  readonly atributosGravadosForaDaCategoria: boolean;
  /** The block's notices, in order of importance. */
  readonly avisos: readonly string[];
}

/** A block with neither a document nor an entry (never rendered by a correct tab) holds nothing. */
const VAZIO: CamposRascunhoShopee = {
  item_name: null,
  description: null,
  category_id: null,
  marca: null,
  attributes: null,
};

/**
 * THE decision of one draft block (DC §2.3): its publish reading, what it
 * shows, whether it may be typed into, saved, undone or discarded, and its
 * notices. Read only through this: a block that re-derives "in progress" from
 * the lock fields is the drift #1369 names.
 *
 * - **kit virtual** (`ehKitVirtualEfetivo`) — no editor; Descartar only;
 * - **em-andamento** — nothing editable, nothing sent (every draft route
 *   answers 409 now); one clock re-read at `aguardarMs` + 1 s;
 * - **incerta** — editable except the category (an unsaved category change
 *   made while `livre` may only be put back — `podeVoltarCategoria`);
 *   Descartar asks for the Seller-Centre attestation;
 * - **discard** — its own authority (`permiteDescarte`, else `podeEditar`):
 *   the discard route needs only the link, so a draft whose conta document is
 *   gone can still be discarded while nothing else is offered;
 * - **server truth** — a stored draft with no entry is read-only until the
 *   snapshot came from the server (an existing entry keeps editing through an
 *   Activity re-listen, which re-emits `fromCache: true`);
 * - **just saved** — read-only until the listener brings the stored draft back.
 */
export function estadoDoBlocoRascunhoShopee(e: EntradaDoBlocoRascunhoShopee): BlocoRascunhoShopee {
  const { link, edicao } = e;
  const publicacao: EstadoPublicacaoRascunhoShopee =
    link !== null && ehRascunhoShopee(link)
      ? estadoPublicacaoRascunhoShopee(link, e.nowMs)
      : { tipo: 'livre' };
  const emAndamento = publicacao.tipo === 'em-andamento';
  const novo = edicao?.novo === true;
  const salvo = edicao !== null && edicao.salvo !== null;
  const plano = edicao === null ? null : planoDoRascunhoShopee(edicao, publicacao);
  const projecao = link === null ? null : projecaoGuardadaDoRascunhoShopee(edicao, link);
  const guardado = projecao ?? edicao?.base ?? VAZIO;
  const valores = edicao?.atual ?? formularioDoRascunhoShopee(guardado);

  const camposEditaveis =
    e.podeEditar &&
    !e.ocupado &&
    !e.kitVirtual &&
    !emAndamento &&
    !salvo &&
    (edicao !== null || e.servidorConfirmado);
  const impedimento = plano === null ? 'nada-a-salvar' : plano.impedimento;
  const podeSalvar = e.podeEditar && !e.ocupado && !e.kitVirtual && impedimento === null;
  const sujo = plano?.sujo === true;
  const CATEGORIA = CAMPO_RASCUNHO_SHOPEE.categoryId;
  const outraCategoria = !mesmoValorGravadoDoRascunhoShopee(
    CATEGORIA,
    guardado.category_id,
    valores.category_id,
  );
  // Never on a local new draft: it has no stored category to go back to
  // (`guardado` is its prefill), so the button would put back nothing.
  const podeVoltarCategoria =
    camposEditaveis && publicacao.tipo === 'incerta' && edicao !== null && !novo && outraCategoria;

  const avisos: string[] = [];
  if (e.kitVirtual) avisos.push(FRASE_RASCUNHO_EM_KIT_VIRTUAL_SHOPEE);
  if (publicacao.tipo === 'em-andamento') {
    avisos.push(fraseDoRascunhoEmAndamentoShopee(publicacao, e.nowMs));
  } else if (publicacao.tipo === 'incerta') {
    avisos.push(FRASE_RASCUNHO_INCERTO_SHOPEE);
  }
  if (novo) avisos.push(FRASE_RASCUNHO_NOVO_SHOPEE);
  else if (salvo) avisos.push(FRASE_RASCUNHO_AGUARDANDO_SERVIDOR_SHOPEE);
  else if (edicao === null && link !== null && !e.servidorConfirmado) {
    avisos.push(FRASE_RASCUNHO_CARREGANDO_SHOPEE);
  }

  return {
    publicacao,
    releituraEmMs:
      publicacao.tipo === 'em-andamento'
        ? publicacao.aguardarMs + MARGEM_DA_RELEITURA_DO_ESTADO_SHOPEE_MS
        : null,
    valores,
    campos: { ...guardado, ...valores },
    novo,
    kitVirtual: e.kitVirtual,
    camposEditaveis,
    categoriaEditavel: camposEditaveis && publicacao.tipo !== 'incerta',
    categoriaGravada: guardado.category_id,
    podeVoltarCategoria,
    sujo,
    podeSalvar,
    impedimento,
    podeDesfazer: e.podeEditar && !e.ocupado && edicao !== null && !novo && sujo,
    // Its own authority: a deleted conta still lets its draft go (the route
    // needs only the link) — every other action stays under `podeEditar`.
    podeDescartar:
      (e.permiteDescarte ?? e.podeEditar) &&
      !e.ocupado &&
      !emAndamento &&
      !salvo &&
      (novo || (link !== null && (edicao !== null || e.servidorConfirmado))),
    descarte: novo ? 'local' : publicacao.tipo === 'incerta' ? 'atestar' : 'confirmar',
    atributosPreenchidos:
      (projecao?.attributes?.length ?? 0) > 0 ||
      (valores.attributes?.length ?? 0) > 0 ||
      (edicao !== null && digitacoesBloqueiam(edicao.digitacoesAtributos)),
    voltarCategoriaApagaAtributos:
      podeVoltarCategoria &&
      edicao !== null &&
      (Object.keys(edicao.digitacoesAtributos).length > 0 ||
        ((valores.attributes?.length ?? 0) > 0 &&
          !mesmoValorGravadoDoRascunhoShopee(
            CAMPO_RASCUNHO_SHOPEE.attributes,
            guardado.attributes,
            valores.attributes,
          ))),
    atributosGravadosForaDaCategoria:
      edicao !== null && !novo && (projecao?.attributes?.length ?? 0) > 0 && outraCategoria,
    avisos,
  };
}

/**
 * Whether the block accepts `valor` as its category pick: any pick while the
 * picker is open ({@link BlocoRascunhoShopee.categoriaEditavel}); in `incerta`,
 * ONLY the held category put back ({@link BlocoRascunhoShopee.podeVoltarCategoria})
 * — a revert, never a change. The tab asks this before applying a pick.
 */
export function categoriaAceitaNoBlocoShopee(
  bloco: BlocoRascunhoShopee,
  valor: number | null,
): boolean {
  if (bloco.categoriaEditavel) return true;
  return bloco.podeVoltarCategoria && valor === bloco.categoriaGravada;
}

/**
 * Whether a held `category_id` can name a Shopee category at all: a POSITIVE
 * id. A legacy `0` (or a negative) names none — no tree read, no bands read,
 * and the picker opens at the roots. THE one test, for the Categoria label,
 * the tab's bands request and the draft's «Publicar» gate
 * ({@link publicacaoDoRascunhoShopee}) alike.
 */
export function idDeCategoriaShopeeValido(categoryId: number | null): categoryId is number {
  return categoryId !== null && categoryId > 0;
}

/* -------------------------------------------------------------------------- */
/*                     #1911 P11 — Publicar on a draft                         */
/* -------------------------------------------------------------------------- */

/** Why a draft's «Publicar» is disabled now — the FIRST reason, in this order. */
export type ImpedimentoDaPublicacaoShopee =
  /** The operator may not author (`podeEditar` false): no button at all. */
  | 'sem-permissao'
  /** A virtual-kit produto: its first publish is a native kit, never this draft. */
  | 'kit-virtual'
  /** A local draft: nothing is stored to publish. */
  | 'rascunho-novo'
  /** Just saved: the listener has not brought the stored draft back yet. */
  | 'aguardando-servidor'
  /** The draft has unsaved changes (P10's plan): the publish reads the STORED draft. */
  | 'alteracoes-nao-salvas'
  /** The reading is `em-andamento`: the publish answers 409 now. */
  | 'publicacao-em-andamento'
  /** The links snapshot is a cached copy, or the stored produto's texts are not known yet. */
  | 'carregando'
  /** A write of this tab is in flight. */
  | 'ocupado'
  /**
   * ANOTHER draft of the produto on the conta records an attempt that may
   * have created a listing ({@link rascunhosIrmaosIncertosShopee}): the
   * server refuses this publish, confirmation or not, until that draft is
   * resolved on its own block — the `aviso` names it and how.
   */
  | 'irmao-incerto'
  /** The produto form has unsaved changes: the publish reads the STORED produto (K2-7). */
  | 'produto-nao-salvo'
  /** A pendência the publish would refuse ({@link PublicacaoDoRascunhoShopee.pendencias}). */
  | 'pendencias'
  /**
   * The held category names none ({@link idDeCategoriaShopeeValido} — a
   * legacy `0`): no bands are ever read for it and the listing assembly
   * refuses it. The Categoria field already says so (and asks for a category
   * where the picker is offered), so no `aviso` repeats it.
   */
  | 'categoria-inexistente'
  /** The title/description bands are not loaded: a band pendência cannot be seen yet. */
  | 'faixas-desconhecidas'
  /**
   * The attribute tree of the draft's category is not loaded (still loading, or
   * the read failed): a missing MANDATORY attribute cannot be seen yet — the
   * `atributo-obrigatorio` pendência needs the tree — so «Publicar» waits for
   * it, exactly as it waits for the bands. Checked after them.
   */
  | 'atributos-desconhecidos';

/** The facts a draft's Publicar is decided from. */
export interface EntradaDaPublicacaoDoRascunhoShopee {
  /** THE block decision at this render ({@link estadoDoBlocoRascunhoShopee}, `nowMs` fresh). */
  readonly bloco: BlocoRascunhoShopee;
  /** The same three facts the block was decided from. */
  readonly podeEditar: boolean;
  readonly ocupado: boolean;
  readonly servidorConfirmado: boolean;
  /** The produto form holds unsaved changes (the page's dirty state). */
  readonly produtoSujo: boolean;
  /** The STORED produto `nome` and `extraData/singleton.descricao`, or `null` while either is unknown. */
  readonly textosDoProduto: Pick<
    ArgsPendenciasRascunhoShopee,
    'nomeProduto' | 'descricaoProduto'
  > | null;
  /**
   * The title/description bands of the draft's EDITED category
   * (`limitesDoItem({ categoryId }).limites`), or `null` while they load or
   * after the read failed — and `null` for a draft with no category, or with a
   * non-positive legacy id: those ask apps/shopee NOTHING on render (rev. 2a
   * B.7(b); there is no shop-wide band read). A draft with no category always
   * carries the `categoria-ausente` pendência, and a legacy `0` is
   * `categoria-inexistente` — both checked before `faixas-desconhecidas`, so
   * neither ever waits on bands (review R2-drafts#7; the order is pinned by
   * `rascunho.test.ts`).
   */
  readonly limites: ArgsPendenciasRascunhoShopee['limites'];
  /**
   * The attribute tree of the draft's EDITED category (`client.atributos`,
   * `leaf: false` read as a complete EMPTY tree — the assembly refuses a
   * non-leaf category on its own), or `null` while it loads or after the read
   * failed — and `null` for a draft with no category or a non-positive legacy
   * id, which ask apps/shopee nothing (`categoria-ausente` and
   * `categoria-inexistente` speak first, so neither waits on a tree). Fed to
   * `pendenciasDoRascunhoShopee`, so a mandatory attribute left empty is the
   * `atributo-obrigatorio` pendência; `null` is `atributos-desconhecidos`.
   */
  readonly arvore: ArvoreAtributosShopee | null;
  /**
   * The OTHER drafts of the produto on this conta whose last attempt may have
   * created a listing — {@link rascunhosIrmaosIncertosShopee} over the SAME
   * links snapshot the D15 count reads (review round 3). Non-empty ⇒
   * `irmao-incerto`.
   */
  readonly rascunhosIrmaosIncertos: readonly string[];
}

/** Whether a draft's «Publicar» acts now, and why not. */
export interface PublicacaoDoRascunhoShopee {
  readonly podePublicar: boolean;
  /** `null` ⇔ {@link podePublicar}. */
  readonly impedimento: ImpedimentoDaPublicacaoShopee | null;
  /**
   * The pendências the publish would refuse (`pendenciasDoRascunhoShopee`, the
   * listing assembly's own predicates, over the STORED produto texts and the
   * category's tree) — `[]` when those texts are unknown or the produto is a
   * virtual kit. ⚠️ Computed with `limites: null`, the list holds NO band
   * pendência, and with `arvore: null` no `atributo-obrigatorio`: that is why
   * unknown bands and an unknown tree are impediments of their own.
   */
  readonly pendencias: readonly PendenciaRascunhoShopee[];
  /**
   * The sentence under a disabled «Publicar», or `null` when the block already
   * says why (its notices, the pendências list) or nothing blocks.
   */
  readonly aviso: string | null;
}

/**
 * THE decision of a draft's «Publicar» (#1911 P11, rev. 2a §D P11):
 * saved ∧ clean (P10's plan empty, not a local draft) ∧ the produto form clean
 * ∧ server truth ∧ no pendência ∧ a held category that names one
 * ({@link idDeCategoriaShopeeValido}) ∧ the bands LOADED ∧ the category's
 * attribute tree LOADED (P13: the pendências read it, so a mandatory attribute
 * left EMPTY — one the ERP cannot edit included — is `atributo-obrigatorio`
 * while it holds no value; a stored value is carried and published, D-7; an
 * OPTIONAL one blocks nothing) ∧ the publish reading
 * not `em-andamento` ∧ no OTHER draft of the produto on the conta recording an
 * attempt that may have created a listing (`irmao-incerto`, review round 3:
 * the server's sibling scan refuses every publish meanwhile, so the
 * confirmation never opens over a 409). THIS draft's own `incerta` does NOT
 * block: its publish is a real one — ENSURE looks the listing up first, then
 * adopts it, refuses (a 422 row), or
 * creates. A draft whose conta document is gone is not the operator's to
 * author (`podeEditar` false ⇒ `sem-permissao`): it offers «Descartar» alone
 * (P10's `permiteDescarte`), never «Publicar».
 *
 * Every input is the schemas' or P10's own reading — the block decision
 * (`estadoPublicacaoRascunhoShopee` inside it) and `pendenciasDoRascunhoShopee`
 * — so nothing here re-derives the lock or the pendências (#1369).
 */
export function publicacaoDoRascunhoShopee(
  e: EntradaDaPublicacaoDoRascunhoShopee,
): PublicacaoDoRascunhoShopee {
  const { bloco } = e;
  const pendencias =
    e.textosDoProduto === null || bloco.kitVirtual
      ? []
      : pendenciasDoRascunhoShopee(bloco.campos, {
          ...e.textosDoProduto,
          limites: e.limites,
          arvore: e.arvore,
        });
  const impedido = (
    impedimento: ImpedimentoDaPublicacaoShopee,
    aviso: string | null = null,
  ): PublicacaoDoRascunhoShopee => ({ podePublicar: false, impedimento, pendencias, aviso });

  if (!e.podeEditar) return impedido('sem-permissao');
  if (bloco.kitVirtual) return impedido('kit-virtual');
  if (bloco.novo) return impedido('rascunho-novo', FRASE_PUBLICAR_RASCUNHO_NOVO_SHOPEE);
  if (bloco.impedimento === 'aguardando-servidor') return impedido('aguardando-servidor');
  if (bloco.sujo) {
    // A category change stranded by `incerta` blocks every save: «Salve as
    // alterações» would name an exit that is disabled. The block's own
    // `categoria-travada` sentence says why and names the exits that act
    // («Desfazer alterações», «Voltar à categoria gravada» — P10).
    return impedido(
      'alteracoes-nao-salvas',
      bloco.impedimento === 'categoria-travada' ? null : FRASE_PUBLICAR_COM_ALTERACOES_SHOPEE,
    );
  }
  if (bloco.publicacao.tipo === 'em-andamento') return impedido('publicacao-em-andamento');
  if (!e.servidorConfirmado || e.textosDoProduto === null) return impedido('carregando');
  if (e.ocupado) return impedido('ocupado');
  // After `carregando`: a cached snapshot may hold a sibling's stale reading.
  if (e.rascunhosIrmaosIncertos.length > 0) {
    return impedido(
      'irmao-incerto',
      fraseDosRascunhosIrmaosIncertosShopee(e.rascunhosIrmaosIncertos),
    );
  }
  if (e.produtoSujo) return impedido('produto-nao-salvo', FRASE_PUBLICAR_PRODUTO_NAO_SALVO_SHOPEE);
  if (pendencias.length > 0) return impedido('pendencias');
  // A held id that names no category (a legacy `0`) is no pendência and has no
  // bands to wait for — the tab never asks for them — so it is said as itself,
  // never as «limites … forem lidos», a wait that would never end.
  if (!idDeCategoriaShopeeValido(bloco.valores.category_id)) {
    return impedido('categoria-inexistente');
  }
  if (e.limites === null) return impedido('faixas-desconhecidas', FRASE_PUBLICAR_SEM_FAIXAS_SHOPEE);
  // `== null`: a caller that never read the tree (absent) waits like one still reading it.
  if (e.arvore == null) {
    return impedido('atributos-desconhecidos', FRASE_PUBLICAR_SEM_ATRIBUTOS_SHOPEE);
  }
  return { podePublicar: true, impedimento: null, pendencias, aviso: null };
}

/**
 * The publish input of a draft's «Publicar» — by `linkDocId` ALONE (never
 * `categoryId`: the draft carries its own; never a kit flag). «Criar pausado»
 * sends `status: 'UNLIST'`; otherwise no status (the route's default for a
 * create). Each confirmation is sent only once the operator gave it:
 * `confirmarSegundoAnuncio` after the D15 warning
 * ({@link segundoAnuncioNaContaShopee} non-empty, or a 409
 * `rascunhoContaJaTemAnuncio`).
 *
 * `atestacao` (#1911 P11 review, §I1) — the Seller-Centre attestation exit
 * that opened the confirmation ({@link saidasDoProblemaShopee}'s
 * `publicar-atestando`), or `null` for the block's own «Publicar». It sends
 * `confirmarCriacaoIncerta: true` AND, always beside it, the outcome the exit
 * PROMISED — `criacaoIncertaAdota`: the unlinked listing(s) it adopts, `[]`
 * for a deliberate create — so the look-up honours the attestation only when
 * its fresh verdict is that one, and refuses with nothing sent otherwise (a
 * listing linked elsewhere since the refusal never turns «adota … — não cria
 * outro» into an `add_item`). ⚠️ The flag never travels without its
 * expectation from here: a bare flag is the CLI's meaning (no guard). The
 * key is the attestation's own object, never a boolean — a caller cannot
 * send the flag and forget the promise.
 */
export function corpoPublicarRascunhoShopee(args: {
  readonly contaId: string;
  readonly produtoId: string;
  readonly linkDocId: string;
  readonly pausado: boolean;
  readonly confirmarSegundoAnuncio?: boolean;
  readonly atestacao?: { readonly adota: readonly number[] } | null;
}): PublicarShopeeInput {
  const { atestacao } = args;
  return {
    integracaoId: args.contaId,
    produtoId: args.produtoId,
    linkDocId: args.linkDocId,
    ...(args.pausado ? { status: 'UNLIST' as const } : {}),
    ...(args.confirmarSegundoAnuncio === true ? { confirmarSegundoAnuncio: true as const } : {}),
    ...(atestacao === undefined || atestacao === null
      ? {}
      : { confirmarCriacaoIncerta: true as const, criacaoIncertaAdota: [...atestacao.adota] }),
  };
}

/* ---- What a failed draft Publicar means (§C.2) ----------------------------- */

/** A failed draft Publicar, read for the tab — or `null` (the publish's own reading applies). */
export type FalhaDaPublicacaoDoRascunhoShopee =
  /**
   * 409 `rascunhoContaJaTemAnuncio`: the second-listing warning again — the
   * SAME copy as the confirmation, from `vinculos` ({@link existentesDosVinculosShopee})
   * — then the identical publish with `confirmarSegundoAnuncio: true` (K1-4).
   */
  | { readonly tipo: 'segundo-anuncio'; readonly vinculos: readonly VinculoConflitanteShopee[] }
  /**
   * No answer the tab can trust: a network failure, a 2xx it cannot read, a
   * 5xx without a usable code (App Hosting's 504 is one). NEVER "falhou" — the
   * publish may still be running or may have created the listing. The tab
   * shows {@link fraseDaPublicacaoSemRespostaShopee} over the block's CURRENT
   * reading (`bloco.publicacao`), so the wait follows the snapshot.
   */
  | { readonly tipo: 'sem-resposta' }
  /**
   * 409 `publicacaoExpirada` — the run stopped before any send that could
   * create. Holds NO sentence (review R8-copy#0): the tab words it on every
   * render over the block's CURRENT reading
   * ({@link textoDaPublicacaoParadaDoRascunhoShopee}) — the exit for a
   * `livre` draft (check first, then create) and for an `incerta` one (the
   * last attempt's listing first, never another) are opposite advice, and the
   * kept record is what decides, not the reading at click time.
   * `mensagemDoServidor` = the server's sentence (its cause).
   */
  | { readonly tipo: 'expirada'; readonly mensagemDoServidor: string }
  /**
   * A CODED 502 that is not a rate limit — Shopee refused a call the publish
   * needed. Worded at render like {@link expirada}'s, for the same reason.
   */
  | { readonly tipo: 'interrompida'; readonly mensagemDoServidor: string }
  /**
   * 409 `rascunhoJaPublicado` — the link stopped being a draft by another path
   * before this publish could send; nothing it sent created or changed a
   * listing. Holds NO sentence: what the REQUEST was decides it
   * ({@link fraseDoRascunhoJaPublicadoNaPublicacaoShopee}) — an ATTESTED
   * publish (§I4: the server refuses one on its first read) says its
   * confirmation had no effect.
   */
  | { readonly tipo: 'ja-publicado' }
  /** A definite answer about the draft: show `mensagem`. */
  | { readonly tipo: 'mensagem'; readonly mensagem: string };

/**
 * The sentence of a {@link FalhaDaPublicacaoDoRascunhoShopee} `ja-publicado`:
 * `atestada` ⇔ the refused request carried `confirmarCriacaoIncerta` (a
 * refusal row's attestation exit). The block's own Publicar keeps the draft
 * routes' sentence; an attested one says the confirmation had no effect and
 * that nothing was created or changed — the operator asked for a create or an
 * adoption, and «já virou anúncio» alone would read as theirs (review round 4).
 */
export function fraseDoRascunhoJaPublicadoNaPublicacaoShopee(atestada: boolean): string {
  return atestada
    ? FRASE_ATESTACAO_DE_RASCUNHO_JA_PUBLICADO_SHOPEE
    : FRASE_RASCUNHO_JA_PUBLICADO_SHOPEE;
}

/** The two failures of a draft's Publicar the tab words at render. */
export type PublicacaoParadaDoRascunhoShopee = Extract<
  FalhaDaPublicacaoDoRascunhoShopee,
  { readonly tipo: 'expirada' | 'interrompida' }
>;

/**
 * The sentence of a {@link PublicacaoParadaDoRascunhoShopee} over the block's
 * CURRENT publish reading (`bloco.publicacao`, re-read on every render — the
 * way `sem-resposta` is): `./anuncioProduto.ts`'s
 * `fraseDaPublicacaoExpiradaShopee` / `fraseDaPublicacaoInterrompidaShopee`.
 * A block that is no longer a draft has no reading to word it with — the tab
 * says that instead.
 */
export function textoDaPublicacaoParadaDoRascunhoShopee(
  parada: PublicacaoParadaDoRascunhoShopee,
  publicacao: EstadoPublicacaoRascunhoShopee,
): string {
  return parada.tipo === 'expirada'
    ? fraseDaPublicacaoExpiradaShopee(parada.mensagemDoServidor, publicacao)
    : fraseDaPublicacaoInterrompidaShopee(parada.mensagemDoServidor, publicacao);
}

/**
 * THE reading of a failed DRAFT Publicar — by the client's error CLASS, then
 * the backend's `code` (never the status alone: a 404 here is a draft
 * discarded meanwhile, not a link of another conta). `null` for what the
 * publish's own reading already handles: the two 422s (`publicacaoBloqueada` /
 * `publicacaoRecusada` — their rows, worded by `textoDoProblemaShopee` with
 * the block's link and produto, plus {@link superficieDoCampoShopee} and
 * {@link saidasDoProblemaShopee}), the conta's quota pause and every other
 * definite 4xx.
 */
export function falhaDaPublicacaoDoRascunhoShopee(
  err: ShopeeClientHttpError | ShopeeClientNetworkError,
): FalhaDaPublicacaoDoRascunhoShopee | null {
  if (err instanceof ShopeeClientNetworkError) return SEM_RESPOSTA;
  // A SUBCLASS of the HTTP error: read first, or its `code` would be read.
  if (err instanceof ShopeeClientRespostaInvalidaError) return SEM_RESPOSTA;
  const { code, detalhes, status } = err;
  switch (code) {
    case CODIGO_FALHA_SHOPEE.publicacaoEmAndamento:
      return {
        tipo: 'mensagem',
        mensagem: fraseDaPublicacaoDoRascunhoEmAndamentoShopee(detalhes),
      };
    case CODIGO_FALHA_SHOPEE.rascunhoJaPublicado:
      return JA_PUBLICADO;
    case CODIGO_FALHA_SHOPEE.publicacaoExpirada:
      return { tipo: 'expirada', mensagemDoServidor: err.message };
    case CODIGO_FALHA_SHOPEE.rascunhoContencao:
      return { tipo: 'mensagem', mensagem: FRASE_PUBLICACAO_CONTENCAO_SHOPEE };
    case CODIGO_FALHA_SHOPEE.rascunhoCriacaoIncerta:
      return { tipo: 'mensagem', mensagem: FRASE_PUBLICACAO_CRIACAO_INCERTA_SEM_JANELA_SHOPEE };
    case CODIGO_FALHA_SHOPEE.rascunhoContaJaTemAnuncio:
      return { tipo: 'segundo-anuncio', vinculos: detalhes.vinculos ?? [] };
    case CODIGO_FALHA_SHOPEE.anuncioNaoEncontrado:
      return { tipo: 'mensagem', mensagem: FRASE_RASCUNHO_INEXISTENTE_NA_PUBLICACAO_SHOPEE };
    case CODIGO_FALHA_SHOPEE.publicacaoBloqueada:
    case CODIGO_FALHA_SHOPEE.publicacaoRecusada:
      return null;
    case null:
      // Codeless: a proxy's or the platform's answer (App Hosting's 504), read by status below.
      break;
  }
  if (status === 502 && code !== null) {
    // Definite (a backend code), but it says nothing of what exists — the
    // block's reading does, at render.
    return err.kind === 'burst' || err.kind === 'daily'
      ? { tipo: 'mensagem', mensagem: FRASE_LIMITE_NA_PUBLICACAO_DO_RASCUNHO_SHOPEE }
      : { tipo: 'interrompida', mensagemDoServidor: err.message };
  }
  // Any other 5xx may follow a write the route already made; 501 is a fact
  // about the deployment, a definite answer.
  if (status >= 500 && status !== 501) return SEM_RESPOSTA;
  return null;
}

const SEM_RESPOSTA: FalhaDaPublicacaoDoRascunhoShopee = { tipo: 'sem-resposta' };
const JA_PUBLICADO: FalhaDaPublicacaoDoRascunhoShopee = { tipo: 'ja-publicado' };

/* ---- The Seller-Centre attestation exits of a refusal row (§C #7, #8) ------ */

/** One exit a refusal row of a DRAFT's Publicar offers. */
export type SaidaDoProblemaShopee =
  /**
   * Publish THIS draft again with `confirmarCriacaoIncerta: true`
   * ({@link corpoPublicarRascunhoShopee}, handed this exit as `atestacao`) —
   * ⚠️ through the SAME «Publicar» confirmation and gate
   * ({@link publicacaoDoRascunhoShopee}: pendências, «Criar pausado», D15),
   * never a bare re-send. `adota` = the UNLINKED candidates the attested
   * publish adopts instead of creating (`[]` ⇒ it creates) — the PROMISE the
   * label makes, sent beside the flag as `criacaoIncertaAdota` so the server
   * keeps it or refuses with nothing sent (§I1): a 422 from a look-up that now
   * sees otherwise is an ordinary row, opened by
   * `./anuncioProduto.ts`'s `FRASE_ATESTACAO_SUPERADA_SHOPEE`. `varre` = WHICH
   * exit, as the confirmation needs it (review round 2, KNOWN #12): whether
   * that look-up scans the conta again — `true` for `-ja-vinculada`'s exits,
   * `false` for `-sem-sku`'s, which the server honours WITHOUT a scan (no SKU
   * to look for), so its confirmation never promises a change-guard
   * (`AtestacaoDaPublicacaoShopee`).
   */
  | {
      readonly tipo: 'publicar-atestando';
      readonly rotulo: string;
      readonly adota: readonly number[];
      readonly varre: boolean;
    }
  /**
   * Discard THIS draft with `confirmarCriacaoIncerta: true`
   * ({@link corpoDescartarRascunhoShopee} over the held projection). `aviso`:
   * what stays on Shopee, said before the discard.
   */
  | {
      readonly tipo: 'descartar-atestando';
      readonly rotulo: string;
      readonly aviso: string | null;
    };

/**
 * The exits a refusal row offers — keyed on the motivo SLUG, exactly
 * ({@link MOTIVO_ANUNCIO_SHOPEE}; the route honours the attestation for these
 * two only), so a renamed or merely similar slug gets NONE (the safe direction):
 *
 * - `criacao-incerta-sem-sku` ⇒ one: the operator checked that nothing exists
 *   (`varre: false` — the server cannot look a SKU-less listing up);
 * - `criacao-incerta-ja-vinculada` ⇒ two — (1) discard (the listing IS the
 *   attempt's, linked in the ERP), warning about any UNLINKED candidate left
 *   on Shopee; (2) the attested publish, worded as an ADOPTION when an
 *   unlinked candidate is there (the attested re-publish adopts it and sends
 *   nothing), else as a deliberate second listing. Only when the row's
 *   `importar` names which candidates are linked — without that list, none
 *   (fail closed). ⚠️ When NO candidate is linked (the §I1 refusal of an
 *   attestation that expected a create while a free listing turned up), only
 *   (2), the adoption (review round 2, R8-copy#1): «É o anúncio da tentativa»
 *   would attest a LINKED listing the row says is not there, and its dialog
 *   says «vinculado no ERP». The block's own Descartar stays (its three-case
 *   dialog has the unlinked case). Both exits `varre: true`;
 * - everything else — `criacao-incerta-ambigua` in both shapes, the two
 *   `busca-*`, the first create's look-up refusals — ⇒ none.
 *
 * `ehRascunho` false (a live listing's row) ⇒ none: the flag is a draft's.
 */
export function saidasDoProblemaShopee(
  problema: Pick<ProblemaShopee, 'motivo' | 'acao'>,
  contexto: { readonly ehRascunho: boolean },
): readonly SaidaDoProblemaShopee[] {
  if (!contexto.ehRascunho) return [];
  const { motivo, acao } = problema;
  if (motivo === MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaSemSku) {
    return [
      {
        tipo: 'publicar-atestando',
        rotulo: ROTULO_PUBLICAR_ATESTANDO_SEM_SKU_SHOPEE,
        adota: [],
        varre: false,
      },
    ];
  }
  if (motivo !== MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaJaVinculada) return [];
  if (acao?.tipo !== TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.importar || acao.vinculados == null) {
    return [];
  }
  const vinculados = new Set(acao.vinculados.map((v) => v.itemId));
  const livres = acao.itemIds.filter((id) => !vinculados.has(id));
  const publicar: SaidaDoProblemaShopee = {
    tipo: 'publicar-atestando',
    rotulo:
      livres.length === 0
        ? ROTULO_PUBLICAR_SEGUNDO_DE_PROPOSITO_SHOPEE
        : rotuloDaPublicacaoQueAdotaShopee(livres),
    adota: livres,
    varre: true,
  };
  if (livres.length === acao.itemIds.length) return [publicar];
  return [
    {
      tipo: 'descartar-atestando',
      rotulo: ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE,
      aviso: livres.length === 0 ? null : avisoDoDescarteComAnuncioSemVinculoShopee(livres),
    },
    publicar,
  ];
}

/* ---- campo → the surface that fixes it (D17, DC §2.9) ---------------------- */

/** A produto FIELD key a refusal row routes to — the ObjectView resolves its section (no tab name is copied). */
export type CampoDoProdutoShopee =
  | 'pesoBrutoKg'
  | 'alturaCm'
  | 'fotos'
  | 'sku'
  | 'gtin'
  | 'precos'
  | 'estoques'
  | 'impostos'
  | 'crossdocking'
  | 'extraData';

/** Where the operator fixes what a refusal row's `campo` names. */
export type SuperficieDoCampoShopee =
  /** A field of THIS draft's form. `aviso`: a sentence shown with the button (a Shopee brand refusal). */
  | {
      readonly tipo: 'rascunho';
      readonly campo: CampoDoFormularioRascunhoShopee;
      readonly aviso: string | null;
    }
  /** A produto field (`useObjectViewSections().sectionOfField(campo)` → `goToSection`). */
  | { readonly tipo: 'produto'; readonly campo: CampoDoProdutoShopee }
  /** The produto's variations (`/variacoes`). */
  | { readonly tipo: 'variacoes' }
  /** The size chart (`/medidas`). */
  | { readonly tipo: 'medidas' }
  /** A PUBLISHED listing's own content (D8): fixed in Seller Centre — text, no link. */
  | { readonly tipo: 'seller-centre' };

/** Shopee request roots that are a produto field, on a draft and a listing alike. */
const CAMPO_DO_PRODUTO_POR_RAIZ: Readonly<Record<string, CampoDoProdutoShopee>> = {
  logistic_info: 'pesoBrutoKg',
  weight: 'pesoBrutoKg',
  dimension: 'alturaCm',
  image: 'fotos',
  gtin_code: 'gtin',
  original_price: 'precos',
  seller_stock: 'estoques',
  tax_info: 'impostos',
  pre_order: 'crossdocking',
};

/**
 * Roots fixed in the produto's VARIATIONS. ⚠️ Not `tier_variation_list` — the
 * native kit's tier (its `opcoes-demais` names a kit option): no surface here
 * owns it, so it keeps the sentence and gets no button (§H).
 */
const RAIZES_DE_VARIACAO: ReadonlySet<string> = new Set([
  'standardise_tier_variation',
  'tier_variation',
  'model_list',
  'model',
  'grupoDeVariacoesUid',
]);

/** The two SKU roots: routed ONLY for the allow-listed motivos ({@link superficieDoCampoShopee}). */
const RAIZES_DE_SKU: ReadonlySet<string> = new Set(['item_sku', 'sku']);

/**
 * THE campo → surface map of a refusal row (D17, DC §2.9, rev. 2a #4). The key
 * is the request path's ROOT — `campo` cut at its first `[` or `.`
 * (`attribute_list[COLOR]` ⇒ `attribute_list`) — matched EXACTLY: never a
 * prefix (`item_names` and `tier_variation_list` route nowhere). `null` ⇒ the
 * row keeps its sentence and gets no button — the safe fallback, also for
 * `linkDocId`, the kit and link keys (`recriar`, `principal`, `kitNativo`,
 * `paiId`, `item_id`, `shop`, …) and anything unknown; the row's `acao`
 * buttons are another matter and stay.
 *
 * - `item_name` / `category_id` — the draft's field; a listing's ⇒ Seller Centre.
 * - `description` — the draft's own text when it has one (`descricaoPropria`),
 *   else the produto's (`extraData`); a listing with its own text ⇒ Seller Centre.
 * - `brand` — the draft's Marca, with {@link FRASE_MARCA_PODE_NAO_VALER_SHOPEE}
 *   EXCEPT for `marca-nao-escolhida` (nothing was rejected: nothing was
 *   chosen); a listing's ⇒ Seller Centre.
 * - `attribute_list` (and `attribute_list[COLOR]`, the token naming one
 *   attribute) — the draft's «Atributos» section (P13: the publisher's own
 *   `atributo-obrigatorio` and Shopee's attribute refusals alike); a
 *   listing's ⇒ Seller Centre. Only that root: `attribute_lists` or
 *   `attribute` route nowhere.
 * - `item_sku` / `sku` — an ALLOW-LIST (§C rule 4): the produto's SKU ONLY for
 *   `anuncio-existente-de-outro-produto` and an acao-less
 *   `criacao-incerta-ambigua` (the SKU moved). Every other motivo carrying it
 *   (the uncertain create's, the look-ups', Shopee's duplicate refusal) — or
 *   a renamed one — gets none: there the SKU is not the fix.
 * - weight, dimensions, photos, GTIN, price, stock, taxes, pre-order — the
 *   produto's field; `size_chart_info` — the size chart; the variation roots —
 *   the variations.
 * - `logistic_info` — the produto's weight (a channel the parcel does not fit,
 *   `logistica-sem-canal`, and Shopee's own logistics refusal), EXCEPT for
 *   the two import-remedy motivos: `logistica-nao-confirmada` (#2015, a
 *   stored size or fee the ERP has no record of having written) and
 *   `logistica-sem-valor-gravado` (#2099, no size or fee stored readably on a
 *   list the ERP has no record of having written). Both are fixed by importing
 *   the listing, and the channel they name already fits — no field of the
 *   produto is the fix, so the row keeps its copy and gets no button. Matched
 *   EXACTLY, and scoped to that ROOT: the same motivo on another root routes
 *   as usual.
 */
export function superficieDoCampoShopee(
  problema: Pick<ProblemaShopee, 'campo' | 'motivo' | 'acao'>,
  contexto: { readonly ehRascunho: boolean; readonly descricaoPropria: boolean },
): SuperficieDoCampoShopee | null {
  const { campo } = problema;
  if (campo === null) return null;
  const raiz = campo.split(/[[.]/, 1)[0] ?? '';
  const { ehRascunho } = contexto;
  const SELLER_CENTRE: SuperficieDoCampoShopee = { tipo: 'seller-centre' };
  const doRascunho = (
    c: CampoDoFormularioRascunhoShopee,
    aviso: string | null = null,
  ): SuperficieDoCampoShopee => ({ tipo: 'rascunho', campo: c, aviso });

  switch (raiz) {
    case 'item_name':
      return ehRascunho ? doRascunho(CAMPO_RASCUNHO_SHOPEE.itemName) : SELLER_CENTRE;
    case 'category_id':
      return ehRascunho ? doRascunho(CAMPO_RASCUNHO_SHOPEE.categoryId) : SELLER_CENTRE;
    case 'description':
      if (!contexto.descricaoPropria) return { tipo: 'produto', campo: 'extraData' };
      return ehRascunho ? doRascunho(CAMPO_RASCUNHO_SHOPEE.description) : SELLER_CENTRE;
    case 'brand':
      if (!ehRascunho) return SELLER_CENTRE;
      return doRascunho(
        CAMPO_RASCUNHO_SHOPEE.marca,
        problema.motivo === MOTIVO_ANUNCIO_SHOPEE.marcaNaoEscolhida
          ? null
          : FRASE_MARCA_PODE_NAO_VALER_SHOPEE,
      );
    case 'attribute_list':
      return ehRascunho ? doRascunho(CAMPO_RASCUNHO_SHOPEE.attributes) : SELLER_CENTRE;
    case 'size_chart_info':
      return { tipo: 'medidas' };
    case 'logistic_info':
      // #2015 / #2099: the stored size/fee was not confirmed as this app's, or
      // none is stored readably — the fix is importing the listing (or setting
      // the value in Seller Centre first), never the produto's weight.
      if (
        problema.motivo === MOTIVO_ANUNCIO_SHOPEE.logisticaNaoConfirmada ||
        problema.motivo === MOTIVO_ANUNCIO_SHOPEE.logisticaSemValorGravado
      ) {
        return null;
      }
      break;
  }
  if (RAIZES_DE_SKU.has(raiz)) {
    const permitido =
      problema.motivo === MOTIVO_ANUNCIO_SHOPEE.anuncioExistenteDeOutroProduto ||
      (problema.motivo === MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaAmbigua && problema.acao === null);
    return permitido ? { tipo: 'produto', campo: 'sku' } : null;
  }
  if (RAIZES_DE_VARIACAO.has(raiz)) return { tipo: 'variacoes' };
  const doProduto = Object.hasOwn(CAMPO_DO_PRODUTO_POR_RAIZ, raiz)
    ? CAMPO_DO_PRODUTO_POR_RAIZ[raiz]
    : undefined;
  return doProduto === undefined ? null : { tipo: 'produto', campo: doProduto };
}

/**
 * The button (or, for Seller Centre, the line) of a surface. `secaoDoProduto`
 * is the ObjectView's section of a produto field (`sectionOfField`), `null`
 * when it is not known.
 */
export function rotuloDaSuperficieShopee(
  s: SuperficieDoCampoShopee,
  secaoDoProduto: string | null,
): string {
  switch (s.tipo) {
    case 'rascunho':
      return `Corrigir no rascunho: ${ROTULO_CAMPO_RASCUNHO_SHOPEE[s.campo]}`;
    case 'produto':
      return secaoDoProduto === null ? 'Abrir no produto' : `Abrir no produto: ${secaoDoProduto}`;
    case 'variacoes':
      return ROTULO_ABRIR_VARIACOES_SHOPEE;
    case 'medidas':
      return ROTULO_ABRIR_TABELA_DE_MEDIDAS_SHOPEE;
    case 'seller-centre':
      return FRASE_CORRIGIR_NO_SELLER_CENTRE_SHOPEE;
  }
}
