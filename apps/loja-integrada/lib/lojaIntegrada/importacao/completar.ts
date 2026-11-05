/**
 * The product import's FILL-EMPTY (master plan step 9, "complete"): an ERP produto that exists —
 * matched by the cascade, or adopted after a create met `ALREADY_EXISTS` — gets each of its EMPTY
 * fields of the table below filled from the store, and nothing else. Under Simular the same reads
 * run and the same plan is made, and nothing is written: the result names the fields a run would
 * fill.
 *
 * ## Order (the caller's contract, per produto)
 *
 * FILL first ({@link preencherProdutoLi}), then the photos, then the store link LAST. The link's
 * creation fires the anchor trigger, which writes the produto (`integracoesComProduto`); written
 * last, that write can never land between this module's read of the produto and its guarded write,
 * so the job never loses a fill to its own anchor. A crash before the link is repaired by the next
 * run's SKU match.
 *
 * ## "Empty" ({@link vazioNoErpLi})
 *
 * On the ERP side a field is empty when it is ABSENT, `null` or `''`. Everything else is a value
 * and is never replaced: `0`, `false`, `' '`, a value of the wrong type, a malformed ref. On the
 * store side `null`, absent and `''` are "nothing", and nothing is never written (the shared
 * readers already fold them: `lerDetalheProdutoLi` reads `''` as `null` and a zero measure as
 * `null`; a brand whose name is `''` is nothing here).
 *
 * ## The field map ({@link valoresDoLiLi}, {@link planejarPreenchimentoProdutoLi},
 * {@link planejarPreenchimentoExtraDataLi})
 *
 * | ERP field | From the store | A variation |
 * | --- | --- | --- |
 * | `gtin` (≤ 255) | its own `gtin` (detail, else row) | its own |
 * | `pesoLiquidoKg`, `pesoBrutoKg` | the detail's `peso`, each field on its own | its own only |
 * | `alturaCm`, `larguraCm`, `profundidadeCm` | the detail's dimensions | its own; when its detail was read and carries NONE of the three, the parent's three |
 * | `categoriaProdutoOuterRef` | the leaf the category resolution gave (`categorias.ts`) | the PARENT's resolved category |
 * | `extraData.descricao` (≤ 3,000) | the detail's description, verbatim | its own |
 * | `extraData.marca` (≤ 255) | the brand's `nome` in the job's brand list, by the detail's brand id | the PARENT's brand |
 *
 * A variation's dimensions are taken WHOLE, never mixed: one with any dimension of its own keeps
 * its own (a box built from its height and its parent's width would describe no package), and one
 * whose detail was never read inherits nothing (unknown is not none). Its weight is never inherited:
 * the store keeps one per variation.
 *
 * Units ({@link medidasErpDoDetalheLi}, the ONE place they are converted): the store's weight is
 * read as kilograms and its dimensions as centimetres. ⚠️ That is an INFERENCE from the store's
 * panel, awaiting the owner's confirmation; a different unit changes that one function. The weight
 * is rounded to the gram — the precision the ERP's weight field is edited at — which also absorbs
 * the float noise a decimal text such as `"0.450000000000000011…"` parses to; a weight below half a
 * gram rounds to nothing, never to a `0` that would fill the field for good. Dimensions are kept as
 * read (the store sends integers).
 *
 * A planned value that does not parse through the field's own schema (a GTIN or a brand name over
 * 255) is not written: `dado-invalido` names the field (`extraData.<campo>` for the extraData
 * ones) and every other field still fills. A description longer than 3,000 characters leaves
 * `extraData.descricao` empty and reports `descricao-longa` with the store text's LENGTH (never a
 * cut text). Both are reported only for a field that is still empty, so a run never asks a person
 * about a field it would not have written anyway.
 *
 * ## Never written
 *
 * `nome`, `sku` and `ehUsado` (create only); `precos`, `custo`, any `estoques` document; NCM or any
 * `imposto` document; the kit fields (`componentesKit`, `componentesKitKeys`, `ehKit`,
 * `ehKitVirtual`); `publicado`, `codPai`, `codFornecedor`, `paiId`, `filhoUnicoId`;
 * `integracoesComProduto` (the anchor's); `marketplace*`, `statusProdutosMarketplace`;
 * `extraData.youtube`, `metaDescricao`, `keyWords`; any field that has a value. Each patch carries
 * only the table's keys (plus `ultimaModificacao` on the produto) and passes the collection's
 * `parseMerge` before it is written, which throws on any key the schema does not model.
 *
 * **A kit root** (`ehKit: true` as stored) gets only its non-kit empty fields: its weight and box
 * are the kit rollup's, computed from its components server-side, so the store's are never written
 * there. Its composition is never touched.
 *
 * ## The writes (root rule 7, the plan's rows 9 and 10)
 *
 * - **The produto, tier 1**: the patch is derived from THIS attempt's read and written as
 *   `update({ …patch, ultimaModificacao }, { lastUpdateTime: <that read's updateTime> })`, the
 *   stamp in MILLISECONDS from the job's clock (`produto.ultimaModificacao` is ms, and the TableView
 *   monitor watches it). A 9 (or 5) re-reads the produto: when the stored document holds the WHOLE
 *   patch as written (`guardaOPatchLi`, the job module's "is it our write?" — the patch carries this
 *   attempt's own ms stamp), it is OUR write that landed and lost only its reply (the Admin SDK
 *   retries a commit with the same precondition and meets its own stamp), counted as written.
 *   Otherwise the re-read is the next attempt's read and the plan is made AGAIN from it: a field
 *   another writer filled meanwhile is no longer empty, so it is not touched. A fourth plan that
 *   still has something to write is `conflito-de-escrita` — never forced.
 * - **`extraData/singleton`**: ABSENT ⇒ `create(patch)` (tier 0; a 6 re-reads it — our own create
 *   whose reply was lost holds the patch and counts as written; another writer's document is planned
 *   on as below); PRESENT ⇒ tier 1 exactly as the produto, with no stamp of its own (the schema has
 *   none). A store with nothing for it costs no read of it.
 *
 * Fields filled by an earlier attempt of THIS call that landed stay counted. A produto found gone
 * (at the first read, or at a re-read after a loss) ends `ausente` with `conflito-de-escrita`: the
 * job lost it to a delete, so the caller fills no extraData, adds no photo and writes no link.
 *
 * ## What the result reports
 *
 * The NAMES of the fields filled (Simular: that would be) — the produto's bare, the extraData's
 * prefixed — for the report item, the pendências above, and how the category stands for the
 * tax-review list: `preenchida` (it was empty and this fill wrote it), `existente` (it had a value)
 * or `vazia` (it was empty and stays so: the store gave none, the one it gave was refused, or the
 * write lost every attempt).
 *
 * ⚠️ Accepted residual: a fill that LANDED while its reply was lost and that another writer then
 * changed again before the re-read (a later `ultimaModificacao`) is not recognised as ours; the
 * re-plan finds those fields filled and writes nothing over them, and they are reported nowhere. A
 * unit retried after the fill landed reads the same: the fields are filled, so the retry reports
 * none of them.
 *
 * ## The reads, against the indexes (root rule 1)
 *
 * Two documents by id — `produtos/{id}` and `produtos/{id}/extraData/singleton` — per attempt. No
 * query, so no index.
 *
 * ## Errors (root rule 6)
 *
 * Only the precondition codes a write can lose with are caught, each narrowed by its gRPC code
 * (`FAILED_PRECONDITION`/`NOT_FOUND` on an update, `ALREADY_EXISTS` on a create); every other
 * Firestore failure, and a `ZodError` from a patch the schema refuses (a coding error), propagates
 * and the task retries.
 *
 * ⚠️ Never name the Admin SDK's multi-document read-and-write call here — not even in a comment
 * (`estrutura.test.ts`). Next-free; `db` is a parameter.
 */
