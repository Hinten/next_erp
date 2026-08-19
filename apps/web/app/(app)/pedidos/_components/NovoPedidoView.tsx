'use client';

import { Suspense, useMemo } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Alert, Anchor, Button, Skeleton, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { FirebaseError } from 'firebase/app';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@delfrance/ui';
import type { Pedido } from '@delfrance/schemas';
import {
  buildDevolucaoIntegralSeed,
  buildDuplicarPedidoSeed,
  criarEntradaDevolucaoIntegral,
  criarSaidaComDevolucao,
  PedidoConflictError,
  prepareDevolucaoSave,
  registrarIncidenteDeDevolucaoIntegral,
  type DevolucaoSavePrepared,
  type PedidoDevolucaoDataPort,
} from '@delfrance/data/pedido';
import { PedidoForm } from './PedidoForm';
import { DIRECAO, direcaoIncompativelDaCopia, type Direcao } from './direcao';
import { DirecaoSurface } from './DirecaoSurface';
import { useConfirmDialog } from './ConfirmDialog';
import { runDevolucaoDialogs } from './devolucaoSaveFlow';
import { useEmitirEntradaPrompt } from './useEmitirEntradaPrompt';
import { emitirNFeComNotificacao } from './emitirNFeComNotificacao';
import { registrarIncidentesDeTrocaBestEffort } from './trocaIncidentesBestEffort';
import { createPedidoWithNumero, resolveOperacaoNome } from '@/lib/pedidos/createPedido';
import { createClientPedidoPort } from '@/lib/pedidos/clientPort';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth/useAuth';
import { useNFeClient } from '@/lib/nfe/client';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';

// Fills the AppShell main area so the form's flex layout can pin the sticky
// footer to the bottom regardless of how short a tab's content is.
const PAGE_MIN_HEIGHT =
  'calc(100dvh - var(--app-shell-header-height, 56px) - var(--app-shell-padding, 1rem) * 2)';

/**
 * The create-pedido page, parametrized by direction: `/pedidos/novo` (saída)
 * and `/pedidos/entradas/novo` (entrada) share this view. The entrada route
 * additionally accepts `?devolucaoDe=<pedidoId>` (#551) to pre-seed a full
 * return of a saída; both routes accept `?copiarDe=<pedidoId>` (#370) to
 * pre-seed a duplicate of an existing pedido — hence the `useSearchParams` +
 * Suspense split.
 */
export function NovoPedidoView({ direcao }: { direcao: Direcao }) {
  return (
    <Suspense
      fallback={
        <Stack>
          <Skeleton height={32} width={240} />
          <Skeleton height={400} />
        </Stack>
      }
    >
      <NovoPedidoInner direcao={direcao} />
    </Suspense>
  );
}

function NovoPedidoInner({ direcao }: { direcao: Direcao }) {
  const searchParams = useSearchParams();
  const devolucaoDe = searchParams.get('devolucaoDe');
  const copiarDe = searchParams.get('copiarDe');
  if (direcao === 'entrada' && devolucaoDe) {
    return <NovaEntradaDevolucaoIntegral originId={devolucaoDe} />;
  }
  if (copiarDe) {
    return <NovoPedidoCopia direcao={direcao} originId={copiarDe} />;
  }
  return <NovoPedidoCreate direcao={direcao} />;
}

/**
 * Create-flow submit orchestration shared by the plain create ({@link
 * NovoPedidoCreate}) and the #370 "Duplicar pedido" pre-filled create
 * ({@link NovoPedidoCopia}) — both save through the exact same path (the
 * #488 troca-com-devolução branch included; a duplicate's `itensDevolvidos`
 * is always stripped by {@link buildDuplicarPedidoSeed}, so
 * `prepareDevolucaoSave` naturally falls through to the plain create for it).
 */
