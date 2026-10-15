'use client';

import { useCallback, type ReactNode } from 'react';
import { Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { PERM } from '@delfrance/auth';
import { detectarEnderecosDeOutroCliente, planejarCopiasDeEndereco } from '@delfrance/data/pedido';
import type { Pedido } from '@delfrance/schemas';
import { usePermission } from '@/lib/auth';
import { newDocId } from '@/lib/data/newDocId';
import { useConfirmDialog } from './ConfirmDialog';
import type { PedidoSubmitPreparation } from './PedidoForm';

export function usePedidoEnderecoCopyPreparation(): {
  prepareSubmit: (values: Pedido) => Promise<PedidoSubmitPreparation | false>;
  element: ReactNode;
} {
  const { allowed: canRead, loading: readLoading } = usePermission(PERM.endereco.read);
  const { allowed: canWrite, loading: writeLoading } = usePermission(PERM.endereco.write);
  const { confirm, element } = useConfirmDialog();

  const prepareSubmit = useCallback(
    async (values: Pedido): Promise<PedidoSubmitPreparation | false> => {
      const mismatches = detectarEnderecosDeOutroCliente(values);
      if (mismatches.length === 0) return { enderecoCopyPlan: null };

      if (readLoading || writeLoading) {
        notifications.show({
          color: 'yellow',
          message: 'As permissões de endereço ainda estão carregando. Tente salvar novamente.',
        });
        return false;
      }
      if (!canRead || !canWrite) {
        notifications.show({
          color: 'red',
          title: 'Sem permissão para copiar endereço',
          message:
            'Você precisa das permissões de leitura e escrita de endereço para salvar este pedido.',
        });
        return false;
      }

      const usos = new Set(mismatches.map((mismatch) => mismatch.uso));
      const descricao =
        usos.size === 2
          ? 'Os endereços fiscal e de entrega selecionados pertencem a outro cliente.'
          : usos.has('fiscal')
            ? 'O endereço fiscal selecionado pertence a outro cliente.'
            : 'O endereço de entrega selecionado pertence a outro cliente.';
      const confirmed = await confirm({
        title: 'Copiar endereço para o cliente selecionado?',
        message: (
          <Text>
            {descricao} Uma cópia será criada para o cliente atual e o endereço original será
            mantido.
          </Text>
        ),
        confirmLabel: 'Copiar e salvar',
        cancelLabel: 'Revisar',
      });
      if (!confirmed) return false;

      return { enderecoCopyPlan: planejarCopiasDeEndereco(values, newDocId) };
    },
    [canRead, canWrite, confirm, readLoading, writeLoading],
  );

  return { prepareSubmit, element };
}
