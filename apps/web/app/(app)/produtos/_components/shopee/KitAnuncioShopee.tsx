'use client';

import type { Firestore } from 'firebase/firestore';
import { Alert, Button, Group, List, Loader, Stack, Table, Text } from '@mantine/core';
import {
  anuncioShopeeVivo,
  ehVinculoSubstituido,
  type MotivoEstruturaLocalKit,
  type ProdutoShopeeLink,
} from '@delfrance/schemas';

import { formatarInstanteShopee, itemIdDoAnuncioShopee } from '@/lib/shopee/anuncioProduto';
import {
  useReceitaKitShopee,
  type ProblemaDaReceitaKitShopee,
  type ReceitaKitShopee,
} from '@/lib/shopee/useReceitaKitShopee';
import type { AcoesShopee, IncertoKitNaTela } from './AcoesAnuncioShopee';

export interface KitAnuncioShopeeProps {
  db: Firestore;
  produtoId: string;
  contaId: string;
  linkDocId: string;
  link: ProdutoShopeeLink;
  /** The produto's STORED `ehKit` — what the converter's server gate reads. */
  produtoEhKit: boolean;
  acoes: AcoesShopee;
}

/**
 * Whether "Recriar kit" applies to a link: a native kit Shopee knows by its
 * `item_id` — live, removed or superseded (a superseded one whose delete did not
 * take is retried the same way). The server's gate is the link's own
 * `kitNativo === true`.
 */
export function recriavel(link: ProdutoShopeeLink): boolean {
  return link.kitNativo === true && itemIdDoAnuncioShopee(link.item_id) !== null;
}

/**
 * Whether "Converter em kit nativo" applies: a LIVE ordinary listing
 * (`anuncioShopeeVivo`, not superseded, not a native kit) of a produto whose
 * stored `ehKit` is on — a pre-filter of the server's own refusals
 * (`converter-sem-kit`, `ja-e-kit-nativo`), never a second judge of them.
 */
export function convertivel(link: ProdutoShopeeLink, produtoEhKit: boolean): boolean {
  return (
    produtoEhKit &&
    link.kitNativo !== true &&
    anuncioShopeeVivo(link) &&
    !ehVinculoSubstituido(link)
  );
}

/**
 * The listing's KIT section (step 21-3, PR 8): on a native-kit link, or on any
 * link of a produto marked as kit. Collapsed it reads nothing; "Ver composição"
 * reads the ERP recipe ({@link useReceitaKitShopee}) and its local warnings.
 * Then the create arms — "Recriar kit" / "Converter em kit nativo", each opening
 * the editor's confirmation — and the uncertain create of this link, if one is
 * pending, with its "Repetir".
 *
 * ⚠️ The warnings NEVER disable a button: the publish re-decides each against
 * the real Shopee addresses. What disables the create arms is a write in flight
 * from this tab, or an uncertain create of this conta whose wait is not over —
 * a second `add_kit_item` before Shopee lists the first is a second kit.
 */
export function KitAnuncioShopee({
  db,
  produtoId,
  contaId,
  linkDocId,
  link,
  produtoEhKit,
  acoes,
}: KitAnuncioShopeeProps) {
  const aberto = acoes.kitAberto(linkDocId);
  const receita = useReceitaKitShopee({ db, produtoId, enabled: aberto });
  if (link.kitNativo !== true && !produtoEhKit) return null;

  const incerto = acoes.incertoDe(contaId);
  const incertoAqui = incerto !== null && incerto.corpo.linkDocId === linkDocId ? incerto : null;
  const podeRecriar = recriavel(link);
  const podeConverter = convertivel(link, produtoEhKit);
  const travado = acoes.bloqueadas || (incerto?.pendente ?? false);
  const carregando = (arma: 'recriar' | 'converter') =>
    acoes.emVoo !== null && acoes.emVoo.linkDocId === linkDocId && acoes.emVoo.acao === arma;

  return (
    <Stack gap="xs" data-testid={`shopee-kit-${linkDocId}`}>
      <Group gap="xs">
        <Text size="sm" fw={500}>
          Kit
        </Text>
        <Button
          type="button"
          variant="subtle"
          size="xs"
          aria-expanded={aberto}
          onClick={() => acoes.alternarKit(linkDocId)}
        >
          {aberto ? 'Ocultar composição' : 'Ver composição'}
        </Button>
      </Group>
      {aberto && <ComposicaoKitShopee receita={receita} />}
      {incertoAqui !== null && (
        <IncertoDoKit contaId={contaId} incerto={incertoAqui} acoes={acoes} />
      )}
      {acoes.permitidas && (podeRecriar || podeConverter) && (
        <Group gap="xs">
          {podeRecriar && (
            <Button
              type="button"
              size="xs"
              variant="light"
              color="grape"
              disabled={travado}
              loading={carregando('recriar')}
              onClick={() => acoes.abrirKit(contaId, linkDocId, 'recriar')}
            >
              Recriar kit
            </Button>
          )}
          {podeConverter && (
            <Button
              type="button"
              size="xs"
              variant="light"
              color="grape"
              disabled={travado}
              loading={carregando('converter')}
              onClick={() => acoes.abrirKit(contaId, linkDocId, 'converter')}
            >
              Converter em kit nativo
            </Button>
          )}
        </Group>
      )}
    </Stack>
  );
}

