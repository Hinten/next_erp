'use client';

import { Alert, Box, Stack, Text } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { LIMIAR_AVISO_AMAZON_DIAS, type StatusContaAmazon } from '@delfrance/schemas';

import { ConnectionPanel } from '@/components/oauth/ConnectionPanel';
import { type MotivoBackendAmazonIndisponivel, useBackendAmazon } from '@/lib/amazon/client';
import {
  AMAZON_CALLBACK_TOAST,
  describeAmazonConnectFailure,
  describeAmazonContaFailure,
} from './amazonOAuthErrors';

/**
 * The Amazon connection panel on `/canais/amazon/[id]` — the connection status
 * and a Conectar conta / Reautenticar button that starts the server-side
 * consent flow on `apps/amazon`. The browser never sees an LWA token, an
 * authorization code, the state or the seller id: the status route answers a
 * projection without them.
 *
 * The card itself is the shared `ConnectionPanel` (#563), UNCHANGED; everything
 * below is this channel's configuration plus what it renders inside the card.
 * `retry` stays at the shared default (`false`): the status route answers 200
 * for every state it can describe, so a thrown error means the backend is
 * unreachable or refused, which a silent retry only delays saying.
 *
 * ## What it says, and from whose clock
 *
 * Every date and count comes from the SERVER (`statusContaAmazonSchema`): São
 * Paulo civil dates (`YYYY-MM-DD`) shown by splitting the string, and
 * `diasParaReautorizar` as computed by the backend with the same function the
 * daily sweep uses. The panel recomputes nothing from the browser's clock or
 * zone, so it and the reauthorization aviso cannot disagree about one conta.
 *
 * Three Alerts, each for a different action:
 *
 *  - **parked** (`reconexaoPendente`, red) — Amazon refused the stored
 *    authorization; the conta's integration is stopped until a new consent;
 *  - **reauthorization due** (≤ {@link LIMIAR_AVISO_AMAZON_DIAS} days, yellow;
 *    red once the date has passed) — the seller's 365-day authorization runs
 *    out; a new consent restarts it;
 *  - **switch off** (`chamadasLigadas === false`, blue) — the backend calls
 *    Amazon for nothing until the cutover. The button still renders, and a
 *    click answers 503, which `describeAmazonConnectFailure` turns into copy.
 *
 * ⚠️ The copy names THIS card's button, never Seller Central's "Re-Authorize":
 * that one loads a log-in URI this ERP does not serve.
 */

/** `'2027-03-10'` → `'10/03/2027'`, by splitting the string — never a `Date`. */
function dataCivilBr(dataCivil: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dataCivil);
  if (m === null) return dataCivil;
  return `${m[3] ?? ''}/${m[2] ?? ''}/${m[1] ?? ''}`;
}

const NAO_USE_SELLER_CENTRAL =
  'Não use o botão de reautorizar do Seller Central: ele não é suportado por este ERP.';

/** The parked state: Amazon refused the stored authorization. */
function AlertaReconexao({
  pendente,
}: {
  pendente: NonNullable<StatusContaAmazon['reconexaoPendente']>;
}) {
  return (
    <Alert color="red" variant="light" title="Autorização recusada pela Amazon">
      A Amazon recusou a autorização desta conta em {dataCivilBr(pendente.desde)} (HTTP{' '}
      {String(pendente.status)}). A integração desta conta está parada até uma nova autorização:
      clique em Reautenticar abaixo. {NAO_USE_SELLER_CENTRAL}
    </Alert>
  );
}

/** The 365-day clock, only once it is within the threshold. */
function AlertaReautorizacao({ dias, ate }: { dias: number; ate: string | null }) {
  const quando = ate === null ? '' : ` (${dataCivilBr(ate)})`;
  if (dias < 0) {
    return (
      <Alert color="red" variant="light" title="Prazo de reautorização vencido">
        O prazo de 365 dias da autorização da Amazon já passou{quando}, e a Amazon pode recusá-la a
        qualquer momento. Clique em Reautenticar abaixo para renová-la. {NAO_USE_SELLER_CENTRAL}
      </Alert>
    );
  }
  const prazo = dias === 0 ? 'vence hoje' : `vence em ${String(dias)} dia(s)`;
  return (
    <Alert color="yellow" variant="light" title="Reautorização próxima">
      A autorização da Amazon desta conta {prazo}
      {quando}. Clique em Reautenticar abaixo para renová-la por mais 365 dias.{' '}
      {NAO_USE_SELLER_CENTRAL}
    </Alert>
  );
}

