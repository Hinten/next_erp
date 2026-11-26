/**
 * The price TRIGGER's work (master plan step 13, PR 13-e), for ONE write of an ERP produto
 * `produtos/{produtoId}`: decide, as cheaply as possible, which price send runs the write may need,
 * and enqueue them on the price queue (`filaPrecoLojaIntegrada`). The functions codebase binds it
 * (`functions/src/onPrecoLojaIntegrada.ts`); here every input is injected — the environment, the
 * Firestore handle and the producer LAZILY, the clock, the logger. It is the price queue's first
 * PRODUCER besides the send run's own `deriva` follow-up.
 *
 * It fires on EVERY ERP produto write, every channel's produtos included, so the gates run from
 * the cheapest up and each returns as early as it can:
 *
 *  1. **Relevance, from the payload alone** (`relevanciaPrecoLi.ts`): ZERO reads, and no line. A
 *     create, a delete, and an update that moves no tabela reading, no folded propagation flag and
 *     no parent stop here — the anchor's own array writes, a new counting link, the custo, the
 *     name, the photos, `publicado`, a kit rollup, a mirror field, float residue, a ghost key.
 *  2. **The valve** `LOJA_INTEGRADA_MODO_PRECO`: `off` — unset, blank, a typo — returns with zero
 *     reads. An UNRECOGNISED value logs ONE WARNING run-start line per instance (latched: a line per
 *     relevant produto write ERP-wide would be noise). `dry-run` and `on` go on alike: the trigger
 *     reads no canary list and no read switch — those are the send run's.
 *  3. **The anchor** (`mapaTabelasLi.ts`): the contas the produto's `integracoesComProduto` lists,
 *     before ∪ after, from the payload — still zero reads. None ⇒ return.
 *  4. **The conta map** (`mapaTabelasLi.ts`): the anchor ∩ the cached map of ACTIVE contas that
 *     name a normal tabela — zero reads on a warm instance, one query per 15 min on a cold one. No
 *     conta concerned ⇒ return (a conta with no normal tabela, or inactive, is inert).
 *  5. **A child** (`paiDoProdutoErp` names a parent on either side):
 *     - the PARENT moved ⇒ ONE task per concerned conta, `baixar: false`, zero reads. It wins over
 *       a price that moved in the same write: a structural move never lowers a price;
 *     - otherwise, only the contas one of whose own tabelas moved go on, and for them ONE masked
 *       read of the parent ({@link CAMPOS_PAI_GATILHO_PRECO_LI}: its flag and its anchor), shared
 *       by every conta. Per conta: the parent propagates AND its anchor names the conta ⇒ NO task
 *       (under propagation the child's own map never prices it, and the parent's own event owns the
 *       family: this is what removes the duplicates the ERP's propagation echo would cause); it
 *       propagates but its anchor lacks the conta ⇒ ONE task, `baixar: true`; it does not
 *       propagate, or is missing ⇒ ONE task, `baixar: true` (the run holds `pai-ausente`). A
 *       parent id that names no document (`idDocumentoEstoqueLiSchema`) costs no read and counts as
 *       missing; a ref is never built from a raw `paiId`.
 *  6. **A root** (both sides a root: no parent, `''`, a self-parent), per concerned conta: it
 *     affects its children when (the flag is on after AND one of the conta's tabelas moved) OR the
 *     flag flipped, and itself when one of the conta's tabelas moved. If either, ONE family query
 *     (`paiId ==` the root, `integracoesComProduto array-contains` the conta, projected to `paiId`,
 *     `limit` {@link MAX_FILHOS_GATILHO_PRECO_LI} + 1) on the manual stock push's declared index,
 *     built from the SAME constant (`CAMPOS_INDICE_FILHOS_ENVIO_MANUAL_LI`); the per-conta queries
 *     run concurrently. Children found and the children affected ⇒ ONE task each, `baixar: true`;
 *     none found and the root affected ⇒ the root's own task, `baixar: true`; children found and
 *     only the root's own price moved (a non-propagating parent) ⇒ nothing. More than
 *     {@link MAX_FILHOS_GATILHO_PRECO_LI} ⇒ ONE WARNING (`familia-excede-limite`) and only the first
 *     ones, in document-id order: the store's variation cap; the nightly price phase covers the
 *     rest once it ships. A root's own document never counts as its child (a self-parent matches
 *     its own query), and a `''` root is queried by its id, never read at `produtos/''`.
 *
 * `baixar` is `true` exactly when an ERP PRICE decision moved the target (a concerned tabela, or the
 * flag, which switches which map prices the family) and `false` for a structural parent move.
 *
 * ## The enqueues, after EVERY read
 *
 * The clock is read inside the price producer's enqueue helper (`agendadorPreco.ts`), immediately
 * before each enqueue — never the event's time, never a value captured before the reads — so a
 * task's name never meets a task that may already have dispatched. Tasks (deduplicated, sorted by
 * conta then produto) carry ids only — origin `evento`, generation 0, `baixar`, never a tabela id
 * — and go at most {@link CONCORRENCIA_ENFILEIRAMENTO_GATILHO_PRECO_LI} at a time. What a
 * rejection means is the producer's contract: an answered already-exists is success; the closed
 * sweep-only valve is ONE WARNING and the event's remaining enqueues are skipped; a payload the
 * strict schema refuses is ONE WARNING with field names, and only that task is skipped; a transient
 * Cloud Tasks failure (or anything else) is rethrown once its round settled, for Eventarc's retry —
 * a retry inside the window re-meets its names, one in a later window is one more run, never a
 * loss. A conta-map load, a parent read or a family query that throws is rethrown too, with nothing
 * enqueued.
 *
 * ONE INFO line (`… decidido`, ids and counts) for each event that read a parent, ran a family
 * query or enqueued, so the echoes that read the parent and enqueued nothing can be counted; none
 * for an event that stopped at the relevance gate, the valve, the anchor or the map.
 *
 * ## Rule 7
 *
 * The trigger writes NOTHING, so it has no race to lose: its task names are tier 0 (deterministic
 * by window), and each send run re-reads the ERP and the store when it runs. No atomic
 * read-and-write call, so no inventory row.
 *
 * ## What it never does
 *
 * It writes NOTHING to Firestore (so it cannot trigger itself, nor anything else), calls no Loja
 * Integrada endpoint and builds no client, never reads the produto document itself (the payload
 * is the event's), the conta's credential, the canary list or the read switch. Its lines carry ids
 * and counts only, never a price, a tabela id or a value of the environment. It must never name
 * the Admin SDK's multi-document read-and-write call, and never reads the process environment:
 * `deps.ambiente` is the environment, passed in.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { ZodError } from 'zod';
import { produtoCollection } from '@delfrance/data/admin/collections';
import {
  ORIGEM_TAREFA_PRECO_LI,
  idDocumentoEstoqueLiSchema,
  propagaPrecoAosFilhos,
} from '@delfrance/schemas';

import {
  type AmbienteLi,
  FLUXO_LI,
  MODO_LI,
  lerValvula,
  registrarValvulaLi,
} from '../core/valvulas';
import { CAMPOS_INDICE_FILHOS_ENVIO_MANUAL_LI } from '../estoque/envioManualEstoqueLi';
import {
  type AgendadorPrecoLi,
  LiTarefasDesligadasError,
  type TarefaPrecoSemJanelaLi,
  enfileirarTarefaPrecoLi,
} from './agendadorPreco';
import {
  type ContaDoPrecoLi,
  contasDaAncoraLi,
  contasDoEventoPrecoLi,
  lerMapaTabelasLi,
} from './mapaTabelasLi';
import {
  type DadosProdutoPrecoLi,
  type RelevanciaPrecoLi,
  relevanciaEventoPrecoLi,
  tabelaDaContaMoveuLi,
} from './relevanciaPrecoLi';

const TAG = '[loja-integrada/preco] gatilho';

/** The parent's fields the child path reads — its flag and its anchor; nothing else. */
export const CAMPOS_PAI_GATILHO_PRECO_LI = [
  'propagatePriceToChildren',
  'integracoesComProduto',
] as const;

