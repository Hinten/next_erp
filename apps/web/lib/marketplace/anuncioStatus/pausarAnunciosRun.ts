import type { Firestore } from 'firebase/firestore';
import type { AcaoStatusAnuncio, Integracao } from '@delfrance/schemas';

import { enviarParaMarketplaces } from '../push/run';
import type { PushAlvo, PushRowBase } from '../push/types';
import { PROVIDERS, definirStatusParaIntegracao } from './registry';
import type { AnuncioStatusDeps, AnuncioStatusRow } from './types';

/**
 * The bulk "Pausar anúncios" run.
 *
 * The loop itself is `../push/run.ts`, shared with "Enviar estoque" (#819) and
 * "Enviar preços" (#804): all three take the checked produtos, fan out over
 * every channel each one is listed on, and report one row per listing. This file
 * is what remains once that is factored out — the status-shaped row and this
 * operation's registry.
 */

/** One selected produto, as the produtos table already holds it. */
export type PausarAnuncioAlvo = PushAlvo;

export interface AnuncioStatusRunDeps {
  db: Firestore;
  /** Per-channel clients handed to the providers. */
  deps: AnuncioStatusDeps;
  /** Injected so tests never touch Firestore. */
  lerIntegracoes?: (
    db: Firestore,
    ids: readonly string[],
  ) => Promise<Map<string, Pick<Integracao, 'nome' | 'tipo' | 'ativo'>>>;
  signal?: AbortSignal;
}

export interface AnuncioStatusRunResult {
  rows: AnuncioStatusRow[];
  cancelado: boolean;
}

/** A row the ORCHESTRATOR invented: it knows the produto and the conta, no listing. */
const completarLinha = (base: PushRowBase): AnuncioStatusRow => ({
  ...base,
  statusFinal: null,
  membros: null,
});

/**
 * Move every listing of the selected produtos, on every channel they are listed
 * on. See `../push/run.ts` for the cost shape and why the grouping happens
 * before the read.
 */
export function definirStatusParaMarketplaces(
  alvos: readonly PausarAnuncioAlvo[],
  acao: AcaoStatusAnuncio,
  runDeps: AnuncioStatusRunDeps,
  onProgress: (rows: AnuncioStatusRow[]) => void,
): Promise<AnuncioStatusRunResult> {
  return enviarParaMarketplaces<AnuncioStatusRow>(
    alvos,
    {
      db: runDeps.db,
      suportado: (tipo) => PROVIDERS[tipo] !== undefined,
      dispatch: (args) =>
        definirStatusParaIntegracao({
          integracao: args.integracao,
          produtoIds: args.produtoIds,
          nomePorProdutoId: args.nomePorProdutoId,
          acao,
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
