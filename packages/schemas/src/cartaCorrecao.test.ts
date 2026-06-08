import { describe, expect, it } from 'vitest';
import { cartaCorrecaoSchema, cartaCorrecaoMeta } from './cartaCorrecao';

const MINIMAL = {
  xCorrecao: 'Correcao do endereco de entrega informado no campo observacoes',
  nSeqEvento: 1,
  xml_enviado: null,
  xml_retorno: null,
  cStat: null,
  xMotivo: null,
  nProt: null,
  error: null,
  tpEmis: null,
};

describe('cartaCorrecaoSchema', () => {
  it('parses a minimal record and defaults estado to iniciado', () => {
    const out = cartaCorrecaoSchema.parse(MINIMAL);
    expect(out.estado).toBe('0'); // EstadoEnviNFeMsg.iniciado
    expect(out.nSeqEvento).toBe(1);
  });

  it('requires xCorrecao to be at least 15 chars (SEFAZ rule)', () => {
    expect(cartaCorrecaoSchema.safeParse({ ...MINIMAL, xCorrecao: 'curto' }).success).toBe(false);
  });

  it('rejects xCorrecao longer than 1000 chars (SEFAZ rule)', () => {
    expect(cartaCorrecaoSchema.safeParse({ ...MINIMAL, xCorrecao: 'a'.repeat(1001) }).success).toBe(
      false,
    );
  });

  it('requires nSeqEvento ≥ 1', () => {
    expect(cartaCorrecaoSchema.safeParse({ ...MINIMAL, nSeqEvento: 0 }).success).toBe(false);
  });

  it('accepts a registrada record with cStat / xMotivo / nProt', () => {
    const out = cartaCorrecaoSchema.parse({
      ...MINIMAL,
      nSeqEvento: 2,
      cStat: '135',
      xMotivo: 'Evento registrado e vinculado a NF-e',
      nProt: '135200000099999',
      estado: '3', // concluido
    });
    expect(out.cStat).toBe('135');
    expect(out.nProt).toBe('135200000099999');
    expect(out.estado).toBe('3');
  });

  it('targets the per-NF-e cartacorrecao subcollection', () => {
    expect(cartaCorrecaoMeta.collectionPath).toBe('pedidos/{pedidoId}/nfev4/{nfeId}/cartacorrecao');
  });
});
