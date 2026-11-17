'use client';

/**
 * The product imports (master plan step 9) of ONE conta, on
 * `/canais/loja-integrada/[id]` — the page the import's three avisos link to
 * (`ROTAS_AVISO.canalLojaIntegrada`), so their "the import's report" lands on
 * it. The list page's own pieces, unchanged: the conta's newest job as a card
 * (`ImportacoesLiPanel`: progress, Cancelar, "Ver resultado"), and the result
 * view (`ResultadoImportacaoLi`) with its picker over the conta's other ended
 * jobs and its tax-review list.
 *
 * No start button: "Importar produtos da loja" is a list-page action over the
 * selected contas. A finished Simular's "Importar selecionados" still starts
 * from here, through this page's own ledger, so its card shows here.
 *
 * Gated like the list page's rail: a viewer with the read or the write bit
 * follows the imports; only the write bit cancels and starts.
 */
import { useMemo, useState } from 'react';
import { Box } from '@mantine/core';
import { PERM } from '@delfrance/auth';

import { usePermission } from '@/lib/auth';
import type { ContaRef } from '@/lib/marketplace/contaJobs/types';
import type { AlvoResultadoImportacaoLi } from './CartaoImportacaoLi';
import { ImportacoesLiPanel } from './ImportacoesLiPanel';
import { ResultadoImportacaoLi } from './ResultadoImportacaoLi';
import { useImportarProdutosLiAction } from './useImportarProdutosLiAction';

/**
 * The conta's label on its own page. The page reads the conta through its form,
 * not here: a second listener for one label is not worth it, and the page's
 * title already says which conta this is.
 */
export const NOME_DA_CONTA_NA_PROPRIA_TELA_LI = 'Esta conta';

export function ImportacoesDaContaLi({ integracaoId }: { integracaoId: string }) {
  const { allowed: canRead } = usePermission(PERM.integracao.read);
  const { allowed: canWrite } = usePermission(PERM.integracao.write);
  const importacao = useImportarProdutosLiAction();
  const [resultado, setResultado] = useState<AlvoResultadoImportacaoLi | null>(null);
  const selecionadas = useMemo<readonly ContaRef[]>(
    () => [{ id: integracaoId, nome: NOME_DA_CONTA_NA_PROPRIA_TELA_LI }],
    [integracaoId],
  );

  if (!canRead && !canWrite) return null;
  return (
    <>
      <Box maw={420}>
        <ImportacoesLiPanel
          collapsed={false}
          selecionadas={selecionadas}
          importacao={importacao.state}
          podeCancelar={canWrite}
          onAbrirResultado={setResultado}
        />
      </Box>
      <ResultadoImportacaoLi
        alvo={resultado}
        onClose={() => setResultado(null)}
        onAbrir={setResultado}
        importacao={canWrite ? importacao.state : null}
      />
    </>
  );
}
