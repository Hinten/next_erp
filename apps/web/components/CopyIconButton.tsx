'use client';

/**
 * Shared copy-to-clipboard icon button — the CopyButton + Tooltip + ActionIcon
 * (IconCopy → IconCheck) combo used by the pedido NF/frete hover cards, the
 * enviNfe detail chave list, the "Verificar novamente" results modal and
 * `XmlBlock`. Tooltip shows `label` ("Copiar …") and flips to "Copiado!" for
 * 1.5s after a copy.
 */
import { ActionIcon, CopyButton, Tooltip, type FloatingPosition } from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';

export interface CopyIconButtonProps {
  /** The text copied to the clipboard. */
  readonly value: string;
  /** Tooltip text (pre-copy). Also the aria-label unless `ariaLabel` is set. */
  readonly label: string;
  /** Accessible name override — e.g. `Copiar chave <chave>` per row. */
  readonly ariaLabel?: string;
  /** Tooltip placement (default `top`). */
  readonly position?: FloatingPosition;
}

export function CopyIconButton({ value, label, ariaLabel, position = 'top' }: CopyIconButtonProps) {
  return (
    <CopyButton value={value} timeout={1500}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? 'Copiado!' : label} withArrow withinPortal position={position}>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            onClick={copy}
            aria-label={ariaLabel ?? label}
          >
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </ActionIcon>
        </Tooltip>
      )}
    </CopyButton>
  );
}
