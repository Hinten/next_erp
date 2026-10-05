import { describe, expect, it } from 'vitest';

import {
  EIXOS_PACOTE_SHOPEE,
  EIXOS_PACOTE_SHOPEE_INVERSO,
  type EixoDePacoteProduto,
} from './eixos';

/**
 * As quatro asserções que impedem a transposição do legado de voltar.
 *
 * ⚠️ Os dois sentidos são conferidos SEPARADAMENTE e o direto é escrito campo a
 * campo, nunca derivado do próprio mapa: um teste que percorre o objeto para
 * conferir o objeto passa com qualquer mapa, inclusive o transposto.
 */
describe('EIXOS_PACOTE_SHOPEE', () => {
  it('mapeia package_width para larguraCm e package_length para profundidadeCm', () => {
    expect(EIXOS_PACOTE_SHOPEE.package_height).toBe('alturaCm');
    expect(EIXOS_PACOTE_SHOPEE.package_width).toBe('larguraCm');
    expect(EIXOS_PACOTE_SHOPEE.package_length).toBe('profundidadeCm');
  });

  it('o inverso devolve o campo de wire original para cada um dos três eixos', () => {
    for (const [wire, erp] of Object.entries(EIXOS_PACOTE_SHOPEE)) {
      expect(EIXOS_PACOTE_SHOPEE_INVERSO[erp]).toBe(wire);
    }
    // E explicitamente, para que o laço acima não seja a única prova.
    expect(EIXOS_PACOTE_SHOPEE_INVERSO.larguraCm).toBe('package_width');
    expect(EIXOS_PACOTE_SHOPEE_INVERSO.profundidadeCm).toBe('package_length');
    expect(EIXOS_PACOTE_SHOPEE_INVERSO.alturaCm).toBe('package_height');
  });

  it('⛔ NEAR-MISS: larguraCm NÃO mapeia para package_length', () => {
    // A transposição EXATA do exportador legado: `larguraCm → package_length` e
    // `profundidadeCm → package_width`. Ela é simétrica, então um round trip
    // legado parecia consistente enquanto trocava duas medidas do pacote.
    expect(EIXOS_PACOTE_SHOPEE_INVERSO.larguraCm).not.toBe('package_length');
    expect(EIXOS_PACOTE_SHOPEE_INVERSO.profundidadeCm).not.toBe('package_width');
    expect(EIXOS_PACOTE_SHOPEE.package_width).not.toBe('profundidadeCm');
    expect(EIXOS_PACOTE_SHOPEE.package_length).not.toBe('larguraCm');
  });

  it('os três nomes de campo ERP são distintos — o mapa é uma bijeção', () => {
    const erp = Object.values(EIXOS_PACOTE_SHOPEE) as EixoDePacoteProduto[];
    expect(erp).toHaveLength(3);
    expect(new Set(erp).size).toBe(3);
    // E o inverso não perdeu nenhuma entrada no caminho: dois eixos de wire
    // caindo no mesmo campo do produto apagariam uma medida em silêncio.
    expect(Object.keys(EIXOS_PACOTE_SHOPEE_INVERSO)).toHaveLength(3);
  });
});
