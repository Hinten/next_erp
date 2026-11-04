/**
 * The WRITE-FREE prefix of the manual stock push — resolve, read, plan — and the
 * ONE place it is written (#1529, step 21; review of PR #1948).
 *
 * Two callers, and the second one is the reason this module exists:
 *
 *  - `enviarEstoqueManual.ts` — the `enviar-estoque` route and
 *    `enviar:estoque --live` — sends the tasks this plan returns;
 *  - the `enviar:estoque` DRY RUN (`scripts/enviar-estoque.ts`) renders them
 *    through `enviarEstoqueCli.ts` and sends nothing.
 *
 * ⚠️ **Why one copy, and the failure it closes.** The dry run used to keep its
 * own prefix: it read each id's name by hand and handed the ids AS TYPED to
 * {@link buscarFamiliasShopeePorIds}, while `--live` resolved each one to its
 * family anchor first. A variation child was therefore planned as its OWN
 * anchor in the dry run — its own conta denorm, its own (absent) listing links,
 * so the planner answered `conta-fora-do-produto` and the rehearsal printed
 * "nothing would be sent" — and `--live` then pushed the WHOLE family's stock
 * through the anchor's listing. The divergence ran in the direction that writes,
 * and a rehearsal that previews something other than the write is worse than
 * none. Both modes now call {@link planejarEnvioEstoqueShopee}, so the dry run
 * renders exactly the tasks `--live` would hand to the sender.
 *
 * What it decides, per requested id, is what the live path decides:
 *
 *  - the anchor it resolves to, ONCE ({@link resolverAnchorsShopee}: one masked
 *    batch key read, plus a masked `nome` read for an anchor nobody requested);
 *  - the family row, read over the DEDUPED ANCHORS — never over the ids as
 *    typed — so a child and its own anchor are ONE family;
 *  - per anchor, the planner's answer ({@link montarTarefasDeEstoqueShopee}) with
 *    the manual push's options (force-send, `sweepId` `manual-…`, the request's
 *    one logical instant);
 *  - or the "no listing at all" verdict, reported under each REQUESTED id that
 *    resolved there: `produto-nao-encontrado` (no produto document, or a `paiId`
 *    naming a missing one) and the planner's own `conta-fora-do-produto` /
 *    `sem-link` ({@link MOTIVOS_SEM_LISTAGEM}).
 *
 * ⚠️ **Write-free by construction, not by promise.** No sender, no scheduler,
 * no link writer and no Shopee client is imported here: the dry run loads this
 * module and must not be able to reach `update_stock` even by accident.
 * `planejarEnvioEstoque.test.ts` reads this file as text and fails on any such
 * import. No clock either — `nowMs` is a parameter, this folder's discipline.
 *
 * What stays in the CALLERS: the size cap and the depósito guard (each surface
 * refuses those before any read, with its own error), the sends, the deadline,
 * the pause, and the accounting check over the rows actually produced
 * (`conferirContabilidadePorAnchor`, in the live path).
 */
import type { Firestore } from 'firebase-admin/firestore';

import { resolverAnchorsShopee } from '../core/anchors';
import { buscarFamiliasShopeePorIds, type BuscarFamiliasShopeePorIds } from './descobertaEstoque';
import {
  MENSAGEM_POR_MOTIVO,
  MOTIVO_ESTOQUE_SHOPEE,
  type MotivoEstoqueShopee,
} from './errosEstoque';
import {
  montarTarefasDeEstoqueShopee,
  type LinhaDeFamiliaShopee,
  type ResultadoDoPlanoShopee,
} from './planoEstoque';
import { quantidadesDaFamiliaShopee } from './quantidadeEstoque';

/* -------------------------------------------------------------------------- */
/*                                  the shapes                                 */
/* -------------------------------------------------------------------------- */

/**
 * A requested produto that produced no listing at all, and why — one row of the
 * manual envelope's `produtosSemEnvio`.
 *
 * Declared HERE, where it is built, and re-exported by `enviarEstoqueManual.ts`
 * for the envelope: one declaration, so the dry run and the route can never
 * carry two shapes of the same row.
 */
export interface EnvioEstoqueSemEnvio {
  /** The REQUESTED id, verbatim — a child whose anchor has no listing stays a child here. */
  readonly produtoId: string;
  readonly produtoNome: string | null;
  readonly motivo: string;
  readonly mensagem: string;
}

