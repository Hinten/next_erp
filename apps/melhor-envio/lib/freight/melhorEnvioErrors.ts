/** The configured freight integration is absent or is not Melhor Envio. */
export class MelhorEnvioContaNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MelhorEnvioContaNotConfiguredError';
  }
}

/** Required application-wide Melhor Envio runtime configuration is missing. */
export class MelhorEnvioConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MelhorEnvioConfigError';
  }
}