import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import {
  categoriaCollection,
  produtoCollection,
  produtoExtraDataCollection,
} from '@delfrance/data/admin/collections';
import {
  isAlreadyExists,
  isFailedPrecondition,
  isNotFound,
} from '@delfrance/data/admin/grpcErrors';
import {
  type MarcaCatalogoLi,
  MODO_IMPORTACAO_LI,
  type ModoImportacaoLi,
  PENDENCIA_IMPORTACAO_LI,
  PRODUTO_EXTRA_DATA_DOC_ID,
  type ProdutoLiDetalhado,
  type ProdutoLiLido,
  produtoExtraDataSchema,
  produtoSchema,
  toOuterRefOrNull,
} from '@delfrance/schemas';

import { guardaOPatchLi } from './job';
import { PAPEL_DO_VINCULO_LI, type PapelDoVinculoLi, type PendenciaDoPlanoLi } from './plano';

/** The guarded writes of one document per call: the first and two re-plans (module header). */
export const MAX_TENTATIVAS_PREENCHIMENTO_LI = 3;

/** The produto fields the fill may write, in the order they are reported (module header). */
export const CAMPOS_PRODUTO_PREENCHIMENTO_LI = [
  'gtin',
  'pesoLiquidoKg',
  'pesoBrutoKg',
  'alturaCm',
  'larguraCm',
  'profundidadeCm',
  'categoriaProdutoOuterRef',
] as const;
export type CampoProdutoPreenchimentoLi = (typeof CAMPOS_PRODUTO_PREENCHIMENTO_LI)[number];

