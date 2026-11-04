import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { App, LegacyStackSynthesizer, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { CfnPipe } from 'aws-cdk-lib/aws-pipes';
import type { CloudAssembly, CloudFormationStackArtifact } from 'aws-cdk-lib/cx-api';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CABECALHO_CHAVE_RELAY_AMAZON,
  CAMINHO_RECEPTOR_AMAZON,
  MODELO_ENTRADA_RELAY_AMAZON,
} from '@delfrance/schemas';
import { CONTEXTO_DO_APP, criarAppRelay } from '../lib/app';
import {
  ACOES_SP_API,
  NOME_DLQ,
  NOME_FILA,
  NOME_PIPE,
  NOME_STACK,
  NOME_TOPICO_ALARMES,
  PRINCIPAL_SP_API,
  SID_SP_API,
} from '../lib/constantes';
import { RelayAmazonStack } from '../lib/relayStack';

/**
 * The relay stack, asserted on the template AND on the cloud assembly the same
 * synth wrote. The app comes from `criarAppRelay`, the factory `bin/relay.ts`
 * uses, so what is asserted here is what the owner deploys at W2a.
 *
 * Synthesised ONCE, in-process, into a throwaway directory: no `cdk` CLI, no
 * network (`semRede.ts`), no AWS account (D11).
 */

const RAIZ = resolve(import.meta.dirname, '..');

/**
 * Amazon's SP-API notification principal, written out HERE rather than read
 * from `constantes.ts`: a test that imported it would follow a wrong value
 * there. Public: the SP-API tutorial that grants it access to the queue.
 */
const PRINCIPAL_DOCUMENTADO = '437568002678';

type Json = Record<string, unknown>;

function objeto(valor: unknown, onde: string): Json {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
    throw new TypeError(`${onde}: esperava um objeto JSON`);
  }
  return valor as Json;
}

function lista(valor: unknown, onde: string): unknown[] {
  if (!Array.isArray(valor)) throw new TypeError(`${onde}: esperava uma lista JSON`);
  return valor;
}

/** One-or-many, as IAM renders `Action` and `Resource`. */
function umOuMuitos(valor: unknown): unknown[] {
  return Array.isArray(valor) ? valor : [valor];
}

/**
 * What must never appear in anything the synth emits: an account id other than
 * Amazon's documented SP-API principal, a hard-coded `arn:aws` partition, the
 * default bootstrap qualifier, or CDK's analytics resource.
 */
function achadosDeHigiene(texto: string): string[] {
  const achados: string[] = [];
  for (const numero of texto.match(/\b\d{12}\b/g) ?? []) {
    if (numero !== PRINCIPAL_DOCUMENTADO) achados.push(`conta:${numero}`);
  }
  if (texto.includes('arn:aws')) achados.push('arn-literal');
  if (texto.includes('hnb659fds')) achados.push('qualificador-de-bootstrap');
  if (texto.includes('AWS::CDK::Metadata')) achados.push('metadata-do-cdk');
  return achados;
}

describe('the hygiene scanner (synthetic cases)', () => {
  it('finds every forbidden shape', () => {
    expect(
      achadosDeHigiene(
        'arn:aws:iam::123456789012:role/cdk-hnb659fds-deploy-role AWS::CDK::Metadata',
      ).sort(),
    ).toEqual(
      ['arn-literal', 'conta:123456789012', 'metadata-do-cdk', 'qualificador-de-bootstrap'].sort(),
    );
  });

  it("passes the near-misses: Amazon's principal, a partition Ref, a 13-digit run", () => {
    expect(
      achadosDeHigiene(`arn:\${AWS::Partition}:iam::${PRINCIPAL_DOCUMENTADO}:root 1234567890123`),
    ).toEqual([]);
  });
});

