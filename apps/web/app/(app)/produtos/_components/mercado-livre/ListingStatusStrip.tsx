'use client';

import { Alert, Anchor, Badge, Button, Group, List, Stack, Text } from '@mantine/core';
import {
  ESTADO_PUBLICACAO_ML_LABELS,
  type EstadoPublicacaoMl,
  type ProdutoMercadoLivreLink,
} from '@delfrance/schemas';

import {
  isStockLatched,
  listingModel,
  listingPermalink,
  parseEstado,
} from '@/lib/mercado-livre/listingLinks';
import { splitCausas, textoDaCausa } from '@/lib/mercado-livre/listingCausas';

/** Badge colour per old-shape estado code. */
const ESTADO_COLORS: Record<EstadoPublicacaoMl, string> = {
  r: 'gray',
  a: 'blue',
  ep: 'blue',
  v: 'yellow',
  p: 'green',
  pa: 'yellow',
  c: 'gray',
  E: 'red',
  am: 'orange',
};

export interface ListingStatusStripProps {
  link: ProdutoMercadoLivreLink;
  /** Enables the latch escape hatch; false for a read-only operator. */
  canWrite: boolean;
  disabled: boolean;
  rechecking: boolean;
  onReverificar: () => void;
  /**
   * A listing URL the editor has already resolved from Mercado Livre — the
   * User-Products answer {@link listingPermalink} cannot compute on its own.
   * Once present the affordance is a plain anchor again, so a second click
   * costs no round trip.
   */
  urlResolvida?: string | null;
  /** True while {@link onAbrirAnuncio} is resolving this listing's URL. */
  abrindo?: boolean;
  /**
   * Ask the backend where this listing lives and open it. Omitted (or absent
   * along with a client) leaves an unresolvable listing with no affordance,
   * which is the pre-existing behaviour.
   */
  onAbrirAnuncio?: () => void;
}

/**
 * Everything the operator needs to know about a listing's current state with ML:
 * which model it uses, where it lives, what ML last said, and whether stock sync
 * is stopped.
 *
 * Split out of the old single-file tab so the same strip can head each listing
 * in the full editor. Three things are new here versus what shipped before:
 *
 *  - the **model badge** (User Products vs the legacy variations shape). Both
 *    coexist indefinitely and they behave differently on publish, so which one a
 *    listing uses must be visible without opening anything.
 *  - the raw **`status` / `sub_status`** ML reports. `estado` is our derived
 *    short code; these are what actually distinguishes "paused by me" from
 *    "paused by ML for `out_of_stock`", which is the difference between waiting
 *    and acting.
 *  - a link to the **live listing**. Legacy listings resolve client-side; a
 *    User-Products family's stored id addresses nothing public, so there the
 *    control asks the backend for the URL on click (`onAbrirAnuncio`) and turns
 *    into an ordinary anchor once it has one.
 */
