'use client';

import { PedidosListView } from './_components/PedidosListView';
import { useDevolucaoIntegralAction } from './_components/useDevolucaoIntegralAction';

export default function PedidosPage() {
  // Saída-only action (#551): jumps to the pre-seeded entrada create page.
  const devolucaoIntegralAction = useDevolucaoIntegralAction();
  return <PedidosListView direcao="saida" extraActions={[devolucaoIntegralAction]} />;
}
