import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { REDACT_PATHS } from './redact';

/**
 * Reduce any thrown value to a small, leak-safe shape. We copy only `name`,
 * `message` and a string/number `code` — never the arbitrary enumerable own
 * properties an error may carry (e.g. `NFeTransportError.responseBody`, which
 * can echo signed XML). Mirrors `safeErrorShape` in the NF-e logger.
 */
function errSerializer(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      name: err.name,
      message: err.message,
      ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    };
  }
  return { message: typeof err === 'string' ? err : String(err) };
}

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

// Default level: silent under test (no log noise in suites), `info` in prod,
// `debug` otherwise. `LOG_LEVEL` overrides in every environment.
const defaultLevel = process.env.LOG_LEVEL ?? (isTest ? 'silent' : isProd ? 'info' : 'debug');

export interface CreateLoggerOptions extends LoggerOptions {
  /** Advanced/testing: write to a custom stream instead of stdout. */
  destination?: DestinationStream;
}

/**
 * Create a named structured logger.
 *
 * Emits newline-delimited JSON to stdout with **no worker-thread transport** —
 * which keeps it safe inside Next.js server bundles and serverless runtimes,
 * and lets Firebase App Hosting / Cloud Logging ingest the JSON directly. For
 * human-readable local output, pipe a process through `pino-pretty` (it is not
 * wired as a transport on purpose, to avoid bundler/worker pitfalls).
 *
 * Sensitive keys (see `./redact`) are censored and thrown values are reduced to
 * a leak-safe shape via the `err` serializer (`log.error({ err }, 'msg')`).
 *
 * **Server-only** — pino is Node-only. Do not import this from client
 * components or browser-bundled shared packages.
 */
export function createLogger(name: string, options: CreateLoggerOptions = {}): Logger {
  const { destination, ...rest } = options;
  const opts: LoggerOptions = {
    name,
    level: defaultLevel,
    redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
    serializers: { err: errSerializer },
    ...rest,
  };
  return destination ? pino(opts, destination) : pino(opts);
}

export type { Logger } from 'pino';