/** The most children one family query enqueues per conta (the store's variation cap). */
export const MAX_FILHOS_GATILHO_PRECO_LI = 50;

/** What the family query projects: the key alone would do; `paiId` is the one field it filters on. */
export const CAMPOS_FILHO_GATILHO_PRECO_LI = ['paiId'] as const;

/** Send tasks one event enqueues at a time (the stock trigger's 8). */
export const CONCORRENCIA_ENFILEIRAMENTO_GATILHO_PRECO_LI = 8;

/** Everything one event needs — injected, so a test drives every gate with doubles. */
export interface DepsGatilhoPrecoLi {
  /** The process environment: the valve is read from it. */
  readonly ambiente: AmbienteLi;
  /** Resolved LAZILY: an event that stops before the conta map never builds the handle. */
  readonly db: () => Firestore;
  /** Built only when there is something to enqueue — the sweep-only valve is read at construction. */
  readonly agendador: () => AgendadorPrecoLi;
  /** The clock, read only inside the enqueue helper. */
  readonly agoraMs: () => number;
  readonly logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
}

/** One ERP produto write, as the trigger received it. */
export interface EventoPrecoLi {
  readonly produtoId: string;
  /** The produto's data before the write; `null` on a create. */
  readonly antes: DadosProdutoPrecoLi | null;
  /** The produto's data after the write; `null` on a delete. */
  readonly depois: DadosProdutoPrecoLi | null;
}

