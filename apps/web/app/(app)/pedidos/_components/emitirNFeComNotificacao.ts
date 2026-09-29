'use client';

/**
 * Post-commit NF-e emission with the standard toasts, shared by the create
 * views, the edit page's "Emitir NF-e" button and the entrada post-save prompt:
 * a red "não está logado" toast when there's no client, `emitir(pedidoId)`, a
 * COPYABLE success toast (SEFAZ outcomes — cStat/xMotivo — must be
 * copy-pasteable for diagnosis) and the copyable error path — which, for a
 * rejection that needs context (cStat 805, #852), reads the rejected NF-e and
 * the cliente first so the toast can say what to fix and link the cadastro.
 */
import type { NFeHttpClient } from '@delfrance/integrations-nfe/http-provider';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { carregadorContextoRejeicao } from '@/lib/nfe/contextoRejeicao';
import { notificationForNFeErrorComContexto, notificationForNFeResult } from '@/lib/nfe/errors';
import {
  showCopyableNotification,
  showErrorNotification,
} from '@/lib/notifications/showErrorNotification';

export async function emitirNFeComNotificacao(
  client: NFeHttpClient | null,
  pedidoId: string,
): Promise<void> {
  if (!client) {
    showErrorNotification({
      title: 'Você não está logado',
      message: 'Faça login para emitir NF-e.',
    });
    return;
  }
  try {
    const result = await client.emitir(pedidoId);
    showCopyableNotification(notificationForNFeResult(result));
  } catch (err) {
    // The repo's established narrowing for this exact call (see
    // lib/nfe/bulkEmit.ts): the typed NFe errors all extend Error and
    // `notificationForNFeError` narrows them further; non-Error throws rethrow.
    // The loader only runs for a cStat that needs context (805) — every other
    // error maps synchronously, without a read.
    if (!(err instanceof Error)) throw err;
    showErrorNotification(
      await notificationForNFeErrorComContexto(
        err,
        carregadorContextoRejeicao(getFirebaseFirestore()),
      ),
    );
  }
}
