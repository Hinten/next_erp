'use client';

import { Text } from '@mantine/core';
import { ACAO_STATUS_ANUNCIO } from '@delfrance/schemas';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useMercadoLivreClient } from '@/lib/mercado-livre/client';
import { PushProgressDialog } from '@/lib/marketplace/push/PushProgressDialog';
import {
  type PausarAnuncioAlvo,
  definirStatusParaMarketplaces,
} from '@/lib/marketplace/anuncioStatus/pausarAnunciosRun';
import type { AnuncioStatusRow } from '@/lib/marketplace/anuncioStatus/types';

/**
 * The bulk "Pausar anúncios" dialog — `PushProgressDialog`, shared with the two
 * push flows. What is left here is this operation's wording and the fact that it
 * has no per-run option: the direction IS the action.
 */

export interface PausarAnunciosDialogProps {
  opened: boolean;
  alvos: readonly PausarAnuncioAlvo[];
  onClose: () => void;
}

export function PausarAnunciosDialog({ opened, alvos, onClose }: PausarAnunciosDialogProps) {
  const mercadoLivre = useMercadoLivreClient();

  return (
    <PushProgressDialog<AnuncioStatusRow, null>
      opened={opened}
      onClose={onClose}
      titulo="Pausando anúncios nos marketplaces"
      rotuloAcao="Pausar anúncios"
      testIdPrefix="pausar-anuncio-row-"
      totalAlvos={alvos.length}
      descricao={
        <>
          <Text size="sm">
            Os anúncios de {alvos.length} produto(s) deixam de vender nos canais em que estão
            publicados. As variações publicadas como família são pausadas junto.
          </Text>
          {/* ⚠️ The behaviour that makes this warning necessary: publish sends
              `status: 'active'` on every update, so an ordinary save reactivates
              a listing paused here. Kept deliberately (legacy parity), which
              makes saying so part of shipping the action. */}
          <Text size="sm" c="dimmed" mt="xs">
            Salvar ou republicar um anúncio depois o reativa no Mercado Livre. Anúncios já pausados
            ou encerrados são ignorados.
          </Text>
        </>
      }
      // This operation has no per-run choice: the direction is the action.
      opcaoInicial={null}
      renderOpcao={() => null}
      rotuloSucesso={{ singular: 'Pausado', plural: 'Pausados' }}
      detalheLinha={(row) =>
        row.membros && row.membros.total > 1
          ? `${String(row.membros.aplicados)}/${String(row.membros.total)} variações`
          : null
      }
      executar={(_opcao, signal, onProgress) =>
        definirStatusParaMarketplaces(
          alvos,
          ACAO_STATUS_ANUNCIO.pausar,
          { db: getFirebaseFirestore(), deps: { mercadoLivre }, signal },
          onProgress,
        )
      }
    />
  );
}
