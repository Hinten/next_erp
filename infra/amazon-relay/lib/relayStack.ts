import {
  ArnFormat,
  Aws,
  CfnCondition,
  CfnOutput,
  CfnParameter,
  Duration,
  Fn,
  RemovalPolicy,
  SecretValue,
  Stack,
  Validations,
  type StackProps,
} from 'aws-cdk-lib';
import {
  Alarm,
  ComparisonOperator,
  MathExpression,
  Metric,
  TreatMissingData,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { ApiDestination, Authorization, Connection, HttpMethod } from 'aws-cdk-lib/aws-events';
import { AccountPrincipal, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { CfnPipe } from 'aws-cdk-lib/aws-pipes';
import { CfnSubscription, Topic } from 'aws-cdk-lib/aws-sns';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { CABECALHO_CHAVE_RELAY_AMAZON, MODELO_ENTRADA_RELAY_AMAZON } from '@delfrance/schemas';
import {
  ACOES_SP_API,
  AMOSTRAS_FILA_NUNCA_VAZIA,
  ESTADOS_PIPE,
  FALHAS_PIPE_LIMIAR,
  IDADE_MAXIMA_FILA_S,
  MAX_RECEBIMENTOS,
  NAMESPACE_PIPES,
  NIVEL_LOG_PIPE,
  NOME_DLQ,
  NOME_FILA,
  NOME_PIPE,
  NOME_TOPICO_ALARMES,
  PADRAO_EMAIL_ALARME,
  PADRAO_GERACAO_SEGREDO,
  PADRAO_NOME_SEGREDO,
  PADRAO_URL_RECEPTOR,
  PERIODO_ALARME_S,
  PERIODO_FALHAS_PIPE_S,
  PERIODO_FILA_NUNCA_VAZIA_S,
  PRINCIPAL_SP_API,
  RETENCAO_FILA_DIAS,
  RETENCAO_LOGS,
  SID_SP_API,
  TAMANHO_LOTE,
  TAXA_DESTINO_POR_S,
  VISIBILIDADE_FILA_S,
} from './constantes';

/**
 * The Amazon order-notification relay (D4): SP-API writes `ORDER_CHANGE` into
 * an SQS queue in OUR account, and an EventBridge Pipe forwards each message,
 * one at a time, to an API destination that POSTs it to the `apps/amazon`
 * receiver with the relay secret in a header.
 *
 *   SP-API → SQS (+ DLQ) → Pipe → API destination (API_KEY Connection) → receiver
 *
 * Fully parameterised: every environment value is a `CfnParameter`, so the
 * synthesized template holds no account, region, domain, secret or e-mail.
 * There is no pipe-state metric, so four alarms stand in for it (§3 decision
 * 33 sets their missing-data treatment one by one).
 */
export class RelayAmazonStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    /* ------------------------------ Parameters ------------------------------ */

    const urlReceptor = new CfnParameter(this, 'ReceiverUrl', {
      type: 'String',
      description: 'The https URL of the apps/amazon receiver. No default, on purpose.',
      allowedPattern: PADRAO_URL_RECEPTOR,
    });
    const nomeSegredo = new CfnParameter(this, 'RelaySecretName', {
      type: 'String',
      description:
        'The NAME of an existing plain-string Secrets Manager secret (same account and region) holding the relay secret.',
      allowedPattern: PADRAO_NOME_SEGREDO,
    });
    // The bundled CloudFormation validator guesses "password" from the word
    // Secret in the name. This parameter is the secret's NAME, never its value,
    // which only Secrets Manager holds; NoEcho would hide a harmless name.
    // Reported against the stack, so acknowledged there, for this one rule.
    Validations.of(this).acknowledge({
      id: 'CloudFormation-Validate::W2509',
      reason: 'RelaySecretName is the NAME of a Secrets Manager secret, not a secret value.',
    });
    const geracaoSegredo = new CfnParameter(this, 'RelaySecretGeneration', {
      type: 'String',
      description: 'Bump on every rotation, so the Connection is updated and re-reads the secret.',
      allowedPattern: PADRAO_GERACAO_SEGREDO,
      default: '1',
    });
    const emailAlarme = new CfnParameter(this, 'AlarmEmail', {
      type: 'String',
      description: 'Optional e-mail subscribed to the alarm topic. Empty: no subscription.',
      allowedPattern: PADRAO_EMAIL_ALARME,
      default: '',
    });
    const estadoPipe = new CfnParameter(this, 'PipeDesiredState', {
      type: 'String',
      description: 'RUNNING, or STOPPED to pause delivery (messages wait in the queue).',
      allowedValues: [...ESTADOS_PIPE],
      default: 'RUNNING',
    });

    /* -------------------------------- Queues -------------------------------- */

    // The DLQ's redrive allow-list names the source by its FIXED name, built
    // into an ARN, never by the source object: the source's redrive policy
    // already points at the DLQ, and a reference back would be a
    // CloudFormation dependency cycle (Source → Dlq → Source).
    const fonteDaDlq = Queue.fromQueueArn(
      this,
      'FonteDaDlq',
      Stack.of(this).formatArn({
        service: 'sqs',
        resource: NOME_FILA,
        arnFormat: ArnFormat.NO_RESOURCE_NAME,
      }),
    );
    const dlq = new Queue(this, 'Dlq', {
      queueName: NOME_DLQ,
      retentionPeriod: Duration.days(RETENCAO_FILA_DIAS),
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      redriveAllowPolicy: { sourceQueues: [fonteDaDlq] },
    });

    // SSE-SQS, never KMS: the AWS-managed `aws/sqs` key's policy cannot admit
    // Amazon's account, so SP-API's SendMessage would fail (§3 decision 2).
    const fila = new Queue(this, 'Fila', {
      queueName: NOME_FILA,
      retentionPeriod: Duration.days(RETENCAO_FILA_DIAS),
      visibilityTimeout: Duration.seconds(VISIBILIDADE_FILA_S),
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      // The source's own redrive policy is THE dead-letter path: a pipe-level
      // DLQ does not apply to an SQS source.
      deadLetterQueue: { queue: dlq, maxReceiveCount: MAX_RECEBIMENTOS },
    });

    // Exactly the statement SP-API's tutorial asks for. Never
    // `grantSendMessages()`, which adds `sqs:GetQueueUrl`.
    fila.addToResourcePolicy(
      new PolicyStatement({
        sid: SID_SP_API,
        principals: [new AccountPrincipal(PRINCIPAL_SP_API)],
        actions: [...ACOES_SP_API],
        resources: [fila.queueArn],
      }),
    );

    /* -------------------- Connection + API destination ---------------------- */

    // The template carries only the `{{resolve:secretsmanager:…}}` reference;
    // CloudFormation resolves it at deploy time. The description ties the
    // resource to the generation, so a rotation (generation + 1) changes a
    // property and CloudFormation updates the Connection.
    // [unverified until W2b]: that an update re-sends the key (README, rotation).
    const conexao = new Connection(this, 'Conexao', {
      authorization: Authorization.apiKey(
        CABECALHO_CHAVE_RELAY_AMAZON,
        SecretValue.secretsManager(nomeSegredo.valueAsString),
      ),
      description: Fn.join('', ['amazon-relay generation ', geracaoSegredo.valueAsString]),
    });

    const destino = new ApiDestination(this, 'Destino', {
      connection: conexao,
      endpoint: urlReceptor.valueAsString,
      httpMethod: HttpMethod.POST,
      rateLimitPerSecond: TAXA_DESTINO_POR_S,
    });

    /* ------------------------------ Pipe logs ------------------------------- */

    const registros = new LogGroup(this, 'RegistrosPipe', {
      retention: RETENCAO_LOGS,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    /* ------------------------------ Pipe role ------------------------------- */

    const arnPipe = Stack.of(this).formatArn({
      service: 'pipes',
      resource: 'pipe',
      resourceName: NOME_PIPE,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    const papel = new Role(this, 'PapelPipe', {
      assumedBy: new ServicePrincipal('pipes.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID, 'aws:SourceArn': arnPipe },
        },
      }),
    });
    papel.addToPolicy(
      new PolicyStatement({
        actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
        resources: [fila.queueArn],
      }),
    );
    const arnsDestino = [destino.apiDestinationArn];
    if (destino.apiDestinationArnForPolicy !== undefined) {
      arnsDestino.push(destino.apiDestinationArnForPolicy);
    }
    papel.addToPolicy(
      new PolicyStatement({ actions: ['events:InvokeApiDestination'], resources: arnsDestino }),
    );
    papel.addToPolicy(
      new PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [registros.logGroupArn],
      }),
    );

    /* --------------------------------- Pipe --------------------------------- */

    const pipe = new CfnPipe(this, 'Pipe', {
      name: NOME_PIPE,
      roleArn: papel.roleArn,
      source: fila.queueArn,
      target: destino.apiDestinationArn,
      desiredState: estadoPipe.valueAsString,
      // One message per invocation, and no batching window.
      sourceParameters: { sqsQueueParameters: { batchSize: TAMANHO_LOTE } },
      // `{"body": <$.body>}`: the wrapper keeps a JSON body JSON (the contract).
      targetParameters: { inputTemplate: MODELO_ENTRADA_RELAY_AMAZON },
      // ERROR only, and no `includeExecutionData`: it would log the body (buyer
      // data) and possibly the key header.
      logConfiguration: {
        level: NIVEL_LOG_PIPE,
        cloudwatchLogsLogDestination: { logGroupArn: registros.logGroupArn },
      },
    });
    // The role's policy must exist before the pipe starts polling with it.
    pipe.node.addDependency(papel);

    /* -------------------------------- Alarms -------------------------------- */

    // No SSE on this topic: CloudWatch cannot publish to a topic encrypted with
    // the AWS-managed `aws/sns` key, and the alarm text carries no buyer data.
    const topico = new Topic(this, 'TopicoAlarmes', {
      topicName: NOME_TOPICO_ALARMES,
      enforceSSL: true,
    });
    // `enforceSSL` gives the topic an access policy, which REPLACES SNS's
    // default one; CloudWatch's publish is therefore allowed explicitly, for
    // this account's alarms only.
    topico.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AllowCloudWatchAlarms',
        principals: [new ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [topico.topicArn],
        conditions: {
          StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
          ArnLike: {
            'aws:SourceArn': Stack.of(this).formatArn({
              service: 'cloudwatch',
              resource: 'alarm',
              resourceName: '*',
              arnFormat: ArnFormat.COLON_RESOURCE_NAME,
            }),
          },
        },
      }),
    );

    const temEmail = new CfnCondition(this, 'TemEmailDeAlarme', {
      expression: Fn.conditionNot(Fn.conditionEquals(emailAlarme.valueAsString, '')),
    });
    const assinatura = new CfnSubscription(this, 'AssinaturaEmail', {
      topicArn: topico.topicArn,
      protocol: 'email',
      endpoint: emailAlarme.valueAsString,
    });
    assinatura.cfnOptions.condition = temEmail;

    const acao = new SnsAction(topico);

    // (A) The DLQ holds a message. IGNORE, and no OK action: nothing consumes a
    // DLQ, so CloudWatch stops publishing its metrics hours after the last
    // arrival while the messages still count down their 14 days; IGNORE keeps
    // the ALARM until a real 0 arrives (a redrive or a purge touches the queue).
    const alarmeDlq = new Alarm(this, 'AlarmeDlq', {
      alarmName: 'amazon-relay-dlq-com-mensagens',
      alarmDescription: 'The relay DLQ holds messages. Redrive them (README, Operations).',
      metric: dlq.metricApproximateNumberOfMessagesVisible({
        statistic: 'Maximum',
        period: Duration.seconds(PERIODO_ALARME_S),
      }),
      threshold: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.IGNORE,
    });
    alarmeDlq.addAlarmAction(acao);

    // (B) The source is not draining (a stopped or auto-disabled pipe). IGNORE:
    // a stopped pipe overnight, with Amazon sending nothing, is a queue nobody
    // touches, and its metrics stop.
    const alarmeIdade = new Alarm(this, 'AlarmeFilaParada', {
      alarmName: 'amazon-relay-fila-parada',
      alarmDescription: 'The oldest relay message is 15 minutes old: the pipe is not draining.',
      metric: fila.metricApproximateAgeOfOldestMessage({
        statistic: 'Maximum',
        period: Duration.seconds(PERIODO_ALARME_S),
      }),
      threshold: IDADE_MAXIMA_FILA_S,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.IGNORE,
    });
    alarmeIdade.addAlarmAction(acao);
    alarmeIdade.addOkAction(acao);

    // (C) The source is never empty: a message retried forever, which (B)
    // misses because SQS leaves poison pills out of the age metric. Summed PER
    // ONE-MINUTE SAMPLE: a sum of two 5-minute minimums reads 0 while one
    // message alternates between visible and in flight.
    // [unverified until W2b]: that SQS publishes both at one-minute resolution.
    const umMinuto = Duration.seconds(PERIODO_FILA_NUNCA_VAZIA_S);
    const alarmeNuncaVazia = new Alarm(this, 'AlarmeFilaNuncaVazia', {
      alarmName: 'amazon-relay-fila-nunca-vazia',
      alarmDescription: 'The relay queue held a message in every sample for 15 minutes.',
      metric: new MathExpression({
        expression: 'FILL(visiveis, 0) + FILL(emVoo, 0)',
        usingMetrics: {
          visiveis: fila.metricApproximateNumberOfMessagesVisible({
            statistic: 'Minimum',
            period: umMinuto,
          }),
          emVoo: fila.metricApproximateNumberOfMessagesNotVisible({
            statistic: 'Minimum',
            period: umMinuto,
          }),
        },
        period: umMinuto,
      }),
      threshold: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: AMOSTRAS_FILA_NUNCA_VAZIA,
      datapointsToAlarm: AMOSTRAS_FILA_NUNCA_VAZIA,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    alarmeNuncaVazia.addAlarmAction(acao);
    alarmeNuncaVazia.addOkAction(acao);

    // (D) The pipe fails. FILL: a sum over a metric with no datapoint in the
    // window would otherwise be no datapoint at all, and the alarm would never
    // fire when only one of the two failure kinds occurs.
    // [unverified until W2b]: the metric names and the `PipeName` dimension.
    const quinzeMinutos = Duration.seconds(PERIODO_FALHAS_PIPE_S);
    const falhasDoPipe = (nome: string): Metric =>
      new Metric({
        namespace: NAMESPACE_PIPES,
        metricName: nome,
        dimensionsMap: { PipeName: NOME_PIPE },
        statistic: 'Sum',
        period: quinzeMinutos,
      });
    const alarmeFalhas = new Alarm(this, 'AlarmeFalhasPipe', {
      alarmName: 'amazon-relay-pipe-falhando',
      alarmDescription: 'The relay pipe failed 5 times in 15 minutes.',
      metric: new MathExpression({
        expression: 'FILL(execucao, 0) + FILL(alvo, 0)',
        usingMetrics: {
          execucao: falhasDoPipe('ExecutionFailed'),
          alvo: falhasDoPipe('TargetStageFailed'),
        },
        period: quinzeMinutos,
      }),
      threshold: FALHAS_PIPE_LIMIAR,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    alarmeFalhas.addAlarmAction(acao);
    alarmeFalhas.addOkAction(acao);

    /* -------------------------------- Outputs ------------------------------- */

    // W5's `createDestination` input. Read from the deployed stack, never committed.
    new CfnOutput(this, 'QueueArn', { value: fila.queueArn });
    new CfnOutput(this, 'DlqArn', { value: dlq.queueArn });
    new CfnOutput(this, 'PipeName', { value: pipe.ref });
    new CfnOutput(this, 'AlarmTopicArn', { value: topico.topicArn });
  }
}
