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
 *      stored value as the link schema's own field reads it (its default for an absent one), or
 *      when that field REFUSES the stored value (`null`, a string): so a link stored `removido:
 *      true` whose product is listed again becomes `false` and the anchor counts it again, and a
 *      value no reader of the link can parse is repaired, never left beside an equal default;
 *    - every other planned field only where the stored one is `null` or absent
 *      (`paiProdutoIntegradaId` included); a field with a value is never touched,
 *      `estadoPublicacao` included;
 *    - nothing to change ⇒ no write (`sem-mudanca`): a second run over an unchanged store writes
 *      and counts nothing — unless the link is the one THIS job created (below).
 *
 * A lost precondition (9; 5, a document deleted meanwhile, reads the same) or a document that
 * vanished between the 6 and its re-read re-plans the WHOLE link once, from a fresh scan; a second
 * loss ⇒ `conflito-de-escrita`, reported, never forced ({@link MAX_TENTATIVAS_VINCULO_LI}).
 *
 * ## A link this job created — `criado`, `retomado`
 *
 * A create can land and the unit still fail after it: the report item's write, the checkpoint, the
 * instance killed — the task re-runs the family from the old cursor — or the create's own reply
 * lost, whose SDK retry meets our document as `ALREADY_EXISTS`. Either way the attempt now finds
 * this conta's link (the re-run's scan says `proprio`; the 6 adopts it) equal to the plan, which
 * would read `sem-mudanca`: the link counted nowhere, the item saying the family changed nothing.
 * So when the refresh's ONLY document is the one at the store id's doc id, there is nothing to
 * change, and its snapshot's `createTime` is at or after the job document's own `createTime`
 * ({@link DepsVinculosLi.criacaoDoJob}), the outcome is that creation: `criado` with `retomado`,
 * counted and reported as on the first attempt. Both stamps are commit times of the one server
 * clock (never the App Hosting clock `iniciadoEmMs` was read from, which skews against it and is
 * stamped BEFORE the job's commit), both read on snapshots this module and the dispatch already
 * take: no read is added. The start guard allows one running import per conta and links are per
 * conta, so a link of this conta born after the job's start is this job's — up to the residuals
 * below. A link created BEFORE the job started stays `sem-mudanca` (a second job counts nothing);
 * Simular, which creates nothing, never reads one as its own.
 *
 * ⚠️ Accepted residuals of "born after the start ⇒ ours":
 *  - two jobs of one conta running at once — the start guard is a query, then a create, so two
 *    starts in the same instant both pass it — each counts the links the other created after its
 *    own start;
 *  - a link of this conta created at the store id's doc id during the run by ANOTHER writer (a
 *    person, a later publisher, the in-flight unit of a job cancelled just before this one
 *    started) and equal to the plan is counted as this job's creation;
 *  - a link this job created that another writer then CHANGED is refreshed as usual
 *    (`atualizado`): its creation is counted nowhere;
 *  - a refresh of TWO documents (ours, plus an auto-id link of this conta another writer added —
 *    row 11's residual) is never read as a creation, whatever the documents' order (decided once,
 *    after the loop);
 *  - a MIRROR REFRESH this job landed reads `sem-mudanca` on a retried unit: `semMudanca + 1`, its
 *    informational `vinculo-atualizado` lost; `vinculados` unaffected. The refresh's `update` lands,
 *    then the item write or the checkpoint fails (or the instance dies), and the retry finds the
 *    link already equal to the plan. Its `updateTime` after the job's start cannot tell our refresh
 *    from another writer's, nor say which fields it changed. Closing it needs a job-owned tier-0
 *    record of each planned refresh's `campos`, written BEFORE the link writes (a write per refreshed
 *    link); pinned as it stands in `familiaDoJob.test.ts`.
 *
 * ⚠️ Accepted residual (the plan's row 11): a link of this conta written at an AUTO id by another
 * writer between our scan and our create leaves two links of one conta on the produto; the next
 * scan sees it, and publishing refuses a produto with two links of one conta.
 *
 * ⚠️ Accepted residual of Simular's parity: TWO store roots of one job that the cascade places on
 * the SAME ERP produto (one by its root SKU, the other through the sole-member hop, say). Under
 * `aplicar` the first creates its link and the second's scan finds it — `vinculado-a-outro`.
 * Under Simular nothing is written, so the second's scan finds nothing and both items say
 * `vincular`: picking the second in "Importar selecionados" then meets the refusal at `aplicar`
 * time, and nothing is written for it. Closing it needs an overlay of the links a Simular would
 * create, kept across dispatches; it would cost a read and a write per planned link of every
 * Simular to cover a store whose two products map to one ERP produto.
 *
 * ## A family ({@link vincularFamiliaLi})
 *
 * The root's link first. Only when it is CONFIRMED — created, refreshed, or already as the store
 * says (under Simular: would be) — are the variations' links written, one after another, each
 * judged by the same "a link this job created" rule as the root's; a root
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
import type { DocumentSnapshot, Timestamp } from 'firebase-admin/firestore';
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
  produtoLojaIntegradaLinkSchema,
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
  /**
   * The job document's own `createTime` (module header, "A link this job created"): a link of this
   * conta created at or after it was created by this job, up to the stated residuals.
   */
  readonly criacaoDoJob: Timestamp;
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
  /**
   * Created at the store id's doc id — by this attempt, or (`retomado`) by an earlier attempt of
   * this job whose create landed: a retried unit, or a reply lost (module header).
   */
  | { readonly tipo: 'criado'; readonly docId: string; readonly retomado?: true }
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
  /**
   * A write of this job landed for it (`aplicar` only; always `false` under Simular and for a
   * refusal): `true` for a `retomado` creation too, whose create landed in an earlier attempt.
   */
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

/**
 * A stored mirror field read by the LINK SCHEMA's own field (its `.default()` for an absent one),
 * never a copy of its defaults here; `null` when the schema refuses the stored value (`null`, a
 * string, a number): there is no value to compare, so the live one is written over it.
 */
function espelhoArmazenado(
  armazenado: Readonly<Record<string, unknown>>,
  chave: 'ativo' | 'bloqueado' | 'removido',
): boolean | null {
  const bruto = Object.hasOwn(armazenado, chave) ? armazenado[chave] : undefined;
  const lido = produtoLojaIntegradaLinkSchema.shape[chave].safeParse(bruto);
  return lido.success ? lido.data : null;
}

/**
 * The refresh patch of ONE stored link (module header): the mirror where it differs from the
 * stored value as the link schema reads it — or where the schema cannot read one —, every other
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
    if (espelhoArmazenado(armazenado, chave) !== vivo) patch[chave] = vivo;
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
 * Whether a link document read in this attempt was created by THIS job (module header, "A link
 * this job created"): its own `createTime` at or after the job document's — two commit stamps of
 * the one server clock, compared to the nanosecond through the SDK's own ordering primitive
 * (`Timestamp.valueOf()`: a fixed-width `<seconds>.<nanoseconds>` text whose lexicographic order is
 * the stamps' order). Nothing is converted. Never under Simular, which creates nothing.
 */
function criadoPorEsteJob(deps: DepsVinculosLi, snap: DocumentSnapshot): boolean {
  if (deps.modo === MODO_IMPORTACAO_LI.simular) return false;
  const criado = snap.createTime;
  if (criado === undefined) return false;
  return criado.valueOf() >= deps.criacaoDoJob.valueOf();
}

/**
 * Refresh this conta's link documents `docIds` (module header): each read, re-judged, patched on
 * its own read. A document that is no longer this conta's link for the store id, or a lost write,
 * loses the attempt. A refresh whose ONLY document is the one at the store id's doc id, created
 * by this job and with nothing to change, is that creation (`retomado`), not `sem-mudanca`.
 */
async function refrescar(
  deps: DepsVinculosLi,
  vinculo: VinculoPlanejadoLi,
  docIds: readonly string[],
  lidos: ReadonlyMap<string, DocumentSnapshot> = new Map(),
): Promise<Tentativa> {
  const campos = new Set<string>();
  const nossoDocId = String(vinculo.liId);
  let gravado = false;
  /** The snapshot of the document at the store id's doc id, when it is among `docIds`. */
  let nosso: DocumentSnapshot | null = null;
  for (const docId of docIds) {
    const snap = lidos.get(docId) ?? (await refDoVinculo(deps, vinculo, docId).get());
    if (!snap.exists || snap.updateTime === undefined) return PERDEU;
    const dados = dadosDe(snap);
    if (vinculoLiDaContaEId(dados, deps.contaId, vinculo.liId) !== RELACAO_VINCULO_LI.mesmo) {
      return PERDEU;
    }
    if (docId === nossoDocId) nosso = snap;
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
  // Decided once, over the whole refresh, so the documents' order never decides it: only a refresh
  // of ONE document — ours — that changed nothing is a creation (module header: a refresh of TWO
  // documents is never one).
  const retomado =
    campos.size === 0 && docIds.length === 1 && nosso !== null && criadoPorEsteJob(deps, nosso);
  if (retomado) {
    return {
      tipo: 'fim',
      desfecho: { tipo: DESFECHO_DO_VINCULO_LI.criado, docId: nossoDocId, retomado: true },
      gravado: true,
    };
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
