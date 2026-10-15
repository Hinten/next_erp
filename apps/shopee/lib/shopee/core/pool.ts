/**
 * The bounded pool — at most `largura` calls in flight over one list, every item
 * run, every worker awaited.
 *
 * It was `estoque/enviarEstoqueManual.ts`'s private code until step 13's price
 * push (#1521) needed exactly the same loop. Promoted for step 13's price push
 * (register 100) verbatim rather than copied: two folders fanning out over "the
 * produtos an operator picked" through two spellings is the drift shape the root
 * `CLAUDE.md` names — one of them gains a clause, both keep their comments, and
 * the pair reads as agreeing while one of them has quietly gone back to
 * `Promise.all`.
 *
 * Pure orchestration: no clock, no Firestore, no Shopee. The width is the
 * CALLER's decision (each folder clamps its own knob to the queue it shares a
 * rate limit with); this module only honours it.
 */

/**
 * The bounded pool.
 *
 * Every worker pulls the next index off ONE shared cursor, so the items START in
 * list order across however many workers there are, and no item runs twice. A
 * worker whose call rejects stops pulling; its siblings keep draining the
 * cursor. A width below 1 is floored to 1 (a `0` would otherwise deadlock), and
 * never more workers are started than there are items.
 *
 * ⚠️ **`allSettled`, never `all`.** `Promise.all` settles on the FIRST
 * rejection while every sibling worker keeps pulling off the shared cursor, so
 * a throw would let the run answer its caller — the route has already built and
 * flushed its error body by then — while later listings were still calling
 * `update_stock` and patching link documents, in a response that reports
 * neither. Waiting for all of them costs nothing, because the one caller that
 * throws sets its abort flag first and every remaining iteration
 * short-circuits. The first rejection, in WORKER order, is then rethrown
 * unchanged.
 */
export async function executarEmPool<T>(
  itens: readonly T[],
  largura: number,
  executar: (item: T, indice: number) => Promise<void>,
): Promise<void> {
  let proximo = 0;
  const trabalhador = async (): Promise<void> => {
    for (;;) {
      const indice = proximo;
      proximo += 1;
      const item = itens[indice];
      if (item === undefined) return;
      await executar(item, indice);
    }
  };
  const trabalhadores = Math.min(Math.max(1, largura), Math.max(1, itens.length));
  const saidas = await Promise.allSettled(
    Array.from({ length: trabalhadores }, () => trabalhador()),
  );
  for (const saida of saidas) {
    if (saida.status === 'rejected') throw saida.reason;
  }
}
