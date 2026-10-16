'use client';

import { Anchor, Badge, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import { formatReais } from '@delfrance/core/money';
import {
  ESTADO_ANUNCIO_SHOPEE,
  ehKitNativoAtivo,
  ehVinculoSubstituido,
  type ProdutoShopeeLink,
} from '@delfrance/schemas';

import {
  COR_ESTADO_ANUNCIO_SHOPEE,
  ROTULO_ESTADO_ANUNCIO_SHOPEE,
  estadoAnuncioShopeeLido,
  formatarInstanteShopee,
  itemIdDoAnuncioShopee,
  urlDoAnuncioShopee,
} from '@/lib/shopee/anuncioProduto';
import { EMPTY_VALUE, ListingField } from '../marketplace/ListingField';
import { numeroFinito, textoPreenchido } from './campos';

export interface StatusAnuncioShopeeProps {
  link: ProdutoShopeeLink;
  /** The conta's `shop_id`, unvalidated — half of the storefront URL. */
  shopId: unknown;
}

/**
 * A listing's state, as the ERP last recorded it: the folded `estadoAnuncio`
 * badge, the orthogonal deboost, whether another link superseded it, and the
 * read-only facts the senders stamped (ids, dates, the last stock and price
 * sent). Rendered with `ListingField` — plain text, never a labelled control.
 *
 * The kit badge is the schemas' `ehKitNativoAtivo` — THE live-native-kit
 * predicate the publish dispatcher and the editor's pre-save notice share: "Kit
 * nativo" when it holds, "Kit nativo (inativo)" for a link Shopee reported as a
 * kit that is removed, superseded or names no listing (never a web copy, #1369).
 *
 * ⚠️ `estadoAnuncio: null` reads "Não verificado", never a dead state: it means
 * NEVER FOLDED (every link step 9 imported), which is not evidence of anything —
 * the same reading `anuncioShopeeVivo` and `podeMoverAnuncioShopee` give it.
 */
export function StatusAnuncioShopee({ link, shopId }: StatusAnuncioShopeeProps) {
  const itemId = itemIdDoAnuncioShopee(link.item_id);
  const url = urlDoAnuncioShopee(shopId, link.item_id);
  const substituidoPor = ehVinculoSubstituido(link) ? link.substituidoPorLinkDocId : null;
  const substituidoEm = formatarInstanteShopee(link.substituidoEm);
  const ultimaPublicacaoEm = link.ultimaPublicacao ? link.ultimaPublicacao.em : null;
  const estoqueEnviado = numeroFinito(link.estoqueEnviado);
  const precoEnviado = numeroFinito(link.precoEnviado);

  return (
    <Stack gap="xs">
      <Group gap="xs">
        <EstadoBadge link={link} publicado={itemId !== null} />
        {link.deboost === true && (
          <Badge color="orange" variant="light">
            Rebaixado na busca
          </Badge>
        )}
        {substituidoPor !== null && (
          <Badge color="grape" variant="light">
            Substituído
          </Badge>
        )}
        {ehKitNativoAtivo(link) ? (
          <Badge color="grape" variant="filled">
            Kit nativo
          </Badge>
        ) : (
          link.kitNativo === true && (
            <Badge color="gray" variant="outline">
              Kit nativo (inativo)
            </Badge>
          )
        )}
        {url !== null && (
          <Anchor href={url} target="_blank" rel="noopener noreferrer" size="sm">
            Ver na Shopee
          </Anchor>
        )}
      </Group>
      {substituidoPor !== null && (
        <Text size="xs" c="dimmed">
          Substituído pelo vínculo {substituidoPor}
          {substituidoEm === null ? '' : ` em ${substituidoEm}`}. Ele ainda pode estar vendendo na
          Shopee até ser removido lá.
        </Text>
      )}
      <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="sm" verticalSpacing="xs">
        <ListingField label="Anúncio na Shopee">
          {itemId === null ? EMPTY_VALUE : String(itemId)}
        </ListingField>
        <ListingField label="Status na Shopee">
          {textoPreenchido(link.item_status) ?? EMPTY_VALUE}
        </ListingField>
        <ListingField label="Categoria">
          {numeroFinito(link.category_id) === null ? EMPTY_VALUE : String(link.category_id)}
        </ListingField>
        <ListingField label="Primeira publicação">
          {formatarInstanteShopee(link.publicadoEm) ?? EMPTY_VALUE}
        </ListingField>
        <ListingField label="Última publicação">
          {formatarInstanteShopee(ultimaPublicacaoEm) ?? EMPTY_VALUE}
        </ListingField>
        <ListingField label="Estoque enviado">
          {estoqueEnviado === null
            ? EMPTY_VALUE
            : comData(String(estoqueEnviado), link.estoqueEnviadoEm)}
        </ListingField>
        <ListingField label="Preço enviado">
          {precoEnviado === null
            ? EMPTY_VALUE
            : comData(formatReais(precoEnviado), link.precoEnviadoEm)}
        </ListingField>
      </SimpleGrid>
    </Stack>
  );
}

/** `valor (em <data>)`, or the value alone when the stamp is unreadable. */
function comData(valor: string, em: unknown): string {
  const quando = formatarInstanteShopee(em);
  return quando === null ? valor : `${valor} (em ${quando})`;
}

/**
 * The folded state. A link with no listing yet is "Não publicado" whatever it
 * stores; a published one reads its `estadoAnuncio`, `null` (and a value this
 * build does not know) as "Não verificado". "Pausado" says WHO paused it:
 * `pausadoPeloErp` is the only thing that separates a seller pause from a
 * Shopee hold — both are `UNLIST` on the wire.
 */
function EstadoBadge({ link, publicado }: { link: ProdutoShopeeLink; publicado: boolean }) {
  if (!publicado) {
    return (
      <Badge color="gray" variant="light">
        Não publicado
      </Badge>
    );
  }
  const estado = estadoAnuncioShopeeLido(link.estadoAnuncio);
  if (estado === null) {
    return (
      <Badge color="gray" variant="outline">
        Não verificado
      </Badge>
    );
  }
  const rotulo = ROTULO_ESTADO_ANUNCIO_SHOPEE[estado];
  const sufixo =
    estado === ESTADO_ANUNCIO_SHOPEE.pausado
      ? link.pausadoPeloErp === true
        ? ' pelo ERP'
        : ' na Shopee'
      : '';
  return (
    <Badge color={COR_ESTADO_ANUNCIO_SHOPEE[estado]} variant="light">
      {rotulo}
      {sufixo}
    </Badge>
  );
}
