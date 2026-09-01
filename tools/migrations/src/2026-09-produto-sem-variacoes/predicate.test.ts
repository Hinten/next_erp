import { describe, expect, it } from 'vitest';
import {
  classificarProduto,
  depositoIdDoRef,
  montarLinha,
  resumirEstoques,
  resumirLinha,
  type EstoqueBruto,
  type ProdutoBruto,
} from './predicate';

const PRODUTO = 'prod-1';
const DEPOSITO = 'dep-1';
/** What `makeEstoqueUid(PRODUTO, DEPOSITO)` produces — spelled out, not imported. */
const UID_CANONICO = 'est-prod-1-dep-1';

function bruto(over: Partial<EstoqueBruto> = {}): EstoqueBruto {
  return {
    docId: UID_CANONICO,
    depositoOuterRef: `documents/depositos/${DEPOSITO}`,
    quantidade: 0,
    quantidadeReservada: 0,
    ...over,
  };
}

function produto(over: Partial<ProdutoBruto> = {}): ProdutoBruto {
  return {
    id: PRODUTO,
    nome: 'Bandeja',
    sku: 'BAN-1',
    paiId: null,
    ehKit: false,
    publicado: true,
    ultimaModificacao: 1_756_196_207_441,
    ...over,
  };
}

describe('depositoIdDoRef', () => {
  // Both encodings are legal and `aplicarBalanco.ts:228-233` queries for both.
  it('resolves the canonical form', () => {
    expect(depositoIdDoRef('documents/depositos/dep-9')).toBe('dep-9');
  });

  it('resolves the bare form the migrated corpus also holds', () => {
    expect(depositoIdDoRef('depositos/dep-9')).toBe('dep-9');
  });

  // ⚠️ The near-miss. A trailing-segment reader (`split('/').pop()`) would answer
  // 'dep-9' here and silently attribute stock to a depósito that was never named.
  it('refuses a ref into some OTHER collection, even when the id looks right', () => {
    expect(depositoIdDoRef('documents/filiais/dep-9')).toBeNull();
    expect(depositoIdDoRef('documents/produtos/dep-9')).toBeNull();
  });

  it('refuses anything that is not a usable ref', () => {
    expect(depositoIdDoRef(null)).toBeNull();
    expect(depositoIdDoRef(undefined)).toBeNull();
    expect(depositoIdDoRef('')).toBeNull();
    expect(depositoIdDoRef(42)).toBeNull();
    expect(depositoIdDoRef('depositos')).toBeNull();
  });
});

describe('resumirLinha — the canonical-id test', () => {
  it('does not flag the canonical id', () => {
    expect(resumirLinha(PRODUTO, bruto()).sinais).toEqual([]);
  });

  // ⚠️ THE case from `.old/packages/produtos/lib/src/tasks.dart:92`, which calls
  // makeEstoqueUid(depositoId, produtoId) with the arguments TRANSPOSED. It is a
  // near-miss by construction: same prefix, same two ids, same separator — only
  // the order differs, and a substring test would pass it.
  it('flags the transposed legacy id est-<depositoId>-<produtoId>', () => {
    const linha = resumirLinha(PRODUTO, bruto({ docId: `est-${DEPOSITO}-${PRODUTO}` }));
    expect(linha.sinais).toContain('id-nao-canonico');
  });

  it('flags an auto-id row', () => {
    expect(resumirLinha(PRODUTO, bruto({ docId: 'gT7xQ2mAbCdEf' })).sinais).toContain(
      'id-nao-canonico',
    );
  });

  // A row whose depósito cannot be resolved has no canonical id to be compared
  // against, so it must NOT also claim the id is wrong — that would double-count
  // one defect as two.
  it('does not claim a non-canonical id when the depósito is unresolvable', () => {
    const linha = resumirLinha(PRODUTO, bruto({ depositoOuterRef: 'lixo', docId: 'qualquer' }));
    expect(linha.sinais).toEqual(['deposito-irreconhecivel']);
    expect(linha.depositoId).toBeNull();
  });
});