function useCreatePedidoSubmit(direcao: Direcao) {
  const cfg = DIRECAO[direcao];
  const router = useRouter();
  const nfeClient = useNFeClient();
  const { confirm, element: confirmElement } = useConfirmDialog();
  const { promptEmitirEntrada, element: emitirPromptElement } = useEmitirEntradaPrompt();

  // #488 — a saída with itens devolvidos: dialog chain, then either the atomic
  // saída+devolução create or the plain create; troca incidentes + optional
  // NF-e emission after the commit (both best-effort: the pedidos are already
  // committed, so their failure must never block the flow or the navigation).
  async function handleSaidaComDevolucao(
    port: PedidoDevolucaoDataPort,
    values: Pedido,
    prepared: DevolucaoSavePrepared,
  ): Promise<boolean | void> {
    const answers = await runDevolucaoDialogs(prepared, confirm, (msg) =>
      notifications.show({ color: 'yellow', message: msg, autoClose: 8000 }),
    );

    let saidaId: string;
    let saidaNumero: string;
    let devolucao: { id: string; numero: string } | null = null;

    if (answers.criarDevolucao) {
      // Mirror the plain create's numero-prefix derivation for the saída.
      const saidaOperacaoNome = await resolveOperacaoNome(
        getFirebaseFirestore(),
        values.operacaoPedidoOuterRef,
      );
      try {
        const result = await criarSaidaComDevolucao(port, { values, prepared, saidaOperacaoNome });
        saidaId = result.saidaId;
        saidaNumero = result.saidaNumero;
        devolucao = { id: result.devolucaoId, numero: result.devolucaoNumero };
      } catch (err) {
        if (err instanceof PedidoConflictError) {
          showErrorNotification({
            title: 'Pedido alterado',
            message: 'O pedido de origem foi alterado em outro computador — tente novamente.',
          });
          return false; // nothing committed — keep the form dirty
        }
        throw err;
      }
    } else {
      const created = await createPedidoWithNumero(getFirebaseFirestore(), values);
      saidaId = created.id;
      saidaNumero = created.numero;
    }

    await registrarIncidentesDeTrocaBestEffort(port, {
      saidaPedidoId: saidaId,
      saidaNumero,
      originIds: prepared.originIds,
    });

    if (devolucao !== null && answers.emitirNfe) {
      await emitirNFeComNotificacao(nfeClient, devolucao.id);
    }

    if (devolucao !== null) {
      notifications.show({ color: 'green', message: `Devolução ${devolucao.numero} criada.` });
    }
    router.replace(DIRECAO.saida.editarPath(saidaId));
  }

  async function handleSubmit(values: Pedido): Promise<boolean | void> {
    const db = getFirebaseFirestore();
    // Devolução (#488): prepare returns null whenever the flow doesn't apply
    // (not a saída, or no itens devolvidos) — the plain create below stays the
    // single untouched path in that case.
    const port = createClientPedidoPort(db);
    const prepared = await prepareDevolucaoSave(port, { values });
    if (prepared !== null) {
      return handleSaidaComDevolucao(port, values, prepared);
    }
    // Allocate a human-readable, unique `numero` atomically with the create.
    const { id } = await createPedidoWithNumero(db, values);
    // #551 parity with the edit page and the integral path: a paid entrada
    // offers to emit its NF-e right after the create.
    if (!cfg.ehSaida) {
      await promptEmitirEntrada({
        pedidoId: id,
        estado: values.estado,
        operacaoOuterRef: values.operacaoPedidoOuterRef,
      });
    }
    router.replace(cfg.editarPath(id));
  }

  return { handleSubmit, confirmElement, emitirPromptElement };
}

/** The plain create view — no pre-fill. */
function NovoPedidoCreate({ direcao }: { direcao: Direcao }) {
  const cfg = DIRECAO[direcao];
  const { handleSubmit, confirmElement, emitirPromptElement } = useCreatePedidoSubmit(direcao);

  return (
    <DirecaoSurface direcao={direcao}>
      <Stack mih={PAGE_MIN_HEIGHT}>
        <PageHeader
          title={cfg.novoTitle}
          actions={
            <Button component={Link} href={cfg.listPath} variant="subtle">
              Voltar
            </Button>
          }
        />
        {confirmElement}
        {emitirPromptElement}
        <PedidoForm ehSaida={cfg.ehSaida} submitLabel="Criar" onSubmit={handleSubmit} />
      </Stack>
    </DirecaoSurface>
  );
}

