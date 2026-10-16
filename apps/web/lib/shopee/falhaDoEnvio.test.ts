import { describe, expect, it } from 'vitest';

import {
  ShopeeClientHttpError,
  ShopeeClientNetworkError,
  ShopeeClientRespostaInvalidaError,
} from './client';
import { CODIGO_FALHA_SHOPEE } from './erros';
import { classificarFalhaDoEnvioShopee } from './falhaDoEnvio';
import { DETALHES_ERRO_SHOPEE_VAZIOS, type DetalhesErroShopee } from './wire';

/** An HTTP failure as the client builds it, with only the `detalhes` the case needs. */
function erroHttp(
  mensagem: string,
  status: number,
  code: string | null,
  detalhes: Partial<DetalhesErroShopee> = {},
): ShopeeClientHttpError {
  return new ShopeeClientHttpError(mensagem, status, code, null, null, {
    ...DETALHES_ERRO_SHOPEE_VAZIOS,
    ...detalhes,
  });
}

function abortado(): AbortSignal {
  const c = new AbortController();
  c.abort();
  return c.signal;
}

const MENSAGEM_PAUSA = 'A conta atingiu a cota diária da Shopee.';

describe('classificarFalhaDoEnvioShopee', () => {
  describe('F1 — a quota pause is "not attempted", with WHEN it ends in São Paulo time', () => {
    it('reads the pause as nao-tentado, keeps the instant, and says it', () => {
      const f = classificarFalhaDoEnvioShopee(
        erroHttp(MENSAGEM_PAUSA, 409, CODIGO_FALHA_SHOPEE.contaPausada, {
          pausadoAte: '2026-10-14T18:30:00Z',
        }),
        undefined,
      );
      expect(f).toMatchObject({
        tipo: 'conta',
        outcome: 'nao-tentado',
        motivo: 'conta-pausada',
        pausadoAte: '2026-10-14T18:30:00Z',
      });
      const mensagem = f?.tipo === 'conta' ? f.mensagem : '';
      // The backend's sentence first, untouched — then the suffix.
      expect(mensagem.startsWith(`${MENSAGEM_PAUSA} A pausa vence em `)).toBe(true);
      expect(mensagem).toContain('14/10/2026');
      // ⚠️ NEAR MISS: 18:30 is the UTC wall clock, and the runner's own zone
      // would be a third answer. São Paulo (UTC-3) is the only right one.
      expect(mensagem).toMatch(/15:30\.$/);
      expect(mensagem).not.toContain('18:30');
    });

    it('formats the São Paulo CIVIL day, not the UTC one (NEAR MISS across midnight)', () => {
      const f = classificarFalhaDoEnvioShopee(
        erroHttp(MENSAGEM_PAUSA, 409, CODIGO_FALHA_SHOPEE.contaPausada, {
          pausadoAte: '2026-10-15T02:30:00Z',
        }),
        undefined,
      );
      const mensagem = f?.tipo === 'conta' ? f.mensagem : '';
      expect(mensagem).toContain('14/10/2026');
      expect(mensagem).toMatch(/23:30\.$/);
      expect(mensagem).not.toContain('15/10/2026');
    });

    it.each([
      ['absent', null],
      ['unreadable', 'amanhã'],
    ])('a pause with an %s instant keeps the sentence alone, never a broken date', (_c, iso) => {
      const f = classificarFalhaDoEnvioShopee(
        erroHttp(MENSAGEM_PAUSA, 409, CODIGO_FALHA_SHOPEE.contaPausada, { pausadoAte: iso }),
        undefined,
      );
      expect(f).toEqual({
        tipo: 'conta',
        outcome: 'nao-tentado',
        motivo: 'conta-pausada',
        mensagem: MENSAGEM_PAUSA,
        pausadoAte: iso,
      });
    });

    it('NEAR MISS: a pausadoAte on ANOTHER code is not a pause', () => {
      const f = classificarFalhaDoEnvioShopee(
        erroHttp('Seleção grande demais.', 400, CODIGO_FALHA_SHOPEE.selecaoExcedeLimite, {
          pausadoAte: '2026-10-14T18:30:00Z',
        }),
        undefined,
      );
      expect(f).toMatchObject({ outcome: 'falha', pausadoAte: null });
    });

    // ⚠️ NEAR MISS on the SAME status: the stock, price and status routes also
    // answer 409 for a dead grant and for a conta with no shop id
    // (core/respond.ts), so the pause is keyed on the CODE, never on the 409.
    it.each([
      ['reautenticar', CODIGO_FALHA_SHOPEE.reautenticar, 'Reconecte a conta.'],
      ['contaSemShopId', CODIGO_FALHA_SHOPEE.contaSemShopId, 'A conta não tem loja vinculada.'],
    ])('NEAR MISS: a 409 %s is a failure carrying its code, not a pause', (_c, code, mensagem) => {
      const f = classificarFalhaDoEnvioShopee(
        erroHttp(mensagem, 409, code, { pausadoAte: '2026-10-14T18:30:00Z' }),
        undefined,
      );
      expect(f).toEqual({
        tipo: 'conta',
        outcome: 'falha',
        motivo: code,
        mensagem,
        pausadoAte: null,
      });
    });
  });

  describe('F2 — a conta refusal keeps the verdict slug and the backend sentence', () => {
    it('a 422 price verdict keeps its own motivo, not the code', () => {
      const f = classificarFalhaDoEnvioShopee(
        erroHttp('A loja não é do Brasil.', 422, CODIGO_FALHA_SHOPEE.precoContaRecusada, {
          motivo: 'regiao-nao-br',
          regiao: 'SG',
        }),
        undefined,
      );
      expect(f).toEqual({
        tipo: 'conta',
        outcome: 'falha',
        motivo: 'regiao-nao-br',
        mensagem: 'A loja não é do Brasil.',
        pausadoAte: null,
      });
    });

    it('a refusal with no motivo falls back to the code, then to erro-http', () => {
      expect(
        classificarFalhaDoEnvioShopee(
          erroHttp('Mais de 50 produtos.', 400, CODIGO_FALHA_SHOPEE.selecaoExcedeLimite),
          undefined,
        ),
      ).toMatchObject({ motivo: CODIGO_FALHA_SHOPEE.selecaoExcedeLimite });
      expect(
        classificarFalhaDoEnvioShopee(erroHttp('Falhou.', 500, null), undefined),
      ).toMatchObject({ motivo: 'erro-http', mensagem: 'Falhou.' });
    });

    it('an HTTP refusal that lands while aborted is still the refusal, not a cancel', () => {
      // The server answered before the cancel took effect: what it said is real.
      const f = classificarFalhaDoEnvioShopee(
        erroHttp('Conta sem depósito.', 400, CODIGO_FALHA_SHOPEE.contaSemDeposito),
        abortado(),
      );
      expect(f).toMatchObject({ tipo: 'conta', outcome: 'falha' });
    });
  });

  describe('F3 — a network failure is a cancel ONLY when the operator cancelled', () => {
    it('in-flight abort (NetworkError wrapping the AbortError) + aborted ⇒ cancelado', () => {
      const err = new ShopeeClientNetworkError(
        'aborted',
        new DOMException('The operation was aborted.', 'AbortError'),
      );
      expect(classificarFalhaDoEnvioShopee(err, abortado())).toEqual({ tipo: 'cancelado' });
    });

    it('NEAR MISS: the same NetworkError with nobody cancelling ⇒ rede', () => {
      const err = new ShopeeClientNetworkError('Failed to fetch');
      const vivo = new AbortController().signal;
      for (const signal of [vivo, undefined]) {
        expect(classificarFalhaDoEnvioShopee(err, signal)).toEqual({
          tipo: 'conta',
          outcome: 'falha',
          motivo: 'rede',
          mensagem: 'Não foi possível contatar o serviço da Shopee.',
          pausadoAte: null,
        });
      }
    });
  });

  describe('F4 — the abort itself, and anything foreign (rule 6)', () => {
    it('a body-read abort (the bare DOMException) + aborted ⇒ cancelado', () => {
      expect(
        classificarFalhaDoEnvioShopee(new DOMException('aborted', 'AbortError'), abortado()),
      ).toEqual({ tipo: 'cancelado' });
    });

    it('is not ours ⇒ null, so the caller rethrows', () => {
      expect(classificarFalhaDoEnvioShopee(new TypeError('boom'), undefined)).toBeNull();
      expect(classificarFalhaDoEnvioShopee(new Error('boom'), abortado())).toBeNull();
      // An AbortError nobody asked for is not a cancel either.
      expect(
        classificarFalhaDoEnvioShopee(new DOMException('aborted', 'AbortError'), undefined),
      ).toBeNull();
      expect(
        classificarFalhaDoEnvioShopee(new DOMException('x', 'NotFoundError'), abortado()),
      ).toBeNull();
    });
  });

  it('F5 — an unreadable 2xx (the RespostaInvalida subclass) reaches the HTTP arm', () => {
    const err = new ShopeeClientRespostaInvalidaError(
      'A Shopee respondeu num formato inesperado.',
      200,
      ['listings'],
    );
    expect(classificarFalhaDoEnvioShopee(err, undefined)).toEqual({
      tipo: 'conta',
      outcome: 'falha',
      motivo: CODIGO_FALHA_SHOPEE.respostaInvalida,
      mensagem: 'A Shopee respondeu num formato inesperado.',
      pausadoAte: null,
    });
  });
});
