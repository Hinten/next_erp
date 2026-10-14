'use client';

import type { Firestore } from 'firebase/firestore';
import { Card, Divider, Stack, Text } from '@mantine/core';
import type { ProdutoShopeeLink } from '@delfrance/schemas';

import type { ContaShopee, TabelaMedidasDoProduto } from './ContaShopeePanel';
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
}

/**
 * One Shopee listing (`data-testid="shopee-anuncio-<linkDocId>"`), top to
 * bottom: its state, what was refused on it, what Shopee says is wrong with it,
 * the size chart a publish would send, and — on demand — its models.
 *
 * Read-only: every value comes from the live link document (or, for the models,
 * a one-shot read). Presentational — the open/closed state of "Variações"
 * belongs to the editor (its rule R2).
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
}: AnuncioShopeeBlockProps) {
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
      </Stack>
    </Card>
  );
}
