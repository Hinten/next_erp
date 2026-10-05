import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  IMPORTACAO_SHOPEE_STATUS,
  OPCOES_IMPORTACAO_SHOPEE_PADRAO,
  SHOPEE_IMPORT_STATUS,
  SHOPEE_IMPORT_STATUS_PADRAO,
  importacaoShopeeMeta,
  importacaoShopeeOptionsSchema,
  importacaoShopeeSchema,
  importacaoShopeeStatusSchema,
  shopeeImportStatusSchema,
  shopeeImportacaoFalhaSchema,
} from './importacaoShopee';
import { ALL_DOMAINS } from './registry';

/** Um job recém-criado: o mínimo que a rota `importar-todos` grava. */
const STAMP_MS = 1_757_500_000_000;
/** O mesmo instante em MICROSSEGUNDOS — a única forma de provar a unidade do campo. */
const STAMP_US = 1_757_500_000_000_000;

const JOB_MINIMO = {
  integracaoId: 'int-1',
  status: IMPORTACAO_SHOPEE_STATUS.running,
  startedAt: STAMP_MS,
  updatedAt: STAMP_MS,
};

describe('importacaoShopeeOptionsSchema', () => {
  it('um doc de job sem NENHUMA chave de options parseia com todos os padrões', () => {
    const parsed = importacaoShopeeSchema.parse(JOB_MINIMO);
    expect(parsed.options).toEqual({
      statuses: ['NORMAL', 'UNLIST'],
      importarEstoque: true,
      sobrescreverEstoque: false,
      importarPreco: true,
      sobrescreverPreco: true,
      atualizarProdutoPai: true,
      sobrescreverDadosProduto: false,
      importarFotos: true,
      importarCategorias: true,
      atualizarCadastrados: false,
      updateTimeFromS: null,
      updateTimeToS: null,
    });
  });

  it('um options VAZIO produz exatamente o mesmo objeto que a ausência do campo — uma só fonte', () => {
    const semCampo = importacaoShopeeSchema.parse(JOB_MINIMO).options;
    const campoVazio = importacaoShopeeSchema.parse({ ...JOB_MINIMO, options: {} }).options;
    expect(campoVazio).toEqual(semCampo);
    expect(importacaoShopeeOptionsSchema.parse({})).toEqual(semCampo);
  });

  it('o padrão de statuses é SHOPEE_IMPORT_STATUS_PADRAO e vem de OPCOES_IMPORTACAO_SHOPEE_PADRAO', () => {
    const { statuses } = importacaoShopeeOptionsSchema.parse({});
    expect(statuses).toEqual([...SHOPEE_IMPORT_STATUS_PADRAO]);
    expect(statuses).toEqual([...OPCOES_IMPORTACAO_SHOPEE_PADRAO.statuses]);
    expect(OPCOES_IMPORTACAO_SHOPEE_PADRAO.statuses).toBe(SHOPEE_IMPORT_STATUS_PADRAO);
  });

  it('cada parse recebe um ARRAY NOVO — o padrão não é compartilhado entre documentos', () => {
    const a = importacaoShopeeOptionsSchema.parse({});
    const b = importacaoShopeeOptionsSchema.parse({});
    expect(a.statuses).not.toBe(b.statuses);
    a.statuses.push(SHOPEE_IMPORT_STATUS.banned);
    expect(importacaoShopeeOptionsSchema.parse({}).statuses).toEqual([
      ...SHOPEE_IMPORT_STATUS_PADRAO,
    ]);
  });

  it('aceita os quatro statuses do enum e nada além deles', () => {
    expect(
      importacaoShopeeOptionsSchema.parse({
        statuses: ['NORMAL', 'UNLIST', 'BANNED', 'REVIEWING'],
      }).statuses,
    ).toEqual(['NORMAL', 'UNLIST', 'BANNED', 'REVIEWING']);
  });

  it('⛔ SELLER_DELETE é RECUSADO pelo enum de opções — um anúncio deletado nunca vira produto', () => {
    expect(shopeeImportStatusSchema.safeParse('SELLER_DELETE').success).toBe(false);
    expect(importacaoShopeeOptionsSchema.safeParse({ statuses: ['SELLER_DELETE'] }).success).toBe(
      false,
    );
  });

  it('⛔ SHOPEE_DELETE é RECUSADO pelo enum de opções, pelo mesmo motivo', () => {
    expect(shopeeImportStatusSchema.safeParse('SHOPEE_DELETE').success).toBe(false);
    expect(importacaoShopeeOptionsSchema.safeParse({ statuses: ['SHOPEE_DELETE'] }).success).toBe(
      false,
    );
  });

  it('⛔ near-miss: `normal` minúsculo NÃO é `NORMAL` — os tokens do wire são case-sensitive', () => {
    expect(shopeeImportStatusSchema.safeParse('normal').success).toBe(false);
    expect(shopeeImportStatusSchema.safeParse('Normal').success).toBe(false);
    expect(shopeeImportStatusSchema.safeParse('NORMAL').success).toBe(true);
  });

  it('⛔ uma lista de statuses VAZIA é recusada — item_status é obrigatório no wire', () => {
    expect(importacaoShopeeOptionsSchema.safeParse({ statuses: [] }).success).toBe(false);
  });

  it('a janela update_time é em SEGUNDOS e só aceita inteiros positivos ou null', () => {
    const parsed = importacaoShopeeOptionsSchema.parse({
      updateTimeFromS: 1_757_400_000,
      updateTimeToS: 1_757_500_000,
    });
    expect(parsed.updateTimeFromS).toBe(1_757_400_000);
    expect(parsed.updateTimeToS).toBe(1_757_500_000);
    expect(importacaoShopeeOptionsSchema.safeParse({ updateTimeFromS: 0 }).success).toBe(false);
    expect(importacaoShopeeOptionsSchema.safeParse({ updateTimeFromS: -1 }).success).toBe(false);
    expect(importacaoShopeeOptionsSchema.safeParse({ updateTimeFromS: 1.5 }).success).toBe(false);
    expect(importacaoShopeeOptionsSchema.parse({ updateTimeFromS: null }).updateTimeFromS).toBe(
      null,
    );
  });

  it('SHOPEE_IMPORT_STATUS cobre exatamente os quatro valores do enum de opções', () => {
    expect(Object.values(SHOPEE_IMPORT_STATUS)).toEqual([
      'NORMAL',
      'UNLIST',
      'BANNED',
      'REVIEWING',
    ]);
    expect(Object.values(SHOPEE_IMPORT_STATUS)).toHaveLength(
      shopeeImportStatusSchema.options.length,
    );
  });
});

