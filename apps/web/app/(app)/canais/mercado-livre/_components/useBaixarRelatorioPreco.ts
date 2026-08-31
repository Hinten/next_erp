'use client';

/**
 * Fetch a run's whole per-item report page by page, build the CSV and hand it to
 * the browser.
 *
 * The route pages because the App Hosting backend has ~6 MiB of heap per
 * in-flight request; the loop is therefore the client's job, and it reports
 * progress because a large report is several sequential round trips.
 */
import { useCallback, useRef, useState } from 'react';
import { notifications } from '@mantine/notifications';

import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  type MercadoLivreRelatorioEnvioPrecoLinha,
  useMercadoLivreClient,
} from '@/lib/mercado-livre/client';
import { describeMercadoLivreFailure } from '@/lib/mercado-livre/errors';
import { saveBlob } from '@/lib/nfe/saveBlob';
import { buildEnvioPrecoCsv, envioPrecoCsvFilename } from './envioPrecoCsv';

/**
 * Bound on the loop. A report past this is truncated AND SAYS SO in the trailer
 * — a silent cap is the failure this whole area keeps guarding against.
 */
const MAX_PAGINAS = 100;

export interface BaixarRelatorioAlvo {
  jobId: string;
  contaId: string;
  contaNome: string;
}

export function useBaixarRelatorioPreco() {
  const client = useMercadoLivreClient();
  const [baixando, setBaixando] = useState<string | null>(null);
  const [pagina, setPagina] = useState(0);
  /**
   * ⚠️ A REF, not the `baixando` state, and the guard is not defensive padding.
   *
   * `PriceSyncHistoricoModal` calls this hook ONCE and hands the same object to
   * every row, so `baixando`/`pagina` are shared across N buttons — and Mantine
   * disables only the button that is loading, leaving every other row clickable.
   * A second click therefore started a second paging loop, and whichever loop
   * finished first cleared the shared state while the other was still fetching:
   * the operator saw the spinner vanish and clicked again, stacking a third.
   * That runs against a backend with ~6 MiB of heap per in-flight request, which
   * is the very budget the route's own docblock pages to respect.
   *
   * It has to be a ref because `baixando` read inside this `useCallback` is the
   * value captured when the callback was created — always stale for the click
   * that matters.
   */
  const emVoo = useRef(false);

  const baixar = useCallback(
    async (alvo: BaixarRelatorioAlvo) => {
      if (!client || emVoo.current) return;
      emVoo.current = true;
      setBaixando(alvo.jobId);
      setPagina(0);
      try {
        const linhas: MercadoLivreRelatorioEnvioPrecoLinha[] = [];
        let depois: string | null = null;
        let paginas = 0;
        let ultima: Awaited<ReturnType<typeof client.priceSyncRelatorio>> | null = null;

        do {
          const p: Awaited<ReturnType<typeof client.priceSyncRelatorio>> =
            await client.priceSyncRelatorio({
              integracaoId: alvo.contaId,
              jobId: alvo.jobId,
              depois,
            });
          ultima = p;
          linhas.push(...p.linhas);
          depois = p.proximoDepois;
          paginas += 1;
          setPagina(paginas);
        } while (depois !== null && paginas < MAX_PAGINAS);

        if (ultima === null) return;

        // ⚠️ `relatorioShards === 0` alone is ambiguous. With `relatorioCompleto`
        // false it means the run predates the report; handing over an empty CSV
        // there would read as "nothing to change in the whole catalogue".
        if (ultima.relatorioShards === 0 && !ultima.relatorioCompleto) {
          notifications.show({
            color: 'yellow',
            title: 'Sem relatório',
            message:
              'Este envio é anterior à versão que grava o relatório item a item, então não há o que baixar.',
          });
          return;
        }

        const csv = buildEnvioPrecoCsv(
          linhas,
          {
            status: ultima.status,
            relatorioCompleto: ultima.relatorioCompleto,
            filaRestante: ultima.filaRestante,
            planejados: ultima.planejados,
            enviados: ultima.enviados,
            pulados: ultima.pulados,
            falhas: ultima.falhas,
          },
          { truncado: depois !== null },
        );
        saveBlob(
          new Blob([csv], { type: 'text/csv;charset=utf-8' }),
          envioPrecoCsvFilename(alvo.contaNome, ultima.startedAt),
        );
      } catch (err) {
        // ⚠️ Nothing may rethrow: this runs from an async click handler, so a
        // throw becomes an unhandled rejection that no error boundary catches —
        // the operator would see the button stop spinning and nothing said.
        // `describeMercadoLivreFailure` always returns copy, so the narrowing
        // here only decides what reaches the console (and satisfies rule 6,
        // whose lint reads the catch body rather than the helper it calls).
        if (
          !(err instanceof MercadoLivreClientHttpError) &&
          !(err instanceof MercadoLivreClientNetworkError)
        ) {
          console.error('[mercado-livre] download do relatório de preços falhou', err);
        }
        const falha = describeMercadoLivreFailure(err, {
          network: 'Falha de rede ao baixar o relatório.',
          unknown: 'Não foi possível baixar o relatório.',
        });
        notifications.show({ color: 'red', title: 'Relatório', message: falha.message });
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
