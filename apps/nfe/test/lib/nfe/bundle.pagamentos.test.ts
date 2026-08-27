import { describe, expect, it, vi } from 'vitest';
import { STATUS_PAGAMENTO } from '@delfrance/schemas';

import { loadPagamentosFromSnapshot } from '../../../lib/nfe/orchestrator/bundle';

/**
 * Which pagamentos reach the `<pag>` group of a nota.
 *
 * ⚠️ This filter had NO test, and that absence had a cost. It carried its own
 * inline copy of the "counts as paid" rule (`status_pagamento === null ||
 * === aprovado`), a faithful port of Flutter's `pedido_nfe_base.dart:449` —
 * so when the SHARED `isPagamentoPagante` widened to cover `em_disputa`
 * (#1322), the NF-e bundle silently kept the old rule and disagreed with the
 * footer, both admin reconciles and every other consumer. Nothing failed.
 *
 * The filter now calls the shared helper, and these tests pin that it is the
 * shared rule being applied rather than a look-alike.
 */

/** Minimal stand-in for the `pedidos/{id}/pagamentos` QuerySnapshot. */
function snapshotOf(docs: Array<{ id: string; data: Record<string, unknown> }>) {
  return {
    docs: docs.map((d) => ({ id: d.id, data: () => d.data })),
  } as unknown as FirebaseFirestore.QuerySnapshot;
}

describe('loadPagamentosFromSnapshot', () => {
  it('keeps null, aprovado and em_disputa — drops every reversal and pending state', () => {
    const out = loadPagamentosFromSnapshot(
      'PED-1',
      snapshotOf([
        { id: 'sem-status', data: { valor: 10, status_pagamento: null } },
        { id: 'aprovado', data: { valor: 20, status_pagamento: STATUS_PAGAMENTO.aprovado } },
        { id: 'disputa', data: { valor: 30, status_pagamento: STATUS_PAGAMENTO.em_disputa } },
        { id: 'pendente', data: { valor: 40, status_pagamento: STATUS_PAGAMENTO.pendente } },
        { id: 'estornado', data: { valor: 50, status_pagamento: STATUS_PAGAMENTO.estornado } },
        { id: 'recusado', data: { valor: 60, status_pagamento: STATUS_PAGAMENTO.recusado } },
      ]),
    );

    expect(out.map((p) => p.valor)).toEqual([10, 20, 30]);
  });

  it('a payment in mediation still goes on the nota — a HOLD is not a reversal', () => {
    // ML keeps the order `paid` and holds the funds as `retained` for the whole
    // mediation. Dropping the payment here would emit a nota whose `<pag>` does
    // not add up to the sale it documents.
    const out = loadPagamentosFromSnapshot(
      'PED-2',
      snapshotOf([
        { id: 'p1', data: { valor: 100, status_pagamento: STATUS_PAGAMENTO.em_disputa } },
      ]),
    );

    expect(out).toHaveLength(1);
    expect(out[0]!.valor).toBe(100);
  });

  it('skips a doc that fails pagamentoSchema with a warn — one bad doc must not block emission', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = loadPagamentosFromSnapshot(
        'PED-3',
        snapshotOf([
          // `valor` is required and must be >= 0.
          { id: 'malformado', data: { valor: -1 } },
          { id: 'ok', data: { valor: 70, status_pagamento: STATUS_PAGAMENTO.aprovado } },
        ]),
      );

      expect(out.map((p) => p.valor)).toEqual([70]);
      expect(warn).toHaveBeenCalledOnce();
      // The message must name the pedido AND the offending doc — a warn that
      // cannot be traced back to a document is not diagnosable.
      expect(warn.mock.calls[0]![0]).toContain('PED-3');
      expect(warn.mock.calls[0]![0]).toContain('malformado');
    } finally {
      warn.mockRestore();
    }
  });
});