describe('resumirLinha — what would move, and what would stay', () => {
  it('moves the whole quantity when nothing is reserved', () => {
    const linha = resumirLinha(PRODUTO, bruto({ quantidade: 20 }));
    expect(linha).toMatchObject({ disponivel: 20, moveria: 20, ficaNoPai: 0 });
  });

  // ⚠️ The residual the whole design turns on (`upSoleMember.ts:243-257`): the
  // available half moves, the reserved half stays so the pedido's release still
  // has a row to decrement.
  it('splits a partially reserved row', () => {
    const linha = resumirLinha(PRODUTO, bruto({ quantidade: 20, quantidadeReservada: 6 }));
    expect(linha).toMatchObject({ disponivel: 14, moveria: 14, ficaNoPai: 6 });
  });

  it('moves nothing when the whole quantity is reserved', () => {
    const linha = resumirLinha(PRODUTO, bruto({ quantidade: 5, quantidadeReservada: 5 }));
    expect(linha).toMatchObject({ disponivel: 0, moveria: 0, ficaNoPai: 5 });
  });

  // `estoqueDisponivel` returns the honest negative; `moveria` is what a WRITE
  // would use and must never be one.
  it('reports a negative disponível but never moves a negative', () => {
    const linha = resumirLinha(PRODUTO, bruto({ quantidade: 2, quantidadeReservada: 5 }));
    expect(linha.disponivel).toBe(-3);
    expect(linha.moveria).toBe(0);
    expect(linha.ficaNoPai).toBe(5);
  });

  // The #931 defect, surfaced in passing. `reservaEfetiva` floors it, so it can
  // never INCREASE what would move — which is the direction that oversells.
  it('flags a negative reservation and does not let it invent units', () => {
    const linha = resumirLinha(PRODUTO, bruto({ quantidade: 10, quantidadeReservada: -2 }));
    expect(linha.sinais).toContain('reservada-negativa');
    expect(linha).toMatchObject({ disponivel: 10, moveria: 10, ficaNoPai: 0 });
  });

  it('flags non-numeric counters and reads them as zero', () => {
    const linha = resumirLinha(PRODUTO, bruto({ quantidade: undefined, quantidadeReservada: 'x' }));
    expect(linha.sinais).toContain('quantidade-nao-numerica');
    expect(linha.sinais).toContain('reservada-nao-numerica');
    expect(linha).toMatchObject({ quantidade: 0, quantidadeReservada: 0, moveria: 0 });
  });
});

describe('resumirEstoques — what counts as "holds stock"', () => {
  it('is false for a produto with no rows at all', () => {
    const resumo = resumirEstoques(PRODUTO, []);
    expect(resumo.temEstoque).toBe(false);
    expect(resumo).toMatchObject({ nDepositos: 0, moveriaTotal: 0, ficariaNoPaiTotal: 0 });
  });

  // ⚠️ EVERY legacy root produto has zero rows like this — Flutter's
  // `criarEstoques` writes one per depósito on create AND update. If this
  // returned true the census would flag the entire catalogue.
  it('is false for the zero rows Flutter creates for every produto', () => {
    expect(
      resumirEstoques(PRODUTO, [bruto(), bruto({ docId: 'est-prod-1-dep-2' })]).temEstoque,
    ).toBe(false);
  });

  // ⚠️ The near-miss on the OTHER side: disponível is 0, but the produto is
  // holding 5 units. Keying `temEstoque` on `estoqueDisponivel !== 0` would miss
  // it, and the conversion would leave those units stranded with nothing to say so.
  it('is true when everything is reserved and disponível reads zero', () => {
    const resumo = resumirEstoques(PRODUTO, [bruto({ quantidade: 5, quantidadeReservada: 5 })]);
    expect(resumo.temEstoque).toBe(true);
    expect(resumo.moveriaTotal).toBe(0);
    expect(resumo.ficariaNoPaiTotal).toBe(5);
  });

  it('is true when only the reservation is non-zero', () => {
    expect(resumirEstoques(PRODUTO, [bruto({ quantidadeReservada: 3 })]).temEstoque).toBe(true);
  });

  it('totals across depósitos and counts the distinct ones', () => {
    const resumo = resumirEstoques(PRODUTO, [
      bruto({ quantidade: 20, quantidadeReservada: 6 }),
      bruto({
        docId: 'est-prod-1-dep-2',
        depositoOuterRef: 'depositos/dep-2',
        quantidade: 14,
      }),
    ]);
    expect(resumo).toMatchObject({
      quantidadeTotal: 34,
      reservadaTotal: 6,
      moveriaTotal: 28,
      ficariaNoPaiTotal: 6,
      nDepositos: 2,
      nLinhasNaoCanonicas: 0,
      nDepositosIrreconheciveis: 0,
    });
  });

  it('counts the anomalies separately from the totals', () => {
    const resumo = resumirEstoques(PRODUTO, [
      bruto({ docId: 'auto-id', quantidade: 3 }),
      bruto({ depositoOuterRef: 'lixo', quantidade: 4 }),
    ]);
    expect(resumo).toMatchObject({
      nLinhasNaoCanonicas: 1,
      nDepositosIrreconheciveis: 1,
      nDepositos: 1,
      quantidadeTotal: 7,
    });
  });
});