/**
 * `/pedidos/novo?copiarDe=<id>` and `/pedidos/entradas/novo?copiarDe=<id>`
 * (#370): the create form pre-filled by cloning an existing pedido — cliente,
 * operação, itens and frete carry through; state/print/marketplace metadata
 * and the origin's relational links are stripped so the duplicate starts as
 * an independent, unpaid draft (see {@link buildDuplicarPedidoSeed} for the
 * exact field-by-field rules). Saves through the same
 * {@link useCreatePedidoSubmit} path as the plain create.
 *
 * A seed whose direction disagrees with the route is refused rather than
 * rendered — see {@link direcaoIncompativelDaCopia} for why the two halves of
 * the page would otherwise contradict each other.
 */
function NovoPedidoCopia({ direcao, originId }: { direcao: Direcao; originId: string }) {
  const cfg = DIRECAO[direcao];
  const { user } = useAuth();
  const usuarioRef = user ? `documents/usuarios/${user.uid}` : null;
  const { handleSubmit, confirmElement, emitirPromptElement } = useCreatePedidoSubmit(direcao);

  const port = useMemo(() => createClientPedidoPort(getFirebaseFirestore()), []);

  const {
    data: seed,
    error,
    isPending,
  } = useQuery({
    queryKey: ['pedidos', 'duplicarSeed', originId, usuarioRef],
    // A missing origin is definitive — don't retry it.
    retry: (failureCount, err) => !(err instanceof PedidoConflictError) && failureCount < 2,
    queryFn: () => buildDuplicarPedidoSeed(port, { originId, usuarioRef }),
  });

  const direcaoDoOriginal = seed
    ? direcaoIncompativelDaCopia(seed.values.ehSaida as boolean | null | undefined, direcao)
    : null;

  return (
    <DirecaoSurface direcao={direcao}>
      <Stack mih={PAGE_MIN_HEIGHT}>
        <PageHeader
          title={cfg.novoTitle}
          description={
            seed ? `Cópia do pedido ${seed.originNumero ?? originId}` : 'Duplicar pedido'
          }
          actions={
            <Button component={Link} href={cfg.listPath} variant="subtle">
              Voltar
            </Button>
          }
        />
        {confirmElement}
        {emitirPromptElement}
        {isPending ? (
          <Stack>
            <Skeleton height={32} width={240} />
            <Skeleton height={400} />
          </Stack>
        ) : error instanceof PedidoConflictError ? (
          <Alert color="yellow" title="Pedido não encontrado">
            O pedido a ser duplicado não existe mais.{' '}
            <Anchor component={Link} href={cfg.listPath}>
              Voltar para {cfg.listTitle}
            </Anchor>
          </Alert>
        ) : error ? (
          <Alert color="red">{error.message}</Alert>
        ) : direcaoDoOriginal ? (
          <Alert color="yellow" title="Direção incompatível">
            O original é do tipo “{DIRECAO[direcaoDoOriginal].docLabel}” e a cópia mantém a direção
            do original, que não pode ser alterada. Esta página cria do tipo “{cfg.docLabel}”.{' '}
            <Anchor
              component={Link}
              href={`${DIRECAO[direcaoDoOriginal].novoPath}?copiarDe=${encodeURIComponent(originId)}`}
            >
              Duplicar em {DIRECAO[direcaoDoOriginal].listTitle}
            </Anchor>
          </Alert>
        ) : (
          <PedidoForm
            defaultValues={seed.values as Pedido}
            ehSaida={cfg.ehSaida}
            submitLabel="Criar"
            onSubmit={handleSubmit}
          />
        )}
      </Stack>
    </DirecaoSurface>
  );
}

/**
 * `/pedidos/entradas/novo?devolucaoDe=<id>` (#551): the entrada create
 * pre-seeded as a FULL return of the origin saída. The seed clones the origin
 * (devolução operação, all approved chaves referenced, current user as
 * vendedor); the save links both pedidos atomically, writes the devolução
 * incidente on the origin and may prompt to emit the entrada NF-e.
 */
