'use client';

/**
 * Awaitable confirmation dialog — the imperative `confirm()` bridge the
 * devolução save-time flows need (the legacy Flutter dialogs were awaited
 * mid-save). `useConfirmDialog` returns a promise-returning `confirm(opts)`
 * plus the `element` to render once per view; the Modal is closable ONLY via
 * the Sim/Não buttons (the legacy dialogs were `barrierDismissible: false`).
 *
 * `ciencia: true` turns a question into an acknowledged risk: the dialog shows
 * a "Estou ciente do risco" checkbox and its confirm button stays DISABLED
 * until the operator ticks it. The tick belongs to ONE question — every new
 * question opens unticked, so an answer given to the previous one can never
 * carry over.
 */
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Button, Checkbox, Group, Modal, Stack, Text } from '@mantine/core';

export interface ConfirmDialogOptions {
  title: string;
  message: ReactNode;
  /** Defaults to "Sim". */
  confirmLabel?: string;
  /** Defaults to "Não". */
  cancelLabel?: string;
  /** Require the "Estou ciente do risco" tick before the confirm button enables. */
  ciencia?: true;
}

/** The checkbox label of every acknowledged-risk question (the buy modal's own). */
export const ROTULO_CIENCIA_RISCO = 'Estou ciente do risco';

export interface UseConfirmDialogResult {
  /** Open the dialog and resolve with the user's answer. */
  confirm: (opts: ConfirmDialogOptions) => Promise<boolean>;
  /** Render once in the view that owns the hook. */
  element: ReactNode;
}

export function useConfirmDialog(): UseConfirmDialogResult {
  const [opts, setOpts] = useState<ConfirmDialogOptions | null>(null);
  // The "Estou ciente do risco" tick of the question on screen — reset by every
  // new question and every answer.
  const [ciente, setCiente] = useState(false);
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
        setCiente(false);
        setOpts(next);
      }),
    [],
  );

  function settle(answer: boolean) {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setCiente(false);
    setOpts(null);
    resolve?.(answer);
  }

  const exigeCiencia = opts?.ciencia === true;

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
        {exigeCiencia && (
          <Checkbox
            label={ROTULO_CIENCIA_RISCO}
            checked={ciente}
            onChange={(e) => setCiente(e.currentTarget.checked)}
          />
        )}
        <Group justify="flex-end">
          <Button variant="subtle" onClick={() => settle(false)}>
            {opts?.cancelLabel ?? 'Não'}
          </Button>
          <Button
            onClick={() => settle(true)}
            disabled={exigeCiencia && !ciente}
            color={exigeCiencia ? 'orange' : undefined}
          >
            {opts?.confirmLabel ?? 'Sim'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );

  return { confirm, element };
}
