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
 * Only the four fields the P10 form renders ({@link CAMPOS_DO_FORMULARIO_RASCUNHO_SHOPEE}).
 * `attributes` is never in a patch before the attribute editor (P13): the
 * projection DECODES any stored list while the write schema demands positive
 * ids and re-normalises, so piping a legacy list through it would fail every
 * save of that draft — or send an `attributes` patch nobody made, which also
 * suppresses the clear a category change performs. Each changed field is
 * normalised ALONE, so a stored value the write schema refuses (a legacy
 * `category_id: 0`) blocks nothing while nobody touches it.
 *
 * ## Rule 7 — the browser writes nothing
 *
 * Every draft write goes through apps/shopee's draft route (the P8 client
 * methods): a create at a client id (tier 0), an edit and a discard compared
 * against the `base` the operator saw (tier 3 — a loser is a 409 the operator
 * sees, never a silent overwrite). After a 2xx the HELD projection is never
 * rebuilt from what was sent (`gravados` may name fields the patch did not —
 * a category change clears `attributes`): the block shows what was saved,
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
  ShopeeClientNetworkError,
  ShopeeClientRespostaInvalidaError,
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
 * The draft fields the P10 form renders and may put in a patch, canonical
 * order. `attributes` joins with the attribute editor (P13), `logistic_info`
 * with the logistics editor (P16) — until then neither is ever sent by an edit.
 */
export const CAMPOS_DO_FORMULARIO_RASCUNHO_SHOPEE = [
  CAMPO_RASCUNHO_SHOPEE.itemName,
  CAMPO_RASCUNHO_SHOPEE.description,
  CAMPO_RASCUNHO_SHOPEE.categoryId,
  CAMPO_RASCUNHO_SHOPEE.marca,
] as const satisfies readonly CampoRascunhoShopee[];
export type CampoDoFormularioRascunhoShopee = (typeof CAMPOS_DO_FORMULARIO_RASCUNHO_SHOPEE)[number];

/**
 * What the form holds, in the projection's types: `item_name` and
 * `description` as typed (a cleared input is `''` — never trimmed here),
 * `category_id` as picked, `marca` as the PAIR (`null` = not chosen; "Sem
 * marca" is {@link MARCA_SEM_MARCA_RASCUNHO_SHOPEE}).
 */
export type FormularioRascunhoShopee = {
  readonly [C in CampoDoFormularioRascunhoShopee]: CamposRascunhoShopee[C];
};

/** A patch: the CHANGED form fields, each normalised as the draft route stores it. */
export type PatchDoRascunhoShopee = Partial<FormularioRascunhoShopee>;

/** The form fields of a projection. */
export function formularioDoRascunhoShopee(campos: CamposRascunhoShopee): FormularioRascunhoShopee {
  return {
    item_name: campos.item_name,
    description: campos.description,
    category_id: campos.category_id,
    marca: campos.marca,
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
   * Set by {@link marcarRascunhoShopeeSalvo} after a 2xx: the links snapshot
   * (`data`, by identity) current when the request LEFT — never the one
   * current at the answer, which may already be the route's echo (then it
   * would never move again and the block would stay read-only). While the snapshot
   * is still that object the entry shows what was saved, read-only; the first
   * newer snapshot drops it ({@link conciliarEdicaoRascunhoShopee}).
   */
  readonly salvo: { readonly snapshot: unknown } | null;
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
    salvo: null,
  };
}

/**
 * One form field set. Pure; the block decides whether the field may be typed
 * into. ⚠️ Typing into a just-saved entry ends its read-only bridge: its `base`
 * is then the PRE-save projection, so the next save's baseline answers a
 * 409 the operator sees — the safe direction, never a silent overwrite.
 */
