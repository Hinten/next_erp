'use client';

import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  CopyButton,
  Group,
  Modal,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PERM } from '@delfrance/auth';
import { USUARIO_TESTE_LIMITE_POR_CONTA } from '@delfrance/schemas';

import { usePermission } from '@/lib/auth';
import {
  MercadoLivreBackendDesatualizadoError,
  MercadoLivreClientHttpError,
  type MercadoLivreUsuarioTeste,
  useMercadoLivreClient,
} from '@/lib/mercado-livre/client';
import { describeMercadoLivreFailure, mercadoLivreQueryRetry } from '@/lib/mercado-livre/errors';
import { queryRetry } from '@/lib/query/queryRetry';
import { RetryAlert } from '@/components/feedback/RetryAlert';

/**
 * Build-time constant: Next inlines `process.env.NODE_ENV`, so the check in the
 * wrapper below folds to a constant rather than being evaluated per render.
 */
const IS_DEV = process.env.NODE_ENV !== 'production';

/**
 * What a conta whose credential was just revoked answers on the next mint. The
 * generic copy for it ("reconecte a conta") is true but not actionable here, so
 * the panel replaces it with the one sentence that is.
 */
const CODIGO_REAUTH = 'ML_REAUTH_REQUIRED';

/**
 * Shown when the list comes back without doc ids — every backend older than the
 * field, including one that already mints correctly.
 *
 * ⚠️ Named rather than rendered as an empty chip. The doc id is the only thing
 * on screen that separates "the new buyer landed beside the old one" from "it
 * landed on top of it", so a blank where it should be is the panel quietly
 * withdrawing the one answer it was added to give.
 */
const DOC_ID_AUSENTE =
  'Este backend não informa em qual documento cada conta está guardada, então esta lista não ' +
  'consegue distinguir um comprador criado AO LADO do antigo de um que substituiu o antigo. ' +
  'As credenciais abaixo estão corretas; faça o deploy de `apps/mercado-livre` para recuperar ' +
  'essa distinção.';

const PRECISA_RECONECTAR =
  'Conecte novamente a conta real que registrou a aplicação: a criação anterior apagou as ' +
  'credenciais desta conta, e o backend precisa de um token antes de qualquer verificação.';

/**
 * Dev-only: mint the Mercado Livre test users an end-to-end run needs.
 *
 * Mercado Livre has **no sandbox**. It hands out throwaway production accounts
 * through `POST /users/test_user`, capped at ten per real account, never listed
 * anywhere, and with the password shown exactly once. Doing that by hand means
 * pasting an access token into curl and not losing the response.
 *
 * Two actions, and the difference between them is the whole point:
 *
 *  - **Criar usuários de teste** — the pair bootstrap. Reuses anything already
 *    stored, so a retry after a partial failure costs zero slots.
 *  - **Novo comprador** — one fresh buyer, reusing nothing. #1087's case:
 *    Mercado Pago stopped accepting purchases from the stored buyer, and it has
 *    to be replaced without re-minting the seller that still works. Every click
 *    spends a slot, so this one shows the count first.
 *
 * ⚠️ **The mint is destructive to the conta it runs on.** On success the backend
 * deletes every OAuth credential of the account it used — deliberately, because
 * that account is a real seller account and must not stay wired to the ERP — so
 * pointed at the wrong conta it disconnects a live seller. Three guards live
 * here (the connected account is NAMED, a checkbox must be ticked, and the
 * single mint shows how many slots are already gone); the fourth and
 * authoritative one is the backend's `MERCADO_LIVRE_TEST_USERS_ENABLED`.
 *
 * ⚠️ **A successful mint is why the next one needs a reconnect.** The backend
 * resolves a token BEFORE any guard runs, so once the credential is gone every
 * further mint answers 409 `ML_REAUTH_REQUIRED` — even one that would have
 * created nothing. That is a precondition, not a fault, which is why the panel
 * disables the action while the conta is disconnected and says so. The single
 * mint can opt out of the revocation to keep the conta usable for a follow-up.
 *
 * ⚠️ The `NODE_ENV` check is for DISCOVERABILITY ONLY and is not a security
 * guard: `apps/web` in local dev calls the DEPLOYED channel backend, so the
 * browser's notion of "dev" says nothing about which backend answers. It does
 * still have to be correct — see the wrapper below for why its POSITION matters.
 *
 * A backend without `MERCADO_LIVRE_TEST_USERS_ENABLED=1` answers 404. In
 * PRODUCTION that renders nothing (the wrapper returns first); in DEV it renders
 * {@link FlagDesligadaCard}, which names the variable — silence there cost a
 * debugging session, because an absent panel is indistinguishable from a feature
 * that was never built.
 *
 * ⚠️ **No hooks in this wrapper, deliberately.** The env check used to sit AFTER
 * the hooks, which does not do what it looks like it does: hooks run before any
 * early return, so a deployed `apps/web` (always `NODE_ENV=production`) still
 * fired `GET /usuarios-teste` at the channel backend on **every** Mercado Livre
 * conta page — a request that can only 404 and whose result can never be
 * rendered. Returning before the hooks exist is what makes "renders nothing in a
 * production build" actually true.
 */