/** The `extraData` fields the fill may write. */
export const CAMPOS_EXTRA_DATA_PREENCHIMENTO_LI = ['descricao', 'marca'] as const;
export type CampoExtraDataPreenchimentoLi = (typeof CAMPOS_EXTRA_DATA_PREENCHIMENTO_LI)[number];

/** The prefix an `extraData` field carries in the reported names (`extraData.descricao`). */
export const PREFIXO_EXTRA_DATA_LI = 'extraData.';

/** A kit root's weight and box: the kit rollup's, never the store's (module header). */
const CAMPOS_DO_ROLLUP_DO_KIT: ReadonlySet<CampoProdutoPreenchimentoLi> = new Set([
  'pesoLiquidoKg',
  'pesoBrutoKg',
  'alturaCm',
  'larguraCm',
  'profundidadeCm',
]);

/* -------------------------------------------------------------------------- */
/*                                 The values                                  */
/* -------------------------------------------------------------------------- */

/** A store product's measures in the ERP's units. */
export interface MedidasErpLi {
  readonly pesoKg: number | null;
  readonly alturaCm: number | null;
  readonly larguraCm: number | null;
  readonly profundidadeCm: number | null;
}

const SEM_MEDIDAS: MedidasErpLi = {
  pesoKg: null,
  alturaCm: null,
  larguraCm: null,
  profundidadeCm: null,
};

/** Grams per kilogram: the weight is kept to the gram (module header, "Units"). */
const GRAMAS_POR_KG = 1000;

/**
 * THE unit conversion of the import (module header, "Units"): the detail's measures as the ERP
 * stores them — the weight in kg rounded to the gram, the dimensions in cm as read. A weight that
 * rounds to zero is nothing. ⚠️ kg and cm are an inference awaiting the owner's confirmation:
 * change this function, and only this one, if they turn out otherwise.
 */
export function medidasErpDoDetalheLi(
  detalhe: Pick<ProdutoLiDetalhado, 'pesoKg' | 'alturaCm' | 'larguraCm' | 'profundidadeCm'> | null,
): MedidasErpLi {
  if (detalhe === null) return SEM_MEDIDAS;
  const gramas = detalhe.pesoKg === null ? 0 : Math.round(detalhe.pesoKg * GRAMAS_POR_KG);
  return {
    pesoKg: gramas > 0 ? gramas / GRAMAS_POR_KG : null,
    alturaCm: detalhe.alturaCm,
    larguraCm: detalhe.larguraCm,
    profundidadeCm: detalhe.profundidadeCm,
  };
}

/** Where a produto's store values come from (module header, the field map). */
export interface FonteDoPreenchimentoLi {
  /** The root (a parent or a simple product) or a variation. */
  readonly papel: PapelDoVinculoLi;
  /** The store product's row view (for a variation never listed, its detail). */
  readonly linha: ProdutoLiLido;
  /** Its detail, when this job read one. */
  readonly detalhe: ProdutoLiDetalhado | null;
  /** A variation's PARENT detail (its dimensions and its brand); ignored for a root. */
  readonly detalheDoPai: ProdutoLiDetalhado | null;
  /**
   * The ERP categoria the produto takes: a root's own resolved leaf (`categorias.ts`), a variation's
   * PARENT's; `null` when there is none.
   */
  readonly categoriaErpId: string | null;
  /** The job's brand list (`job.marcas`). */
  readonly marcas: readonly MarcaCatalogoLi[];
}

