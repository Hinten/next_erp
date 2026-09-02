'use client';

import { Alert, Badge, Code, Group, Stack, Table, Text } from '@mantine/core';
import { PageHeader } from '@delfrance/ui';
import {
  type IntegracaoTipo,
  type MarketplaceCapabilities,
  marketplaceCapsOrNull,
} from '@delfrance/schemas';

import { StatusCanalBadge } from './StatusCanalBadge';

/**
 * What a channel we have not built yet supports, straight off its
 * `MARKETPLACE_TIPO_CAPS` row (#1430).
 *
 * It replaces `PlaceholderPage`'s generic "Em construção" alert on the five
 * unbuilt channel screens. The alert said the same nothing for every one of
 * them; the row says which questions have been answered, which answers are
 * `'nao'`, and — the point of the tri-state — which nobody has asked yet.
 *
 * ⚠️ `PlaceholderPage` itself is untouched: eleven pages across `/canais`,
 * `/relatorios` and `/etiquetas` share it, and `/canais/webchat` is not a
 * marketplace tipo at all, so it keeps the generic one.
 *
 * It doubles as the Phase 0 checklist in the `marketplace-integration` skill:
 * every yellow row is a question the provider's own documentation has to close
 * before the channel can be built.
 */

export interface CanalCapsPanelProps {
  tipo: IntegracaoTipo;
  titulo: string;
  descricao: string;
}

type ValorCap = string | number | null | readonly string[];

interface GrupoCaps {
  readonly titulo: string;
  readonly linhas: ReadonlyArray<readonly [string, ValorCap]>;
}

function grupos(c: MarketplaceCapabilities): readonly GrupoCaps[] {
  return [
    {
      titulo: 'Autenticação e notificações',
      linhas: [
        ['Autenticação', c.auth],
        ['PKCE', c.pkce],
        ['Notificações', c.notificacoes],
        ['Assina os webhooks', c.assinaWebhook],
      ],
    },
    {
      titulo: 'Anúncios',
      linhas: [
        ['Publicar anúncio', c.publicarAnuncio],
        ['Importar anúncio', c.importarAnuncio],
        ['Variações', c.variacoes],
        ['Categorias e atributos', c.categoriasEAtributos],
        ['Tabela de medidas', c.tabelaDeMedidas],
        ['Kit virtual', c.kitVirtual],
        ['Pausar / reativar anúncio', c.pausarAnuncio],
      ],
    },
    {
      titulo: 'Estoque e preço',
      linhas: [
        ['Enviar estoque', c.estoque.suporte],
        ['Protocolo de estoque', c.estoque.protocolo],
        ['SKUs por chamada', c.estoque.loteMax],
        ['Estoque por depósito', c.estoque.multiDeposito],
        ['Enviar preço', c.enviarPreco],
      ],
    },
    {
      titulo: 'Pedidos',
      linhas: [
        ['Importar pedido', c.importarPedido],
        ['Importar pagamento', c.importarPagamento],
        ['Consolida pacote', c.consolidaPacote],
        ['Dados fiscais em chamada separada', c.dadosFiscaisSeparados],
      ],
    },
    {
      titulo: 'Logística e fiscal',
      linhas: [
        ['Etiqueta', c.etiqueta],
        ['Rastreio', c.rastreio],
        ['Enviar NF-e', c.enviarNfe],
      ],
    },
    {
      titulo: 'Mensagens',
      linhas: [
        ['Perguntas', c.perguntas],
        ['Mensagens pós-venda', c.mensagensPosVenda],
        ['Reclamações', c.reclamacoes],
        ['Origens na caixa de entrada', c.origensConversa],
      ],
    },
  ];
}

/**
 * ⚠️ `'desconhecido'` is yellow and reads **"não pesquisado"**, never "não".
 * A `boolean` could only have said `false`, which reads as an answer, and
 * putting an unverified claim in front of an operator is the failure #815 undid.
 */
function ValorCapBadge({ valor }: { valor: ValorCap }) {
  if (valor === null)
    return (
      <Text size="sm" c="dimmed">
        —
      </Text>
    );
  if (typeof valor === 'number') return <Text size="sm">{valor}</Text>;
  if (Array.isArray(valor)) {
    const lista = valor as readonly string[];
    return lista.length === 0 ? (
      <Text size="sm" c="dimmed">
        —
      </Text>
    ) : (
      <Group gap={4}>
        {lista.map((v) => (
          <Badge key={v} variant="light" color="blue" size="sm">
            {v}
          </Badge>
        ))}
      </Group>
    );
  }

  const texto = valor as string;
  if (texto === 'desconhecido') {
    return (
      <Badge variant="light" color="yellow" size="sm">
        não pesquisado
      </Badge>
    );
  }
  if (texto === 'sim') {
    return (
      <Badge variant="light" color="green" size="sm">
        sim
      </Badge>
    );
  }
  if (texto === 'nao') {
    return (
      <Badge variant="light" color="gray" size="sm">
        não
      </Badge>
    );
  }
  if (texto === 'nenhuma' || texto === 'nenhum') {
    return (
      <Badge variant="light" color="gray" size="sm">
        {texto}
      </Badge>
    );
  }
  return (
    <Badge variant="light" color="blue" size="sm">
      {texto}
    </Badge>
  );
}

export function CanalCapsPanel({ tipo, titulo, descricao }: CanalCapsPanelProps) {
  const caps = marketplaceCapsOrNull(tipo);

  return (
    <Stack>
      <PageHeader title={titulo} description={descricao} />

      <Group gap="xs">
        <StatusCanalBadge caps={caps} />
      </Group>

      {caps === null ? (
        <Alert color="gray" title="Sem tabela de capacidades">
          Este tipo de integração não é um canal de marketplace, então não tem uma linha em{' '}
          <Code>MARKETPLACE_TIPO_CAPS</Code>.
        </Alert>
      ) : (
        <>
          {!caps.implementado && (
            <Alert color="yellow" title="Canal ainda não implementado">
              Não existe backend <Code mx={4}>apps/&lt;canal&gt;</Code> para este canal, então nada
              é publicado, importado nem sincronizado por aqui. A tabela abaixo é o que se sabe
              sobre o canal hoje.
              <Text size="sm" mt="xs">
                <strong>&quot;Não pesquisado&quot; não quer dizer que o canal não faz</strong> —
                quer dizer que ninguém leu a documentação dele ainda. Fechar essas linhas é o
                primeiro passo de implementar o canal.
              </Text>
            </Alert>
          )}

          {grupos(caps).map((grupo) => (
            <Stack key={grupo.titulo} gap={4}>
              <Text fw={600} size="sm">
                {grupo.titulo}
              </Text>
              <Table withTableBorder withColumnBorders>
                <Table.Tbody>
                  {grupo.linhas.map(([rotulo, valor]) => (
                    <Table.Tr key={rotulo}>
                      <Table.Td w="60%">
                        <Text size="sm">{rotulo}</Text>
                      </Table.Td>
                      <Table.Td>
                        <ValorCapBadge valor={valor} />
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Stack>
          ))}

          <Text size="xs" c="dimmed">
            Fonte: <Code>MARKETPLACE_TIPO_CAPS</Code> em{' '}
            <Code>packages/schemas/src/shared/marketplace.ts</Code> (ADR 0015).
          </Text>
        </>
      )}
    </Stack>
  );
}
