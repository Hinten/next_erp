'use client';

/**
 * Post-save NF-e prompt for a paid entrada (#551, legacy decision 4): after an
 * entrada is saved with `estado === 'pago'`, has no NF-e yet and its operação
 * is fiscal, offer to emit the NF-e right away. Eligibility read failures skip
 * the prompt silently — the pedido is already saved, so this must never break
 * the save flow.
 */
import type { ReactNode } from 'react';
import { FirebaseError } from 'firebase/app';
import { idFromRef } from '@delfrance/schemas';
import type { DevolucaoOperacaoInfo } from '@delfrance/data/pedido';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { createClientPedidoPort } from '@/lib/pedidos/clientPort';
import { useNFeClient } from '@/lib/nfe/client';
import { emitirNFeComNotificacao } from './emitirNFeComNotificacao';
import { useConfirmDialog } from './ConfirmDialog';

export interface EmitirEntradaPromptArgs {
  pedidoId: string;
  /** The just-saved estado — only `'pago'` triggers the prompt. */
  estado: unknown;
  /** The just-saved `operacaoPedidoOuterRef` — the operação must be fiscal. */
  operacaoOuterRef: unknown;
  /**
   * Pre-resolved devolução operação (the #551 integral flow passes
   * `seed.operacao`). When provided, eligibility is `operacao.fiscalCapable`
   * (a devolução entrada must be able to emit a finNFe 4 NF-e) and the
   * no-NFe probe is skipped — the entrada was created milliseconds ago.
   */
  operacao?: DevolucaoOperacaoInfo;
}

export interface UseEmitirEntradaPromptResult {
  /** Await after a successful entrada save; resolves once the flow is done. */
  promptEmitirEntrada: (args: EmitirEntradaPromptArgs) => Promise<void>;
  /** Render once in the view that owns the hook (the confirm dialog). */
  element: ReactNode;
}

/**
 * Eligibility. With a pre-resolved `operacao` (#551 integral):
 * `operacao.fiscalCapable`, no reads. Otherwise (plain entrada / edit page),
 * one-shot reads: the pedido has no `nfev4` doc yet AND its operação exists
 * and is fiscal (`ehFiscal !== false`). A `FirebaseError` on either read skips
 * the prompt silently.
 */
async function isElegivel(args: EmitirEntradaPromptArgs): Promise<boolean> {
  if (args.operacao) return args.operacao.fiscalCapable;
  try {
    const port = createClientPedidoPort(getFirebaseFirestore());
    if (await port.hasNFe(args.pedidoId)) return false;
    const operacaoId =
      typeof args.operacaoOuterRef === 'string' && args.operacaoOuterRef !== ''
        ? idFromRef(args.operacaoOuterRef)
        : '';
    if (operacaoId === '') return false;
    const operacao = await port.getOperacao(operacaoId);
    // Laxer than the integral path's fiscalCapable: a plain compra entrada
    // doesn't require finNFe 4 — any fiscal operação may emit its NF-e.
    return operacao !== null && operacao.ehFiscal !== false;
  } catch (err) {
    if (err instanceof FirebaseError) return false;
    throw err;
  }
}

export function useEmitirEntradaPrompt(): UseEmitirEntradaPromptResult {
  const { confirm, element } = useConfirmDialog();
  const nfeClient = useNFeClient();

  async function promptEmitirEntrada(args: EmitirEntradaPromptArgs): Promise<void> {
    if (args.estado !== 'pago') return;
    if (!(await isElegivel(args))) return;

    const emitir = await confirm({
      title: 'Emitir NF-e',
      message: 'Deseja emitir uma NF-e para esta entrada?',
    });
    if (!emitir) return;

    await emitirNFeComNotificacao(nfeClient, args.pedidoId);
  }

  return { promptEmitirEntrada, element };
}
