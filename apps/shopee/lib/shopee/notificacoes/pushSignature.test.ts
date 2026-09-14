import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';

import {
  ShopeePushConfigError,
  expectedPushSignature,
  pushBaseString,
  verifyShopeePushSignature,
} from './pushSignature';

/** Inventado — nunca uma credencial real. */
const CHAVE = 'chave-de-teste-nao-e-credencial';

/**
 * O vetor do `guide 18`: a URL e o corpo do exemplo da própria Shopee, com a
 * nossa chave de teste. O digest abaixo é o valor computado uma vez e fixado —
 * é ele que prova que a base string é `url + '|' + corpo` e não qualquer outra
 * concatenação (a assinatura de REQUISIÇÃO, por contraste, não tem separador).
 */
const URL_GUIA = 'http://www.example.com/example/uri';
const CORPO_GUIA =
  '{"shop_id": 123, "code": 1, "success": 1, "extra": "shop_id 123 is authorized successfully", "data": {"more_info": "more info"}, "timestamp": 1470198856}';
const DIGEST_GUIA = '501aac61724c5ebfcbf8759d47a4e155ad45f4e1f766e5407a2a9c05ac76c950';

const config = { partnerKey: CHAVE, callbackUrl: URL_GUIA };

describe('pushBaseString', () => {
  it('junta URL e corpo com o pipe do guide 18', () => {
    expect(pushBaseString('https://erp.example/api/webhooks/shopee', '{"code":1}')).toBe(
      'https://erp.example/api/webhooks/shopee|{"code":1}',
    );
  });

  // NEAR-MISS da regra: a assinatura de REQUISIÇÃO concatena sem separador
  // nenhum (`sign.ts`). Se alguém "unificar" as duas, este par diverge.
  it('não é a concatenação sem separador da assinatura de requisição', () => {
    const comPipe = pushBaseString(URL_GUIA, CORPO_GUIA);
    expect(comPipe).not.toBe(`${URL_GUIA}${CORPO_GUIA}`);
    expect(expectedPushSignature(CORPO_GUIA, config)).not.toBe(
      createHmac('sha256', CHAVE).update(`${URL_GUIA}${CORPO_GUIA}`, 'utf8').digest('hex'),
    );
  });
});

describe('verifyShopeePushSignature — o vetor do guide 18', () => {
  it('aceita o digest hex minúsculo do exemplo da Shopee', () => {
    expect(expectedPushSignature(CORPO_GUIA, config)).toBe(DIGEST_GUIA);
    expect(verifyShopeePushSignature(CORPO_GUIA, DIGEST_GUIA, config)).toBe(true);
  });

  it('aceita o mesmo digest em MAIÚSCULAS (tolerância nossa: os demos da Shopee comparam verbatim)', () => {
    expect(verifyShopeePushSignature(CORPO_GUIA, DIGEST_GUIA.toUpperCase(), config)).toBe(true);
  });

  it('aceita o digest com espaços em volta', () => {
    expect(verifyShopeePushSignature(CORPO_GUIA, `  ${DIGEST_GUIA}  `, config)).toBe(true);
  });

  // NEAR-MISS: o header da Shopee é o hex NU. O esquema `sha256=` é do Meta, e
  // aceitá-lo seria aceitar um valor sob uma regra que a Shopee não aplica.
  it('REJEITA o mesmo digest prefixado com "sha256=" (esquema do Meta)', () => {
    expect(verifyShopeePushSignature(CORPO_GUIA, `sha256=${DIGEST_GUIA}`, config)).toBe(false);
  });

  it('rejeita header ausente', () => {
    expect(verifyShopeePushSignature(CORPO_GUIA, null, config)).toBe(false);
  });

  it('rejeita um digest de outro corpo', () => {
    expect(verifyShopeePushSignature('{"code":2}', DIGEST_GUIA, config)).toBe(false);
  });

  // `timingSafeEqual` LANÇA quando os comprimentos diferem — a checagem de
  // comprimento é o que transforma isso num `false` em vez de num 500.
  it('devolve false SEM lançar para headers de 63 e 65 caracteres', () => {
    const curto = DIGEST_GUIA.slice(0, 63);
    const longo = `${DIGEST_GUIA}0`;
    expect(curto).toHaveLength(63);
    expect(longo).toHaveLength(65);
    expect(() => verifyShopeePushSignature(CORPO_GUIA, curto, config)).not.toThrow();
    expect(verifyShopeePushSignature(CORPO_GUIA, curto, config)).toBe(false);
    expect(() => verifyShopeePushSignature(CORPO_GUIA, longo, config)).not.toThrow();
    expect(verifyShopeePushSignature(CORPO_GUIA, longo, config)).toBe(false);
  });

  // Hex inválido não pode virar buffer vazio e casar com qualquer coisa.
  it('devolve false SEM lançar para um header não-hex do tamanho certo', () => {
    const naoHex = 'z'.repeat(64);
    expect(() => verifyShopeePushSignature(CORPO_GUIA, naoHex, config)).not.toThrow();
    expect(verifyShopeePushSignature(CORPO_GUIA, naoHex, config)).toBe(false);
  });
});

