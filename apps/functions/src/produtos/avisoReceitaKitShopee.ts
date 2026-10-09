import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { reavaliarAvisoDeReceitaKit } from '@delfrance/data/admin/avisos';
import {
  integracaoCollection,
  produtoCollection,
  produtoShopeeLinkCollection,
  variacaoShopeeLinkCollection,
} from '@delfrance/data/admin/collections';
import {
  MOTIVO_RESOLUCAO_RECEITA_KIT,
  chaveReceitaKitErp,
  toDocPathOrNull,
} from '@delfrance/schemas';

/**
 * The produto half of the Shopee native-kit recipe aviso (step 19, #1527, L4(2)).
 *
 * Shopee freezes a native kit's composition at create: a later quantity change is
 * answered 200 and silently ignored, and Shopee derives the kit's stock from the
 * frozen recipe. So when an operator edits the ERP recipe of a kit that already
 * sells as a native Shopee kit, the stock Shopee shows may be wrong — and a recipe
 * change never BLOCKS anything (Lucas, L4). What it does is open one aviso per
 * (conta, kit produto) after the save, which resolves itself once the kit is
 * recreated or the recipe comes back to what Shopee holds.
 *
 * ## ⚠️ This file DECIDES NOTHING about the aviso
 *
 * It only finds WHICH (conta, kit) pairs a recipe edit may have touched and hands
 * each one to `reavaliarAvisoDeReceitaKit` (`@delfrance/data/admin/avisos`) — the
 * SAME decision every Shopee-side site runs (the import, the kit create arms, the
 * republish, the reverify). That function re-reads every child of the kit, the
 * kit's link docs of the conta and their model rows in ONE read-only snapshot,
 * opens or resolves the aviso from what is stored NOW, and clocks its write by the
 * newest commit time of every document it read (rule 7 tier 2: an older snapshot
 * landing late is dropped as stale).
 *
 * That is why nothing here reads the event's `after` beyond the gate: a delayed
 * delivery whose produto has since been edited back must RESOLVE, not reopen, and
 * only a decision over the current state can tell. It is also why the trigger
 * holds no rule of its own about which link still sells — `variashopee` rows on a
 * removed kit, an ordinary listing, or a superseded kit are all handed over, and
 * the shared decision filters them (`ehKitNativoQueAindaVende`).
 *
 * ## Cost
 *
 * ZERO reads unless the recipe fingerprint moved ({@link receitaKitMudou} is
 * pure). Then: one re-read of the produto, one unfiltered read of its own
 * `variashopee` rows, and per distinct (conta, kit) pair the shared decision's own
 * reads (the kit's links, its children, their rows).
 */

/**
 * Did this write change the produto's kit recipe, as the aviso decision measures
 * it?
 *
 * Pure. Compares the ERP-side recipe fingerprint of `before` and `after` — the
 * very fingerprint a kit-model `variashopee` row is stamped with when Shopee's
 * live kit read back equal, so the gate and the decision agree on what a "recipe
 * change" is.
 *
 * - **Equal (gate stays closed):** the same components with the same quantities,
 *   whatever the key order, the `limitarEstoque` flags or the per-entry
 *   `timestamp` — so an import-shaped write that re-writes an unchanged recipe
 *   costs nothing; and an absent, `null` or empty map are all "no recipe".
 * - **Distinct (gate opens):** any quantity change, and any component added,
 *   removed or renamed (a #1450 repoint included — the shared decision then
 *   answers it).
 * - **A delete is never a recipe change** (`after === undefined` ⇒ `false`): the
 *   produto's rows go with it. So deleting the child that held the ONLY divergent
 *   row of an open (conta, kit) aviso leaves that aviso open until a later write
 *   re-evaluates the kit — a sibling's recipe edit, a re-import, a republish or a
 *   recriar — the residual the shared decision already accepts for deletions
 *   (R-16: a deletion advances no commit time, so a resolve it alone caused would
 *   not be newer than the open row and would be dropped as stale anyway).
 */
export function receitaKitMudou(
  before: DocumentData | undefined,
  after: DocumentData | undefined,
): boolean {
  if (after === undefined) return false;
  return chaveReceitaKitErp(mapaDe(before)) !== chaveReceitaKitErp(mapaDe(after));
}

/** The stored `componentesKit`, verbatim — the fingerprint is total over any value. */
function mapaDe(doc: DocumentData | undefined): Parameters<typeof chaveReceitaKitErp>[0] {
  return doc?.componentesKit as Parameters<typeof chaveReceitaKitErp>[0];
}

/** One (conta, kit produto) pair the shared decision is asked about. */
interface ParDeAviso {
  readonly integracaoId: string;
  readonly kitProdutoId: string;
}