/** The store's values for the table's fields, in the ERP's units; `null` = nothing. */
export interface ValoresDoLiLi {
  readonly gtin: string | null;
  readonly medidas: MedidasErpLi;
  readonly categoriaErpId: string | null;
  readonly descricao: string | null;
  /** The store description's length when it exceeds the ERP field (its text is never kept). */
  readonly descricaoLongaTamanho: number | null;
  readonly marca: string | null;
}

/** Whether a detail carries none of the three dimensions. */
function semDimensoes(m: MedidasErpLi): boolean {
  return m.alturaCm === null && m.larguraCm === null && m.profundidadeCm === null;
}

/** The brand's name in the job's list, by id; `''`, an unknown id or no id ⇒ nothing. */
function nomeDaMarca(marcaId: number | null, marcas: readonly MarcaCatalogoLi[]): string | null {
  if (marcaId === null) return null;
  const nome = marcas.find((m) => m.id === marcaId)?.nome;
  return nome === undefined || nome === '' ? null : nome;
}

/** The store's values for one produto (module header, the field map). Pure. */
export function valoresDoLiLi(fonte: FonteDoPreenchimentoLi): ValoresDoLiLi {
  const { detalhe } = fonte;
  const proprias = medidasErpDoDetalheLi(detalhe);
  const filho = fonte.papel === PAPEL_DO_VINCULO_LI.filho;
  // A variation's box is its own, or — when its READ detail has none of the three — its parent's.
  const caixa =
    filho && detalhe !== null && semDimensoes(proprias)
      ? medidasErpDoDetalheLi(fonte.detalheDoPai)
      : proprias;
  const marcaId = filho ? (fonte.detalheDoPai?.marcaId ?? null) : (detalhe?.marcaId ?? null);
  return {
    // The detail, when read, is the fresher answer: its `null` is not overruled by the row.
    gtin: detalhe === null ? fonte.linha.gtin : detalhe.gtin,
    medidas: {
      pesoKg: proprias.pesoKg,
      alturaCm: caixa.alturaCm,
      larguraCm: caixa.larguraCm,
      profundidadeCm: caixa.profundidadeCm,
    },
    categoriaErpId: fonte.categoriaErpId,
    descricao: detalhe?.descricao ?? null,
    descricaoLongaTamanho: detalhe?.descricaoLonga === true ? detalhe.descricaoTamanho : null,
    marca: nomeDaMarca(marcaId, fonte.marcas),
  };
}

/* -------------------------------------------------------------------------- */
/*                                  The plans                                  */
/* -------------------------------------------------------------------------- */

/** Whether a stored field is EMPTY: absent, `null` or `''` (module header). Pure. */
export function vazioNoErpLi(
  armazenado: Readonly<Record<string, unknown>>,
  campo: string,
): boolean {
  if (!Object.hasOwn(armazenado, campo)) return true;
  const valor = armazenado[campo];
  return valor === null || valor === undefined || valor === '';
}

/** How the produto's category stands after the fill (the tax review's input). */
export type CategoriaNoPreenchimentoLi =
  /** It was empty and the fill writes it (Simular: would). */
  | 'preenchida'
  /** It had a value; never touched. */
  | 'existente'
  /** It was empty and stays empty (no category to give, a refused one, or a lost race). */
  | 'vazia';

/** Named members of {@link CategoriaNoPreenchimentoLi}. */
export const CATEGORIA_NO_PREENCHIMENTO_LI = {
  preenchida: 'preenchida',
  existente: 'existente',
  vazia: 'vazia',
} as const satisfies Record<string, CategoriaNoPreenchimentoLi>;

/** One document's plan. */
export interface PlanoDoPreenchimentoLi {
  /** The fields to write, with their values (no stamp); empty ⇒ no write. */
  readonly patch: Readonly<Record<string, unknown>>;
  /** The reported names of the fields in `patch` (extraData's prefixed), table order. */
  readonly campos: readonly string[];
  /** Empty fields whose store value does not parse through the field's schema (reported names). */
  readonly invalidos: readonly string[];
}

/** The produto's plan, plus where its category stands. */
export interface PlanoDoProdutoLi extends PlanoDoPreenchimentoLi {
  readonly categoria: CategoriaNoPreenchimentoLi;
}

/** The extraData's plan, plus the description too long to write (its length) for an empty field. */
export interface PlanoDoExtraDataLi extends PlanoDoPreenchimentoLi {
  readonly descricaoLongaTamanho: number | null;
}

