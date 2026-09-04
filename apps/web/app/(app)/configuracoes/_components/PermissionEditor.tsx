'use client';

import { Card, Checkbox, Group, Stack, Text, Title } from '@mantine/core';
import { PERM } from '@delfrance/auth';

const DOMAIN_LABELS: Record<keyof typeof PERM, string> = {
  cliente: 'Clientes',
  endereco: 'Endereços',
  produto: 'Produtos',
  categoria: 'Categorias',
  pedido: 'Pedidos',
  pagamento: 'Pagamentos',
  metodoPagamento: 'Métodos de pagamento',
  nfe: 'NF-e',
  configuracoes: 'Configurações',
  chat: 'Atendimento',
  mensagem: 'Mensagens',
  integracao: 'Integrações',
  estoque: 'Estoque',
  fiscal: 'Fiscal',
  impostoProduto: 'Imposto de produto',
  impostoCategoria: 'Imposto de categoria',
  regraImposto: 'Regras de imposto',
  arquivo: 'Arquivos',
  frete: 'Frete',
  cmun: 'Tabela de municípios (CEP → IBGE)',
  incidenteResolucao: 'Resolução de reclamações (marketplace)',
  webchat: 'Webchat',
};

const ACTION_LABELS: Record<string, string> = {
  read: 'Ler',
  write: 'Editar',
  delete: 'Excluir',
};

/**
 * Per-domain overrides where "Editar" would understate what the bit does.
 * `incidenteResolucao.write` executes a refund on the marketplace — the checkbox
 * has to say so, because a cargo editor is where someone decides who may.
 */
const ACTION_LABELS_POR_DOMINIO: Partial<Record<keyof typeof PERM, Record<string, string>>> = {
  incidenteResolucao: { read: 'Consultar', write: 'Executar (reembolso, devolução, mediação)' },
};

export interface PermissionEditorProps {
  value: bigint;
  onChange?: (next: bigint) => void;
  readOnly?: boolean;
}

export function PermissionEditor({ value, onChange, readOnly = false }: PermissionEditorProps) {
  function toggle(bit: bigint, checked: boolean) {
    if (readOnly || !onChange) return;
    const next = checked ? value | bit : value & ~bit;
    onChange(next);
  }

  return (
    <Stack gap="sm">
      {(Object.entries(PERM) as [keyof typeof PERM, Record<string, bigint>][]).map(
        ([domain, actions]) => (
          <Card withBorder key={domain} padding="sm">
            <Stack gap="xs">
              <Title order={5}>{DOMAIN_LABELS[domain]}</Title>
              <Group gap="lg">
                {Object.entries(actions).map(([action, bit]) => {
                  const granted = (value & bit) === bit;
                  return (
                    <Checkbox
                      key={action}
                      label={
                        ACTION_LABELS_POR_DOMINIO[domain]?.[action] ??
                        ACTION_LABELS[action] ??
                        action
                      }
                      checked={granted}
                      readOnly={readOnly}
                      disabled={readOnly}
                      onChange={(e) => toggle(bit, e.currentTarget.checked)}
                    />
                  );
                })}
              </Group>
            </Stack>
          </Card>
        ),
      )}
      {readOnly && value === 0n && (
        <Text c="dimmed" size="sm">
          Nenhuma permissão atribuída.
        </Text>
      )}
    </Stack>
  );
}
