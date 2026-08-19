'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Group, Stack, Text } from '@mantine/core';

import { formatCategoriaPath } from '@/lib/mercado-livre/categoriaTree';
import { useMercadoLivreClient } from '@/lib/mercado-livre/client';
import { mercadoLivreQueryRetry } from '@/lib/mercado-livre/errors';
import { CategoriaPickerModal } from './CategoriaPickerModal';

const METADATA_STALE_MS = 30 * 60 * 1000;

export interface CategoriaFieldProps {
  integracaoId: string;
  /** The stored `category_id`, or null on a fresh draft. */
  value: string | null;
  onChange: (categoryId: string) => void;
  /** Seeds the suggestion request. */
  produtoNome: string;
  disabled?: boolean;
  error?: string;
}

/**
 * The listing's category: what it is now, and the only way to change it.
 *
 * Rendered as text plus a button rather than a labelled control. The value is
 * an ML id (`MLB31447`) that no one can type from memory and that means nothing
 * on screen, so the field's job is to show the resolved **path** and hand the
 * operator the cascade — the id itself is never edited directly.
 *
 * Resolving the path costs one request per listing that has a category. It is
 * cached for half an hour client-side on top of the server's own read cache,
 * and it is what turns "MLB31447" into something an operator can verify.
 */
export function CategoriaField({
  integracaoId,
  value,
  onChange,
  produtoNome,
  disabled,
  error,
}: CategoriaFieldProps) {
  const client = useMercadoLivreClient();
  const [pickerOpen, setPickerOpen] = useState(false);

  const pathQuery = useQuery({
    queryKey: ['ml', 'categorias', integracaoId, value],
    enabled: value != null && client != null,
    staleTime: METADATA_STALE_MS,
    queryFn: () => client!.categorias({ integracaoId, categoryId: value }),
    // No alert here on purpose: a failed lookup degrades to showing the raw
    // `MLB…` id, which still names the category and still opens the picker. The
    // automatic retry is what makes that fallback rare.
    retry: mercadoLivreQueryRetry,
  });
  const path = formatCategoriaPath(pathQuery.data?.node ?? null);

  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">
        Categoria
      </Text>
      <Group gap="xs" wrap="wrap">
        {value == null ? (
          <Text size="sm" c="dimmed">
            Não definida
          </Text>
        ) : (
          <Stack gap={0}>
            <Text size="sm">{path ?? value}</Text>
            {path != null && (
              <Text size="xs" c="dimmed">
                {value}
              </Text>
            )}
          </Stack>
        )}
        <Button
          type="button"
          variant="light"
          size="compact-sm"
          onClick={() => setPickerOpen(true)}
          disabled={disabled || client == null}
        >
          {value == null ? 'Escolher categoria' : 'Alterar'}
        </Button>
      </Group>
      {error != null && (
        <Text size="xs" c="red">
          {error}
        </Text>
      )}

      {pickerOpen && (
        <CategoriaPickerModal
          opened={pickerOpen}
          onClose={() => setPickerOpen(false)}
          integracaoId={integracaoId}
          initialCategoryId={value}
          produtoNome={produtoNome}
          onSelect={onChange}
        />
      )}
    </Stack>
  );
}
