'use client';

import { Alert, Badge, Group, Stack, Text } from '@mantine/core';
import type { ProdutoShopeeLink } from '@delfrance/schemas';

import { formatarInstanteShopee } from '@/lib/shopee/anuncioProduto';
import { numeroFinito, textoPreenchido } from './campos';

export interface ViolacoesAnuncioShopeeProps {
  link: ProdutoShopeeLink;
}

/** What one stored violation row says, read field by field (the row may be raw). */
interface ViolacaoLida {
  readonly tipo: 'Bloqueio' | 'Rebaixamento' | null;
  readonly titulo: string | null;
  readonly motivo: string | null;
  readonly sugestao: string | null;
  readonly corrigirAte: string | null;
  readonly diasLegado: number | null;
  readonly categoriasSugeridas: readonly string[];
}

/**
 * What Shopee says is wrong with this listing — the stored `violations[]`
 * (push 18 and the re-verify's `get_item_violation_info`, flattened into one
 * list whose `kind` tells a take-down from a deboost).
 *
 * ⚠️ A legacy row carries `days_to_fix` — a DURATION from the retired code-6
 * push — and is printed as that duration, never turned into a date: the
 * conversion needs a clock and is not idempotent (`shopeeLink.ts`). A modern
 * row's `fix_deadline_time` is already MILLISECONDS.
 */
export function ViolacoesAnuncioShopee({ link }: ViolacoesAnuncioShopeeProps) {
  const linhas = Array.isArray(link.violations) ? link.violations.map(lerViolacao) : [];
  if (linhas.length === 0) return null;
  const desde = formatarInstanteShopee(link.violacoesLidasEm);

  return (
    <Alert color="red" variant="light" title="Pendências apontadas pela Shopee">
      <Stack gap="xs">
        {linhas.map((v, i) => (
          <Stack key={i} gap={2}>
            <Group gap="xs">
              {v.tipo !== null && (
                <Badge color={v.tipo === 'Bloqueio' ? 'red' : 'orange'} variant="light" size="sm">
                  {v.tipo}
                </Badge>
              )}
              <Text size="sm" fw={500}>
                {v.titulo ?? 'Violação sem tipo informado'}
              </Text>
            </Group>
            {v.motivo !== null && <Text size="sm">{v.motivo}</Text>}
            {v.sugestao !== null && (
              <Text size="sm" c="dimmed">
                Sugestão: {v.sugestao}
              </Text>
            )}
            {v.categoriasSugeridas.length > 0 && (
              <Text size="sm" c="dimmed">
                Categorias sugeridas: {v.categoriasSugeridas.join(', ')}
              </Text>
            )}
            {v.corrigirAte !== null && <Text size="xs">Corrigir até {v.corrigirAte}</Text>}
            {v.diasLegado !== null && (
              <Text size="xs">prazo: {v.diasLegado} dias (registro antigo)</Text>
            )}
          </Stack>
        ))}
        {desde !== null && (
          <Text size="xs" c="dimmed">
            Desde {desde}
          </Text>
        )}
      </Stack>
    </Alert>
  );
}

function lerViolacao(bruta: unknown): ViolacaoLida {
  const v = typeof bruta === 'object' && bruta !== null ? (bruta as Record<string, unknown>) : {};
  const categorias = Array.isArray(v.suggested_category)
    ? v.suggested_category.flatMap((c: unknown) => {
        if (typeof c !== 'object' || c === null) return [];
        const nome = textoPreenchido((c as Record<string, unknown>).category_name);
        return nome === null ? [] : [nome];
      })
    : [];
  return {
    tipo: v.kind === 'status' ? 'Bloqueio' : v.kind === 'deboost' ? 'Rebaixamento' : null,
    titulo: textoPreenchido(v.violation_type),
    motivo: textoPreenchido(v.violation_reason),
    sugestao: textoPreenchido(v.suggestion),
    corrigirAte: formatarInstanteShopee(v.fix_deadline_time),
    diasLegado: numeroFinito(v.days_to_fix),
    categoriasSugeridas: categorias,
  };
}
