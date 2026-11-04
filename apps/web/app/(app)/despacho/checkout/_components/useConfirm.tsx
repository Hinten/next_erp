'use client';

import { useCallback, useRef, useState } from 'react';
import { Button, Checkbox, Group, Modal, Text } from '@mantine/core';

import { ROTULO_CIENCIA_RISCO } from '@/app/(app)/pedidos/_components/ConfirmDialog';

/**
 * A Promise-based confirm dialog — `@mantine/modals` isn't a dependency, so we
 * render a controlled `<Modal>` and resolve a stored promise on the operator's
 * choice. Used by the Salvar confirm-loop (`evaluatePreSave` returns `confirm`
 * gates the operator must acknowledge), by the etiqueta provider's
 * `confirmRisk` (the already-posted reprint ack) and by its `confirmarCiente`
 * (the Loja Integrada paid re-check's acknowledged risk, `ciencia: true`).
 *
 * `ciencia: true` shows a "Estou ciente do risco" checkbox and keeps the
 * confirm button DISABLED until it is ticked. The tick belongs to ONE
 * question: every new question opens unticked.
 */
export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** style the confirm button as a risky action (orange). */
  danger?: boolean;
  /** Require the "Estou ciente do risco" tick before the confirm button enables. */
  ciencia?: true;
}

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export interface ConfirmHandle {
  /** Open the dialog; resolves `true` on confirm, `false` on cancel/close. */
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  /**
   * Mount this once near the screen root — **NEVER inside another `<Modal>`.**
   *
   * Not a style preference: Mantine's `keepMounted` defaults to `false`, so the
   * parent modal closing UNMOUNTS this element while a `confirm()` is still
   * pending. The stored `resolve` (see `settle` below) is then stranded and
   * every caller awaiting it hangs forever — there is no timeout and no error,
   * just a promise that never settles. #1096 wedged the despacho reprint print
   * mutex exactly that way: `usePrintInFlight`'s `finally` never ran, so both
   * reprint buttons spun for the life of the pane.
   *
   * Portalling does not save you — `ModalBase` portals to `document.body`
   * regardless of JSX nesting, so a nested dialog LOOKS correct right up until
   * the parent closes.
   */
  element: React.ReactNode;
}

export function useConfirm(): ConfirmHandle {
  const [pending, setPending] = useState<Pending | null>(null);
  // The "Estou ciente do risco" tick of the question on screen.
  const [ciente, setCiente] = useState(false);
  // Guard against a resolve firing twice (confirm click + onClose).
  const settledRef = useRef(false);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      settledRef.current = false;
      setCiente(false);
      setPending({ ...opts, resolve });
    });
  }, []);

  const settle = useCallback(
    (ok: boolean) => {
      if (settledRef.current) return;
      settledRef.current = true;
      pending?.resolve(ok);
      setCiente(false);
      setPending(null);
    },
    [pending],
  );

  const exigeCiencia = pending?.ciencia === true;

  const element = (
    <Modal
      opened={pending !== null}
      onClose={() => settle(false)}
      title={pending?.title ?? ''}
      centered
    >
      <Text size="sm">{pending?.message}</Text>
      {exigeCiencia && (
        <Checkbox
          mt="md"
          label={ROTULO_CIENCIA_RISCO}
          checked={ciente}
          onChange={(e) => setCiente(e.currentTarget.checked)}
        />
      )}
      <Group justify="flex-end" mt="md">
        <Button variant="default" onClick={() => settle(false)}>
          {pending?.cancelLabel ?? 'Cancelar'}
        </Button>
        <Button
          color={pending?.danger ? 'orange' : undefined}
          onClick={() => settle(true)}
          disabled={exigeCiencia && !ciente}
        >
          {pending?.confirmLabel ?? 'Continuar'}
        </Button>
      </Group>
    </Modal>
  );

  return { confirm, element };
}
