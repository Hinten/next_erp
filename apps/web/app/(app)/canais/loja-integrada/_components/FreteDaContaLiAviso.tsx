'use client';

import { Alert, Stack, Text } from '@mantine/core';
import type { FreteDaContaLi } from './useFreteDaContaLi';

export interface FreteDaContaLiAvisoProps {
  readonly frete: FreteDaContaLi;
  /** The tabs' server-truth seed, once a doc is chosen. */
  readonly semente: { readonly ready: boolean; readonly error: string | null };
}

/**
 * The state line shared by both freight tabs of a Loja Integrada conta: why
 * there is nothing to edit (loading, no permission, no doc, a failed read), or
 * what to know about the doc being edited (inactive, one of several, gone since
 * load, still loading from the server). Renders nothing when the doc is loaded
 * and unremarkable.
 */
export function FreteDaContaLiAviso({ frete, semente }: FreteDaContaLiAvisoProps) {
  switch (frete.estado) {
    case 'carregando':
      return (
        <Text size="sm" c="dimmed">
          Carregando o frete da conta…
        </Text>
      );
    case 'sem-permissao':
      return (
        <Alert color="gray" title="Sem permissão">
          Você não tem permissão para ver as integrações de frete, então o frete desta conta não é
          exibido.
        </Alert>
      );
    case 'erro':
      return (
        <Alert color="red" title="Falha ao carregar o frete da conta">
          {frete.mensagem}
        </Alert>
      );
    case 'ausente':
      return (
        <Alert color="blue" title="Esta conta ainda não tem frete">
          O frete da conta é criado pelo servidor a partir dos dados da conta (a filial e a data de
          cadastro precisam estar preenchidas). Esta tela não o cria: quando ele existir, o
          mapeamento e os horários de corte aparecem aqui.
        </Alert>
      );
    case 'encontrado':
      return (
        <Stack gap="xs">
          {!frete.naConsulta && (
            <Alert color="red" title="O frete desta conta mudou">
              O documento de frete carregado não está mais ligado a esta conta. Recarregue a página
              antes de editar.
            </Alert>
          )}
          {!frete.ativo && (
            <Alert color="yellow" title="Frete inativo">
              O frete desta conta está inativo: a importação de pedidos não o usa enquanto ele não
              for reativado (ele segue a conta).
            </Alert>
          )}
          {frete.total > 1 && (
            <Alert color="yellow" title="Mais de um documento de frete">
              Esta conta tem {frete.total} documentos de frete. Esta tela edita o que a importação
              de pedidos usa.
            </Alert>
          )}
          {semente.error !== null && (
            <Alert color="red" title="Falha ao carregar o frete da conta">
              {semente.error}
            </Alert>
          )}
          {semente.error === null && !semente.ready && (
            <Text size="sm" c="dimmed">
              Carregando o frete da conta do servidor…
            </Text>
          )}
        </Stack>
      );
  }
}
