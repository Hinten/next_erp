import { describe, expect, it } from 'vitest';
import {
  MOTIVO_PRECO_PARADO_LI,
  MOTIVO_PRECO_RECUSADO_LI,
  TIPO_AVISO,
  TIPO_AVISO_LABELS,
  motivoPrecoParadoLiSchema,
} from '@delfrance/schemas';
import { MENSAGENS_POR_TIPO } from './mensagens';

/**
 * The wording of the four Loja Integrada price-sync avisos (step 13), rendered with the params
 * their producers will write (the send run and the reconcile of `apps/loja-integrada`; a copied
 * literal is the only way to hold the writer's params against this reader, since `apps/web` has
 * no edge to that app).
 */

const TIPOS = [
  TIPO_AVISO.lojaIntegradaPrecoSemErp,
  TIPO_AVISO.lojaIntegradaPrecoRecusado,
  TIPO_AVISO.lojaIntegradaPrecoNaoBaixado,
  TIPO_AVISO.lojaIntegradaPrecoParado,
] as const;

/** Each Parado motivo's DISTINCTIVE phrase — the fact that sends the operator to the right fix. */
const FRASE_DO_MOTIVO = [
  [MOTIVO_PRECO_PARADO_LI.divergenciaEmMassa, 'não enviou o preço de nenhum produto desta loja'],
  [MOTIVO_PRECO_PARADO_LI.naoConverge, 'nas duas últimas conferências'],
] as const;

const corpo = (tipo: (typeof TIPOS)[number], params: Record<string, string | number>) =>
  MENSAGENS_POR_TIPO[tipo].corpo(params);

