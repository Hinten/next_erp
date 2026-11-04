'use client';

/**
 * Fetch a Shopee price run's whole per-model report page by page, build the CSV
 * and hand it to the browser (#1529, step 21-5).
 *
 * A SIBLING of Mercado Livre's `useBaixarRelatorioPreco`, not a wrapper over it:
 * the RULES are shared — the CSV builder, its trailer, the filename and the page
 * cap all come from `lib/marketplace/contaJobs/envioPrecoCsv.ts` — while the loop
 * is per channel, because the two wires differ where it matters:
 *
 *  - Shopee's report page carries NO counters, so the trailer and the filename
 *    come from ONE status read, made AFTER the last page: a cancel's in-flight
 *    listing may still add rows, and reading the counters last keeps them ≥ the
 *    rows the file holds;
 *  - there is no "Sem relatório" branch: every terminal Shopee stamp writes at
 *    least one report row, and the trailer already says INCOMPLETO when
 *    `relatorioCompleto` is false.
 */
import { useCallback, useRef, useState } from 'react';
import { notifications } from '@mantine/notifications';

import {
  buildEnvioPrecoCsv,
  envioPrecoCsvFilename,
  MAX_PAGINAS_RELATORIO_PRECO,
} from '@/lib/marketplace/contaJobs/envioPrecoCsv';
import { saveBlob } from '@/lib/nfe/saveBlob';
import {
  ShopeeClientHttpError,
  ShopeeClientNetworkError,
  useShopeeClient,
} from '@/lib/shopee/client';
import { descreverFalhaShopee } from '@/lib/shopee/erros';
import type {
  PriceSyncRelatorioLinhaShopee,
  PriceSyncRelatorioPaginaShopee,
} from '@/lib/shopee/wire';

export interface AlvoRelatorioPrecoShopee {
  jobId: string;
  contaId: string;
  contaNome: string;
}

export function useBaixarRelatorioPrecoShopee() {
  const client = useShopeeClient();
  const [baixando, setBaixando] = useState<string | null>(null);
  const [pagina, setPagina] = useState(0);
  /**
   * ⚠️ A REF, not the `baixando` state: the Histórico modal hands this ONE hook
   * to every row, Mantine disables only the loading button, and the state read
   * inside this callback is the value captured when it was built — stale for
   * the click that matters. Without it a second row's click starts a second
   * paging loop against a backend with ~6 MiB of heap per request (Mercado
   * Livre's hook learned this first).
   */
  const emVoo = useRef(false);

  const baixar = useCallback(
    async (alvo: AlvoRelatorioPrecoShopee) => {
      if (!client || emVoo.current) return;
      emVoo.current = true;
      setBaixando(alvo.jobId);
      setPagina(0);
      try {
        const linhas: PriceSyncRelatorioLinhaShopee[] = [];
        let depois: string | null = null;
        let paginas = 0;
        do {
          // Annotated: `depois` feeds the call and is read back from it.
          const p: PriceSyncRelatorioPaginaShopee = await client.priceSyncRelatorio({
            integracaoId: alvo.contaId,
            jobId: alvo.jobId,
            depois,
          });
          linhas.push(...p.linhas);
          depois = p.proximoDepois;
          paginas += 1;
          setPagina(paginas);
        } while (depois !== null && paginas < MAX_PAGINAS_RELATORIO_PRECO);

        // AFTER the pages — see the module docblock.
        const status = await client.priceSyncStatus({
          integracaoId: alvo.contaId,
          jobId: alvo.jobId,
        });

        const csv = buildEnvioPrecoCsv(
          linhas,
          {
            status: status.status,
            relatorioCompleto: status.relatorioCompleto,
            filaRestante: status.filaRestante,
            planejados: status.planejados,
            enviados: status.enviados,
            pulados: status.pulados,
            falhas: status.falhas,
          },
          { truncado: depois !== null },
        );
        saveBlob(
          new Blob([csv], { type: 'text/csv;charset=utf-8' }),
          envioPrecoCsvFilename(alvo.contaNome, status.startedAt),
        );
      } catch (err) {
        // ⚠️ Nothing may rethrow: this runs from an async click handler, so a
        // throw is an unhandled rejection no error boundary catches. The narrowing
        // only decides what reaches the console (and is what rule 6's lint reads);
        // `descreverFalhaShopee` always returns copy.
        if (!(err instanceof ShopeeClientHttpError) && !(err instanceof ShopeeClientNetworkError)) {
          console.error('[shopee] download do relatório de preços falhou', err);
        }
        const falha = descreverFalhaShopee(err, {
          desconhecido: 'Não foi possível baixar o relatório.',
        });
        notifications.show({ color: 'red', title: 'Relatório', message: falha.mensagem });
      } finally {
        emVoo.current = false;
        setBaixando(null);
        setPagina(0);
      }
    },
    [client],
  );

  return { baixar, baixando, pagina };
}
