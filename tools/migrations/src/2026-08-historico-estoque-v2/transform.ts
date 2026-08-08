/**
 * Pure transform for the `historicoEstoque` v1 → v2 reshape (ADR 0014).
 *
 * v1 stored `quantidade` / `quantidadeReservada` as a **signed delta for a
 * movement but the ABSOLUTE counted value for a balanço**, told apart only by
 * `ehBalanco`. A field whose meaning depends on a discriminator cannot be
 * summed, and summing the ledger is exactly what the Mercado Livre sweep now
 * does to answer "what was the stock at time T".
 *
 * v2 records a real signed delta on every row and adds the join keys the
 * collection never had:
 *
 * | v2 | from v1 |
 * |---|---|
 * | `movimento` / `movimentoReservada` | `quantidade` / `quantidadeReservada`, **except on a balanço** |
 * | `saldo` / `saldoReservada` | `quantidadeDepois` / `quantidadeReservadaDepois` |
 * | `parentId` / `depositoOuterRef` | the document PATH (never stored on the row) |
 *
 * ---- ⚠️ The balanço is the case that cannot be assumed.
 *
 * A balanço's v1 `quantidade` is the counted value, so its delta is
 * `contado − anterior` and `anterior` is only knowable when the row also carries
 * `quantidadeAntes`. The pedido sync always wrote that pair; the read-free
 * manual path never did, and a balanço is exactly what the manual path writes.
 * So for most balanços the delta is **unrecoverable**, and this transform
 * **refuses to invent one**: it writes `movimento: null` and reports a skip.
 *
 * A null reads as *unknown* downstream and fails OPEN (the sweep sends rather
 * than skips), which is the whole reason the v2 readers were written that way.
 * Guessing `contado` as if it were a delta would instead be silently wrong in
 * the one direction nothing can detect.
 *
 * ---- Idempotent: a row already carrying `movimento` is left alone, so a
 * re-run after a partial pass is a no-op on what already converted.
 */

/** A row's classification — what the migration decided and why. */
export type HistoricoV2Verdict =
  /** Already v2 (or already processed) — nothing to write. */
  | { kind: 'ja-migrado' }
  /** Not a stock-history row shape we recognize — left untouched, reported. */
  | { kind: 'sem-dados' }
  /** Converted; `patch` is the field set to merge. */
  | { kind: 'migrado'; patch: Record<string, unknown> }
  /**
   * Converted, but the signed delta could not be derived — `patch` carries
   * everything else and leaves `movimento` null. `motivo` names why.
   */
  | { kind: 'movimento-desconhecido'; patch: Record<string, unknown>; motivo: string };

function numeroOuNull(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

/**
 * Derive `parentId` and `depositoOuterRef` from the document path —
 * `produtos/{produtoId}/estoques/{estoqueId}/historicoEstoque/{rowId}`, where
 * the estoque id is `est-<produtoId>-<depositoId>` (`makeEstoqueUid`).
 *
 * The depósito id is recovered by stripping the KNOWN prefix
 * `est-<produtoId>-` rather than by splitting on `-`: both ids may legally
 * contain hyphens, so a positional split would truncate them. Returns `null`
 * for anything that does not match, which the caller reports rather than
 * guessing at.
 */
export function chavesDoPath(path: string): { parentId: string; depositoId: string } | null {
  const partes = path.split('/').filter(Boolean);
  const i = partes.indexOf('produtos');
  if (i < 0 || partes.length < i + 4) return null;
  const parentId = partes[i + 1];
  const estoqueId = partes[i + 3];
  if (!parentId || !estoqueId) return null;
  const prefixo = `est-${parentId}-`;
  if (!estoqueId.startsWith(prefixo)) return null;
  const depositoId = estoqueId.slice(prefixo.length);
  return depositoId === '' ? null : { parentId, depositoId };
}

/**
 * Classify + convert ONE `historicoEstoque` row. Pure: the caller supplies the
 * stored data and the document path, and decides what to write.
 */
export function planHistoricoV2(data: unknown, path: string): HistoricoV2Verdict {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return { kind: 'sem-dados' };
  const row = data as Record<string, unknown>;

  // Idempotence: v2 rows carry `movimento`. Present (even null-after-a-previous
  // partial pass is ambiguous, so only a NUMBER counts as converted) ⇒ skip.
  if (numeroOuNull(row.movimento) != null) return { kind: 'ja-migrado' };

  const chaves = chavesDoPath(path);
  if (chaves == null) return { kind: 'sem-dados' };

  const quantidade = numeroOuNull(row.quantidade);
  const reservada = numeroOuNull(row.quantidadeReservada);
  const depois = numeroOuNull(row.quantidadeDepois);
  const reservadaDepois = numeroOuNull(row.quantidadeReservadaDepois);
  const antes = numeroOuNull(row.quantidadeAntes);
  const reservadaAntes = numeroOuNull(row.quantidadeReservadaAntes);

  const base: Record<string, unknown> = {
    parentId: chaves.parentId,
    depositoOuterRef: `documents/depositos/${chaves.depositoId}`,
    saldo: depois,
    saldoReservada: reservadaDepois,
  };

  // A balanço stored ABSOLUTES in the delta fields (`ehBalanco: true`, or the
  // structured `tipo` when the row has one).
  const ehBalanco = row.ehBalanco === true || row.tipo === 'balanco';
  if (!ehBalanco) {
    // Every other row already held a signed delta — a straight rename.
    return {
      kind: 'migrado',
      patch: { ...base, movimento: quantidade ?? 0, movimentoReservada: reservada ?? 0 },
    };
  }

  // Balanço: the delta is `contado − anterior`, and `anterior` is only on the
  // row when a transactional writer produced it.
  if (quantidade != null && antes != null) {
    return {
      kind: 'migrado',
      patch: {
        ...base,
        movimento: quantidade - antes,
        movimentoReservada:
          reservada != null && reservadaAntes != null ? reservada - reservadaAntes : null,
        // A balanço's counted value IS the resulting saldo, even when the row
        // never recorded `quantidadeDepois`.
        saldo: depois ?? quantidade,
        saldoReservada: reservadaDepois ?? reservada,
      },
    };
  }

  return {
    kind: 'movimento-desconhecido',
    patch: {
      ...base,
      movimento: null,
      movimentoReservada: null,
      saldo: depois ?? quantidade,
      saldoReservada: reservadaDepois ?? reservada,
    },
    motivo:
      quantidade == null
        ? 'balanço sem quantidade contada'
        : 'balanço sem quantidadeAntes — o delta assinado não é recuperável (fail-open)',
  };
}