describe('shopeeImportacaoFalhaSchema', () => {
  it('parseia uma falha com a mensagem em branco por padrão', () => {
    expect(shopeeImportacaoFalhaSchema.parse({ itemId: 34_001, motivo: 'item-deletado' })).toEqual({
      itemId: 34_001,
      motivo: 'item-deletado',
      mensagem: '',
    });
  });

  it('guarda motivo e mensagem quando ambos vêm preenchidos', () => {
    const falha = {
      itemId: 34_002,
      motivo: 'erro-schema',
      mensagem: 'response.item_list[0].deboost',
    };
    expect(shopeeImportacaoFalhaSchema.parse(falha)).toEqual(falha);
  });

  it('⛔ um motivo vazio é recusado — a falha é agrupada POR ele', () => {
    expect(shopeeImportacaoFalhaSchema.safeParse({ itemId: 1, motivo: '' }).success).toBe(false);
  });

  it('⛔ o itemId é NÚMERO — um id em string não casa com o composto do vínculo', () => {
    expect(shopeeImportacaoFalhaSchema.safeParse({ itemId: '34001', motivo: 'x' }).success).toBe(
      false,
    );
  });
});

describe('importacaoShopeeSchema', () => {
  it('parseia um job recém-criado com todos os padrões aplicados', () => {
    const parsed = importacaoShopeeSchema.parse(JOB_MINIMO);
    expect(parsed).toMatchObject({
      integracaoId: 'int-1',
      status: 'running',
      nextOffset: null,
      fila: [],
      filaKits: [],
      scanned: 0,
      imported: 0,
      created: 0,
      skipped: 0,
      kits: 0,
      failureCount: 0,
      failures: [],
      finishedAt: null,
      erro: null,
    });
  });

  it('cada parse recebe filas NOVAS — drenar uma não contamina o próximo documento', () => {
    const a = importacaoShopeeSchema.parse(JOB_MINIMO);
    const b = importacaoShopeeSchema.parse(JOB_MINIMO);
    expect(a.fila).not.toBe(b.fila);
    expect(a.filaKits).not.toBe(b.filaKits);
    expect(a.failures).not.toBe(b.failures);
    a.fila.push(34_001);
    expect(importacaoShopeeSchema.parse(JOB_MINIMO).fila).toEqual([]);
  });

  it('faz round-trip de um job no meio da drenagem', () => {
    const doc = {
      integracaoId: 'int-1',
      status: IMPORTACAO_SHOPEE_STATUS.running,
      nextOffset: 200,
      fila: [34_001, 34_002],
      filaKits: [34_050],
      scanned: 200,
      imported: 120,
      created: 90,
      skipped: 40,
      kits: 2,
      failureCount: 3,
      failures: [{ itemId: 34_099, motivo: 'item-nao-retornado', mensagem: '' }],
      options: importacaoShopeeOptionsSchema.parse({}),
      startedAt: STAMP_MS,
      updatedAt: STAMP_MS + 60_000,
      finishedAt: null,
      erro: null,
    };
    expect(importacaoShopeeSchema.parse(doc)).toEqual(doc);
  });

  it('exige integracaoId não-vazio e um status — um job sem conta não é retomável', () => {
    expect(
      importacaoShopeeSchema.safeParse({ status: 'running', startedAt: 1, updatedAt: 1 }).success,
    ).toBe(false);
    expect(
      importacaoShopeeSchema.safeParse({
        integracaoId: '',
        status: 'running',
        startedAt: 1,
        updatedAt: 1,
      }).success,
    ).toBe(false);
    expect(
      importacaoShopeeSchema.safeParse({ integracaoId: 'int-1', startedAt: 1, updatedAt: 1 })
        .success,
    ).toBe(false);
  });

  it('aceita os quatro estados do job e nada mais', () => {
    for (const estado of Object.values(IMPORTACAO_SHOPEE_STATUS)) {
      expect(importacaoShopeeStatusSchema.safeParse(estado).success).toBe(true);
    }
    expect(importacaoShopeeStatusSchema.safeParse('parked').success).toBe(false);
    expect(importacaoShopeeStatusSchema.safeParse('Running').success).toBe(false);
  });

  it('IMPORTACAO_SHOPEE_STATUS cobre exatamente os quatro membros do enum', () => {
    expect(Object.values(IMPORTACAO_SHOPEE_STATUS)).toEqual([
      'running',
      'completed',
      'failed',
      'cancelled',
    ]);
    expect(Object.values(IMPORTACAO_SHOPEE_STATUS)).toHaveLength(
      importacaoShopeeStatusSchema.options.length,
    );
  });

  it('nextOffset aceita 0 (a primeira página É o offset 0) e null', () => {
    expect(importacaoShopeeSchema.parse({ ...JOB_MINIMO, nextOffset: 0 }).nextOffset).toBe(0);
    expect(importacaoShopeeSchema.parse({ ...JOB_MINIMO, nextOffset: null }).nextOffset).toBe(null);
  });

  it('⛔ um nextOffset NEGATIVO é recusado — o cursor vem do servidor, não de aritmética local', () => {
    expect(importacaoShopeeSchema.safeParse({ ...JOB_MINIMO, nextOffset: -1 }).success).toBe(false);
    expect(importacaoShopeeSchema.safeParse({ ...JOB_MINIMO, nextOffset: 1.5 }).success).toBe(
      false,
    );
  });

  it('fila e filaKits aceitam apenas inteiros POSITIVOS', () => {
    const parsed = importacaoShopeeSchema.parse({
      ...JOB_MINIMO,
      fila: [34_001],
      filaKits: [34_050],
    });
    expect(parsed.fila).toEqual([34_001]);
    expect(parsed.filaKits).toEqual([34_050]);
    for (const invalido of [0, -1, 1.5, '34001']) {
      expect(importacaoShopeeSchema.safeParse({ ...JOB_MINIMO, fila: [invalido] }).success).toBe(
        false,
      );
      expect(
        importacaoShopeeSchema.safeParse({ ...JOB_MINIMO, filaKits: [invalido] }).success,
      ).toBe(false);
    }
  });

  it('os carimbos são MILISSEGUNDOS inteiros — um valor em µs é normalizado para ms', () => {
    const parsed = importacaoShopeeSchema.parse({
      ...JOB_MINIMO,
      startedAt: STAMP_US,
      updatedAt: STAMP_US,
      finishedAt: STAMP_US,
    });
    expect(parsed.startedAt).toBe(STAMP_MS);
    expect(parsed.updatedAt).toBe(STAMP_MS);
    expect(parsed.finishedAt).toBe(STAMP_MS);
    expect(Number.isInteger(parsed.startedAt)).toBe(true);
  });

  it('parseia um job encerrado com erro', () => {
    const parsed = importacaoShopeeSchema.parse({
      ...JOB_MINIMO,
      status: IMPORTACAO_SHOPEE_STATUS.failed,
      finishedAt: STAMP_MS + 300_000,
      erro: 'Limite diário da Shopee atingido; ele zera à meia-noite UTC+8.',
    });
    expect(parsed.status).toBe('failed');
    expect(parsed.erro).toBe('Limite diário da Shopee atingido; ele zera à meia-noite UTC+8.');
  });
});

