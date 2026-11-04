import { describe, expect, it } from 'vitest';

import { detalheLinhaPreco } from './detalheLinhaPreco';
import type { PricePushRow } from './types';

const row = (over: Partial<PricePushRow> = {}): PricePushRow => ({
  key: 'p1:c1:A1',
  produtoId: 'p1',
  produtoNome: 'Camiseta',
  integracaoId: 'c1',
  integracaoNome: 'Loja',
  anuncioId: 'A1',
  linkDocId: 'l1',
  outcome: 'enviado',
  motivo: null,
  mensagem: 'Preço atualizado de 40 para 50.',
  preco: 50,
  precoAnterior: 40,
  ...over,
});

describe('detalheLinhaPreco (E5)', () => {
  describe('a Mercado Livre row (no `variacao`) renders exactly as before the extraction', () => {
    it('a success adds nothing — the backend sentence already carries old→new', () => {
      expect(detalheLinhaPreco(row())).toBeNull();
    });

    it('a row that did NOT change shows the listing price', () => {
      expect(detalheLinhaPreco(row({ outcome: 'pulado', preco: null }))).toBe(' · anúncio a 40');
      expect(detalheLinhaPreco(row({ outcome: 'falha' }))).toBe(' · anúncio a 40');
    });

    it('…but not when the run never read it', () => {
      expect(detalheLinhaPreco(row({ outcome: 'falha', precoAnterior: null }))).toBeNull();
    });
  });

  describe('a per-model row names its variation first', () => {
    it('on a success', () => {
      expect(detalheLinhaPreco(row({ variacao: 'CAM-AZ-P' }))).toBe(' · CAM-AZ-P');
    });

    it('before the listing price on a row that did not change', () => {
      expect(detalheLinhaPreco(row({ variacao: 'CAM-AZ-P', outcome: 'pulado' }))).toBe(
        ' · CAM-AZ-P · anúncio a 40',
      );
    });

    it('NEAR MISS: a null or empty label prints nothing — never "null", never a bare " · "', () => {
      expect(detalheLinhaPreco(row({ variacao: null }))).toBeNull();
      expect(detalheLinhaPreco(row({ variacao: '' }))).toBeNull();
      expect(detalheLinhaPreco(row({ variacao: null, outcome: 'pulado' }))).toBe(' · anúncio a 40');
    });
  });
});
