'use client';

/**
 * Awaitable confirmation dialog — the imperative `confirm()` bridge the
 * devolução save-time flows need (the legacy Flutter dialogs were awaited
 * mid-save). `useConfirmDialog` returns a promise-returning `confirm(opts)`
 * plus the `element` to render once per view; the Modal is closable ONLY via
 * the Sim/Não buttons (the legacy dialogs were `barrierDismissible: false`).
 */
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';

export interface ConfirmDialogOptions {
  title: string;
  message: ReactNode;
  /** Defaults to "Sim". */
  confirmLabel?: string;
  /** Defaults to "Não". */
  cancelLabel?: string;
}

export interface UseConfirmDialogResult {
  /** Open the dialog and resolve with the user's answer. */
  confirm: (opts: ConfirmDialogOptions) => Promise<boolean>;
  /** Render once in the view that owns the hook. */
  element: ReactNode;
}

export function useConfirmDialog(): UseConfirmDialogResult {
  const [opts, setOpts] = useState<ConfirmDialogOptions | null>(null);
  // The pending promise's resolver — a ref, not state: it never affects
  // rendering and must be settled synchronously from the button handlers.
  const resolveRef = useRef<((answer: boolean) => void) | null>(null);

  const confirm = useCallback(
    (next: ConfirmDialogOptions) =>
      new Promise<boolean>((resolve) => {
        // A dangling previous promise (should not happen — dialogs are awaited
        // sequentially) resolves as "Não" so no caller hangs forever.
        resolveRef.current?.(false);
        resolveRef.current = resolve;
        setOpts(next);
      }),
    [],
  );

  function settle(answer: boolean) {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setOpts(null);
    resolve?.(answer);
  }

  const element = (
    <Modal
      opened={opts !== null}
      onClose={() => settle(false)}
      title={opts?.title}
      centered
      withCloseButton={false}
      closeOnClickOutside={false}
      closeOnEscape={false}
    >
      <Stack>
        {typeof opts?.message === 'string' ? <Text>{opts.message}</Text> : opts?.message}
        <Group justify="flex-end">
          <Button variant="subtle" onClick={() => settle(false)}>
            {opts?.cancelLabel ?? 'Não'}
          </Button>
          <Button onClick={() => settle(true)}>{opts?.confirmLabel ?? 'Sim'}</Button>
        </Group>
      </Stack>
    </Modal>
  );

  return { confirm, element };
}
