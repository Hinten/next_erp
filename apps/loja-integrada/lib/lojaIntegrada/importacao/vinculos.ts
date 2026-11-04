/**
 * The product import's LINK WRITES (master plan step 9): a family's planned links (`plano.ts`)
 * written under their ERP produtos — created, refreshed or refused — the root's first, and a
 * variation's only beside the root's CONFIRMED link. Under Simular the same reads run and the same
 * decisions are taken, and nothing is written. It changes no ERP produto: a link only records which
 * store product a produto is, and mirrors the store's state.
 *
 * ## One link ({@link vincularProdutoLi}) — root rule 7, one row per write
 *
 * Each attempt starts with the one-store-product-per-conta scan of the produto's OWN links
 * (`escanearVinculosDoProdutoLi`, every document judged by `vinculoLiDaContaEId`):
 *  - another store product of this conta is linked there ⇒ `vinculado-a-outro` (never deleted,
 *    never re-pointed); a link of this conta whose `id` is not a number ⇒ `vinculo-ilegivel`
 *    (invisible to every field query: never adopted, never filled); another conta's document at
 *    the store id's own doc id ⇒ `vinculo-ambiguo`. Nothing is written.
 *  - **free ⇒ CREATE, tier 0**: `create()` at the store id's decimal text, the planned document
 *    whole. `ALREADY_EXISTS` (6) is the arbiter: the document now there is re-read and judged —
 *    this conta's link for this store id ⇒ refreshed as below, on that read; a text id ⇒
 *    `vinculo-ilegivel`; anything else ⇒ `vinculo-ambiguo`. A product with no SKU has no
 *    creatable document ⇒ `sem-sku`.
 *  - **this conta's link for this store id exists ⇒ the MIRROR REFRESH, tier 1** on each such
 *    document (the one at the store id's doc id first; an auto-id link of the migrated corpus is
 *    refreshed where it is, never duplicated): read it, derive the patch from THAT read, then
 *    `update(patch, { lastUpdateTime: <the read's updateTime> })`. The patch:
 *    - the mirror — `ativo`, `bloqueado`, `removido` — set to the store's when it DIFFERS from the
 *      stored value as the link schema reads it (an absent `ativo` reads `true`, an absent
 *      `bloqueado` or `removido` `false`), so a link stored `removido: true` whose product is
 *      listed again becomes `false` and the anchor counts it again;
 *    - every other planned field only where the stored one is `null` or absent
 *      (`paiProdutoIntegradaId` included); a field with a value is never touched,
 *      `estadoPublicacao` included;
 *    - nothing to change ⇒ no write (`sem-mudanca`): a second run over an unchanged store writes
 *      nothing.
 *
 * A lost precondition (9; 5, a document deleted meanwhile, reads the same) or a document that
 * vanished between the 6 and its re-read re-plans the WHOLE link once, from a fresh scan; a second
 * loss ⇒ `conflito-de-escrita`, reported, never forced ({@link MAX_TENTATIVAS_VINCULO_LI}).
 *
 * ⚠️ Accepted residual (the plan's row 11): a link of this conta written at an AUTO id by another
 * writer between our scan and our create leaves two links of one conta on the produto; the next
 * scan sees it, and publishing refuses a produto with two links of one conta.
 *
 * ## A family ({@link vincularFamiliaLi})
 *
 * The root's link first. Only when it is CONFIRMED — created, refreshed, or already as the store
 * says (under Simular: would be) — are the variations' links written, one after another; a root
 * refused (`vinculado-a-outro`, `vinculo-ambiguo`, `vinculo-ilegivel`, `conflito-de-escrita`,
 * `sem-sku`) refuses every variation with `vinculo-pai-ausente`, with ZERO reads or writes for
 * them: every store link's root is anchored, so steps 12 and 13 never meet a variation linked
 * without its parent.
 *
 * ## The reads, against the indexes (root rule 1)
 *
 * A produto's OWN link subcollection, whole and unfiltered (no index; small), and one link document
 * by id. No query with a filter.
 *
 * ⚠️ Never name the Admin SDK's multi-document read-and-write call here — not even in a comment
 * (`estrutura.test.ts`). Next-free; `db` is a parameter.
 */