/**
 * The integração id a stored conta ref names — either stored encoding
 * (`documents/…` or bare), and only when it names an `integracao` document: the
 * shared decision binds a conta by that same full path, so a ref naming any other
 * collection could never match there and is reported here instead. `null`
 * otherwise.
 */
function integracaoIdDaConta(bruto: unknown): string | null {
  const caminho = toDocPathOrNull(bruto);
  if (caminho === null) return null;
  const [colecao, id, ...resto] = caminho.split('/');
  if (resto.length > 0 || id === undefined || id === '') return null;
  return colecao === integracaoCollection.resolvePath({}) ? id : null;
}

/**
 * The produto that OWNS the `prodshopee` link a row names — the kit produto K.
 *
 * A kit-model row lives under the CHILD (the sellable unit), while its link lives
 * under the kit itself, so K is read from the link's path, never from where the
 * row sits. The stored ref may carry either encoding; `toDocPathOrNull` folds both
 * to the bare path, which must then be exactly `<produtos>/<K>/<prodshopee>/<id>`.
 * Anything else is `null` — the canonical `documents/…` form is never split by
 * hand and never handed to `doc()`.
 */
function kitDoVinculo(bruto: unknown): string | null {
  const caminho = toDocPathOrNull(bruto);
  if (caminho === null) return null;
  const segmentos = caminho.split('/');
  if (segmentos.length !== 4) return null;
  const [, dono] = segmentos;
  if (dono === undefined || dono === '') return null;
  const colecao = produtoShopeeLinkCollection.resolvePath({ produtoId: dono });
  return segmentos.slice(0, 3).join('/') === colecao ? dono : null;
}

/**
 * After a produto save: open or resolve the Shopee native-kit recipe aviso of every
 * (conta, kit) the produto's `variashopee` rows name.
 *
 * Wired LAST in `recordProdutoModificationAndPropagate`. Every failure RETHROWS
 * (rule 6) — after every pair has been attempted, so one conta's transient error
 * cannot cost another conta's aviso; nothing below this call is left to lose.
 *
 * @returns `null` when the gate stayed closed (no read at all), else how many
 *   (conta, kit) pairs were handed to the shared decision.
 */
export async function avisarReceitaKitShopee(
  db: Firestore,
  produtoId: string,
  before: DocumentData | undefined,
  after: DocumentData | undefined,
  deps: { readonly agoraUs: number; readonly increment: (by: number) => unknown },
): Promise<{ readonly reavaliados: number } | null> {
  if (!receitaKitMudou(before, after)) return null;

  // The produto as it is NOW — a delivery that outlived its produto has nothing
  // left to evaluate (the delete cascade sweeps its rows).
  const atual = await produtoCollection.docRef(db, {}, produtoId).get();
  if (!atual.exists) return { reavaliados: 0 };

  // UNFILTERED, on purpose: every row the produto holds, of any listing and any
  // conta. Which of them still count is the shared decision's question.
  const linhas = await variacaoShopeeLinkCollection.ref(db, { produtoId }).get();

  const pares = new Map<string, ParDeAviso>();
  for (const linha of linhas.docs) {
    const dados = linha.data();
    const integracaoId = integracaoIdDaConta(dados.contaVariacaoShopeeOuterRef);
    const kitProdutoId = kitDoVinculo(dados.produtoShopeeOuterRef);
    if (integracaoId === null || kitProdutoId === null) {
      logger.warn(
        `avisoReceitaKitShopee: variashopee ${linha.id} de ${produtoId} sem ` +
          `${integracaoId === null ? 'conta' : 'vínculo'} legível — ignorada`,
      );
      continue;
    }
    // Keyed by the PAIR: one aviso per (conta, kit) — two contas are two avisos,
    // and two rows of one kit (an old and a new listing) are one decision.
    pares.set(JSON.stringify([integracaoId, kitProdutoId]), { integracaoId, kitProdutoId });
  }

  const ordenados = [...pares.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, par]) => par);

  const resultados = await Promise.allSettled(
    ordenados.map((par) =>
      reavaliarAvisoDeReceitaKit(db, par, MOTIVO_RESOLUCAO_RECEITA_KIT.receitaIgualAShopee, deps),
    ),
  );

  const falhas: unknown[] = [];
  resultados.forEach((resultado, i) => {
    if (resultado.status !== 'rejected') return;
    const par = ordenados[i];
    falhas.push(resultado.reason as unknown);
    logger.error(
      `avisoReceitaKitShopee: falha ao reavaliar o aviso de receita do kit ` +
        `${par?.kitProdutoId ?? '?'} na conta ${par?.integracaoId ?? '?'} (edição de ${produtoId})`,
    );
  });
  // Rule 6: nothing is swallowed. Every pair was attempted first, so the first
  // failure surfaces only after the others had their chance.
  if (falhas.length > 0) throw falhas[0];

  return { reavaliados: ordenados.length };
}
