import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ATRASOS_REVERIFICACAO_S,
  ATRASOS_SERPRO_REENVIO_S,
  ATRASO_SERPRO_S,
  EXCERTO_SHOPEE_MAX,
  NFE_SHOPEE_MAX_PAUSAS,
  NFE_SHOPEE_MAX_TENTATIVAS,
  SHOPEE_NFE_DETALHE_CAMPOS,
  SHOPEE_NFE_UPLOAD_QUEUE,
  atrasoSerproS,
} from './constantesNfe';

/** This module's raw TEXT — one property below is measured on it. */
const FONTE = readFileSync(fileURLToPath(new URL('./constantesNfe.ts', import.meta.url)), 'utf8');

/** A fixed clock: every case below is relative to it, never to the machine's. */
const AGORA_MS = 1_790_000_000_000;

describe('as constantes do passo 14', () => {
  it('1 — os valores da reconciliação §2.4, literais', () => {
    expect(SHOPEE_NFE_UPLOAD_QUEUE).toBe('processShopeeNfeUpload');
    expect(NFE_SHOPEE_MAX_TENTATIVAS).toBe(4);
    expect(ATRASO_SERPRO_S).toBe(360);
    expect(ATRASOS_SERPRO_REENVIO_S).toEqual([600, 1800, 3600]);
    expect(ATRASOS_REVERIFICACAO_S).toEqual([900, 1800]);
    expect(NFE_SHOPEE_MAX_PAUSAS).toBe(6);
    expect(SHOPEE_NFE_DETALHE_CAMPOS).toEqual([
      'invoice_data',
      'fulfillment_flag',
      'international_label',
    ]);
    expect(EXCERTO_SHOPEE_MAX).toBe(160);
  });

  it('2 — ⛔ a espera do SERPRO nunca fica abaixo de 300 s (o emulador ignora o atraso)', () => {
    // O guia pede ~5 min depois da criação da NF-e. O emulador de tasks IGNORA
    // `scheduleDelaySeconds`, então nenhuma volta completa pegaria um disparo
    // cedo demais: este pino é a única guarda.
    expect(ATRASO_SERPRO_S).toBeGreaterThanOrEqual(300);
  });

  it('3 — as escadas crescem, e o reenvio chega a ~1h40 depois da primeira tentativa', () => {
    for (const escada of [ATRASOS_SERPRO_REENVIO_S, ATRASOS_REVERIFICACAO_S]) {
      for (let i = 1; i < escada.length; i += 1) {
        expect(escada[i]).toBeGreaterThan(escada[i - 1] ?? 0);
      }
    }
    expect(ATRASOS_SERPRO_REENVIO_S.reduce((a, b) => a + b, 0)).toBe(100 * 60);
  });

  it('4 — ⛔ o campo do pedido de leitura não pede comprador, endereço, item nem pagamento', () => {
    // A lista SUBSTITUI a padrão do pacote: o que não está aqui não trafega.
    const proibidos = ['buyer', 'recipient', 'address', 'item_list', 'payment', 'pay_time'];
    for (const campo of SHOPEE_NFE_DETALHE_CAMPOS) {
      for (const p of proibidos) expect(campo.includes(p)).toBe(false);
    }
  });

  it('5 — ⛔ o teto de BYTES do upload não tem cópia aqui (é constante do pacote)', () => {
    expect(FONTE).not.toMatch(/1024\s*\*\s*1024|1_048_576|1048576/);
    expect(FONTE).not.toMatch(/MAX_BYTES/);
  });
});

describe('atrasoSerproS — ms entram, segundos saem', () => {
  it('6 — `null` espera a janela INTEIRA', () => {
    expect(atrasoSerproS(null, AGORA_MS)).toBe(ATRASO_SERPRO_S);
  });

  it('7 — ⛔ uma autorização no FUTURO (relógios desalinhados) espera a janela inteira, nunca mais', () => {
    expect(atrasoSerproS(AGORA_MS + 60_000, AGORA_MS)).toBe(ATRASO_SERPRO_S);
    expect(atrasoSerproS(AGORA_MS + 86_400_000, AGORA_MS)).toBe(ATRASO_SERPRO_S);
  });

  it('8 — PAR: uma NF-e fresca espera só o RESTANTE — 100 000 ms depois ⇒ 260 s', () => {
    // A leitura de unidade: 100 000 ms são 100 s. Uma mistura (ms tratados
    // como s) daria 0 aqui, e segundos tratados como ms dariam 360.
    expect(atrasoSerproS(AGORA_MS - 100_000, AGORA_MS)).toBe(260);
    expect(atrasoSerproS(AGORA_MS, AGORA_MS)).toBe(ATRASO_SERPRO_S);
  });

  it('9 — ⛔ NEAR-MISS: uma fração de segundo restante arredonda para CIMA (nunca dispara antes)', () => {
    expect(atrasoSerproS(AGORA_MS - 100_500, AGORA_MS)).toBe(260);
    expect(atrasoSerproS(AGORA_MS - 359_001, AGORA_MS)).toBe(1);
    expect(atrasoSerproS(AGORA_MS - 360_000, AGORA_MS)).toBe(0);
  });

  it('10 — uma NF-e antiga espera 0 (um reenvio de ontem não espera seis minutos)', () => {
    expect(atrasoSerproS(AGORA_MS - 3_600_000, AGORA_MS)).toBe(0);
    expect(atrasoSerproS(AGORA_MS - 86_400_000, AGORA_MS)).toBe(0);
  });

  it('11 — ⛔ um valor não finito espera a janela inteira — o lado seguro é esperar', () => {
    expect(atrasoSerproS(Number.NaN, AGORA_MS)).toBe(ATRASO_SERPRO_S);
    expect(atrasoSerproS(AGORA_MS, Number.NaN)).toBe(ATRASO_SERPRO_S);
    expect(atrasoSerproS(Number.POSITIVE_INFINITY, AGORA_MS)).toBe(ATRASO_SERPRO_S);
  });

  it('12 — o resultado é sempre um inteiro em [0, ATRASO_SERPRO_S]', () => {
    for (const decorrido of [-1e9, -1, 0, 1, 999, 1_001, 123_456, 359_999, 360_001, 1e12]) {
      const s = atrasoSerproS(AGORA_MS - decorrido, AGORA_MS);
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(ATRASO_SERPRO_S);
    }
  });
});