export function UsuariosTesteDevPanel({ integracaoId }: { integracaoId: string }) {
  if (!IS_DEV) return null;
  return <UsuariosTestePanel integracaoId={integracaoId} />;
}

function UsuariosTestePanel({ integracaoId }: { integracaoId: string }) {
  const client = useMercadoLivreClient();
  const queryClient = useQueryClient();
  const { allowed: canWrite } = usePermission(PERM.integracao.write);
  const [confirmingPar, setConfirmingPar] = useState(false);
  const [confirmingAvulso, setConfirmingAvulso] = useState(false);
  const [entendido, setEntendido] = useState(false);
  const [manterCredencial, setManterCredencial] = useState(false);
  const [revelado, setRevelado] = useState<MercadoLivreUsuarioTeste | null>(null);

  const queryKey = ['mercado-livre-usuarios-teste', integracaoId];
  const query = useQuery({
    queryKey,
    queryFn: () => {
      if (!client) throw new Error('not ready');
      return client.usuariosTeste(integracaoId);
    },
    enabled: Boolean(client),
    retry: mercadoLivreQueryRetry,
  });

  // Same key the conta panel this is mounted inside already populates, so this
  // is a cache hit rather than a second request. It buys the two facts the
  // confirmations need: WHICH account is about to be charged a slot, and
  // whether a token still exists to charge it with.
  const contaQuery = useQuery({
    queryKey: ['mercado-livre-conta', integracaoId],
    queryFn: () => {
      if (!client) throw new Error('not ready');
      return client.conta(integracaoId);
    },
    enabled: Boolean(client),
    retry: mercadoLivreQueryRetry,
  });

  function fecharConfirmacoes(): void {
    setConfirmingPar(false);
    setConfirmingAvulso(false);
    setEntendido(false);
    setManterCredencial(false);
  }

  /**
   * ⚠️ `invalidateQueries`, never `setQueryData`. Seeding the cache with the
   * mint's own `usuarios` was correct while the pair was the only shape — it is
   * the WHOLE list then. A single mint returns ONE record, so seeding would
   * erase every other stored account from the panel until the next refetch, on
   * the one screen whose job is showing which credentials exist.
   *
   * ⚠️ Called from `onSettled`, never `onSuccess`. A failed mint is exactly when
   * the panel is most likely to be showing something false: the request can
   * refuse AFTER the backend already minted and already revoked the credential
   * (the client-side post-condition below throws on a 200), leaving "Conectada"
   * on screen next to a conta that no longer is.
   */
  function refetchListas(): void {
    void queryClient.invalidateQueries({ queryKey });
    // The conta panel next door still shows "Conectada" from a cached read —
    // and, unless the caller opted out, it no longer is.
    void queryClient.invalidateQueries({ queryKey: ['mercado-livre-conta', integracaoId] });
  }

  function descreverFalha(err: unknown, fallback: string): string {
    // Already written as the one sentence that is actionable — a deploy, or
    // "check the list before spending another slot". Do not generalise it.
    if (err instanceof MercadoLivreBackendDesatualizadoError) return err.message;
    if (err instanceof MercadoLivreClientHttpError) {
      return err.code === CODIGO_REAUTH ? PRECISA_RECONECTAR : err.message;
    }
    return fallback;
  }

  const mutationPar = useMutation({
    mutationFn: () => {
      if (!client) throw new Error('not ready');
      return client.criarUsuariosTeste(integracaoId);
    },
    onSettled: refetchListas,
    onSuccess: (result) => {
      fecharConfirmacoes();
      notifications.show({
        color: 'green',
        message:
          `${String(result.criados.length)} usuário(s) criado(s), ` +
          `${String(result.reaproveitados.length)} reaproveitado(s). ` +
          `A conta ${result.conta.nickname ?? String(result.conta.id)} foi desconectada ` +
          `(${String(result.credenciaisRemovidas)} credencial(is) removida(s)).`,
      });
    },
    onError: (err: unknown) => {
      notifications.show({
        color: 'red',
        message: descreverFalha(err, 'Não foi possível criar os usuários de teste.'),
      });
    },
  });

  const mutationAvulso = useMutation({
    mutationFn: (manter: boolean) => {
      if (!client) throw new Error('not ready');
      return client.criarUsuarioTesteAvulso(integracaoId, 'comprador', {
        manterCredencial: manter,
      });
    },
    onSettled: refetchListas,
    onSuccess: (result) => {
      fecharConfirmacoes();
      // The single mint creates exactly one account and reuses nothing, so this
      // is it — and `exigirMintAvulso` in the client has already refused any
      // response where that is not literally true, so `usuarios[0]` cannot be
      // some other account's credential. Revealed in a modal that cannot be
      // dismissed before the password is copied — see `SenhaReveladaModal`.
      const novo = result.usuarios[0];
      if (novo) setRevelado(novo);
      notifications.show({
        color: 'green',
        message: result.credencialRevogada
          ? `A conta ${result.conta.nickname ?? String(result.conta.id)} foi desconectada ` +
            `(${String(result.credenciaisRemovidas)} credencial(is) removida(s)).`
          : `A conta ${result.conta.nickname ?? String(result.conta.id)} CONTINUA conectada — ` +
            'a credencial foi mantida a seu pedido.',
      });
    },
    onError: (err: unknown) => {
      notifications.show({
        color: 'red',
        // ⚠️ A stale-backend message names a deploy the operator has to go and
        // do, and reports a credential that was wiped anyway. Four seconds is
        // not enough to read that, let alone act on it.
        ...(err instanceof MercadoLivreBackendDesatualizadoError ? { autoClose: false } : {}),
        message: descreverFalha(err, 'Não foi possível criar o comprador de teste.'),
      });
    },
  });

  // A backend without the flag answers 404 on both verbs. This branch only ever
  // runs in a dev build (the wrapper above returned already in production), so
  // it SAYS SO instead of rendering nothing: an off flag is indistinguishable
  // from a missing feature otherwise, and "no panel, no error" sends you reading
  // the component to find out why. Naming the variable is the whole point.
  if (query.error instanceof MercadoLivreClientHttpError && query.error.status === 404) {
    return <FlagDesligadaCard />;
  }

  const usuarios = ordenarUsuarios(query.data?.usuarios ?? []);
  // Anything that is NOT that 404 used to be swallowed: `usuarios` fell back to
  // `[]` and the panel said "Nenhum usuário de teste criado" — indistinguishable
  // from an unreachable backend, on the one screen whose whole job is to tell
  // you which users exist before you create more.
  const listaFailure =
    query.error == null
      ? null
      : describeMercadoLivreFailure(query.error, {
          network: 'Falha de rede ao consultar os usuários de teste.',
          unknown: 'Não foi possível consultar os usuários de teste.',
        });
  const listaRetry = queryRetry(query);

  // ⚠️ Split by role rather than counted. `usuarios.length >= 2` read a total as
  // if it were coverage: two extra compradores and no vendedor would disable the
  // pair bootstrap while the seller half is still missing. The two lists ARE the
  // coverage, and they are also what the panel renders — one derivation, so the
  // buttons and the screen can never disagree about what exists.
  const vendedores = usuarios.filter((u) => u.role === 'vendedor');
  const compradores = usuarios.filter((u) => u.role === 'comprador');
  const temVendedor = vendedores.length > 0;
  const temComprador = compradores.length > 0;
  const parCompleto = temVendedor && temComprador;

  // `ordenarUsuarios` already sorted newest-first inside each role.
  const compradorMaisRecente = compradores[0] ?? null;
  const conectada = contaQuery.data?.connected === true;
  // ⚠️ "Disconnected" and "we do not know yet" are DIFFERENT, and only the first
  // has a cause worth naming. `conectada` collapses them, so the hint below has
  // to gate on the answer having arrived — otherwise it asserts a specific and
  // false reason ("the previous mint deleted the credentials") on every first
  // render and on every failed conta read.
  const contaRespondeu = contaQuery.data != null;
  const contaNome = contaQuery.data?.me
    ? (contaQuery.data.me.nickname ?? `id ${String(contaQuery.data.me.id)}`)
    : null;
  const limiteAtingido = usuarios.length >= USUARIO_TESTE_LIMITE_POR_CONTA;
  // ⚠️ `some`, not `every`: one record without a doc id is already enough to
  // make the list unable to answer its own question, and a mixed answer is the
  // shape a half-deployed backend produces.
  const semDocId = usuarios.some((u) => u.docId == null);

  return (
    <Card withBorder padding="md" data-testid="ml-usuarios-teste-panel">
      <Stack gap="sm">
        <Group justify="space-between">
          <Text fw={600}>Usuários de teste (dev)</Text>
          <Badge color="orange" variant="light">
            Somente desenvolvimento
          </Badge>
        </Group>

        <Text size="sm" c="dimmed">
          O Mercado Livre não tem sandbox: os usuários de teste são contas reais de produção,
          limitadas a {USUARIO_TESTE_LIMITE_POR_CONTA} por conta e sem recuperação de senha. Por
          isso as credenciais ficam guardadas aqui — é o único lugar onde elas existem depois da
          criação.
        </Text>

        <ContadorDeVagas registrados={usuarios.length} />

        {semDocId && (
          <Alert color="yellow" variant="light" data-testid="ml-usuarios-teste-sem-doc-id">
            {DOC_ID_AUSENTE}
          </Alert>
        )}

        {listaFailure && (
          <RetryAlert
            color="yellow"
            message={listaFailure.message}
            onRetry={listaFailure.retryable ? listaRetry.retry : undefined}
            retrying={listaRetry.retrying}
          />
        )}

        {usuarios.length > 0 ? (
          <Stack gap="md" data-testid="ml-usuarios-teste-lista">
            <GrupoDeUsuarios
              titulo="Vendedores"
              usuarios={vendedores}
              testId="ml-usuarios-teste-vendedores"
            />
            <GrupoDeUsuarios
              titulo="Compradores"
              usuarios={compradores}
              maisRecente={compradorMaisRecente}
              testId="ml-usuarios-teste-compradores"
            />
          </Stack>
        ) : (
          // Suppressed while the read is failing: "nenhum criado" next to "não
          // foi possível consultar" is the exact contradiction the alert exists
          // to remove.
          !listaFailure && (
            <Text size="sm" c="dimmed">
              Nenhum usuário de teste criado para esta conta ainda.
            </Text>
          )
        )}

        <Group align="center" gap="sm">
          <Button
            type="button"
            color="orange"
            variant="light"
            onClick={() => {
              setConfirmingPar(true);
            }}
            disabled={!client || !canWrite || parCompleto || limiteAtingido}
            data-testid="ml-criar-usuarios-teste"
          >
            Criar usuários de teste
          </Button>
          <Button
            type="button"
            color="grape"
            variant="light"
            onClick={() => {
              setConfirmingAvulso(true);
            }}
            disabled={!client || !canWrite || !conectada || limiteAtingido}
            data-testid="ml-novo-comprador"
          >
            Novo comprador
          </Button>
          {!canWrite && (
            <Text size="xs" c="dimmed">
              Requer permissão de escrita em integrações.
            </Text>
          )}
        </Group>

        {canWrite && contaRespondeu && !conectada && (
          <Text size="xs" c="dimmed" data-testid="ml-usuarios-teste-desconectada">
            {PRECISA_RECONECTAR}
          </Text>
        )}
        {canWrite && limiteAtingido && (
          <Text size="xs" c="dimmed" data-testid="ml-usuarios-teste-limite">
            Limite de {USUARIO_TESTE_LIMITE_POR_CONTA} usuários de teste atingido para esta conta.
          </Text>
        )}
      </Stack>

      <Modal
        opened={confirmingPar}
        onClose={fecharConfirmacoes}
        title="Criar usuários de teste e desconectar esta conta"
      >
        <Stack gap="sm" data-testid="ml-usuarios-teste-confirm">
          <Alert color="red" variant="light">
            Esta ação usa o token da conta conectada
            {contaNome ? (
              <>
                {' '}
                (<strong>{contaNome}</strong>)
              </>
            ) : null}{' '}
            para criar um vendedor e um comprador de teste e, em seguida,{' '}
            <strong>apaga as credenciais OAuth desta conta</strong>. Ela ficará desconectada e
            precisará ser reconectada manualmente.
          </Alert>
          <Text size="sm">
            Cada usuário criado consome uma das{' '}
            <strong>{USUARIO_TESTE_LIMITE_POR_CONTA} vagas permanentes</strong> da conta real, e o
            Mercado Livre nunca mostra a senha de novo.
          </Text>
          <ContadorDeVagas registrados={usuarios.length} />
          <Checkbox
            checked={entendido}
            onChange={(e) => {
              setEntendido(e.currentTarget.checked);
            }}
            label="Entendi que esta conta será desconectada"
            data-testid="ml-usuarios-teste-entendido"
          />
          <Group justify="flex-end">
            <Button type="button" variant="default" onClick={fecharConfirmacoes}>
              Cancelar
            </Button>
            <Button
              type="button"
              color="red"
              disabled={!entendido}
              loading={mutationPar.isPending}
              onClick={() => {
                mutationPar.mutate();
              }}
              data-testid="ml-usuarios-teste-confirmar"
            >
              Criar e desconectar
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={confirmingAvulso}
        onClose={fecharConfirmacoes}
        title="Criar um novo comprador de teste"
      >
        <Stack gap="sm" data-testid="ml-novo-comprador-confirm">
          <Alert color="red" variant="light">
            Esta ação usa o token da conta conectada
            {contaNome ? (
              <>
                {' '}
                (<strong>{contaNome}</strong>)
              </>
            ) : null}{' '}
            para criar <strong>um comprador novo</strong>. O comprador já guardado{' '}
            <strong>não é substituído nem apagado</strong> — a conta nova entra ao lado dele.
          </Alert>
          <Text size="sm">
            ⚠️ Diferente da criação do par, esta ação <strong>nunca reaproveita</strong>: cada
            clique gasta uma vaga, inclusive uma nova tentativa depois de um erro de rede. Confira a
            lista antes de clicar de novo.
          </Text>
          <ContadorDeVagas registrados={usuarios.length} />
          <Checkbox
            checked={entendido}
            onChange={(e) => {
              setEntendido(e.currentTarget.checked);
            }}
            label="Entendi que isto consome uma vaga permanente"
            data-testid="ml-novo-comprador-entendido"
          />
          {/*
            ⚠️ Polarity is deliberate: UNTICKED revokes. Keeping a real seller
            account wired to the ERP is the choice that needs an affirmative
            click, not the one you get by not reading the dialog.
          */}
          <Checkbox
            checked={manterCredencial}
            onChange={(e) => {
              setManterCredencial(e.currentTarget.checked);
            }}
            label="Manter esta conta conectada (não apagar as credenciais)"
            data-testid="ml-novo-comprador-manter"
          />
          {manterCredencial && (
            <Alert color="orange" variant="light">
              A conta real seguirá conectada ao ERP depois da criação. Útil para criar outro
              comprador em seguida sem refazer o OAuth — mas lembre de reconectar a conta de teste
              antes de continuar o roteiro.
            </Alert>
          )}
          <Group justify="flex-end">
            <Button type="button" variant="default" onClick={fecharConfirmacoes}>
              Cancelar
            </Button>
            <Button
              type="button"
              color="red"
              disabled={!entendido}
              loading={mutationAvulso.isPending}
              onClick={() => {
                mutationAvulso.mutate(manterCredencial);
              }}
              data-testid="ml-novo-comprador-confirmar"
            >
              Criar comprador
            </Button>
          </Group>
        </Stack>
      </Modal>

      {revelado && (
        <SenhaReveladaModal
          usuario={revelado}
          onClose={() => {
            setRevelado(null);
          }}
        />
      )}
    </Card>
  );
}

