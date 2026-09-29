/**
 * A cached WhatsApp arquivo vanished between the provider download and the
 * transaction that would publish its reference. Throwing keeps the notification
 * retryable so the next attempt can download/cache the media again.
 */
export class WhatsappMediaAnchorMissingError extends Error {
  constructor() {
    super('O arquivo de mídia do WhatsApp desapareceu antes de a mensagem ser gravada.');
    this.name = 'WhatsappMediaAnchorMissingError';
  }
}
