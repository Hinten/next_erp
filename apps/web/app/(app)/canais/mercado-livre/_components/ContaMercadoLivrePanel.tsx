'use client';

import { Text } from '@mantine/core';
import { PERM } from '@delfrance/auth';

import { ConnectionPanel } from '@/components/oauth/ConnectionPanel';
import { type MercadoLivreConta, useMercadoLivreClient } from '@/lib/mercado-livre/client';
import { describeMercadoLivreFailure, mercadoLivreQueryRetry } from '@/lib/mercado-livre/errors';
import { UsuariosTesteDevPanel } from './UsuariosTesteDevPanel';
import {
  MERCADO_LIVRE_OAUTH_TOAST,
  describeMercadoLivreConnectFailure,
} from './mercadoLivreOAuthErrors';

/** Copy for a failed conta read that is not a typed Mercado Livre client error. */
const CONTA_FALLBACKS = {
  network: 'Falha de rede ao consultar a conta.',
  unknown: 'Não foi possível consultar a conta.',
} as const;

/**
 * Mercado Livre account panel on /canais/mercado-livre/[id] — shows the
 * connection status (`/users/me`) and a Conectar / Reautenticar button that
 * kicks off the server-side OAuth flow on apps/mercado-livre. Mounted beside
 * the integracao editor. The browser never sees a Mercado Livre token.
 *
 * The card itself is `ConnectionPanel` (#563), shared with Melhor Envio and
 * Mercado Pago; everything below is this channel's configuration. This is the
 * only channel that passes a `retry` predicate: `mercadoLivreQueryRetry` heals
 * a one-off blip on the conta read before the operator ever sees the alert, and
 * it is also the only channel whose failures carry a retryability verdict
 * (`describeMercadoLivreFailure`), which is what puts a Tentar novamente button
 * on the alert.
 *
 * The backend oauth/start route is PERM.integracao.write-gated — the button is
 * gated by the same bit so a viewer isn't offered an action that will 403.
 *
 * The two account-wide bulk jobs ("Importar todos os anúncios" #621 and
 * "Atualizar preços" Step 11 PR-D) used to live here; #816 moved them to the
 * channel list (`/canais/mercado-livre`), where they act on the table's
 * selection and can run for several contas at once. Their progress moved with
 * them, and deliberately does NOT get a read-only mirror here: the job docs
 * are admin-only/default-deny, so this page has no way to reach one — every
 * lookup is by conta, and the conta is exactly what the list already knows.
 */
export function ContaMercadoLivrePanel({ integracaoId }: { integracaoId: string }) {
  const client = useMercadoLivreClient();

  return (
    <ConnectionPanel<MercadoLivreConta>
      title="Conta Mercado Livre"
      contaId={integracaoId}
      client={client}
      queryKey={['mercado-livre-conta', integracaoId]}
      retry={mercadoLivreQueryRetry}
      toast={MERCADO_LIVRE_OAUTH_TOAST}
      permission={{
        bit: PERM.integracao.write,
        hint: 'Requer permissão de escrita em integrações.',
      }}
      describeContaFailure={(err) => describeMercadoLivreFailure(err, CONTA_FALLBACKS)}
      describeConnectFailure={describeMercadoLivreConnectFailure}
      renderConnected={(conta) =>
        conta.me && (
          <Text size="sm">
            {conta.me.nickname ?? `Usuário ${conta.me.id}`}
            {conta.me.email ? ` · ${conta.me.email}` : ''}
          </Text>
        )
      }
    >
      {/*
        Mounted inside the conta card because it acts ON this conta — and, on
        success, disconnects it. Renders nothing in a production build; in dev
        against a backend without MERCADO_LIVRE_TEST_USERS_ENABLED (which
        404s) it renders a card naming the variable, rather than vanishing.
      */}
      <UsuariosTesteDevPanel integracaoId={integracaoId} />
    </ConnectionPanel>
  );
}
