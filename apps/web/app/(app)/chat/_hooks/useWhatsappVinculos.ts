'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { PERM } from '@delfrance/auth';
import { usePermission } from '@/lib/auth';
import { useWhatsappClient } from '@/lib/whatsapp/client';

export const WHATSAPP_VINCULOS_QUERY = ['whatsapp-vinculos'] as const;

export function useWhatsappVinculos(integracaoId?: string) {
  const client = useWhatsappClient();
  const { allowed } = usePermission(PERM.chat.read | PERM.cliente.read);
  return useInfiniteQuery({
    queryKey: [...WHATSAPP_VINCULOS_QUERY, 'lista', integracaoId ?? null],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => client!.vinculos({ integracaoId, cursor: pageParam, limit: 30 }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: allowed && client !== null,
    refetchInterval: 30_000,
  });
}

export function useWhatsappVinculosBadge() {
  const client = useWhatsappClient();
  const { allowed } = usePermission(PERM.chat.read | PERM.cliente.read);
  return useQuery({
    queryKey: [...WHATSAPP_VINCULOS_QUERY, 'badge'],
    queryFn: () => client!.vinculos({ limit: 10 }),
    enabled: allowed && client !== null,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}
