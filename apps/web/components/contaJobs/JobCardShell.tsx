'use client';

/**
 * The chrome every per-conta bulk-job card shares — conta heading, flow label,
 * running spinner, dismiss-or-cancel — plus the card for a conta whose job never
 * started. Moved out of `canais/mercado-livre/_components/MercadoLivreJobCards.tsx`
 * (#1529) so a second channel's cards render through it instead of forking it;
 * the cards themselves, their polling and their copy stay per-channel.
 *
 * ⚠️ It knows NO channel's error classes. Which failures a channel's client has
 * already described arrives as {@link ErrosDoCliente}, with the cancel it
 * belongs to.
 */
import { type ReactNode, useState } from 'react';
import { Alert, Button, Card, CloseButton, Group, Loader, Modal, Stack, Text } from '@mantine/core';

import type { ContaRef } from '@/lib/marketplace/contaJobs/types';

/**
 * Which throwables a channel's client already describes, and the console tag for
 * everything else. A cancel that fails with one of `classes` is fully explained
 * by `describeCancelError`; anything else is also logged, because it is not a
 * client failure at all.
 */
export interface ErrosDoCliente {
  /** Console tag, verbatim — `'[mercado-livre]'` keeps that channel's line byte-identical. */
  readonly tagLog: string;
  /** The channel client's OWN classes — a failure of one of these is already described. */
  readonly classes: readonly (abstract new (...args: never[]) => Error)[];
}

/**
 * The cancel half of {@link JobCardShell}'s props — a UNION, so the four travel
 * together or not at all.
 *
 * ⚠️ It was three independent optionals with a docblock saying
 * `describeCancelError` was "required alongside `onCancel`". A rule asserted in a
 * comment is a rule nothing enforces: a flow could ship a cancel with no copy for
 * its own failures, and only a runtime fallback would have caught it. The shell
 * already learned this once — it called `describeMassImportCancelError` outright
 * while serving two flows (#1144), so a price-sync 404 read "Importação não
 * encontrada." Here the compiler carries it: pass `onCancel` and you must pass
 * the label, the mapper and the channel's error classes.
 */
export type CancelaveisProps =
  | {
      /**
       * Stops the job server-side. A rejection is shown in the confirm itself and
       * never rethrown — see `handleCancel`.
       */
      onCancel: () => Promise<void>;
      /** Copy for the destructive button, e.g. "Cancelar importação". */
      cancelLabel: string;
      /** Per-flow copy for a rejected cancel. Always returns something to show. */
      describeCancelError: (err: unknown) => string;
      /** The channel client's classes `describeCancelError` already explains, and the log tag. */
      errosDoCliente: ErrosDoCliente;
    }
  /** This flow has no cancel yet: the X keeps its dismiss-only behaviour. */
  | {
      onCancel?: never;
      cancelLabel?: never;
      describeCancelError?: never;
      errosDoCliente?: never;
    };

/**
 * Shared chrome: conta heading, flow label, running spinner, dismiss.
 *
 * ⚠️ Dismissing is NOT cancelling, and the two used to be indistinguishable:
 * the X removed the card while the job kept running server-side, and the
 * `dismissedJobIds` blacklist then kept the running-job lookup from bringing it
 * back. A flow that can be stopped passes `onCancel`, and the X then asks which
 * one the operator meant instead of guessing — unless the job is KNOWN to have
 * finished, in which case there is nothing to ask about. See `encerrado`.
 */
