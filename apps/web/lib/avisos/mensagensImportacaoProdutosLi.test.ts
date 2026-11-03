import { describe, expect, it } from 'vitest';
import {
  MOTIVO_CATEGORIA_SEM_VINCULO_LI,
  TIPO_AVISO,
  TIPO_AVISO_LABELS,
  motivoCategoriaSemVinculoLiSchema,
} from '@delfrance/schemas';
import { MENSAGENS_POR_TIPO } from './mensagens';

/**
 * The wording of the three Loja Integrada product-import avisos (step 9), rendered with the
 * params their producer writes (the job of `apps/loja-integrada`; a copied literal is the only way
 * to hold the writer's params against this reader, since `apps/web` has no edge to that app).
 */

const TIPOS = [
  TIPO_AVISO.lojaIntegradaCategoriaSemVinculo,
  TIPO_AVISO.lojaIntegradaRevisaoFiscal,
  TIPO_AVISO.lojaIntegradaImportacaoComPendencias,
] as const;

describe('the product-import avisos', () => {
  it.each(TIPOS)(
    '%s is titled like its label and carries no runbook — the fix is in the app',
    (tipo) => {
      expect(MENSAGENS_POR_TIPO[tipo].titulo).toBe(TIPO_AVISO_LABELS[tipo]);
      expect(MENSAGENS_POR_TIPO[tipo].runbook).toBeUndefined();
    },
  );

  it('the category aviso names the path, the store, the motivo and the products to review', () => {
    const corpo = MENSAGENS_POR_TIPO[TIPO_AVISO.lojaIntegradaCategoriaSemVinculo].corpo({
      loja: 'Conta A',
      caminho: '7645870 > 7645875',
      produtos: 3,
      motivo: MOTIVO_CATEGORIA_SEM_VINCULO_LI.semVinculo,
    });
    expect(corpo).toContain('A categoria 7645870 > 7645875 da loja Conta A');
    expect(corpo).toContain('a importação só vincula categorias');
    expect(corpo).toContain('3 produto(s) foram importados sem categoria');
    expect(corpo).toContain('revisão fiscal');
  });

  it.each(motivoCategoriaSemVinculoLiSchema.options)('motivo %s has its own sentence', (motivo) => {
    const corpo = MENSAGENS_POR_TIPO[TIPO_AVISO.lojaIntegradaCategoriaSemVinculo].corpo({ motivo });
    expect(corpo).not.toContain('confira o relatório da importação de produtos');
    expect(corpo).not.toContain('undefined');
  });

  it('a motivo newer than this build falls back to a neutral sentence, never "undefined"', () => {
    const corpo = MENSAGENS_POR_TIPO[TIPO_AVISO.lojaIntegradaCategoriaSemVinculo].corpo({
      motivo: 'motivo-novo',
    });
    expect(corpo).toContain('confira o relatório da importação de produtos');
    expect(corpo).not.toContain('undefined');
  });

  it('the two per-conta avisos print their counts', () => {
    expect(
      MENSAGENS_POR_TIPO[TIPO_AVISO.lojaIntegradaRevisaoFiscal].corpo({
        loja: 'Conta A',
        abertos: 4,
        job: 'job1',
      }),
    ).toContain('4 produto(s) aguardam revisão fiscal');
    expect(
      MENSAGENS_POR_TIPO[TIPO_AVISO.lojaIntegradaImportacaoComPendencias].corpo({
        loja: 'Conta A',
        acionaveis: 5,
        job: 'job1',
        'sem-sku': 5,
      }),
    ).toContain('terminou com 5 pendência(s)');
  });
});
