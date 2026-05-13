'use client';

import { Badge, Skeleton } from '@mantine/core';
import { useGrupoEconomico } from '@/lib/data/useGrupoEconomico';

export function TenantBadge() {
  const { data, loading } = useGrupoEconomico();
  if (loading) return <Skeleton height={20} width={120} />;
  if (!data) return null;
  return (
    <Badge variant="light" color="blue" size="lg" radius="sm">
      {data.data.nome}
    </Badge>
  );
}