import type { DocumentSnapshot } from 'firebase-admin/firestore';
import { produtoLojaIntegradaLinkCollection } from '@delfrance/data/admin/collections';
import {
  isAlreadyExists,
  isFailedPrecondition,
  isNotFound,
} from '@delfrance/data/admin/grpcErrors';
import {
  MODO_IMPORTACAO_LI,
  type ModoImportacaoLi,
  PENDENCIA_IMPORTACAO_LI,
  RELACAO_VINCULO_LI,
  vinculoLiDaContaEId,
} from '@delfrance/schemas';

import type { PlanoDaFamiliaLi, VinculoPlanejadoLi } from './plano';
import {
  type DepsResolucaoLi,
  SITUACAO_DO_VINCULO_NO_PRODUTO_LI,
  escanearVinculosDoProdutoLi,
} from './resolucao';

/** The attempts of one link: the first, and ONE re-plan after a lost write (module header). */
export const MAX_TENTATIVAS_VINCULO_LI = 2;

export interface DepsVinculosLi extends DepsResolucaoLi {
  /** Simular reads and decides exactly as `aplicar` does, and writes nothing. */
  readonly modo: ModoImportacaoLi;
}

/** Why a link was not written. */
export type CodigoDeRecusaDoVinculoLi =
  | typeof PENDENCIA_IMPORTACAO_LI.vinculadoAOutro
  | typeof PENDENCIA_IMPORTACAO_LI.vinculoIlegivel
  | typeof PENDENCIA_IMPORTACAO_LI.vinculoAmbiguo
  | typeof PENDENCIA_IMPORTACAO_LI.semSku
  | typeof PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita
  | typeof PENDENCIA_IMPORTACAO_LI.vinculoPaiAusente;

/** How one link ended (under Simular: would end). */
export type DesfechoDoVinculoLi =
  /** Created at the store id's doc id. */
  | { readonly tipo: 'criado'; readonly docId: string }
  /** This conta's link existed; `campos` were refreshed or filled. */
  | {
      readonly tipo: 'atualizado';
      readonly docIds: readonly string[];
      readonly campos: readonly string[];
    }
  /** This conta's link existed exactly as the store says. */
  | { readonly tipo: 'sem-mudanca'; readonly docIds: readonly string[] }
  /** Not written (module header). */
  | {
      readonly tipo: 'recusado';
      readonly codigo: CodigoDeRecusaDoVinculoLi;
      readonly referencias: readonly string[];
    };

/** Named members of {@link DesfechoDoVinculoLi}'s `tipo`. */
export const DESFECHO_DO_VINCULO_LI = {
  criado: 'criado',
  atualizado: 'atualizado',
  semMudanca: 'sem-mudanca',
  recusado: 'recusado',
} as const satisfies Record<string, DesfechoDoVinculoLi['tipo']>;

export interface ResultadoDoVinculoLi {
  readonly vinculo: VinculoPlanejadoLi;
  readonly desfecho: DesfechoDoVinculoLi;
  /** A write landed (`aplicar` only; always `false` under Simular and for a refusal). */
  readonly gravado: boolean;
}

export interface ResultadoDosVinculosLi {
  /** `null` when the plan has no root link. */
  readonly raiz: ResultadoDoVinculoLi | null;
  /** One per planned variation link, in the plan's order. */
  readonly filhos: readonly ResultadoDoVinculoLi[];
}

/** Whether a link's outcome leaves this conta's link in place (or, under Simular, would). */
export function vinculoConfirmadoLi(desfecho: DesfechoDoVinculoLi): boolean {
  return desfecho.tipo !== DESFECHO_DO_VINCULO_LI.recusado;
}

/* -------------------------------------------------------------------------- */
/*                                  The patch                                  */
/* -------------------------------------------------------------------------- */

/** How the link schema reads an absent or non-boolean mirror field (its `.default()`s). */
const ESPELHO_PADRAO = { ativo: true, bloqueado: false, removido: false } as const;

/**
 * The refresh patch of ONE stored link (module header): the mirror where it differs, every other
 * planned field where the stored one is `null` or absent. Pure.
 */
