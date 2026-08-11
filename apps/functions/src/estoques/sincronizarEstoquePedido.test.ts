import { describe, expect, it } from 'vitest';
import { pedidoMeta } from '@delfrance/schemas';
import {
  CAMPOS_ESCRITOS,
  CAMPOS_OBSERVADOS,
  detectarCrescimentoLegado,
  incidenteDrift,
  incidenteReconstrucaoLegado,
  mudouCampoObservado,
  sintetizarAplicadoLegado,
} from './sincronizarEstoquePedido';

describe('loop guard 1 — observed/written field sets', () => {
  it('CAMPOS_OBSERVADOS and CAMPOS_ESCRITOS are disjoint (no self-retrigger, ever)', () => {
    // Disjoint at the path level: no written field equals an observed path, is a
    // parent of one, or is nested under one — a write to any CAMPOS_ESCRITOS
    // field can never change the value at an observed path. (Widened to string:
    // TS proves the literal unions don't overlap — that proof is this test.)
    for (const escrito of CAMPOS_ESCRITOS as readonly string[]) {
      for (const observado of CAMPOS_OBSERVADOS as readonly string[]) {
        expect(
          escrito === observado ||
            escrito.startsWith(`${observado}.`) ||
            observado.startsWith(`${escrito}.`),
        ).toBe(false);
      }
    }
  });

  it('every written field is declared server-owned on pedidoMeta', () => {
    // Two consequences hang off `serverOwnedFields`, and both are wrong if this
    // drifts: the generated rules stop denying clients the write, AND
    // `remotelyChangedFields` (@delfrance/data/pedido) starts counting the
    // sync's own write-back as "someone else changed your pedido" — a conflict
    // modal over a field the operator cannot see, edit or write. That is #791,
    // which this sync re-created once already.
    const serverOwned = new Set(pedidoMeta.serverOwnedFields ?? []);
    for (const escrito of CAMPOS_ESCRITOS as readonly string[]) {
      expect(serverOwned.has(escrito)).toBe(true);
    }
  });
});

describe('loop guard 2 — mudouCampoObservado fast-path', () => {
  const base = {
    estado: 'pago',
    ehSaida: true,
    itens: { p1: [{ produtoUid: 'p1', quantidade: 2 }] },
    freteInicial: { estado: 'iniciado', codRastreio: null },
    operacaoPedidoOuterRef: 'documents/operacao/op1',
    integracaoPedidoOuterRef: 'documents/integracao/int1',
    estoqueAplicado: null,
    dataIndisponivelEstoque: null,
    dataRemocaoEstoque: null,
  };

  it("ignores the sync's own write (only CAMPOS_ESCRITOS changed)", () => {
    const after = {
      ...base,
      estoqueAplicado: {
        depositoId: 'dep1',
        reservado: { p1: 2 },
        ehSaida: true,
        atualizadoEm: 1,
      },
      dataIndisponivelEstoque: 123,
    };
    expect(mudouCampoObservado(base, after)).toBe(false);
  });

  it('detects an estado change', () => {
    expect(mudouCampoObservado(base, { ...base, estado: 'finalizado' })).toBe(true);
  });

  it('detects a freteInicial.estado change but ignores other frete edits', () => {
    expect(
      mudouCampoObservado(base, {
        ...base,
        freteInicial: { ...base.freteInicial, estado: 'empacotado' },
      }),
    ).toBe(true);
    expect(
      mudouCampoObservado(base, {
        ...base,
        freteInicial: { ...base.freteInicial, codRastreio: 'BR123' },
      }),
    ).toBe(false);
  });

  it('detects item quantity edits regardless of map key order', () => {
    const antes = { ...base, itens: { a: [{ produtoUid: 'a', quantidade: 1 }], b: [] } };
    const mesmo = { ...base, itens: { b: [], a: [{ produtoUid: 'a', quantidade: 1 }] } };
    const editado = { ...base, itens: { a: [{ produtoUid: 'a', quantidade: 3 }], b: [] } };
    expect(mudouCampoObservado(antes, mesmo)).toBe(false);
    expect(mudouCampoObservado(antes, editado)).toBe(true);
  });

  it('detects operação/integração ref changes and null↔value transitions', () => {
    expect(mudouCampoObservado(base, { ...base, operacaoPedidoOuterRef: null })).toBe(true);
    expect(
      mudouCampoObservado(base, {
        ...base,
        integracaoPedidoOuterRef: 'documents/integracao/int2',
      }),
    ).toBe(true);
    expect(mudouCampoObservado(base, { ...base, freteInicial: null })).toBe(true);
  });

  it('treats a create (before=null) as changed', () => {
    expect(mudouCampoObservado(null, base)).toBe(true);
  });
});

