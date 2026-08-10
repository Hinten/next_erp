import { describe, expect, it } from 'vitest';
import {
  ESTADO_BALANCO,
  RELATORIO_BALANCO_SHARD_SIZE,
  balancoAceitaLancamento,
  balancoMeta,
  balancoSchema,
  estadoBalanco,
  itemRelatorioBalancoSchema,
  movimentoBalancoMeta,
  movimentoBalancoSchema,
  podeFinalizarBalanco,
  relatorioBalancoMeta,
  relatorioBalancoSchema,
  relatorioBalancoShardId,
} from './balanco';

const DEPOSITO = 'documents/depositos/dep-1';
const PRODUTO = 'documents/produtos/prod-1';
const USUARIO = 'documents/usuarios/uid-1';

describe('balancoSchema', () => {
  it('opens a balanço with every server-owned field null', () => {
    const out = balancoSchema.parse({ nome: 'Contagem Janeiro', depositoOuterRef: DEPOSITO });
    expect(out).toMatchObject({
      nome: 'Contagem Janeiro',
      depositoOuterRef: DEPOSITO,
      estado: null,
      dataFinalizado: null,
      finalizacao: null,
    });
  });

  it('rejects an empty nome and a nome over 255 chars', () => {
    expect(balancoSchema.safeParse({ nome: '', depositoOuterRef: DEPOSITO }).success).toBe(false);
    expect(
      balancoSchema.safeParse({ nome: 'x'.repeat(256), depositoOuterRef: DEPOSITO }).success,
    ).toBe(false);
  });

  it('requires a depósito, and requires it in the canonical outer-ref form', () => {
    expect(balancoSchema.safeParse({ nome: 'Sem depósito' }).success).toBe(false);
    expect(
      balancoSchema.safeParse({ nome: 'Bare ref', depositoOuterRef: 'depositos/dep-1' }).success,
    ).toBe(false);
  });

  it('rejects an estado outside the enum', () => {
    // The legacy Flutter names in particular — a doc written by the old app
    // must not parse as if it were one of ours.
    for (const estado of ['aberto', 'iniciado', 'emProcessamento', 'gerandoFinalizacao', 'error']) {
      expect(
        balancoSchema.safeParse({ nome: 'n', depositoOuterRef: DEPOSITO, estado }).success,
      ).toBe(false);
    }
    expect(
      balancoSchema.safeParse({
        nome: 'n',
        depositoOuterRef: DEPOSITO,
        estado: ESTADO_BALANCO.finalizado,
      }).success,
    ).toBe(true);
  });

  it('parses the finalizacao checkpoint with its defaults', () => {
    const out = balancoSchema.parse({
      nome: 'n',
      depositoOuterRef: DEPOSITO,
      estado: ESTADO_BALANCO.finalizando,
      finalizacao: { iniciadoEm: 1_700_000_000_000, usuarioOuterRef: USUARIO },
    });
    expect(out.finalizacao).toMatchObject({
      iniciadoEm: 1_700_000_000_000,
      usuarioOuterRef: USUARIO,
      zerarNaoContados: false,
      shards: null,
      shardCursor: 0,
      produtosAplicados: 0,
      erro: null,
    });
  });
});

describe('estado helpers', () => {
  it('reads a null estado as aberto', () => {
    expect(estadoBalanco({ estado: null })).toBe('aberto');
    expect(estadoBalanco({ estado: ESTADO_BALANCO.finalizado })).toBe(ESTADO_BALANCO.finalizado);
  });

  it('accepts lançamentos only while open', () => {
    expect(balancoAceitaLancamento({ estado: null })).toBe(true);
    for (const estado of [
      ESTADO_BALANCO.finalizando,
      ESTADO_BALANCO.finalizado,
      // Even a parked-in-error balanço stays closed to counting: its
      // movimentos have already been aggregated into a report.
      ESTADO_BALANCO.erro,
    ]) {
      expect(balancoAceitaLancamento({ estado })).toBe(false);
    }
  });

  it('lets finalize take the lock when open or parked in erro, never twice', () => {
    expect(podeFinalizarBalanco({ estado: null, dataFinalizado: null })).toBe(true);
    expect(podeFinalizarBalanco({ estado: ESTADO_BALANCO.erro, dataFinalizado: null })).toBe(true);
    expect(podeFinalizarBalanco({ estado: ESTADO_BALANCO.finalizando, dataFinalizado: null })).toBe(
      false,
    );
    expect(podeFinalizarBalanco({ estado: ESTADO_BALANCO.finalizado, dataFinalizado: 1 })).toBe(
      false,
    );
  });

  it('refuses to re-finalize on dataFinalizado alone, even with a forged estado', () => {
    // `estado` and `dataFinalizado` are both server-owned, but this is the
    // half that is written once and never cleared — so the guard survives even
    // if `estado` somehow says the balanço is open again.
    expect(podeFinalizarBalanco({ estado: null, dataFinalizado: 1_700_000_000_000 })).toBe(false);
    expect(
      podeFinalizarBalanco({ estado: ESTADO_BALANCO.erro, dataFinalizado: 1_700_000_000_000 }),
    ).toBe(false);
  });
});