export function comCampoRascunhoShopee<C extends CampoDoFormularioRascunhoShopee>(
  edicao: EdicaoRascunhoShopee,
  campo: C,
  valor: FormularioRascunhoShopee[C],
): EdicaoRascunhoShopee {
  return { ...edicao, atual: { ...edicao.atual, [campo]: valor }, salvo: null };
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
 */
export function marcaDaLinhaParaRascunhoShopee(
  linha: MarcaDaContaShopee,
  guardada: MarcaRascunhoShopee | null,
): MarcaRascunhoShopee {
  const par = marcaParaRascunhoShopee(linha);
  if (par.original_brand_name !== null || guardada === null || guardada.brand_id !== par.brand_id) {
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
   * a blank name ⇒ no name). For a `novo` entry: all four (the create's
   * `conteudo`); for a stored one: the {@link alterados}.
   */
  readonly patch: PatchDoRascunhoShopee;
  /** The fields in {@link patch}, canonical order. */
  readonly alterados: readonly CampoDoFormularioRascunhoShopee[];
  /** Fields the operator changed (all four on a `novo` entry) that no write accepts. */
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
    const valor = edicao.atual[campo];
    if (!edicao.novo && mesmoValorGravadoDoRascunhoShopee(campo, edicao.base[campo], valor)) {
      return;
    }
    const normalizado = normalizar(campo, valor);
    if (!normalizado.ok) {
      invalidos.push(campo);
      return;
    }
    if (
      !edicao.novo &&
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
 * impediment (a blank title, …). `conteudo` names EVERY field — the four
 * normalised form values and `attributes: null` (a new draft has none) — so a
 * create retry at the same id compares like for like.
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
      attributes: null,
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
 * `category_id` (that write clears them, so it must prove the operator saw
 * them). VERBATIM: a legacy `''` title is sent back as `''`.
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
 * was SAVED (each field normalised as the route stored it) and tied to the
 * links snapshot current when the request LEFT (`snapshot` — `linksSnap.data`,
 * by identity; the echo may land before the 2xx). Its
 * `base` is deliberately NOT rebuilt from the patch (rev. 2a #7): the first
 * newer snapshot drops the entry and the block repaints from the stored draft.
 */
export function marcarRascunhoShopeeSalvo(
  edicao: EdicaoRascunhoShopee,
  snapshot: unknown,
): EdicaoRascunhoShopee {
  let atual: FormularioRascunhoShopee = edicao.atual;
  for (const campo of CAMPOS_DO_FORMULARIO_RASCUNHO_SHOPEE) {
    const normalizado = normalizar(campo, edicao.atual[campo]);
    if (normalizado.ok) atual = { ...atual, [campo]: normalizado.valor };
  }
  return { ...edicao, novo: false, atual, salvo: { snapshot } };
}

/**
 * The entry rebased on the STORED draft — after a 409 `rascunhoConflito`:
 *
 * - «Salvar mesmo assim» (`usarDoServidor` empty): the form stays as typed and
 *   `base` becomes the projection of `link` (the snapshot's document). On a
 *   create retry this turns the entry into an UPDATE built exactly like any
 *   other (rev. 2a #19): the patch is the form fields the stored draft does not
 *   already hold, the base its projection cut to `camposDaBaseDoRascunhoShopee`.
 *   ⚠️ Never built from the 409's `conflitos[].atual`, which is display-only:
 *   a list differing only in `category_id` would make a base without the
 *   `attributes` that change clears — a 400.
 * - «Usar o que está salvo» (`usarDoServidor` = the conflicting fields): those
 *   form fields take the stored values too.
 *
 * `link` must be the CURRENT snapshot's document: a snapshot older than the
 * 409 only answers 409 again — the safe direction.
 */
export function rebasearEdicaoRascunhoShopee(
  edicao: EdicaoRascunhoShopee,
  link: Record<string, unknown>,
  usarDoServidor: readonly CampoRascunhoShopee[] = [],
): EdicaoRascunhoShopee {
  const base = camposDoRascunhoShopee(link);
  const doServidor = formularioDoRascunhoShopee(base);
  let atual = edicao.atual;
  for (const campo of CAMPOS_DO_FORMULARIO_RASCUNHO_SHOPEE) {
    if (usarDoServidor.includes(campo)) atual = { ...atual, [campo]: doServidor[campo] };
  }
  return { ...edicao, novo: false, base, atual, salvo: null };
}

/** What the tab does with an entry once the links snapshot moved. */
export type ConciliacaoDaEdicaoShopee =
  | { readonly acao: 'manter' }
  /** Drop the entry; when it held unsaved work, show `aviso` — never a silent drop. */
  | { readonly acao: 'largar'; readonly aviso: string | null };

const MANTER: ConciliacaoDaEdicaoShopee = { acao: 'manter' };

/**
 * Reconcile one entry with the CURRENT links snapshot (DC §2.2). Pure — call
 * it on every snapshot; a `largar` is applied by the tab.
 *
 * - **Just saved** — kept while `snapshot` is still the object it was saved
 *   against, dropped (silently) by the first newer one.
 * - **A stored draft that is no longer a draft** (it gained a listing) —
 *   dropped, with a notice when it held unsaved work.
 * - **A stored draft gone from a SERVER-truth snapshot** — dropped, with a
 *   notice when it held unsaved work (a cache-served snapshot proves nothing
 *   is gone).
 * - **A clean stored entry** — dropped: the block renders the snapshot, which
 *   is always current.
 * - **A `novo` entry** — kept while its document is absent (nothing was
 *   created) or still a draft (a create that landed while its answer was lost:
 *   the next Salvar is that create's retry).
 * - **A dirty entry** is never replaced by a snapshot: the operator's text
 *   survives a concurrent write, and the route's baseline is the guard.
 */
export function conciliarEdicaoRascunhoShopee(
  edicao: EdicaoRascunhoShopee,
  agora: {
    readonly link: Record<string, unknown> | undefined;
    readonly snapshot: unknown;
    readonly servidorConfirmado: boolean;
  },
): ConciliacaoDaEdicaoShopee {
  if (edicao.salvo !== null) {
    return agora.snapshot === edicao.salvo.snapshot ? MANTER : { acao: 'largar', aviso: null };
  }
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
  return sujo ? MANTER : { acao: 'largar', aviso: null };
}

/**
 * THE stale check: the fields this entry's next save would compare (its
 * `base`, `camposDaBaseDoRascunhoShopee` of its patch) whose STORED value is
 * no longer what the entry holds, under the CONFLICT question — e.g. another
 * tab saved the title meanwhile. Non-empty ⇒ that save will answer 409
 * `rascunhoConflito`; the block can say so before the click. `[]` for a
 * `novo` or just-saved entry, or one with nothing to save.
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

/* -------------------------------------------------------------------------- */
/*                         The second listing (D15)                            */
/* -------------------------------------------------------------------------- */

/** How many of the produto's listings / drafts a conta already holds — the confirmation's numbers. */
export interface ExistentesNaContaShopee {
  readonly quantidade: number;
  readonly comRascunho: boolean;
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
  return {
    quantidade: vinculos.length + locais,
    comRascunho: locais > 0 || vinculos.some((v) => v.rascunho),
  };
}

/** The confirmation's numbers from a 409 `rascunhoContaJaTemAnuncio`'s `detalhes.vinculos`. */
export function existentesDosVinculosShopee(
  vinculos: readonly VinculoConflitanteShopee[],
): ExistentesNaContaShopee {
  return { quantidade: vinculos.length, comRascunho: vinculos.some((v) => v.rascunho) };
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
      // The two CODELESS answers: the conta's 404 (no `linkDocId`), and the
      // create's no-title 400 — the one codeless 400 that names the draft (a
      // schema 400 names nothing).
      if (status === 404) return mensagem(FRASE_CONTA_NAO_ENCONTRADA_SHOPEE);
      if (status === 400 && operacao === 'criar' && detalhes.linkDocId !== null) {
        return mensagem(FRASE_RASCUNHO_SEM_TITULO_SHOPEE);
      }
      break;
  }
  // A 5xx may follow a write the route already made (App Hosting's 504 at the
  // ceiling is one); 501 is a fact about the deployment.
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
  /** What the four fields show. */
  readonly valores: FormularioRascunhoShopee;
  /**
   * The block's draft in the projection's form — {@link valores} over the held
   * projection (its `attributes`) — the `campos` that
   * `pendenciasDoRascunhoShopee` (`@delfrance/schemas`) reads for the block's
   * pendências.
   */
  readonly campos: CamposRascunhoShopee;
  readonly novo: boolean;
  readonly kitVirtual: boolean;
  /** The fields accept typing. */
  readonly camposEditaveis: boolean;
  /** The category picker accepts a pick (never in `incerta`). */
  readonly categoriaEditavel: boolean;
  /** Unsaved work in this block. */
  readonly sujo: boolean;
  readonly podeSalvar: boolean;
  /** Why "Salvar rascunho" cannot send now (`null` ⇔ {@link podeSalvar}). */
  readonly impedimento: ImpedimentoDoRascunhoShopee | null;
  /** "Desfazer alterações": drop a dirty stored entry. */
  readonly podeDesfazer: boolean;
  readonly podeDescartar: boolean;
  readonly descarte: DescarteDoRascunhoShopee;
  /** The held projection stores attributes: a category change clears them — warn first. */
  readonly atributosGravados: boolean;
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
 * - **incerta** — editable except the category; Descartar asks for the
 *   Seller-Centre attestation;
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
    sujo,
    podeSalvar,
    impedimento,
    podeDesfazer: e.podeEditar && !e.ocupado && edicao !== null && !novo && sujo,
    podeDescartar:
      e.podeEditar &&
      !e.ocupado &&
      !emAndamento &&
      !salvo &&
      (novo || (link !== null && (edicao !== null || e.servidorConfirmado))),
    descarte: novo ? 'local' : publicacao.tipo === 'incerta' ? 'atestar' : 'confirmar',
    atributosGravados: projecao?.attributes != null && projecao.attributes.length > 0,
    avisos,
  };
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
  /** The produto form has unsaved changes: the publish reads the STORED produto (K2-7). */
  | 'produto-nao-salvo'
  /** A pendência the publish would refuse ({@link PublicacaoDoRascunhoShopee.pendencias}). */
  | 'pendencias'
  /** The title/description bands are not loaded: a band pendência cannot be seen yet. */
  | 'faixas-desconhecidas';

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
   * The title/description bands — `limitesDoItem(...).limites` for the draft's
   * category, or the SHOP-WIDE answer (`limitesDoItem` without `categoryId`)
   * when the draft has none — or `null` while not loaded (or failed).
   */
  readonly limites: ArgsPendenciasRascunhoShopee['limites'];
}

/** Whether a draft's «Publicar» acts now, and why not. */
export interface PublicacaoDoRascunhoShopee {
  readonly podePublicar: boolean;
  /** `null` ⇔ {@link podePublicar}. */
  readonly impedimento: ImpedimentoDaPublicacaoShopee | null;
  /**
   * The pendências the publish would refuse (`pendenciasDoRascunhoShopee`, the
   * listing assembly's own predicates, over the STORED produto texts) — `[]`
   * when those texts are unknown or the produto is a virtual kit. ⚠️ Computed
   * with `limites: null`, the list holds NO band pendência: that is why
   * unknown bands are an impediment of their own.
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
 * ∧ server truth ∧ no pendência ∧ the bands LOADED ∧ the publish reading not
 * `em-andamento`. `incerta` does NOT block: its publish is a real one — ENSURE
 * looks the listing up first, then adopts it, refuses (a 422 row), or creates.
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
      : pendenciasDoRascunhoShopee(bloco.campos, { ...e.textosDoProduto, limites: e.limites });
  const impedido = (
    impedimento: ImpedimentoDaPublicacaoShopee,
    aviso: string | null = null,
  ): PublicacaoDoRascunhoShopee => ({ podePublicar: false, impedimento, pendencias, aviso });

  if (!e.podeEditar) return impedido('sem-permissao');
  if (bloco.kitVirtual) return impedido('kit-virtual');
  if (bloco.novo) return impedido('rascunho-novo', FRASE_PUBLICAR_RASCUNHO_NOVO_SHOPEE);
  if (bloco.impedimento === 'aguardando-servidor') return impedido('aguardando-servidor');
  if (bloco.sujo) return impedido('alteracoes-nao-salvas', FRASE_PUBLICAR_COM_ALTERACOES_SHOPEE);
  if (bloco.publicacao.tipo === 'em-andamento') return impedido('publicacao-em-andamento');
  if (!e.servidorConfirmado || e.textosDoProduto === null) return impedido('carregando');
  if (e.ocupado) return impedido('ocupado');
  if (e.produtoSujo) return impedido('produto-nao-salvo', FRASE_PUBLICAR_PRODUTO_NAO_SALVO_SHOPEE);
  if (pendencias.length > 0) return impedido('pendencias');
  if (e.limites === null) return impedido('faixas-desconhecidas', FRASE_PUBLICAR_SEM_FAIXAS_SHOPEE);
  return { podePublicar: true, impedimento: null, pendencias, aviso: null };
}

/**
 * The publish input of a draft's «Publicar» — by `linkDocId` ALONE (never
 * `categoryId`: the draft carries its own; never a kit flag). «Criar pausado»
 * sends `status: 'UNLIST'`; otherwise no status (the route's default for a
 * create). Each confirmation is sent only once the operator gave it:
 * `confirmarSegundoAnuncio` after the D15 warning
 * ({@link segundoAnuncioNaContaShopee} non-empty, or a 409
 * `rascunhoContaJaTemAnuncio`), `confirmarCriacaoIncerta` after a
 * Seller-Centre attestation exit ({@link saidasDoProblemaShopee}).
 */
export function corpoPublicarRascunhoShopee(args: {
  readonly contaId: string;
  readonly produtoId: string;
  readonly linkDocId: string;
  readonly pausado: boolean;
  readonly confirmarSegundoAnuncio?: boolean;
  readonly confirmarCriacaoIncerta?: boolean;
}): PublicarShopeeInput {
  return {
    integracaoId: args.contaId,
    produtoId: args.produtoId,
    linkDocId: args.linkDocId,
    ...(args.pausado ? { status: 'UNLIST' as const } : {}),
    ...(args.confirmarSegundoAnuncio === true ? { confirmarSegundoAnuncio: true as const } : {}),
    ...(args.confirmarCriacaoIncerta === true ? { confirmarCriacaoIncerta: true as const } : {}),
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
  /** A definite answer about the draft: show `mensagem`. */
  | { readonly tipo: 'mensagem'; readonly mensagem: string };

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
      return { tipo: 'mensagem', mensagem: FRASE_RASCUNHO_JA_PUBLICADO_SHOPEE };
    case CODIGO_FALHA_SHOPEE.publicacaoExpirada:
      return { tipo: 'mensagem', mensagem: fraseDaPublicacaoExpiradaShopee(err.message) };
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
    // block's reading does.
    return {
      tipo: 'mensagem',
      mensagem:
        err.kind === 'burst' || err.kind === 'daily'
          ? FRASE_LIMITE_NA_PUBLICACAO_DO_RASCUNHO_SHOPEE
          : fraseDaPublicacaoInterrompidaShopee(err.message),
    };
  }
  // Any other 5xx may follow a write the route already made; 501 is a fact
  // about the deployment, a definite answer.
  if (status >= 500 && status !== 501) return SEM_RESPOSTA;
  return null;
}

const SEM_RESPOSTA: FalhaDaPublicacaoDoRascunhoShopee = { tipo: 'sem-resposta' };

/* ---- The Seller-Centre attestation exits of a refusal row (§C #7, #8) ------ */

/** One exit a refusal row of a DRAFT's Publicar offers. */
export type SaidaDoProblemaShopee =
  /**
   * Publish THIS draft again with `confirmarCriacaoIncerta: true`
   * ({@link corpoPublicarRascunhoShopee}) — ⚠️ through the SAME «Publicar»
   * confirmation and gate ({@link publicacaoDoRascunhoShopee}: pendências,
   * «Criar pausado», D15), never a bare re-send. `adota` = the UNLINKED
   * candidates the attested publish adopts instead of creating (`[]` ⇒ it
   * creates).
   */
  | {
      readonly tipo: 'publicar-atestando';
      readonly rotulo: string;
      readonly adota: readonly number[];
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
 * - `criacao-incerta-sem-sku` ⇒ one: the operator checked that nothing exists;
 * - `criacao-incerta-ja-vinculada` ⇒ two — (1) discard (the listing IS the
 *   attempt's), warning about any UNLINKED candidate left on Shopee; (2) the
 *   attested publish, worded as an ADOPTION when an unlinked candidate is
 *   there (the attested re-publish adopts it and sends nothing), else as a
 *   deliberate second listing. Only when the row's `importar` names which
 *   candidates are linked — without that list, none (fail closed);
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
      { tipo: 'publicar-atestando', rotulo: ROTULO_PUBLICAR_ATESTANDO_SEM_SKU_SHOPEE, adota: [] },
    ];
  }
  if (motivo !== MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaJaVinculada) return [];
  if (acao?.tipo !== TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.importar || acao.vinculados == null) {
    return [];
  }
  const vinculados = new Set(acao.vinculados.map((v) => v.itemId));
  const livres = acao.itemIds.filter((id) => !vinculados.has(id));
  return [
    {
      tipo: 'descartar-atestando',
      rotulo: ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE,
      aviso: livres.length === 0 ? null : avisoDoDescarteComAnuncioSemVinculoShopee(livres),
    },
    {
      tipo: 'publicar-atestando',
      rotulo:
        livres.length === 0
          ? ROTULO_PUBLICAR_SEGUNDO_DE_PROPOSITO_SHOPEE
          : rotuloDaPublicacaoQueAdotaShopee(livres),
      adota: livres,
    },
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
 * - `attribute_list` — none on a draft until the attribute editor (P13); a
 *   listing's ⇒ Seller Centre.
 * - `item_sku` / `sku` — an ALLOW-LIST (§C rule 4): the produto's SKU ONLY for
 *   `anuncio-existente-de-outro-produto` and an acao-less
 *   `criacao-incerta-ambigua` (the SKU moved). Every other motivo carrying it
 *   (the uncertain create's, the look-ups', Shopee's duplicate refusal) — or
 *   a renamed one — gets none: there the SKU is not the fix.
 * - weight, dimensions, photos, GTIN, price, stock, taxes, pre-order — the
 *   produto's field; `size_chart_info` — the size chart; the variation roots —
 *   the variations.
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
      return ehRascunho ? null : SELLER_CENTRE;
    case 'size_chart_info':
      return { tipo: 'medidas' };
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
