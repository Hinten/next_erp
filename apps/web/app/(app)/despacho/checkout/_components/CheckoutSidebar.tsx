'use client';

import { Divider, Select, Stack } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import type { NFeHttpClient } from '@delfrance/integrations-nfe/http-provider';
import type { FreightHttpClient } from '@delfrance/integrations-freight-br/http-client';
import type { Pedido } from '@delfrance/schemas';
import type { CheckoutDanfeFormat } from '@/lib/checkout/nfeFlow';
import { NfeStatusTile } from './NfeStatusTile';
import { FreteSummary } from './FreteSummary';
import { OutrosCheckoutsPane } from './OutrosCheckoutsPane';

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
  db: Firestore;
  /** the loaded pedido (the parent renders the sidebar only when one is loaded). */
  pedido: Pedido;
  pedidoId: string;
  /** current operator uid for the Outros-Checkouts query; `null` while unresolved. */
  uid: string | null;
  nfeClient: NFeHttpClient | null;
  freightClient: FreightHttpClient | null;
  formatoDanfe: CheckoutDanfeFormat;
  onFormatoDanfe: (v: CheckoutDanfeFormat) => void;
  formatoEtiqueta: 'pdf' | 'zpl2';
  onFormatoEtiqueta: (v: 'pdf' | 'zpl2') => void;
  /** re-fetch the loaded pedido (after an external freight edit). */
  onReload: () => void;
}

/**
 * The checkout right-rail: live NF-e status, a read-only frete summary
 * (link-out + reload), the DANFE / etiqueta print-format selects that drive both
 * the Salvar post-save and the reprints, and the "Outros Checkouts" reprint
 * panel. The print-target reliability lives in `OutroCheckoutModal` — this shell
 * just wires the pieces for the loaded pedido.
 */
export function CheckoutSidebar({
  db,
  pedido,
  pedidoId,
  uid,
  nfeClient,
  freightClient,
  formatoDanfe,
  onFormatoDanfe,
  formatoEtiqueta,
  onFormatoEtiqueta,
  onReload,
}: CheckoutSidebarProps) {
  return (
    <Stack gap="sm" w={240}>
      <NfeStatusTile db={db} pedidoId={pedidoId} />
      <FreteSummary pedidoId={pedidoId} frete={pedido.freteInicial} onReload={onReload} />

      <Divider />

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
      <OutrosCheckoutsPane
        db={db}
        uid={uid}
        nfeClient={nfeClient}
        freightClient={freightClient}
        formatoDanfe={formatoDanfe}
        formatoEtiqueta={formatoEtiqueta}
      />
    </Stack>
  );
}
