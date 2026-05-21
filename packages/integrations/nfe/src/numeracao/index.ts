/**
 * NF-e numeração + lote — per-Filial counter helpers.
 *
 * Mirrors the three transactional methods on Flutter's `NFeConfig`
 * (`.old/packages/nfe_client/lib/src/models.dart:63-149`):
 *
 *   - `proxima_numeracao`                    → `nextNumeracao`
 *   - `proxima_numeracao_batch_transaction(qte)` → `nextNumeracaoBulk`
 *   - `proximo_lote_transaction`             → `nextIdLote`
 *
 * **Fiscal-critical correctness rule**: every allocation runs inside the
 * store's transaction so two concurrent callers can never get the same
 * `nNF` or `idLote`. Skipping an `nNF` requires an `inutNFe` filing;
 * duplicating one means SEFAZ rejects the second emission. The staging
 * Firestore concurrency test (`numeracao.staging.test.ts`) is the
 * regression contract for this.
 *
 * The store interface is intentionally abstract — the in-memory mock used
 * by `numeracao.test.ts` and the Firestore adapter in
 * `./firestore-adapter.ts` both satisfy it.
 */
import type { NFeConfig } from '@delfrance/schemas';

/** Minimum surface a transaction-capable store needs to satisfy. */
export interface NFeConfigStore {
  readonly runTransaction: <T>(fn: (tx: NFeConfigTx) => Promise<T>) => Promise<T>;
}

export interface NFeConfigTx {
  /** Get the live `NFeConfig` for a filial. Returns null when absent. */
  readonly get: (filialId: string) => Promise<NFeConfig | null>;
  /** Write the new `NFeConfig` back inside the same transaction. */
  readonly set: (filialId: string, next: NFeConfig) => void;
}

export class NFeConfigNotFoundError extends Error {
  constructor(public readonly filialId: string) {
    super(
      `NFeConfig not found for filial '${filialId}'. ` +
        'Seed `filiais/{filialId}/nfeconfig` (numeracao_atual, serie, idLote, ambiente) ' +
        'before emitting any NF-e from this filial.',
    );
    this.name = 'NFeConfigNotFoundError';
  }
}

export class NFeBulkSizeError extends Error {
  constructor(count: number) {
    super(`nextNumeracaoBulk: count must be ≥ 1, got ${count}`);
    this.name = 'NFeBulkSizeError';
  }
}

/**
 * Allocate the next `nNF` for the filial. Mirrors Dart's
 * `NFeConfig.proxima_numeracao`. Returns the new `nNF` and the filial's
 * configured `serie` so the caller can build the chave in one shot.
 */
export async function nextNumeracao(
  store: NFeConfigStore,
  filialId: string,
): Promise<{ nNF: number; serie: number }> {
  return store.runTransaction(async (tx) => {
    const cfg = await tx.get(filialId);
    if (cfg == null) throw new NFeConfigNotFoundError(filialId);
    const nNF = cfg.numeracao_atual + 1;
    tx.set(filialId, { ...cfg, numeracao_atual: nNF });
    return { nNF, serie: cfg.serie };
  });
}

/**
 * Allocate `count` contiguous `nNF` values in one transaction.
 * Mirrors Dart's `NFeConfig.proxima_numeracao_batch_transaction(qte)`.
 * Returns `[atual+1, atual+2, …, atual+count]` ascending.
 */
export async function nextNumeracaoBulk(
  store: NFeConfigStore,
  filialId: string,
  count: number,
): Promise<{ nNFs: readonly number[]; serie: number }> {
  if (!Number.isInteger(count) || count < 1) {
    throw new NFeBulkSizeError(count);
  }
  return store.runTransaction(async (tx) => {
    const cfg = await tx.get(filialId);
    if (cfg == null) throw new NFeConfigNotFoundError(filialId);
    const base = cfg.numeracao_atual;
    const nNFs: number[] = [];
    for (let i = 1; i <= count; i++) nNFs.push(base + i);
    tx.set(filialId, { ...cfg, numeracao_atual: base + count });
    return { nNFs, serie: cfg.serie };
  });
}

/**
 * Allocate the next `idLote` for the filial. Mirrors Dart's
 * `NFeConfig.proximo_lote_transaction`. Independent counter from
 * `nNF` — the same filial advances both on every emission.
 */
export async function nextIdLote(
  store: NFeConfigStore,
  filialId: string,
): Promise<number> {
  return store.runTransaction(async (tx) => {
    const cfg = await tx.get(filialId);
    if (cfg == null) throw new NFeConfigNotFoundError(filialId);
    const idLote = cfg.idLote + 1;
    tx.set(filialId, { ...cfg, idLote });
    return idLote;
  });
}

/**
 * Read the current `NFeConfig` for a filial without advancing any counter.
 * Useful for `apps/nfe`'s `/api/health` to surface the configured
 * `ambiente` + `serie` per filial.
 */
export async function readNFeConfig(
  store: NFeConfigStore,
  filialId: string,
): Promise<NFeConfig> {
  return store.runTransaction(async (tx) => {
    const cfg = await tx.get(filialId);
    if (cfg == null) throw new NFeConfigNotFoundError(filialId);
    return cfg;
  });
}
