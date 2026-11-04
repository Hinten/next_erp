import { describe, expect, it } from 'vitest';

import {
  ShopeeClientHttpError,
  ShopeeClientNetworkError,
  ShopeeClientRespostaInvalidaError,
} from '@/lib/shopee/client';
import { CODIGO_FALHA_SHOPEE } from '@/lib/shopee/erros';
import { DETALHES_ERRO_SHOPEE_VAZIOS, type DetalhesErroShopee } from '@/lib/shopee/wire';

import {
  ERROS_DO_CLIENTE_SHOPEE,
  descreverFalhaAoCancelarAtualizacaoPrecos,
  descreverFalhaAoCancelarImportacao,
  descreverFalhaAoIniciarAtualizacaoPrecos,
  descreverFalhaAoIniciarImportacao,
  jobIdDoJobEmAndamento,
} from './shopeeJobErrors';

/** A backend refusal as the client builds it — `detalhes` read from the same body. */
function http(
  status: number,
  code: string | null,
  message = 'mensagem do backend',
  detalhes: Partial<DetalhesErroShopee> = {},
  kind: string | null = null,
): ShopeeClientHttpError {
  return new ShopeeClientHttpError(message, status, code, null, kind, {
    ...DETALHES_ERRO_SHOPEE_VAZIOS,
    ...detalhes,
  });
}

describe('ERROS_DO_CLIENTE_SHOPEE', () => {
  it('names the two Shopee client classes and the [shopee] console tag', () => {
    expect(ERROS_DO_CLIENTE_SHOPEE.tagLog).toBe('[shopee]');
    expect(ERROS_DO_CLIENTE_SHOPEE.classes).toEqual([
      ShopeeClientHttpError,
      ShopeeClientNetworkError,
    ]);
  });
});

describe('jobIdDoJobEmAndamento', () => {
  it('reads the running job a busy start names', () => {
    const err = http(409, CODIGO_FALHA_SHOPEE.importacaoEmAndamento, 'x', { jobId: 'job-vivo' });
    expect(jobIdDoJobEmAndamento(err, CODIGO_FALHA_SHOPEE.importacaoEmAndamento)).toBe('job-vivo');
  });

  it('is null for an older backend whose 409 names no job', () => {
    const err = http(409, CODIGO_FALHA_SHOPEE.envioPrecoEmAndamento);
    expect(jobIdDoJobEmAndamento(err, CODIGO_FALHA_SHOPEE.envioPrecoEmAndamento)).toBeNull();
  });

  it('NEAR MISS — never attaches on the pause 409 or the cancel’s NOT_RUNNING, even with a jobId', () => {
    // `SHOPEE_PRICE_SYNC_NOT_RUNNING` is one word from `…_RUNNING` and means the
    // opposite; the pause is a 409 too. Neither may put a card on the rail.
    const pausa = http(409, CODIGO_FALHA_SHOPEE.contaPausada, 'x', { jobId: 'job-x' });
    const naoRodando = http(409, CODIGO_FALHA_SHOPEE.envioPrecoNaoEmAndamento, 'x', {
      jobId: 'job-x',
    });
    const importacaoNaoRodando = http(409, CODIGO_FALHA_SHOPEE.importacaoNaoEmAndamento, 'x', {
      jobId: 'job-x',
    });
    expect(jobIdDoJobEmAndamento(pausa, CODIGO_FALHA_SHOPEE.envioPrecoEmAndamento)).toBeNull();
    expect(jobIdDoJobEmAndamento(naoRodando, CODIGO_FALHA_SHOPEE.envioPrecoEmAndamento)).toBeNull();
    expect(
      jobIdDoJobEmAndamento(importacaoNaoRodando, CODIGO_FALHA_SHOPEE.importacaoEmAndamento),
    ).toBeNull();
  });

  it('NEAR MISS — the OTHER flow’s busy code does not attach', () => {
    const err = http(409, CODIGO_FALHA_SHOPEE.envioPrecoEmAndamento, 'x', { jobId: 'job-p' });
    expect(jobIdDoJobEmAndamento(err, CODIGO_FALHA_SHOPEE.importacaoEmAndamento)).toBeNull();
  });

  it('is null for anything that is not a Shopee HTTP failure', () => {
    expect(
      jobIdDoJobEmAndamento(
        new ShopeeClientNetworkError('x'),
        CODIGO_FALHA_SHOPEE.importacaoEmAndamento,
      ),
    ).toBeNull();
    expect(
      jobIdDoJobEmAndamento(new TypeError('x'), CODIGO_FALHA_SHOPEE.importacaoEmAndamento),
    ).toBeNull();
  });
});

