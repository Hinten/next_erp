import { describe, expect, it } from 'vitest';
import { makeEstoqueUid, type ComponentesKit } from '@delfrance/schemas';
import { combineEstoqueDisponivel } from './useEstoqueDisponivel';

const PRODUTO = 'p1';
const DEP = 'dep1';
const OWN_UID = makeEstoqueUid(PRODUTO, DEP);

/** Own estoque row helper (`quantidade` / `quantidadeReservada`). */
function row(id: string, quantidade: number, quantidadeReservada = 0) {
  return { id, data: { quantidade, quantidadeReservada } };
}

const kit = (quantidade: number, limitarEstoque = true) => ({ quantidade, limitarEstoque });

function base(over: Partial<Parameters<typeof combineEstoqueDisponivel>[0]> = {}) {
  return combineEstoqueDisponivel({
    ownRows: [],
    depositoId: null,
    produtoId: PRODUTO,
    ehKit: false,
    componentesKit: null,
    componentDisponivel: undefined,
    ...over,
  });
}

describe('combineEstoqueDisponivel', () => {
  it('returns null while the own rows load', () => {
    expect(base({ ownRows: null })).toBeNull();
    expect(base({ ownRows: undefined })).toBeNull();
  });

  describe('no depósito (fallback — Σ own across all depósitos)', () => {
    it('sums disponível over every depósito', () => {
      const ownRows = [
        row(makeEstoqueUid(PRODUTO, 'a'), 10, 3), // 7
        row(makeEstoqueUid(PRODUTO, 'b'), 5, 0), // 5
      ];
      expect(base({ ownRows })).toBe(12);
    });

    it('skips non-finite rows so the badge never NaNs', () => {
      const ownRows = [
        row(makeEstoqueUid(PRODUTO, 'a'), 4, 0),
        { id: makeEstoqueUid(PRODUTO, 'b'), data: { quantidade: NaN, quantidadeReservada: 0 } },
      ];
      expect(base({ ownRows })).toBe(4);
    });
  });

  describe('depósito set, non-kit (single depósito)', () => {
    it('uses only the target depósito, ignoring the others', () => {
      const ownRows = [row(OWN_UID, 8, 2), row(makeEstoqueUid(PRODUTO, 'other'), 99, 0)];
      expect(base({ ownRows, depositoId: DEP })).toBe(6);
    });

    it('counts a missing own row as 0', () => {
      expect(base({ ownRows: [], depositoId: DEP })).toBe(0);
    });
  });

  describe('depósito set, kit (own + assemblable-from-components)', () => {
    const componentesKit: ComponentesKit = {
      compA: kit(2) as ComponentesKit[string], // 2 per kit
      compB: kit(1) as ComponentesKit[string], // 1 per kit
    };

    it('adds min over components (floor-free) to the own stock', () => {
      // compA: 10/2 = 5 ; compB: 3/1 = 3 → min 3 ; own 4 → 7
      const value = base({
        ownRows: [row(OWN_UID, 4, 0)],
        depositoId: DEP,
        ehKit: true,
        componentesKit,
        componentDisponivel: { compA: 10, compB: 3 },
      });
      expect(value).toBe(7);
    });

    it('counts a component with no stock at the depósito as 0 (#238 divergence)', () => {
      // compB absent → 0 → min 0 → own(2) + 0 = 2
      const value = base({
        ownRows: [row(OWN_UID, 2, 0)],
        depositoId: DEP,
        ehKit: true,
        componentesKit,
        componentDisponivel: { compA: 10 },
      });
      expect(value).toBe(2);
    });

    it('ignores limitarEstoque:false components', () => {
      const value = base({
        ownRows: [row(OWN_UID, 1, 0)],
        depositoId: DEP,
        ehKit: true,
        componentesKit: {
          compA: kit(2) as ComponentesKit[string],
          compB: kit(1, false) as ComponentesKit[string],
        },
        componentDisponivel: { compA: 8 }, // compB not read (limitarEstoque false)
        // compA: 8/2 = 4 ; own 1 → 5
      });
      expect(value).toBe(5);
    });

    it('is null while the component reads are in flight', () => {
      const value = base({
        ownRows: [row(OWN_UID, 4, 0)],
        depositoId: DEP,
        ehKit: true,
        componentesKit,
        componentDisponivel: undefined,
      });
      expect(value).toBeNull();
    });
  });
});
