import type { Firestore } from 'firebase/firestore';
import type { Integracao } from '@delfrance/schemas';

import { enviarParaMarketplaces } from '../push/run';
import type { PushAlvo, PushRowBase } from '../push/types';
import { enviarPrecoParaIntegracao, suportePrecoDoCanal } from './registry';
import type { PricePushDeps, PricePushRow } from './types';

/**
 * The bulk "Enviar preços" run (#804) — the port of the legacy
 * `_enviarPrecoStream` (`.old/lib/produtos/pages/produtoTableView.dart:503-1000`),
 * which walked the selection, then each produto's `marketplace` entries, and
 * dispatched to whichever channel each one named.
 *
 * The loop itself lives in `../push/run.ts`, shared with "Enviar estoque": the
 * two legacy streams were the same fan-out with a different payload. This file
 * is what remains once that is factored out — the price-shaped row and the
 * price registry.
 */

/** One selected produto, as the produtos table already holds it. */
export type EnviarPrecoAlvo = PushAlvo;

export interface EnviarPrecoRunDeps {
  db: Firestore;
  /** Per-channel clients handed to the providers. */
  deps: PricePushDeps;
  /** Injected so tests never touch Firestore. */
  lerIntegracoes?: (
    db: Firestore,
    ids: readonly string[],
  ) => Promise<Map<string, Pick<Integracao, 'nome' | 'tipo' | 'ativo'>>>;
  signal?: AbortSignal;
}

export interface EnviarPrecoRunResult {
  rows: PricePushRow[];
  cancelado: boolean;
}

/**
 * The operator's per-run ticks, passed as an OBJECT rather than as positional
 * booleans.
 *
 * ⚠️ Deliberate: two adjacent `boolean` parameters at a call site are
 * transposable in silence — the compiler cannot tell them apart and both
 * mistakes ship a working-looking run that did the wrong thing (a price
 * lowered that should not have been, or a hidden produto skipped that should
 * not have been). Naming them at every call site is the cheapest fix.
 */
export interface EnviarPrecoOpcoes {
  /** Allow the send to LOWER a listing's price. */
  baixarPreco: boolean;
  /** Send even when the produto is oculto (não publicado) in the ERP. */
  incluirNaoPublicados: boolean;
}

/** A row the ORCHESTRATOR invented: it knows the produto and the conta, never a price. */
const completarLinha = (base: PushRowBase): PricePushRow => ({
  ...base,
  preco: null,
  precoAnterior: null,
});

/**
 * Push the selected produtos' prices to every channel they are listed on. See
 * `../push/run.ts` for the cost shape and why the grouping happens before the
 * read.
 */
export function enviarPrecoParaMarketplaces(
  alvos: readonly EnviarPrecoAlvo[],
  opcoes: EnviarPrecoOpcoes,
  runDeps: EnviarPrecoRunDeps,
  onProgress: (rows: PricePushRow[]) => void,
): Promise<EnviarPrecoRunResult> {
  return enviarParaMarketplaces<PricePushRow>(
    alvos,
    {
      db: runDeps.db,
      suportado: (tipo) => suportePrecoDoCanal(tipo).suportado,
      dispatch: (args) =>
        enviarPrecoParaIntegracao({
          integracao: args.integracao,
          produtoIds: args.produtoIds,
          nomePorProdutoId: args.nomePorProdutoId,
          baixarPreco: opcoes.baixarPreco,
          incluirNaoPublicados: opcoes.incluirNaoPublicados,
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