/** How one event ended — for tests and the caller; the lines are written here. */
export type ResultadoGatilhoPrecoLi =
  /** A create, a delete, or nothing price-deciding moved: zero reads, no line. */
  | { readonly tipo: 'irrelevante' }
  /** The valve is `off`: zero reads. */
  | { readonly tipo: 'desligado' }
  /** No concerned conta: zero reads (an empty anchor), or the cached map only. */
  | { readonly tipo: 'fora-do-li' }
  | {
      readonly tipo: 'processado';
      readonly caminho: 'filho' | 'raiz';
      /** The concerned contas, sorted. */
      readonly contas: readonly string[];
      readonly leiturasDoPai: 0 | 1;
      /** Family queries. */
      readonly consultas: number;
      /** Tasks accepted (an answered already-exists included). */
      readonly tarefas: number;
      /** Tasks the strict schema refused (one WARNING each). */
      readonly recusadas: number;
      /** Families with more linked children than one query enqueues (one WARNING each). */
      readonly familiasAcimaDoLimite: number;
      /** The sweep-only valve was closed: the rest of the event was not enqueued. */
      readonly tarefasDesligadas: boolean;
    };

/**
 * ONE WARNING per instance for an unrecognised valve (module header, the valve): latched here,
 * because the trigger sees every relevant ERP produto write. A changed value means a redeploy,
 * which starts new instances.
 */
let valvulaNaoReconhecidaRegistrada = false;

/** Test-only: forget the valve's latch. */
export function __reiniciarGatilhoPrecoParaTestes(): void {
  valvulaNaoReconhecidaRegistrada = false;
}

/** What the child path reads of the parent: whether it propagates, and the contas it is anchored to. */
export interface PaiDoGatilhoPrecoLi {
  readonly propaga: boolean;
  readonly contas: ReadonlySet<string>;
}

/**
 * ONE masked `getAll` of the parent (module header, the child path): its folded flag and the
 * STRING elements of its own anchor; `null` when the document does not exist. The caller has
 * already checked that `paiId` names a document.
 */
export async function lerPaiDoGatilhoPrecoLi(
  db: Firestore,
  paiId: string,
): Promise<PaiDoGatilhoPrecoLi | null> {
  const [snap] = await db.getAll(produtoCollection.docRef(db, {}, paiId), {
    fieldMask: [...CAMPOS_PAI_GATILHO_PRECO_LI],
  });
  if (snap === undefined || !snap.exists) return null;
  const dados: Readonly<Record<string, unknown>> = snap.data() ?? {};
  return {
    propaga: propagaPrecoAosFilhos(
      Object.hasOwn(dados, 'propagatePriceToChildren') ? dados.propagatePriceToChildren : undefined,
    ),
    contas: new Set(contasDaAncoraLi(dados, null)),
  };
}

