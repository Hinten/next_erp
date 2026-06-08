import { describe, expect, it } from 'vitest';
import { buildFotoRefs } from './foto';

describe('buildFotoRefs', () => {
  it('builds the optimistic arquivos/<id> ref strings (Flutter Foto wire shape)', () => {
    expect(buildFotoRefs('p1', 'h')).toEqual({
      arquivoOuterRef: 'arquivos/p1_h',
      arquivo200pxOuterRef: 'arquivos/p1_h_200',
      arquivo400pxOuterRef: 'arquivos/p1_h_400',
      arquivoJpegOuterRef: 'arquivos/p1_h_jpeg',
    });
  });
});
