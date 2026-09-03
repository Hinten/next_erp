/**
 * Fixed-size worker pool — the bounded fan-out every hand-picked bulk operation
 * on this channel uses to reach ML.
 *
 * Three callers (`estoque/estoqueManual.ts`, `preco/precoManual.ts`,
 * `anuncios/anuncioStatus.ts`), so it sits in `core/` rather than in whichever
 * one happened to need it first. Unbounded `Promise.all` over an operator's
 * selection is what this exists to prevent: ML rate-limits per application, and
 * a 50-produto family fan-out is easily hundreds of requests.
 */

/** Runs `worker` over `items` with at most `size` in flight. No ordering guarantee. */
export async function runPool<T>(
  items: readonly T[],
  size: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]!);
    }
  });
  await Promise.all(workers);
}
