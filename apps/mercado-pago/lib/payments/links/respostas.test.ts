import { describe, expect, it } from 'vitest';
import {
  CODIGO_ERRO_LINK,
  MOTIVO_RECUSA_LINK_LABELS,
  erroLinkPagamentoSchema,
  motivoRecusaLinkSchema,
} from '@delfrance/schemas';

import {
  corpoInvalido,
  erroLink,
  linkNaoEncontrado,
  pedidoNaoEncontrado,
  recusaLink,
  requisicaoRepetida,
  respostaOk,
} from './respostas';

describe('recusaLink', () => {
  it.each(motivoRecusaLinkSchema.options)(
    '"%s" is a 409 LINK_NAO_ELEGIVEL carrying its reason and its pt-BR sentence',
    (motivo) => {
      const r = recusaLink(motivo);
      expect(r.status).toBe(409);
      expect(erroLinkPagamentoSchema.parse(r.corpo)).toEqual({
        code: CODIGO_ERRO_LINK.naoElegivel,
        error: MOTIVO_RECUSA_LINK_LABELS[motivo],
        reason: motivo,
      });
    },
  );
});

describe('the other refusals', () => {
  it.each([
    ['pedidoNaoEncontrado', 404, CODIGO_ERRO_LINK.pedidoNaoEncontrado, pedidoNaoEncontrado()],
    ['linkNaoEncontrado', 404, CODIGO_ERRO_LINK.linkNaoEncontrado, linkNaoEncontrado()],
    ['corpoInvalido', 400, CODIGO_ERRO_LINK.corpoInvalido, corpoInvalido('fora da janela')],
    ['requisicaoRepetida', 429, CODIGO_ERRO_LINK.requisicaoRepetida, requisicaoRepetida()],
  ])('%s answers %i with its code and NO reason', (_nome, status, code, r) => {
    expect(r.status).toBe(status);
    expect(erroLinkPagamentoSchema.parse(r.corpo).code).toBe(code);
    // Only a LINK_NAO_ELEGIVEL refusal names a reason.
    expect(r.corpo).not.toHaveProperty('reason');
  });

  it('carries the message it was given', () => {
    expect(corpoInvalido('fora da janela').corpo.error).toBe('fora da janela');
  });

  it('leaves an absent reason OUT of the body instead of sending undefined', () => {
    const r = erroLink(409, 'X', 'msg');
    expect(Object.keys(r.corpo).sort()).toEqual(['code', 'error']);
  });
});

describe('respostaOk', () => {
  it('is a 200 unless told otherwise', () => {
    expect(respostaOk({ a: 1 })).toEqual({ status: 200, corpo: { a: 1 } });
  });

  it('carries a 201 for a create that wrote', () => {
    expect(respostaOk({ a: 1 }, 201)).toEqual({ status: 201, corpo: { a: 1 } });
  });
});
