import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANAL_AVISO,
  MAX_AMOSTRA_AVISO_PRECO_LI,
  MOTIVO_PRECO_PARADO_LI,
  MOTIVO_PRECO_RECUSADO_LI,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  TIPO_AVISO_LABELS,
  avisoSchema,
  chaveDeAviso,
  motivoPrecoParadoLiSchema,
  motivoPrecoRecusadoLiSchema,
  tipoAvisoSchema,
} from './index';

/**
 * The four avisos of the Loja Integrada price sync (master plan step 13): named, labelled, each
 * with its machine resolver in the docblock (the collection is `serverOwned`: an aviso nothing
 * resolves stands until retention), and parseable as their producers will store them.
 */

const TIPOS = [
  TIPO_AVISO.lojaIntegradaPrecoSemErp,
  TIPO_AVISO.lojaIntegradaPrecoRecusado,
  TIPO_AVISO.lojaIntegradaPrecoNaoBaixado,
  TIPO_AVISO.lojaIntegradaPrecoParado,
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

describe('the four price-sync tipos (Loja Integrada step 13)', () => {
  it('are named and labelled, right after the stock ones', () => {
    expect(TIPOS).toEqual([
      'lojaIntegradaPrecoSemErp',
      'lojaIntegradaPrecoRecusado',
      'lojaIntegradaPrecoNaoBaixado',
      'lojaIntegradaPrecoParado',
    ]);
    const opcoes = tipoAvisoSchema.options;
    const depoisDoEstoque = opcoes.indexOf('lojaIntegradaEstoqueVinculo') + 1;
    expect(opcoes.slice(depoisDoEstoque, depoisDoEstoque + 4)).toEqual([...TIPOS]);
    expect(TIPO_AVISO_LABELS.lojaIntegradaPrecoSemErp).toBe(
      'Produtos da Loja Integrada sem preço no ERP',
    );
    expect(TIPO_AVISO_LABELS.lojaIntegradaPrecoRecusado).toBe('Preço recusado pela Loja Integrada');
    expect(TIPO_AVISO_LABELS.lojaIntegradaPrecoNaoBaixado).toBe(
      'Redução de preço não enviada à Loja Integrada',
    );
    expect(TIPO_AVISO_LABELS.lojaIntegradaPrecoParado).toBe(
      'Envio de preços da Loja Integrada parado',
    );
  });

  it('⚠️ NEAR-MISS: other spellings are other tipos — refused by the enum, never folded', () => {
    for (const quase of [
      'lojaIntegradaPrecoSemERP',
      'lojaIntegradaPrecoRecusada',
      'lojaIntegradaPrecosNaoBaixados',
      'lojaIntegradaPrecoParada',
      'lojaintegradaPrecoSemErp',
      'precoRecusado',
    ]) {
      expect(tipoAvisoSchema.safeParse(quase).success, quase).toBe(false);
    }
  });

  it('each docblock entry exists and names its machine resolver and its key', () => {
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

  it('the "sem preço no ERP" and "não baixado" rows are per conta: counts and a sample', () => {
    expect(chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaPrecoSemErp, conta: 'int-1' })).toBe(
      'lojaIntegradaPrecoSemErp:int-1',
    );
    expect(chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaPrecoNaoBaixado, conta: 'int-1' })).toBe(
      'lojaIntegradaPrecoNaoBaixado:int-1',
    );
    expect(
      linha(TIPO_AVISO.lojaIntegradaPrecoSemErp, {
        loja: 'Conta A',
        produtos: 12,
        ilegiveis: 2,
        amostra: 'p1, p2',
      }).params,
    ).toEqual({ loja: 'Conta A', produtos: 12, ilegiveis: 2, amostra: 'p1, p2' });
    expect(
      linha(TIPO_AVISO.lojaIntegradaPrecoNaoBaixado, {
        loja: 'Conta A',
        produtos: 5,
        baixadosNoErp: 1,
        amostra: 'p3',
      }).params.baixadosNoErp,
    ).toBe(1);
    expect(MAX_AMOSTRA_AVISO_PRECO_LI).toBe(200);
  });

  it('a refusal row is per child produto, apart from another produto’s, another conta’s and the stock one', () => {
    const chave = (conta: string, produto: string) =>
      chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaPrecoRecusado, conta, entidade: produto });
    expect(chave('int-1', 'p1')).toBe('lojaIntegradaPrecoRecusado:int-1:p1');
    expect(chave('int-1', 'p1')).not.toBe(chave('int-1', 'p2'));
    expect(chave('int-1', 'p1')).not.toBe(chave('int-2', 'p1'));
    expect(chave('int-1', 'p1')).not.toBe(
      chaveDeAviso({
        tipo: TIPO_AVISO.lojaIntegradaEstoqueRecusado,
        conta: 'int-1',
        entidade: 'p1',
      }),
    );
    const lido = linha(TIPO_AVISO.lojaIntegradaPrecoRecusado, {
      loja: 'Conta A',
      produto: 'p1',
      idLi: '123456789',
      motivo: MOTIVO_PRECO_RECUSADO_LI.recusado,
      status: 422,
    });
    expect(lido.params.status).toBe(422);
    expect(lido.params.motivo).toBe('recusado');
  });

  it('a "parado" row is per (conta, motivo): the two motivos are two rows', () => {
    const chaves = motivoPrecoParadoLiSchema.options.map((motivo) =>
      chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaPrecoParado, conta: 'int-1', entidade: motivo }),
    );
    expect(new Set(chaves).size).toBe(2);
    expect(chaves).toContain('lojaIntegradaPrecoParado:int-1:divergencia-em-massa');
    const lido = linha(TIPO_AVISO.lojaIntegradaPrecoParado, {
      loja: 'Conta A',
      motivo: MOTIVO_PRECO_PARADO_LI.naoConverge,
      produtos: 2,
      amostra: 'p1, p2',
    });
    expect(lido.params.motivo).toBe('nao-converge');
  });
});

describe('the two motivo vocabularies', () => {
  it('MOTIVO_PRECO_RECUSADO_LI is exactly the refusal and the non-reflected write', () => {
    expect(motivoPrecoRecusadoLiSchema.options).toEqual(['recusado', 'nao-refletido']);
    expect(Object.values(MOTIVO_PRECO_RECUSADO_LI)).toEqual(motivoPrecoRecusadoLiSchema.options);
  });

  it('MOTIVO_PRECO_PARADO_LI is exactly the mass gate and the non-convergence', () => {
    expect(motivoPrecoParadoLiSchema.options).toEqual(['divergencia-em-massa', 'nao-converge']);
    expect(Object.values(MOTIVO_PRECO_PARADO_LI)).toEqual(motivoPrecoParadoLiSchema.options);
  });

  it('⚠️ NEAR-MISS: a near spelling is no motivo', () => {
    for (const quase of ['recusada', 'naoRefletido', 'nao_refletido', '']) {
      expect(motivoPrecoRecusadoLiSchema.safeParse(quase).success, quase).toBe(false);
    }
    for (const quase of [
      'divergencia',
      'divergência-em-massa',
      'nao-convergiu',
      'naoConverge',
      '',
    ]) {
      expect(motivoPrecoParadoLiSchema.safeParse(quase).success, quase).toBe(false);
    }
  });
});
