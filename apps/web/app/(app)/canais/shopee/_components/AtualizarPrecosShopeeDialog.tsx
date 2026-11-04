'use client';

/**
 * The "Atualizar preços" dialog for a Shopee conta (#1529, step 21-5). One run
 * for the selected conta; the single toggle is the price-DECREASE opt-in, which
 * `useAtualizarPrecosShopeeAction` re-arms to `false` on every open.
 */
import { Button, Checkbox, Group, Modal, Stack, Text } from '@mantine/core';

import { ContasSelecionadas } from '@/components/contaJobs/ContasSelecionadas';
import type { AtualizarPrecosShopeeActionState } from './useAtualizarPrecosShopeeAction';

export function AtualizarPrecosShopeeDialog({
  state,
}: {
  state: AtualizarPrecosShopeeActionState;
}) {
  return (
    <Modal opened={state.opened} onClose={state.close} title="Atualizar preços" centered>
      <Stack>
        <Text size="sm" c="dimmed">
          Envia o preço da tabela de preços normal de cada anúncio vinculado à Shopee nesta conta.
          Preços iguais são pulados; reduções só são enviadas com a opção abaixo.
        </Text>
        <ContasSelecionadas contas={state.contas} />
        <Checkbox
          label="Permitir baixar preços"
          checked={state.baixarPreco}
          onChange={(e) => state.setBaixarPreco(e.currentTarget.checked)}
        />
        <Text size="xs" c="dimmed">
          Sem esta opção, reduções são puladas (preco-menor-bloqueado).
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={state.close}>
            Cancelar
          </Button>
          <Button
            onClick={() => {
              void state.start();
            }}
            loading={state.busy}
          >
            Atualizar preços
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