describe('movimentoBalancoSchema', () => {
  it('defaults a bare lançamento to a live, non-error row', () => {
    const out = movimentoBalancoSchema.parse({
      produtoOuterRef: PRODUTO,
      produtoId: 'prod-1',
      quantidade: 3,
      usuarioOuterRef: USUARIO,
    });
    expect(out).toMatchObject({
      produtoId: 'prod-1',
      quantidade: 3,
      removido: false,
      error: false,
      errorInput: null,
      errorMessage: null,
    });
  });

  it('accepts an error row with no produto at all', () => {
    const out = movimentoBalancoSchema.parse({
      usuarioOuterRef: USUARIO,
      error: true,
      errorInput: '789123',
      errorMessage: 'SKU não encontrado',
    });
    expect(out.produtoOuterRef).toBeNull();
    expect(out.produtoId).toBeNull();
    // Error rows carry 0, not a phantom 1: they are excluded from every total,
    // and a 1 would be a lie if the filter were ever dropped.
    expect(out.quantidade).toBe(0);
  });

  it('rejects a fractional quantidade — a balanço counts whole things', () => {
    expect(movimentoBalancoSchema.safeParse({ quantidade: 1.5 }).success).toBe(false);
  });

  it('allows a negative quantidade so a miscount can be corrected in place', () => {
    expect(movimentoBalancoSchema.parse({ quantidade: -2 }).quantidade).toBe(-2);
  });
});

describe('relatorioBalancoSchema', () => {
  it('parses a shard keyed by bare produto id', () => {
    const out = relatorioBalancoSchema.parse({
      itens: { 'prod-1': { sku: 'ABC', nome: 'Camiseta', estoque: 8, contado: 5 } },
      timestamp: 1_700_000_000_000,
    });
    expect(out.itens['prod-1']).toMatchObject({ estoque: 8, contado: 5, estoquesExtras: null });
  });

  it('defaults an empty shard to an empty map', () => {
    expect(relatorioBalancoSchema.parse({}).itens).toEqual({});
  });

  it('keeps `contado: null` distinct from `contado: 0`', () => {
    // null = never counted (a `zerar` row); 0 = counted and found empty.
    const nunca = itemRelatorioBalancoSchema.parse({});
    const contadoZero = itemRelatorioBalancoSchema.parse({ contado: 0 });
    expect(nunca.contado).toBeNull();
    expect(contadoZero.contado).toBe(0);
  });
});

describe('relatorioBalancoShardId', () => {
  it('zero-pads so lexical order is shard order', () => {
    expect(relatorioBalancoShardId(0)).toBe('0000');
    expect(relatorioBalancoShardId(7)).toBe('0007');
    expect(['0010', '0002', '0000'].sort()).toEqual(['0000', '0002', '0010']);
  });

  it('stays sortable past the padding width', () => {
    // Beyond 9999 the padding stops helping, but a shard count that high needs
    // 5M produtos — well past anything this job will see.
    expect(relatorioBalancoShardId(12345)).toBe('12345');
    expect(RELATORIO_BALANCO_SHARD_SIZE).toBe(500);
  });
});

describe('metas', () => {
  it('rides the estoque permission bits (byte 8) — no new domain', () => {
    for (const meta of [balancoMeta, movimentoBalancoMeta, relatorioBalancoMeta]) {
      expect(meta.permissions.read).toBe(1n << 64n);
      expect(meta.permissions.write).toBe(1n << 65n);
      expect(meta.permissions.delete).toBe(1n << 66n);
    }
  });

  it('declares the collection paths the finalize job walks', () => {
    expect(balancoMeta.collectionPath).toBe('balanco');
    expect(movimentoBalancoMeta.collectionPath).toBe('balanco/{balancoId}/movimentos');
    expect(relatorioBalancoMeta.collectionPath).toBe('balanco/{balancoId}/relatorios');
  });

  it('server-owns the whole workflow lock, not just the finished flag', () => {
    expect(balancoMeta.serverOwnedFields).toEqual(['estado', 'dataFinalizado', 'finalizacao']);
    expect(relatorioBalancoMeta.serverOwned).toBe(true);
  });

  it('opts both subcollections out of the collection-group read block', () => {
    // Every read is scoped to one balanço, so the group block would only widen
    // the query surface — the exact shape flagged as a leak in the legacy
    // ruleset (#454).
    expect(movimentoBalancoMeta.noCollectionGroupRead).toBe(true);
    expect(relatorioBalancoMeta.noCollectionGroupRead).toBe(true);
  });
});
