import { describe, expect, it } from 'vitest';
import { DELETE_MARK } from '@delfrance/ui';

import { buildMedidasFatos } from './medidasFatos';

describe('buildMedidasFatos', () => {
  it('carries the form values, unsaved edits included', () => {
    expect(
      buildMedidasFatos({ nome: 'Camiseta', codigo: 'FORN-42', descricao: 'recém digitada' }),
    ).toMatchObject({ nome: 'Camiseta', codigo: 'FORN-42', descricao: 'recém digitada' });
  });

  it('drops photos the operator has staged for deletion', () => {
    // ⚠️ Deletion is staged in this form (apps/web rule 7), so a marked photo is
    // still in `getValues()` until the record is saved. Sending it would feed
    // the model an image on its way out AND count it in `contexto.anexadas`, so
    // the review modal would report a photo the operator can see struck through.
    const fatos = buildMedidasFatos({
      fotos: [
        { arquivoOuterRef: 'arquivos/fica' },
        { arquivoOuterRef: 'arquivos/sai', [DELETE_MARK]: true },
      ],
    });
    expect(fatos.fotos).toEqual([{ arquivoOuterRef: 'arquivos/fica' }]);
  });

  it('strips the transient marker from the survivors', () => {
    // The marker is a UI-only key. Leaving it on would put an unknown field in
    // the request body for no reason.
    const fatos = buildMedidasFatos({
      fotos: [{ arquivoOuterRef: 'arquivos/fica', [DELETE_MARK]: false }],
    });
    expect(fatos.fotos).toEqual([{ arquivoOuterRef: 'arquivos/fica' }]);
  });

  it('nulls each field it cannot read, rather than sending garbage', () => {
    // A null means "no opinion — use the stored value", which is what the route
    // falls back to per field. Sending a number would 400 the whole request.
    expect(buildMedidasFatos({ nome: 42, fotos: 'nope' })).toEqual({
      nome: null,
      codigo: null,
      descricao: null,
      fotos: null,
    });
  });
});