/**
 * ONE family query for one conta (module header, the root path): the ids of the root's children
 * whose anchor names it, in the answer's order (document id order: the query has no `orderBy`),
 * the root's OWN id removed (a self-parent root matches its own query). At most
 * {@link MAX_FILHOS_GATILHO_PRECO_LI} + 1 documents, projected to `paiId`, on the manual stock
 * push's declared index — the SAME constant, pinned against `firestore.indexes.json`. No new index.
 */
export async function lerFilhosDaRaizPrecoLi(
  db: Firestore,
  raizId: string,
  contaId: string,
): Promise<readonly string[]> {
  const [campoPai, campoContas] = CAMPOS_INDICE_FILHOS_ENVIO_MANUAL_LI;
  const snap = await produtoCollection
    .ref(db, {})
    .where(campoPai, '==', raizId)
    .where(campoContas, 'array-contains', contaId)
    .select(...CAMPOS_FILHO_GATILHO_PRECO_LI)
    .limit(MAX_FILHOS_GATILHO_PRECO_LI + 1)
    .get();
  return snap.docs.map((d) => d.id).filter((id) => id !== raizId);
}

/** What one path decided, before any enqueue. */
interface DecisaoGatilhoPrecoLi {
  readonly leiturasDoPai: 0 | 1;
  readonly consultas: number;
  readonly familiasAcimaDoLimite: number;
  readonly tarefas: readonly TarefaPrecoSemJanelaLi[];
}

type Relevante = Extract<RelevanciaPrecoLi, { readonly relevante: true }>;

/** One `evento` send task: ids only (a non-bulk origin carries no tabela id). */
function tarefaDoEvento(
  contaId: string,
  produtoId: string,
  baixar: boolean,
): TarefaPrecoSemJanelaLi {
  return {
    contaId,
    produtoId,
    origem: ORIGEM_TAREFA_PRECO_LI.evento,
    geracao: 0,
    baixar,
  };
}

/** The child path (module header, step 5). */
async function decidirFilho(
  db: Firestore,
  ev: EventoPrecoLi,
  r: Relevante,
  contas: readonly ContaDoPrecoLi[],
): Promise<DecisaoGatilhoPrecoLi> {
  if (r.paiMudou) {
    return {
      leiturasDoPai: 0,
      consultas: 0,
      familiasAcimaDoLimite: 0,
      tarefas: contas.map((c) => tarefaDoEvento(c.contaId, ev.produtoId, false)),
    };
  }
  const movem = contas.filter((c) => tabelaDaContaMoveuLi(r.tabelasMovidas, c));
  if (movem.length === 0) {
    return { leiturasDoPai: 0, consultas: 0, familiasAcimaDoLimite: 0, tarefas: [] };
  }
  // The parent did not move, so both sides name the same one.
  const paiId = r.paiDepois;
  const legivel = paiId !== null && idDocumentoEstoqueLiSchema.safeParse(paiId).success;
  const pai = legivel ? await lerPaiDoGatilhoPrecoLi(db, paiId) : null;
  return {
    leiturasDoPai: legivel ? 1 : 0,
    consultas: 0,
    familiasAcimaDoLimite: 0,
    tarefas: movem
      .filter((c) => !(pai !== null && pai.propaga && pai.contas.has(c.contaId)))
      .map((c) => tarefaDoEvento(c.contaId, ev.produtoId, true)),
  };
}