describe('incidenteDrift (#408)', () => {
  it('builds a Flutter-safe payload with the structured subtipo marker', () => {
    const payload = incidenteDrift({
      estoqueId: 'est-p1-dep1',
      reservadaAntes: 2,
      deltaReservada: -5,
      pedidoNumero: '123',
      agoraMs: 1_700_000_000_000,
    });
    // tipo stays inside the legacy wire enum ('o' = Outros); the marker is the
    // passthrough field the UI filters on.
    expect(payload.tipo).toBe('o');
    expect(payload.subtipo).toBe('estoque-drift');
    expect(payload.timestamp).toBe(1_700_000_000_000_000); // µs
    expect(payload.ultimaModificacao).toBe(1_700_000_000_000_000);
    const motivo = payload.motivoDoIncidente as string;
    expect(motivo).toContain('est-p1-dep1');
    expect(motivo).toContain('liberação de 5 unidade(s)'); // absolute amount in prose
    expect(motivo).toContain('(delta -5)'); // signed delta kept for debugging
    expect(motivo).toContain('pedido 123');
    expect(motivo.length).toBeLessThanOrEqual(2000);
  });

  it('truncates the motivo to the schema cap instead of aborting the sync', () => {
    const payload = incidenteDrift({
      estoqueId: `est-${'p'.repeat(1500)}-${'d'.repeat(1500)}`,
      reservadaAntes: 2,
      deltaReservada: -5,
      pedidoNumero: '123',
      agoraMs: 1,
    });
    const motivo = payload.motivoDoIncidente as string;
    expect(motivo.length).toBeLessThanOrEqual(2000);
    expect(motivo.endsWith('…')).toBe(true);
  });

  it('omits the pedido reference when there is no número', () => {
    const payload = incidenteDrift({
      estoqueId: 'est-p1-dep1',
      reservadaAntes: 0,
      deltaReservada: -1,
      pedidoNumero: null,
      agoraMs: 1,
    });
    expect(payload.motivoDoIncidente as string).not.toContain('(pedido');
  });
});

