'use client';

import { Alert, Badge, Code, Group, Stack, Table, Text } from '@mantine/core';
import { PageHeader } from '@delfrance/ui';
import {
  type EstoqueCapabilities,
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
 *
 * ⚠️ Which is exactly why the field list below is TOTAL rather than
 * hand-enumerated. `CAMPOS_CAPS` is a `Record` over every renderable key of
 * `MarketplaceCapabilities` and `EstoqueCapabilities`, so adding a capability
 * without giving it a label is a **compile error** — the same structural
 * guarantee that makes a missing caps row one. A cap that silently missed this
 * table would be a question nobody is asked to answer, which is the unreached
 * surface this whole PR exists to close. `pausarAnuncio` had to be remembered
 * in three places by hand when it was added; this is the fourth, and the only
 * one the compiler was not already watching.
 */

export interface CanalCapsPanelProps {
  tipo: IntegracaoTipo;
  titulo: string;
  descricao: string;
}

type ValorCap = string | number | null | readonly string[];

/**
 * Every capability worth rendering, as a flat key.
 *
 * Derived from the interfaces rather than listed: `channel` and `implementado`
 * are facts about this repo and are carried by {@link StatusCanalBadge}, and
 * `estoque` is flattened into its own four fields. A new field on either
 * interface widens this union, and the `Record` below then fails to compile.
 */
type CampoCaps =
  | Exclude<keyof MarketplaceCapabilities, 'channel' | 'implementado' | 'estoque'>
  | `estoque.${keyof EstoqueCapabilities & string}`;

interface DescritorCampo {
  readonly rotulo: string;
  readonly ler: (caps: MarketplaceCapabilities) => ValorCap;
}

/**
 * ⚠️ Total by annotation. Exported so `CanalCapsPanel.test.tsx` can check the
 * other half — a field declared here but placed in no group would compile and
 * still never render.
 */
export const CAMPOS_CAPS: Record<CampoCaps, DescritorCampo> = {
  auth: { rotulo: 'Autenticação', ler: (c) => c.auth },
  pkce: { rotulo: 'PKCE', ler: (c) => c.pkce },
  notificacoes: { rotulo: 'Notificações', ler: (c) => c.notificacoes },
  assinaWebhook: { rotulo: 'Assina os webhooks', ler: (c) => c.assinaWebhook },

  publicarAnuncio: { rotulo: 'Publicar anúncio', ler: (c) => c.publicarAnuncio },
  importarAnuncio: { rotulo: 'Importar anúncio', ler: (c) => c.importarAnuncio },
  variacoes: { rotulo: 'Variações', ler: (c) => c.variacoes },
  categoriasEAtributos: { rotulo: 'Categorias e atributos', ler: (c) => c.categoriasEAtributos },
  tabelaDeMedidas: { rotulo: 'Tabela de medidas', ler: (c) => c.tabelaDeMedidas },
  kitVirtual: { rotulo: 'Kit virtual', ler: (c) => c.kitVirtual },
  pausarAnuncio: { rotulo: 'Pausar / reativar anúncio', ler: (c) => c.pausarAnuncio },

  'estoque.suporte': { rotulo: 'Enviar estoque', ler: (c) => c.estoque.suporte },
  'estoque.protocolo': { rotulo: 'Protocolo de estoque', ler: (c) => c.estoque.protocolo },
  'estoque.loteMax': { rotulo: 'SKUs por chamada', ler: (c) => c.estoque.loteMax },
  'estoque.multiDeposito': { rotulo: 'Estoque por depósito', ler: (c) => c.estoque.multiDeposito },
  enviarPreco: { rotulo: 'Enviar preço', ler: (c) => c.enviarPreco },

  importarPedido: { rotulo: 'Importar pedido', ler: (c) => c.importarPedido },
  importarPagamento: { rotulo: 'Importar pagamento', ler: (c) => c.importarPagamento },
  consolidaPacote: { rotulo: 'Consolida pacote', ler: (c) => c.consolidaPacote },
  dadosFiscaisSeparados: {
    rotulo: 'Dados fiscais em chamada separada',
    ler: (c) => c.dadosFiscaisSeparados,
  },

  etiqueta: { rotulo: 'Etiqueta', ler: (c) => c.etiqueta },
  rastreio: { rotulo: 'Rastreio', ler: (c) => c.rastreio },
  enviarNfe: { rotulo: 'Enviar NF-e', ler: (c) => c.enviarNfe },

  perguntas: { rotulo: 'Perguntas', ler: (c) => c.perguntas },
  mensagensPosVenda: { rotulo: 'Mensagens pós-venda', ler: (c) => c.mensagensPosVenda },
  reclamacoes: { rotulo: 'Reclamações', ler: (c) => c.reclamacoes },
  origensConversa: { rotulo: 'Origens na caixa de entrada', ler: (c) => c.origensConversa },
};

/** Presentation only — which fields sit under which heading, in reading order. */
const GRUPOS: ReadonlyArray<{ readonly titulo: string; readonly campos: readonly CampoCaps[] }> = [
  {
    titulo: 'Autenticação e notificações',
    campos: ['auth', 'pkce', 'notificacoes', 'assinaWebhook'],
  },
  {
    titulo: 'Anúncios',
    campos: [
      'publicarAnuncio',
      'importarAnuncio',
      'variacoes',
      'categoriasEAtributos',
      'tabelaDeMedidas',
      'kitVirtual',
      'pausarAnuncio',
    ],
  },
  {
    titulo: 'Estoque e preço',
    campos: [
      'estoque.suporte',
      'estoque.protocolo',
      'estoque.loteMax',
      'estoque.multiDeposito',
      'enviarPreco',
    ],
  },
  {
    titulo: 'Pedidos',
    campos: ['importarPedido', 'importarPagamento', 'consolidaPacote', 'dadosFiscaisSeparados'],
  },
  {
    titulo: 'Logística e fiscal',
    campos: ['etiqueta', 'rastreio', 'enviarNfe'],
  },
  {
    titulo: 'Mensagens',
    campos: ['perguntas', 'mensagensPosVenda', 'reclamacoes', 'origensConversa'],
  },
];

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

          {GRUPOS.map((grupo) => (
            <Stack key={grupo.titulo} gap={4}>
              <Text fw={600} size="sm">
                {grupo.titulo}
              </Text>
              <Table withTableBorder withColumnBorders>
                <Table.Tbody>
                  {grupo.campos.map((campo) => (
                    <Table.Tr key={campo}>
                      <Table.Td w="60%">
                        <Text size="sm">{CAMPOS_CAPS[campo].rotulo}</Text>
                      </Table.Td>
                      <Table.Td>
                        <ValorCapBadge valor={CAMPOS_CAPS[campo].ler(caps)} />
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