/** A category id no `documents/categorias/<id>` ref can be formed from: reported, never thrown. */
const REF_IMPOSSIVEL = Symbol('ref-impossivel');

/** The store's value of one produto field, `null` for nothing. */
function valorDoCampoProduto(
  campo: CampoProdutoPreenchimentoLi,
  v: ValoresDoLiLi,
): string | number | null | typeof REF_IMPOSSIVEL {
  switch (campo) {
    case 'gtin':
      return v.gtin;
    case 'pesoLiquidoKg':
    case 'pesoBrutoKg':
      return v.medidas.pesoKg;
    case 'alturaCm':
      return v.medidas.alturaCm;
    case 'larguraCm':
      return v.medidas.larguraCm;
    case 'profundidadeCm':
      return v.medidas.profundidadeCm;
    case 'categoriaProdutoOuterRef':
      return v.categoriaErpId === null
        ? null
        : (toOuterRefOrNull(categoriaCollection.docPath({}, v.categoriaErpId)) ?? REF_IMPOSSIVEL);
  }
}

/**
 * The produto's fill (module header): each table field that is EMPTY as stored and has a store
 * value parsing through the produto schema's own field. A kit root skips its rollup's fields. Pure.
 */
export function planejarPreenchimentoProdutoLi(
  armazenado: Readonly<Record<string, unknown>>,
  valores: ValoresDoLiLi,
): PlanoDoProdutoLi {
  const kit = armazenado.ehKit === true;
  const patch: Record<string, unknown> = {};
  const campos: string[] = [];
  const invalidos: string[] = [];
  for (const campo of CAMPOS_PRODUTO_PREENCHIMENTO_LI) {
    if (kit && CAMPOS_DO_ROLLUP_DO_KIT.has(campo)) continue;
    if (!vazioNoErpLi(armazenado, campo)) continue;
    const valor = valorDoCampoProduto(campo, valores);
    if (valor === null) continue;
    const lido = valor === REF_IMPOSSIVEL ? null : produtoSchema.shape[campo].safeParse(valor);
    if (lido === null || !lido.success || lido.data === null) {
      invalidos.push(campo);
      continue;
    }
    patch[campo] = lido.data;
    campos.push(campo);
  }
  const categoria = !vazioNoErpLi(armazenado, 'categoriaProdutoOuterRef')
    ? CATEGORIA_NO_PREENCHIMENTO_LI.existente
    : Object.hasOwn(patch, 'categoriaProdutoOuterRef')
      ? CATEGORIA_NO_PREENCHIMENTO_LI.preenchida
      : CATEGORIA_NO_PREENCHIMENTO_LI.vazia;
  return { patch, campos, invalidos, categoria };
}

/**
 * The extraData's fill (module header): `descricao` and `marca` where EMPTY as stored (an absent
 * document has every field empty). Pure.
 */
export function planejarPreenchimentoExtraDataLi(
  armazenado: Readonly<Record<string, unknown>> | null,
  valores: ValoresDoLiLi,
): PlanoDoExtraDataLi {
  const atual = armazenado ?? {};
  const patch: Record<string, unknown> = {};
  const campos: string[] = [];
  const invalidos: string[] = [];
  const candidatos: Record<CampoExtraDataPreenchimentoLi, string | null> = {
    descricao: valores.descricao,
    marca: valores.marca,
  };
  for (const campo of CAMPOS_EXTRA_DATA_PREENCHIMENTO_LI) {
    if (!vazioNoErpLi(atual, campo)) continue;
    const valor = candidatos[campo];
    if (valor === null) continue;
    const lido = produtoExtraDataSchema.shape[campo].safeParse(valor);
    if (!lido.success || lido.data === null) {
      invalidos.push(`${PREFIXO_EXTRA_DATA_LI}${campo}`);
      continue;
    }
    patch[campo] = lido.data;
    campos.push(`${PREFIXO_EXTRA_DATA_LI}${campo}`);
  }
  const descricaoLongaTamanho =
    valores.descricaoLongaTamanho !== null && vazioNoErpLi(atual, 'descricao')
      ? valores.descricaoLongaTamanho
      : null;
  return { patch, campos, invalidos, descricaoLongaTamanho };
}

/* -------------------------------------------------------------------------- */
/*                                  The writes                                 */
/* -------------------------------------------------------------------------- */