describe('detectarCrescimentoLegado (#795 — the ML pack-merge shape)', () => {
  /** A pedido the Flutter app stock-moved: markers stamped, no snapshot. */
  const legado = (itens: Record<string, { produtoUid: string; quantidade: number }[]>) => ({
    estado: 'pago',
    itens,
    estoqueAplicado: null,
    dataIndisponivelEstoque: null,
    dataRemocaoEstoque: 1_700_000_000_000_000,
  });

  const soP1 = legado({ p1: [{ produtoUid: 'p1', quantidade: 2 }] });
  const p1MaisP2 = legado({
    p1: [{ produtoUid: 'p1', quantidade: 2 }],
    p2: [{ produtoUid: 'p2', quantidade: 3 }],
  });

  it('matches a pack sibling appended to a Flutter-era pedido, returning the anchor items', () => {
    expect(detectarCrescimentoLegado(soP1, p1MaisP2)).toEqual({
      p1: [{ produtoUid: 'p1', quantidade: 2 }],
    });
  });

  it('matches a sibling that adds MORE of a produto already on the pedido', () => {
    const maisP1 = legado({
      p1: [
        { produtoUid: 'p1', quantidade: 2 },
        { produtoUid: 'p1', quantidade: 5 },
      ],
    });
    expect(detectarCrescimentoLegado(soP1, maisP1)).not.toBeNull();
  });

  it('matches on the reservation marker alone (Flutter held a reserve, never removed)', () => {
    const antes = { ...soP1, dataRemocaoEstoque: null, dataIndisponivelEstoque: 1 };
    const depois = { ...p1MaisP2, dataRemocaoEstoque: null, dataIndisponivelEstoque: 1 };
    expect(detectarCrescimentoLegado(antes, depois)).not.toBeNull();
  });

  it('does NOT match when the pedido already carries a snapshot (the normal path owns it)', () => {
    const comSnapshot = {
      ...p1MaisP2,
      estoqueAplicado: { depositoId: 'dep1', ehSaida: true, removido: { p1: 2 }, atualizadoEm: 1 },
    };
    expect(detectarCrescimentoLegado(soP1, comSnapshot)).toBeNull();
    expect(detectarCrescimentoLegado(comSnapshot, p1MaisP2)).toBeNull();
  });

  it('does NOT match without legacy markers (a new-app pedido that simply has no effect yet)', () => {
    const semMarcadores = { ...soP1, dataRemocaoEstoque: null };
    const cresceu = { ...p1MaisP2, dataRemocaoEstoque: null };
    expect(detectarCrescimentoLegado(semMarcadores, cresceu)).toBeNull();
  });

  it('does NOT match a create — there is no prior revision to anchor on', () => {
    expect(detectarCrescimentoLegado(null, p1MaisP2)).toBeNull();
  });

  it('does NOT match a shrink, a reduction, or an unchanged item set', () => {
    // Removing a produto entirely, reducing a quantity, and a no-op edit are all
    // outside the merge shape — they keep hitting the no-snapshot skip.
    expect(detectarCrescimentoLegado(p1MaisP2, soP1)).toBeNull();
    expect(
      detectarCrescimentoLegado(soP1, legado({ p1: [{ produtoUid: 'p1', quantidade: 1 }] })),
    ).toBeNull();
    expect(detectarCrescimentoLegado(soP1, soP1)).toBeNull();
  });

  it('does NOT match a swap that both adds and drops a produto (net growth is not enough)', () => {
    // p2 appears but p1 vanished: the anchor would claim stock was moved for an
    // item the pedido no longer sells. Not a merge — skip.
    expect(
      detectarCrescimentoLegado(soP1, legado({ p2: [{ produtoUid: 'p2', quantidade: 9 }] })),
    ).toBeNull();
  });

  it('ignores unpriced/junk lines when comparing (produtoUid NONE, non-numeric quantities)', () => {
    const comLixo = legado({
      p1: [{ produtoUid: 'p1', quantidade: 2 }],
      NONE: [{ produtoUid: 'NONE', quantidade: 7 }],
    });
    // Only the NONE bucket differs → no real growth.
    expect(detectarCrescimentoLegado(soP1, comLixo)).toBeNull();
  });

  it('does NOT match when the anchor is EMPTY — no baseline is not a baseline', () => {
    // Every previous line is junk, so there is nothing to anchor on: a first
    // real addition must NOT read as growth over nothing, or the reconstruction
    // would rest on no baseline and could double-move stock.
    const soLixo = legado({ NONE: [{ produtoUid: 'NONE', quantidade: 7 }] });
    expect(detectarCrescimentoLegado(soLixo, p1MaisP2)).toBeNull();

    const zeroQuantidade = legado({ p1: [{ produtoUid: 'p1', quantidade: 0 }] });
    expect(detectarCrescimentoLegado(zeroQuantidade, p1MaisP2)).toBeNull();

    expect(detectarCrescimentoLegado(legado({}), p1MaisP2)).toBeNull();
  });
});

