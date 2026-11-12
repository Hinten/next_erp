import { describe, expect, it } from 'vitest';
import {
  MOTIVO_ESTOQUE_VINCULO_LI,
  TIPO_AVISO,
  TIPO_AVISO_LABELS,
  motivoEstoqueVinculoLiSchema,
} from '@delfrance/schemas';
import { MENSAGENS_POR_TIPO } from './mensagens';

/**
 * The wording of the three Loja Integrada stock-sync avisos (step 12), rendered with the params
 * their producers will write (the send run and the reconcile of `apps/loja-integrada`; a copied
 * literal is the only way to hold the writer's params against this reader, since `apps/web` has
 * no edge to that app).
 */

const TIPOS = [
  TIPO_AVISO.lojaIntegradaEstoqueSemErp,
  TIPO_AVISO.lojaIntegradaEstoqueRecusado,
  TIPO_AVISO.lojaIntegradaEstoqueVinculo,
] as const;

describe('the stock-sync avisos', () => {
  it.each(TIPOS)(
    '%s is titled like its label and carries no runbook — the fix is in the ERP or the panel',
    (tipo) => {
      expect(MENSAGENS_POR_TIPO[tipo].titulo).toBe(TIPO_AVISO_LABELS[tipo]);
      expect(MENSAGENS_POR_TIPO[tipo].runbook).toBeUndefined();
    },
  );

  it('"sem estoque no ERP" names the count, the store, the sample and what keeps the store’s number', () => {
    const corpo = MENSAGENS_POR_TIPO[TIPO_AVISO.lojaIntegradaEstoqueSemErp].corpo({
      loja: 'Conta A',
      produtos: 12,
      amostra: 'p1, p2',
    });
    expect(corpo).toContain('12 produto(s) vinculado(s) à loja Conta A nunca tiveram estoque');
    expect(corpo).toContain('em nenhum depósito');
    expect(corpo).toContain('mantém o número que já tinha');
    expect(corpo).toContain('Os primeiros: p1, p2.');
    expect(corpo).toContain('no depósito da conta');
  });

  it('near-miss: no sample stored ⇒ no "Os primeiros" clause at all, never a dash', () => {
    const corpo = MENSAGENS_POR_TIPO[TIPO_AVISO.lojaIntegradaEstoqueSemErp].corpo({
      loja: 'Conta A',
      produtos: 1,
    });
    expect(corpo).not.toContain('Os primeiros');
    expect(corpo).not.toContain('undefined');
  });

  it('a refusal names the produto, the store id, the store and the status', () => {
    const corpo = MENSAGENS_POR_TIPO[TIPO_AVISO.lojaIntegradaEstoqueRecusado].corpo({
      loja: 'Conta A',
      produto: 'p1',
      idLi: '123456789',
      status: 422,
    });
    expect(corpo).toContain('recusou o estoque do produto p1 (produto 123456789 na loja Conta A)');
    expect(corpo).toContain('com HTTP 422');
    expect(corpo).toContain('a conferência diária tenta de novo');
  });

  it('near-miss: a refusal with no status drops the whole clause', () => {
    const corpo = MENSAGENS_POR_TIPO[TIPO_AVISO.lojaIntegradaEstoqueRecusado].corpo({
      loja: 'Conta A',
      produto: 'p1',
      idLi: '123456789',
    });
    expect(corpo).not.toContain('HTTP');
    expect(corpo).toContain('(produto 123456789 na loja Conta A), e o número');
  });

  it.each(motivoEstoqueVinculoLiSchema.options)(
    'the link aviso has its own sentence for %s',
    (motivo) => {
      const corpo = MENSAGENS_POR_TIPO[TIPO_AVISO.lojaIntegradaEstoqueVinculo].corpo({
        loja: 'Conta A',
        motivo,
        produtos: 2,
        amostra: 'p3, p4',
      });
      expect(corpo).toContain('Na loja Conta A, 2 produto(s) estão sem envio de estoque');
      expect(corpo).not.toContain('confira os vínculos e o estoque desses produtos');
      expect(corpo).toContain('Os primeiros: p3, p4.');
    },
  );

  it('the five sentences differ, and an unknown or inherited code falls back', () => {
    const frase = (motivo: string) =>
      MENSAGENS_POR_TIPO[TIPO_AVISO.lojaIntegradaEstoqueVinculo].corpo({
        loja: 'Conta A',
        motivo,
        produtos: 1,
      });
    const frases = Object.values(MOTIVO_ESTOQUE_VINCULO_LI).map(frase);
    expect(new Set(frases).size).toBe(frases.length);
    for (const desconhecido of ['outro-motivo', 'toString', '']) {
      expect(frase(desconhecido), desconhecido).toContain(
        'confira os vínculos e o estoque desses produtos',
      );
    }
    expect(frase(MOTIVO_ESTOQUE_VINCULO_LI.duplicado)).toContain(
      'um produto da loja está vinculado a dois produtos do ERP',
    );
  });
});