export interface DepsPreenchimentoLi {
  readonly db: Firestore;
  /** Simular reads and plans exactly as `aplicar` does, and writes nothing. */
  readonly modo: ModoImportacaoLi;
  /** The job's clock, ms: the produto's `ultimaModificacao`. */
  readonly agoraMs: () => number;
}

export interface EntradaDoPreenchimentoLi {
  /** The ERP produto (an existing one: matched, or adopted after a create met a 6). */
  readonly produtoId: string;
  /** The store variation the pendências are about; `null` for the item's root. */
  readonly liId: number | null;
  readonly valores: ValoresDoLiLi;
}

/** How one produto's fill ended. */
export type ResultadoDoPreenchimentoLi =
  /** The produto is gone (deleted since the match): nothing read beyond it, nothing written. */
  | {
      readonly tipo: 'ausente';
      readonly produtoId: string;
      readonly pendencias: readonly PendenciaDoPlanoLi[];
    }
  | {
      readonly tipo: 'preenchido';
      readonly produtoId: string;
      /** The fields filled (Simular: that would be), produto's then extraData's, table order. */
      readonly campos: readonly string[];
      readonly categoria: CategoriaNoPreenchimentoLi;
      readonly pendencias: readonly PendenciaDoPlanoLi[];
      /** A write of this call landed (`aplicar` only). */
      readonly gravado: boolean;
    };

/** Named members of {@link ResultadoDoPreenchimentoLi}'s `tipo`. */
export const TIPO_RESULTADO_PREENCHIMENTO_LI = {
  ausente: 'ausente',
  preenchido: 'preenchido',
} as const satisfies Record<string, ResultadoDoPreenchimentoLi['tipo']>;

/** One document's outcome. */
interface DesfechoDoDocumento<P extends PlanoDoPreenchimentoLi> {
  /** The last plan made (its `invalidos` are what the item reports). */
  readonly plano: P;
  /** The fields that LANDED (Simular: the plan's). */
  readonly campos: readonly string[];
  readonly gravado: boolean;
  /** A fourth plan still had something to write. */
  readonly conflito: boolean;
}

/** The stored data of a snapshot, as a plain record. */
function dadosDe(snap: DocumentSnapshot): Record<string, unknown> {
  return (snap.data() ?? {}) as Record<string, unknown>;
}

/** The produto's fill, attempt by attempt (module header, "The writes"); `null` = it is gone. */
async function preencherOProduto(
  deps: DepsPreenchimentoLi,
  produtoId: string,
  valores: ValoresDoLiLi,
): Promise<DesfechoDoDocumento<PlanoDoProdutoLi> | null> {
  const ref = produtoCollection.docRef(deps.db, {}, produtoId);
  let snap = await ref.get();
  for (let escritas = 0; ; escritas += 1) {
    if (!snap.exists || snap.updateTime === undefined) return null;
    const plano = planejarPreenchimentoProdutoLi(dadosDe(snap), valores);
    if (plano.campos.length === 0) return { plano, campos: [], gravado: false, conflito: false };
    if (deps.modo === MODO_IMPORTACAO_LI.simular) {
      return { plano, campos: plano.campos, gravado: false, conflito: false };
    }
    if (escritas >= MAX_TENTATIVAS_PREENCHIMENTO_LI) {
      return { plano, campos: [], gravado: false, conflito: true };
    }
    // Validated as the collection validates a merge: an unmodelled key throws (a coding error).
    const escrito = produtoCollection.parseMerge({
      ...plano.patch,
      ultimaModificacao: deps.agoraMs(),
    });
    try {
      await ref.update(escrito, { lastUpdateTime: snap.updateTime });
      return { plano, campos: plano.campos, gravado: true, conflito: false };
    } catch (err) {
      if (!isFailedPrecondition(err) && !isNotFound(err)) throw err;
    }
    snap = await ref.get();
    // Our own write, landed with its reply lost (module header): counted, never redone.
    if (snap.exists && guardaOPatchLi(snap.data(), escrito)) {
      return { plano, campos: plano.campos, gravado: true, conflito: false };
    }
  }
}