describe('descreverFalhaAoIniciarImportacao', () => {
  it('a busy start WITHOUT a jobId is yellow and says the panel cannot follow it', () => {
    const err = http(
      409,
      CODIGO_FALHA_SHOPEE.importacaoEmAndamento,
      'Já existe uma importação em massa em andamento para esta conta.',
    );
    expect(descreverFalhaAoIniciarImportacao(err)).toEqual({
      color: 'yellow',
      message:
        'Já existe uma importação em massa em andamento para esta conta. Não foi possível identificar o job para acompanhá-lo daqui.',
    });
  });

  it('a busy start WITH a jobId never claims it could not be identified', () => {
    const err = http(409, CODIGO_FALHA_SHOPEE.importacaoEmAndamento, 'Já existe.', {
      jobId: 'job-vivo',
    });
    expect(descreverFalhaAoIniciarImportacao(err)).toEqual({
      color: 'yellow',
      message: 'Já existe.',
    });
  });

  it('a queue that would not take the first dispatch is red with the backend’s sentence', () => {
    const frase =
      'Não foi possível enfileirar o primeiro despacho da importação (MissingRegionError).';
    const err = http(503, CODIGO_FALHA_SHOPEE.importacaoNaoEnfileirada, frase);
    expect(descreverFalhaAoIniciarImportacao(err)).toEqual({ color: 'red', message: frase });
  });

  it('any other refusal goes through the shared Shopee copy', () => {
    expect(
      descreverFalhaAoIniciarImportacao(http(404, null, 'Conta Shopee não encontrada.')),
    ).toEqual({ color: 'red', message: 'Conta Shopee não encontrada.' });
    expect(
      descreverFalhaAoIniciarImportacao(http(409, CODIGO_FALHA_SHOPEE.reautenticar, 'x')),
    ).toEqual({ color: 'red', message: 'Reconecte a conta Shopee em Canais de venda.' });
  });

  it('a malformed 2xx (a subclass of the HTTP error) is red, never rethrown', () => {
    const err = new ShopeeClientRespostaInvalidaError('Resposta inválida do backend.', 202, [
      'jobId',
    ]);
    expect(descreverFalhaAoIniciarImportacao(err)).toEqual({
      color: 'red',
      message: 'Resposta inválida do backend.',
    });
  });

  it('a network failure gets this flow’s own copy', () => {
    expect(descreverFalhaAoIniciarImportacao(new ShopeeClientNetworkError('x'))).toEqual({
      color: 'red',
      message: 'Falha de rede ao iniciar a importação.',
    });
  });

  it('anything that is not a Shopee client failure is NOT ours — null, so the fan-out rethrows', () => {
    expect(descreverFalhaAoIniciarImportacao(new TypeError('boom'))).toBeNull();
    expect(descreverFalhaAoIniciarImportacao(new Error('not ready'))).toBeNull();
  });
});

