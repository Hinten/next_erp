'use client';

import { useState } from 'react';
import { Alert, Button, Group, List, Modal, Stack, Switch, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

/** A kit that uses the produto being edited as one of its components. */
export interface ReferencingKit {
  id: string;
  nome: string;
}

export interface EhKitFieldProps {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /**
   * Other kits that currently use THIS produto as a component (#246). Turning
   * this produto INTO a kit while it's still a component creates a kit-of-kit,
   * which can corrupt stock math — so the promotion is gated behind a warning.
   * This is a capped preview (see {@link hasMore}).
   */
  referencedByKits: ReferencingKit[];
  /** True when more kits reference this produto than the capped `referencedByKits` shows. */
  hasMore?: boolean;
  /**
   * The referenced-by query is still loading. The toggle is disabled until it
   * resolves so a promotion can't slip past the warning during the initial read.
   */
  loading?: boolean;
  /**
   * The kit root has an ACTIVE native Shopee kit link (`useKitNativoShopee`,
   * the shared `ehKitNativoAtivo`; step 19, #1527). While it does, a
   * NON-BLOCKING notice says Shopee keeps the kit's old recipe (L4(1)) —
   * whatever the «É kit» switch currently says: the LINK is the only authority.
   * Editar-only: a new produto can have no link.
   */
  kitNativoShopee?: boolean;
}

/**
 * The "É kit" toggle with a kit-of-kit safety warning (#246). The legacy Flutter
 * app (and the new picker) only guard the forward direction — a kit can't pick a
 * kit as a component — but neither catches **promoting** a produto that is
 * already a component into a kit. That silently creates a kit-of-kit. Here,
 * flipping the switch ON while the produto is referenced by other kits asks for
 * explicit confirmation (warning it can break stock); a persistent alert stays
 * visible while it remains a kit AND still referenced. Editar-only — a brand-new
 * produto (novo) can't be referenced yet.
 *
 * It also carries the Shopee native-kit notice (step 19, #1527, L4(1)): while
 * the produto's root has an active native Shopee kit link, a yellow alert says
 * Shopee keeps the kit's composition frozen. It does NOT read the switch: turning
 * «É kit» OFF clears the whole recipe on save (`componentesKit: null`), the most
 * destructive recipe change there is, so the notice must stay up exactly then.
 * It never blocks or confirms anything — a recipe change is allowed (L4); after
 * the save the `shopeeKitReceitaDivergente` aviso tracks the divergence.
 */
export function EhKitField({
  label,
  value,
  onChange,
  disabled,
  referencedByKits,
  hasMore,
  loading,
  kitNativoShopee,
}: EhKitFieldProps) {
  const [confirming, setConfirming] = useState(false);
  const referenced = referencedByKits.length > 0;
  const isKit = value === true;
  // "5+" when the capped list under-reports the true number of referencing kits.
  const countLabel = `${referencedByKits.length}${hasMore ? '+' : ''}`;

  const handleSwitch = (checked: boolean) => {
    // Only the promotion (off→on) while referenced needs confirmation; turning a
    // kit back off is always safe.
    if (checked && referenced) {
      setConfirming(true);
      return;
    }
    onChange(checked);
  };

  return (
    <Stack gap="xs">
      <Switch
        label={label}
        checked={isKit}
        onChange={(e) => handleSwitch(e.currentTarget.checked)}
        // Disabled while the referenced-by query loads, so a promotion can't slip
        // past the warning before we know whether this produto is a component.
        disabled={disabled || loading}
      />

      {kitNativoShopee === true && (
        <Alert
          color="yellow"
          variant="light"
          icon={<IconAlertTriangle size={18} />}
          title="Este kit é um kit nativo da Shopee"
          data-testid="aviso-kit-nativo-shopee"
        >
          <Text size="sm">
            A Shopee não permite alterar os componentes nem as quantidades de um kit já criado. Se
            você mudar a composição aqui, o kit na Shopee continua com a receita antiga e o estoque
            que ela calcula pode ficar errado. Depois de salvar, um aviso fica aberto até o kit ser
            recriado ou a composição voltar à que está na Shopee.
          </Text>
        </Alert>
      )}

      {isKit && referenced && (
        <Alert
          color="red"
          variant="light"
          icon={<IconAlertTriangle size={18} />}
          title="Este produto é componente de outros kits"
        >
          <Text size="sm">
            Mantê-lo como kit cria um <b>kit dentro de kit</b>, o que pode causar inconsistências no
            cálculo de estoque. Kits que usam este produto como componente:
          </Text>
          <List size="sm" mt={4}>
            {referencedByKits.map((k) => (
              <List.Item key={k.id}>{k.nome}</List.Item>
            ))}
            {hasMore && <List.Item c="dimmed">… e outros kits</List.Item>}
          </List>
        </Alert>
      )}

      <Modal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title="Tornar este produto um kit?"
        centered
      >
        <Stack>
          <Text size="sm">
            Este produto é usado como componente em <b>{countLabel}</b> kit(s):
          </Text>
          <List size="sm">
            {referencedByKits.map((k) => (
              <List.Item key={k.id}>{k.nome}</List.Item>
            ))}
            {hasMore && <List.Item c="dimmed">… e outros kits</List.Item>}
          </List>
          <Text size="sm" c="red">
            Transformá-lo em kit cria um <b>kit dentro de kit</b>, o que pode causar inconsistências
            no estoque. Prossiga apenas se tiver certeza do que está fazendo.
          </Text>
          <Group justify="flex-end">
            <Button type="button" variant="default" onClick={() => setConfirming(false)}>
              Cancelar
            </Button>
            <Button
              type="button"
              color="red"
              onClick={() => {
                onChange(true);
                setConfirming(false);
              }}
            >
              Prosseguir mesmo assim
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
