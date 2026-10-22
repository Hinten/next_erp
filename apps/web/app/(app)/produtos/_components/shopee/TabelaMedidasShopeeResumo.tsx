'use client';

import Link from 'next/link';
import { Anchor, Group, Text } from '@mantine/core';
import {
  MOTIVO_SEM_TABELA_SHOPEE,
  lerEntradasShopeeDaConta,
  resolverEntradaShopee,
  type MotivoSemTabelaShopee,
} from '@delfrance/schemas';

import type { TabelaMedidasDoProduto } from './ContaShopeePanel';
import { numeroFinito } from './campos';

export interface TabelaMedidasShopeeResumoProps {
  tabelaMedidas: TabelaMedidasDoProduto;
  /** The listing's conta, or `null` when its conta ref names no id. */
  contaId: string | null;
  /** The listing's `category_id`, unvalidated. */
  categoryId: unknown;
}

/** Why no template applies, as the operator reads it. Exhaustive by type. */
const TEXTO_SEM_TABELA = {
  [MOTIVO_SEM_TABELA_SHOPEE.anuncioSemCategoria]:
    'Anúncio sem categoria — nenhum modelo de tabela se aplica.',
  [MOTIVO_SEM_TABELA_SHOPEE.contaSemEntradas]:
    'A tabela de medidas do produto não tem modelo da Shopee para esta conta.',
  [MOTIVO_SEM_TABELA_SHOPEE.categoriaSemEntrada]:
    'A tabela de medidas do produto não tem modelo para a categoria deste anúncio.',
} as const satisfies Record<MotivoSemTabelaShopee, string>;

/**
 * The size-chart TEMPLATE entry the produto's tabela de medidas holds for this
 * listing's conta and category — `resolverEntradaShopee(lerEntradasShopeeDaConta(…))`,
 * the selection rule's one home in `@delfrance/schemas`. This file holds no
 * selection rule.
 *
 * ⚠️ It says which entry applies, never what a publish SENT: what actually goes
 * out (a template or something else) is publish's decision, not restated here —
 * the tab can name it only once a republish answers with it (residual 7).
 */
export function TabelaMedidasShopeeResumo({
  tabelaMedidas,
  contaId,
  categoryId,
}: TabelaMedidasShopeeResumoProps) {
  if (tabelaMedidas.estado === 'carregando') return null;
  if (tabelaMedidas.estado === 'sem-tabela') {
    return (
      <Text size="sm" c="dimmed">
        Tabela de medidas: o produto não tem tabela de medidas.
      </Text>
    );
  }
  if (tabelaMedidas.estado === 'ref-invalida') {
    return (
      <Text size="sm" c="dimmed">
        Tabela de medidas: o produto aponta para algo que não é uma tabela de medidas (
        {tabelaMedidas.ref}).
      </Text>
    );
  }
  if (tabelaMedidas.estado === 'ausente') {
    return (
      <Text size="sm" c="dimmed">
        Tabela de medidas: o produto aponta para uma tabela que não existe mais ({tabelaMedidas.id}
        ).
      </Text>
    );
  }

  const abrir = (
    <Anchor component={Link} href={`/medidas/${tabelaMedidas.id}`} size="sm">
      Abrir tabela «{tabelaMedidas.nome}»
    </Anchor>
  );

  if (contaId === null) {
    return (
      <Group gap="xs">
        <Text size="sm" c="dimmed">
          Tabela de medidas: sem conta legível, nenhum modelo a resolver.
        </Text>
        {abrir}
      </Group>
    );
  }

  const categoria = numeroFinito(categoryId);
  const resolucao = resolverEntradaShopee(
    lerEntradasShopeeDaConta(tabelaMedidas.entradasShopee, contaId),
    categoria !== null && Number.isInteger(categoria) ? categoria : null,
  );

  return (
    <Group gap="xs">
      {resolucao.motivo === null ? (
        <Text size="sm">
          Tabela de medidas: modelo #{resolucao.entrada.size_chart_id} (categoria «
          {resolucao.entrada.name}»)
        </Text>
      ) : (
        <Text size="sm" c="dimmed">
          Tabela de medidas: {TEXTO_SEM_TABELA[resolucao.motivo]}
        </Text>
      )}
      {abrir}
    </Group>
  );
}
