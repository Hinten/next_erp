import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  componentesNaoResolvidos,
  disponivelByProdutoIdFrom,
  kitNaoVerificavel,
  type LinhaDeFamilia,
  type MembroDaFamilia,
  type OpcoesDeQuantidade,
  quantidadeDoMembroCore,
  quantidadeParaEnvioCore,
  quantidadesAnterioresCore,
  quantidadesDaFamiliaCore,
} from './quantidades';
import { chaveMovimento, type MovimentosDaJanela } from './ledger';

/**
 * The promoted quantity core (#1520 step 12, R9).
 *
 * Two jobs, and they are not the same job:
 *
 *  1. **Behaviour parity.** A representative slice of
 *     `apps/mercado-livre/lib/marketplace/estoque/bulkEstoquePlan.test.ts` runs
 *     here against the `*Core` signatures with the SAME inputs and the SAME
 *     expected numbers. ML's own suites stay byte-unedited, so those two facts
 *     together are what says the move changed nothing.
 *  2. **The fold's SCOPE.** Every equivalence this core decides is pinned by a
 *     PAIR that must come out equal AND a NEAR-MISS that must stay distinct
 *     (#1372 — a test that a fold APPLIES cannot show where it STOPS). Each such
 *     test names both halves in its title.
 *
 * ⚠️ Neither this file nor the code under test reads the ambient
 * environment. The
 * options are constructed explicitly on every call, which is the promotion's
 * point (C-v): a default resolved inside the core would put one channel's answer
 * on the other channel's path.
 */

/** Both flags off, no ceiling — the shape every channel starts from. */
const BASE_OPCOES: OpcoesDeQuantidade = {
  incluirEstoqueProprioDoKit: false,
  pularKitVirtual: false,
  estoqueMax: Number.POSITIVE_INFINITY,
};

const opcoes = (extra: Partial<OpcoesDeQuantidade> = {}): OpcoesDeQuantidade => ({
  ...BASE_OPCOES,
  ...extra,
});

/** ML's `MERCADO_LIVRE_STOCK_MAX` default, supplied as a parameter here. */
const TETO_ML = 99999;

const componente = (quantidade: number, limitarEstoque = true) => ({
  quantidade,
  limitarEstoque,
  timestamp: null,
});

/** A fully-defaulted family member — the shape of ML's `member()` fixture. */
function membro(produtoId: string, extra: Partial<MembroDaFamilia> = {}): MembroDaFamilia {
  return {
    produtoId,
    ehKit: false,
    ehKitVirtual: false,
    publicado: true,
    componentesKit: null,
    timestampMs: null,
    estoque: null,
    componentEstoques: [],
    ...extra,
  };
}

function linha(anchor: Partial<MembroDaFamilia>, children: MembroDaFamilia[] = []): LinhaDeFamilia {
  return { anchor: membro('PROD', anchor), children };
}

const DEP = 'DEP';

const mov = (entries: Array<[string, number]>): MovimentosDaJanela =>
  new Map(entries.map(([id, dq]) => [chaveMovimento(id, DEP), { dq, dr: 0, desconhecido: false }]));

afterEach(() => {
  vi.unstubAllEnvs();
});

/* -------------------------------------------------------------------------- */

