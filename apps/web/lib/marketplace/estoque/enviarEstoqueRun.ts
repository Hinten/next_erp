import type { Firestore } from 'firebase/firestore';
import type { Integracao } from '@delfrance/schemas';

import { enviarParaMarketplaces } from '../push/run';
import type { PushAlvo, PushRowBase } from '../push/types';
import { PROVIDERS, enviarEstoqueParaIntegracao } from './registry';
import type { StockPushDeps, StockPushRow } from './types';

/**
 * The bulk "Enviar estoque" run — the port of the legacy `enviarEstoqueStream`
 * (`.old/lib/produtos/pages/enviarEstoqueDialog.dart:188-349`).
 *
 * The loop itself now lives in `../push/run.ts`, shared with "Enviar preços"
 * (#804): both operations take the checked produtos, fan out over every channel
 * each is listed on, and report one row per listing — the grouping, the single
 * chunked integração read, the whole-selection dispatch to supported channels,
 * the cancel semantics and the incremental `onProgress` are identical. This
 * file is what remains once that is factored out: the stock-shaped row and the
 * stock registry.
 */

/** One selected produto, as the produtos table already holds it. */
export type EnviarEstoqueAlvo = PushAlvo;

export interface EnviarEstoqueRunDeps {
  db: Firestore;
  /** Per-channel clients handed to the providers. */
  deps: StockPushDeps;
  /** Injected so tests never touch Firestore. */
  lerIntegracoes?: (
    db: Firestore,
    ids: readonly string[],
  ) => Promise<Map<string, Pick<Integracao, 'nome' | 'tipo' | 'ativo'>>>;
  signal?: AbortSignal;
}

export interface EnviarEstoqueRunResult {
  rows: StockPushRow[];
  cancelado: boolean;
}

/** A row the ORCHESTRATOR invented: it knows the produto and the conta, never a quantity. */
const completarLinha = (base: PushRowBase): StockPushRow => ({ ...base, quantidade: null });

/**
 * Push the selected produtos' stock to every channel they are listed on. See
 * `../push/run.ts` for the cost shape and why the grouping happens before the
 * read.
 */
export function enviarEstoqueParaMarketplaces(
  alvos: readonly EnviarEstoqueAlvo[],
  reenviarComErro: boolean,
  runDeps: EnviarEstoqueRunDeps,
  onProgress: (rows: StockPushRow[]) => void,
): Promise<EnviarEstoqueRunResult> {
  return enviarParaMarketplaces<StockPushRow>(
    alvos,
    {
      db: runDeps.db,
      suportado: (tipo) => PROVIDERS[tipo] !== undefined,
      dispatch: (args) =>
        enviarEstoqueParaIntegracao({
          integracao: args.integracao,
          produtoIds: args.produtoIds,
          nomePorProdutoId: args.nomePorProdutoId,
          reenviarComErro,
          deps: runDeps.deps,
          signal: args.signal,
        }),
      completarLinha,
      lerIntegracoes: runDeps.lerIntegracoes,
      signal: runDeps.signal,
    },
    onProgress,
  );
}