/** The verdict for a family that reaches no listing, applied to every id that resolved to it. */
export interface VereditoSemListagem {
  readonly motivo: MotivoEstoqueShopee;
  /** RENDERED pt-BR — the planner's sentence, or `MENSAGEM_POR_MOTIVO`'s. Never re-worded. */
  readonly mensagem: string;
}

/** One family anchor of the request, and everything the plan decided for it. */
export interface FamiliaPlanejada {
  readonly anchorId: string;
  /** The ANCHOR's own name — what its listing rows carry, even when only a child was requested. */
  readonly anchorNome: string | null;
  /** The REQUESTED ids that resolved here, in request order (the anchor among them if requested). */
  readonly pedidos: readonly string[];
  /** The row discovery returned; `null` when the anchor document does not exist. */
  readonly row: LinhaDeFamiliaShopee | null;
  /** The planner's answer; `null` exactly when {@link row} is. */
  readonly plano: ResultadoDoPlanoShopee | null;
  /**
   * Non-null when this family reaches NO listing: `produto-nao-encontrado` for a
   * missing row, else the planner's first line when every line is one of
   * {@link MOTIVOS_SEM_LISTAGEM} and no task was planned. Then the family emits
   * no listing row at all and each of its {@link pedidos} leaves through
   * `produtosSemEnvio` instead.
   */
  readonly semListagem: VereditoSemListagem | null;
}

export interface PlanejamentoEnvioEstoqueShopee {
  /** The DEDUPED request, in first-seen order. */
  readonly solicitados: readonly string[];
  /** Requested id → its anchor. A requested id with no document is absent. */
  readonly anchorDe: ReadonlyMap<string, string>;
  /** Id → stored `nome` (null when unusable), for every requested id AND every anchor reached. */
  readonly nomeDe: ReadonlyMap<string, string | null>;
  /** Requested ids with no produto document, in request order. */
  readonly naoEncontrados: readonly string[];
  /** One entry per anchor, in first-seen request order. */
  readonly familias: readonly FamiliaPlanejada[];
  /** How many family rows discovery returned — the envelope's `familias`. */
  readonly familiasLidas: number;
  /** Every requested id that reaches no listing, in REQUEST order — the envelope's list, verbatim. */
  readonly produtosSemEnvio: readonly EnvioEstoqueSemEnvio[];
}

export interface ArgsPlanejamentoEnvioEstoque {
  readonly integracaoId: string;
  /** The depósito doc id — derived and GUARDED by the caller, before any read. */
  readonly depositoId: string;
  /** The ids as the operator picked them — anchors or variation children. Deduped here. */
  readonly produtoIds: readonly string[];
  /** The route's and the CLI's `reenviarComErro`: bypasses the per-link skip set only. */
  readonly reenviarComErro: boolean;
}

export interface DepsPlanejamentoEnvioEstoque {
  /** MILLISECONDS — the request's ONE logical instant, stamped on every task. */
  readonly nowMs: number;
  /** Injectable purely so tests never go near the real pipeline. */
  readonly buscarFamilias?: BuscarFamiliasShopeePorIds | undefined;
}

/* -------------------------------------------------------------------------- */
/*                                  the rules                                  */
/* -------------------------------------------------------------------------- */

/**
 * The two planner rungs that mean "this produto has no listing on this conta at
 * all". They are the ONLY skips that belong in `produtosSemEnvio` rather than in
 * a listing row, and both return from the planner immediately — so a plan that
 * consists of exactly one of them and no task is the whole family's verdict.
 */
export const MOTIVOS_SEM_LISTAGEM: ReadonlySet<MotivoEstoqueShopee> = new Set<MotivoEstoqueShopee>([
  MOTIVO_ESTOQUE_SHOPEE.contaForaDoProduto,
  MOTIVO_ESTOQUE_SHOPEE.semLink,
]);

const PRODUTO_NAO_ENCONTRADO: VereditoSemListagem = {
  motivo: MOTIVO_ESTOQUE_SHOPEE.produtoNaoEncontrado,
  mensagem: MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.produtoNaoEncontrado],
};

/**
 * The family's "no listing" verdict, or `null` when its plan has rows to emit.
 *
 * ⚠️ The motivo and the sentence are the PLANNER's, never re-derived here.
 */
function vereditoSemListagem(plano: ResultadoDoPlanoShopee): VereditoSemListagem | null {
  const semListagem =
    plano.tarefas.length === 0 &&
    plano.pulos.length > 0 &&
    plano.pulos.every((p) => MOTIVOS_SEM_LISTAGEM.has(p.motivo));
  const primeiro = plano.pulos[0];
  return semListagem && primeiro !== undefined
    ? { motivo: primeiro.motivo, mensagem: primeiro.mensagem }
    : null;
}

