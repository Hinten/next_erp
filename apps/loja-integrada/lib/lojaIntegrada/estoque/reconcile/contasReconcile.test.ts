/**
 * `contasReconcile.ts` (master plan step 12, PR 12-g): whether a conta is still the one the run
 * took, and whether a depósito change asks for a new full run — the pure rule with its near-misses,
 * and the release's check against `testing/fakeDb.ts` with its cost. No Loja Integrada call:
 * `fetch` throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { relogioDoDocumentoUs } from '../../avisos/avisos';
import { FakeDb, asDb } from '../../testing/fakeDb';
import { refDeposito, seedContaComDeposito } from '../../testing/reconcileEstoqueLi';
import {
  type ContaRevistaLi,
  INDISPONIBILIDADE_CONTA_LI,
  depositoQuePedeRevisaoLi,
  idExecucaoRedepositoLi,
  indisponibilidadeDaContaLi,
  revisaoDeDepositoNaLiberacaoLi,
} from './contasReconcile';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('contasReconcile.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A conta as read: active, at D2, written at µs 5 000 after its create at µs 1 000. */
const conta = (over: Partial<ContaRevistaLi> = {}): ContaRevistaLi => ({
  contaId: 'C1',
  existe: true,
  ativo: true,
  depositoId: 'D2',
  nome: 'Loja',
  versaoUs: 5_000,
  criadaUs: 1_000,
  ...over,
});

describe('indisponibilidadeDaContaLi', () => {
  it('gone, inactive, re-pointed (another depósito, or none) — or available', () => {
    expect(indisponibilidadeDaContaLi(undefined, 'D1')).toBe(INDISPONIBILIDADE_CONTA_LI.ausente);
    expect(indisponibilidadeDaContaLi(conta({ existe: false }), 'D2')).toBe(
      INDISPONIBILIDADE_CONTA_LI.ausente,
    );
    expect(indisponibilidadeDaContaLi(conta({ ativo: false }), 'D2')).toBe(
      INDISPONIBILIDADE_CONTA_LI.inativa,
    );
    expect(indisponibilidadeDaContaLi(conta(), 'D1')).toBe(
      INDISPONIBILIDADE_CONTA_LI.depositoMudou,
    );
    expect(indisponibilidadeDaContaLi(conta({ depositoId: null }), 'D1')).toBe(
      INDISPONIBILIDADE_CONTA_LI.depositoMudou,
    );
    expect(indisponibilidadeDaContaLi(conta(), 'D2')).toBeNull();
  });
});

describe('depositoQuePedeRevisaoLi — the arm’s own rule', () => {
  it('⚠️ NEAR-MISS pair: D1 → D2 asks (by the conta’s update time); D1 → none does not (nothing to send to)', () => {
    expect(depositoQuePedeRevisaoLi(conta(), 'D1', 0)).toBe(5_000);
    expect(depositoQuePedeRevisaoLi(conta({ depositoId: null }), 'D1', 0)).toBe(0);
  });

  it('the depósito the run fixed, a gone or inactive conta, a conta with no stamp: none asks', () => {
    expect(depositoQuePedeRevisaoLi(conta(), 'D2', 0)).toBe(0);
    expect(depositoQuePedeRevisaoLi(undefined, 'D1', 0)).toBe(0);
    expect(depositoQuePedeRevisaoLi(conta({ existe: false }), 'D1', 0)).toBe(0);
    expect(depositoQuePedeRevisaoLi(conta({ ativo: false }), 'D1', 0)).toBe(0);
    expect(depositoQuePedeRevisaoLi(conta({ versaoUs: null }), 'D1', 0)).toBe(0);
  });

  it('⚠️ a conta the run did NOT take asks when it now has a depósito — unless CREATED at or after the run’s start and never written since', () => {
    // Created before the run (inactive or depósito-less at the take), given a depósito since.
    expect(depositoQuePedeRevisaoLi(conta(), undefined, 2_000)).toBe(5_000);
    // NEAR-MISS: created during the run, never written since ⇒ a create: the next night's.
    const criada = conta({ criadaUs: 3_000, versaoUs: 3_000 });
    expect(depositoQuePedeRevisaoLi(criada, undefined, 2_000)).toBe(0);
    expect(
      depositoQuePedeRevisaoLi(conta({ criadaUs: 2_000, versaoUs: 2_000 }), undefined, 2_000),
    ).toBe(0);
    // …created during the run and written AFTER its create (a depósito set by an update) asks.
    expect(depositoQuePedeRevisaoLi(conta({ criadaUs: 3_000 }), undefined, 2_000)).toBe(5_000);
    // …and a conta the run DID take is judged by its depósito alone, whenever it was created.
    expect(depositoQuePedeRevisaoLi(criada, 'D1', 2_000)).toBe(3_000);
  });

  it('names the re-run after the stamp', () => {
    expect(idExecucaoRedepositoLi(1_768_000_000_123_456)).toBe(
      'estoque-reconcile-redeposito-1768000000123456',
    );
  });
});

describe('revisaoDeDepositoNaLiberacaoLi — the release’s ONE question', () => {
  /** A run that started after every stamp this fake issues: no conta was created during it. */
  const DEPOIS_DE_TUDO_MS = 2_000_000_000_000;

  it('⚠️ nothing moved: ONE listing of the contas and no read by id at all', async () => {
    const db = new FakeDb();
    seedContaComDeposito(db, 'C1', refDeposito('dep-1'));
    seedContaComDeposito(db, 'C2', 'depositos/dep-2');
    seedContaComDeposito(db, 'C3', null);
    seedContaComDeposito(db, 'C4', refDeposito('dep-4'), { ativo: false });
    const r = await revisaoDeDepositoNaLiberacaoLi(asDb(db), {
      fixados: new Map([
        ['C1', 'dep-1'],
        ['C2', 'dep-2'],
      ]),
      runIniciadoEmMs: DEPOIS_DE_TUDO_MS,
    });
    expect(r).toBe(0);
    expect(db.consultas.map((c) => c.colecao)).toEqual(['integracao']);
    expect(db.leituras).toEqual([]);
  });

  it('the newest stamp among the contas that ask, each suspect read again by id in ONE getAll', async () => {
    const db = new FakeDb();
    seedContaComDeposito(db, 'C1', refDeposito('dep-9'));
    seedContaComDeposito(db, 'C2', refDeposito('dep-2'));
    seedContaComDeposito(db, 'C3', refDeposito('dep-3'));
    const getAll = vi.spyOn(db, 'getAll');
    const r = await revisaoDeDepositoNaLiberacaoLi(asDb(db), {
      fixados: new Map([
        ['C1', 'dep-1'],
        ['C2', 'dep-2'],
      ]),
      runIniciadoEmMs: DEPOIS_DE_TUDO_MS,
    });
    const versaoDe = (id: string) => {
      const c = db.carimboDe(`integracao/${id}`);
      if (c === undefined) throw new Error(id);
      return relogioDoDocumentoUs(c);
    };
    expect(r).toBe(Math.max(versaoDe('C1'), versaoDe('C3')));
    expect(getAll).toHaveBeenCalledTimes(1);
    expect([...db.leituras].sort()).toEqual(['integracao/C1', 'integracao/C3']);
  });
});