export function patchDoVinculoLi(
  armazenado: Readonly<Record<string, unknown>>,
  vinculo: Pick<VinculoPlanejadoLi, 'espelho' | 'preencher'>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const chave of ['ativo', 'bloqueado', 'removido'] as const) {
    const vivo = vinculo.espelho[chave];
    if (vivo === undefined) continue;
    const bruto = Object.hasOwn(armazenado, chave) ? armazenado[chave] : undefined;
    const lido = typeof bruto === 'boolean' ? bruto : ESPELHO_PADRAO[chave];
    if (lido !== vivo) patch[chave] = vivo;
  }
  for (const [chave, valor] of Object.entries(vinculo.preencher)) {
    if (valor === undefined) continue;
    const bruto = Object.hasOwn(armazenado, chave) ? armazenado[chave] : undefined;
    if (bruto === null || bruto === undefined) {
      patch[chave] = Array.isArray(valor) ? [...(valor as readonly unknown[])] : valor;
    }
  }
  return patch;
}

/* -------------------------------------------------------------------------- */
/*                                   One link                                  */
/* -------------------------------------------------------------------------- */

/** One attempt's verdict: an outcome, or a lost write (the caller re-plans). */
type Tentativa =
  | { readonly tipo: 'fim'; readonly desfecho: DesfechoDoVinculoLi; readonly gravado: boolean }
  | { readonly tipo: 'perdeu' };

const PERDEU: Tentativa = { tipo: 'perdeu' };

function recusa(codigo: CodigoDeRecusaDoVinculoLi, referencias: readonly string[] = []): Tentativa {
  return {
    tipo: 'fim',
    desfecho: { tipo: DESFECHO_DO_VINCULO_LI.recusado, codigo, referencias },
    gravado: false,
  };
}

function refDoVinculo(deps: DepsVinculosLi, vinculo: VinculoPlanejadoLi, docId: string) {
  return produtoLojaIntegradaLinkCollection.docRef(
    deps.db,
    { produtoId: vinculo.produtoId },
    docId,
  );
}

/** The stored data of a snapshot, as a plain record. */
function dadosDe(snap: DocumentSnapshot): Record<string, unknown> {
  return (snap.data() ?? {}) as Record<string, unknown>;
}

/**
 * Refresh this conta's link documents `docIds` (module header): each read, re-judged, patched on
 * its own read. A document that is no longer this conta's link for the store id, or a lost write,
 * loses the attempt.
 */
async function refrescar(
  deps: DepsVinculosLi,
  vinculo: VinculoPlanejadoLi,
  docIds: readonly string[],
  lidos: ReadonlyMap<string, DocumentSnapshot> = new Map(),
): Promise<Tentativa> {
  const campos = new Set<string>();
  let gravado = false;
  for (const docId of docIds) {
    const snap = lidos.get(docId) ?? (await refDoVinculo(deps, vinculo, docId).get());
    if (!snap.exists || snap.updateTime === undefined) return PERDEU;
    const dados = dadosDe(snap);
    if (vinculoLiDaContaEId(dados, deps.contaId, vinculo.liId) !== RELACAO_VINCULO_LI.mesmo) {
      return PERDEU;
    }
    const patch = patchDoVinculoLi(dados, vinculo);
    const chaves = Object.keys(patch);
    if (chaves.length === 0) continue;
    for (const c of chaves) campos.add(c);
    if (deps.modo === MODO_IMPORTACAO_LI.simular) continue;
    try {
      await refDoVinculo(deps, vinculo, docId).update(patch, { lastUpdateTime: snap.updateTime });
      gravado = true;
    } catch (err) {
      if (!isFailedPrecondition(err) && !isNotFound(err)) throw err;
      return PERDEU;
    }
  }
  const desfecho: DesfechoDoVinculoLi =
    campos.size === 0
      ? { tipo: DESFECHO_DO_VINCULO_LI.semMudanca, docIds: [...docIds] }
      : {
          tipo: DESFECHO_DO_VINCULO_LI.atualizado,
          docIds: [...docIds],
          campos: [...campos].sort(),
        };
  return { tipo: 'fim', desfecho, gravado };
}

/** A create that met `ALREADY_EXISTS`: judge the document now at our doc id (module header). */
async function adotar(
  deps: DepsVinculosLi,
  vinculo: VinculoPlanejadoLi,
  docId: string,
): Promise<Tentativa> {
  const snap = await refDoVinculo(deps, vinculo, docId).get();
  if (!snap.exists) return PERDEU;
  const relacao = vinculoLiDaContaEId(dadosDe(snap), deps.contaId, vinculo.liId);
  if (relacao === RELACAO_VINCULO_LI.mesmo) {
    return refrescar(deps, vinculo, [docId], new Map([[docId, snap]]));
  }
  if (relacao === RELACAO_VINCULO_LI.idIlegivel) {
    return recusa(PENDENCIA_IMPORTACAO_LI.vinculoIlegivel, [docId]);
  }
  return recusa(PENDENCIA_IMPORTACAO_LI.vinculoAmbiguo, [docId]);
}