describe('the price-sync avisos', () => {
  it.each(TIPOS)(
    '%s is titled like its label and carries no runbook — the fix is in the ERP or the panel',
    (tipo) => {
      expect(MENSAGENS_POR_TIPO[tipo].titulo).toBe(TIPO_AVISO_LABELS[tipo]);
      expect(MENSAGENS_POR_TIPO[tipo].runbook).toBeUndefined();
    },
  );

  it('"sem preço no ERP" names the count, the store, the unreadable share, the sample and what the store keeps', () => {
    const texto = corpo(TIPO_AVISO.lojaIntegradaPrecoSemErp, {
      loja: 'Conta A',
      produtos: 12,
      ilegiveis: 2,
      amostra: 'p1, p2',
    });
    expect(texto).toContain('12 produto(s) vinculado(s) à loja Conta A não têm preço');
    expect(texto).toContain('(2 deles com um preço que o ERP não consegue ler)');
    expect(texto).toContain('a Loja Integrada mantém o preço que já tinha');
    expect(texto).toContain('Os primeiros: p1, p2.');
    expect(texto).not.toContain('undefined');
  });

  it('⚠️ "sem preço no ERP" sends a child of a propagating parent to the PARENT’s price', () => {
    // Under propagation the child's own entry never prices it: the copy must not send the
    // operator to an edit the ERP refuses.
    const texto = corpo(TIPO_AVISO.lojaIntegradaPrecoSemErp, { loja: 'Conta A', produtos: 1 });
    expect(texto).toContain('Cadastre o preço deles na tabela da conta');
    expect(texto).toContain('no produto pai, quando ele propaga o preço às variações');
  });

  it('"sem preço no ERP" counts the children whose parent is not there, beside the unreadable ones', () => {
    const ambos = corpo(TIPO_AVISO.lojaIntegradaPrecoSemErp, {
      loja: 'Conta A',
      produtos: 5,
      ilegiveis: 2,
      semPai: 1,
    });
    expect(ambos).toContain(
      '(2 deles com um preço que o ERP não consegue ler; 1 deles apontando para um produto pai ' +
        'que não existe no ERP)',
    );
    const soSemPai = corpo(TIPO_AVISO.lojaIntegradaPrecoSemErp, {
      loja: 'Conta A',
      produtos: 1,
      semPai: 1,
    });
    expect(soSemPai).toContain('(1 deles apontando para um produto pai que não existe no ERP)');
    expect(soSemPai).not.toContain('não consegue ler');
  });

  it('near-miss: no unreadable or parentless share (absent or 0) and no sample ⇒ no such clause', () => {
    const casos: Record<string, string | number>[] = [
      { loja: 'Conta A', produtos: 1 },
      { loja: 'Conta A', produtos: 1, ilegiveis: 0 },
      { loja: 'Conta A', produtos: 1, ilegiveis: 0, semPai: 0 },
    ];
    for (const params of casos) {
      const texto = corpo(TIPO_AVISO.lojaIntegradaPrecoSemErp, params);
      expect(texto).not.toContain('não consegue ler');
      expect(texto).not.toContain('não existe no ERP');
      expect(texto).not.toContain('Os primeiros');
      expect(texto).not.toContain('ERP (');
      expect(texto).not.toContain('—');
      expect(texto).not.toContain('undefined');
    }
  });

  it('a refusal names the produto, the store id, the store and the status', () => {
    const texto = corpo(TIPO_AVISO.lojaIntegradaPrecoRecusado, {
      loja: 'Conta A',
      produto: 'p1',
      idLi: '123456789',
      motivo: MOTIVO_PRECO_RECUSADO_LI.recusado,
      status: 422,
    });
    expect(texto).toContain(
      'recusou o preço do produto p1 (produto 123456789 na loja Conta A) com HTTP 422',
    );
    expect(texto).toContain('não foi atualizado');
    expect(texto).not.toContain('undefined');
  });

  it('⚠️ a non-reflected price says the store ACCEPTED it — never that it refused', () => {
    const texto = corpo(TIPO_AVISO.lojaIntegradaPrecoRecusado, {
      loja: 'Conta A',
      produto: 'p1',
      idLi: '123456789',
      motivo: MOTIVO_PRECO_RECUSADO_LI.naoRefletido,
    });
    expect(texto).toContain('aceitou o preço do produto p1');
    expect(texto).toContain('mesmo depois de um segundo envio');
    expect(texto).not.toContain('recusou');
    expect(texto).not.toContain('HTTP');
  });

  it('near-miss: a refusal with no status drops the clause; an unknown motivo falls back', () => {
    const semStatus = corpo(TIPO_AVISO.lojaIntegradaPrecoRecusado, {
      loja: 'Conta A',
      produto: 'p1',
      idLi: '1',
      motivo: MOTIVO_PRECO_RECUSADO_LI.recusado,
    });
    expect(semStatus).not.toContain('HTTP');
    expect(semStatus).toContain('(produto 1 na loja Conta A), e o preço');
    for (const motivo of ['outro-motivo', 'toString', '']) {
      const texto = corpo(TIPO_AVISO.lojaIntegradaPrecoRecusado, {
        loja: 'Conta A',
        produto: 'p1',
        idLi: '1',
        motivo,
      });
      expect(texto, motivo).toContain('não ficou com o preço do produto p1');
      expect(texto, motivo).not.toContain('undefined');
    }
  });

  it('"não baixado" names the count, the lowered-in-the-ERP share, the sample and the way to send', () => {
    const texto = corpo(TIPO_AVISO.lojaIntegradaPrecoNaoBaixado, {
      loja: 'Conta A',
      produtos: 5,
      baixadosNoErp: 2,
      amostra: 'p3',
    });
    expect(texto).toContain('Na loja Conta A, 5 produto(s) têm no ERP um preço menor');
    expect(texto).toContain('uma promoção nova');
    expect(texto).toContain('2 deles porque o preço baixou no ERP');
    expect(texto).toContain('"permitir baixar preços"');
    expect(texto).toContain('Os primeiros: p3.');
    const semBaixados = corpo(TIPO_AVISO.lojaIntegradaPrecoNaoBaixado, {
      loja: 'Conta A',
      produtos: 5,
      baixadosNoErp: 0,
    });
    expect(semBaixados).not.toContain('baixou no ERP');
    expect(semBaixados).not.toContain('undefined');
  });

  it('the phrase table covers every Parado motivo, once each', () => {
    expect(FRASE_DO_MOTIVO.map(([motivo]) => motivo)).toEqual(motivoPrecoParadoLiSchema.options);
  });

  it.each(FRASE_DO_MOTIVO)(
    '⚠️ the Parado aviso for %s says ITS fact, and not the other’s',
    (motivo, frase) => {
      const texto = corpo(TIPO_AVISO.lojaIntegradaPrecoParado, {
        loja: 'Conta A',
        motivo,
        produtos: 2,
        amostra: 'p3, p4',
      });
      expect(texto).toContain('Na loja Conta A, 2 produto(s) estão sem envio de preço');
      expect(texto).toContain('Os primeiros: p3, p4.');
      expect(texto).toContain(frase);
      for (const [outro, fraseDoOutro] of FRASE_DO_MOTIVO) {
        if (outro !== motivo) expect(texto, outro).not.toContain(fraseDoOutro);
      }
      expect(texto).not.toContain('undefined');
    },
  );

  it('an unknown or inherited Parado code falls back', () => {
    for (const motivo of ['outro-motivo', 'toString', '']) {
      expect(
        corpo(TIPO_AVISO.lojaIntegradaPrecoParado, { loja: 'Conta A', motivo, produtos: 1 }),
        motivo,
      ).toContain('confira os preços desses produtos no ERP e na loja');
    }
  });
});