/** The root path (module header, step 6). */
async function decidirRaiz(
  deps: DepsGatilhoPrecoLi,
  db: Firestore,
  ev: EventoPrecoLi,
  r: Relevante,
  contas: readonly ContaDoPrecoLi[],
): Promise<DecisaoGatilhoPrecoLi> {
  const alvos = contas
    .map((conta) => {
      const tabelaMoveu = tabelaDaContaMoveuLi(r.tabelasMovidas, conta);
      return {
        conta,
        afetaFilhos: (r.propagaDepois && tabelaMoveu) || r.flagMudou,
        afetaRaiz: tabelaMoveu,
      };
    })
    .filter((a) => a.afetaFilhos || a.afetaRaiz);
  const respostas = await Promise.all(
    alvos.map(async (a) => ({
      ...a,
      filhos: await lerFilhosDaRaizPrecoLi(db, ev.produtoId, a.conta.contaId),
    })),
  );
  let familiasAcimaDoLimite = 0;
  const tarefas: TarefaPrecoSemJanelaLi[] = [];
  for (const { conta, afetaFilhos, afetaRaiz, filhos: lidos } of respostas) {
    let filhos = lidos;
    if (filhos.length > MAX_FILHOS_GATILHO_PRECO_LI) {
      familiasAcimaDoLimite += 1;
      deps.logger.warn(`${TAG} família acima do limite — só os primeiros enfileirados`, {
        produtoId: ev.produtoId,
        contaId: conta.contaId,
        limite: MAX_FILHOS_GATILHO_PRECO_LI,
        motivo: 'familia-excede-limite',
      });
      filhos = filhos.slice(0, MAX_FILHOS_GATILHO_PRECO_LI);
    }
    if (filhos.length > 0) {
      if (afetaFilhos) {
        for (const filho of filhos) tarefas.push(tarefaDoEvento(conta.contaId, filho, true));
      }
    } else if (afetaRaiz) {
      tarefas.push(tarefaDoEvento(conta.contaId, ev.produtoId, true));
    }
  }
  return { leiturasDoPai: 0, consultas: alvos.length, familiasAcimaDoLimite, tarefas };
}

/** The tasks deduplicated by `(conta, produto, baixar)` and sorted by conta, then produto. */
function tarefasOrdenadas(tarefas: readonly TarefaPrecoSemJanelaLi[]): TarefaPrecoSemJanelaLi[] {
  const porChave = new Map<string, TarefaPrecoSemJanelaLi>();
  for (const t of tarefas) porChave.set(JSON.stringify([t.contaId, t.produtoId, t.baixar]), t);
  const comparar = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...porChave.values()].sort(
    (a, b) =>
      comparar(a.contaId, b.contaId) ||
      comparar(a.produtoId, b.produtoId) ||
      Number(a.baixar) - Number(b.baixar),
  );
}

/** The field names a strict parse refused, deduplicated and sorted — never a value. */
function camposDoZod(err: ZodError): string[] {
  return [...new Set(err.issues.map((i) => String(i.path[0] ?? '')))].sort();
}

/**
 * The price trigger's work for ONE produto write (module header). Never throws for an event that
 * is not ours; rethrows what Eventarc must retry.
 */
