import type { Firestore } from 'firebase/firestore';
import type { Integracao, IntegracaoTipo } from '@delfrance/schemas';
import { getDocsByIds } from '@/lib/data/getDocsByIds';
import { integracaoCollection } from '@/lib/data/integracaoCollection';

import { PROVIDERS, enviarEstoqueParaIntegracao } from './registry';
import type { StockPushRow } from './types';

/**
 * The bulk "Enviar estoque" run — the port of the legacy `enviarEstoqueStream`
 * (`.old/lib/produtos/pages/enviarEstoqueDialog.dart:188-349`).
 *
 * Incremental by design, exactly like the legacy `async*`: `onProgress` fires
 * after every conta resolves, so the dialog fills in as results land rather than
 * waiting for the whole batch.
 */

/** One selected produto, as the produtos table already holds it. */
export interface EnviarEstoqueAlvo {
  produtoId: string;
  produtoNome: string;
  /**
   * The conta ids this produto is linked to. Used ONLY to decide which
   * unsupported channels are worth warning about — never to decide what to
   * send: the channel backend is authoritative about its own links, and this
   * denorm is known to drift (#804 S7).
   */
  integracoesComProduto: readonly string[];
}

export interface EnviarEstoqueRunDeps {
  db: Firestore;
  /** Per-channel clients handed to the providers. */
  deps: import('./types').StockPushDeps;
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

const defaultLerIntegracoes = (db: Firestore, ids: readonly string[]) =>
  getDocsByIds(db, integracaoCollection, ids);

function linhaSimples(
  produtoId: string,
  produtoNome: string | null,
  motivo: string,
  mensagem: string,
): StockPushRow {
  return {
    key: `${produtoId}:-:-`,
    produtoId,
    produtoNome,
    integracaoId: null,
    integracaoNome: null,
    anuncioId: null,
    linkDocId: null,
    outcome: 'pulado',
    motivo,
    mensagem,
    quantidade: null,
  };
}

/**
 * Push the selected produtos' stock to every channel they are listed on.
 *
 * Cost shape, and why the grouping happens BEFORE the read: the conta ids are
 * deduped across the whole selection first, so 50 produtos × 3 contas is **3
 * document reads in one chunked query**, not 150. The produto names and denorm
 * ride in from the table's existing snapshot, so they cost nothing. That is
 * already cheaper than the legacy, which re-read each produto AND loaded the
 * entire `integracao` collection on every run.
 *
 * Each SUPPORTED conta is called once with the whole selection — the channel
 * filters to the produtos it actually has listings for and reports the rest, so
 * the drifting `integracoesComProduto` denorm never decides what gets sent.
 */
export async function enviarEstoqueParaMarketplaces(
  alvos: readonly EnviarEstoqueAlvo[],
  reenviarComErro: boolean,
  runDeps: EnviarEstoqueRunDeps,
  onProgress: (rows: StockPushRow[]) => void,
): Promise<EnviarEstoqueRunResult> {
  const lerIntegracoes = runDeps.lerIntegracoes ?? defaultLerIntegracoes;
  const rows: StockPushRow[] = [];
  const emitir = () => onProgress([...rows]);

  const nomePorProdutoId = new Map(alvos.map((a) => [a.produtoId, a.produtoNome]));
  const semIntegracoes = alvos.filter((a) => a.integracoesComProduto.length === 0);
  const contaIds = [...new Set(alvos.flatMap((a) => [...a.integracoesComProduto]))];

  // Legacy verbatim (`enviarEstoqueDialog.dart:226`).
  for (const a of semIntegracoes) {
    rows.push(
      linhaSimples(a.produtoId, a.produtoNome, 'sem-integracoes', 'Produto não tem integrações'),
    );
  }
  emitir();

  if (contaIds.length === 0) return { rows, cancelado: false };

  const integracoes = await lerIntegracoes(runDeps.db, contaIds);

  // Only produtos that actually list a conta are pushed through it, and the
  // produtos that listed a channel we cannot serve get told so per channel.
  const produtosPorConta = new Map<string, EnviarEstoqueAlvo[]>();
  for (const a of alvos) {
    for (const id of a.integracoesComProduto) {
      const lista = produtosPorConta.get(id) ?? [];
      lista.push(a);
      produtosPorConta.set(id, lista);
    }
  }

  let cancelado = false;
  for (const contaId of contaIds) {
    if (runDeps.signal?.aborted === true) {
      cancelado = true;
      break;
    }
    const alvosDaConta = produtosPorConta.get(contaId) ?? [];
    const conta = integracoes.get(contaId);
    if (!conta) {
      // Legacy `:241` — reported, and the run CONTINUES (legacy `continue`).
      for (const a of alvosDaConta) {
        rows.push(
          linhaSimples(
            a.produtoId,
            a.produtoNome,
            'integracao-nao-encontrada',
            `Integração não encontrada ${contaId}`,
          ),
        );
      }
      emitir();
      continue;
    }

    const suportado = PROVIDERS[conta.tipo as IntegracaoTipo] !== undefined;
    const result = await enviarEstoqueParaIntegracao({
      integracao: {
        id: contaId,
        nome: conta.nome,
        tipo: conta.tipo as IntegracaoTipo,
        ativo: conta.ativo !== false,
      },
      // A supported channel gets the WHOLE selection and decides for itself;
      // an unsupported one only warns about the produtos that name it, so an
      // unrelated channel never adds a row per selected produto.
      produtoIds: suportado ? alvos.map((a) => a.produtoId) : alvosDaConta.map((a) => a.produtoId),
      nomePorProdutoId,
      reenviarComErro,
      deps: runDeps.deps,
      signal: runDeps.signal,
    });
    rows.push(...result.rows);
    emitir();
  }

  return { rows, cancelado };
}
