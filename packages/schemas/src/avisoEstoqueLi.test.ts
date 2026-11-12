import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANAL_AVISO,
  MAX_AMOSTRA_AVISO_ESTOQUE_LI,
  MOTIVO_ESTOQUE_VINCULO_LI,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  TIPO_AVISO_LABELS,
  avisoSchema,
  chaveDeAviso,
  motivoEstoqueVinculoLiSchema,
  tipoAvisoSchema,
} from './index';

/**
 * The three avisos of the Loja Integrada stock sync (master plan step 12): named, labelled,
 * each with its machine resolver in the docblock (the collection is `serverOwned`: an aviso
 * nothing resolves stands until retention), and parseable as their producers will store them.
 */

const TIPOS = [
  TIPO_AVISO.lojaIntegradaEstoqueSemErp,
  TIPO_AVISO.lojaIntegradaEstoqueRecusado,
  TIPO_AVISO.lojaIntegradaEstoqueVinculo,
] as const;

const AGORA_US = 1_800_000_000_000_000;

function linha(tipo: (typeof TIPOS)[number], params: Record<string, string | number>) {
  return avisoSchema.parse({
    tipo,
    severidade: SEVERIDADE_AVISO.atencao,
    canal: CANAL_AVISO.lojaIntegrada,
    params,
    urlInterna: { rota: ROTAS_AVISO.canalLojaIntegrada.build('int-1'), campo: null },
    relogioEvento: AGORA_US,
    criadoEm: AGORA_US,
    atualizadoEm: AGORA_US,
  });
}

describe('the three stock-sync tipos (Loja Integrada step 12)', () => {
  it('are named and labelled', () => {
    expect(TIPOS).toEqual([
      'lojaIntegradaEstoqueSemErp',
      'lojaIntegradaEstoqueRecusado',
      'lojaIntegradaEstoqueVinculo',
    ]);
    expect(TIPO_AVISO_LABELS.lojaIntegradaEstoqueSemErp).toBe(
      'Produtos da Loja Integrada sem estoque no ERP',
    );
    expect(TIPO_AVISO_LABELS.lojaIntegradaEstoqueRecusado).toBe(
      'Estoque recusado pela Loja Integrada',
    );
    expect(TIPO_AVISO_LABELS.lojaIntegradaEstoqueVinculo).toBe(
      'Estoque da Loja Integrada parado por um vínculo',
    );
  });

  it('⚠️ NEAR-MISS: other spellings are other tipos — refused by the enum, never folded', () => {
    for (const quase of [
      'lojaIntegradaEstoqueSemERP',
      'lojaIntegradaEstoqueRecusada',
      'lojaIntegradaEstoqueVinculos',
      'lojaintegradaEstoqueSemErp',
      'estoqueRecusado',
    ]) {
      expect(tipoAvisoSchema.safeParse(quase).success, quase).toBe(false);
    }
  });

  it('each docblock entry exists and names its machine resolver', () => {
    const FONTE = readFileSync(join(import.meta.dirname, 'aviso.ts'), 'utf8');
    const fim = FONTE.indexOf('export const tipoAvisoSchema');
    for (const tipo of TIPOS) {
      const inicio = FONTE.indexOf(`**\`${tipo}\`**`);
      expect(inicio, tipo).toBeGreaterThan(-1);
      expect(inicio, tipo).toBeLessThan(fim);
      const proximos = TIPOS.map((t) => FONTE.indexOf(`**\`${t}\`**`)).filter((i) => i > inicio);
      const bloco = FONTE.slice(inicio, Math.min(fim, ...proximos));
      expect(bloco, tipo).toMatch(/\*\*Machine resolvers?\*\*/);
      expect(bloco, tipo).toMatch(/\*\*Key\*\*/);
    }
  });

  it('the "sem estoque no ERP" row is per conta: a count and a sample of ids', () => {
    expect(chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaEstoqueSemErp, conta: 'int-1' })).toBe(
      'lojaIntegradaEstoqueSemErp:int-1',
    );
    const lido = linha(TIPO_AVISO.lojaIntegradaEstoqueSemErp, {
      loja: 'Conta A',
      produtos: 12,
      amostra: 'p1, p2',
    });
    expect(lido.params).toEqual({ loja: 'Conta A', produtos: 12, amostra: 'p1, p2' });
    expect(MAX_AMOSTRA_AVISO_ESTOQUE_LI).toBe(200);
  });

  it('a refusal row is per child produto, apart from another produto’s and another conta’s', () => {
    const chave = (conta: string, produto: string) =>
      chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaEstoqueRecusado, conta, entidade: produto });
    expect(chave('int-1', 'p1')).toBe('lojaIntegradaEstoqueRecusado:int-1:p1');
    expect(chave('int-1', 'p1')).not.toBe(chave('int-1', 'p2'));
    expect(chave('int-1', 'p1')).not.toBe(chave('int-2', 'p1'));
    const lido = linha(TIPO_AVISO.lojaIntegradaEstoqueRecusado, {
      loja: 'Conta A',
      produto: 'p1',
      idLi: '123456789',
      status: 422,
    });
    expect(lido.params.status).toBe(422);
  });

  it('a link row is per (conta, motivo): the five motivos are five rows', () => {
    const chaves = motivoEstoqueVinculoLiSchema.options.map((motivo) =>
      chaveDeAviso({
        tipo: TIPO_AVISO.lojaIntegradaEstoqueVinculo,
        conta: 'int-1',
        entidade: motivo,
      }),
    );
    expect(new Set(chaves).size).toBe(5);
    expect(chaves).toContain('lojaIntegradaEstoqueVinculo:int-1:sem-linha-na-loja');
    const lido = linha(TIPO_AVISO.lojaIntegradaEstoqueVinculo, {
      loja: 'Conta A',
      motivo: MOTIVO_ESTOQUE_VINCULO_LI.duplicado,
      produtos: 2,
      amostra: 'p1, p2',
    });
    expect(lido.params.motivo).toBe('duplicado');
  });
});

describe('MOTIVO_ESTOQUE_VINCULO_LI', () => {
  it('is exactly the five reasons, each its own code', () => {
    expect(motivoEstoqueVinculoLiSchema.options).toEqual([
      'ambiguo',
      'duplicado',
      'sem-linha-na-loja',
      'ausente',
      'estoque-ambiguo',
    ]);
    expect(Object.values(MOTIVO_ESTOQUE_VINCULO_LI)).toEqual(motivoEstoqueVinculoLiSchema.options);
  });

  it('⚠️ NEAR-MISS: a near spelling is no motivo', () => {
    for (const quase of ['ambíguo', 'sem_linha_na_loja', 'estoqueAmbiguo', 'Ausente', '']) {
      expect(motivoEstoqueVinculoLiSchema.safeParse(quase).success, quase).toBe(false);
    }
  });
});