describe('quantidadeParaEnvioCore — parity with the ML arithmetic', () => {
  const base = {
    ehKit: false,
    ehKitVirtual: false,
    componentesKit: null,
    ownDisponivel: 0,
    disponivelByProdutoId: {},
  };

  it('non-kit: own disponivel floored, negative clamped to ESTOQUE_MIN', () => {
    expect(quantidadeParaEnvioCore({ ...base, ownDisponivel: 7.9 }, opcoes())).toBe(7);
    expect(quantidadeParaEnvioCore({ ...base, ownDisponivel: -3.2 }, opcoes())).toBe(0);
  });

  it('kit: min over constraining components of disponivel/quantidade', () => {
    expect(
      quantidadeParaEnvioCore(
        {
          ...base,
          ehKit: true,
          componentesKit: { A: componente(2), B: componente(3) },
          ownDisponivel: 100,
          disponivelByProdutoId: { A: 10, B: 9 },
        },
        opcoes(),
      ),
    ).toBe(3); // min(10/2 = 5, 9/3 = 3), own stock NOT added
  });

  it('kit: limitarEstoque:false components do not constrain; a fractional min floors', () => {
    expect(
      quantidadeParaEnvioCore(
        {
          ...base,
          ehKit: true,
          componentesKit: { A: componente(1, false), B: componente(2) },
          ownDisponivel: 0,
          disponivelByProdutoId: { A: 0, B: 8 },
        },
        opcoes(),
      ),
    ).toBe(4);
    expect(
      quantidadeParaEnvioCore(
        {
          ...base,
          ehKit: true,
          componentesKit: { A: componente(3) },
          ownDisponivel: 0,
          disponivelByProdutoId: { A: 10 },
        },
        opcoes(),
      ),
    ).toBe(3); // 10/3 = 3.33…
  });

  it('kit: a MISSING component counts 0 (#238) — a resolved 0 lands the same way', () => {
    // ⚠️ The #238 divergence from Flutter, and the reason it is load-bearing:
    // the legacy code SKIPPED an unresolvable component, overstating a kit that
    // was never stocked. Counting it as 0 is what makes an unverifiable kit
    // publish 0 rather than a stale positive number.
    const args = {
      ...base,
      ehKit: true,
      componentesKit: { A: componente(2), B: componente(1) },
      ownDisponivel: 100,
    };
    expect(quantidadeParaEnvioCore({ ...args, disponivelByProdutoId: { A: 10 } }, opcoes())).toBe(
      0,
    );
    expect(
      quantidadeParaEnvioCore({ ...args, disponivelByProdutoId: { A: 10, B: 0 } }, opcoes()),
    ).toBe(0);
  });

  it('kit: unconstrained (empty map / all limitarEstoque:false) falls back to own stock', () => {
    expect(
      quantidadeParaEnvioCore(
        {
          ...base,
          ehKit: true,
          componentesKit: { A: componente(1, false) },
          ownDisponivel: 6.7,
          disponivelByProdutoId: { A: 100 },
        },
        opcoes(),
      ),
    ).toBe(6);
    expect(quantidadeParaEnvioCore({ ...base, ehKit: true, ownDisponivel: 6 }, opcoes())).toBe(6);
  });
});

