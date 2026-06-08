import type { Firestore } from 'firebase-admin/firestore';

import { renderDanfe, renderDanfeZpl } from '@delfrance/integrations-nfe/danfe';
import { ESTADO_NFE, type NotaFiscalEletronica } from '@delfrance/schemas';

import { nfev4Collection } from '@delfrance/data/admin/collections';

import { NFeDanfeError, NFePedidoNotFoundError } from './errors';

/** Output formats the DANFE route can serve. `zpl2` is the Zebra label. */
export type DanfeArtifactFormat = 'simplificado' | 'retrato' | 'paisagem' | 'zpl2';

export interface DanfeArtifactOptions {
  readonly format: DanfeArtifactFormat;
  /** ZPL printhead density (dpi). Ignored by the PDF formats. */
  readonly dpi?: number;
}

/** A ready-to-stream DANFE artifact (PDF bytes or a ZPL string). */
export interface DanfeArtifact {
  readonly contentType: string;
  readonly filename: string;
  readonly body: Buffer | string;
}

/**
 * Produce a DANFE artifact for a specific authorized NF-e, rendered from its
 * persisted procNFe (`pedidos/{pedidoId}/nfev4/{nfeId}.xml_nfe_proc`) — never
 * re-generated. Only an **aprovada** or **cancelada** NF-e has a procNFe to
 * render; a cancelada gets the "CANCELADO" overlay, `tpAmb=2` the "SEM VALOR
 * FISCAL" watermark (handled inside the renderer).
 *
 * EPEC (`estado='p'`) renders from a different proc shape (`xml_epec_proc`) and
 * is excluded for now, consistent with the cancel/CC-e screens (issue #86).
 *
 * Errors: `NFePedidoNotFoundError` (404 — no such nfev4 doc), `NFeDanfeError`
 * (422 — estado not renderable or no procNFe).
 */
export async function danfeArtifactService(
  fs: Firestore,
  pedidoId: string,
  nfeId: string,
  opts: DanfeArtifactOptions,
): Promise<DanfeArtifact> {
  const snap = await nfev4Collection.docRef(fs, { pedidoId }, nfeId).get();
  if (!snap.exists) {
    throw new NFePedidoNotFoundError(pedidoId);
  }
  const nota = snap.data() as NotaFiscalEletronica;

  const renderable = nota.estado === ESTADO_NFE.aprovada || nota.estado === ESTADO_NFE.cancelada;
  if (!renderable) {
    throw new NFeDanfeError(
      `pedido '${pedidoId}' nfe '${nfeId}': estado='${nota.estado}' não possui DANFE — ` +
        'apenas NF-e autorizada (aprovada) ou cancelada pode ser impressa.',
    );
  }
  const xml = nota.xml_nfe_proc;
  if (!xml) {
    throw new NFeDanfeError(
      `pedido '${pedidoId}' nfe '${nfeId}': sem procNFe (xml_nfe_proc) persistido — ` +
        'não é possível gerar a DANFE.',
    );
  }
  const cancelada = nota.estado === ESTADO_NFE.cancelada;

  if (opts.format === 'zpl2') {
    return {
      contentType: 'text/plain; charset=utf-8',
      filename: `danfe-${nota.numeracao}.txt`,
      body: renderDanfeZpl(xml, { dpi: opts.dpi }),
    };
  }

  // `opts.format` is narrowed to the PDF formats after the zpl2 early return.
  const pdf = await renderDanfe(xml, { format: opts.format, cancelada });
  return {
    contentType: 'application/pdf',
    filename: `danfe-${nota.numeracao}.pdf`,
    body: pdf,
  };
}
