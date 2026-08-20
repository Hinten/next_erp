'use client';

import { useState } from 'react';
import {
  ActionIcon,
  Button,
  Group,
  Menu,
  Modal,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconDots,
  IconLogin2,
  IconLogout2,
  IconMessageForward,
  IconPencilCog,
  IconSend2,
  IconTag,
  IconTrash,
  IconUserOff,
  IconUserPlus,
  IconUsersGroup,
} from '@tabler/icons-react';
import { FirebaseError } from 'firebase/app';
import { writeBatch } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { ORIGEM_CONVERSA, ESTADO_CONVERSA, idFromRef, type Conversa } from '@delfrance/schemas';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import {
  enterConversa,
  finishConversa,
  includeAtendente,
  leaveConversa,
  renameConversa,
  resolveActor,
  setEtiqueta,
  transferConversa,
  type ActionActor,
} from '@/lib/chat/conversaActions';
import {
  useWhatsappClient,
  WhatsappClientHttpError,
  WhatsappClientNetworkError,
} from '@/lib/whatsapp/client';
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  useMercadoLivreClient,
} from '@/lib/mercado-livre/client';
import { EtiquetaPicker } from '../EtiquetaPicker';
import { AtendentePickerModal } from './AtendentePickerModal';

interface ActionBatchCtx {
  batch: import('firebase/firestore').WriteBatch;
  db: ReturnType<typeof getFirebaseFirestore>;
  conversaId: string;
  actor: ActionActor;
  now: number;
}

type OpenModal = 'none' | 'rename' | 'etiqueta' | 'transfer' | 'include';

interface ConfirmSpec {
  title: string;
  message: string;
  confirmLabel: string;
  color?: string;
  run: () => void | Promise<void>;
}

/**
 * The conversa-actions menu shown in the `/chat/[id]` header — the port of the
 * legacy `ConversaMenuWidget` (`.old/lib/chat/basico/conversa_popup_menu.dart`).
 * Every item writes its lifecycle EVENT via the pure {@link conversaActions}
 * writers (so each state change carries an event, parity with legacy), replacing
 * the old free-form estado `Select`. Items are gated by conversa state exactly
 * as legacy's `MenuAnchor` gates them.
 */
