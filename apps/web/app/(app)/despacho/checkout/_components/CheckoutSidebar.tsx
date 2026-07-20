'use client';

import { Divider, Select, Stack, Text } from '@mantine/core';
import type { CheckoutDanfeFormat } from '@/lib/checkout/nfeFlow';

const DANFE_OPTIONS: { value: CheckoutDanfeFormat; label: string }[] = [
  { value: 'simplificadoPdf', label: 'Simplificado PDF' },
  { value: 'simplificadoZpl2', label: 'Simplificado ZPL2' },
  { value: 'retrato', label: 'Retrato PDF' },
  { value: 'paisagem', label: 'Paisagem PDF' },
];

const ETIQUETA_OPTIONS: { value: 'pdf' | 'zpl2'; label: string }[] = [
  { value: 'pdf', label: 'PDF' },
  { value: 'zpl2', label: 'ZPL2' },
];

export interface CheckoutSidebarProps {
  formatoDanfe: CheckoutDanfeFormat;
  onFormatoDanfe: (v: CheckoutDanfeFormat) => void;
  formatoEtiqueta: 'pdf' | 'zpl2';
  onFormatoEtiqueta: (v: 'pdf' | 'zpl2') => void;
  /** whether a pedido is loaded (drives the placeholder copy). */
  hasPedido: boolean;
}

/**
 * The right-hand controls column. PR 5 wires the two print-format selects (they
 * drive the post-save DANFE / etiqueta calls, so they must be live here);
 * the NF-e status tile, frete summary (link + reload), and the "Outros
 * Checkouts" realtime panel are PR 6's reliability surfaces — placeholders for
 * now (`outrosCheckoutsQuery` already exists in `@/lib/checkout/queries`).
 */
export function CheckoutSidebar({
  formatoDanfe,
  onFormatoDanfe,
  formatoEtiqueta,
  onFormatoEtiqueta,
  hasPedido,
}: CheckoutSidebarProps) {
  return (
    <Stack gap="sm" w={240}>
      <Select
        label="Formato do DANFE"
        data={DANFE_OPTIONS}
        value={formatoDanfe}
        allowDeselect={false}
        onChange={(v) => v && onFormatoDanfe(v as CheckoutDanfeFormat)}
      />
      <Select
        label="Formato da etiqueta"
        data={ETIQUETA_OPTIONS}
        value={formatoEtiqueta}
        allowDeselect={false}
        onChange={(v) => v && onFormatoEtiqueta(v as 'pdf' | 'zpl2')}
      />
      <Divider label="Outros checkouts" labelPosition="center" />
      <Text size="xs" c="dimmed">
        {hasPedido
          ? 'Painel de reimpressão e status (NF-e, frete, outros checkouts) — em breve.'
          : 'Carregue um pedido para começar.'}
      </Text>
    </Stack>
  );
}