/**
 * A kit create the server could not confirm (`data-testid="shopee-kit-incerto-<contaId>"`):
 * what may have happened, until when to wait, and "Repetir" — the IDENTICAL
 * body, offered only once the wait is over. Exported so the conta panel can show
 * it when the link it names is no longer listed.
 */
export function IncertoDoKit({
  contaId,
  incerto,
  acoes,
}: {
  contaId: string;
  incerto: IncertoKitNaTela;
  acoes: AcoesShopee;
}) {
  const ate = formatarInstanteShopee(incerto.ate);
  return (
    <Alert
      color="yellow"
      variant="light"
      title="A Shopee pode ter criado o kit"
      data-testid={`shopee-kit-incerto-${contaId}`}
    >
      <Stack gap="xs">
        <Text size="sm">
          A resposta não confirmou se o kit foi criado.{' '}
          {incerto.pendente
            ? `Aguarde${ate === null ? '' : ` até ${ate}`} e use "Repetir": o ERP envia exatamente o mesmo pedido — se o kit existir, ele recusa e indica importá-lo; senão, cria o kit.`
            : 'Use "Repetir": o ERP envia exatamente o mesmo pedido — se o kit existir, ele recusa e indica importá-lo; senão, cria o kit.'}
        </Text>
        {incerto.fraseShopee !== null && (
          <Text size="sm" c="dimmed">
            A Shopee respondeu: {incerto.fraseShopee}
          </Text>
        )}
        {acoes.permitidas && (
          <Group>
            <Button
              type="button"
              size="xs"
              variant="light"
              color="yellow"
              disabled={acoes.bloqueadas || incerto.pendente}
              onClick={() => acoes.repetirKit(contaId)}
            >
              Repetir
            </Button>
          </Group>
        )}
      </Stack>
    </Alert>
  );
}

/** What the operator reads for each local structural warning. Exhaustive by type. */
const FRASE_DO_PROBLEMA_DA_RECEITA = {
  'kit-sem-unidade-vendavel': () =>
    'O kit não tem variação vendável — salve o produto no ERP para criar a variação única antes ' +
    'de publicar.',
  'kit-variacoes-demais': (_unidade: string, detalhe: string) =>
    `A Shopee aceita um número limitado de variações num kit: ${detalhe}.`,
  'kit-sem-componentes': (unidade: string) => `A variação ${unidade} não tem componentes.`,
  'kit-componente-unico-quantidade': (unidade: string) =>
    `A variação ${unidade} tem um único componente com quantidade 1 — um kit de um componente ` +
    'precisa de quantidade 2 ou mais.',
} as const satisfies Record<MotivoEstruturaLocalKit, (unidade: string, detalhe: string) => string>;

function textoDoProblemaDaReceita(
  p: ProblemaDaReceitaKitShopee,
  nomeDaUnidade: (filhoId: string) => string,
): string {
  const unidade = p.filhoId === null ? '' : nomeDaUnidade(p.filhoId);
  return FRASE_DO_PROBLEMA_DA_RECEITA[p.motivo](unidade, p.detalhe);
}

/**
 * The ERP recipe the kit's Shopee models are made of: one row per sellable unit
 * (component × quantity), then the local structural warnings
 * (`data-testid="shopee-receita-kit"`). The SAVED recipe — what a recriar sends.
 */
export function ComposicaoKitShopee({ receita }: { receita: ReceitaKitShopee }) {
  if (receita.estado === 'desligada') return null;
  if (receita.estado === 'carregando') {
    return (
      <Group justify="center" py="xs">
        <Loader size="xs" />
      </Group>
    );
  }
  if (receita.estado === 'erro') {
    return (
      <Alert color="red" variant="light">
        Erro ao carregar a composição do kit: {receita.mensagem}
      </Alert>
    );
  }
  const { unidades, nomes, problemas } = receita;
  const nomeDoComponente = (id: string) => {
    const nome = nomes.get(id);
    return nome === undefined ? id : `${nome} (${id})`;
  };
  const nomeDaUnidade = (filhoId: string) =>
    unidades.find((u) => u.filhoId === filhoId)?.nome ?? filhoId;

  return (
    <Stack gap="xs" data-testid="shopee-receita-kit">
      <Text size="xs" c="dimmed">
        A composição SALVA no ERP — é ela que a Shopee recebe ao recriar ou converter.
      </Text>
      {unidades.length > 0 && (
        <Table withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Variação</Table.Th>
              <Table.Th>Componentes</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {unidades.map((u) => (
              <Table.Tr key={u.filhoId}>
                <Table.Td>{u.nome ?? u.filhoId}</Table.Td>
                <Table.Td>
                  {u.componentes.length === 0
                    ? '—'
                    : u.componentes
                        .map((c) => `${String(c.quantidade)} × ${nomeDoComponente(c.produtoId)}`)
                        .join('; ')}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {problemas.length > 0 && (
        <Alert
          color="yellow"
          variant="light"
          title="A Shopee deve recusar esta composição"
          data-testid="shopee-receita-kit-avisos"
        >
          <List size="sm" spacing={2}>
            {problemas.map((p, i) => (
              <List.Item key={`${p.motivo}-${p.filhoId ?? ''}-${String(i)}`}>
                {textoDoProblemaDaReceita(p, nomeDaUnidade)}
              </List.Item>
            ))}
          </List>
          <Text size="xs" c="dimmed" mt={4}>
            Um aviso, não um bloqueio: a publicação confere de novo com os anúncios da Shopee.
          </Text>
        </Alert>
      )}
    </Stack>
  );
}
