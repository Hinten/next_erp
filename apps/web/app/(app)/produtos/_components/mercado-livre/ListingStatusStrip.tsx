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
 *  - a link to the **live listing**.
 */
export function ListingStatusStrip({
  link,
  canWrite,
  disabled,
  rechecking,
  onReverificar,
}: ListingStatusStripProps) {
  const estado = parseEstado(link.estado);
  const model = listingModel(link);
  const latched = isStockLatched(link);
  const permalink = listingPermalink(link);

  // `errors` is written by the publish flow, the price sync AND the stock
  // sender, so the title must not blame any one of them (#781).
  const persistedErrors = (link.errors ?? []).filter(
    (e): e is string => typeof e === 'string' && e.length > 0,
  );
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
            <Anchor href={permalink} target="_blank" rel="noreferrer" size="sm">
              ver no Mercado Livre
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

      {persistedErrors.length > 0 && (
        <Alert color="red" variant="light" title="Última falha do Mercado Livre">
          <List size="sm">
            {persistedErrors.map((e) => (
              <List.Item key={e}>{e}</List.Item>
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
