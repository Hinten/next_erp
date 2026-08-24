'use client';

import { Button, Group, Modal, Select, Stack, Text } from '@mantine/core';

import { DEFAULT_LISTING_TYPE, LISTING_TYPE_OPTIONS } from '@/lib/mercado-livre/listingFields';

export interface NovoAnuncioModalProps {
  opened: boolean;
  onClose: () => void;
  /** Named in the title, so the operator sees which account they are adding to. */
  contaNome: string;
  /** True while the account already has at least one anúncio. */
  adicional: boolean;
  listingTypeId: string;
  onListingTypeChange: (listingTypeId: string) => void;
  onConfirm: () => void;
  criando: boolean;
}

/**
 * Where a new Mercado Livre anúncio is started.
 *
 * ## Why a modal rather than a control in the panel
 *
 * The "Tipo de anúncio" select used to sit inline beside "Preparar anúncio", and
 * only for an account with **no** listing — because once a listing exists, its
 * `listing_type_id` is a field of its own form, and a second control for the same
 * value in the same panel gives the operator two inputs for one thing (and hands
 * the e2e locator two elements to choose between).
 *
 * A produto can now carry several anúncios on one account, so that constraint
 * would rule the inline control out permanently. Moving it here resolves it
 * instead: the choice is made once, at the moment of creation, and from then on
 * lives only in the listing's own form. One control serves both the empty and
 * the non-empty account.
 */
export function NovoAnuncioModal({
  opened,
  onClose,
  contaNome,
  adicional,
  listingTypeId,
  onListingTypeChange,
  onConfirm,
  criando,
}: NovoAnuncioModalProps) {
  return (
    <Modal opened={opened} onClose={onClose} title={`Novo anúncio — ${contaNome}`} centered>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {adicional
            ? 'Esta conta já tem anúncio(s) deste produto. O novo começa como rascunho, sem nada enviado ao Mercado Livre.'
            : 'O anúncio começa como rascunho. Escolha a categoria e revise os dados antes de publicar.'}
        </Text>
        <Select
          label="Tipo de anúncio"
          data={[...LISTING_TYPE_OPTIONS]}
          value={listingTypeId}
          onChange={(v) => onListingTypeChange(v ?? DEFAULT_LISTING_TYPE)}
          allowDeselect={false}
          disabled={criando}
        />
        <Group justify="flex-end" gap="sm">
          <Button type="button" variant="default" onClick={onClose} disabled={criando}>
            Cancelar
          </Button>
          {/* Single-flight: the only thing standing between a double-click and
              two drafts, since an additional draft takes a fresh auto-id and so
              has nothing to collide with. */}
          <Button type="button" onClick={onConfirm} loading={criando}>
            Criar anúncio
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