/* -------------------------------------------------------------------------- */
/*                                   the plan                                  */
/* -------------------------------------------------------------------------- */

/**
 * Resolve, read and plan a manual stock push WITHOUT writing anything.
 *
 * An empty selection reads nothing at all (`getAll` with no reference rejects,
 * and the by-ids reader refuses an empty list), and a selection whose every id
 * is missing reads no family either.
 */
export async function planejarEnvioEstoqueShopee(
  db: Firestore,
  args: ArgsPlanejamentoEnvioEstoque,
  deps: DepsPlanejamentoEnvioEstoque,
): Promise<PlanejamentoEnvioEstoqueShopee> {
  const buscarFamilias = deps.buscarFamilias ?? buscarFamiliasShopeePorIds;
  const solicitados = [...new Set(args.produtoIds)];

  // --- each requested id → its family anchor: ONE masked batch read, one hop
  // (plus a masked `nome` read for an anchor nobody requested, for its rows).
  const resolvidos = await resolverAnchorsShopee(db, solicitados);
  const nomeDe = (produtoId: string): string | null => resolvidos.nomeDe.get(produtoId) ?? null;
  const pedidosDoAnchor = (anchorId: string): string[] =>
    solicitados.filter((id) => resolvidos.anchorDe.get(id) === anchorId);

  // Filled per anchor, emitted in REQUEST order below.
  const semEnvioPorId = new Map<string, EnvioEstoqueSemEnvio>();
  const semEnvio = (produtoId: string, veredito: VereditoSemListagem): void => {
    semEnvioPorId.set(produtoId, {
      produtoId,
      produtoNome: nomeDe(produtoId),
      motivo: veredito.motivo,
      mensagem: veredito.mensagem,
    });
  };

  for (const produtoId of resolvidos.naoEncontrados) semEnvio(produtoId, PRODUTO_NAO_ENCONTRADO);

  // ⚠️ Over the ANCHORS, never the ids as typed: a child read as its own anchor
  // carries no listing link, and the plan would preview a send that never
  // happens while the real one moves the whole family (module docblock).
  const rows =
    resolvidos.anchorIds.length === 0
      ? []
      : await buscarFamilias(db, {
          integracaoId: args.integracaoId,
          depositoId: args.depositoId,
          produtoIds: resolvidos.anchorIds,
        });
  const rowPorAnchor = new Map(rows.map((r) => [r.anchorId, r]));

  const familias: FamiliaPlanejada[] = [];
  for (const anchorId of resolvidos.anchorIds) {
    const pedidos = pedidosDoAnchor(anchorId);
    // No row: the anchor document does not exist — the requested id itself
    // vanished between the two reads, or a child's `paiId` names a missing
    // produto. Reported under each requested id that resolved here.
    const row = rowPorAnchor.get(anchorId) ?? null;
    const plano =
      row === null
        ? null
        : montarTarefasDeEstoqueShopee(row, quantidadesDaFamiliaShopee(row), {
            integracaoId: args.integracaoId,
            // Deterministic and self-describing in the send handler's own log lines.
            sweepId: `manual-${args.integracaoId}-${String(deps.nowMs)}`,
            // Manual quantities are computed NOW, so the handler reads an age of ~0.
            sweepComputadoEmMs: deps.nowMs,
            nowMs: deps.nowMs,
            ignorarRecusa: args.reenviarComErro,
          });
    const semListagem = plano === null ? PRODUTO_NAO_ENCONTRADO : vereditoSemListagem(plano);
    if (semListagem !== null) {
      // The whole family's verdict, under each requested id that resolved to
      // it (a child stays a child in this list).
      for (const produtoId of pedidos) semEnvio(produtoId, semListagem);
    }
    familias.push({ anchorId, anchorNome: nomeDe(anchorId), pedidos, row, plano, semListagem });
  }

  const produtosSemEnvio: EnvioEstoqueSemEnvio[] = [];
  for (const produtoId of solicitados) {
    const s = semEnvioPorId.get(produtoId);
    if (s !== undefined) produtosSemEnvio.push(s);
  }

  return {
    solicitados,
    anchorDe: resolvidos.anchorDe,
    nomeDe: resolvidos.nomeDe,
    naoEncontrados: resolvidos.naoEncontrados,
    familias,
    familiasLidas: rows.length,
    produtosSemEnvio,
  };
}
