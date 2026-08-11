'use client';

import { Alert, Fieldset, SimpleGrid, Text } from '@mantine/core';
import type { ProdutoMercadoLivreLink } from '@delfrance/schemas';
import { formatReais } from '@delfrance/core/money';

import { EMPTY_VALUE, ListingField, textOr } from './ListingField';

/** ML caps a listing at 10 pictures; publish truncates to the first 10. */
const MAX_PICTURES = 10;

/** The three preset `channels` combinations the legacy offered. */
function channelsLabel(channels: string[] | null | undefined): string {
  const set = new Set(channels ?? []);
  if (set.size === 0) return EMPTY_VALUE;
  const marketplace = set.has('marketplace');
  const mshops = set.has('mshops');
  if (marketplace && mshops) return 'Todos';
  if (marketplace) return 'Mercado Livre';
  if (mshops) return 'Mercado Shops';
  return [...set].join(', ');
}

export interface ListingDetailsProps {
  link: ProdutoMercadoLivreLink;
  /**
   * The produto's own photo count — publish derives listing pictures from it.
   *
   * **`null` means "not known yet"**, not "zero". The count comes from a live
   * snapshot that reports `undefined` on its first render, and collapsing that
   * to `0` made the "publicação será bloqueada" alert flash on every open, for
   * every produto — a false alarm about a blocked publish is exactly the kind
   * of warning that teaches operators to ignore the real one.
   */
  produtoFotoCount: number | null;
}

/**
 * The listing's stored fields, read-only.
 *
 * Every one of these is a real column on `produtoMercadoLivreLink` that the
 * screen never surfaced — título, descrição, canais, tarifa de frete,
 * crossdocking, comissão, vídeo — so an operator could neither see what was
 * about to be sent nor tell why ML rejected it. Showing them is the smallest
 * useful step and it is independently reviewable; U5 turns the operator-owned
 * ones into inputs.
 *
 * ⚠️ Values are plain text on purpose — see the note in `ListingField`. A
 * labelled control here would break the e2e assertion that proves the
 * first-publish "Tipo de anúncio" Select is absent once published.
 */
export function ListingDetails({ link, produtoFotoCount }: ListingDetailsProps) {
  const cols = { base: 1, sm: 2, xl: 3 };

  return (
    <>
      <Fieldset legend="Dados gerais" variant="unstyled">
        <SimpleGrid cols={cols} spacing="sm" verticalSpacing="xs">
          <ListingField label="Título do anúncio">{textOr(link.title)}</ListingField>
          <ListingField label="Condição">
            {link.condition === 'used' ? 'Usado' : 'Novo'}
          </ListingField>
          <ListingField label="Canais">{channelsLabel(link.channels)}</ListingField>
          <ListingField label="Categoria">{textOr(link.category_id)}</ListingField>
          <ListingField label="Descrição" span>
            {link.descricao?.trim() ? (
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {link.descricao}
              </Text>
            ) : (
              <Text size="sm" c="dimmed">
                Sem descrição própria — a publicação usa a descrição do produto.
              </Text>
            )}
          </ListingField>
        </SimpleGrid>
      </Fieldset>

      <Fieldset legend="Comercial" variant="unstyled">
        <SimpleGrid cols={cols} spacing="sm" verticalSpacing="xs">
          {/* Plain text, never a labelled control — see the file header. */}
          <ListingField label="Tipo de anúncio">{textOr(link.listing_type_id)}</ListingField>
          <ListingField label="Preço publicado">
            {link.precoPublicado == null ? EMPTY_VALUE : formatReais(link.precoPublicado)}
          </ListingField>
          <ListingField label="Comissão">
            {link.comissao == null ? EMPTY_VALUE : formatReais(link.comissao)}
          </ListingField>
          <ListingField label="Tarifa de frete">
            {link.tarifaFrete == null ? EMPTY_VALUE : formatReais(link.tarifaFrete)}
          </ListingField>
          <ListingField label="Frete grátis">{link.freteGratis ? 'Sim' : 'Não'}</ListingField>
          <ListingField label="Crossdocking">
            {link.crossdocking == null ? EMPTY_VALUE : `${link.crossdocking} dia(s)`}
          </ListingField>
        </SimpleGrid>
      </Fieldset>

      <Fieldset legend="Mídia" variant="unstyled">
        <SimpleGrid cols={cols} spacing="sm" verticalSpacing="xs">
          <ListingField label="Fotos do produto">
            {produtoFotoCount == null ? EMPTY_VALUE : `${produtoFotoCount} foto(s)`}
          </ListingField>
          <ListingField label="Vídeo (YouTube)">{textOr(link.video_id)}</ListingField>
        </SimpleGrid>
        {/* Both of these are 422s waiting to happen, surfaced BEFORE the
            operator clicks publish and gets a rejection they can't read.
            Neither fires on a null count — see the prop docs. */}
        {produtoFotoCount === 0 && (
          <Alert color="yellow" variant="light" mt="xs">
            Produto sem fotos — a publicação será bloqueada. Adicione fotos na aba Fotos.
          </Alert>
        )}
        {produtoFotoCount != null && produtoFotoCount > MAX_PICTURES && (
          <Alert color="yellow" variant="light" mt="xs">
            O Mercado Livre publica no máximo {MAX_PICTURES} fotos; as demais são ignoradas.
          </Alert>
        )}
      </Fieldset>
    </>
  );
}
