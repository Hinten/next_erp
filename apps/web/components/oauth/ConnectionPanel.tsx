'use client';

import { useState, type ReactNode } from 'react';
import { Badge, Button, Card, Group, Loader, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';

import { usePermission } from '@/lib/auth';
import { navegarPara } from '@/lib/oauth/navegarPara';
import {
  useOAuthCallbackToast,
  type OAuthCallbackToastConfig,
} from '@/lib/oauth/useOAuthCallbackToast';
import { queryRetry } from '@/lib/query/queryRetry';
import { RetryAlert } from '@/components/feedback/RetryAlert';

/**
 * The account card every OAuth channel shows on its `[id]` screen: a connection
 * badge, the connected identity, and a Conectar / Reautenticar button that
 * kicks off the server-side consent flow on that channel's backend.
 *
 * It replaces three near-line-for-line copies (Mercado Livre, Melhor Envio,
 * Mercado Pago — 401 lines differing in about thirty), which is #563. Those
 * three are now configuration wrappers, and the fourth channel needs a wrapper
 * rather than a fourth copy.
 *
 * ⚠️ It knows NO channel vocabulary. Everything channel-specific arrives as a
 * prop: the client (structurally — `oauthStart` + `conta` is all it calls), the
 * query key, the callback-toast copy, the permission bit, both error describers
 * and the identity renderer. In particular it narrows no error class of its own
 * — which classes a channel owns is the channel's business, and that narrowing
 * lives in the channel's `*OAuthErrors.ts`. A grep for the narrowing operator
 * over this file must come back empty; a hit means a channel leaked in.
 *
 * Why `components/` and not `lib/` — it renders `RetryAlert` from
 * `components/feedback/`, and no file under `apps/web/lib/` imports
 * `@/components` today. That edge runs one way; keep it that way. Why not
 * `packages/ui` — it needs `usePermission`, `PERM`, TanStack Query and the
 * client seam, none of which `packages/ui` has.
 *
 * ⚠️ Two mounting traps:
 *
 * 1. It calls `useSearchParams` (through `useOAuthCallbackToast`), so Next
 *    refuses to prerender a page that mounts it outside a `<Suspense>`
 *    boundary. Every current caller is a dynamic `[id]` route, which is why the
 *    three panels never needed one; a static route must wrap it.
 * 2. `toast` must be a MODULE-LEVEL constant. The toast effect's dependency
 *    list includes `mensagens`, so a fresh object literal on each render
 *    re-fires the notification on every render.
 */

/**
 * The slice of a channel client this panel calls. Structural on purpose:
 * `MercadoLivreClient`, `FreightHttpClient` and `MercadoPagoClient` already
 * satisfy it, so no channel needs an adapter. `null` while logged out — every
 * `use<Channel>Client()` hook answers `null` then, and the button is disabled.
 */
export interface OAuthContaClient<TConta> {
  oauthStart(contaId: string): Promise<{ authorizeUrl: string }>;
  conta(contaId: string): Promise<TConta>;
}

/** Operator copy for a failed conta read, plus whether a retry could help. */
export interface ConnectionFailure {
  readonly message: string;
  readonly retryable: boolean;
}

/** The write bit the channel's `oauth/start` route enforces, and why it is dimmed. */
export interface ConnectionPermission {
  readonly bit: bigint;
  readonly hint: string;
}

export interface ConnectionPanelProps<TConta extends { readonly connected: boolean }> {
  /**
   * Rendered as `<Text fw={600}>` — NEVER a heading. The e2e specs locate the
   * page title with `getByRole('heading')`, and the page `<Title order={2}>`
   * carries the same words; a heading here would make that locator ambiguous.
   */
  readonly title: string;
  /** `integracaoId` / `intFreteId` / `metodoId` — the account document's id. */
  readonly contaId: string;
  readonly client: OAuthContaClient<TConta> | null;
  readonly queryKey: readonly unknown[];
  /** TanStack `retry` for the conta read. Default `false`; only Mercado Livre passes a predicate. */
  readonly retry?: boolean | number | ((failureCount: number, err: unknown) => boolean);
  /** ⚠️ A module-level constant — see the mounting traps above. */
  readonly toast: OAuthCallbackToastConfig;
  /** Omit for no gate at all (Melhor Envio). */
  readonly permission?: ConnectionPermission;
  /**
   * TOTAL: a query error state has nowhere to rethrow to, so every input must
   * produce copy. Channels reuse their own describer here.
   */
  readonly describeContaFailure: (err: unknown) => ConnectionFailure;
  /**
   * `null` means "not mine" and the panel rethrows — root `CLAUDE.md` rule 6,
   * the same contract as `describeMassImportStartError`
   * (`lib/marketplace/contaJobs/types.ts`).
   */
  readonly describeConnectFailure: (err: unknown) => string | null;
  /** The identity line(s) shown when the account is connected. */
  readonly renderConnected: (conta: TConta) => ReactNode;
  /** Optional extra for a conta that answered `connected: false`. */
  readonly renderDisconnected?: (conta: TConta) => ReactNode;
  /** Rendered last inside the card — Mercado Livre's dev-only test-user panel. */
  readonly children?: ReactNode;
}

export function ConnectionPanel<TConta extends { readonly connected: boolean }>({
  title,
  contaId,
  client,
  queryKey,
  retry = false,
  toast,
  permission,
  describeContaFailure,
  describeConnectFailure,
  renderConnected,
  renderDisconnected,
  children,
}: ConnectionPanelProps<TConta>) {
  // The hook cannot be called conditionally, and `0n` on its own answers
  // `allowed: false` while the claims load — hence the `permission === undefined`
  // override rather than a `?? true` on the bit.
  const gate = usePermission(permission?.bit ?? 0n);
  const permitido = permission === undefined || gate.allowed;
  const [connecting, setConnecting] = useState(false);

  // Toast the OAuth callback outcome (`?<chave>=connected|error&reason=…`).
  // Shared with the channel's list screen, which the callback redirects to for
  // the failures that happen before a trustworthy account id exists.
  useOAuthCallbackToast(toast);

  const query = useQuery({
    queryKey,
    queryFn: () => {
      if (!client) throw new Error('not ready');
      return client.conta(contaId);
    },
    enabled: Boolean(client),
    retry,
  });

  const contaRetry = queryRetry(query);
  const falha = query.error == null ? null : describeContaFailure(query.error);

  async function handleConnect() {
    if (!client) return;
    setConnecting(true);
    try {
      const { authorizeUrl } = await client.oauthStart(contaId);
      navegarPara(authorizeUrl);
    } catch (err) {
      setConnecting(false);
      // Rule 6 lives in the channel's describer: it narrows the classes it
      // owns and answers `null` for everything else, which is rethrown here.
      const mensagem = describeConnectFailure(err);
      if (mensagem === null) throw err;
      notifications.show({ color: 'red', message: mensagem });
    }
  }

  const conta = query.data ?? null;
  const connected = conta?.connected === true;

  return (
    <Card withBorder padding="md">
      <Stack gap="sm">
        <Group justify="space-between">
          <Text fw={600}>{title}</Text>
          {query.isLoading ? (
            <Loader size="sm" />
          ) : connected ? (
            <Badge color="green">Conectada</Badge>
          ) : (
            <Badge color="gray">Não conectada</Badge>
          )}
        </Group>

        {falha && (
          <RetryAlert
            color="yellow"
            message={falha.message}
            onRetry={falha.retryable ? contaRetry.retry : undefined}
            retrying={contaRetry.retrying}
          />
        )}

        {conta != null && (connected ? renderConnected(conta) : renderDisconnected?.(conta))}

        <Group align="center" gap="sm">
          <Button
            type="button"
            variant={connected ? 'light' : 'filled'}
            onClick={handleConnect}
            loading={connecting}
            disabled={!client || !permitido}
          >
            {connected ? 'Reautenticar' : 'Conectar conta'}
          </Button>
          {permission !== undefined && !permitido && (
            <Text size="xs" c="dimmed">
              {permission.hint}
            </Text>
          )}
        </Group>

        {children}
      </Stack>
    </Card>
  );
}
