'use client';

import { Alert, Fieldset, SimpleGrid } from '@mantine/core';
import type { ProdutoMercadoLivreLink } from '@delfrance/schemas';
import { formatReais } from '@delfrance/core/money';

import { EMPTY_VALUE, ListingField, textOr } from './ListingField';

/** ML caps a listing at 10 pictures; publish truncates to the first 10. */
const MAX_PICTURES = 10;

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
 * The listing fields the operator does **not** own, read-only.
 *
 * `precoPublicado`, `comissao` and `freteGratis` are written by publish and the
 * price sync; rendering them as inputs would invite a patch that races those
 * writers, which is precisely what the operator-owned allow-list exists to
 * prevent.
 *
 * ⚠️ Values are plain text on purpose — see the note in `ListingField`. A
 * labelled control here would break the e2e assertion that proves the
 * first-publish "Tipo de anúncio" Select is absent once published.
 */
export function ListingDetails({ link, produtoFotoCount }: ListingDetailsProps) {
  const cols = { base: 1, sm: 2, xl: 3 };

  return (
    <>
      <Fieldset legend="Publicação" variant="unstyled">
        <SimpleGrid cols={cols} spacing="sm" verticalSpacing="xs">
          <ListingField label="Preço publicado">
            {link.precoPublicado == null ? EMPTY_VALUE : formatReais(link.precoPublicado)}
          </ListingField>
          <ListingField label="Comissão">
            {link.comissao == null ? EMPTY_VALUE : formatReais(link.comissao)}
          </ListingField>
          <ListingField label="Frete grátis">{link.freteGratis ? 'Sim' : 'Não'}</ListingField>
          <ListingField label="Fotos do produto">
            {produtoFotoCount == null ? EMPTY_VALUE : `${produtoFotoCount} foto(s)`}
          </ListingField>
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