/**
 * React key for one account's card.
 *
 * ⚠️ The doc id first, because it is unique by CONSTRUCTION — the ML user id is
 * unique only if nothing was ever stored twice, which is the very property this
 * panel exists to let you check, so keying on it would assume the answer.
 *
 * ⚠️ The fallback exists because a backend older than the field reports no doc
 * id at all, and `key={undefined}` is not a key: React drops to index
 * reconciliation on exactly the list this panel needs to be trustworthy. It is
 * exported so the derivation can be asserted directly — a test that watched for
 * React's missing-key console warning instead PASSED against a deliberately
 * broken key (the warning is de-duplicated per component and never reached the
 * spy), which is a checker that cannot fail.
 */
export function chaveDoCard(u: MercadoLivreUsuarioTeste): string {
  return u.docId ?? `sem-doc-${String(u.id)}`;
}

/**
 * One role's accounts, counted in the heading.
 *
 * ⚠️ The count is rendered even when it is zero, and every account in the group
 * is rendered — there is no "and N more". "Compradores (1)" sitting there right
 * after a mint that was supposed to add one is the fastest way to see that
 * nothing was created, and a section that collapses or truncates cannot say it.
 * That question is why this grouping exists at all: the flat list showed every
 * record too, but with the roles interleaved a buyer count that failed to grow
 * was invisible.
 */
