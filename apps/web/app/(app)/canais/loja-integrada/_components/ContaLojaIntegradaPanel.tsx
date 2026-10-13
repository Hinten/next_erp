'use client';

/**
 * The Loja Integrada credential panel on `/canais/loja-integrada/[id]` — the
 * operator's surface for the `apps/loja-integrada` conta routes (master-plan
 * step 2). Model: `ContaWhatsappPanel` — a pasted token, no OAuth.
 *
 * It shows what WE stored, never live health: whether a Personal Token is saved,
 * the expiry date the operator copied from Loja Integrada's painel (with the
 * days left and the 30-day warning the expiry aviso also uses), and whether Loja
 * Integrada refused the stored token (the "reconexão pendente" park). Three
 * writes: save a token (validated against Loja Integrada first), renew only the
 * expiry (the painel's "Renovar" keeps the SAME token, which is never shown
 * again), and remove the token.
 *
 * ## The token is write-only
 *
 * Never prefilled, never read back, never rendered as text, never in a URL, a
 * log line or the mutation's `variables`. The field is UNCONTROLLED: the token
 * lives only in the input element's `value` property, read through a ref when
 * the save runs. React state holds the field's verdict (`bloqueioDoTokenLi`),
 * never the token — a controlled input would also mirror it into the `value`
 * ATTRIBUTE, where anything that serialises the DOM reads it. The field is
 * cleared after every submit except where sending the SAME token again is the
 * point (`lib/loja-integrada/erros.ts` decides which).
 *
 * ## Every write carries the version the operator saw
 *
 * `versaoEsperada` is the cached status's `versaoCredencialUs`; a mismatch is a
 * 409 `LI_CREDENCIAL_ALTERADA`, after which the panel re-reads the status and
 * tells the operator. A successful write REPLACES the cached status with its
 * answer (after cancelling any read in flight, which would otherwise land the
 * older version on top), so the next write carries the version just written.
 *
 * So the status is re-read only on mount (the form is empty then) and where the
 * code asks for it — never in the background (reconnect, focus), where it would
 * swap the version under a form the operator has already filled, and the save
 * would overwrite another operator's token without the 409.
 *
 * ⚠️ A `Card` titled with `<Text fw={600}>`, never a heading — the e2e specs find
 * the page title by role. Labels avoid `Nome`, `Ativo`, `Filial` and `Depósito`,
 * which the ObjectView below owns.
 */
import { useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  PasswordInput,
  Stack,
  Text,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { useDisclosure } from '@mantine/hooks';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PERM } from '@delfrance/auth';
import { nowMillis } from '@delfrance/core/datetime';
import {
  CODIGO_ERRO_LI,
  type JanelaDeValidadeTokenLi,
  type RespostaCredencialLojaIntegrada,
  type StatusContaLojaIntegrada,
  janelaDeValidadeTokenLi,
} from '@delfrance/schemas';

import { RetryAlert } from '@/components/feedback/RetryAlert';
import { usePermission } from '@/lib/auth';
import {
  type MotivoBackendLiIndisponivel,
  useBackendLojaIntegrada,
} from '@/lib/loja-integrada/client';
import {
  type BloqueioDoTokenLi,
  MENSAGEM_REMOVIDO,
  MENSAGEM_TOKEN_LONGO,
  bloqueioAoRenovar,
  bloqueioAoSalvar,
  bloqueioDoTokenLi,
  mensagemRenovado,
  mensagemSalvo,
  montarCorpoRenovar,
  montarCorpoSalvar,
  statusDaResposta,
} from '@/lib/loja-integrada/credencialForm';
import {
  type FalhaCredencialLi,
  codigoDaFalhaLi,
  descreverFalhaCredencialLi,
  descreverFalhaStatusLi,
} from '@/lib/loja-integrada/erros';
import {
  corValidadeLi,
  dataCivilParaExibicao,
  diaEMesNoFuso,
  orientacaoValidadeLi,
  textoValidadeLi,
} from '@/lib/loja-integrada/expiracao';

/** The status query's key — one cache entry per conta. */
function chaveDoStatusLi(integracaoId: string): readonly ['loja-integrada-conta', string] {
  return ['loja-integrada-conta', integracaoId];
}

type Resultado =
  | { readonly tipo: 'sucesso'; readonly mensagem: string }
  | { readonly tipo: 'falha'; readonly falha: FalhaCredencialLi };

const DICA_TOKEN =
  'Gerado pelo proprietário da loja no painel da Loja Integrada (Configurações > Chave para ' +
  'API). Nunca é exibido depois de salvo.';

