import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { envioPrecoFailureSchema, envioPrecoSkipSchema } from './envioPrecoMercadoLivre';
import * as moduloEnvioPrecoShopee from './envioPrecoShopee';
import {
  ENVIO_PRECO_SHOPEE_STATUS,
  envioPrecoShopeeFilaItemSchema,
  envioPrecoShopeeModeloSchema,
  envioPrecoShopeeSchema,
  envioPrecoShopeeStatusSchema,
} from './envioPrecoShopee';
import { ALL_DOMAINS } from './registry';
import { relatorioEnvioPrecoSchema } from './relatorioEnvioPrecoMercadoLivre';
import {
  RETENCAO_ENVIO_PRECO_ML_DIAS,
  RETENCAO_ENVIO_PRECO_SHOPEE_DIAS,
  TTL_POLICIES,
  expiraEmApos,
} from './shared/ttl';

/* Fixture ids only — never a real shop, item or credential. */
const INTEGRACAO = 'int-1';
const ITEM = 2500139861;
const MODELO = 2000458802;
const INICIO = 1_726_000_000_000;
const DIA_MS = 24 * 60 * 60 * 1000;

const MODELO_FILA = { modelId: MODELO, produtoId: 'prod-filho-1', varLinkDocId: 'var-1' };
const ITEM_FILA = {
  produtoId: 'prod-ancora',
  linkDocId: 'link-a',
  itemId: ITEM,
  modelos: [MODELO_FILA],
};

const MINIMO = {
  integracaoId: INTEGRACAO,
  status: 'running' as const,
  startedAt: INICIO,
  updatedAt: INICIO,
};

/** This module's raw TEXT — the array-default rule is measured on it. */
const FONTE = readFileSync(
  fileURLToPath(new URL('./envioPrecoShopee.ts', import.meta.url)),
  'utf8',
);

