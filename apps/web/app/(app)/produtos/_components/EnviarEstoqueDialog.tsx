'use client';

import { Checkbox } from '@mantine/core';
import { useIntegracoes } from '@/lib/data/useIntegracoes';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useMercadoLivreClient } from '@/lib/mercado-livre/client';
import { AvisoCanaisNaoSuportados } from '@/lib/marketplace/caps/AvisoCanaisNaoSuportados';
import { PushProgressDialog } from '@/lib/marketplace/push/PushProgressDialog';
import {
  type EnviarEstoqueAlvo,
  enviarEstoqueParaMarketplaces,
} from '@/lib/marketplace/estoque/enviarEstoqueRun';
import { suporteEstoqueDoCanal } from '@/lib/marketplace/estoque/registry';
import type { StockPushRow } from '@/lib/marketplace/estoque/types';

/**
 * The bulk stock-push dialog — the port of the legacy `EnviarEstoqueDialog`
 * (`.old/lib/produtos/pages/enviarEstoqueDialog.dart`).
 *
 * The dialog itself is `PushProgressDialog`, shared with "Enviar preços" (#804):
 * the legacy had two dialogs that differed only in the verb in the title and
 * the tick-box above the run. What is left here is exactly that difference.
 */

export interface EnviarEstoqueDialogProps {
  opened: boolean;
  alvos: readonly EnviarEstoqueAlvo[];
  onClose: () => void;
}

export function EnviarEstoqueDialog({ opened, alvos, onClose }: EnviarEstoqueDialogProps) {
  const mercadoLivre = useMercadoLivreClient();
  // The same shared `['integracoes']` entry `/produtos` already holds — this
  // resolves the selection's conta ids to a tipo at no extra read.
  const { byId, status } = useIntegracoes(getFirebaseFirestore());

  return (
    <PushProgressDialog<StockPushRow, boolean>
      opened={opened}
      onClose={onClose}
      titulo="Enviando estoque para os marketplaces"
      rotuloAcao="Enviar estoque"
      testIdPrefix="envio-estoque-row-"
      totalAlvos={alvos.length}
      avisos={
        <AvisoCanaisNaoSuportados
          acao="estoque"
          alvos={alvos}
          veredito={suporteEstoqueDoCanal}
          byId={byId}
          status={status}
        />
      }
      descricao={`O estoque atual de ${String(alvos.length)} produto(s) será enviado para os canais em que eles estão anunciados.`}
      /**
       * RE-ARMED OFF on every open, never remembered. Re-sending to a listing
       * latched by #781 costs an extra ML `GET` per anúncio and, if our payload
       * really was the problem, just re-earns the rejection — so it must be a
       * deliberate choice each time, not a sticky preference.
       */
      opcaoInicial={false}
      renderOpcao={(reenviarComErro, definir) => (
        <Checkbox
          label="Reenviar anúncios com erro"
          description={
            'Anúncios marcados com erro ficam de fora por padrão: o Mercado Livre já ' +
            'confirmou que eles estão saudáveis, então foi o envio anterior que ele recusou. ' +
            'Marque para reverificar cada um e tentar de novo.'
          }
          checked={reenviarComErro}
          onChange={(e) => definir(e.currentTarget.checked)}
        />
      )}
      executar={(reenviarComErro, signal, onProgress) =>
        enviarEstoqueParaMarketplaces(
          alvos,
          reenviarComErro,
          { db: getFirebaseFirestore(), deps: { mercadoLivre }, signal },
          onProgress,
        )
      }
    />
  );
}