/** The extraData's fill, attempt by attempt (module header, "The writes"). */
async function preencherOExtraData(
  deps: DepsPreenchimentoLi,
  produtoId: string,
  valores: ValoresDoLiLi,
): Promise<DesfechoDoDocumento<PlanoDoExtraDataLi>> {
  const ref = produtoExtraDataCollection.docRef(deps.db, { produtoId }, PRODUTO_EXTRA_DATA_DOC_ID);
  let snap = await ref.get();
  for (let escritas = 0; ; escritas += 1) {
    const versao = snap.exists ? snap.updateTime : undefined;
    const plano = planejarPreenchimentoExtraDataLi(
      versao === undefined ? null : dadosDe(snap),
      valores,
    );
    if (plano.campos.length === 0) return { plano, campos: [], gravado: false, conflito: false };
    if (deps.modo === MODO_IMPORTACAO_LI.simular) {
      return { plano, campos: plano.campos, gravado: false, conflito: false };
    }
    if (escritas >= MAX_TENTATIVAS_PREENCHIMENTO_LI) {
      return { plano, campos: [], gravado: false, conflito: true };
    }
    const escrito = produtoExtraDataCollection.parseMerge({ ...plano.patch });
    try {
      if (versao === undefined) await ref.create(escrito);
      else await ref.update(escrito, { lastUpdateTime: versao });
      return { plano, campos: plano.campos, gravado: true, conflito: false };
    } catch (err) {
      const perdeu =
        versao === undefined ? isAlreadyExists(err) : isFailedPrecondition(err) || isNotFound(err);
      if (!perdeu) throw err;
    }
    snap = await ref.get();
    if (snap.exists && guardaOPatchLi(snap.data(), escrito)) {
      return { plano, campos: plano.campos, gravado: true, conflito: false };
    }
  }
}

/** Whether the store has anything the extraData could take (else its read is skipped). */
function temAlgoParaExtraData(v: ValoresDoLiLi): boolean {
  return v.descricao !== null || v.marca !== null || v.descricaoLongaTamanho !== null;
}

/**
 * Fill ONE existing produto's empty fields from the store (module header): the produto, then its
 * extraData. Call it BEFORE the produto's photos and its link. Under Simular nothing is written and
 * the result names the fields a run would fill.
 */
export async function preencherProdutoLi(
  deps: DepsPreenchimentoLi,
  entrada: EntradaDoPreenchimentoLi,
): Promise<ResultadoDoPreenchimentoLi> {
  const { produtoId, liId, valores } = entrada;
  const produto = await preencherOProduto(deps, produtoId, valores);
  if (produto === null) {
    return {
      tipo: TIPO_RESULTADO_PREENCHIMENTO_LI.ausente,
      produtoId,
      pendencias: [
        { codigo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita, liId, referencias: [produtoId] },
      ],
    };
  }
  const extra = temAlgoParaExtraData(valores)
    ? await preencherOExtraData(deps, produtoId, valores)
    : null;

  const pendencias: PendenciaDoPlanoLi[] = [];
  const invalidos = [...produto.plano.invalidos, ...(extra?.plano.invalidos ?? [])];
  if (invalidos.length > 0) {
    pendencias.push({ codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido, liId, referencias: invalidos });
  }
  const tamanho = extra?.plano.descricaoLongaTamanho ?? null;
  if (tamanho !== null) {
    pendencias.push({
      codigo: PENDENCIA_IMPORTACAO_LI.descricaoLonga,
      liId,
      referencias: [String(tamanho)],
    });
  }
  if (produto.conflito) {
    pendencias.push({
      codigo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita,
      liId,
      referencias: [produtoId],
    });
  }
  if (extra?.conflito === true) {
    pendencias.push({
      codigo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita,
      liId,
      referencias: [`${produtoId}/extraData`],
    });
  }

  const categoriaPreenchida = produto.campos.includes('categoriaProdutoOuterRef');
  const categoria: CategoriaNoPreenchimentoLi = categoriaPreenchida
    ? CATEGORIA_NO_PREENCHIMENTO_LI.preenchida
    : produto.plano.categoria === CATEGORIA_NO_PREENCHIMENTO_LI.existente
      ? CATEGORIA_NO_PREENCHIMENTO_LI.existente
      : CATEGORIA_NO_PREENCHIMENTO_LI.vazia;
  return {
    tipo: TIPO_RESULTADO_PREENCHIMENTO_LI.preenchido,
    produtoId,
    campos: [...produto.campos, ...(extra?.campos ?? [])],
    categoria,
    pendencias,
    gravado: produto.gravado || extra?.gravado === true,
  };
}