/** One attempt: the scan, then the create, the refresh or the refusal (module header). */
async function tentar(deps: DepsVinculosLi, vinculo: VinculoPlanejadoLi): Promise<Tentativa> {
  const scan = await escanearVinculosDoProdutoLi(deps, vinculo.produtoId, vinculo.liId);
  switch (scan.situacao) {
    case SITUACAO_DO_VINCULO_NO_PRODUTO_LI.vinculadoAOutro:
      return recusa(
        PENDENCIA_IMPORTACAO_LI.vinculadoAOutro,
        scan.outrosIdsLi.map((id) => String(id)),
      );
    case SITUACAO_DO_VINCULO_NO_PRODUTO_LI.vinculoIlegivel:
      return recusa(PENDENCIA_IMPORTACAO_LI.vinculoIlegivel, scan.docIds);
    case SITUACAO_DO_VINCULO_NO_PRODUTO_LI.vinculoAmbiguo:
      return recusa(PENDENCIA_IMPORTACAO_LI.vinculoAmbiguo, scan.docIds);
    case SITUACAO_DO_VINCULO_NO_PRODUTO_LI.proprio:
      return refrescar(deps, vinculo, scan.docIds);
    case SITUACAO_DO_VINCULO_NO_PRODUTO_LI.livre:
      break;
  }

  if (vinculo.doc === null) return recusa(PENDENCIA_IMPORTACAO_LI.semSku);
  const docId = String(vinculo.liId);
  const criado: Tentativa = {
    tipo: 'fim',
    desfecho: { tipo: DESFECHO_DO_VINCULO_LI.criado, docId },
    gravado: deps.modo !== MODO_IMPORTACAO_LI.simular,
  };
  if (deps.modo === MODO_IMPORTACAO_LI.simular) return criado;
  try {
    await refDoVinculo(deps, vinculo, docId).create({ ...vinculo.doc });
    return criado;
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    return adotar(deps, vinculo, docId);
  }
}

/** Write (or, under Simular, decide) ONE planned link (module header, "One link"). */
export async function vincularProdutoLi(
  deps: DepsVinculosLi,
  vinculo: VinculoPlanejadoLi,
): Promise<ResultadoDoVinculoLi> {
  for (let tentativa = 0; tentativa < MAX_TENTATIVAS_VINCULO_LI; tentativa += 1) {
    const t = await tentar(deps, vinculo);
    if (t.tipo === 'fim') return { vinculo, desfecho: t.desfecho, gravado: t.gravado };
  }
  return {
    vinculo,
    desfecho: {
      tipo: DESFECHO_DO_VINCULO_LI.recusado,
      codigo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita,
      referencias: [vinculo.produtoId],
    },
    gravado: false,
  };
}

/* -------------------------------------------------------------------------- */
/*                                  A family                                   */
/* -------------------------------------------------------------------------- */

/**
 * Write (or decide) a family's planned links (module header, "A family"): the root's first, the
 * variations' only beside its confirmed link.
 */
export async function vincularFamiliaLi(
  deps: DepsVinculosLi,
  plano: Pick<PlanoDaFamiliaLi, 'raizVinculo' | 'filhosVinculos'>,
): Promise<ResultadoDosVinculosLi> {
  if (plano.raizVinculo === null) return { raiz: null, filhos: [] };
  const raiz = await vincularProdutoLi(deps, plano.raizVinculo);
  if (!vinculoConfirmadoLi(raiz.desfecho)) {
    return {
      raiz,
      filhos: plano.filhosVinculos.map((vinculo) => ({
        vinculo,
        desfecho: {
          tipo: DESFECHO_DO_VINCULO_LI.recusado,
          codigo: PENDENCIA_IMPORTACAO_LI.vinculoPaiAusente,
          referencias: [],
        },
        gravado: false,
      })),
    };
  }
  const filhos: ResultadoDoVinculoLi[] = [];
  for (const vinculo of plano.filhosVinculos) filhos.push(await vincularProdutoLi(deps, vinculo));
  return { raiz, filhos };
}
