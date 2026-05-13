import { describe, expect, it } from 'vitest';
import {
  ESTADO_CONVERSA,
  ESTADO_ENVIO,
  conversaSchema,
  mensagemSchema,
  podeReabrirConversa,
} from './conversa';

describe('conversaSchema', () => {
  it('parses with defaults applied', () => {
    const out = conversaSchema.parse({});
    expect(out.estadoConversa).toBe(ESTADO_CONVERSA.naoRespondido);
    expect(out.origem).toBe('site');
    expect(out.atendido).toBe(false);
    expect(out.nome).toBe('Conversa sem título');
    expect(out.urlAvatar).toBe('');
  });

  it('accepts every estadoConversa code (incl. spam=99)', () => {
    for (const value of Object.values(ESTADO_CONVERSA)) {
      const out = conversaSchema.safeParse({ estadoConversa: value });
      expect(out.success).toBe(true);
    }
  });

  it('rejects unknown estadoConversa codes', () => {
    expect(conversaSchema.safeParse({ estadoConversa: 42 }).success).toBe(false);
  });

  it('rejects unknown origem strings', () => {
    expect(conversaSchema.safeParse({ origem: 'tiktok' }).success).toBe(false);
  });

  it('preserves outer-ref objects unchanged', () => {
    const usario = { docId: { id: 'u1', collectionId: 'usuarios' } };
    const out = conversaSchema.parse({ usarioOuterRef: usario });
    expect(out.usarioOuterRef).toEqual(usario);
  });
});

describe('mensagemSchema', () => {
  it('parses with defaults', () => {
    const out = mensagemSchema.parse({});
    expect(out.estadoEnvio).toBe(ESTADO_ENVIO.salva);
    expect(out.tipo).toBe('c');
    expect(out.canal).toBe(0);
  });

  it('accepts every estadoEnvio code', () => {
    for (const value of Object.values(ESTADO_ENVIO)) {
      expect(mensagemSchema.safeParse({ estadoEnvio: value }).success).toBe(true);
    }
  });

  it('rejects unknown tipo characters', () => {
    expect(mensagemSchema.safeParse({ tipo: 'z' }).success).toBe(false);
  });

  it('keeps anexoUrl pass-through', () => {
    const out = mensagemSchema.parse({
      conteudo: 'Veja o anexo',
      anexoUrl: 'https://cdn.example.com/x.pdf',
      timestamp: '2026-01-01T12:00:00.000Z',
    });
    expect(out.anexoUrl).toBe('https://cdn.example.com/x.pdf');
  });
});

describe('podeReabrirConversa', () => {
  it('returns true for finalizadas/canceladas', () => {
    expect(podeReabrirConversa(ESTADO_CONVERSA.atendimentoFinalizado)).toBe(true);
    expect(podeReabrirConversa(ESTADO_CONVERSA.atendimentoCancelado)).toBe(true);
    expect(
      podeReabrirConversa(ESTADO_CONVERSA.atendimentoCanceladoPeloCliente),
    ).toBe(true);
    expect(
      podeReabrirConversa(ESTADO_CONVERSA.atendimentoCanceladoPeloAtendente),
    ).toBe(true);
    expect(podeReabrirConversa(ESTADO_CONVERSA.finalizadoSemAtendimento)).toBe(true);
  });

  it('returns false for estados ativos / spam', () => {
    expect(podeReabrirConversa(ESTADO_CONVERSA.naoRespondido)).toBe(false);
    expect(podeReabrirConversa(ESTADO_CONVERSA.emResposta)).toBe(false);
    expect(podeReabrirConversa(ESTADO_CONVERSA.emEspera)).toBe(false);
    expect(podeReabrirConversa(ESTADO_CONVERSA.emTransferencia)).toBe(false);
    expect(podeReabrirConversa(ESTADO_CONVERSA.spam)).toBe(false);
  });
});
