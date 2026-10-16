'use client';

import { useMemo } from 'react';
import type { Firestore } from 'firebase/firestore';
import { Badge, Card, Group, Stack, Text } from '@mantine/core';
import type { ProdutoShopeeLink } from '@delfrance/schemas';

import { ordenarVinculosShopee } from '@/lib/shopee/anuncioProduto';
import type { AcoesShopee } from './AcoesAnuncioShopee';
import { AnuncioShopeeBlock } from './AnuncioShopeeBlock';
import { AvisoReceitaKitShopee } from './AvisoReceitaKitShopee';
import { IncertoDoKit } from './KitAnuncioShopee';

/** One `prodshopee` row as the live snapshot hands it over (possibly the RAW doc — see `campos.ts`). */
export interface VinculoShopee {
  readonly id: string;
  readonly data: ProdutoShopeeLink;
}

/** One tab of the strip: a conta the query returned, or one a link names that it did not. */
export interface ContaShopee {
  readonly id: string;
  readonly nome: string;
  /** The conta's `shop_id`, unvalidated — the storefront URL checks it. */
  readonly shopId: unknown;
  readonly ativo: boolean;
  /** `false` for a tab built from a link's conta ref alone (no conta doc to show). */
  readonly encontrada: boolean;
  /**
   * `true` while that conta's by-id read has not answered — the tab must not
   * call it missing yet. Always `false` when `encontrada`.
   */
  readonly carregando: boolean;
}

/**
 * The produto's tabela de medidas, as far as the tab knows it. `ausente` is a
 * produto that names a tabela whose document does not exist (publish reports
 * that dangling ref itself; the tab only says it).
 */
export type TabelaMedidasDoProduto =
  | { readonly estado: 'sem-tabela' }
  | { readonly estado: 'carregando' }
  /** The ref names no `tabMedi` document (`lerRefTabelaDeMedidas`) — nothing was read. */
  | { readonly estado: 'ref-invalida'; readonly ref: string }
  | { readonly estado: 'ausente'; readonly id: string }
  | {
      readonly estado: 'tabela';
      readonly id: string;
      readonly nome: string;
      /** `tabelasMedidasShopee` verbatim — `lerEntradasShopeeDaConta` reads it. */
      readonly entradasShopee: unknown;
    };

export interface ContaShopeePanelProps {
  db: Firestore;
  produtoId: string;
  conta: ContaShopee;
  vinculos: readonly VinculoShopee[];
  /** `false` for the tab of links whose conta ref names no id — no size chart can be resolved for them. */
  contaDoAnuncioLegivel: boolean;
  tabelaMedidas: TabelaMedidasDoProduto;
  agoraMs: number;
  modelosAbertos: ReadonlySet<string>;
  onAlternarModelos: (linkDocId: string) => void;
  /** The produto's STORED `ehKit`. */
  produtoEhKit: boolean;
  /** The actions — `permitidas: false` on a tab whose conta the query did not return. */
  acoes: AcoesShopee;
}

/**
 * One Shopee conta's listings on this produto, in `ordenarVinculosShopee` order
 * (live, then superseded, then removed or never published). Presentational: the
 * editor owns every piece of state (its rule R2).
 *
 * Above the listings: the conta's open "kit with an old composition" aviso (only
 * for a conta holding a native-kit link), and an uncertain kit create whose link
 * this conta no longer lists — it still blocks the kit buttons, so it is never
 * left unexplained.
 */
export function ContaShopeePanel({
  db,
  produtoId,
  conta,
  vinculos,
  contaDoAnuncioLegivel,
  tabelaMedidas,
  agoraMs,
  modelosAbertos,
  onAlternarModelos,
  produtoEhKit,
  acoes,
}: ContaShopeePanelProps) {
  const ordenados = useMemo(() => ordenarVinculosShopee(vinculos), [vinculos]);
  const temKitNativo = vinculos.some((v) => v.data.kitNativo === true);
  const incerto = acoes.incertoDe(conta.id);
  const incertoSemBloco =
    incerto !== null && !vinculos.some((v) => v.id === incerto.corpo.linkDocId) ? incerto : null;

  return (
    <Card withBorder padding="md" data-testid={`shopee-conta-${conta.id}`}>
      <Stack gap="sm">
        <Group gap="xs">
          <Text fw={600}>{conta.nome}</Text>
          {conta.encontrada && !conta.ativo && (
            <Badge color="gray" variant="light">
              Conta inativa
            </Badge>
          )}
        </Group>

        {!conta.encontrada && (
          <Text size="sm" c="dimmed">
            {conta.carregando
              ? 'Carregando a conta Shopee destes anúncios…'
              : contaDoAnuncioLegivel
                ? 'Estes anúncios apontam para uma conta Shopee que não está cadastrada (ou que você não pode ver).'
                : 'Estes anúncios não indicam uma conta Shopee legível.'}
          </Text>
        )}

        {conta.encontrada && temKitNativo && (
          <AvisoReceitaKitShopee db={db} contaId={conta.id} produtoId={produtoId} />
        )}

        {incertoSemBloco !== null && (
          <IncertoDoKit contaId={conta.id} incerto={incertoSemBloco} acoes={acoes} />
        )}

        {ordenados.length === 0 && (
          <Text size="sm" c="dimmed">
            Este produto não tem anúncio nesta conta.
          </Text>
        )}

        {ordenados.map((v) => (
          <AnuncioShopeeBlock
            key={v.id}
            db={db}
            produtoId={produtoId}
            linkDocId={v.id}
            link={v.data}
            conta={conta}
            contaDoAnuncioLegivel={contaDoAnuncioLegivel}
            tabelaMedidas={tabelaMedidas}
            agoraMs={agoraMs}
            modelosAberto={modelosAbertos.has(v.id)}
            onAlternarModelos={onAlternarModelos}
            produtoEhKit={produtoEhKit}
            acoes={acoes}
          />
        ))}
      </Stack>
    </Card>
  );
}
