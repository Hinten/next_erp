/**
 * The family read model of the Amazon stock sync (step 12, PR 12-d), pure:
 * how the documents a SKU's unit is read from become the
 * {@link MembroDaFamilia} the shared quantity core reads, and the ONE call into
 * that core. Its reader is `familiaEstoqueFirestore.ts` (PR 12-e1).
 *
 * ## The quantity is the core's, never a second rule
 *
 * {@link quantidadeEstoqueAmazon} is `quantidadeDoMembroCore(membro,
 * opcoesEstoqueAmazon())` and nothing else: the kit fold (component-min, a
 * missing component counting 0), the reservation floor (`reservaEfetiva`), the
 * floor to an integer and the clamp at 0 are all the shared core's.
 * A kit whose components cannot be verified publishes 0 there, which is the
 * safe direction: an oversell cannot be undone.
 *
 * ## The unit
 *
 * The produto a SKU publishes is the UNIT its link resolves to (a family-of-one
 * wrapper's sole member, a kit itself, any other produto itself): the same
 * produto an order line of that SKU consumes. This module takes the unit as
 * given; it never hops a family.
 *
 * ## A component row's produto comes from its PATH
 *
 * Every kit component row is projected as `{ ...raw, parentId: <the produto id
 * in its path>, estoqueDocId: <its doc id> }`, the stored `parentId` spread
 * FIRST and overwritten. That field is a denormalisation, nullable at rest, and
 * the core keys a component on it and skips a row without a string one: read
 * verbatim, a row stored with `parentId: null` (or with none) would count its
 * component as missing and floor the kit to 0. A reader that located a document
 * by its path takes the produto from the path.
 *
 * ## The row at the depósito
 *
 * {@link linhaEstoqueNoDepositoAmazon}: the document at the canonical id
 * `makeEstoqueUid(produtoId, depositoId)` when it exists; else, from the
 * produto's own `estoques` partition, the row whose `depositoOuterRef` is one
 * of the two stored forms of that depósito (`documents/depositos/<id>` or
 * `depositos/<id>`, compared as exact strings: no trim, no case fold), the
 * smallest document id first when several match (rows under an auto-id); else
 * `null`, which the core reads as 0. A row at another depósito is never read.
 *
 * ## `publicado` is carried, never read
 *
 * The core's member type has a `publicado` field; it is projected here because
 * the type asks for it, and nothing in the stock sync reads it. It is an ERP
 * catalogue flag, not "this listing sells": gating a send on it would leave a
 * selling listing at a stale quantity, which oversells.
 *
 * ## The fields
 *
 * {@link CAMPOS_UNIDADE_ESTOQUE_AMAZON} and {@link CAMPOS_LINHA_ESTOQUE_AMAZON}
 * are everything this module reads off a produto and off an estoque row: a
 * reader may project its documents to them (a test proves the projection
 * changes no quantity).
 *
 * PURE: no Firestore, no clock, no environment read.
 */
import {
  type MembroDaFamilia,
  type RawEstoqueRow,
  quantidadeDoMembroCore,
} from '@delfrance/data/admin/estoque';
import {
  type ComponentesKit,
  type estoqueProdutoSchema,
  makeEstoqueUid,
  naoDocId,
  type produtoSchema,
} from '@delfrance/schemas';

import { opcoesEstoqueAmazon } from './opcoesEstoque';

/** Everything this module reads off the UNIT's produto document. */
export const CAMPOS_UNIDADE_ESTOQUE_AMAZON = [
  'ehKit',
  'ehKitVirtual',
  'publicado',
  'componentesKit',
  'timestamp',
] as const satisfies ReadonlyArray<keyof typeof produtoSchema.shape>;

/** Everything this module (and the core behind it) reads off an estoque row. */
export const CAMPOS_LINHA_ESTOQUE_AMAZON = [
  'depositoOuterRef',
  'quantidade',
  'quantidadeReservada',
] as const satisfies ReadonlyArray<keyof typeof estoqueProdutoSchema.shape>;

