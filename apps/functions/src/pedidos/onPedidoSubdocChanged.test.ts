import { describe, expect, it } from 'vitest';

import { PEDIDO_HISTORY_ROOT } from '../lib/historyRoots';
import { buildModificationEntry } from '../lib/modificationHistory';
import { incidenteHistorySource } from './onIncidenteChanged';
import { pagamentoHistorySource } from './onPagamentoChanged';

const ENTRY_BASE = {
  eventId: 'evt1',
  eventTimeMicros: 1_000_000,
  usuarioOuterRef: null,
};

describe('pagamentoHistorySource', () => {
  it('has the fixed subcolecao/ignoreFields', () => {
    expect(pagamentoHistorySource.subcolecao).toBe('pagamentos');
    expect(pagamentoHistorySource.ignoreFields).toEqual(['id', 'ultimaModificacao']);
  });

  it('is bound to the PEDIDO root — rows land under the pedido, not the pagamento', () => {
    expect(pagamentoHistorySource.root).toBe(PEDIDO_HISTORY_ROOT);
    expect(pagamentoHistorySource.root.parentIdParam).toBe('pedidoId');
  });

  it('leaves requireParentExists OFF, because nothing sweeps a pedido subtree', () => {
    // `pedidos` declares a cascade and deliberately has no delete trigger, so a
    // pagamento delete arriving after its pedido is gone is exactly the event
    // that most needs a row — the guard would drop it.
    expect(pagamentoHistorySource.requireParentExists).toBeFalsy();
  });

  it('resolve() maps {pedidoId, docId} to the owning pedido', () => {
    expect(pagamentoHistorySource.resolve({ pedidoId: 'ped1', docId: 'pag1' })).toEqual({
      parentId: 'ped1',
      docId: 'pag1',
      path: 'pedidos/ped1/pagamentos/pag1',
    });
  });

  it('records a status_pagamento transition — what the legacy histpgto captured', () => {
    const entry = buildModificationEntry({
      ...ENTRY_BASE,
      before: { status_pagamento: 1, valor: 100, ultimaModificacao: 1 },
      after: { status_pagamento: 3, valor: 100, ultimaModificacao: 2 },
      ignore: pagamentoHistorySource.ignoreFields,
      path: 'pedidos/ped1/pagamentos/pag1',
      subcolecao: 'pagamentos',
      docId: 'pag1',
    });
    expect(entry?.campos).toEqual(['status_pagamento']);
    expect(entry?.changes.status_pagamento).toEqual({ old: 1, new: 3 });
  });

  it('ALSO records a valor change — the case legacy histpgto was blind to', () => {
    const entry = buildModificationEntry({
      ...ENTRY_BASE,
      before: { status_pagamento: 3, valor: 100 },
      after: { status_pagamento: 3, valor: 250 },
      ignore: pagamentoHistorySource.ignoreFields,
      path: 'pedidos/ped1/pagamentos/pag1',
      subcolecao: 'pagamentos',
      docId: 'pag1',
    });
    expect(entry?.changes.valor).toEqual({ old: 100, new: 250 });
  });

  it('writes NO row for a content-identical re-import (only the stamp moved)', () => {
    // The ML importer does a wholesale `tx.set` and advances `ultimaModificacao`
    // as its update-if-newer key; ignoring that stamp is what makes a repeated
    // import silent instead of one row per poll.
    const entry = buildModificationEntry({
      ...ENTRY_BASE,
      before: { id: 'pag1', status_pagamento: 3, valor: 100, ultimaModificacao: 1 },
      after: { id: 'pag1', status_pagamento: 3, valor: 100, ultimaModificacao: 999 },
      ignore: pagamentoHistorySource.ignoreFields,
      path: 'pedidos/ped1/pagamentos/pag1',
      subcolecao: 'pagamentos',
      docId: 'pag1',
    });
    expect(entry).toBeNull();
  });

  it('records a DELETE as a tombstone carrying the pre-delete values', () => {
    const entry = buildModificationEntry({
      ...ENTRY_BASE,
      before: { status_pagamento: 3, valor: 100 },
      after: undefined,
      ignore: pagamentoHistorySource.ignoreFields,
      path: 'pedidos/ped1/pagamentos/pag1',
      subcolecao: 'pagamentos',
      docId: 'pag1',
    });
    expect(entry?.kind).toBe('delete');
    expect(entry?.changes.valor).toEqual({ old: 100, new: null });
  });
});

describe('incidenteHistorySource', () => {
  it('has the fixed subcolecao/ignoreFields and the pedido root', () => {
    expect(incidenteHistorySource.subcolecao).toBe('incidentes');
    expect(incidenteHistorySource.ignoreFields).toEqual(['timestamp', 'ultimaModificacao']);
    expect(incidenteHistorySource.root).toBe(PEDIDO_HISTORY_ROOT);
    expect(incidenteHistorySource.requireParentExists).toBeFalsy();
  });

  it('resolve() maps {pedidoId, docId} to the owning pedido', () => {
    expect(incidenteHistorySource.resolve({ pedidoId: 'ped1', docId: 'inc1' })).toEqual({
      parentId: 'ped1',
      docId: 'inc1',
      path: 'pedidos/ped1/incidentes/inc1',
    });
  });

  it('drops a stamp-only save (saveIncidente stamps on every write)', () => {
    const entry = buildModificationEntry({
      ...ENTRY_BASE,
      before: { motivoDoIncidente: 'Avaria', timestamp: 1, ultimaModificacao: 1 },
      after: { motivoDoIncidente: 'Avaria', timestamp: 1, ultimaModificacao: 2 },
      ignore: incidenteHistorySource.ignoreFields,
      path: 'pedidos/ped1/incidentes/inc1',
      subcolecao: 'incidentes',
      docId: 'inc1',
    });
    expect(entry).toBeNull();
  });

  it('compares resolucao wholesale — its movement carries money', () => {
    const entry = buildModificationEntry({
      ...ENTRY_BASE,
      before: { resolucao: { tipo: 1, valor: 10 } },
      after: { resolucao: { tipo: 1, valor: 40 } },
      ignore: incidenteHistorySource.ignoreFields,
      path: 'pedidos/ped1/incidentes/inc1',
      subcolecao: 'incidentes',
      docId: 'inc1',
    });
    expect(entry?.campos).toEqual(['resolucao']);
    expect(entry?.changes.resolucao).toEqual({
      old: { tipo: 1, valor: 10 },
      new: { tipo: 1, valor: 40 },
    });
  });
});

describe('both pedido subdoc sources', () => {
  it('opt into no field expansion — only the pedido document expands itens', () => {
    expect(pagamentoHistorySource.expand).toBeUndefined();
    expect(incidenteHistorySource.expand).toBeUndefined();
  });
});