describe('envioPrecoShopeeSchema — defaults', () => {
  it('a freshly-started job parses with EVERY default applied', () => {
    expect(envioPrecoShopeeSchema.parse(MINIMO)).toEqual({
      ...MINIMO,
      baixarPreco: false,
      afterAnchorId: null,
      planejamentoConcluido: false,
      fila: [],
      planejados: 0,
      enviados: 0,
      pulados: 0,
      falhas: 0,
      pausas: 0,
      parques: 0,
      retomarEm: null,
      skips: [],
      failures: [],
      relatorioLinhas: 0,
      relatorioShards: 0,
      relatorioCompleto: false,
      filaRestante: 0,
      startedBy: null,
      finishedAt: null,
      erro: null,
    });
  });

  it('requires integracaoId, status, startedAt and updatedAt — and nothing else', () => {
    for (const chave of ['integracaoId', 'status', 'startedAt', 'updatedAt'] as const) {
      expect(envioPrecoShopeeSchema.safeParse({ ...MINIMO, [chave]: undefined }).success).toBe(
        false,
      );
    }
    expect(envioPrecoShopeeSchema.safeParse({ ...MINIMO, integracaoId: '' }).success).toBe(false);
  });

  it('PAIR — two parses get two DIFFERENT default arrays; mutating one never leaks into the next', () => {
    const a = envioPrecoShopeeSchema.parse(MINIMO);
    const b = envioPrecoShopeeSchema.parse(MINIMO);
    for (const chave of ['fila', 'skips', 'failures'] as const) {
      expect(a[chave]).not.toBe(b[chave]);
    }
    a.fila.push(envioPrecoShopeeFilaItemSchema.parse(ITEM_FILA));
    expect(envioPrecoShopeeSchema.parse(MINIMO).fila).toEqual([]);
    const semModelos = envioPrecoShopeeFilaItemSchema.parse({ ...ITEM_FILA, modelos: undefined });
    semModelos.modelos.push(envioPrecoShopeeModeloSchema.parse(MODELO_FILA));
    expect(
      envioPrecoShopeeFilaItemSchema.parse({ ...ITEM_FILA, modelos: undefined }).modelos,
    ).toEqual([]);
  });

  it('every array default is written as a FUNCTION — the form that does not depend on the Zod major', () => {
    // Zod 4.4.3 shallow-clones a VALUE default, so the runtime test above cannot
    // tell `.default([])` from `.default(() => [])`; Zod 3 returned the same
    // array by reference. The rule is therefore pinned on the source text.
    expect(FONTE).not.toMatch(/\.default\(\s*\[/);
    expect(FONTE.match(/\.default\(\(\) => \[\]\)/g)).toHaveLength(4);
  });
});

describe('envioPrecoShopeeSchema — a full job round-trips', () => {
  it('parses a mid-plan, mid-fila, parked job unchanged', () => {
    const doc = {
      ...MINIMO,
      baixarPreco: true,
      afterAnchorId: 'prod-ancora-40',
      planejamentoConcluido: false,
      fila: [
        ITEM_FILA,
        { produtoId: 'prod-b', linkDocId: 'link-b', itemId: ITEM + 1, modelos: [] },
      ],
      planejados: 40,
      enviados: 21,
      pulados: 12,
      falhas: 1,
      pausas: 2,
      parques: 1,
      retomarEm: INICIO + DIA_MS,
      skips: [
        {
          itemId: String(ITEM),
          produtoId: 'prod-c',
          code: 'preco-igual',
          linkDocId: 'link-c',
          precoAnterior: 10,
        },
      ],
      failures: [
        {
          itemId: String(ITEM),
          produtoId: 'prod-d',
          code: 'preco-recusado',
          linkDocId: 'link-d',
          precoAnterior: null,
          error: 'product.error_update_price_fail',
        },
      ],
      relatorioLinhas: 34,
      relatorioShards: 1,
      relatorioCompleto: false,
      filaRestante: 0,
      startedBy: 'uid-1',
      finishedAt: null,
      erro: null,
      expiraEm: expiraEmApos(INICIO, RETENCAO_ENVIO_PRECO_SHOPEE_DIAS),
    };
    expect(envioPrecoShopeeSchema.parse(doc)).toEqual(doc);
  });

  it('every stamp is MILLISECONDS — a Date on a stamp field is folded to its ms integer', () => {
    const parsed = envioPrecoShopeeSchema.parse({
      ...MINIMO,
      startedAt: new Date(INICIO),
      retomarEm: new Date(INICIO + DIA_MS),
    });
    expect(parsed.startedAt).toBe(INICIO);
    expect(parsed.retomarEm).toBe(INICIO + DIA_MS);
  });
});

describe('ENVIO_PRECO_SHOPEE_STATUS', () => {
  it('accepts exactly running / completed / failed / cancelled — a PARK is not a status', () => {
    expect([...envioPrecoShopeeStatusSchema.options].sort()).toEqual([
      'cancelled',
      'completed',
      'failed',
      'running',
    ]);
    expect(envioPrecoShopeeStatusSchema.safeParse('parked').success).toBe(false);
  });

  it('names every member on the as-const companion (prefer-schema-enum reads it)', () => {
    expect(Object.values(ENVIO_PRECO_SHOPEE_STATUS).sort()).toEqual(
      [...envioPrecoShopeeStatusSchema.options].sort(),
    );
  });
});

describe('envioPrecoShopeeFilaItemSchema — IDENTITIES only', () => {
  it('declares EXACTLY the planner fields — no price, and no categoryId', () => {
    // The job prices at DRAIN time (reconcile C-d): a `preco` here is the ML
    // shape the park made unsafe, and `categoryId` was cut from the seam.
    expect(Object.keys(envioPrecoShopeeFilaItemSchema.shape).sort()).toEqual([
      'itemId',
      'linkDocId',
      'modelos',
      'produtoId',
    ]);
    expect(Object.keys(envioPrecoShopeeModeloSchema.shape).sort()).toEqual([
      'modelId',
      'produtoId',
      'varLinkDocId',
    ]);
  });

  it('PAIR — a numeric item_id parses; NEAR-MISS — the same id as a STRING is refused', () => {
    expect(envioPrecoShopeeFilaItemSchema.safeParse(ITEM_FILA).success).toBe(true);
    expect(
      envioPrecoShopeeFilaItemSchema.safeParse({ ...ITEM_FILA, itemId: String(ITEM) }).success,
    ).toBe(false);
  });

  it('PAIR — a positive model_id parses; NEAR-MISS — the no-model 0 is never a model entry', () => {
    expect(envioPrecoShopeeModeloSchema.safeParse(MODELO_FILA).success).toBe(true);
    expect(envioPrecoShopeeModeloSchema.safeParse({ ...MODELO_FILA, modelId: 0 }).success).toBe(
      false,
    );
    expect(
      envioPrecoShopeeModeloSchema.safeParse({ ...MODELO_FILA, modelId: String(MODELO) }).success,
    ).toBe(false);
  });

  it('refuses an empty identity string on every id field', () => {
    for (const chave of ['produtoId', 'linkDocId'] as const) {
      expect(envioPrecoShopeeFilaItemSchema.safeParse({ ...ITEM_FILA, [chave]: '' }).success).toBe(
        false,
      );
    }
    for (const chave of ['produtoId', 'varLinkDocId'] as const) {
      expect(envioPrecoShopeeModeloSchema.safeParse({ ...MODELO_FILA, [chave]: '' }).success).toBe(
        false,
      );
    }
  });

  it('an absent modelos list reads as [] — the NO-MODEL listing', () => {
    const { modelos: _modelos, ...semModelos } = ITEM_FILA;
    expect(envioPrecoShopeeFilaItemSchema.parse(semModelos).modelos).toEqual([]);
  });

  it('rides a newer planner key through passthrough, on the item and on the model', () => {
    const parsed = envioPrecoShopeeFilaItemSchema.parse({
      ...ITEM_FILA,
      dicaFutura: 'mantenha',
      modelos: [{ ...MODELO_FILA, outraDica: 7 }],
    });
    expect(parsed).toMatchObject({ dicaFutura: 'mantenha', modelos: [{ outraDica: 7 }] });
  });
});

describe('skips / failures — ML’s sample rows, reused', () => {
  it('binds the SAME element schemas the ML job uses (one row definition, two channels)', () => {
    expect(envioPrecoShopeeSchema.shape.skips.unwrap().element).toBe(envioPrecoSkipSchema);
    expect(envioPrecoShopeeSchema.shape.failures.unwrap().element).toBe(envioPrecoFailureSchema);
  });
});

describe('expiraEm — the TTL stamp (reconcile C-y)', () => {
  const inicio = { ...MINIMO };

  it('PAIR — a Date parses and comes back as the SAME instance (no coercion)', () => {
    const data = expiraEmApos(INICIO, RETENCAO_ENVIO_PRECO_SHOPEE_DIAS);
    expect(envioPrecoShopeeSchema.parse({ ...inicio, expiraEm: data }).expiraEm).toBe(data);
  });

  it('NEAR-MISS — the SAME instant as a numeric epoch is REFUSED (a TTL ignores a number)', () => {
    const ms = expiraEmApos(INICIO, RETENCAO_ENVIO_PRECO_SHOPEE_DIAS).getTime();
    expect(envioPrecoShopeeSchema.safeParse({ ...inicio, expiraEm: ms }).success).toBe(false);
  });

  it('a stored Timestamp (duck-typed) parses; null and absent read as "never expires"', () => {
    const ts = { seconds: 1, nanoseconds: 0, toMillis: () => 1000 };
    expect(envioPrecoShopeeSchema.parse({ ...inicio, expiraEm: ts }).expiraEm).toBe(ts);
    expect(envioPrecoShopeeSchema.parse({ ...inicio, expiraEm: null }).expiraEm).toBeNull();
    expect('expiraEm' in envioPrecoShopeeSchema.parse(inicio)).toBe(false);
  });

  it('the run is kept 180 days from startedAt — the ML twin’s retention', () => {
    expect(RETENCAO_ENVIO_PRECO_SHOPEE_DIAS).toBe(180);
    expect(RETENCAO_ENVIO_PRECO_SHOPEE_DIAS).toBe(RETENCAO_ENVIO_PRECO_ML_DIAS);
    expect(expiraEmApos(INICIO, RETENCAO_ENVIO_PRECO_SHOPEE_DIAS).getTime() - INICIO).toBe(
      180 * DIA_MS,
    );
  });

  it('the report shards carry the stamp too — the shared report schema declares it', () => {
    expect(Object.keys(relatorioEnvioPrecoSchema.shape)).toContain('expiraEm');
  });

  it('TTL_POLICIES names the Shopee run and its shards, and the relatorios motivo TEXT says balanco/*/relatorios is never stamped (the registry text only — no balanço writer is scanned)', () => {
    const porGrupo = new Map(TTL_POLICIES.map((p) => [p.collectionGroup, p.motivo]));
    expect(porGrupo.get('enviosPrecoShopee')).toContain('apps/shopee precos/atualizarPrecos');
    expect(porGrupo.get('enviosPrecoShopee')).toContain('180 days');
    const relatorios = porGrupo.get('relatorios') ?? '';
    expect(relatorios).toContain('apps/mercado-livre precoSync');
    expect(relatorios).toContain('apps/shopee precos/atualizarPrecos');
    expect(relatorios).toContain('balanco/*/relatorios');
    expect(relatorios).toContain('never stamped');
  });
});

describe('enviosPrecoShopee — admin-only registration', () => {
  it('is NOT a domain: not in ALL_DOMAINS, and the module exports no …Meta', () => {
    expect(ALL_DOMAINS.map((d) => d.schema)).not.toContain(envioPrecoShopeeSchema);
    expect(Object.keys(moduloEnvioPrecoShopee).filter((nome) => nome.endsWith('Meta'))).toEqual([]);
  });
});
