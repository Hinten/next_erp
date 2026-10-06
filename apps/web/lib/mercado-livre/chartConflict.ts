/**
 * The operator's chart changed or disappeared before a local save.
 *
 * saveChartTransaction compares the entire opened chart against tx.get on every
 * retry, then writes in that same transaction. The manager and modal narrow on
 * this class to preserve typing and give persistent reopen guidance.
 *
 * The local draft-delete path still uses its separate positional identity check;
 * making that removal staged and race-safe is follow-up work outside #1778.
 */
export class SizeChartConflictError extends Error {
  constructor(
    message = 'A lista de guias mudou enquanto você editava. Feche e abra a guia novamente.',
  ) {
    super(message);
    this.name = 'SizeChartConflictError';
  }
}

/** A failed send has no acknowledged version to adopt before a conflicting retry. */
export class SizeChartSyncUnconfirmedError extends SizeChartConflictError {
  constructor() {
    super(
      'Não foi possível confirmar o envio anterior. As guias salvas podem conter atualizações parciais. Feche e abra a guia novamente antes de tentar enviar.',
    );
    this.name = 'SizeChartSyncUnconfirmedError';
  }
}
