'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Loader,
  Modal,
  NavLink,
  ScrollArea,
  Stack,
  Text,
} from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';

import {
  canSelectCategoria,
  categoriaBreadcrumb,
  levelChildren,
} from '@/lib/mercado-livre/categoriaTree';
import { useMercadoLivreClient } from '@/lib/mercado-livre/client';

/** ML metadata barely moves; a half-hour is generous and still bounded. */
const METADATA_STALE_MS = 30 * 60 * 1000;

export interface CategoriaPickerModalProps {
  opened: boolean;
  onClose: () => void;
  integracaoId: string;
  /** Where the cascade opens, when the listing already has a category. */
  initialCategoryId: string | null;
  /** Seeds "Sugerir categoria" — ML ranks by title text. */
  produtoNome: string;
  onSelect: (categoryId: string) => void;
}

/**
 * The category cascade, plus ML's own ranked suggestions.
 *
 * #799's acceptance criterion is that the category is **offered, never
 * applied** — publish used to pick `suggestCategories(nome, 1)[0]` silently,
 * with no human in the loop and no screen showing what it chose. So the
 * suggestions here are a list the operator picks from, and picking is the only
 * way a `category_id` is ever written.
 *
 * Navigation is one level per request rather than a prefetched tree: ML's
 * catalogue is tens of thousands of nodes, and the operator only ever walks one
 * branch of it.
 */
export function CategoriaPickerModal({
  opened,
  onClose,
  integracaoId,
  initialCategoryId,
  produtoNome,
  onSelect,
}: CategoriaPickerModalProps) {
  const client = useMercadoLivreClient();
  const [cursor, setCursor] = useState<string | null>(initialCategoryId);
  const [showSuggestions, setShowSuggestions] = useState(false);

  const levelQuery = useQuery({
    queryKey: ['ml', 'categorias', integracaoId, cursor],
    enabled: opened && client != null,
    staleTime: METADATA_STALE_MS,
    queryFn: () => client!.categorias({ integracaoId, categoryId: cursor }),
  });

  const suggestionsQuery = useQuery({
    queryKey: ['ml', 'categorias', 'sugestoes', integracaoId, produtoNome],
    enabled: opened && showSuggestions && client != null && produtoNome.trim().length > 0,
    staleTime: METADATA_STALE_MS,
    queryFn: () => client!.sugerirCategorias({ integracaoId, q: produtoNome, limit: 8 }),
  });

  const node = levelQuery.data?.node ?? null;
  const children = levelChildren(levelQuery.data);
  const selectable = canSelectCategoria(node);

  function choose(categoryId: string) {
    onSelect(categoryId);
    onClose();
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Categoria do Mercado Livre" size="lg" centered>
      <Stack gap="sm">
        <Group gap={4} wrap="wrap">
          {categoriaBreadcrumb(node).map((crumb, index, all) =>
            index === all.length - 1 ? (
              <Text key={crumb.id ?? 'root'} size="sm" fw={600}>
                {crumb.name}
              </Text>
            ) : (
              <Group key={crumb.id ?? 'root'} gap={4} wrap="nowrap">
                <Anchor size="sm" onClick={() => setCursor(crumb.id)}>
                  {crumb.name}
                </Anchor>
                <IconChevronRight size={12} />
              </Group>
            ),
          )}
        </Group>

        {!showSuggestions && (
          <Button
            type="button"
            variant="light"
            size="xs"
            onClick={() => setShowSuggestions(true)}
            disabled={produtoNome.trim().length === 0}
          >
            Sugerir categoria pelo nome do produto
          </Button>
        )}

        {showSuggestions && (
          <Stack gap={4}>
            <Text size="xs" c="dimmed">
              Sugestões do Mercado Livre para “{produtoNome}”. Escolher é opcional — nada é aplicado
              automaticamente.
            </Text>
            {suggestionsQuery.isPending && <Loader size="xs" />}
            {suggestionsQuery.isError && (
              <Alert color="red" variant="light">
                Não foi possível obter sugestões.
              </Alert>
            )}
            {suggestionsQuery.data?.sugestoes.length === 0 && (
              <Text size="sm" c="dimmed">
                O Mercado Livre não sugeriu nenhuma categoria para este nome.
              </Text>
            )}
            {(suggestionsQuery.data?.sugestoes ?? []).map((s) => (
              <NavLink
                key={s.categoryId}
                label={s.categoryName ?? s.categoryId}
                description={s.domainName ?? s.domainId ?? undefined}
                rightSection={
                  <Badge size="xs" variant="light">
                    {s.categoryId}
                  </Badge>
                }
                onClick={() => choose(s.categoryId)}
              />
            ))}
          </Stack>
        )}

        {levelQuery.isPending && (
          <Group justify="center" py="md">
            <Loader size="sm" />
          </Group>
        )}
        {levelQuery.isError && (
          <Alert color="red" variant="light">
            Não foi possível carregar as categorias do Mercado Livre.
          </Alert>
        )}

        <ScrollArea.Autosize mah={320}>
          <Stack gap={0}>
            {children.map((child) => (
              <NavLink
                key={child.id}
                label={child.name ?? child.id}
                rightSection={<IconChevronRight size={14} />}
                onClick={() => setCursor(child.id)}
              />
            ))}
          </Stack>
        </ScrollArea.Autosize>

        {node != null && !selectable && children.length > 0 && (
          <Text size="xs" c="dimmed">
            Continue até a última subcategoria — só uma categoria final tem atributos e tipos de
            anúncio.
          </Text>
        )}

        <Group justify="flex-end">
          <Button type="button" variant="default" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="button" disabled={!selectable} onClick={() => node && choose(node.id)}>
            Usar esta categoria
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
