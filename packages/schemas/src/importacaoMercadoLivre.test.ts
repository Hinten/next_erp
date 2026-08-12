import { describe, expect, it } from 'vitest';
import {
  importacaoMercadoLivreSchema,
  importacaoMercadoLivreStatusSchema,
  massImportFailureSchema,
  massImportOptionsSchema,
} from './importacaoMercadoLivre';
import { ALL_DOMAINS } from './registry';

const OPTIONS = {
  importarEstoque: true,
  sobrescreverEstoque: false,
  importarPreco: true,
  sobrescreverPreco: true,
  atualizarProdutoPai: true,
  importarFotos: true,
  importarCategorias: true,
  atualizarCadastrados: false,
};

describe('importacaoMercadoLivreSchema', () => {
  it('parses a freshly-started job with defaults applied', () => {
    const parsed = importacaoMercadoLivreSchema.parse({
      integracaoId: 'INT1',
      status: 'running',
      options: OPTIONS,
      startedAt: 1718003600000,
      updatedAt: 1718003600000,
    });
    expect(parsed).toMatchObject({
      integracaoId: 'INT1',
      status: 'running',
      scrollId: null,
      fila: [],
      scanned: 0,
      imported: 0,
      created: 0,
      skipped: 0,
      failureCount: 0,
      failures: [],
      options: OPTIONS,
      finishedAt: null,
      erro: null,
    });
  });

  it('parses a full in-progress job (mid-fila, mid-scan)', () => {
    const doc = {
      integracaoId: 'INT1',
      status: 'running' as const,
      scrollId: 'SCROLL2',
      fila: ['MLB1', 'MLB2'],
      scanned: 40,
      imported: 20,
      created: 5,
      skipped: 12,
      failureCount: 1,
      failures: [{ itemId: 'MLB99', error: 'anúncio pausado' }],
      options: OPTIONS,
      startedAt: 1718003600000,
      updatedAt: 1718003650000,
      finishedAt: null,
      erro: null,
    };
    expect(importacaoMercadoLivreSchema.parse(doc)).toMatchObject(doc);
  });

  it('parses a completed job', () => {
    const parsed = importacaoMercadoLivreSchema.parse({
      integracaoId: 'INT1',
      status: 'completed',
      options: OPTIONS,
      startedAt: 1718003600000,
      updatedAt: 1718003999000,
      finishedAt: 1718003999000,
    });
    expect(parsed.status).toBe('completed');
    expect(parsed.finishedAt).toBe(1718003999000);
  });

  it('parses a failed job with an erro string', () => {
    const parsed = importacaoMercadoLivreSchema.parse({
      integracaoId: 'INT1',
      status: 'failed',
      options: OPTIONS,
      startedAt: 1718003600000,
      updatedAt: 1718003999000,
      finishedAt: 1718003999000,
      erro: 'Token do Mercado Livre inválido. Reconecte a conta.',
    });
    expect(parsed.status).toBe('failed');
    expect(parsed.erro).toBe('Token do Mercado Livre inválido. Reconecte a conta.');
  });

  it('requires integracaoId, status and options', () => {
    expect(
      importacaoMercadoLivreSchema.safeParse({
        status: 'running',
        options: OPTIONS,
        startedAt: 1,
        updatedAt: 1,
      }).success,
    ).toBe(false);
    expect(
      importacaoMercadoLivreSchema.safeParse({
        integracaoId: 'INT1',
        options: OPTIONS,
        startedAt: 1,
        updatedAt: 1,
      }).success,
    ).toBe(false);
    expect(
      importacaoMercadoLivreSchema.safeParse({
        integracaoId: 'INT1',
        status: 'running',
        startedAt: 1,
        updatedAt: 1,
      }).success,
    ).toBe(false);
    expect(
      importacaoMercadoLivreSchema.safeParse({
        integracaoId: '',
        status: 'running',
        options: OPTIONS,
        startedAt: 1,
        updatedAt: 1,
      }).success,
    ).toBe(false);
  });

  it('only accepts running/completed/failed as status', () => {
    expect(importacaoMercadoLivreStatusSchema.safeParse('running').success).toBe(true);
    expect(importacaoMercadoLivreStatusSchema.safeParse('completed').success).toBe(true);
    expect(importacaoMercadoLivreStatusSchema.safeParse('failed').success).toBe(true);
    expect(importacaoMercadoLivreStatusSchema.safeParse('parked').success).toBe(false);
  });
});

describe('massImportOptionsSchema', () => {
  it('requires all 8 booleans', () => {
    expect(massImportOptionsSchema.safeParse(OPTIONS).success).toBe(true);
    const { atualizarCadastrados: _atualizarCadastrados, ...withoutLast } = OPTIONS;
    expect(massImportOptionsSchema.safeParse(withoutLast).success).toBe(false);
  });
});

describe('massImportFailureSchema', () => {
  it('parses an itemId/error pair', () => {
    expect(massImportFailureSchema.parse({ itemId: 'MLB1', error: 'boom' })).toEqual({
      itemId: 'MLB1',
      error: 'boom',
    });
  });
});

describe('importacoesMercadoLivre admin-only registration', () => {
  it('is NOT registered in ALL_DOMAINS (server-only mass-import job doc)', () => {
    const domainSchemas = ALL_DOMAINS.map((d) => d.schema);
    expect(domainSchemas).not.toContain(importacaoMercadoLivreSchema);
  });
});