describe('the kit fold — PAIR and NEAR-MISS on every option', () => {
  const kitVirtual = {
    ehKit: true,
    ehKitVirtual: true,
    componentesKit: { A: componente(1), B: componente(1) },
    ownDisponivel: 50,
    disponivelByProdutoId: { A: 5, B: 3 },
  };

  it('incluirEstoqueProprioDoKit — PAIR: false and true agree on an UNCONSTRAINED kit (50, never 100); NEAR-MISS: on a constrained one they differ (3 vs 53)', () => {
    // ⚠️ The hook ADDS own stock to a kit min, and only when that min exists.
    // An unconstrained kit already FELL BACK to its own stock, so adding it
    // again would double the number — the pair below is what pins that the two
    // branches do not both fire.
    const semRestricao = { ...kitVirtual, componentesKit: null, disponivelByProdutoId: {} };
    expect(quantidadeParaEnvioCore(semRestricao, opcoes())).toBe(50);
    expect(
      quantidadeParaEnvioCore(semRestricao, opcoes({ incluirEstoqueProprioDoKit: true })),
    ).toBe(50);
    expect(
      quantidadeParaEnvioCore(semRestricao, opcoes({ incluirEstoqueProprioDoKit: true })),
    ).not.toBe(100);

    // NEAR-MISS: with a real min the two options must NOT agree.
    expect(quantidadeParaEnvioCore(kitVirtual, opcoes())).toBe(3);
    expect(quantidadeParaEnvioCore(kitVirtual, opcoes({ incluirEstoqueProprioDoKit: true }))).toBe(
      53,
    );
  });

  it('pularKitVirtual — PAIR: true ⇒ null for a VIRTUAL kit; NEAR-MISS: false ⇒ the fold (3), and an ordinary kit is never skipped', () => {
    expect(quantidadeParaEnvioCore(kitVirtual, opcoes({ pularKitVirtual: true }))).toBeNull();
    expect(quantidadeParaEnvioCore(kitVirtual, opcoes({ pularKitVirtual: false }))).toBe(3);
    // NEAR-MISS: the option keys on `ehKitVirtual`, never on `ehKit`.
    expect(
      quantidadeParaEnvioCore(
        { ...kitVirtual, ehKitVirtual: false },
        opcoes({ pularKitVirtual: true }),
      ),
    ).toBe(3);
  });

  it('⚠️ the kit branch is `ehKit || ehKitVirtual` — PAIR: ehKitVirtual ALONE still constrains to 3; NEAR-MISS: it must not fall back to own stock (50)', () => {
    // Keying the branch on `ehKit` alone computes NO min and silently answers
    // `ownDisponivel` — a WRONG number rather than a refusal, which nothing
    // anywhere reports. That is strictly worse than the bug #1087 fixed.
    const semEhKit = { ...kitVirtual, ehKit: false };
    expect(quantidadeParaEnvioCore(semEhKit, opcoes())).toBe(3);
    expect(quantidadeParaEnvioCore(semEhKit, opcoes())).not.toBe(50);
  });

  it('estoqueMax — PAIR: Infinity never clamps (250000 stays); NEAR-MISS: a ceiling of 5 clamps 7 to 5 while 4 is untouched', () => {
    // ⚠️ `Infinity` is the "no ceiling" value, never `0`: a 0 ceiling zeroes
    // every listing it touches and 0 is a legal quantity on every wire here, so
    // nothing downstream would flag it.
    const args = { ...kitVirtual, ehKit: false, ehKitVirtual: false, componentesKit: null };
    expect(quantidadeParaEnvioCore({ ...args, ownDisponivel: 250000 }, opcoes())).toBe(250000);
    expect(
      quantidadeParaEnvioCore({ ...args, ownDisponivel: 250000 }, opcoes({ estoqueMax: TETO_ML })),
    ).toBe(99999);
    expect(quantidadeParaEnvioCore({ ...args, ownDisponivel: 7 }, opcoes({ estoqueMax: 5 }))).toBe(
      5,
    );
    expect(quantidadeParaEnvioCore({ ...args, ownDisponivel: 4 }, opcoes({ estoqueMax: 5 }))).toBe(
      4,
    );
  });

  it('⚠️ the ceiling comes from the PARAMETER, never from the ambient environment', () => {
    // C-v: `estoqueMax` was the ONE tunable ML read unconditionally mid-fold, so
    // this is the mutant that matters — re-adding an env fallback under the
    // parameter would keep every test above green, because they all supply the
    // parameter. Here a Mercado Livre variable is set on the process and must
    // change nothing: on a shared Functions instance it is exactly how one
    // channel's ceiling would silently clamp another channel's listing.
    //
    // ⚠️ Set through `vi.stubEnv`, not by assigning the ambient object, so the
    // purity grep over this directory keeps matching `env.ts` alone.
    vi.stubEnv('MERCADO_LIVRE_STOCK_MAX', '7');
    expect(
      quantidadeParaEnvioCore(
        {
          ehKit: false,
          ehKitVirtual: false,
          componentesKit: null,
          ownDisponivel: 4000,
          disponivelByProdutoId: {},
        },
        opcoes({ estoqueMax: 5000 }),
      ),
    ).toBe(4000);
  });
});