/** The read switch: nothing reaches Amazon from this backend yet. */
function AlertaChamadasDesligadas() {
  return (
    <Alert color="blue" variant="light" title="Integração desligada">
      As chamadas à Amazon estão desligadas neste backend até a virada do sistema (ou por
      configuração). Até lá a conexão não pode ser feita, e nada é enviado à Amazon.
    </Alert>
  );
}

function ContaConectada({ conta }: { conta: StatusContaAmazon }) {
  const dias = conta.diasParaReautorizar;
  return (
    <Stack gap="xs">
      {conta.autorizadoEm !== null && (
        <Text size="sm">
          Autorizada em {dataCivilBr(conta.autorizadoEm)}
          {conta.reautorizarAte === null
            ? ''
            : ` · reautorizar até ${dataCivilBr(conta.reautorizarAte)}`}
        </Text>
      )}
      {conta.reconexaoPendente !== null && <AlertaReconexao pendente={conta.reconexaoPendente} />}
      {dias !== null && dias <= LIMIAR_AVISO_AMAZON_DIAS && (
        <AlertaReautorizacao dias={dias} ate={conta.reautorizarAte} />
      )}
      {!conta.chamadasLigadas && <AlertaChamadasDesligadas />}
    </Stack>
  );
}

/**
 * A conta that answered `connected: false`. Two notes, neither an error: the
 * switch (why Conectar conta answers 503 today) and a credential document that
 * no longer parses (a new consent overwrites it).
 */
function ContaDesconectada({ conta }: { conta: StatusContaAmazon }) {
  if (!conta.credencialInvalida && conta.chamadasLigadas) return null;
  return (
    <Stack gap="xs">
      {conta.credencialInvalida && (
        <Text size="xs" c="orange">
          A credencial salva desta conta está ilegível e não pode ser usada. Uma nova conexão (botão
          abaixo) a substitui.
        </Text>
      )}
      {!conta.chamadasLigadas && <AlertaChamadasDesligadas />}
    </Stack>
  );
}

function mensagemBackendIndisponivel(motivo: MotivoBackendAmazonIndisponivel): string {
  if (motivo === 'inseguro') {
    return (
      'Esta página é servida por https, mas o endereço do backend da Amazon deste build é http: a ' +
      'sessão não é enviada por uma conexão sem criptografia. Configure NEXT_PUBLIC_AMAZON_URL ' +
      'com o endereço https do backend.'
    );
  }
  return (
    'O endereço do backend da Amazon deste build (NEXT_PUBLIC_AMAZON_URL) não é um endereço ' +
    'http(s) válido.'
  );
}

export function ContaAmazonPanel({ integracaoId }: { integracaoId: string }) {
  const { client, indisponivel } = useBackendAmazon();

  return (
    // A named `region` (not a heading): screen readers and the e2e spec find the
    // panel by it, while the page title stays the only heading.
    <Box component="section" aria-label="Conexão com a Amazon">
      <ConnectionPanel<StatusContaAmazon>
        title="Conexão com a Amazon"
        contaId={integracaoId}
        client={client}
        queryKey={['amazon', 'conta', integracaoId]}
        toast={AMAZON_CALLBACK_TOAST}
        permission={{
          bit: PERM.integracao.write,
          hint: 'Requer permissão de escrita em integrações.',
        }}
        describeContaFailure={describeAmazonContaFailure}
        describeConnectFailure={describeAmazonConnectFailure}
        renderConnected={(conta) => <ContaConectada conta={conta} />}
        renderDisconnected={(conta) => <ContaDesconectada conta={conta} />}
      >
        {indisponivel !== null && (
          <Alert color="red" variant="light" title="Backend da Amazon não configurado">
            {mensagemBackendIndisponivel(indisponivel)}
          </Alert>
        )}
      </ConnectionPanel>
    </Box>
  );
}