describe('the relay stack (synthesised once, in-process)', () => {
  let saida: string;
  let montagem: CloudAssembly;
  let artefato: CloudFormationStackArtifact;
  let modelo: Template;
  let json: Json;
  let recursos: Json;

  // One CDK synth (aws-cdk-lib's module graph + the offline validator's WASM
  // engine) takes seconds; every test below reads its result.
  beforeAll(() => {
    saida = mkdtempSync(join(tmpdir(), 'amazon-relay-'));
    const app = criarAppRelay({ outdir: saida });
    montagem = app.synth();
    const pilha = app.node.findChild(NOME_STACK);
    if (!(pilha instanceof RelayAmazonStack)) throw new TypeError('the app holds no relay stack');
    artefato = montagem.getStackByName(NOME_STACK);
    modelo = Template.fromStack(pilha);
    json = objeto(modelo.toJSON(), 'template');
    recursos = objeto(json.Resources, 'Resources');
  }, 60_000);

  afterAll(() => {
    if (saida) rmSync(saida, { recursive: true, force: true });
  });

  /** `[logicalId, resource]` for every resource of one type. */
  function doTipo(tipo: string): [string, Json][] {
    return Object.entries(recursos)
      .map(([id, r]): [string, Json] => [id, objeto(r, id)])
      .filter(([, r]) => r.Type === tipo);
  }

  function unico(tipo: string): [string, Json] {
    const achados = doTipo(tipo);
    expect(achados, tipo).toHaveLength(1);
    return achados[0] as [string, Json];
  }

  function propriedades(recurso: Json): Json {
    return objeto(recurso.Properties, 'Properties');
  }

  function filaPorNome(nome: string): [string, Json] {
    const achada = doTipo('AWS::SQS::Queue').find(([, r]) => propriedades(r).QueueName === nome);
    if (!achada) throw new TypeError(`no queue named ${nome}`);
    return achada;
  }

  function arquivosDaMontagem(): string[] {
    return readdirSync(saida).filter((f) => !f.startsWith('.'));
  }

  function textosDaMontagem(): [string, string][] {
    return arquivosDaMontagem().map((f) => [f, readFileSync(join(saida, f), 'utf8')]);
  }

  /* ------------------------------- Inventory -------------------------------- */

  it('creates exactly the planned resources and nothing else', () => {
    const porTipo: Record<string, number> = {};
    for (const r of Object.values(recursos)) {
      const tipo = String(objeto(r, 'resource').Type);
      porTipo[tipo] = (porTipo[tipo] ?? 0) + 1;
    }
    expect(porTipo).toEqual({
      'AWS::SQS::Queue': 2,
      'AWS::SQS::QueuePolicy': 2,
      'AWS::Events::Connection': 1,
      'AWS::Events::ApiDestination': 1,
      'AWS::Logs::LogGroup': 1,
      'AWS::IAM::Role': 1,
      'AWS::IAM::Policy': 1,
      'AWS::Pipes::Pipe': 1,
      'AWS::SNS::Topic': 1,
      'AWS::SNS::TopicPolicy': 1,
      'AWS::SNS::Subscription': 1,
      'AWS::CloudWatch::Alarm': 4,
    });
    modelo.resourceCountIs('AWS::SQS::Queue', 2);
  });

  /* -------------------------------- Queues ---------------------------------- */

  it('the source queue: 14 days, SSE-SQS, 60-s visibility, redrive to the DLQ after 20', () => {
    const [idDlq] = filaPorNome(NOME_DLQ);
    const [, fila] = filaPorNome(NOME_FILA);
    const p = propriedades(fila);
    expect(p.MessageRetentionPeriod).toBe(1_209_600);
    expect(p.SqsManagedSseEnabled).toBe(true);
    expect(p.VisibilityTimeout).toBe(60);
    expect(p.KmsMasterKeyId).toBeUndefined();
    expect(p.RedrivePolicy).toEqual({
      deadLetterTargetArn: { 'Fn::GetAtt': [idDlq, 'Arn'] },
      maxReceiveCount: 20,
    });
  });

  it('the DLQ: 14 days, SSE-SQS, and both queues fixed-name and RETAINED', () => {
    const [, dlq] = filaPorNome(NOME_DLQ);
    expect(propriedades(dlq).MessageRetentionPeriod).toBe(1_209_600);
    expect(propriedades(dlq).SqsManagedSseEnabled).toBe(true);
    expect(propriedades(dlq).KmsMasterKeyId).toBeUndefined();
    for (const [, fila] of doTipo('AWS::SQS::Queue')) {
      expect(fila.DeletionPolicy).toBe('Retain');
      expect(fila.UpdateReplacePolicy).toBe('Retain');
    }
    expect(
      doTipo('AWS::SQS::Queue')
        .map(([, f]) => propriedades(f).QueueName)
        .sort(),
    ).toEqual([NOME_FILA, NOME_DLQ].sort());
  });

  it("the DLQ's allow-list names the source by its fixed name, never by reference (no cycle)", () => {
    const [, dlq] = filaPorNome(NOME_DLQ);
    const politica = objeto(propriedades(dlq).RedriveAllowPolicy, 'RedriveAllowPolicy');
    expect(politica.redrivePermission).toBe('byQueue');
    const fontes = lista(politica.sourceQueueArns, 'sourceQueueArns');
    expect(fontes).toHaveLength(1);
    const juncao = lista(objeto(fontes[0], 'arn')['Fn::Join'], 'Fn::Join');
    const partes = lista(juncao[1], 'parts');
    expect(partes.at(-1)).toBe(`:${NOME_FILA}`);
    expect(JSON.stringify(politica)).not.toContain('Fn::GetAtt');
  });

  it("the source's policy: exactly SP-API's two actions, plus the TLS-only deny", () => {
    const [idFila] = filaPorNome(NOME_FILA);
    const politica = doTipo('AWS::SQS::QueuePolicy').find(([, r]) =>
      JSON.stringify(propriedades(r).Queues).includes(idFila),
    );
    if (!politica) throw new TypeError('no policy on the source queue');
    const declaracoes = lista(
      objeto(propriedades(politica[1]).PolicyDocument, 'PolicyDocument').Statement,
      'Statement',
    ).map((d) => objeto(d, 'Statement'));

    const permissoes = declaracoes.filter((d) => d.Effect === 'Allow');
    expect(permissoes).toHaveLength(1);
    const [permissao] = permissoes as [Json];
    expect(permissao.Sid).toBe(SID_SP_API);
    expect(permissao.Action).toEqual([...ACOES_SP_API]);
    expect(permissao.Resource).toEqual({ 'Fn::GetAtt': [idFila, 'Arn'] });
    expect(PRINCIPAL_SP_API).toBe(PRINCIPAL_DOCUMENTADO);
    expect(JSON.stringify(permissao.Principal)).toContain(`:iam::${PRINCIPAL_DOCUMENTADO}:root`);

    const negacoes = declaracoes.filter((d) => d.Effect === 'Deny');
    expect(negacoes).toHaveLength(1);
    expect(negacoes[0]?.Condition).toEqual({ Bool: { 'aws:SecureTransport': 'false' } });
  });

  it("the DLQ's policy grants nothing (TLS-only deny alone)", () => {
    const [idDlq] = filaPorNome(NOME_DLQ);
    const politica = doTipo('AWS::SQS::QueuePolicy').find(([, r]) =>
      JSON.stringify(propriedades(r).Queues).includes(idDlq),
    );
    if (!politica) throw new TypeError('no policy on the DLQ');
    const declaracoes = lista(
      objeto(propriedades(politica[1]).PolicyDocument, 'PolicyDocument').Statement,
      'Statement',
    ).map((d) => objeto(d, 'Statement'));
    expect(declaracoes.map((d) => d.Effect)).toEqual(['Deny']);
  });

  /* -------------------- Connection + API destination ------------------------ */

  it('the Connection: API_KEY in the contract header, the value only as a secret reference', () => {
    const [, conexao] = unico('AWS::Events::Connection');
    const p = propriedades(conexao);
    expect(p.AuthorizationType).toBe('API_KEY');
    const chave = objeto(
      objeto(p.AuthParameters, 'AuthParameters').ApiKeyAuthParameters,
      'ApiKeyAuthParameters',
    );
    expect(chave.ApiKeyName).toBe(CABECALHO_CHAVE_RELAY_AMAZON);
    const valor = JSON.stringify(chave.ApiKeyValue);
    expect(valor).toContain('{{resolve:secretsmanager:');
    expect(valor).toContain(JSON.stringify({ Ref: 'RelaySecretName' }));
    expect(JSON.stringify(p.Description)).toContain(
      JSON.stringify({ Ref: 'RelaySecretGeneration' }),
    );
  });

  it('the API destination: POST to the ReceiverUrl parameter, 5 per second', () => {
    const [idConexao] = unico('AWS::Events::Connection');
    modelo.hasResourceProperties('AWS::Events::ApiDestination', {
      HttpMethod: 'POST',
      InvocationEndpoint: { Ref: 'ReceiverUrl' },
      InvocationRateLimitPerSecond: 5,
      ConnectionArn: { 'Fn::GetAtt': [idConexao, 'Arn'] },
    });
  });

  /* --------------------------------- Pipe ----------------------------------- */

  it('the pipe: queue → destination, one message at a time, the contract template, ERROR logs', () => {
    const [idFila] = filaPorNome(NOME_FILA);
    const [idDestino] = unico('AWS::Events::ApiDestination');
    const [idPolitica] = unico('AWS::IAM::Policy');
    const [, pipe] = unico('AWS::Pipes::Pipe');
    const p = propriedades(pipe);

    expect(p.Name).toBe(NOME_PIPE);
    expect(p.Source).toEqual({ 'Fn::GetAtt': [idFila, 'Arn'] });
    expect(p.Target).toEqual({ 'Fn::GetAtt': [idDestino, 'Arn'] });
    expect(p.DesiredState).toEqual({ Ref: 'PipeDesiredState' });

    // Only the SQS block: no batching window, and no pipe-level DLQ (it does
    // not apply to an SQS source; the source's redrive policy is the DLQ).
    const origem = objeto(p.SourceParameters, 'SourceParameters');
    expect(Object.keys(origem)).toEqual(['SqsQueueParameters']);
    expect(origem.SqsQueueParameters).toEqual({ BatchSize: 1 });

    expect(objeto(p.TargetParameters, 'TargetParameters').InputTemplate).toBe(
      MODELO_ENTRADA_RELAY_AMAZON,
    );

    modelo.hasResourceProperties('AWS::Pipes::Pipe', {
      LogConfiguration: { Level: 'ERROR', IncludeExecutionData: Match.absent() },
    });

    expect(lista(pipe.DependsOn, 'DependsOn')).toContain(idPolitica);
  });

  it('the pipe role: trusted by Pipes for this one pipe, with exactly the six actions', () => {
    const [idPapel, papel] = unico('AWS::IAM::Role');
    const p = propriedades(papel);
    expect(p.ManagedPolicyArns).toBeUndefined();
    expect(p.Policies).toBeUndefined();

    const confianca = lista(
      objeto(p.AssumeRolePolicyDocument, 'AssumeRolePolicyDocument').Statement,
      'Statement',
    ).map((d) => objeto(d, 'Statement'));
    expect(confianca).toHaveLength(1);
    const [regra] = confianca as [Json];
    expect(regra.Principal).toEqual({ Service: 'pipes.amazonaws.com' });
    const igual = objeto(objeto(regra.Condition, 'Condition').StringEquals, 'StringEquals');
    expect(igual['aws:SourceAccount']).toEqual({ Ref: 'AWS::AccountId' });
    const partes = lista(
      lista(objeto(igual['aws:SourceArn'], 'aws:SourceArn')['Fn::Join'], 'Fn::Join')[1],
      'parts',
    );
    expect(partes.at(-1)).toBe(`:pipe/${NOME_PIPE}`);

    // Every policy attached to the role, flattened to (action → resources).
    const [idFila] = filaPorNome(NOME_FILA);
    const [idDestino] = unico('AWS::Events::ApiDestination');
    const [idRegistros] = unico('AWS::Logs::LogGroup');
    const concedido = new Map<string, unknown[]>();
    for (const [, politica] of doTipo('AWS::IAM::Policy')) {
      const pp = propriedades(politica);
      expect(pp.Roles).toEqual([{ Ref: idPapel }]);
      for (const d of lista(objeto(pp.PolicyDocument, 'PolicyDocument').Statement, 'Statement')) {
        const declaracao = objeto(d, 'Statement');
        expect(declaracao.Effect).toBe('Allow');
        for (const acao of umOuMuitos(declaracao.Action)) {
          concedido.set(String(acao), umOuMuitos(declaracao.Resource));
        }
      }
    }
    expect([...concedido.keys()].sort()).toEqual(
      [
        'events:InvokeApiDestination',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'sqs:DeleteMessage',
        'sqs:GetQueueAttributes',
        'sqs:ReceiveMessage',
      ].sort(),
    );
    const fila = [{ 'Fn::GetAtt': [idFila, 'Arn'] }];
    expect(concedido.get('sqs:ReceiveMessage')).toEqual(fila);
    expect(concedido.get('sqs:DeleteMessage')).toEqual(fila);
    expect(concedido.get('sqs:GetQueueAttributes')).toEqual(fila);
    expect(concedido.get('events:InvokeApiDestination')).toEqual([
      { 'Fn::GetAtt': [idDestino, 'Arn'] },
      { 'Fn::GetAtt': [idDestino, 'ArnForPolicy'] },
    ]);
    const registros = [{ 'Fn::GetAtt': [idRegistros, 'Arn'] }];
    expect(concedido.get('logs:CreateLogStream')).toEqual(registros);
    expect(concedido.get('logs:PutLogEvents')).toEqual(registros);
  });

  it('keeps the pipe logs 30 days', () => {
    modelo.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  });

  /* -------------------------------- Alarms ---------------------------------- */

  function alarmes(): Map<string, Json> {
    return new Map(
      doTipo('AWS::CloudWatch::Alarm').map(([, a]) => {
        const p = propriedades(a);
        return [String(p.AlarmName), p];
      }),
    );
  }

  /** Every namespace an alarm reads: its own, or its math metrics'. */
  function namespaces(alarme: Json): string[] {
    if (typeof alarme.Namespace === 'string') return [alarme.Namespace];
    return lista(alarme.Metrics, 'Metrics')
      .map((m) => objeto(m, 'metric').MetricStat)
      .filter((s) => s !== undefined)
      .map((s) => String(objeto(objeto(s, 'MetricStat').Metric, 'Metric').Namespace));
  }

  function estatisticas(alarme: Json): Json[] {
    return lista(alarme.Metrics, 'Metrics')
      .map((m) => objeto(m, 'metric'))
      .filter((m) => m.MetricStat !== undefined)
      .map((m) => objeto(m.MetricStat, 'MetricStat'));
  }

  /** The one math expression a metric-math alarm returns. */
  function expressao(alarme: Json): unknown {
    const expressoes = lista(alarme.Metrics, 'Metrics')
      .map((m) => objeto(m, 'metric'))
      .filter((m) => m.Expression !== undefined);
    expect(expressoes).toHaveLength(1);
    return expressoes[0]?.Expression;
  }

  it('four alarms, three on SQS and one on Pipes, all publishing to the topic', () => {
    const todos = alarmes();
    expect(todos.size).toBe(4);
    const porNamespace = [...todos.values()].map((a) => [...new Set(namespaces(a))].join('+'));
    expect(porNamespace.sort()).toEqual(
      ['AWS/EventBridge/Pipes', 'AWS/SQS', 'AWS/SQS', 'AWS/SQS'].sort(),
    );
    const [idTopico] = unico('AWS::SNS::Topic');
    for (const a of todos.values()) expect(a.AlarmActions).toEqual([{ Ref: idTopico }]);
  });

  it('(A) DLQ: any message, IGNORE missing data, and NO OK action', () => {
    const [idDlq] = filaPorNome(NOME_DLQ);
    const a = alarmes().get('amazon-relay-dlq-com-mensagens');
    if (!a) throw new TypeError('alarm (A) missing');
    expect(a).toMatchObject({
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Statistic: 'Maximum',
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: 1,
      Period: 300,
      TreatMissingData: 'ignore',
    });
    expect(a.Dimensions).toEqual([
      { Name: 'QueueName', Value: { 'Fn::GetAtt': [idDlq, 'QueueName'] } },
    ]);
    expect(a.OKActions).toBeUndefined();
  });

  it('(B) source stuck: oldest message ≥ 15 min, IGNORE missing data', () => {
    const [idFila] = filaPorNome(NOME_FILA);
    const b = alarmes().get('amazon-relay-fila-parada');
    if (!b) throw new TypeError('alarm (B) missing');
    expect(b).toMatchObject({
      MetricName: 'ApproximateAgeOfOldestMessage',
      Statistic: 'Maximum',
      Threshold: 900,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: 1,
      Period: 300,
      TreatMissingData: 'ignore',
    });
    expect(b.Dimensions).toEqual([
      { Name: 'QueueName', Value: { 'Fn::GetAtt': [idFila, 'QueueName'] } },
    ]);
  });

  it('(C) never empty: visible + in flight summed PER one-minute sample, 15 of 15', () => {
    const c = alarmes().get('amazon-relay-fila-nunca-vazia');
    if (!c) throw new TypeError('alarm (C) missing');
    expect(c).toMatchObject({
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: 15,
      DatapointsToAlarm: 15,
      TreatMissingData: 'notBreaching',
    });
    const stats = estatisticas(c);
    expect(stats.map((s) => objeto(s.Metric, 'Metric').MetricName).sort()).toEqual(
      ['ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesVisible'].sort(),
    );
    for (const s of stats) {
      expect(s.Period).toBe(60);
      expect(s.Stat).toBe('Minimum');
    }
    expect(expressao(c)).toBe('FILL(visiveis, 0) + FILL(emVoo, 0)');
  });

  it('(D) pipe failures: both failure metrics on the pipe, Sum ≥ 5 per 15 min', () => {
    const d = alarmes().get('amazon-relay-pipe-falhando');
    if (!d) throw new TypeError('alarm (D) missing');
    expect(d).toMatchObject({
      Threshold: 5,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: 1,
      TreatMissingData: 'notBreaching',
    });
    const stats = estatisticas(d);
    expect(stats.map((s) => objeto(s.Metric, 'Metric').MetricName).sort()).toEqual(
      ['ExecutionFailed', 'TargetStageFailed'].sort(),
    );
    for (const s of stats) {
      expect(s.Period).toBe(900);
      expect(s.Stat).toBe('Sum');
      expect(objeto(s.Metric, 'Metric').Dimensions).toEqual([
        { Name: 'PipeName', Value: NOME_PIPE },
      ]);
    }
    // FILL: without it, a window where only ONE failure kind occurred has no
    // datapoint at all, and the alarm never fires.
    expect(expressao(d)).toBe('FILL(execucao, 0) + FILL(alvo, 0)');
  });

  it('the alarm topic: no SSE, TLS only, CloudWatch of this account may publish', () => {
    const [, topico] = unico('AWS::SNS::Topic');
    expect(propriedades(topico)).toEqual({ TopicName: NOME_TOPICO_ALARMES });

    const [, politica] = unico('AWS::SNS::TopicPolicy');
    const declaracoes = lista(
      objeto(propriedades(politica).PolicyDocument, 'PolicyDocument').Statement,
      'Statement',
    ).map((d) => objeto(d, 'Statement'));
    const permissoes = declaracoes.filter((d) => d.Effect === 'Allow');
    expect(permissoes).toHaveLength(1);
    expect(permissoes[0]?.Principal).toEqual({ Service: 'cloudwatch.amazonaws.com' });
    expect(permissoes[0]?.Action).toBe('sns:Publish');
    expect(
      objeto(objeto(permissoes[0]?.Condition, 'Condition').StringEquals, 'StringEquals')[
        'aws:SourceAccount'
      ],
    ).toEqual({ Ref: 'AWS::AccountId' });
    expect(declaracoes.filter((d) => d.Effect === 'Deny')).toHaveLength(1);
  });

  it('subscribes the alarm e-mail only when one is given', () => {
    const [, assinatura] = unico('AWS::SNS::Subscription');
    expect(assinatura.Condition).toBe('TemEmailDeAlarme');
    expect(propriedades(assinatura).Endpoint).toEqual({ Ref: 'AlarmEmail' });
    expect(objeto(json.Conditions, 'Conditions').TemEmailDeAlarme).toEqual({
      'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'AlarmEmail' }, ''] }],
    });
  });

  it('outputs exactly the four hand-off values', () => {
    expect(Object.keys(objeto(json.Outputs, 'Outputs')).sort()).toEqual(
      ['AlarmTopicArn', 'DlqArn', 'PipeName', 'QueueArn'].sort(),
    );
  });

  /* ------------------------------ Parameters -------------------------------- */

  it('takes every environment value as a parameter, and no other parameter', () => {
    // Also the "no asset" pin: LegacyStackSynthesizer turns an asset into
    // parameters instead of refusing it, so any extra key here is one.
    expect(Object.keys(objeto(json.Parameters, 'Parameters')).sort()).toEqual(
      [
        'AlarmEmail',
        'PipeDesiredState',
        'ReceiverUrl',
        'RelaySecretGeneration',
        'RelaySecretName',
      ].sort(),
    );
  });

  it('ReceiverUrl: no default, and the pattern is built from the contract path', () => {
    const url = objeto(objeto(json.Parameters, 'Parameters').ReceiverUrl, 'ReceiverUrl');
    expect(url.Default).toBeUndefined();
    expect(CAMINHO_RECEPTOR_AMAZON).toMatch(/^[a-z/]+$/);
    expect(url.AllowedPattern).toBe(`^https://[^\\s/]+${CAMINHO_RECEPTOR_AMAZON}$`);

    const padrao = new RegExp(String(url.AllowedPattern));
    expect(padrao.test(`https://relay.example.test${CAMINHO_RECEPTOR_AMAZON}`)).toBe(true);
    for (const recusada of [
      `http://relay.example.test${CAMINHO_RECEPTOR_AMAZON}`,
      `https://relay.example.test${CAMINHO_RECEPTOR_AMAZON}/`,
      `https://relay.example.test${CAMINHO_RECEPTOR_AMAZON}x`,
      `https://relay.example.test/outra${CAMINHO_RECEPTOR_AMAZON}`,
      `https://relay example.test${CAMINHO_RECEPTOR_AMAZON}`,
    ]) {
      expect(padrao.test(recusada), recusada).toBe(false);
    }
  });

  it('the other parameters: their defaults and grammars', () => {
    const p = objeto(json.Parameters, 'Parameters');
    expect(objeto(p.RelaySecretName, 'RelaySecretName').Default).toBeUndefined();
    expect(objeto(p.RelaySecretGeneration, 'RelaySecretGeneration')).toMatchObject({
      Default: '1',
      AllowedPattern: '^[0-9]{1,6}$',
    });
    expect(objeto(p.AlarmEmail, 'AlarmEmail').Default).toBe('');
    expect(objeto(p.PipeDesiredState, 'PipeDesiredState')).toMatchObject({
      Default: 'RUNNING',
      AllowedValues: ['RUNNING', 'STOPPED'],
    });
  });

  /* ------------------------------- Hygiene ---------------------------------- */

  it("no account but Amazon's principal, no partition literal, no bootstrap qualifier, no CDK metadata", () => {
    const textos: [string, string][] = [['template', JSON.stringify(json)], ...textosDaMontagem()];
    // Anti-vacuity: the scan reads the template and the assembly's own files.
    expect(textos.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(json)).toContain(PRINCIPAL_DOCUMENTADO);
    for (const [nome, texto] of textos) expect(achadosDeHigiene(texto), nome).toEqual([]);
  });

  it('no https:// literal outside the parameters', () => {
    const { Parameters: _parametros, ...semParametros } = json;
    expect(JSON.stringify(semParametros)).not.toContain('https://');
    expect(JSON.stringify(json)).toContain('https://');
  });

  /* ------------------------ No bootstrap requirement ------------------------ */

  it('the assembly asks for no bootstrap: no role, no template asset, no version', () => {
    expect(artefato.assumeRoleArn).toBeUndefined();
    expect(artefato.cloudFormationExecutionRoleArn).toBeUndefined();
    expect(artefato.stackTemplateAssetObjectUrl).toBeUndefined();
    expect(artefato.requiresBootstrapStackVersion).toBeUndefined();
    expect(artefato.lookupRole).toBeUndefined();
    expect(artefato.assets).toEqual([]);
    expect(arquivosDaMontagem().filter((f) => f.endsWith('.assets.json'))).toEqual([]);
    for (const [nome, texto] of textosDaMontagem()) {
      expect(texto, nome).not.toContain('"aws:cdk:asset"');
    }
    // Anti-vacuity: the directory really is the assembly.
    expect(arquivosDaMontagem()).toContain('manifest.json');
    expect(arquivosDaMontagem()).toContain(artefato.templateFile);
  });

  it('no BootstrapVersion parameter or rule, and termination protection on', () => {
    expect(objeto(json.Parameters, 'Parameters').BootstrapVersion).toBeUndefined();
    expect(json.Rules).toBeUndefined();
    expect(artefato.terminationProtection).toBe(true);
    const manifesto = objeto(
      JSON.parse(readFileSync(join(saida, 'manifest.json'), 'utf8')),
      'manifest',
    );
    const propsDaPilha = objeto(
      objeto(objeto(manifesto.artifacts, 'artifacts')[NOME_STACK], NOME_STACK).properties,
      'properties',
    );
    expect(propsDaPilha.terminationProtection).toBe(true);
  });

  it('is small enough for the CLI to send inline (well under 51,200 bytes as YAML and JSON)', () => {
    // The CLI measures the template as YAML before choosing `TemplateBody`.
    // aws-cdk-lib bundles the same YAML library family the CLI serialises with;
    // its default line folding only ADDS bytes, so this bounds the CLI's own
    // unfolded output from above.
    const yaml = createRequire(createRequire(import.meta.url).resolve('aws-cdk-lib/package.json'))(
      'yaml',
    ) as { stringify(valor: unknown, opcoes: { schema: string }): string };
    const comoYaml = yaml.stringify(json, { schema: 'yaml-1.1' });
    expect(comoYaml).toContain('AWS::Pipes::Pipe');
    expect(Buffer.byteLength(comoYaml, 'utf8')).toBeLessThan(40_000);
    expect(Buffer.byteLength(JSON.stringify(json, null, 1), 'utf8')).toBeLessThan(40_000);
  });

  /* ------------------------------- Validator -------------------------------- */

  it('the offline validator ran, with the flag on, and found nothing unacknowledged', () => {
    const relatorio = objeto(
      JSON.parse(readFileSync(join(saida, 'validation-report.json'), 'utf8')),
      'validation-report',
    );
    const planos = lista(relatorio.pluginReports, 'pluginReports').map((r) => objeto(r, 'report'));
    expect(planos.length).toBeGreaterThanOrEqual(1);
    for (const plano of planos) {
      expect(plano.conclusion).toBe('success');
      expect(plano.violations).toEqual([]);
      const suprimidas = lista(plano.suppressedViolations ?? [], 'suppressedViolations').map(
        (v) => objeto(v, 'violation').ruleName,
      );
      // Only the acknowledged false positive (a secret's NAME read as a password).
      expect(suprimidas.every((n) => n === 'W2509')).toBe(true);
    }
    expect(CONTEXTO_DO_APP['@aws-cdk/core:validateAgainstDefaultRules']).toBe(true);
  });
});

