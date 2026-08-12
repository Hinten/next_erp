'use client';

import { useCallback, useRef, useState } from 'react';
import { Button, Group, Modal, Text } from '@mantine/core';

/**
 * A Promise-based confirm dialog — `@mantine/modals` isn't a dependency, so we
 * render a controlled `<Modal>` and resolve a stored promise on the operator's
 * choice. Used by the Salvar confirm-loop (`evaluatePreSave` returns `confirm`
 * gates the operator must acknowledge) and by the etiqueta provider's
 * `confirmRisk` (the already-posted reprint ack).
 */
export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** style the confirm button as a risky action (orange). */
  danger?: boolean;
}

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export interface ConfirmHandle {
  /** Open the dialog; resolves `true` on confirm, `false` on cancel/close. */
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  /** Mount this once near the screen root. */
  element: React.ReactNode;
}

export function useConfirm(): ConfirmHandle {
  const [pending, setPending] = useState<Pending | null>(null);
  // Guard against a resolve firing twice (confirm click + onClose).
  const settledRef = useRef(false);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      settledRef.current = false;
      setPending({ ...opts, resolve });
    });
  }, []);

  const settle = useCallback(
    (ok: boolean) => {
      if (settledRef.current) return;
      settledRef.current = true;
      pending?.resolve(ok);
      setPending(null);
    },
    [pending],
  );

  const element = (
    <Modal
      opened={pending !== null}
      onClose={() => settle(false)}
      title={pending?.title ?? ''}
      centered
    >
      <Text size="sm">{pending?.message}</Text>
      <Group justify="flex-end" mt="md">
        <Button variant="default" onClick={() => settle(false)}>
          {pending?.cancelLabel ?? 'Cancelar'}
        </Button>
        <Button color={pending?.danger ? 'orange' : undefined} onClick={() => settle(true)}>
          {pending?.confirmLabel ?? 'Continuar'}
        </Button>
      </Group>
    </Modal>
  );

  return { confirm, element };
}