function GrupoDeUsuarios({
  titulo,
  usuarios,
  maisRecente = null,
  testId,
}: {
  titulo: string;
  usuarios: MercadoLivreUsuarioTeste[];
  maisRecente?: MercadoLivreUsuarioTeste | null;
  testId: string;
}) {
  return (
    <Stack gap="xs" data-testid={testId}>
      <Text size="xs" fw={600} c="dimmed">
        {titulo} ({usuarios.length})
      </Text>
      {usuarios.length === 0 ? (
        <Text size="xs" c="dimmed">
          Nenhum registrado.
        </Text>
      ) : (
        usuarios.map((u) => (
          <UsuarioTesteCard key={chaveDoCard(u)} usuario={u} maisRecente={u === maisRecente} />
        ))
      )}
    </Stack>
  );
}

/**
 * How many of the account's ten slots are provably gone.
 *
 * ⚠️ It says "pelo menos" because that is the truth: ML publishes no endpoint
 * that lists an account's test users, so this counts what THIS integração
 * stored. Another integração, another environment or a hand-rolled `curl` all
 * spend from the same ten without appearing here. A number presented as exact
 * would be worse than no number at all.
 */
function ContadorDeVagas({ registrados }: { registrados: number }) {
  return (
    <Text size="xs" c="dimmed" data-testid="ml-usuarios-teste-vagas">
      Registrados aqui: <strong>{registrados}</strong> de {USUARIO_TESTE_LIMITE_POR_CONTA}. O limite
      é por conta real e permanente — uma vaga só volta depois de 60 dias sem atividade, e o Mercado
      Livre não oferece nenhuma forma de conferir quantas restam, então este é um piso, não o total.
    </Text>
  );
}