const DICA_VALIDADE =
  'A data em que o token vence, como aparece no painel da Loja Integrada (o token dura três meses).';

function mensagemBackendIndisponivel(motivo: MotivoBackendLiIndisponivel): string {
  if (motivo === 'inseguro') {
    return (
      'Esta página é servida por https, mas o endereço do backend da Loja Integrada deste build ' +
      'é http: o token não é enviado por uma conexão sem criptografia. Configure ' +
      'NEXT_PUBLIC_LOJA_INTEGRADA_URL com o endereço https do backend.'
    );
  }
  return (
    'O endereço do backend da Loja Integrada deste build (NEXT_PUBLIC_LOJA_INTEGRADA_URL) não é ' +
    'um endereço http(s) válido.'
  );
}

/** The header badge: the most urgent state wins its colour. */
function BadgeDaCredencial({ status }: { status: StatusContaLojaIntegrada }) {
  if (!status.configurado) {
    return (
      <Badge color="gray" variant="light">
        Sem token
      </Badge>
    );
  }
  const cor = status.reconexaoPendente === null ? corValidadeLi(status.situacaoValidade) : 'red';
  const validadoEm = status.atualizadoEmMs === null ? null : diaEMesNoFuso(status.atualizadoEmMs);
  return (
    <Badge color={cor} variant="light">
      {validadoEm === null ? 'Configurado' : `Configurado — validado ao salvar em ${validadoEm}`}
    </Badge>
  );
}

/** What the stored credential says: the park first, then the expiry. */
function SituacaoDaCredencial({ status }: { status: StatusContaLojaIntegrada }) {
  if (!status.configurado) {
    return (
      <Text size="sm" c="dimmed">
        Nenhum token salvo. Sem um Personal Token, nada desta conta conversa com a Loja Integrada.
      </Text>
    );
  }
  const validadeAte = status.expiraEm === null ? null : dataCivilParaExibicao(status.expiraEm);
  const parada = status.reconexaoPendente;
  if (parada !== null) {
    const desde = diaEMesNoFuso(parada.desdeMs);
    return (
      <Stack gap={4}>
        <Alert color="red" variant="light" title="Reconexão pendente">
          A Loja Integrada recusou o token (HTTP {String(parada.status)})
          {desde === null ? '' : ` em ${desde}`}; a importação ficará parada até salvar um token
          válido. Se o token ainda é válido no painel, use &quot;Só atualizar a validade&quot; para
          revalidá-lo.
        </Alert>
        {validadeAte !== null && (
          <Text size="xs" c="dimmed">
            Validade informada: {validadeAte}
          </Text>
        )}
      </Stack>
    );
  }
  const orientacao = orientacaoValidadeLi(status.situacaoValidade);
  const cor = corValidadeLi(status.situacaoValidade);
  return (
    <Stack gap={4}>
      <Group gap="xs" align="center">
        <Badge color={cor} variant="light">
          {textoValidadeLi(status.diasParaExpirar)}
        </Badge>
        {validadeAte !== null && (
          <Text size="xs" c="dimmed">
            Validade até {validadeAte}
          </Text>
        )}
      </Group>
      {orientacao !== null && (
        <Text size="xs" c={cor}>
          {orientacao}
        </Text>
      )}
    </Stack>
  );
}

/** The date field's own error: a refused date from the backend, or a stale window here. */
function erroDaData(
  resultado: Resultado | null,
  expiraEm: string | null,
  janela: JanelaDeValidadeTokenLi,
): string | null {
  if (resultado?.tipo === 'falha' && resultado.falha.campo === 'expiraEm') {
    return resultado.falha.mensagem;
  }
  if (expiraEm !== null && (expiraEm < janela.desde || expiraEm > janela.ate)) {
    return (
      `Escolha uma data entre ${dataCivilParaExibicao(janela.desde)} e ` +
      `${dataCivilParaExibicao(janela.ate)}.`
    );
  }
  return null;
}

