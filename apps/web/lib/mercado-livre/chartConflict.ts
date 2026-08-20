/**
 * The one lost-update guard the size-chart editor can actually implement.
 *
 * Guias live in `tabMedi.tabelasDeMedidasMercadoLivre[<conta>].tabelas`, an
 * ARRAY, and a Firestore `merge()` replaces an array wholesale. Two writers
 * touch that key — this editor (which two operators can open at once) and the
 * sync backend — so writing a list the editor loaded minutes ago would silently
 * drop whatever landed in between.
 *
 * The browser SDK has no `lastUpdateTime` precondition (root `CLAUDE.md` rule 7
 * tier 1 is unreachable here) and the merge is not a transaction, so the only
 * tier left is tier 3: tell the operator. Hence a distinct error class rather
 * than a generic throw — both the manager (which detects it) and the editor
 * (which renders it) narrow on this exact type.
 */
export class SizeChartConflictError extends Error {
  constructor() {
    super('A lista de guias mudou enquanto você editava. Feche e abra a guia novamente.');
    this.name = 'SizeChartConflictError';
  }
}
