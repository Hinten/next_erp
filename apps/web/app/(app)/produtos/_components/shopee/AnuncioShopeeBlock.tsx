'use client';

import type { Firestore } from 'firebase/firestore';
import { Alert, Card, Divider, Stack, Text } from '@mantine/core';
import type { ProdutoShopeeLink } from '@delfrance/schemas';

import { AcoesAnuncioShopee, type AcoesShopee } from './AcoesAnuncioShopee';
import type { ContaShopee, RascunhosShopee, TabelaMedidasDoProduto } from './ContaShopeePanel';
import { DesfechoAcaoShopee } from './DesfechoAcaoShopee';
import { KitAnuncioShopee } from './KitAnuncioShopee';
import { ModelosAnuncioShopee } from './ModelosAnuncioShopee';
import { RascunhoShopee } from './RascunhoShopee';
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
  /** The produto's STORED `ehKit` — the kit section shows on every link of a kit. */
  produtoEhKit: boolean;
  /** The actions' state and handlers — owned by the editor (its rule R2). */
  acoes: AcoesShopee;
  /** The listing drafts' state and handlers (#1911 P10) — owned by the editor. */
  rascunhos: RascunhosShopee;
}

/**
 * One Shopee listing (`data-testid="shopee-anuncio-<linkDocId>"`), top to
 * bottom: its state, what was refused on it, what Shopee says is wrong with it,
 * the template entry the produto's tabela de medidas holds for this listing
 * (never what a publish sent — residual 7), the kit section (a native kit, or
 * any listing of a kit produto), on demand its models — then the outcome of the
 * last action on it, and the action row.
 *
 * A DRAFT (`ehRascunhoShopee`, `@delfrance/schemas` — #1911 P10; the editor
 * decides it, `RascunhosShopee.propsDe`) shows its editor (`RascunhoShopee`)
 * where the action row would be, and the size-chart
 * line reads the category the operator is EDITING, not the stored one. A
 * listing that was a draft being edited when it got published says so above
 * its state — the unsaved edits were not applied, and that is never silent.
 *
 * Every value shown comes from the live link document (or, for the models, a
 * one-shot read): an action calls an apps/shopee route, and the block repaints
 * from the snapshot that route's write-back lands in. Presentational — the
 * open/closed "Variações", the outcomes, the draft being edited and the write
 * in flight belong to the editor (its rule R2).
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
  produtoEhKit,
  acoes,
  rascunhos,
}: AnuncioShopeeBlockProps) {
  const desfecho = acoes.desfechoDe(linkDocId);
  // `null` unless the editor decided a DRAFT block for this link — by the
  // schemas' `ehRascunhoShopee`, ONE gate (#1369): a native-kit link with no
  // `item_id` is no draft and keeps the action row's "código inválido" line.
  const rascunho = rascunhos.propsDe(conta, linkDocId);
  const avisoDoRascunho = rascunhos.avisoDe(linkDocId);
  return (
    <Card withBorder padding="sm" data-testid={`shopee-anuncio-${linkDocId}`}>
      <Stack gap="sm">
        <Text fw={600} size="sm">
          {textoPreenchido(link.item_name) ?? 'Anúncio sem título'}
        </Text>
        {avisoDoRascunho !== null && (
          <Alert
            color="orange"
            variant="light"
            withCloseButton
            closeButtonLabel="Dispensar aviso"
            onClose={() => rascunhos.dispensarAviso(linkDocId)}
            data-testid={`shopee-rascunho-aviso-${linkDocId}`}
          >
            {avisoDoRascunho}
          </Alert>
        )}
        <StatusAnuncioShopee link={link} shopId={conta.shopId} />
        <RecusasAnuncioShopee link={link} agoraMs={agoraMs} />
        <ViolacoesAnuncioShopee link={link} />
        <Divider />
        <TabelaMedidasShopeeResumo
          tabelaMedidas={tabelaMedidas}
          contaId={contaDoAnuncioLegivel ? conta.id : null}
          // A draft: the category being EDITED — the one its publish would use.
          categoryId={rascunho !== null ? rascunho.bloco.valores.category_id : link.category_id}
        />
        <KitAnuncioShopee
          db={db}
          produtoId={produtoId}
          contaId={conta.id}
          linkDocId={linkDocId}
          link={link}
          produtoEhKit={produtoEhKit}
          acoes={acoes}
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
        {rascunho !== null ? (
          <RascunhoShopee {...rascunho} />
        ) : (
          <AcoesAnuncioShopee contaId={conta.id} linkDocId={linkDocId} link={link} acoes={acoes} />
        )}
      </Stack>
    </Card>
  );
}