describe('descreverFalhaAoIniciarAtualizacaoPrecos', () => {
  it('a busy start without a jobId is yellow, with this flow’s code', () => {
    const err = http(409, CODIGO_FALHA_SHOPEE.envioPrecoEmAndamento, 'Já existe uma atualização.');
    expect(descreverFalhaAoIniciarAtualizacaoPrecos(err)?.color).toBe('yellow');
    // NEAR MISS — the import's busy code is not this flow's: plain red refusal.
    const outra = http(409, CODIGO_FALHA_SHOPEE.importacaoEmAndamento, 'outra');
    expect(descreverFalhaAoIniciarAtualizacaoPrecos(outra)).toEqual({
      color: 'red',
      message: 'outra',
    });
  });

  it('a closed price queue is red with the backend’s sentence', () => {
    const err = http(503, CODIGO_FALHA_SHOPEE.envioPrecoNaoEnfileirado, 'fila desabilitada');
    expect(descreverFalhaAoIniciarAtualizacaoPrecos(err)).toEqual({
      color: 'red',
      message: 'fila desabilitada',
    });
  });

  it('a conta with no tabela normal gets the actionable copy', () => {
    const err = http(400, CODIGO_FALHA_SHOPEE.contaSemTabelaNormal, 'sem tabela');
    expect(descreverFalhaAoIniciarAtualizacaoPrecos(err)).toEqual({
      color: 'red',
      message: 'Configure a tabela de preços normal da conta antes de enviar.',
    });
  });

  it('a quota pause is yellow and says until when, in São Paulo time', () => {
    const err = http(409, CODIGO_FALHA_SHOPEE.contaPausada, 'Conta pausada.', {
      pausadoAte: '2026-10-15T03:00:00.000Z',
    });
    expect(descreverFalhaAoIniciarAtualizacaoPrecos(err)).toEqual({
      color: 'yellow',
      message: 'A cota de chamadas da Shopee está esgotada até 15/10 00:00 — tente depois disso.',
    });
  });

  it('a quota pause with no readable instant keeps the backend’s sentence', () => {
    expect(
      descreverFalhaAoIniciarAtualizacaoPrecos(
        http(409, CODIGO_FALHA_SHOPEE.contaPausada, 'Conta pausada.'),
      ),
    ).toEqual({ color: 'yellow', message: 'Conta pausada.' });
    expect(
      descreverFalhaAoIniciarAtualizacaoPrecos(
        http(409, CODIGO_FALHA_SHOPEE.contaPausada, 'Conta pausada.', { pausadoAte: 'amanhã' }),
      ),
    ).toEqual({ color: 'yellow', message: 'Conta pausada.' });
  });

  it('a conta the price push refuses keeps the backend’s operator copy', () => {
    const err = http(422, CODIGO_FALHA_SHOPEE.precoContaRecusada, 'A loja não é do Brasil.', {
      motivo: 'regiao-nao-br',
    });
    expect(descreverFalhaAoIniciarAtualizacaoPrecos(err)).toEqual({
      color: 'red',
      message: 'A loja não é do Brasil.',
    });
  });

  it('a Shopee rate limit reads as one, whatever the status', () => {
    const err = http(502, 'SHOPEE_HTTP_ERROR', 'error_busi', {}, 'daily');
    expect(descreverFalhaAoIniciarAtualizacaoPrecos(err)).toEqual({
      color: 'red',
      message: 'A Shopee limitou as consultas — tente em alguns minutos.',
    });
  });

  it('network and foreign errors', () => {
    expect(descreverFalhaAoIniciarAtualizacaoPrecos(new ShopeeClientNetworkError('x'))).toEqual({
      color: 'red',
      message: 'Falha de rede ao iniciar a atualização de preços.',
    });
    expect(descreverFalhaAoIniciarAtualizacaoPrecos(new RangeError('x'))).toBeNull();
  });
});

describe('descreverFalhaAoCancelar*', () => {
  it('a finished import reads as finished — and only on ITS code', () => {
    expect(
      descreverFalhaAoCancelarImportacao(http(409, CODIGO_FALHA_SHOPEE.importacaoNaoEmAndamento)),
    ).toBe('Esta importação já foi finalizada.');
    expect(descreverFalhaAoCancelarImportacao(http(404, null))).toBe('Importação não encontrada.');
  });

  it('⭐ a finished price run reads as a finished PRICE run, not as the import', () => {
    expect(
      descreverFalhaAoCancelarAtualizacaoPrecos(
        http(409, CODIGO_FALHA_SHOPEE.envioPrecoNaoEmAndamento),
      ),
    ).toBe('Esta atualização de preços já foi finalizada.');
    expect(descreverFalhaAoCancelarAtualizacaoPrecos(http(404, null))).toBe(
      'Atualização de preços não encontrada.',
    );
    // NEAR MISS — the START's busy code is the opposite condition.
    expect(
      descreverFalhaAoCancelarAtualizacaoPrecos(
        http(409, CODIGO_FALHA_SHOPEE.envioPrecoEmAndamento, 'outra coisa'),
      ),
    ).toBe('outra coisa');
  });

  it('ALWAYS returns copy — even for an error that is not a client failure at all', () => {
    expect(descreverFalhaAoCancelarImportacao(new Error('not ready'))).toBe(
      'Não foi possível cancelar a importação.',
    );
    expect(descreverFalhaAoCancelarAtualizacaoPrecos(new Error('not ready'))).toBe(
      'Não foi possível cancelar a atualização de preços.',
    );
    expect(descreverFalhaAoCancelarImportacao(new ShopeeClientNetworkError('x'))).toBe(
      'Não foi possível contatar a integração com a Shopee.',
    );
  });
});
