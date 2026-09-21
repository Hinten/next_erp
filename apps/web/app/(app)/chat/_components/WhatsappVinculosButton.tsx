'use client';

import Link from 'next/link';
import { Badge, Button } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { usePermission } from '@/lib/auth';
import { useWhatsappVinculosBadge } from '../_hooks/useWhatsappVinculos';

export function WhatsappVinculosButton() {
  const { allowed } = usePermission(PERM.chat.read | PERM.cliente.read);
  const { data } = useWhatsappVinculosBadge();
  if (!allowed) return null;
  const count = data?.items.length ?? 0;
  return (
    <Button
      component={Link}
      href="/chat/vinculos-whatsapp"
      variant="light"
      size="xs"
      rightSection={
        count > 0 ? (
          <Badge size="xs">{data?.nextCursor ? `${String(count)}+` : count}</Badge>
        ) : undefined
      }
    >
      Contatos aguardando vínculo
    </Button>
  );
}