describe('disponivelByProdutoIdFrom + quantidadeDoMembroCore', () => {
  it('keyed by parentId, disponivel math, junk skipped', () => {
    expect(
      disponivelByProdutoIdFrom([
        { parentId: 'A', quantidade: 10, quantidadeReservada: 3 },
        { parentId: 'B', quantidade: 5 }, // missing reservada → 0
        { parentId: '', quantidade: 1 }, // junk key skipped
        { quantidade: 2 }, // no parentId skipped
        { parentId: 'C', quantidade: 'x' }, // non-finite → 0
      ]),
    ).toEqual({ A: 7, B: 5, C: 0 });
  });

  it('non-kit own disponivel (quantidade − reservada), floored; missing estoque reads 0', () => {
    expect(
      quantidadeDoMembroCore(
        membro('P1', { estoque: { quantidade: 10, quantidadeReservada: 3 } }),
        opcoes(),
      ),
    ).toBe(7);
    expect(quantidadeDoMembroCore(membro('P1', { estoque: { quantidade: 7.5 } }), opcoes())).toBe(
      7,
    );
    expect(quantidadeDoMembroCore(membro('P1'), opcoes())).toBe(0);
  });

  it('kit min over the joined component rows; a missing component row = 0', () => {
    const kit = membro('KIT', {
      ehKit: true,
      componentesKit: { A: componente(2), B: componente(3) },
      estoque: { quantidade: 5, quantidadeReservada: 1 },
      componentEstoques: [
        { parentId: 'A', quantidade: 10, quantidadeReservada: 0 },
        { parentId: 'B', quantidade: 9, quantidadeReservada: 0 },
      ],
    });
    expect(quantidadeDoMembroCore(kit, opcoes())).toBe(3); // min(10/2, 9/3); own 4 not added
    expect(
      quantidadeDoMembroCore(
        { ...kit, componentEstoques: [{ parentId: 'A', quantidade: 10, quantidadeReservada: 0 }] },
        opcoes(),
      ),
    ).toBe(0);
  });

  it('quantidadesDaFamiliaCore: anchor + children keyed by produto id, virtuals INCLUDED', () => {
    const row = linha({ estoque: { quantidade: 7, quantidadeReservada: 0 } }, [
      membro('CH1', { estoque: { quantidade: 4, quantidadeReservada: 1 } }),
      membro('CHV', { ehKit: true, ehKitVirtual: true, estoque: { quantidade: 9 } }),
    ]);
    expect(quantidadesDaFamiliaCore(row, opcoes())).toEqual(
      new Map([
        ['PROD', 7],
        ['CH1', 3],
        ['CHV', 9],
      ]),
    );
    // NEAR-MISS: the same row with the skip on omits exactly the virtual child.
    expect(quantidadesDaFamiliaCore(row, opcoes({ pularKitVirtual: true }))).toEqual(
      new Map([
        ['PROD', 7],
        ['CH1', 3],
      ]),
    );
  });

  it('quantidadesDaFamiliaCore accepts a channel row with EXTRA keys (structural)', () => {
    // ML's `StockFamilyRow` and Shopee's `LinhaDeFamiliaShopee` both carry link
    // arrays this core neither sees nor needs. If this stops compiling, the
    // neutral types have grown a field a channel cannot supply.
    const rico = {
      anchorId: 'PROD',
      anchor: membro('PROD', { estoque: { quantidade: 2 } }),
      integracoesComProduto: ['int-1'],
      links: [{ item_id: 2500139861, linkDocId: 'link1' }],
      children: [{ ...membro('CH1', { estoque: { quantidade: 1 } }), varLinks: [] }],
    };
    expect(quantidadesDaFamiliaCore(rico, opcoes())).toEqual(
      new Map([
        ['PROD', 2],
        ['CH1', 1],
      ]),
    );
  });
});

describe('componentesNaoResolvidos / kitNaoVerificavel', () => {
  const kit = (extra: Partial<MembroDaFamilia> = {}) =>
    membro('KIT', {
      ehKit: true,
      componentesKit: { A: componente(1), B: componente(1) },
      ...extra,
    });

  it('names only the constraining components the join did not bring back', () => {
    expect(
      componentesNaoResolvidos(
        kit({ componentEstoques: [{ parentId: 'A', quantidade: 3, quantidadeReservada: 0 }] }),
      ),
    ).toEqual(['B']);
    expect(componentesNaoResolvidos(membro('P1'))).toEqual([]);
  });

  it('⚠️ admits a VIRTUAL kit — PAIR: ehKit and ehKitVirtual behave identically; NEAR-MISS: a plain produto is never a kit', () => {
    const semComponentes = { componentEstoques: [] };
    expect(kitNaoVerificavel(kit(semComponentes))).toBe(true);
    expect(kitNaoVerificavel(kit({ ...semComponentes, ehKit: false, ehKitVirtual: true }))).toBe(
      true,
    );
    expect(kitNaoVerificavel(membro('P1'))).toBe(false);
  });

  it('a PARTIALLY resolved kit is verifiable, and one constrained by nothing is not a kit here', () => {
    expect(
      kitNaoVerificavel(
        kit({ componentEstoques: [{ parentId: 'A', quantidade: 3, quantidadeReservada: 0 }] }),
      ),
    ).toBe(false);
    expect(kitNaoVerificavel(kit({ componentesKit: null, componentEstoques: [] }))).toBe(false);
  });
});