function NovaEntradaDevolucaoIntegral({ originId }: { originId: string }) {
  const cfg = DIRECAO.entrada;
  const router = useRouter();
  const { user } = useAuth();
  const { promptEmitirEntrada, element: emitirPromptElement } = useEmitirEntradaPrompt();
  const usuarioRef = user ? `documents/usuarios/${user.uid}` : null;

  const port = useMemo(() => createClientPedidoPort(getFirebaseFirestore()), []);

  const {
    data: seed,
    error,
    isPending,
  } = useQuery({
    queryKey: ['pedidos', 'devolucaoIntegralSeed', originId, usuarioRef],
    // A missing origin is definitive — don't retry it.
    retry: (failureCount, err) => !(err instanceof PedidoConflictError) && failureCount < 2,
    queryFn: () => buildDevolucaoIntegralSeed(port, { originId, usuarioRef }),
  });

  async function handleSubmit(values: Pedido): Promise<boolean | void> {
    if (!seed) return false; // unreachable — the form only renders with a seed

    // The numero prefix follows the operação SELECTED at submit time — the
    // user may have changed it from the seeded devolução operação.
    const operacaoNome = await resolveOperacaoNome(
      getFirebaseFirestore(),
      values.operacaoPedidoOuterRef,
    );

    let created: { entradaId: string; numero: string };
    try {
      created = await criarEntradaDevolucaoIntegral(port, {
        values,
        originId,
        operacaoNome,
      });
    } catch (err) {
      if (err instanceof PedidoConflictError) {
        showErrorNotification({
          title: 'Pedido alterado',
          message: 'O pedido de origem não existe mais — a devolução não foi criada.',
        });
        return false;
      }
      throw err;
    }

    // Best-effort: the entrada is committed; a failed incidente write must
    // not block the flow or the navigation.
    try {
      await registrarIncidenteDeDevolucaoIntegral(port, {
        originId,
        entradaId: created.entradaId,
        entradaNumero: created.numero,
      });
    } catch (err) {
      if (err instanceof FirebaseError) {
        notifications.show({
          color: 'yellow',
          message:
            'Entrada salva, mas o incidente de devolução não pôde ser registrado no pedido de origem.',
        });
      } else {
        throw err;
      }
    }

    await promptEmitirEntrada({
      pedidoId: created.entradaId,
      estado: values.estado,
      operacaoOuterRef: values.operacaoPedidoOuterRef,
      // Pre-resolved: eligibility = fiscalCapable (finNFe 4), no NF-e probe.
      operacao: seed.operacao,
    });
    router.replace(cfg.editarPath(created.entradaId));
  }

  return (
    <DirecaoSurface direcao="entrada">
      <Stack mih={PAGE_MIN_HEIGHT}>
        <PageHeader
          title={cfg.novoTitle}
          description={
            seed
              ? `Devolução integral do pedido ${seed.originNumero ?? originId}`
              : 'Devolução integral'
          }
          actions={
            <Button component={Link} href={cfg.listPath} variant="subtle">
              Voltar
            </Button>
          }
        />
        {emitirPromptElement}
        {isPending ? (
          <Stack>
            <Skeleton height={32} width={240} />
            <Skeleton height={400} />
          </Stack>
        ) : error instanceof PedidoConflictError ? (
          <Alert color="yellow" title="Pedido de origem não encontrado">
            O pedido de origem desta devolução não existe mais.{' '}
            <Anchor component={Link} href={cfg.listPath}>
              Voltar para as entradas
            </Anchor>
          </Alert>
        ) : error ? (
          <Alert color="red">{error.message}</Alert>
        ) : (
          <PedidoForm
            defaultValues={seed.values as Pedido}
            ehSaida={false}
            submitLabel="Criar"
            onSubmit={handleSubmit}
          />
        )}
      </Stack>
    </DirecaoSurface>
  );
}