describe('importacaoShopeeMeta', () => {
  it('aponta para a coleção de topo importacoesShopee com permissões 0n', () => {
    expect(importacaoShopeeMeta.collectionPath).toBe('importacoesShopee');
    expect(importacaoShopeeMeta.permissions).toEqual({ read: 0n, write: 0n, delete: 0n });
  });

  it('não começa com `notificacoes` — o prefixo que os guardrails obrigam a evitar', () => {
    expect(importacaoShopeeMeta.collectionPath.startsWith('notificacoes')).toBe(false);
  });
});

describe('registro admin-only de importacoesShopee', () => {
  // A forma EXATA que o `isDomainSchema()` de `registry.test.ts` procura: UM
  // export que carrega `.schema` (um ZodType) E `.meta.collectionPath`. Nenhum
  // dos dois exports bare a satisfaz — é por isso que este arquivo pode ficar
  // fora de ALL_DOMAINS sem que nada precise ser regenerado.
  const pareceDomainSchema = (value: unknown): boolean => {
    if (typeof value !== 'object' || value === null) return false;
    const candidato = value as { schema?: unknown; meta?: unknown };
    if (!(candidato.schema instanceof z.ZodType)) return false;
    if (typeof candidato.meta !== 'object' || candidato.meta === null) return false;
    return typeof (candidato.meta as { collectionPath?: unknown }).collectionPath === 'string';
  };

  it('nem o schema nem o meta formam um DomainSchema — são duas constantes BARE', () => {
    expect(pareceDomainSchema(importacaoShopeeSchema)).toBe(false);
    expect(pareceDomainSchema(importacaoShopeeMeta)).toBe(false);
    // ⛔ near-miss: o par JUNTO seria um DomainSchema — é a montagem que está
    // proibida aqui, não os campos.
    expect(pareceDomainSchema({ schema: importacaoShopeeSchema, meta: importacaoShopeeMeta })).toBe(
      true,
    );
  });

  it('não está em ALL_DOMAINS — nem pelo schema nem pelo collectionPath', () => {
    expect(ALL_DOMAINS.map((d) => d.schema)).not.toContain(importacaoShopeeSchema);
    expect(ALL_DOMAINS.map((d) => d.meta.collectionPath)).not.toContain(
      importacaoShopeeMeta.collectionPath,
    );
  });
});
