export class NFePedidoNotFoundError extends Error {
  constructor(pedidoId: string) {
    super(`Pedido '${pedidoId}' not found.`);
    this.name = 'NFePedidoNotFoundError';
  }
}
export class NFeBlockedError extends Error {
  constructor(pedidoId: string) {
    super(`Pedido '${pedidoId}' has bloquearEmissaoNFe set.`);
    this.name = 'NFeBlockedError';
  }
}
export class NFeOrchestratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFeOrchestratorError';
  }
}
/**
 * Pre-check abort: a número in the requested inutilização range belongs to an
 * already-authorized NF-e (aprovada / EPEC aprovado / cancelada). Inutilizing
 * it would be consumo indevido, so the event is never sent. The route maps
 * this to **409 Conflict** (distinct from a SEFAZ rejection, which is 422).
 */
export class NFeInutilizacaoAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFeInutilizacaoAbortedError';
  }
}
export class NFeMissingImpostoError extends Error {
  constructor(pedidoId: string, produtoUid: string, itemIndex: number) {
    super(
      `Pedido '${pedidoId}': item ${itemIndex} of produto '${produtoUid}' has no \`imposto\` ` +
        'stamped. Flutter resolves item → product → category → operação rules at ' +
        'pedido-authoring time; that resolver is a Phase D port. For now, every ' +
        'pedido item that will become an NF-e must arrive with `imposto` populated.',
    );
    this.name = 'NFeMissingImpostoError';
  }
}

/** Cancelamento rejected by SEFAZ, or the NF-e is not in a cancellable state. */
export class NFeCancelamentoError extends Error {
  constructor(
    message: string,
    /** SEFAZ event cStat — present only on an actual rejection (not preconditions). */
    public readonly cStat?: string,
    public readonly xMotivo?: string,
  ) {
    super(message);
    this.name = 'NFeCancelamentoError';
  }
}
