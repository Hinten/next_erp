'use client';

import { Checkbox, Stack } from '@mantine/core';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useMercadoLivreClient } from '@/lib/mercado-livre/client';
import { PushProgressDialog } from '@/lib/marketplace/push/PushProgressDialog';
import {
  type EnviarPrecoAlvo,
  type EnviarPrecoOpcoes,
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
    <PushProgressDialog<PricePushRow, EnviarPrecoOpcoes>
      opened={opened}
      onClose={onClose}
      titulo="Enviando preços para os marketplaces"
      rotuloAcao="Enviar preços"
      testIdPrefix="envio-preco-row-"
      totalAlvos={alvos.length}
      descricao={`O preço atual de ${String(alvos.length)} produto(s) será enviado para os canais em que eles estão anunciados.`}
      /**
       * BOTH default ON, for different reasons.
       *
       * `baixarPreco`: unlike the account-wide job — and unlike this dialog's
       * stock twin. Hand-picking produtos IS the explicit intent, and the legacy
       * per-produto action passed `baixarPreco: true` unconditionally
       * (`produtoTableView.dart:607`). The account-wide job keeps the opposite
       * default because one tick there moves every listing at once.
       *
       * `incluirNaoPublicados`: because REFUSING was the risky direction, not
       * sending. `publicado` is an ERP catalogue flag that says nothing about
       * whether the anúncio is live, so the unconditional skip this replaces
       * left ML advertising a stale price on a selling listing — the same
       * conclusion the account-wide job reached in #1072 and the stock side in
       * #1087. Unticked, those produtos come back as `NAO_PUBLICADO` rows.
       *
       * Both are still re-armed to THESE values on every open — the page mounts
       * the dialog fresh per run, so a run where the operator unticked one never
       * leaks into the next. A fresh object literal per render is harmless: it
       * only ever feeds a `useState` initialiser.
       */
      opcaoInicial={{ baixarPreco: true, incluirNaoPublicados: true }}
      renderOpcao={(opcoes, definir) => (
        <Stack gap="sm">
          <Checkbox
            label="Permitir baixar preços"
            description={
              'Deixe marcado para o preço do ERP substituir o do anúncio mesmo quando for MENOR. ' +
              'Desmarque para só aumentar: um anúncio mais caro que o ERP fica como está.'
            }
            checked={opcoes.baixarPreco}
            onChange={(e) => definir({ ...opcoes, baixarPreco: e.currentTarget.checked })}
          />
          <Checkbox
            label="Incluir produtos ocultos"
            description={
              'Deixe marcado para enviar o preço mesmo quando o produto estiver oculto ' +
              '(não publicado) no ERP, desde que o anúncio esteja ativo no Mercado Livre. ' +
              'Desmarque para pular esses produtos.'
            }
            checked={opcoes.incluirNaoPublicados}
            onChange={(e) => definir({ ...opcoes, incluirNaoPublicados: e.currentTarget.checked })}
          />
        </Stack>
      )}
      executar={(opcoes, signal, onProgress) =>
        enviarPrecoParaMarketplaces(
          alvos,
          opcoes,
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