describe('quantidadesAnterioresCore — the reconstruction, and what it OMITS', () => {
  /** A plain produto holding 10 − 2 = 8 available, with no `parentId` on its own row (#932). */
  const simples = () => linha({ estoque: { quantidade: 10, quantidadeReservada: 2 } });

  it('reconstructs a simple produto: anterior = atual − Σmovimento', () => {
    expect(
      quantidadesAnterioresCore(simples(), DEP, mov([['PROD', -3]]), opcoes()).get('PROD'),
    ).toBe(11);
  });

  it('a pair that never moved reconstructs to its current value', () => {
    expect(quantidadesAnterioresCore(simples(), DEP, new Map(), opcoes()).get('PROD')).toBe(8);
  });

  it('undoes the RESERVA arm too, and a reconstruction below zero cannot invent stock (#931)', () => {
    expect(
      quantidadesAnterioresCore(
        simples(),
        DEP,
        new Map([[chaveMovimento('PROD', DEP), { dq: 0, dr: 2, desconhecido: false }]]),
        opcoes(),
      ).get('PROD'),
    ).toBe(10);
    // dq +3 and dr +3 synthesize quantidadeReservada = 2 − 3 = −1. Floored:
    // (10−3) − max(0, −1) = 7. UNFLOORED it would be 8 — exactly `atual` — so
    // the sweep would read "nothing changed" and skip a real movement.
    expect(
      quantidadesAnterioresCore(
        simples(),
        DEP,
        new Map([[chaveMovimento('PROD', DEP), { dq: 3, dr: 3, desconhecido: false }]]),
        opcoes(),
      ).get('PROD'),
    ).toBe(7);
  });

  it('⚠️ OMITS a member whose own movement is `desconhecido` — the omission IS the mechanism', () => {
    // The mutant this kills: "fall back to the current row". That fallback makes
    // `anterior === atual`, which reads as UNCHANGED and silently drops a real
    // movement. The key must be ABSENT, not equal.
    const desconhecido: MovimentosDaJanela = new Map([
      [chaveMovimento('PROD', DEP), { dq: 0, dr: 0, desconhecido: true }],
    ]);
    const anteriores = quantidadesAnterioresCore(simples(), DEP, desconhecido, opcoes());
    expect(anteriores.has('PROD')).toBe(false);
    expect(anteriores.get('PROD')).not.toBe(8); // the fallback's answer
  });

  it('⚠️ OMITS a `kitNaoVerificavel` member, even though the ledger says nothing moved', () => {
    // Second, independent route to absence. The reconstruction would rebuild the
    // same 0 from the same broken component set and conclude "unchanged" about a
    // listing whose published number may be badly wrong (#806 S12, inverted).
    const naoVerificavel = linha({
      ehKit: true,
      componentesKit: { COMP: componente(1) },
      estoque: { quantidade: 9, quantidadeReservada: 0 },
      componentEstoques: [],
    });
    const anteriores = quantidadesAnterioresCore(naoVerificavel, DEP, new Map(), opcoes());
    expect(anteriores.has('PROD')).toBe(false);
    // …while the SAME kit with its component resolved reconstructs normally.
    const verificavel = linha({
      ehKit: true,
      componentesKit: { COMP: componente(1) },
      estoque: { quantidade: 9, quantidadeReservada: 0 },
      componentEstoques: [{ parentId: 'COMP', quantidade: 4, quantidadeReservada: 0 }],
    });
    expect(quantidadesAnterioresCore(verificavel, DEP, new Map(), opcoes()).get('PROD')).toBe(4);
  });

  it('OMITS a kit whose COMPONENT moved by an unknown amount, and keeps it when the amount is readable', () => {
    const kitRow = () =>
      linha({
        ehKit: true,
        componentesKit: { COMP: componente(1) },
        estoque: { quantidade: 0, quantidadeReservada: 0 },
        componentEstoques: [{ parentId: 'COMP', quantidade: 10, quantidadeReservada: 0 }],
      });
    const desconhecido: MovimentosDaJanela = new Map([
      [chaveMovimento('COMP', DEP), { dq: 0, dr: 0, desconhecido: true }],
    ]);
    expect(quantidadesAnterioresCore(kitRow(), DEP, desconhecido, opcoes()).has('PROD')).toBe(
      false,
    );
    expect(
      quantidadesAnterioresCore(kitRow(), DEP, mov([['COMP', -1]]), opcoes()).has('PROD'),
    ).toBe(true);
  });

  it('⚠️ #932: an own-row movement is keyed by member.produtoId, never by the row denorm', () => {
    // The fixture carries no `parentId` on the own row, exactly as the real
    // projection does. Reading the denorm here makes `anterior === atual` and
    // drops every ordinary produto's stock change on every tier.
    expect(
      quantidadesAnterioresCore(simples(), DEP, mov([['PROD', -3]]), opcoes()).get('PROD'),
    ).toBe(11);
  });
});