/**
 * Everything the operator needs to keep, as one block.
 *
 * The verification codes ride along because there is no inbox for these
 * accounts: ML derives the code from the trailing digits of the id, and hitting
 * that prompt without them is a dead end.
 */
function blocoParaCopiar(u: MercadoLivreUsuarioTeste): string {
  return [
    `Usuário de teste Mercado Livre (${u.role})`,
    `nickname: ${u.nickname}`,
    `id: ${String(u.id)}`,
    `senha: ${u.password}`,
    `site: ${u.site_id}`,
    `código de verificação de e-mail: ${u.codigosVerificacaoEmail.quatro} (4 dígitos) ou ${u.codigosVerificacaoEmail.seis} (6 dígitos)`,
  ].join('\n');
}

/**
 * The freshly minted account, in a modal that will not close until the operator
 * has actually taken the credential away.
 *
 * ⚠️ Every dismissal route is off — no close button, no click-outside, no Esc —
 * and "Fechar" unlocks only once a copy has SUCCEEDED. `useClipboard` rather
 * than `CopyButton`'s render prop precisely because it also reports `error`: a
 * denied permission or an insecure context would otherwise leave the operator
 * clicking a button that silently does nothing behind a modal that will not
 * close.
 *
 * ⚠️ And the trap is deliberately not absolute. The record is ALSO persisted and
 * re-rendered in the list below this modal, so the gate is about attention, not
 * about being the last copy in existence — trapping someone whose clipboard is
 * unavailable would trade a small risk for a certain one. When the copy fails,
 * the block is offered as selectable text plus an explicit acknowledgement.
 */