/** One estoque document as a reader got it: its path and its raw data. */
export interface DocEstoqueLidoAmazon {
  /** `produtos/<produtoId>/estoques/<docId>`, as its `DocumentReference.path` reads. */
  readonly caminho: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** The unit's produto document: its id and its raw data. */
export interface UnidadeLidaEstoqueAmazon {
  readonly id: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** An estoque row's path: the owning produto, then the row's own id. */
const CAMINHO_ESTOQUE = /^produtos\/([^/]+)\/estoques\/([^/]+)$/;

/**
 * The produto id and the doc id of an estoque row's path, or `null` when it is
 * not one: EXACTLY `produtos/<produtoId>/estoques/<docId>`, the form a
 * `DocumentReference.path` reads (no `documents/` prefix, nothing around it),
 * each id a document id. The ONE estoque-path grammar under `estoque/`: the
 * family read here and the movement window (`descobertaEstoque.ts`) both parse
 * with it, so a path one maps the other maps too.
 */
export function partesDoCaminhoEstoqueAmazon(
  caminho: string,
): { produtoId: string; docId: string } | null {
  const m = CAMINHO_ESTOQUE.exec(caminho);
  const produtoId = m?.[1];
  const docId = m?.[2];
  if (produtoId === undefined || docId === undefined) return null;
  if (naoDocId(produtoId) || naoDocId(docId)) return null;
  return { produtoId, docId };
}

/** The produto id and doc id of a row the caller says it read, or a `TypeError` (a wiring bug). */
function partesExigidas(caminho: string): { produtoId: string; docId: string } {
  const partes = partesDoCaminhoEstoqueAmazon(caminho);
  if (partes === null) {
    throw new TypeError('familiaEstoque.ts: caminho fora de produtos/<id>/estoques/<id>');
  }
  return partes;
}

function exigirDocId(valor: string, campo: string): void {
  if (naoDocId(valor)) {
    throw new RangeError(`familiaEstoque.ts: ${campo} não é um id de documento`);
  }
}

/**
 * The two stored forms of a depósito ref: canonical first, then the bare form
 * readers tolerate (`outerRef.ts`).
 *
 * @throws {RangeError} a `depositoId` that is not a document id.
 */
export function formasRefDepositoEstoqueAmazon(depositoId: string): readonly [string, string] {
  exigirDocId(depositoId, 'depositoId');
  return [`documents/depositos/${depositoId}`, `depositos/${depositoId}`];
}

/** Whether a raw row sits at the depósito: its ref is one of the two forms, exactly. */
function estaNoDeposito(
  raw: Readonly<Record<string, unknown>>,
  formas: readonly string[],
): boolean {
  const ref = raw.depositoOuterRef;
  return typeof ref === 'string' && formas.includes(ref);
}

/** What {@link linhaEstoqueNoDepositoAmazon} is handed. */
export interface EntradaLinhaEstoqueAmazon {
  readonly produtoId: string;
  readonly depositoId: string;
  /** The document at the canonical id; `null` when it does not exist. */
  readonly canonica: DocEstoqueLidoAmazon | null;
  /**
   * The produto's whole `estoques` partition, needed only when the canonical
   * document is absent (`null` = not read).
   */
  readonly particao: readonly DocEstoqueLidoAmazon[] | null;
}

/**
 * The estoque row of `produtoId` at `depositoId` (module header), or `null`
 * when the produto has none there (the core then reads 0).
 *
 * @throws {TypeError} a canonical document read from another path, a partition
 *   row of another produto, or no partition when the canonical row is absent
 *   (each a wiring bug, never data).
 * @throws {RangeError} an id that is not a document id.
 */
export function linhaEstoqueNoDepositoAmazon(
  entrada: EntradaLinhaEstoqueAmazon,
): DocEstoqueLidoAmazon | null {
  const { produtoId, depositoId, canonica, particao } = entrada;
  exigirDocId(produtoId, 'produtoId');
  const formas = formasRefDepositoEstoqueAmazon(depositoId);
  if (canonica !== null) {
    const partes = partesExigidas(canonica.caminho);
    if (partes.produtoId !== produtoId || partes.docId !== makeEstoqueUid(produtoId, depositoId)) {
      throw new TypeError('familiaEstoque.ts: a linha canônica não está no id canônico do produto');
    }
    return canonica;
  }
  if (particao === null) {
    throw new TypeError('familiaEstoque.ts: sem a linha canônica, a partição precisa ser lida');
  }
  let escolhida: { doc: DocEstoqueLidoAmazon; docId: string } | null = null;
  for (const doc of particao) {
    const partes = partesExigidas(doc.caminho);
    if (partes.produtoId !== produtoId) {
      throw new TypeError('familiaEstoque.ts: linha da partição de outro produto');
    }
    if (!estaNoDeposito(doc.raw, formas)) continue;
    if (escolhida === null || partes.docId < escolhida.docId) {
      escolhida = { doc, docId: partes.docId };
    }
  }
  return escolhida?.doc ?? null;
}

function numeroFinito(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

/**
 * The member the core reads, from the unit, its row at the depósito
 * ({@link linhaEstoqueNoDepositoAmazon}, or `null`) and ONE row per kit
 * component at the same depósito (module header: each produto from the PATH).
 *
 * @throws {TypeError} the own row of another produto, a path that is not an
 *   estoque path, or two rows of one component (each a wiring bug).
 */
export function membroParaEstoqueAmazon(
  unidade: UnidadeLidaEstoqueAmazon,
  estoque: DocEstoqueLidoAmazon | null,
  componentes: readonly DocEstoqueLidoAmazon[],
): MembroDaFamilia {
  exigirDocId(unidade.id, 'unidade.id');
  let propria: RawEstoqueRow | null = null;
  if (estoque !== null) {
    const partes = partesExigidas(estoque.caminho);
    if (partes.produtoId !== unidade.id) {
      throw new TypeError('familiaEstoque.ts: a linha própria é de outro produto');
    }
    propria = { ...estoque.raw, estoqueDocId: partes.docId };
  }
  const donos = new Set<string>();
  const linhasDosComponentes: RawEstoqueRow[] = [];
  for (const componente of componentes) {
    const partes = partesExigidas(componente.caminho);
    if (donos.has(partes.produtoId)) {
      throw new TypeError('familiaEstoque.ts: duas linhas para o mesmo componente');
    }
    donos.add(partes.produtoId);
    linhasDosComponentes.push({
      ...componente.raw,
      parentId: partes.produtoId,
      estoqueDocId: partes.docId,
    });
  }
  const raw = unidade.raw;
  return {
    produtoId: unidade.id,
    ehKit: raw.ehKit === true,
    ehKitVirtual: raw.ehKitVirtual === true,
    // Carried for the core's type only (module header): nothing reads it.
    publicado: raw.publicado === true,
    // Stays RAW: the core's kit fold tolerates junk from a soft-read document.
    componentesKit: (raw.componentesKit ?? null) as ComponentesKit | null,
    timestampMs: numeroFinito(raw.timestamp),
    estoque: propria,
    componentEstoques: linhasDosComponentes,
  };
}

/**
 * The quantity the SKU publishes: the shared core under Amazon's options
 * (module header). Never `null`: those options never ask the core to skip.
 *
 * @throws {TypeError} the core answered no quantity (unreachable under
 *   {@link opcoesEstoqueAmazon}; a thrown wiring bug, never an invented number).
 */
export function quantidadeEstoqueAmazon(membro: MembroDaFamilia): number {
  const quantidade = quantidadeDoMembroCore(membro, opcoesEstoqueAmazon());
  if (quantidade === null) {
    throw new TypeError('familiaEstoque.ts: o núcleo não respondeu uma quantidade');
  }
  return quantidade;
}
