import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANAL_AVISO,
  MOTIVO_CADEIA_CATEGORIA_LI,
  MOTIVO_CATEGORIA_SEM_VINCULO_LI,
  PENDENCIA_IMPORTACAO_LI,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  TIPO_AVISO_LABELS,
  avisoSchema,
  chaveDeAviso,
  motivoCategoriaSemVinculoLiSchema,
  tipoAvisoSchema,
} from './index';

/**
 * The three avisos of the Loja Integrada product import (master plan step 9): named, labelled,
 * each with its machine resolver in the docblock (the collection is `serverOwned`: an aviso nothing
 * resolves stands until retention), and parseable as their producer will store them.
 */

const TIPOS = [
  TIPO_AVISO.lojaIntegradaCategoriaSemVinculo,
  TIPO_AVISO.lojaIntegradaRevisaoFiscal,
  TIPO_AVISO.lojaIntegradaImportacaoComPendencias,
] as const;

const AGORA_US = 1_800_000_000_000_000;

describe('the three product-import tipos (Loja Integrada step 9)', () => {
  it('are named and labelled', () => {
    expect(TIPOS).toEqual([
      'lojaIntegradaCategoriaSemVinculo',
      'lojaIntegradaRevisaoFiscal',
      'lojaIntegradaImportacaoComPendencias',
    ]);
    expect(TIPO_AVISO_LABELS.lojaIntegradaCategoriaSemVinculo).toBe(
      'Categoria da Loja Integrada sem vínculo',
    );
    expect(TIPO_AVISO_LABELS.lojaIntegradaRevisaoFiscal).toBe(
      'Produtos da Loja Integrada para revisão fiscal',
    );
    expect(TIPO_AVISO_LABELS.lojaIntegradaImportacaoComPendencias).toBe(
      'Importação de produtos da Loja Integrada com pendências',
    );
  });

  it('⚠️ NEAR-MISS: other spellings are other tipos — refused by the enum, never folded', () => {
    for (const quase of [
      'lojaIntegradaCategoriaSemVinculos',
      'lojaintegradaRevisaoFiscal',
      'lojaIntegradaImportacaoComPendencia',
      'jobConcluidoComPendencias',
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
    }
  });

  it('parses a category row as stored: per store category, on the conta page', () => {
    const chave = chaveDeAviso({
      tipo: TIPO_AVISO.lojaIntegradaCategoriaSemVinculo,
      conta: 'int-1',
      entidade: '7645875',
    });
    expect(chave).toBe('lojaIntegradaCategoriaSemVinculo:int-1:7645875');
    const lido = avisoSchema.parse({
      tipo: TIPO_AVISO.lojaIntegradaCategoriaSemVinculo,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.lojaIntegrada,
      params: {
        loja: 'Conta A',
        caminho: '7645870 > 7645875',
        produtos: 3,
        motivo: MOTIVO_CATEGORIA_SEM_VINCULO_LI.semVinculo,
      },
      urlInterna: { rota: ROTAS_AVISO.canalLojaIntegrada.build('int-1'), campo: null },
      relogioEvento: AGORA_US,
      criadoEm: AGORA_US,
      atualizadoEm: AGORA_US,
    });
    expect(lido.params).toEqual({
      loja: 'Conta A',
      caminho: '7645870 > 7645875',
      produtos: 3,
      motivo: 'sem-vinculo',
    });
  });

  it('the two per-conta tipos key on the conta alone', () => {
    expect(chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaRevisaoFiscal, conta: 'int-1' })).toBe(
      'lojaIntegradaRevisaoFiscal:int-1',
    );
    expect(
      chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaImportacaoComPendencias, conta: 'int-1' }),
    ).toBe('lojaIntegradaImportacaoComPendencias:int-1');
  });

  it('the summary row stores one NUMBER per actionable code, keyed by the code', () => {
    const lido = avisoSchema.parse({
      tipo: TIPO_AVISO.lojaIntegradaImportacaoComPendencias,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.lojaIntegrada,
      params: {
        loja: 'Conta A',
        acionaveis: 5,
        job: 'job1',
        [PENDENCIA_IMPORTACAO_LI.semSku]: 2,
        [PENDENCIA_IMPORTACAO_LI.skuParecido]: 3,
      },
      relogioEvento: AGORA_US,
      criadoEm: AGORA_US,
      atualizadoEm: AGORA_US,
    });
    expect(lido.params['sem-sku']).toBe(2);
  });
});

describe('MOTIVO_CATEGORIA_SEM_VINCULO_LI', () => {
  it('covers "no link" and every reason the category tree refuses a chain but `ausente`', () => {
    expect(motivoCategoriaSemVinculoLiSchema.options).toContain('sem-vinculo');
    const recusas = Object.values(MOTIVO_CADEIA_CATEGORIA_LI).filter(
      (motivo) => motivo !== MOTIVO_CADEIA_CATEGORIA_LI.ausente,
    );
    for (const motivo of recusas) {
      expect(motivoCategoriaSemVinculoLiSchema.safeParse(motivo).success, motivo).toBe(true);
    }
    expect(motivoCategoriaSemVinculoLiSchema.options).toHaveLength(recusas.length + 1);
  });

  it('⚠️ never `ausente`: the row’s own "gone from the store" resolver would close it on the next run', () => {
    expect(
      motivoCategoriaSemVinculoLiSchema.safeParse(MOTIVO_CADEIA_CATEGORIA_LI.ausente).success,
    ).toBe(false);
  });
});
