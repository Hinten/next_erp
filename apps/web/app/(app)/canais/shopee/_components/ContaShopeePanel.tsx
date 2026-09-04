'use client';

import { Badge, Group, Stack, Text } from '@mantine/core';
import { PERM } from '@delfrance/auth';

import { ConnectionPanel, type ConnectionFailure } from '@/components/oauth/ConnectionPanel';
import {
  ShopeeClientHttpError,
  ShopeeClientNetworkError,
  ShopeeClientRespostaInvalidaError,
  useShopeeClient,
} from '@/lib/shopee/client';
import { corExpiracaoAutorizacao, textoExpiracaoAutorizacao } from '@/lib/shopee/expiracao';
import type { ShopeeContaStatus } from '@/lib/shopee/wire';
import { SHOPEE_OAUTH_TOAST } from './shopeeOAuthErrors';

/**
 * Shopee account panel on `/canais/shopee/[id]` — the connection status and a
 * Conectar / Reautenticar button that starts the server-side consent flow on
 * `apps/shopee`. The browser never sees a Shopee access or refresh token.
 *
 * The card itself is `ConnectionPanel` (#563); everything below is this
 * channel's configuration. `retry` stays at the shared default (`false`): the
 * conta route answers 200 for every state it can describe, so a thrown error
 * here means the backend is unreachable — which a silent retry only delays
 * telling the operator about.
 *
 * ## What this panel renders that the other three do not: TWO clocks
 *
 * A Shopee conta expires twice over, and the panel keeps the two apart because
 * they demand different actions from the operator:
 *
 *  - the **authorization** (`diasParaExpirar` / `expireTime`, 7–365 days) — the
 *    seller's consent. Its lapse means someone has to re-consent, so it gets the
 *    coloured badge that turns yellow a month out.
 *  - the **access token** (`credencial.expirada`, ~4 hours) — a refreshable
 *    detail that means nothing to the operator except as the reason the shop
 *    NAME is missing from the line above (`get_shop_info` needs a live token).
 *    Automatic renewal is a later step of the integration, and the copy says so
 *    rather than implying something is broken.
 *
 * Conflating them is the defect the legacy Flutter app shipped: it painted
 * "Conectado" from the 4-hour clock and never read the other, so an
 * authorization about to lapse looked identical to a healthy conta until the
 * day everything stopped.
 */

/** ms epoch → `dd/mm/aaaa` in the operator's own wall clock (a browser surface). */
function formatarData(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString('pt-BR');
}

/**
 * Who this conta is, in one line.
 *
 * The shop NAME is a side read that needs a live access token, so it is absent
 * far more often than the id is — hence the `Loja <id>` fallback rather than a
 * blank. A consent given on the parent account carries no `shopId` at all, and
 * that is a legitimate connected state, not a hole to paper over.
 */
function identidadeDaConta(conta: ShopeeContaStatus): string {
  if (conta.shopId !== null) {
    const nome = conta.loja?.shopName ?? `Loja ${String(conta.shopId)}`;
    const regiao = conta.loja?.region == null ? '' : ` · ${conta.loja.region}`;
    return `${nome} · #${String(conta.shopId)}${regiao}`;
  }
  if (conta.mainAccountId !== null) return `Conta principal #${String(conta.mainAccountId)}`;
  return 'Conta conectada';
}

/** The `loja.status` badge, or nothing for `NORMAL` / an unknown value. */
function BadgeStatusLoja({ status }: { status: ShopeeContaStatus['loja'] }) {
  if (status?.status === 'BANNED') {
    return (
      <Badge color="red" variant="light">
        Loja banida
      </Badge>
    );
  }
  if (status?.status === 'FROZEN') {
    return (
      <Badge color="orange" variant="light">
        Loja congelada
      </Badge>
    );
  }
  return null;
}

function ContaConectada({ conta }: { conta: ShopeeContaStatus }) {
  const expiraEm = formatarData(conta.expireTime);
  const autorizadaEm = formatarData(conta.authTime);

  return (
    <Stack gap={2}>
      <Group gap="xs" align="center">
        <Text size="sm">{identidadeDaConta(conta)}</Text>
        <BadgeStatusLoja status={conta.loja} />
      </Group>

      <Group gap="xs" align="center">
        <Badge color={corExpiracaoAutorizacao(conta.diasParaExpirar)} variant="light">
          {textoExpiracaoAutorizacao(conta.diasParaExpirar)}
        </Badge>
        {expiraEm !== null && (
          <Text size="xs" c="dimmed">
            Autorização válida até {expiraEm}
            {autorizadaEm === null ? '' : ` · autorizada em ${autorizadaEm}`}
          </Text>
        )}
      </Group>

      {conta.credencial?.expirada === true && (
        <Text size="xs" c="dimmed">
          Token de acesso expirado (dura cerca de 4 horas) — é por isso que o nome da loja não
          aparece acima. A autorização da conta continua válida; a renovação automática do token
          chega em um passo seguinte da integração.
        </Text>
      )}
    </Stack>
  );
}