function SenhaReveladaModal({
  usuario,
  onClose,
}: {
  usuario: MercadoLivreUsuarioTeste;
  onClose: () => void;
}) {
  const clipboard = useClipboard({ timeout: 4000 });
  const [anotado, setAnotado] = useState(false);
  const bloco = blocoParaCopiar(usuario);
  const falhouAoCopiar = clipboard.error != null;
  const podeFechar = clipboard.copied || anotado;

  return (
    <Modal
      opened
      onClose={onClose}
      withCloseButton={false}
      closeOnClickOutside={false}
      closeOnEscape={false}
      title="Comprador de teste criado — copie a senha agora"
    >
      <Stack gap="sm" data-testid="ml-usuario-teste-revelado">
        <Alert color="orange" variant="light">
          Esta conta consumiu uma das {USUARIO_TESTE_LIMITE_POR_CONTA} vagas permanentes e o Mercado
          Livre <strong>nunca reemite a senha</strong>. Ela fica guardada nesta tela, mas copie
          agora: é a única cópia fora do Firestore.
        </Alert>

        <Group gap="xs">
          <Badge color="grape" variant="light">
            Comprador
          </Badge>
          <Text size="sm" fw={600}>
            {usuario.nickname}
          </Text>
          <Text size="xs" c="dimmed">
            id {usuario.id} · {usuario.site_id}
          </Text>
        </Group>

        <Group gap="xs" align="center">
          <Text size="xs" c="dimmed">
            Senha:
          </Text>
          <Code data-testid="ml-usuario-teste-revelado-senha">{usuario.password}</Code>
        </Group>

        <Text size="xs" c="dimmed">
          Código de verificação de e-mail: {usuario.codigosVerificacaoEmail.quatro} (4 dígitos) ou{' '}
          {usuario.codigosVerificacaoEmail.seis} (6 dígitos)
        </Text>

        {falhouAoCopiar && (
          <>
            <Alert color="yellow" variant="light">
              O navegador recusou o acesso à área de transferência. Selecione o texto abaixo e copie
              manualmente.
            </Alert>
            <Textarea
              readOnly
              autosize
              minRows={4}
              value={bloco}
              data-testid="ml-usuario-teste-revelado-fallback"
            />
            <Checkbox
              checked={anotado}
              onChange={(e) => {
                setAnotado(e.currentTarget.checked);
              }}
              label="Anotei a senha manualmente"
              data-testid="ml-usuario-teste-revelado-anotado"
            />
          </>
        )}

        <Group justify="flex-end">
          <Button
            type="button"
            variant="light"
            onClick={() => {
              clipboard.copy(bloco);
            }}
            data-testid="ml-usuario-teste-revelado-copiar"
          >
            {clipboard.copied ? 'Copiado' : 'Copiar tudo'}
          </Button>
          <Button
            type="button"
            disabled={!podeFechar}
            onClick={onClose}
            data-testid="ml-usuario-teste-revelado-fechar"
          >
            Fechar
          </Button>
        </Group>
        {!podeFechar && (
          <Text size="xs" c="dimmed">
            Copie a senha para liberar o botão de fechar.
          </Text>
        )}
      </Stack>
    </Modal>
  );
}