export function ListingStatusStrip({
  link,
  canWrite,
  disabled,
  rechecking,
  onReverificar,
  urlResolvida,
  abrindo = false,
  onAbrirAnuncio,
}: ListingStatusStripProps) {
  const estado = parseEstado(link.estado);
  const model = listingModel(link);
  const latched = isStockLatched(link);
  // The resolved URL wins: `listingPermalink` answers null for a User-Products
  // family, whose stored id addresses nothing public.
  const permalink = urlResolvida ?? listingPermalink(link);
  // Published under User Products, where the stored id is a FAMILY and no
  // string transform reaches a page — so the affordance asks ML instead. Same
  // words either way: the operator should not have to know which of the two
  // coexisting models produced this listing.
  //
  // Deliberately scoped to that model rather than to "permalink == null": a
  // LEGACY id that yields no URL is malformed, and offering a control that can
  // only come back with "o anúncio não existe mais" would misdescribe it.
  const podeResolver =
    permalink == null &&
    model === 'user-products' &&
    (link.id ?? '') !== '' &&
    onAbrirAnuncio != null;

  // `errors` is written by the publish flow, the price sync AND the stock
  // sender, so the title must not blame any one of them (#781).
  const persistedErrors = (link.errors ?? []).filter(
    (e): e is string => typeof e === 'string' && e.length > 0,
  );
  // The structured half of the same diagnosis. `gerais` is what has no control
  // to sit on; per-field causes are rendered BY the control, inside ListingForm.
  const { gerais, avisos, temCausas } = splitCausas(link);
  const subStatus = (link.sub_status ?? []).filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );

  return (
    <Stack gap="xs">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="wrap">
          <Text size="sm">
            {link.id != null ? `Anúncio ${link.id}` : 'Rascunho — ainda não publicado'}
          </Text>
          {permalink != null && (
            <Anchor href={permalink} target="_blank" rel="noopener noreferrer" size="sm">
              ver no Mercado Livre
            </Anchor>
          )}
          {podeResolver && (
            <Anchor
              component="button"
              type="button"
              size="sm"
              onClick={onAbrirAnuncio}
              disabled={abrindo}
            >
              {abrindo ? 'abrindo…' : 'ver no Mercado Livre'}
            </Anchor>
          )}
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Badge
            variant="light"
            color={model === 'user-products' ? 'teal' : 'gray'}
            data-testid={`ml-modelo-${model}`}
          >
            {model === 'user-products' ? 'User Products' : 'Variações do anúncio'}
          </Badge>
          <Badge color={estado ? ESTADO_COLORS[estado] : 'gray'}>
            {estado ? ESTADO_PUBLICACAO_ML_LABELS[estado] : 'Desconhecido'}
          </Badge>
        </Group>
      </Group>

      {(link.status != null || subStatus.length > 0) && (
        // The raw ML values behind the derived estado — `paused` alone is the
        // seller's own pause, `paused` + `out_of_stock` is ML reacting to zero
        // stock, and only the second one resolves itself.
        <Text size="xs" c="dimmed">
          Mercado Livre: {link.status ?? 'sem status'}
          {subStatus.length > 0 ? ` · ${subStatus.join(', ')}` : ''}
        </Text>
      )}

      {/* Structured causes when we have them; the raw `errors` strings otherwise
          — a doc written by the Flutter app, or by this app before #1109, has
          `causas: null` and must keep showing what it does have. */}
      {temCausas
        ? gerais.length > 0 && (
            <Alert
              color="red"
              variant="light"
              title="Última falha do Mercado Livre"
              data-testid="ml-causas-gerais"
            >
              <List size="sm">
                {gerais.map((causa, i) => (
                  <List.Item key={`${causa.code ?? 'sem-codigo'}-${String(i)}`}>
                    {textoDaCausa(causa)}
                    {causa.code != null && (
                      <Text span size="xs" c="dimmed">
                        {' '}
                        · {causa.code}
                      </Text>
                    )}
                  </List.Item>
                ))}
              </List>
            </Alert>
          )
        : persistedErrors.length > 0 && (
            <Alert color="red" variant="light" title="Última falha do Mercado Livre">
              <List size="sm">
                {/* Index-qualified: two identical messages are legal and a bare
                    message key would collide. */}
                {persistedErrors.map((e, i) => (
                  <List.Item key={`${e}-${String(i)}`}>{e}</List.Item>
                ))}
              </List>
            </Alert>
          )}

      {/* ML applied these itself (`type: 'warning'` — *Guia para produtos →
          Validações*), so they are context, not work. Deliberately secondary:
          a warning styled like a rejection sends the operator hunting for a
          problem ML already solved. */}
      {avisos.length > 0 && (
        <Alert
          color="yellow"
          variant="light"
          title="Avisos do Mercado Livre"
          data-testid="ml-causas-avisos"
        >
          <Text size="xs" c="dimmed" mb={4}>
            O Mercado Livre ajustou estes pontos automaticamente.
          </Text>
          <List size="sm">
            {avisos.map((causa, i) => (
              <List.Item key={`${causa.code ?? 'sem-codigo'}-${String(i)}`}>
                {textoDaCausa(causa)}
              </List.Item>
            ))}
          </List>
        </Alert>
      )}

      {latched && (
        <Group gap="sm" align="center">
          <Button
            type="button"
            variant="default"
            size="xs"
            onClick={onReverificar}
            loading={rechecking}
            disabled={disabled || !canWrite}
          >
            Reverificar anúncio
          </Button>
          <Text size="xs" c="dimmed">
            O envio de estoque está parado para este anúncio.
          </Text>
        </Group>
      )}
    </Stack>
  );
}
