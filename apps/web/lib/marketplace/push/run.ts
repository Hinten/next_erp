import type { Firestore } from 'firebase/firestore';
import type { Integracao, IntegracaoTipo } from '@delfrance/schemas';
import { getDocsByIds } from '@/lib/data/getDocsByIds';
import { integracaoCollection } from '@/lib/data/integracaoCollection';

import type { PushAlvo, PushIntegracao, PushRowBase } from './types';

/**
 * The shared produto-scoped push run — the port of the legacy
 * `enviarEstoqueStream` (`.old/lib/produtos/pages/enviarEstoqueDialog.dart:188-349`)
 * and of the per-channel fan-out inside the legacy `EnviarPrecoDialog`
 * (`.old/lib/produtos/pages/produtoTableView.dart:503-1000`). Both legacy flows
 * were the same loop with a different payload; so is this.
 *
 * Incremental by design, exactly like the legacy `async*`: `onProgress` fires
 * after every conta resolves, so the dialog fills in as results land rather
 * than waiting for the whole batch.
 */

/** One channel dispatch, as the operation's registry exposes it. */
export interface PushDispatchArgs {
  integracao: PushIntegracao;
  produtoIds: readonly string[];
  nomePorProdutoId: ReadonlyMap<string, string>;
  signal?: AbortSignal;
}

export interface PushRunDeps<Row extends PushRowBase> {
  db: Firestore;
  /**
   * True when a REAL provider claims this tipo. Drives the whole-selection
   * dispatch below — an unsupported channel must not be handed produtos that
   * never named it.
   */
  suportado: (tipo: IntegracaoTipo) => boolean;
  /** The operation's registry entry point: shared gates, then the channel. */
  dispatch: (args: PushDispatchArgs) => Promise<{ rows: Row[] }>;
  /**
   * Fill the operation's own fields (`quantidade`, `preco`, …) on a row the
   * ORCHESTRATOR invented rather than a channel — it knows the produto and the
   * conta, never the payload.
   */
  completarLinha: (base: PushRowBase) => Row;
  /** Injected so tests never touch Firestore. */
  lerIntegracoes?: (
    db: Firestore,
    ids: readonly string[],
  ) => Promise<Map<string, Pick<Integracao, 'nome' | 'tipo' | 'ativo'>>>;
  signal?: AbortSignal;
}

export interface PushRunResult<Row extends PushRowBase> {
  rows: Row[];
  cancelado: boolean;
}

const defaultLerIntegracoes = (db: Firestore, ids: readonly string[]) =>
  getDocsByIds(db, integracaoCollection, ids);

/**
 * A row no provider produced — the orchestrator's own arms.
 *
 * ⚠️ `contaId` is not decoration: a produto can name SEVERAL missing integrações,
 * and keying every such row `<produtoId>:-:-` would hand React duplicate keys for
 * the same produto. It also belongs in `integracaoId`, so the dialog can say
 * which conta went missing instead of showing "Integração desconhecida".
 */
function linhaBase(
  produtoId: string,
  produtoNome: string | null,
  motivo: string,
  mensagem: string,
  contaId: string | null = null,
): PushRowBase {
  return {
    key: `${produtoId}:${contaId ?? '-'}:-`,
    produtoId,
    produtoNome,
    integracaoId: contaId,
    integracaoNome: null,
    anuncioId: null,
    linkDocId: null,
    outcome: 'pulado',
    motivo,
    mensagem,
  };
}

/**
 * Push the selected produtos to every channel they are listed on.
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
export async function enviarParaMarketplaces<Row extends PushRowBase>(
  alvos: readonly PushAlvo[],
  runDeps: PushRunDeps<Row>,
  onProgress: (rows: Row[]) => void,
): Promise<PushRunResult<Row>> {
  const lerIntegracoes = runDeps.lerIntegracoes ?? defaultLerIntegracoes;
  const rows: Row[] = [];
  const emitir = () => onProgress([...rows]);
  const linha = (...args: Parameters<typeof linhaBase>): Row =>
    runDeps.completarLinha(linhaBase(...args));
  /**
   * Read through a thunk, never inline. `signal.aborted` is mutable external
   * state that flips when the operator hits Cancelar mid-run, but after one
   * inline `=== true` check TypeScript narrows it to `false | undefined` and
   * calls every later check dead code (TS2367). The call defeats that narrowing
   * — and the compiler was wrong, not the code.
   */
  const cancelou = (): boolean => runDeps.signal?.aborted === true;

  const nomePorProdutoId = new Map(alvos.map((a) => [a.produtoId, a.produtoNome]));
  const semIntegracoes = alvos.filter((a) => a.integracoesComProduto.length === 0);
  const contaIds = [...new Set(alvos.flatMap((a) => [...a.integracoesComProduto]))];

  // Legacy verbatim (`enviarEstoqueDialog.dart:226`).
  for (const a of semIntegracoes) {
    rows.push(linha(a.produtoId, a.produtoNome, 'sem-integracoes', 'Produto não tem integrações'));
  }
  emitir();

  if (contaIds.length === 0) return { rows, cancelado: false };
  // Check BEFORE the read, not only inside the dispatch loop: `getDocsByIds`
  // takes no AbortSignal, so an already-cancelled run would otherwise still pay
  // for the integração query before discovering it has nothing to do.
  if (cancelou()) return { rows, cancelado: true };

  const integracoes = await lerIntegracoes(runDeps.db, contaIds);

  // Only produtos that actually list a conta are pushed through it, and the
  // produtos that listed a channel we cannot serve get told so per channel.
  const produtosPorConta = new Map<string, PushAlvo[]>();
  for (const a of alvos) {
    for (const id of a.integracoesComProduto) {
      const lista = produtosPorConta.get(id) ?? [];
      lista.push(a);
      produtosPorConta.set(id, lista);
    }
  }

  let cancelado = false;
  for (const contaId of contaIds) {
    if (cancelou()) {
      cancelado = true;
      break;
    }
    const alvosDaConta = produtosPorConta.get(contaId) ?? [];
    const conta = integracoes.get(contaId);
    if (!conta) {
      // Legacy `:241` — reported, and the run CONTINUES (legacy `continue`).
      for (const a of alvosDaConta) {
        rows.push(
          linha(
            a.produtoId,
            a.produtoNome,
            'integracao-nao-encontrada',
            `Integração não encontrada ${contaId}`,
            contaId,
          ),
        );
      }
      emitir();
      continue;
    }

    const tipo = conta.tipo as IntegracaoTipo;
    const result = await runDeps.dispatch({
      integracao: { id: contaId, nome: conta.nome, tipo, ativo: conta.ativo !== false },
      // A supported channel gets the WHOLE selection and decides for itself; an
      // unsupported one only warns about the produtos that name it, so an
      // unrelated channel never adds a row per selected produto.
      produtoIds: runDeps.suportado(tipo)
        ? alvos.map((a) => a.produtoId)
        : alvosDaConta.map((a) => a.produtoId),
      nomePorProdutoId,
      signal: runDeps.signal,
    });
    rows.push(...result.rows);
    emitir();
  }

  return { rows, cancelado };
}