/**
 * A conta that answered `connected: false` while still naming a shop is a
 * REVOKED authorization, not a conta nobody ever connected — the document keeps
 * the id the callback wrote, and Shopee simply no longer lists it. Saying which
 * shop stopped working, and that the fix is a re-consent, is the difference
 * between an operator reconnecting and an operator opening a support ticket.
 *
 * The 365-day advice is a product decision (P8): the consent screen defaults to
 * a shorter window, and every shorter window is another interruption.
 */
function ContaDesconectada({ conta }: { conta: ShopeeContaStatus }) {
  if (conta.shopId === null) return null;
  return (
    <Text size="xs" c="dimmed">
      A Shopee não reconhece mais a loja #{String(conta.shopId)}: a autorização foi revogada pelo
      vendedor ou expirou. Clique em Reautenticar e escolha 365 dias.
    </Text>
  );
}

/**
 * A failed conta read, as operator copy plus a retryability verdict.
 *
 * ⚠️ MOST-DERIVED FIRST. `ShopeeClientRespostaInvalidaError` extends
 * `ShopeeClientHttpError`, so testing the base class first would swallow it and
 * report a payload this app cannot read as an ordinary backend failure —
 * retryable on a 5xx, which it never is.
 *
 * TOTAL by contract: `ConnectionPanel` renders a query error state and has
 * nowhere to rethrow to, so every input has to produce copy.
 */
export function descreverFalhaContaShopee(err: unknown): ConnectionFailure {
  if (err instanceof ShopeeClientRespostaInvalidaError) {
    return { message: err.message, retryable: false };
  }
  if (err instanceof ShopeeClientHttpError) {
    if (err.code === 'SHOPEE_NETWORK_ERROR') {
      return {
        message: 'O backend não conseguiu falar com a Shopee. Tente de novo em instantes.',
        retryable: true,
      };
    }
    if (err.code === 'SHOPEE_BAD_RESPONSE') {
      return {
        message: 'A Shopee devolveu uma resposta em formato inesperado — avise o suporte.',
        retryable: false,
      };
    }
    // A 4xx is a verdict about this request (no permission, no such conta) and
    // will answer the same way forever; a 5xx may not. `501` is the exception:
    // "not implemented" is as permanent as a 4xx.
    return { message: err.message, retryable: err.status >= 500 && err.status !== 501 };
  }
  if (err instanceof ShopeeClientNetworkError) {
    return { message: 'Falha de rede ao consultar a conta.', retryable: true };
  }
  return { message: 'Não foi possível consultar a conta.', retryable: false };
}

/**
 * A failed Conectar click, as operator copy — or `null` when the failure is not
 * one of this client's, which makes `ConnectionPanel` rethrow it (root
 * `CLAUDE.md` rule 6).
 *
 * The backend's own message is the useful one on this path: `oauth/start`
 * refuses for reasons the operator can act on (the conta is not a Shopee
 * integração, the partner credentials are unset) and each already arrives as
 * pt-BR text.
 */
export function descreverFalhaConexaoShopee(err: unknown): string | null {
  if (err instanceof ShopeeClientHttpError) return err.message;
  if (err instanceof ShopeeClientNetworkError) return 'Falha de rede ao iniciar a conexão.';
  return null;
}

export function ContaShopeePanel({ integracaoId }: { integracaoId: string }) {
  const client = useShopeeClient();

  return (
    <ConnectionPanel<ShopeeContaStatus>
      title="Conta Shopee"
      contaId={integracaoId}
      client={client}
      queryKey={['shopee-conta', integracaoId]}
      toast={SHOPEE_OAUTH_TOAST}
      permission={{
        bit: PERM.integracao.write,
        hint: 'Requer permissão de escrita em integrações.',
      }}
      describeContaFailure={descreverFalhaContaShopee}
      describeConnectFailure={descreverFalhaConexaoShopee}
      renderConnected={(conta) => <ContaConectada conta={conta} />}
      renderDisconnected={(conta) => <ContaDesconectada conta={conta} />}
    />
  );
}
