import { describe, expect, it } from 'vitest';
import {
  CAMPOS_ESCRITOS,
  CAMPOS_OBSERVADOS,
  incidenteDrift,
  mudouCampoObservado,
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
    expect(motivo).toContain('-5');
    expect(motivo).toContain('pedido 123');
    expect(motivo.length).toBeLessThanOrEqual(2000);
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