export async function tratarEventoPrecoLi(
  deps: DepsGatilhoPrecoLi,
  ev: EventoPrecoLi,
): Promise<ResultadoGatilhoPrecoLi> {
  // ---- The relevance gate: the payload alone. Zero reads, no line. ----
  const relevancia = relevanciaEventoPrecoLi(ev);
  if (!relevancia.relevante) return { tipo: 'irrelevante' };

  // ---- The valve. Zero reads. ----
  const valvula = lerValvula(FLUXO_LI.preco, deps.ambiente);
  if (valvula.modo === MODO_LI.off) {
    if (!valvula.modoReconhecido && !valvulaNaoReconhecidaRegistrada) {
      valvulaNaoReconhecidaRegistrada = true;
      registrarValvulaLi(valvula, { conta: null });
    }
    return { tipo: 'desligado' };
  }

  // ---- The anchor, from the payload. Still zero reads. ----
  const ancora = contasDaAncoraLi(ev.antes, ev.depois);
  if (ancora.length === 0) return { tipo: 'fora-do-li' };

  // ---- The conta map, cached. ----
  const db = deps.db();
  const contas = contasDoEventoPrecoLi(await lerMapaTabelasLi(db), ancora);
  if (contas.length === 0) return { tipo: 'fora-do-li' };
  const contaIds = contas.map((c) => c.contaId);

  // ---- A child, or a root: every read happens here, before any enqueue. ----
  const caminho: 'filho' | 'raiz' =
    relevancia.paiAntes !== null || relevancia.paiDepois !== null ? 'filho' : 'raiz';
  const decisao =
    caminho === 'filho'
      ? await decidirFilho(db, ev, relevancia, contas)
      : await decidirRaiz(deps, db, ev, relevancia, contas);

  const resultado = {
    tipo: 'processado' as const,
    caminho,
    contas: contaIds,
    leiturasDoPai: decisao.leiturasDoPai,
    consultas: decisao.consultas,
    tarefas: 0,
    recusadas: 0,
    familiasAcimaDoLimite: decisao.familiasAcimaDoLimite,
    tarefasDesligadas: false,
  };

  // ---- The enqueues, after every read. ----
  const envios = tarefasOrdenadas(decisao.tarefas);
  if (envios.length > 0) {
    const agendador = deps.agendador();
    for (let i = 0; i < envios.length; i += CONCORRENCIA_ENFILEIRAMENTO_GATILHO_PRECO_LI) {
      const rodada = envios.slice(i, i + CONCORRENCIA_ENFILEIRAMENTO_GATILHO_PRECO_LI);
      const desfechos = await Promise.allSettled(
        rodada.map((tarefa) => enfileirarUm(deps, agendador, tarefa, ev.produtoId)),
      );
      // The sweep-only valve is read once, at the producer's construction: closed for one
      // enqueue, closed for all of them. One WARNING, and the event ends here.
      if (
        desfechos.some(
          (d) => d.status === 'rejected' && d.reason instanceof LiTarefasDesligadasError,
        )
      ) {
        deps.logger.warn(`${TAG} tarefas desligadas — o resto do evento não foi enfileirado`, {
          produtoId: ev.produtoId,
          caminho,
          contas: contaIds,
          tarefas: resultado.tarefas,
          recusadas: resultado.recusadas,
        });
        return { ...resultado, tarefasDesligadas: true };
      }
      for (const d of desfechos) {
        if (d.status !== 'fulfilled') continue;
        if (d.value) resultado.tarefas += 1;
        else resultado.recusadas += 1;
      }
      // A transient Cloud Tasks failure, or anything else: rethrown as thrown, once the round's
      // other enqueues settled.
      const falha = desfechos.find((d) => d.status === 'rejected');
      if (falha !== undefined) throw falha.reason;
    }
  }

  if (resultado.leiturasDoPai + resultado.consultas + resultado.tarefas > 0) {
    deps.logger.info(`${TAG} decidido`, {
      produtoId: ev.produtoId,
      caminho,
      contas: contaIds,
      leiturasDoPai: resultado.leiturasDoPai,
      consultas: resultado.consultas,
      tarefas: resultado.tarefas,
      recusadas: resultado.recusadas,
    });
  }
  return resultado;
}

/**
 * ONE enqueue: `true` when accepted (an answered already-exists included), `false` when the
 * strict schema refused its payload (ONE WARNING, field names only). Any other rejection is the
 * caller's.
 */
async function enfileirarUm(
  deps: DepsGatilhoPrecoLi,
  agendador: AgendadorPrecoLi,
  tarefa: TarefaPrecoSemJanelaLi,
  produtoId: string,
): Promise<boolean> {
  try {
    await enfileirarTarefaPrecoLi(agendador, deps.agoraMs, tarefa);
    return true;
  } catch (err) {
    if (!(err instanceof ZodError)) throw err;
    deps.logger.warn(`${TAG} tarefa fora do formato da fila de preço — não enfileirada`, {
      produtoId,
      alvoId: tarefa.produtoId,
      contaId: tarefa.contaId,
      campos: camposDoZod(err),
    });
    return false;
  }
}
