'use client';

import { Button } from '@mantine/core';

/**
 * "Baixar CSV" for one finished run. Shared by the live card and the Histórico
 * modal, so the two cannot drift on what a download means.
 *
 * The page counter is not decoration: a large report is several sequential round
 * trips, and a button that looks stuck for ten seconds gets clicked again.
 */
export function BaixarRelatorioButton({
  jobId,
  contaId,
  contaNome,
  baixar,
  baixando,
  pagina,
}: {
  jobId: string;
  contaId: string;
  contaNome: string;
  baixar: (alvo: { jobId: string; contaId: string; contaNome: string }) => Promise<void>;
  baixando: boolean;
  pagina: number;
}) {
  return (
    <Button
      size="compact-xs"
      variant="light"
      loading={baixando}
      onClick={() => void baixar({ jobId, contaId, contaNome })}
    >
      {baixando && pagina > 0 ? `Baixando… página ${String(pagina)}` : 'Baixar CSV'}
    </Button>
  );
}