export function JobCardShell({
  conta,
  flowLabel,
  running,
  encerrado = false,
  onDismiss,
  onCancel,
  cancelLabel,
  describeCancelError,
  errosDoCliente,
  children,
}: {
  conta: ContaRef;
  flowLabel: string;
  /** Drives the spinner only — a card with no data yet is not "running". */
  running: boolean;
  /**
   * The job is KNOWN to have reached a terminal state. Gates the confirm, and
   * deliberately not `!running`.
   *
   * ⚠️ `running` is false whenever the status query has no data — a card started
   * this session carries no `initialStatus` until its first poll lands, the poll
   * can fail (these queries keep `retry: false`), and the query does not run at
   * all while `client` is null. Gating on `running` therefore sent the X down
   * the silent-dismiss branch in exactly the states where the operator is most
   * likely to press it, blacklisting the `jobId` for the session — the failure
   * this confirm exists to remove. Unknown is treated as possibly-running: the
   * worst case is a cancel that answers 409 and says so.
   */
  encerrado?: boolean;
  onDismiss: () => void;
  children: ReactNode;
} & CancelaveisProps) {
  const [confirmOpened, setConfirmOpened] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelErro, setCancelErro] = useState<string | null>(null);
  const podeCancelar = onCancel != null && !encerrado;

  /**
   * Every close path goes through here. `cancelErro` is scoped to ONE attempt:
   * left standing it greets the operator the next time they open the confirm,
   * reading as a fresh failure of a click they have not made yet.
   */
  function fecharConfirm() {
    setConfirmOpened(false);
    setCancelErro(null);
  }

  async function handleCancel() {
    if (!onCancel) return;
    setCancelling(true);
    setCancelErro(null);
    try {
      await onCancel();
      setConfirmOpened(false);
      // Deliberately NOT dismissed: the card stays so its next poll shows
      // "Importação cancelada", which is the only confirmation the operator
      // gets that the click reached the server.
    } catch (err) {
      // ⚠️ Nothing may rethrow out of here. This is an ASYNC click handler, so a
      // throw becomes an unhandled promise rejection — React error boundaries do
      // not catch those — and the operator would see the spinner stop with the
      // modal still open and nothing said at all. The reachable case is
      // `onCancel` throwing a plain Error when the client is null.
      //
      // Every `describeCancelError` always returns copy, so the guard here
      // exists only to decide what reaches the console — and to satisfy rule 6's
      // lint rule, which reads the catch body rather than the helper it calls.
      const doCliente = errosDoCliente?.classes.some((Classe) => err instanceof Classe) ?? false;
      if (!doCliente) {
        // Not a client failure at all — keep the original where it can be read.
        // The `??` is as unreachable as the one below: the union makes
        // `errosDoCliente` mandatory wherever `onCancel` is.
        console.error(
          `${errosDoCliente?.tagLog ?? '[jobs]'} cancelamento falhou (${flowLabel})`,
          err,
        );
      }
      setCancelErro(
        describeCancelError?.(err) ??
          // Unreachable: `CancelaveisProps` makes the mapper mandatory wherever
          // `onCancel` is, and `handleCancel` returns early without one. The `??`
          // survives only because destructured union members do not narrow
          // against each other — and an empty string here would be the silent
          // modal the whole catch exists to prevent.
          'Não foi possível cancelar.',
      );
    } finally {
      setCancelling(false);
    }
  }

  return (
    <Card withBorder padding="xs">
      <Stack gap={4}>
        <Group justify="space-between" wrap="nowrap" gap={4}>
          <Text size="sm" fw={600} lineClamp={1} title={conta.nome}>
            {conta.nome}
          </Text>
          <Group gap={4} wrap="nowrap">
            {running && <Loader size="xs" />}
            <CloseButton
              size="sm"
              aria-label={`Dispensar ${flowLabel} de ${conta.nome}`}
              onClick={() => (podeCancelar ? setConfirmOpened(true) : onDismiss())}
            />
          </Group>
        </Group>
        <Text size="xs" c="dimmed">
          {flowLabel}
        </Text>
        {children}
      </Stack>
      {podeCancelar && (
        <Modal
          opened={confirmOpened}
          onClose={fecharConfirm}
          title={`${flowLabel} — ${conta.nome}`}
          centered
        >
          <Stack gap="sm">
            {/* Deliberately does not assert that it IS running: the confirm also
                shows while the status is still unknown (see `encerrado`). */}
            <Text size="sm">Fechar o cartão não interrompe o job — ele segue no servidor.</Text>
            {cancelErro != null && (
              <Alert color="red" variant="light" p="xs">
                <Text size="xs">{cancelErro}</Text>
              </Alert>
            )}
            <Group justify="flex-end" gap="xs">
              <Button variant="default" size="xs" onClick={fecharConfirm}>
                Voltar
              </Button>
              <Button
                variant="default"
                size="xs"
                onClick={() => {
                  fecharConfirm();
                  onDismiss();
                }}
              >
                Apenas ocultar
              </Button>
              <Button color="red" size="xs" loading={cancelling} onClick={handleCancel}>
                {cancelLabel ?? 'Cancelar'}
              </Button>
            </Group>
          </Stack>
        </Modal>
      )}
    </Card>
  );
}

/**
 * A conta whose job never started (409 already-running, a missing tabela
 * normal, a network failure). It sits in the same list as the progress cards
 * on purpose: with a multi-conta selection, "which account failed" is the
 * whole question, and a toast cannot answer it.
 */
export function ContaJobErrorCard({
  conta,
  flowLabel,
  color,
  message,
  onDismiss,
}: {
  conta: ContaRef;
  flowLabel: string;
  color: 'yellow' | 'red';
  message: string;
  onDismiss: () => void;
}) {
  return (
    <JobCardShell conta={conta} flowLabel={flowLabel} running={false} onDismiss={onDismiss}>
      <Alert color={color} variant="light" p="xs">
        <Text size="xs">{message}</Text>
      </Alert>
    </JobCardShell>
  );
}
