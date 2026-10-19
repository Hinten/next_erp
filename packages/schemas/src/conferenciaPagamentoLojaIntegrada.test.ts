/**
 * The paid re-check's pure half (master plan step 15, #1825): the verdict of a codigo, the wire
 * contract, the situação labels, the conta of a pedido and the order-id preimage. Every fold is
 * tested from both sides — a pair that must come out equal and a near-miss that must stay
 * distinct.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FONTE_CONFERENCIA_PAGAMENTO_LI,
  MOTIVO_CONFERENCIA_NAO_APLICAVEL_LI,
  ROTULO_SITUACAO_LI,
  VEREDITO_PAGAMENTO_LI,
  contaIdDoPedidoLi,
  fonteConferenciaPagamentoLiSchema,
  preimagemPedidoLi,
  respostaConferenciaPagamentoLiSchema,
  rotuloSituacaoLi,
  veredictoDoCodigoLi,
  vereditoPagamentoLiSchema,
} from './conferenciaPagamentoLojaIntegrada';
import { MOTIVO_PEDIDO_CONTESTADO_LI } from './aviso';
import {
  CODIGOS_LI_PAGO,
  CODIGO_SITUACAO_LI,
  codigoSituacaoLiSchema,
} from './situacaoPedidoLojaIntegrada';
import * as barrel from './index';

/** An independent sha256, so a vector is never checked against a helper it pins. */
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/* -------------------------------------------------------------------------- */
/*                              veredictoDoCodigoLi                           */
/* -------------------------------------------------------------------------- */

describe('veredictoDoCodigoLi — by the codigo alone', () => {
  it('all 16 codigos: `pago` exactly for CODIGOS_LI_PAGO, `nao-pago` for every other one', () => {
    expect(codigoSituacaoLiSchema.options).toHaveLength(16);
    for (const codigo of codigoSituacaoLiSchema.options) {
      expect(veredictoDoCodigoLi(codigo), codigo).toBe(
        CODIGOS_LI_PAGO.has(codigo) ? VEREDITO_PAGAMENTO_LI.pago : VEREDITO_PAGAMENTO_LI.naoPago,
      );
    }
    expect(CODIGOS_LI_PAGO.size).toBe(7);
  });

  it('the contested and reversal codigos are NOT paid — the flags that call them "aprovado" are never read', () => {
    for (const codigo of [
      CODIGO_SITUACAO_LI.pagamentoEmDisputa, // 6
      CODIGO_SITUACAO_LI.pagamentoDevolvido, // 7
      CODIGO_SITUACAO_LI.pedidoCancelado, // 8
      CODIGO_SITUACAO_LI.pedidoChargeback, // 16
      CODIGO_SITUACAO_LI.cancelamentoSolicitado, // 1019
      CODIGO_SITUACAO_LI.pagamentoDevolvidoSemRetorno, // 1020
    ]) {
      expect(veredictoDoCodigoLi(codigo), codigo).toBe(VEREDITO_PAGAMENTO_LI.naoPago);
    }
  });

  it("⚠️ NEAR-MISS: `'Pedido_Pago'`, `'pedido_pago '`, `'toString'` and `''` ⇒ `desconhecido`, never `pago`", () => {
    for (const codigo of [
      'Pedido_Pago',
      'pedido_pago ',
      ' pedido_pago',
      'toString',
      '__proto__',
      '',
    ]) {
      expect(veredictoDoCodigoLi(codigo), codigo).toBe(VEREDITO_PAGAMENTO_LI.desconhecido);
    }
  });

  it('a non-string codigo is `desconhecido`; the verdict is never `contestado` (the mirror’s alone)', () => {
    for (const codigo of [null, undefined, 4, { codigo: 'pedido_pago' }]) {
      expect(veredictoDoCodigoLi(codigo), String(codigo)).toBe(VEREDITO_PAGAMENTO_LI.desconhecido);
    }
    const todos = [...codigoSituacaoLiSchema.options, 'x'].map(veredictoDoCodigoLi);
    expect(todos).not.toContain(VEREDITO_PAGAMENTO_LI.contestado);
  });
});