describe('a URL entra byte a byte', () => {
  // Se `env.ts` passar a remover a barra final, este par de digests colapsa e o
  // teste fica vermelho — é essa a razão de o reader NÃO normalizar.
  it('uma barra final muda o digest', () => {
    const semBarra = expectedPushSignature(CORPO_GUIA, {
      partnerKey: CHAVE,
      callbackUrl: 'https://erp.example/api/webhooks/shopee',
    });
    const comBarra = expectedPushSignature(CORPO_GUIA, {
      partnerKey: CHAVE,
      callbackUrl: 'https://erp.example/api/webhooks/shopee/',
    });
    expect(semBarra).not.toBe(comBarra);
  });

  it('o esquema muda o digest', () => {
    const http = expectedPushSignature(CORPO_GUIA, {
      partnerKey: CHAVE,
      callbackUrl: 'http://erp.example/api/webhooks/shopee',
    });
    const https = expectedPushSignature(CORPO_GUIA, {
      partnerKey: CHAVE,
      callbackUrl: 'https://erp.example/api/webhooks/shopee',
    });
    expect(http).not.toBe(https);
  });
});

describe('configuração ausente falha FECHADO', () => {
  it('lança nomeando SHOPEE_PARTNER_KEY quando a chave está ausente', () => {
    expect(() =>
      verifyShopeePushSignature(CORPO_GUIA, DIGEST_GUIA, {
        partnerKey: null,
        callbackUrl: URL_GUIA,
      }),
    ).toThrow(ShopeePushConfigError);
    try {
      verifyShopeePushSignature(CORPO_GUIA, DIGEST_GUIA, {
        partnerKey: null,
        callbackUrl: URL_GUIA,
      });
    } catch (err) {
      if (!(err instanceof ShopeePushConfigError)) throw err;
      expect(err.variavel).toBe('SHOPEE_PARTNER_KEY');
      expect(err.message).toContain('SHOPEE_PARTNER_KEY');
    }
  });

  it('lança nomeando SHOPEE_PUSH_CALLBACK_URL quando a URL está ausente', () => {
    try {
      verifyShopeePushSignature(CORPO_GUIA, DIGEST_GUIA, {
        partnerKey: CHAVE,
        callbackUrl: null,
      });
      expect.unreachable('deveria ter lançado');
    } catch (err) {
      if (!(err instanceof ShopeePushConfigError)) throw err;
      expect(err.variavel).toBe('SHOPEE_PUSH_CALLBACK_URL');
    }
  });

  // A mensagem não pode carregar a chave — ela É o segredo do HMAC.
  it('a mensagem do erro nunca contém o valor da chave', () => {
    try {
      verifyShopeePushSignature(CORPO_GUIA, DIGEST_GUIA, {
        partnerKey: null,
        callbackUrl: URL_GUIA,
      });
    } catch (err) {
      if (!(err instanceof ShopeePushConfigError)) throw err;
      expect(err.message).not.toContain(CHAVE);
    }
  });

  // A config vem ANTES do header: um backend não configurado responde 503 mesmo
  // quando o push chegou sem header nenhum.
  it('lança mesmo com header nulo (503 vence 401)', () => {
    expect(() =>
      verifyShopeePushSignature(CORPO_GUIA, null, { partnerKey: null, callbackUrl: URL_GUIA }),
    ).toThrow(ShopeePushConfigError);
  });
});
