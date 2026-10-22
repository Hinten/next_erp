import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CAMINHO_RECEPTOR_AMAZON } from '@delfrance/schemas';

/**
 * Every number and fixed name the relay stack uses, each with its source.
 *
 * Nothing here is environment-specific: no account, region, domain, secret
 * name or e-mail. Those arrive as `CfnParameter`s at deploy time (step-3 plan
 * §3 decision 3), so the committed template is the deployed template.
 */

/* ------------------------------- Amazon's side ------------------------------ */

/**
 * The AWS account SP-API notifications are sent FROM. Public: Amazon's own
 * documentation names it in the queue policy every developer must add
 * (SP-API "Tutorial: grant Selling Partner API permission to write to your SQS
 * queue").
 */
export const PRINCIPAL_SP_API = '437568002678';

/**
 * Exactly the two actions that tutorial grants. Never `grantSendMessages()`,
 * which also grants `sqs:GetQueueUrl`.
 */
export const ACOES_SP_API = ['sqs:SendMessage', 'sqs:GetQueueAttributes'] as const;

/** The statement id the same tutorial uses. */
export const SID_SP_API = 'AllowSPAPIAccess';

/* ------------------------------- Fixed names -------------------------------- */

/** The CloudFormation stack (and the CDK construct id). */
export const NOME_STACK = 'AmazonRelay';

/** The source queue SP-API writes to. Generic, so the name says nothing about who runs it. */
export const NOME_FILA = 'amazon-relay-notificacoes';

/** The source queue's dead-letter queue. */
export const NOME_DLQ = 'amazon-relay-notificacoes-dlq';

/** The pipe; also the `PipeName` dimension alarm (D) reads. */
export const NOME_PIPE = 'amazon-relay-pipe';

/** The SNS topic the four alarms publish to. */
export const NOME_TOPICO_ALARMES = 'amazon-relay-alarmes';

/* --------------------------------- Queues ----------------------------------- */

/** 14 days: the SQS maximum ("Amazon SQS quotas", message retention). */
export const RETENCAO_FILA_DIAS = 14;

/**
 * 60 s, at least six times the API destination's 5-second request timeout
 * (the EventBridge "API destinations" page).
 */
export const VISIBILIDADE_FILA_S = 60;

/**
 * 20 receives × 60 s ≈ 20 minutes of retries before a message moves to the DLQ:
 * it rides over a cold-start streak or a short rollout (§3 decision 8).
 */
export const MAX_RECEBIMENTOS = 20;

/* --------------------------------- The pipe --------------------------------- */

/** One SQS message per invocation: the receiver handles exactly one notification. */
export const TAMANHO_LOTE = 1;

/** Invocations per second of the API destination; drains a 14-day backlog in minutes. */
export const TAXA_DESTINO_POR_S = 5;

/**
 * Pipe log level. ERROR only, and never `IncludeExecutionData`: execution data
 * would write the notification body (buyer data) and possibly the key header to
 * CloudWatch Logs.
 */
export const NIVEL_LOG_PIPE = 'ERROR';

/** Pipe log retention: 30 days. */
export const RETENCAO_LOGS = RetentionDays.ONE_MONTH;

/* --------------------------------- Alarms ----------------------------------- */

/** (B) The source's oldest message is this old (15 minutes): the pipe is not draining. */
export const IDADE_MAXIMA_FILA_S = 900;

/**
 * (C) The source holds a message, visible or in flight, in every one of this
 * many consecutive one-minute samples (15 minutes): something is retried
 * forever. One-minute periods, so each datapoint holds ONE SQS sample and the
 * sum is per sample (a sum of two per-period minimums can read 0 while the
 * queue is never empty).
 */
export const PERIODO_FILA_NUNCA_VAZIA_S = 60;
export const AMOSTRAS_FILA_NUNCA_VAZIA = 15;

/** (D) Pipe failures in one 15-minute window; rides over isolated cold-start timeouts. */
export const FALHAS_PIPE_LIMIAR = 5;
export const PERIODO_FALHAS_PIPE_S = 900;

/** (A), (B) The period of the single-datapoint alarms. */
export const PERIODO_ALARME_S = 300;

/**
 * EventBridge Pipes' CloudWatch namespace, as its monitoring page documents it.
 * [unverified until W2b]: the README's metrics drill lists the real names.
 */
export const NAMESPACE_PIPES = 'AWS/EventBridge/Pipes';

/* -------------------------------- Parameters -------------------------------- */

function escaparRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `ReceiverUrl` must be an https URL whose path is EXACTLY the receiver's
 * (`CAMINHO_RECEPTOR_AMAZON`, the shared contract): a host, then the path, then
 * nothing. CloudFormation checks it before creating anything.
 */
export const PADRAO_URL_RECEPTOR = `^https://[^\\s/]+${escaparRegex(CAMINHO_RECEPTOR_AMAZON)}$`;

/** A Secrets Manager secret NAME (the service's own character set and length). */
export const PADRAO_NOME_SEGREDO = '^[A-Za-z0-9/_+=.@-]{1,512}$';

/** The relay secret's generation: bumped on every rotation (README, Operations). */
export const PADRAO_GERACAO_SEGREDO = '^[0-9]{1,6}$';

/** Empty (no subscription) or one address. */
export const PADRAO_EMAIL_ALARME = '^$|^[^@\\s]+@[^@\\s]+$';

/** The pipe's two desired states: the kill switch without the console (D16). */
export const ESTADOS_PIPE = ['RUNNING', 'STOPPED'] as const;
