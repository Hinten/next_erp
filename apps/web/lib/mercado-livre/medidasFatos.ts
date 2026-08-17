import { stripMarkedForDeletion } from '@delfrance/ui';

import type { MercadoLivreMedidasFatos } from './client';

/**
 * The tabela's fields as the FORM has them, for the AI request.
 *
 * ⚠️ Read from `getValues()` at click time, not from the stored document. The
 * Mercado Livre tab is a `renderInput` inside an `ObjectView` form, so a
 * descrição the operator just typed and a photo they just uploaded are not on
 * the document yet — reading only the stored copy handed the model an empty
 * record and produced "nenhuma medida foi lida" over a screen that visibly had
 * text in it.
 *
 * Pure, so the deletion rule below is testable without rendering the tab.
 */
export function buildMedidasFatos(values: Record<string, unknown>): MercadoLivreMedidasFatos {
  return {
    nome: typeof values.nome === 'string' ? values.nome : null,
    codigo: typeof values.codigo === 'string' ? values.codigo : null,
    descricao: typeof values.descricao === 'string' ? values.descricao : null,
    // ⚠️ Through `stripMarkedForDeletion`, the SAME transform the field's
    // `prepareForSave` runs at save time. Deletion is staged in this form
    // (apps/web rule 7), so a photo the operator has just marked is still in
    // `getValues()`. Sending it would feed the model an image on its way out AND
    // count it in `contexto.anexadas`, so the review modal would report a photo
    // the operator can see struck through on the Fotos tab.
    fotos: Array.isArray(values.fotos) ? (stripMarkedForDeletion(values.fotos) as unknown[]) : null,
  };
}