describe('the validator flag turns a schema error into a synth failure', () => {
  // A second, tiny synth with the app's own context; run alone, the validator's
  // WASM engine still has to start (about a second).
  it('refuses a CfnPipe whose role is not an IAM role ARN', () => {
    const saida = mkdtempSync(join(tmpdir(), 'amazon-relay-sonda-'));
    const silencio = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const app = new App({
        analyticsReporting: false,
        postCliContext: { ...CONTEXTO_DO_APP },
        outdir: saida,
      });
      const pilha = new Stack(app, 'Sonda', { synthesizer: new LegacyStackSynthesizer() });
      new CfnPipe(pilha, 'Pipe', { roleArn: 'nao-e-um-arn', source: 's', target: 't' });
      expect(() => app.synth()).toThrow(/RoleArn: 'nao-e-um-arn'[\s\S]*CloudFormation Validate/);
    } finally {
      silencio.mockRestore();
      rmSync(saida, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('the workspace files', () => {
  it('commits no CDK lookup cache', () => {
    expect(existsSync(join(RAIZ, 'cdk.context.json'))).toBe(false);
  });

  it('cdk.json runs the app through tsx and turns the CLI phone-homes off', () => {
    const cdk = objeto(JSON.parse(readFileSync(join(RAIZ, 'cdk.json'), 'utf8')), 'cdk.json');
    expect(cdk.app).toBe('node --import tsx bin/relay.ts');
    expect(cdk.notices).toBe(false);
    expect(cdk.versionReporting).toBe(false);
    expect(objeto(cdk.context, 'context')['cli-telemetry']).toBe(false);
  });
});
