'use client';

/**
 * The "Atualizar preços" dialog. One job per selected conta; the single toggle
 * is the price-DECREASE opt-in, which `usePriceSyncAction` re-arms to `false`
 * on every open.
 */
import { Button, Checkbox, Group, Modal, Stack, Text } from '@mantine/core';

import { ContasSelecionadas } from './MassImportDialog';
import type { PriceSyncActionState } from './usePriceSyncAction';

export function PriceSyncDialog({ state }: { state: PriceSyncActionState }) {
  return (
    <Modal opened={state.opened} onClose={state.close} title="Atualizar preços" centered>
      <Stack>
        <Text size="sm" c="dimmed">
          Envia o preço da tabela de preços normal de cada produto vinculado ao Mercado Livre das
          contas selecionadas. Preços iguais são pulados; preços menores que o atual no Mercado
          Livre só são enviados com a opção abaixo.
        </Text>
        <ContasSelecionadas contas={state.contas} />
        <Checkbox
          label="Permitir baixar preços"
          checked={state.baixarPreco}
          onChange={(e) => state.setBaixarPreco(e.currentTarget.checked)}
        />
        <Text size="xs" c="dimmed">
          Sem esta opção, reduções de preço são puladas com o código PRECO_ANTIGO_MAIOR.
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
            Enviar preços
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