/**
 * Newest first within each role, seller group first.
 *
 * The backend already returns the pair bootstrap's two records ahead of any
 * additional mint, but once several compradores exist the operator needs the
 * ordering that answers "which one should the run use" — and that is recency,
 * not doc-id sort. `createdAt` is nullable on the schema; a record without one
 * predates the field and sorts last, which is also the right answer.
 */
function ordenarUsuarios(usuarios: MercadoLivreUsuarioTeste[]): MercadoLivreUsuarioTeste[] {
  const peso = (u: MercadoLivreUsuarioTeste): number => (u.role === 'vendedor' ? 0 : 1);
  return [...usuarios].sort((a, b) => peso(a) - peso(b) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/**
 * Shown in a DEV build when the backend 404s the route — i.e. it is running
 * without `MERCADO_LIVRE_TEST_USERS_ENABLED=1`.
 *
 * ⚠️ This exists because the previous behaviour was to render nothing, and an
 * absent panel with no error in the console reads as "the feature was never
 * built" rather than "one env var is unset". The 404 is deliberate on the
 * backend (the route must not admit it exists where the flag is off), so the
 * only place that can explain it is here.
 *
 * It deliberately does NOT assert the cause: a 404 also covers a backend
 * predating the route (a stale `pnpm dev`, or `NEXT_PUBLIC_MERCADO_LIVRE_URL`
 * still aimed at the deployed one). Both remedies are named.
 */
function FlagDesligadaCard() {
  return (
    <Card withBorder padding="md" data-testid="ml-usuarios-teste-flag-off">
      <Stack gap="xs">
        <Group justify="space-between">
          <Text fw={600}>Usuários de teste (dev)</Text>
          <Badge color="gray" variant="light">
            Desativado
          </Badge>
        </Group>
        <Alert color="yellow" variant="light">
          O backend do Mercado Livre respondeu <Code>404</Code> nesta rota, então a criação de
          usuários de teste está desligada aqui.
        </Alert>
        <Text size="sm">
          Para ligar: defina <Code>MERCADO_LIVRE_TEST_USERS_ENABLED=1</Code> no{' '}
          <Code>.env.local</Code> da raiz do repositório e <strong>reinicie</strong> o servidor de
          dev do <Code>@delfrance/mercado-livre-app</Code> — o Next lê o arquivo só na
          inicialização.
        </Text>
        <Text size="xs" c="dimmed">
          Se a variável já estiver definida, confira se <Code>NEXT_PUBLIC_MERCADO_LIVRE_URL</Code>{' '}
          aponta para o backend local (:3006) e não para o publicado, que não tem a flag.
        </Text>
      </Stack>
    </Card>
  );
}

/** One stored account, with everything needed to sign in as it on ML. */
function UsuarioTesteCard({
  usuario,
  maisRecente,
}: {
  usuario: MercadoLivreUsuarioTeste;
  maisRecente: boolean;
}) {
  return (
    <Card withBorder padding="xs" radius="sm">
      <Stack gap={4}>
        <Group gap="xs">
          <Badge color={usuario.role === 'vendedor' ? 'blue' : 'grape'} variant="light">
            {usuario.role === 'vendedor' ? 'Vendedor' : 'Comprador'}
          </Badge>
          {maisRecente && (
            <Badge color="teal" variant="light">
              Mais recente
            </Badge>
          )}
          <Text size="sm" fw={600}>
            {usuario.nickname}
          </Text>
          <Text size="xs" c="dimmed">
            id {usuario.id} · {usuario.site_id}
            {usuario.site_status ? ` · ${usuario.site_status}` : ''}
          </Text>
        </Group>
        {/*
          ⚠️ The doc id is the whole point of this line. Two accounts can never
          share one, so it is the only field on screen that distinguishes "the
          new buyer landed BESIDE the old one" (`comprador` and
          `comprador-<id>` both listed) from "it landed on top of it" (one doc,
          new credential) from "it was never created" (nothing new at all).
          Every buyer record says `role: 'comprador'`, so the records alone
          cannot tell those three apart.
        */}
        <Text size="xs" c={usuario.docId == null ? 'orange' : 'dimmed'}>
          {usuario.docId == null ? (
            // ⚠️ Never an empty chip. "doc ⟨nothing⟩" reads as a rendering
            // glitch; "não informado" reads as the fact it is.
            <>doc não informado (backend desatualizado)</>
          ) : (
            <>
              doc <Code>{usuario.docId}</Code>
            </>
          )}
          {usuario.createdAt != null
            ? ` · criado em ${new Date(usuario.createdAt).toLocaleString('pt-BR')}`
            : ''}
        </Text>
        <Group gap="xs" align="center">
          <Text size="xs" c="dimmed">
            Senha:
          </Text>
          <Code>{usuario.password}</Code>
          <CopyButton value={usuario.password}>
            {({ copied, copy }) => (
              <Button size="compact-xs" variant="subtle" onClick={copy}>
                {copied ? 'Copiado' : 'Copiar'}
              </Button>
            )}
          </CopyButton>
        </Group>
        <Text size="xs" c="dimmed">
          {/* No inbox exists for these accounts — ML derives the code from the id. */}
          Código de verificação de e-mail: {usuario.codigosVerificacaoEmail.quatro} (4 dígitos) ou{' '}
          {usuario.codigosVerificacaoEmail.seis} (6 dígitos)
        </Text>
      </Stack>
    </Card>
  );
}