/* -------------------------------------------------------------------------- */
/*                              the situação labels                           */
/* -------------------------------------------------------------------------- */

describe('ROTULO_SITUACAO_LI + rotuloSituacaoLi', () => {
  it('labels every codigo with a distinct, non-empty pt-BR text', () => {
    expect(Object.keys(ROTULO_SITUACAO_LI).sort()).toEqual(
      [...codigoSituacaoLiSchema.options].sort(),
    );
    const rotulos = Object.values(ROTULO_SITUACAO_LI);
    for (const r of rotulos) expect(r.trim().length).toBeGreaterThan(0);
    expect(new Set(rotulos).size).toBe(rotulos.length);
  });

  it('reads a wire codigo exactly and prototype-safely', () => {
    expect(rotuloSituacaoLi('pagamento_em_disputa')).toBe('Pagamento em disputa');
    for (const codigo of ['Pagamento_Em_Disputa', 'toString', '__proto__', '', null, 6]) {
      expect(rotuloSituacaoLi(codigo), String(codigo)).toBeNull();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                       contaIdDoPedidoLi + preimagemPedidoLi                */
/* -------------------------------------------------------------------------- */

describe('contaIdDoPedidoLi — the conta of an imported pedido', () => {
  it('EQUAL pair: `integracao/c` ≡ `documents/integracao/c` → `c`', () => {
    expect(contaIdDoPedidoLi('integracao/c')).toBe('c');
    expect(contaIdDoPedidoLi('documents/integracao/c')).toBe('c');
  });

  it('⚠️ NEAR-MISS: another id is another conta; another collection or a sub-path names none', () => {
    expect(contaIdDoPedidoLi('integracao/c2')).toBe('c2');
    for (const ref of [
      'int_frete/c',
      'documents/integracoes/c',
      'integracao/c/sub/x',
      'integracao',
      '',
      null,
      undefined,
      5,
    ]) {
      expect(contaIdDoPedidoLi(ref), String(ref)).toBeNull();
    }
  });
});

describe('preimagemPedidoLi — the deterministic pedido id’s preimage', () => {
  it("pins the master plan's vector: ('CONTA1', '165') ⇒ `lojaIntegradaCONTA1-165`, whose digest is the corpus id", () => {
    expect(preimagemPedidoLi('CONTA1', '165')).toBe('lojaIntegradaCONTA1-165');
    expect(sha256(preimagemPedidoLi('CONTA1', '165') ?? '')).toBe(
      '60fe37ac35667bf3d56a8cb3a015114133ce02dad6d7338ac5db4f421413e532',
    );
  });

  it('EQUAL pair: a numeric numero and its decimal string give the SAME preimage', () => {
    expect(preimagemPedidoLi('CONTA1', 165)).toBe(preimagemPedidoLi('CONTA1', '165'));
  });

  it("⚠️ NEAR-MISS: `'0165'`, `'165.0'`, `null`, `0` give NO preimage — never a second id for one order", () => {
    for (const numero of ['0165', '165.0', ' 165', null, undefined, 0, -165, 165.5, '']) {
      expect(preimagemPedidoLi('CONTA1', numero), String(numero)).toBeNull();
    }
  });

  it('a conta that is not a usable document id gives no preimage', () => {
    for (const conta of ['', 'integracao/CONTA1', '.', '..', null, 1]) {
      expect(preimagemPedidoLi(conta, '165'), String(conta)).toBeNull();
    }
  });

  it('⚠️ NEAR-MISS: the other channels’ spellings, another conta and another numero stay DISTINCT', () => {
    const id = sha256(preimagemPedidoLi('CONTA1', '165') ?? '');
    expect(id).not.toBe(sha256('CONTA1-165')); // the Shopee spelling
    expect(id).not.toBe(sha256('lojaIntegrada/CONTA1-165'));
    expect(id).not.toBe(sha256('documents/integracao/CONTA1-165'));
    expect(preimagemPedidoLi('CONTA2', '165')).not.toBe(preimagemPedidoLi('CONTA1', '165'));
    expect(preimagemPedidoLi('CONTA1', '1650')).not.toBe(preimagemPedidoLi('CONTA1', '165'));
  });
});

/* -------------------------------------------------------------------------- */
/*                      respostaConferenciaPagamentoLiSchema                  */
/* -------------------------------------------------------------------------- */

describe('respostaConferenciaPagamentoLiSchema — the wire contract', () => {
  const VIVA = {
    aplicavel: true,
    veredito: VEREDITO_PAGAMENTO_LI.naoPago,
    codigo: CODIGO_SITUACAO_LI.pagamentoEmDisputa,
    fonte: FONTE_CONFERENCIA_PAGAMENTO_LI.loja,
    motivoContestacao: MOTIVO_PEDIDO_CONTESTADO_LI.disputa,
    conferidoEmMs: 1_760_000_000_000,
    correlationId: 'corr-1',
  } as const;
  const ESPELHO = {
    aplicavel: true,
    veredito: VEREDITO_PAGAMENTO_LI.contestado,
    codigo: null,
    fonte: FONTE_CONFERENCIA_PAGAMENTO_LI.erp,
    motivoContestacao: MOTIVO_PEDIDO_CONTESTADO_LI.chargeback,
    conferidoEmMs: null,
    correlationId: null,
  } as const;

  it('parses a live answer and an ERP-mirror answer', () => {
    expect(respostaConferenciaPagamentoLiSchema.parse(VIVA)).toEqual(VIVA);
    expect(respostaConferenciaPagamentoLiSchema.parse(ESPELHO)).toEqual(ESPELHO);
  });

  it('parses `aplicavel: false` with its motivo — including one a newer backend adds', () => {
    for (const motivo of [MOTIVO_CONFERENCIA_NAO_APLICAVEL_LI.naoImportado, 'motivo-novo']) {
      expect(respostaConferenciaPagamentoLiSchema.parse({ aplicavel: false, motivo })).toEqual({
        aplicavel: false,
        motivo,
      });
    }
  });

  it('⭐ strips anything else — nothing from the order body (personal data) rides along', () => {
    const resposta = respostaConferenciaPagamentoLiSchema.parse({
      ...VIVA,
      cliente: { nome: 'REDACTED', cpf: 'REDACTED' },
      endereco_entrega: { logradouro: 'REDACTED' },
    });
    expect(Object.keys(resposta).sort()).toEqual(Object.keys(VIVA).sort());
  });

  it('refuses an unknown verdict, an unknown fonte and a missing `aplicavel`', () => {
    expect(
      respostaConferenciaPagamentoLiSchema.safeParse({ ...VIVA, veredito: 'talvez' }).success,
    ).toBe(false);
    expect(
      respostaConferenciaPagamentoLiSchema.safeParse({ ...VIVA, fonte: 'cache' }).success,
    ).toBe(false);
    const { aplicavel: _aplicavel, ...semAplicavel } = VIVA;
    expect(respostaConferenciaPagamentoLiSchema.safeParse(semAplicavel).success).toBe(false);
  });
});

describe('the companions', () => {
  it('VEREDITO_PAGAMENTO_LI and FONTE_CONFERENCIA_PAGAMENTO_LI name every member, once', () => {
    expect(Object.values(VEREDITO_PAGAMENTO_LI).sort()).toEqual(
      [...vereditoPagamentoLiSchema.options].sort(),
    );
    expect(Object.values(FONTE_CONFERENCIA_PAGAMENTO_LI).sort()).toEqual(
      [...fonteConferenciaPagamentoLiSchema.options].sort(),
    );
  });
});

describe('barrel', () => {
  it('exports the contract and the readers', () => {
    expect(barrel.respostaConferenciaPagamentoLiSchema).toBe(respostaConferenciaPagamentoLiSchema);
    expect(barrel.veredictoDoCodigoLi).toBe(veredictoDoCodigoLi);
    expect(barrel.preimagemPedidoLi).toBe(preimagemPedidoLi);
    expect(barrel.contaIdDoPedidoLi).toBe(contaIdDoPedidoLi);
    expect(barrel.ROTULO_SITUACAO_LI).toBe(ROTULO_SITUACAO_LI);
  });
});