export function ConversaActionsMenu({
  conversaId,
  conversa,
}: {
  conversaId: string;
  conversa: Conversa;
}) {
  const { user } = useAuth();
  const whatsappClient = useWhatsappClient();
  const mlClient = useMercadoLivreClient();
  // Transferir / Incluir are gated on the usuario-read permission, matching
  // legacy `has_perm(UsuarioPerms().read)` — which maps to PERM.configuracoes.read
  // (bit 40), the read bit the `usuarios` collection shares.
  const { allowed: canManageAtendentes } = usePermission(PERM.configuracoes.read);

  const [openModal, setOpenModal] = useState<OpenModal>('none');
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [busy, setBusy] = useState(false);
  const [renameValue, setRenameValue] = useState(conversa.nome);
  const [cor, setCor] = useState<number | null>(conversa.cor_etiqueta);

  const uid = user?.uid ?? null;
  const usuarios = conversa.usuarios ?? [];
  const participant = uid != null && usuarios.includes(uid);
  const isWhatsapp = conversa.origem === ORIGEM_CONVERSA.whatsapp;
  const isEmResposta = conversa.estadoConversa === ESTADO_CONVERSA.emResposta;
  /**
   * The two moderation actions ML offers on a PRE-SALE question, and only there
   * — a post-sale thread has neither, and neither exists on any other channel.
   */
  const isPergunta = conversa.origem === ORIGEM_CONVERSA.mercadoLivrePerguntas;
  const integracaoId = conversa.integracaoOuterRef ? idFromRef(conversa.integracaoOuterRef) : null;

  function closeAll() {
    setOpenModal('none');
    setConfirm(null);
  }

  /** Build a batch, run one action writer, commit, notify. */
  async function runBatchAction(
    build: (ctx: ActionBatchCtx) => void,
    successMessage: string,
  ): Promise<void> {
    const actor = resolveActor(user);
    if (!actor) return;
    setBusy(true);
    const db = getFirebaseFirestore();
    const now = Date.now();
    const batch = writeBatch(db);
    build({ batch, db, conversaId, actor, now });
    try {
      await batch.commit();
      notifications.show({ color: 'teal', message: successMessage });
      closeAll();
    } catch (err) {
      if (err instanceof FirebaseError) {
        notifications.show({ color: 'red', title: 'Falha na ação', message: err.message });
      } else {
        throw err;
      }
    } finally {
      setBusy(false);
    }
  }

  async function sendTemplateMessage(): Promise<void> {
    if (!whatsappClient) {
      // Logged out / backend URL unset → the client hook returns null. Surface it
      // instead of silently no-op'ing the confirmed action.
      notifications.show({
        color: 'red',
        title: 'Envio indisponível',
        message: 'Backend WhatsApp não configurado.',
      });
      closeAll();
      return;
    }
    setBusy(true);
    try {
      await whatsappClient.templateMessage(conversaId);
      notifications.show({
        color: 'teal',
        title: 'Mensagem padrão enviada',
        message: 'O template de reabertura foi enviado.',
      });
      closeAll();
    } catch (err) {
      if (err instanceof WhatsappClientHttpError || err instanceof WhatsappClientNetworkError) {
        notifications.show({ color: 'red', title: 'Falha ao enviar', message: err.message });
      } else {
        throw err;
      }
    } finally {
      setBusy(false);
    }
  }

  /**
   * Run one of ML's question moderation actions (#533).
   *
   * ⚠️ Writes NOTHING locally on success. Both actions change the question's
   * `status` on ML, and the question importer is the single writer of that
   * state — the notification ML sends back closes the conversa with the right
   * `respostaBloqueada`. Guessing it here would race the importer and could
   * disagree with it.
   */
  async function runAcaoPergunta(acao: 'excluir' | 'bloquear'): Promise<void> {
    if (!mlClient || !integracaoId) {
      notifications.show({
        color: 'red',
        title: 'Ação indisponível',
        message: 'Conta do Mercado Livre não resolvida para esta conversa.',
      });
      closeAll();
      return;
    }
    setBusy(true);
    try {
      await mlClient.acaoPergunta({ integracaoId, conversaId, acao });
      notifications.show({
        color: 'teal',
        message:
          acao === 'excluir'
            ? 'Pergunta excluída no Mercado Livre.'
            : 'Usuário bloqueado para novas perguntas.',
      });
      closeAll();
    } catch (err) {
      if (
        err instanceof MercadoLivreClientHttpError ||
        err instanceof MercadoLivreClientNetworkError
      ) {
        notifications.show({ color: 'red', title: 'Falha na ação', message: err.message });
      } else {
        throw err;
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Menu position="bottom-end" withinPortal shadow="md" width={240}>
        <Menu.Target>
          <Tooltip label="Ações da conversa">
            <ActionIcon variant="subtle" color="gray" aria-label="Ações da conversa">
              <IconDots size={20} />
            </ActionIcon>
          </Tooltip>
        </Menu.Target>
        <Menu.Dropdown>
          {!participant && (
            <Menu.Item
              leftSection={<IconLogin2 size={16} />}
              onClick={() =>
                setConfirm({
                  title: 'Entrar na conversa?',
                  message: `Deseja entrar na conversa ${conversa.nome}?`,
                  confirmLabel: 'Entrar',
                  run: () =>
                    runBatchAction((ctx) => enterConversa(ctx), 'Você entrou na conversa.'),
                })
              }
            >
              Entrar na conversa
            </Menu.Item>
          )}

          <Menu.Item
            leftSection={<IconTag size={16} />}
            onClick={() => {
              setCor(conversa.cor_etiqueta);
              setOpenModal('etiqueta');
            }}
          >
            Definir etiqueta
          </Menu.Item>

          <Menu.Item
            leftSection={<IconPencilCog size={16} />}
            onClick={() => {
              setRenameValue(conversa.nome);
              setOpenModal('rename');
            }}
          >
            Renomear
          </Menu.Item>

          {isWhatsapp && (
            <Menu.Item
              leftSection={<IconSend2 size={16} />}
              onClick={() =>
                setConfirm({
                  title: 'Mensagem padrão',
                  message:
                    'Enviar a mensagem padrão "Olá, podemos dar continuidade no seu atendimento?" via WhatsApp?',
                  confirmLabel: 'Enviar',
                  run: () => sendTemplateMessage(),
                })
              }
            >
              Enviar mensagem padrão
            </Menu.Item>
          )}

          {canManageAtendentes && (
            <>
              <Menu.Item
                leftSection={<IconMessageForward size={16} />}
                onClick={() => setOpenModal('transfer')}
              >
                Transferir para outro atendente
              </Menu.Item>
              <Menu.Item
                leftSection={<IconUserPlus size={16} />}
                onClick={() => setOpenModal('include')}
              >
                Incluir outro atendente
              </Menu.Item>
            </>
          )}

          {isEmResposta && (
            <Menu.Item
              leftSection={<IconUsersGroup size={16} />}
              onClick={() =>
                setConfirm({
                  title: 'Encerrar atendimento?',
                  message: `Deseja encerrar o atendimento da conversa ${conversa.nome}?`,
                  confirmLabel: 'Encerrar',
                  run: () =>
                    runBatchAction(
                      (ctx) => finishConversa({ ...ctx, usuarios: conversa.usuarios }),
                      'Atendimento encerrado.',
                    ),
                })
              }
            >
              Encerrar atendimento
            </Menu.Item>
          )}

          {isPergunta && (
            <>
              <Menu.Item
                color="red"
                leftSection={<IconTrash size={16} />}
                onClick={() =>
                  setConfirm({
                    title: 'Excluir pergunta?',
                    message:
                      'A pergunta sai do anúncio para todos no Mercado Livre e não pode ser restaurada por aqui.',
                    confirmLabel: 'Excluir',
                    color: 'red',
                    run: () => runAcaoPergunta('excluir'),
                  })
                }
              >
                Excluir pergunta
              </Menu.Item>
              <Menu.Item
                color="red"
                leftSection={<IconUserOff size={16} />}
                onClick={() =>
                  setConfirm({
                    title: 'Bloquear usuário?',
                    message:
                      'O usuário deixa de poder perguntar em qualquer anúncio da conta. O desbloqueio só existe no Mercado Livre.',
                    confirmLabel: 'Bloquear',
                    color: 'red',
                    run: () => runAcaoPergunta('bloquear'),
                  })
                }
              >
                Bloquear usuário
              </Menu.Item>
            </>
          )}

          {participant && (
            <Menu.Item
              color="red"
              leftSection={<IconLogout2 size={16} />}
              onClick={() =>
                setConfirm({
                  title: 'Sair da conversa?',
                  message: `Deseja sair da conversa ${conversa.nome}?`,
                  confirmLabel: 'Sair',
                  color: 'red',
                  run: () =>
                    runBatchAction(
                      (ctx) => leaveConversa({ ...ctx, usuarios: conversa.usuarios }),
                      'Você saiu da conversa.',
                    ),
                })
              }
            >
              Deixar a conversa
            </Menu.Item>
          )}
        </Menu.Dropdown>
      </Menu>

      {/* Generic confirm dialog (entrar / encerrar / deixar / mensagem padrão). */}
      <Modal
        opened={confirm !== null}
        onClose={() => !busy && setConfirm(null)}
        title={confirm?.title}
        size="sm"
      >
        <Stack gap="md">
          <Text size="sm">{confirm?.message}</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirm(null)} disabled={busy}>
              Cancelar
            </Button>
            <Button
              color={confirm?.color ?? 'blue'}
              loading={busy}
              onClick={() => {
                // Last-resort UI boundary: the action runners already narrow
                // Firebase/WhatsApp errors into notifications; anything else
                // reaching here would otherwise become an unhandled rejection.
                // Notify for Error instances, rethrow non-Error throwables.
                void (async () => {
                  try {
                    await confirm?.run();
                  } catch (err) {
                    if (!(err instanceof Error)) throw err;
                    notifications.show({
                      color: 'red',
                      title: 'Falha na ação',
                      message: err.message,
                    });
                  }
                })();
              }}
            >
              {confirm?.confirmLabel}
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Renomear */}
      <Modal
        opened={openModal === 'rename'}
        onClose={() => !busy && setOpenModal('none')}
        title={`Renomear ${conversa.nome}`}
        size="sm"
      >
        <Stack gap="md">
          <TextInput
            data-autofocus
            label="Novo nome"
            value={renameValue}
            onChange={(e) => setRenameValue(e.currentTarget.value)}
            error={renameValue.trim() === '' ? 'Informe um nome válido.' : undefined}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setOpenModal('none')} disabled={busy}>
              Cancelar
            </Button>
            <Button
              loading={busy}
              disabled={renameValue.trim() === '' || renameValue.trim() === conversa.nome}
              onClick={() =>
                void runBatchAction(
                  (ctx) =>
                    renameConversa({
                      ...ctx,
                      usuarios: conversa.usuarios,
                      oldNome: conversa.nome,
                      newNome: renameValue.trim(),
                    }),
                  'Conversa renomeada.',
                )
              }
            >
              Renomear
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Definir etiqueta */}
      <Modal
        opened={openModal === 'etiqueta'}
        onClose={() => !busy && setOpenModal('none')}
        title="Definir etiqueta"
        size="auto"
      >
        <Stack gap="md">
          <EtiquetaPicker value={cor} onChange={setCor} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setOpenModal('none')} disabled={busy}>
              Cancelar
            </Button>
            <Button
              loading={busy}
              onClick={() =>
                void runBatchAction(
                  (ctx) => setEtiqueta({ ...ctx, usuarios: conversa.usuarios, cor }),
                  'Etiqueta atualizada.',
                )
              }
            >
              Aplicar
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Transferir */}
      <AtendentePickerModal
        opened={openModal === 'transfer'}
        onClose={() => setOpenModal('none')}
        title="Transferir atendimento"
        confirmLabel="Transferir"
        submitting={busy}
        excludeUids={[uid]}
        onConfirm={(target) =>
          void runBatchAction(
            (ctx) => transferConversa({ ...ctx, usuarios: conversa.usuarios, target }),
            'Conversa transferida.',
          )
        }
      />

      {/* Incluir atendente */}
      <AtendentePickerModal
        opened={openModal === 'include'}
        onClose={() => setOpenModal('none')}
        title="Incluir atendente"
        confirmLabel="Incluir"
        submitting={busy}
        // Exclude the operator AND the current participants: re-including an
        // already-present atendente would append a duplicate entry event.
        excludeUids={[uid, ...usuarios]}
        onConfirm={(target) =>
          void runBatchAction((ctx) => includeAtendente({ ...ctx, target }), 'Atendente incluído.')
        }
      />
    </>
  );
}
