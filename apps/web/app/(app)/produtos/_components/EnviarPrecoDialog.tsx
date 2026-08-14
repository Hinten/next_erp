'use client';

import { Checkbox } from '@mantine/core';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useMercadoLivreClient } from '@/lib/mercado-livre/client';
import { PushProgressDialog } from '@/lib/marketplace/push/PushProgressDialog';
import {
  type EnviarPrecoAlvo,
  enviarPrecoParaMarketplaces,
} from '@/lib/marketplace/preco/enviarPrecoRun';
import type { PricePushRow } from '@/lib/marketplace/preco/types';

/**
 * The bulk price-push dialog — the port of the legacy `EnviarPrecoDialog`
 * (`.old/lib/produtos/pages/produtoTableView.dart:466-1136`).
 *
 * The dialog itself is `PushProgressDialog`, shared with "Enviar estoque":
 * the legacy had two dialogs that differed only in the verb in the title and
 * the tick-box above the run. What is left here is exactly that difference.
 */

export interface EnviarPrecoDialogProps {
  opened: boolean;
  alvos: readonly EnviarPrecoAlvo[];
  onClose: () => void;
}

export function EnviarPrecoDialog({ opened, alvos, onClose }: EnviarPrecoDialogProps) {
  const mercadoLivre = useMercadoLivreClient();

  return (
    <PushProgressDialog<PricePushRow, boolean>
      opened={opened}
      onClose={onClose}
      titulo="Enviando preços para os marketplaces"
      rotuloAcao="Enviar preços"
      testIdPrefix="envio-preco-row-"
      totalAlvos={alvos.length}
      descricao={`O preço atual de ${String(alvos.length)} produto(s) será enviado para os canais em que eles estão anunciados.`}
      /**
       * Defaulted ON, unlike the account-wide job — and unlike this dialog's
       * stock twin. Hand-picking produtos IS the explicit intent, and the legacy
       * per-produto action passed `baixarPreco: true` unconditionally
       * (`produtoTableView.dart:607`). The account-wide job keeps the opposite
       * default because one tick there moves every listing at once.
       *
       * Still re-armed to THIS value on every open — the page mounts the dialog
       * fresh per run, so a run where the operator unticked it never leaks into
       * the next one.
       */
      opcaoInicial
      renderOpcao={(baixarPreco, definir) => (
        <Checkbox
          label="Permitir baixar preços"
          description={
            'Deixe marcado para o preço do ERP substituir o do anúncio mesmo quando for MENOR. ' +
            'Desmarque para só aumentar: um anúncio mais caro que o ERP fica como está.'
          }
          checked={baixarPreco}
          onChange={(e) => definir(e.currentTarget.checked)}
        />
      )}
      executar={(baixarPreco, signal, onProgress) =>
        enviarPrecoParaMarketplaces(
          alvos,
          baixarPreco,
          { db: getFirebaseFirestore(), deps: { mercadoLivre }, signal },
          onProgress,
        )
      }
      // The old→new price is the one thing an operator checks after a price
      // push, and the backend's `mensagem` already carries it on a success —
      // this adds it to the subtitle for the rows where it did NOT change.
      detalheLinha={(row) =>
        row.outcome !== 'enviado' && row.precoAnterior != null
          ? ` · anúncio a ${String(row.precoAnterior)}`
          : null
      }
    />
  );
}