describe('sintetizarAplicadoLegado (#795)', () => {
  const base = {
    alteracoesAnteriores: { p1: 2 },
    depositoId: 'dep1',
    operacaoId: 'op1',
    agora: 1_700_000_000_000_000,
  };

  it('rebuilds a saída removal from the removal marker', () => {
    const aplicado = sintetizarAplicadoLegado({
      ...base,
      temMarcadorRemocao: true,
      temMarcadorReserva: false,
      ehSaida: true,
    });
    expect(aplicado).toEqual({
      depositoId: 'dep1',
      operacaoId: 'op1',
      ehSaida: true,
      reservado: null,
      removido: { p1: 2 },
      adicionado: null,
      atualizadoEm: 1_700_000_000_000_000,
    });
  });

  it('rebuilds an entrada addition when the operação direction is inbound', () => {
    const aplicado = sintetizarAplicadoLegado({
      ...base,
      temMarcadorRemocao: true,
      temMarcadorReserva: false,
      ehSaida: false,
    });
    expect(aplicado?.adicionado).toEqual({ p1: 2 });
    expect(aplicado?.removido).toBeNull();
  });

  it('rebuilds a reservation when only the reserve marker is set', () => {
    const aplicado = sintetizarAplicadoLegado({
      ...base,
      temMarcadorRemocao: false,
      temMarcadorReserva: true,
      ehSaida: true,
    });
    expect(aplicado?.reservado).toEqual({ p1: 2 });
    expect(aplicado?.removido).toBeNull();
  });

  it('lets the removal win when BOTH markers are set — a removal consumes the reservation', () => {
    const aplicado = sintetizarAplicadoLegado({
      ...base,
      temMarcadorRemocao: true,
      temMarcadorReserva: true,
      ehSaida: true,
    });
    expect(aplicado?.removido).toEqual({ p1: 2 });
    expect(aplicado?.reservado).toBeNull();
  });

  it('returns null with no markers or no quantities — nothing to reconstruct', () => {
    expect(
      sintetizarAplicadoLegado({
        ...base,
        temMarcadorRemocao: false,
        temMarcadorReserva: false,
        ehSaida: true,
      }),
    ).toBeNull();
    expect(
      sintetizarAplicadoLegado({
        ...base,
        alteracoesAnteriores: {},
        temMarcadorRemocao: true,
        temMarcadorReserva: false,
        ehSaida: true,
      }),
    ).toBeNull();
  });

  it('copies the quantity map — the snapshot must not alias the caller’s object', () => {
    const alteracoes = { p1: 2 };
    const aplicado = sintetizarAplicadoLegado({
      ...base,
      alteracoesAnteriores: alteracoes,
      temMarcadorRemocao: true,
      temMarcadorReserva: false,
      ehSaida: true,
    });
    alteracoes.p1 = 99;
    expect(aplicado?.removido).toEqual({ p1: 2 });
  });
});

describe('incidenteReconstrucaoLegado (#795)', () => {
  it('builds a Flutter-safe payload with its own subtipo marker', () => {
    const payload = incidenteReconstrucaoLegado({
      produtoIds: ['p2'],
      pedidoNumero: '123',
      agoraMs: 1_700_000_000_000,
    });
    expect(payload.tipo).toBe('o'); // legacy wire enum — never extended
    expect(payload.subtipo).toBe('estoque-reconstrucao-legado');
    expect(payload.timestamp).toBe(1_700_000_000_000_000); // µs
    const motivo = payload.motivoDoIncidente as string;
    expect(motivo).toContain('pedido 123');
    expect(motivo).toContain('p2');
  });

  it('truncates the motivo to the schema cap instead of aborting the sync', () => {
    const payload = incidenteReconstrucaoLegado({
      produtoIds: Array.from({ length: 500 }, (_, i) => `produto-${i}`),
      pedidoNumero: '123',
      agoraMs: 1,
    });
    const motivo = payload.motivoDoIncidente as string;
    expect(motivo.length).toBeLessThanOrEqual(2000);
    expect(motivo.endsWith('…')).toBe(true);
  });

  it('degrades gracefully when the pedido has no número', () => {
    const payload = incidenteReconstrucaoLegado({
      produtoIds: ['p2'],
      pedidoNumero: null,
      agoraMs: 1,
    });
    expect(payload.motivoDoIncidente as string).toContain('(sem número)');
  });
});