describe('classificarProduto', () => {
  const semEstoque = resumirEstoques(PRODUTO, []);
  const comEstoque = resumirEstoques(PRODUTO, [bruto({ quantidade: 20 })]);

  it('is simples-com-estoque for a childless root holding units — the conversion work', () => {
    expect(
      classificarProduto({ paiId: null, paiExiste: false, temFilhos: false, resumo: comEstoque }),
    ).toBe('simples-com-estoque');
  });

  it('is simples-sem-estoque for a childless root holding nothing', () => {
    expect(
      classificarProduto({ paiId: null, paiExiste: false, temFilhos: false, resumo: semEstoque }),
    ).toBe('simples-sem-estoque');
  });

  it('is ja-familia for a root that already owns children', () => {
    expect(
      classificarProduto({ paiId: null, paiExiste: false, temFilhos: true, resumo: null }),
    ).toBe('ja-familia');
  });

  it('is filho for a produto whose paiId exists', () => {
    expect(
      classificarProduto({ paiId: 'pai-1', paiExiste: true, temFilhos: false, resumo: null }),
    ).toBe('filho');
  });

  it('is orfao for a produto whose paiId names nothing', () => {
    expect(
      classificarProduto({ paiId: 'pai-sumido', paiExiste: false, temFilhos: false, resumo: null }),
    ).toBe('orfao');
  });

  // ⚠️ Order matters, and this is what pins it. The schema does not forbid a
  // child that itself has children; asking "temFilhos" first would relabel it
  // ja-familia and put a variation child into the conversion's candidate set.
  it('calls a child with children a filho, not a ja-familia', () => {
    expect(
      classificarProduto({ paiId: 'pai-1', paiExiste: true, temFilhos: true, resumo: null }),
    ).toBe('filho');
  });

  // The conservative direction: an unread estoque must not be read as "holds
  // stock", because that bucket is the one that implies a move.
  it('falls back to simples-sem-estoque when the estoque was not read', () => {
    expect(
      classificarProduto({ paiId: null, paiExiste: false, temFilhos: false, resumo: null }),
    ).toBe('simples-sem-estoque');
  });
});

describe('montarLinha', () => {
  // ⚠️ The whole point of reading `ultimaModificacao` with `Object.hasOwn`. An
  // ABSENT key hides the produto from `/produtos` (#1213); a stored null does
  // not. `?? null` would collapse them and the finding would never be reported.
  it('separates an ABSENT ultimaModificacao from a stored null', () => {
    expect(montarLinha(base({ ultimaModificacao: undefined })).semUltimaModificacao).toBe(true);
    expect(montarLinha(base({ ultimaModificacao: null })).semUltimaModificacao).toBe(false);
    expect(montarLinha(base({ ultimaModificacao: 0 })).semUltimaModificacao).toBe(false);
  });

  it('carries the produto path and the forensic fields', () => {
    expect(montarLinha(base())).toMatchObject({
      produtoPath: 'produtos/prod-1',
      produtoId: PRODUTO,
      nome: 'Bandeja',
      sku: 'BAN-1',
      ehKit: false,
      publicado: true,
    });
  });

  it('reads an empty-string sku as absent rather than as a value', () => {
    expect(montarLinha(base({ sku: '' })).sku).toBeNull();
  });

  // ⚠️ "not measured" and "measured, found none" must never be the same value in
  // a report someone sizes a migration from.
  it('keeps null (not measured) distinct from 0/false (measured, none found)', () => {
    const naoMedido = montarLinha({
      produto: produto(),
      veredito: 'simples-com-estoque',
      resumo: null,
      nKitsQueReferenciam: 0,
      emBalancoAberto: null,
      nPedidosAbertosQueReservam: null,
    });
    expect(naoMedido.emBalancoAberto).toBeNull();
    expect(naoMedido.nPedidosAbertosQueReservam).toBeNull();

    const medido = montarLinha({
      produto: produto(),
      veredito: 'simples-com-estoque',
      resumo: null,
      nKitsQueReferenciam: 0,
      emBalancoAberto: false,
      nPedidosAbertosQueReservam: 0,
    });
    expect(medido.emBalancoAberto).toBe(false);
    expect(medido.nPedidosAbertosQueReservam).toBe(0);
  });

  function base(over: Partial<ProdutoBruto> = {}) {
    return {
      produto: produto(over),
      veredito: 'simples-com-estoque' as const,
      resumo: null,
      nKitsQueReferenciam: 2,
      emBalancoAberto: false,
      nPedidosAbertosQueReservam: 1,
    };
  }
});
