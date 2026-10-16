'use client';

import type { Firestore } from 'firebase/firestore';
import { Card, Divider, Stack, Text } from '@mantine/core';
import type { ProdutoShopeeLink } from '@delfrance/schemas';

import { AcoesAnuncioShopee, type AcoesShopee } from './AcoesAnuncioShopee';
import type { ContaShopee, TabelaMedidasDoProduto } from './ContaShopeePanel';
import { DesfechoAcaoShopee } from './DesfechoAcaoShopee';
import { ModelosAnuncioShopee } from './ModelosAnuncioShopee';
import { RecusasAnuncioShopee } from './RecusasAnuncioShopee';
import { StatusAnuncioShopee } from './StatusAnuncioShopee';
import { TabelaMedidasShopeeResumo } from './TabelaMedidasShopeeResumo';
import { ViolacoesAnuncioShopee } from './ViolacoesAnuncioShopee';
import { textoPreenchido } from './campos';

export interface AnuncioShopeeBlockProps {
  db: Firestore;
  produtoId: string;
  linkDocId: string;
  link: ProdutoShopeeLink;
  conta: ContaShopee;
  contaDoAnuncioLegivel: boolean;
  tabelaMedidas: TabelaMedidasDoProduto;
  agoraMs: number;
  modelosAberto: boolean;
  onAlternarModelos: (linkDocId: string) => void;
  /** The actions' state and handlers — owned by the editor (its rule R2). */
  acoes: AcoesShopee;
}

/**
 * One Shopee listing (`data-testid="shopee-anuncio-<linkDocId>"`), top to
 * bottom: its state, what was refused on it, what Shopee says is wrong with it,
 * the template entry the produto's tabela de medidas holds for this listing
 * (never what a publish sent — residual 7), on demand its models — then the
 * outcome of the last action on it, and the action row.
 *
 * Every value shown comes from the live link document (or, for the models, a
 * one-shot read): an action calls an apps/shopee route, and the block repaints
 * from the snapshot that route's write-back lands in. Presentational — the
 * open/closed "Variações", the outcomes and the write in flight belong to the
 * editor (its rule R2).
 */
export function AnuncioShopeeBlock({
  db,
  produtoId,
  linkDocId,
  link,
  conta,
  contaDoAnuncioLegivel,
  tabelaMedidas,
  agoraMs,
  modelosAberto,
  onAlternarModelos,
  acoes,
}: AnuncioShopeeBlockProps) {
  const desfecho = acoes.desfechoDe(linkDocId);
  return (
    <Card withBorder padding="sm" data-testid={`shopee-anuncio-${linkDocId}`}>
      <Stack gap="sm">
        <Text fw={600} size="sm">
          {textoPreenchido(link.item_name) ?? 'Anúncio sem título'}
        </Text>
        <StatusAnuncioShopee link={link} shopId={conta.shopId} />
        <RecusasAnuncioShopee link={link} agoraMs={agoraMs} />
        <ViolacoesAnuncioShopee link={link} />
        <Divider />
        <TabelaMedidasShopeeResumo
          tabelaMedidas={tabelaMedidas}
          contaId={contaDoAnuncioLegivel ? conta.id : null}
          categoryId={link.category_id}
        />
        <ModelosAnuncioShopee
          db={db}
          produtoId={produtoId}
          linkDocId={linkDocId}
          anuncio={link}
          aberto={modelosAberto}
          onAlternar={() => onAlternarModelos(linkDocId)}
        />
        {desfecho !== null && (
          <DesfechoAcaoShopee
            contaId={conta.id}
            linkDocId={linkDocId}
            desfecho={desfecho}
            acoes={acoes}
          />
        )}
        <AcoesAnuncioShopee contaId={conta.id} linkDocId={linkDocId} link={link} acoes={acoes} />
      </Stack>
    </Card>
  );
}