export function ContaLojaIntegradaPanel({ integracaoId }: { integracaoId: string }) {
  const { client, indisponivel } = useBackendLojaIntegrada();
  const queryClient = useQueryClient();
  // Every route is `PERM.integracao.write`-gated (the status is `.read`): gate
  // the form by the same bit, so a viewer is not offered a write that will 403.
  const { allowed: podeEscrever } = usePermission(PERM.integracao.write);
  const queryKey = chaveDoStatusLi(integracaoId);

  const status = useQuery({
    queryKey,
    queryFn: client === null ? skipToken : () => client.conta(integracaoId),
    // A save is a validation against Loja Integrada and the read is ours; a
    // failed read is shown with a "Tentar novamente", never silently repeated.
    retry: false,
    // The version every write echoes must be the freshest one: a remount never
    // serves a 30-second-old status (the app default) to a write.
    staleTime: 0,
    // …but never refreshed in the BACKGROUND: under a filled form that would
    // adopt another operator's version silently, and defeat the 409. The only
    // re-reads are on mount and the ones this panel asks for. (Focus refetch is
    // off app-wide in `QUERY_DEFAULT_OPTIONS`; the panel test trips if that flips.)
    refetchOnReconnect: false,
  });
  const dados = status.data;

  // Uncontrolled: the token stays in the element, never in React state.
  const campoToken = useRef<HTMLInputElement>(null);
  const [bloqueioDoToken, setBloqueioDoToken] = useState<BloqueioDoTokenLi | null>('sem-token');
  const [expiraEm, setExpiraEm] = useState<string | null>(null);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [confirmarRemocao, modalRemocao] = useDisclosure(false);

  // Today..today + 120 days in São Paulo — the SAME window the routes enforce.
  const janela = janelaDeValidadeTokenLi(nowMillis());

  /** A write's answer replaces the cached status, over any read still in flight. */
  async function aplicarResposta(resposta: RespostaCredencialLojaIntegrada): Promise<void> {
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData(queryKey, statusDaResposta(resposta));
  }

  /** Empty the token field (and its verdict, which no `onChange` reports). */
  function limparToken(): void {
    if (campoToken.current !== null) campoToken.current.value = '';
    setBloqueioDoToken('sem-token');
  }

  /**
   * One failure → copy, the token field policy and maybe a re-read. An error no
   * module knows is rethrown (root `CLAUDE.md` rule 6) — after the field is
   * cleared, so the token never outlives a failure nobody understood.
   */
  function tratarFalha(err: unknown): void {
    const f = descreverFalhaCredencialLi(err);
    if (f === null) {
      limparToken();
      throw err;
    }
    if (!f.manterToken) limparToken();
    setResultado({ tipo: 'falha', falha: f });
    if (f.recarregarStatus) void queryClient.invalidateQueries({ queryKey });
  }

  const salvar = useMutation({
    gcTime: 0,
    // No `variables`: the token is read from the field itself, so it never sits
    // in the mutation's state (or in the query devtools).
    mutationFn: async (): Promise<RespostaCredencialLojaIntegrada | null> => {
      const token = campoToken.current?.value ?? '';
      if (client === null || dados === undefined || expiraEm === null) return null;
      return client.salvarCredencial(integracaoId, montarCorpoSalvar(token, expiraEm, dados));
    },
    onSuccess: async (resposta) => {
      limparToken();
      if (resposta === null) return;
      setExpiraEm(null);
      await aplicarResposta(resposta);
      setResultado({ tipo: 'sucesso', mensagem: mensagemSalvo(resposta) });
    },
    onError: tratarFalha,
  });

  const renovar = useMutation({
    gcTime: 0,
    mutationFn: async (): Promise<RespostaCredencialLojaIntegrada | null> => {
      if (client === null || dados === undefined || expiraEm === null) return null;
      const corpo = montarCorpoRenovar(expiraEm, dados);
      if (corpo === null) return null;
      return client.renovarValidade(integracaoId, corpo);
    },
    onSuccess: async (resposta) => {
      if (resposta === null) return;
      setExpiraEm(null);
      await aplicarResposta(resposta);
      setResultado({ tipo: 'sucesso', mensagem: mensagemRenovado(resposta) });
    },
    onError: tratarFalha,
  });

  const remover = useMutation({
    gcTime: 0,
    mutationFn: async (): Promise<boolean> => {
      if (client === null) return false;
      await client.removerCredencial(integracaoId);
      return true;
    },
    onSuccess: (removido) => {
      if (!removido) return;
      setResultado({ tipo: 'sucesso', mensagem: MENSAGEM_REMOVIDO });
      // The answer is `{ ok: true }` — re-read what is stored now.
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: tratarFalha,
    onSettled: () => modalRemocao.close(),
  });

  const ocupado = salvar.isPending || renovar.isPending || remover.isPending;
  const desabilitado = !podeEscrever || client === null;
  const entrada = { bloqueioDoToken, expiraEm, janela, status: dados };
  const podeSalvar = !desabilitado && !ocupado && bloqueioAoSalvar(entrada) === null;
  const podeRenovar = !desabilitado && !ocupado && bloqueioAoRenovar(entrada) === null;
  // A corrupt stored credential fails the status read itself; removing it is
  // exactly the remedy, so that one failure keeps "Remover token" available.
  const credencialIlegivel = codigoDaFalhaLi(status.error) === CODIGO_ERRO_LI.credencialInvalida;
  const podeRemover =
    !desabilitado && !ocupado && (dados?.configurado === true || credencialIlegivel);

  const falhaDoStatus = status.error === null ? null : descreverFalhaStatusLi(status.error);
  const falhaNoPainel =
    resultado?.tipo === 'falha' && resultado.falha.campo === null ? resultado.falha : null;

  function iniciar(acao: () => void): void {
    setResultado(null);
    acao();
  }

  return (
    // A named `region` (not a heading): screen readers and the e2e spec find the
    // panel by it, while the page title stays the only heading.
    <Card withBorder padding="md" component="section" aria-label="Credencial da Loja Integrada">
      <Stack gap="sm">
        <Group justify="space-between" align="center">
          <Text fw={600}>Credencial da Loja Integrada</Text>
          {dados !== undefined ? (
            <BadgeDaCredencial status={dados} />
          ) : status.isFetching ? (
            <Loader size="sm" />
          ) : null}
        </Group>

        {indisponivel !== null && (
          <Alert color="red" variant="light" title="Backend da Loja Integrada não configurado">
            {mensagemBackendIndisponivel(indisponivel)}
          </Alert>
        )}

        {falhaDoStatus !== null && (
          <RetryAlert
            title="Não foi possível ler a credencial"
            message={falhaDoStatus.mensagem}
            onRetry={falhaDoStatus.repetivel ? () => void status.refetch() : undefined}
            retrying={status.isFetching}
          />
        )}

        {dados !== undefined && <SituacaoDaCredencial status={dados} />}

        <Stack gap="xs">
          <PasswordInput
            label="Personal Token"
            description={DICA_TOKEN}
            autoComplete="off"
            // Uncontrolled on purpose — no `value` (see the header).
            ref={campoToken}
            onChange={(e) => setBloqueioDoToken(bloqueioDoTokenLi(e.currentTarget.value))}
            error={bloqueioDoToken === 'token-longo' ? MENSAGEM_TOKEN_LONGO : null}
            disabled={desabilitado}
          />
          <DatePickerInput
            label="Validade do token"
            description={DICA_VALIDADE}
            placeholder="Escolha a data"
            valueFormat="DD/MM/YYYY"
            value={expiraEm}
            minDate={janela.desde}
            maxDate={janela.ate}
            defaultDate={janela.desde}
            getDayAriaLabel={dataCivilParaExibicao}
            onChange={(valor) => {
              setExpiraEm(valor);
              // A refused date's message belongs to the date it refused.
              if (resultado?.tipo === 'falha' && resultado.falha.campo === 'expiraEm') {
                setResultado(null);
              }
            }}
            error={erroDaData(resultado, expiraEm, janela)}
            disabled={desabilitado}
            clearable
          />
          <Group gap="sm">
            <Button
              type="button"
              onClick={() => iniciar(() => salvar.mutate())}
              loading={salvar.isPending}
              disabled={!podeSalvar}
            >
              Validar e salvar
            </Button>
            <Button
              type="button"
              variant="light"
              onClick={() => iniciar(() => renovar.mutate())}
              loading={renovar.isPending}
              disabled={!podeRenovar}
            >
              Só atualizar a validade (renovei no painel)
            </Button>
            <Button
              type="button"
              color="red"
              variant="light"
              onClick={modalRemocao.open}
              disabled={!podeRemover}
            >
              Remover token
            </Button>
          </Group>
          {!podeEscrever && (
            <Text size="xs" c="dimmed">
              Requer permissão de escrita em integrações.
            </Text>
          )}
        </Stack>

        {resultado?.tipo === 'sucesso' && (
          <Alert color="green" variant="light">
            {resultado.mensagem}
          </Alert>
        )}
        {falhaNoPainel !== null && (
          <Alert color={falhaNoPainel.cor} variant="light">
            {falhaNoPainel.mensagem}
          </Alert>
        )}
      </Stack>

      <Modal
        opened={confirmarRemocao}
        onClose={modalRemocao.close}
        title="Remover o token da Loja Integrada"
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            A conta fica sem credencial: nada dela conversa com a Loja Integrada até um novo
            Personal Token ser salvo. O token continua válido no painel da Loja Integrada — para
            revogá-lo, o proprietário da loja o remove lá.
          </Text>
          <Group justify="flex-end" gap="sm">
            <Button type="button" variant="default" onClick={modalRemocao.close}>
              Cancelar
            </Button>
            <Button
              type="button"
              color="red"
              onClick={() => iniciar(() => remover.mutate())}
              loading={remover.isPending}
            >
              Remover
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Card>
  );
}
