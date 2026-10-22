# `@delfrance/infra-amazon-relay`

The AWS side of the Amazon order intake (D4, D16), as an AWS CDK v2 app in
TypeScript. SP-API cannot call an HTTPS endpoint for `ORDER_CHANGE`: it writes
into an SQS queue in the developer's own AWS account. This stack is that queue
and the relay that forwards each message to the `apps/amazon` receiver:

```
SP-API ─► SQS queue (+ DLQ) ─► EventBridge Pipe ─► API destination ─► POST /api/webhooks/amazon
                                                   (API_KEY Connection:
                                                    x-erp-relay-key header)
```

- **One message per POST**, wrapped as `{"body": <the SQS body>}`. The header
  name, the wrapper and the receiver path are a contract defined once in
  `packages/schemas/src/relayAmazon.ts`, imported by this stack and by the
  receiver.
- **Every environment value is a CloudFormation parameter**: the receiver URL,
  the relay secret's name, its generation, the alarm e-mail and the pipe's
  desired state. The template in this repository holds no account, region,
  domain, secret or address.
- **Four CloudWatch alarms** stand in for the missing "pipe state" metric:
  (A) the DLQ holds a message; (B) the queue's oldest message is 15 minutes old;
  (C) the queue held a message in every one-minute sample for 15 minutes;
  (D) the pipe failed 5 times in 15 minutes.
- **What CI does:** lint, typecheck and test. The tests synthesise the stack
  in-process and assert the template and the cloud assembly. CI never runs the
  `cdk` CLI, and nothing here talks to AWS.

## Deploying (W2, by the owner, never by CI or an agent)

Items marked **[unverified until W2b]** are documented behaviour that no
offline test can prove. The W2b drills settle each one before W5.

### 1. Prerequisites

- **L4, an IAM principal** in the relay's account with: CloudFormation; SQS;
  EventBridge Pipes; EventBridge Connections and API destinations; IAM role
  creation plus `iam:PassRole`; CloudWatch Logs; CloudWatch alarms; SNS;
  `secretsmanager:CreateSecret` and `secretsmanager:GetSecretValue`; and
  `iam:CreateServiceLinkedRole` (the API-destination service-linked role is
  created with the first Connection).
- **The relay's region** (L4). The CLI deploys to the region of the owner's
  `AWS_REGION` or AWS profile: the synthesized stack names none (its
  environment is `aws://unknown-account/unknown-region`).
- Node 22 and `pnpm install` from the repository root.

### 2. Create the relay secret

The relay secret is ONE value held in two clouds: AWS Secrets Manager in the
relay's region (read by the Connection) and the receiver's
`AMAZON_RELAY_SECRET` (W1).

1. Generate it once with `openssl rand -hex 32` (64 visible-ASCII characters)
   into a file written with NO trailing newline.
2. Load BOTH stores from that file, never from a command-line argument:
   `aws secretsmanager create-secret --name <name> --secret-string file://<file>`
   and `gcloud secrets versions add <secret> --data-file=<file>`.

The receiver answers 503 to a value shorter than 32 characters or holding
anything outside visible ASCII, a trailing newline or space included.

### 3. W2a, deploy (any time in Phase 0)

From `infra/amazon-relay/`, with the CLI's phone-homes off:

```sh
export CDK_DISABLE_CLI_TELEMETRY=true CDK_DISABLE_VERSION_CHECK=true
pnpm dlx aws-cdk@2.1144.0 deploy AmazonRelay \
  --parameters ReceiverUrl=<receiver URL> \
  --parameters RelaySecretName=<secret name> \
  --parameters AlarmEmail=<address>
```

- **No `cdk bootstrap` is needed.** The app uses `LegacyStackSynthesizer`: it
  emits no bootstrap role and no template asset, so the CLI deploys with the
  owner's own credentials and sends the template inline (it stays far under the
  CLI's 50 KiB inline limit; a test pins it).
- The CLI is not a dependency of this repository: `pnpm dlx` fetches the exact
  version, and `cdk.json` runs the app with `node --import tsx`, which finds the
  workspace's own `tsx`. `cdk.json` also turns the CLI's notices and telemetry
  off.
- `AlarmEmail` is optional. When given, confirm the SNS subscription e-mail.
- CloudFormation's schema is checked long before the deploy: the app turns the
  CloudFormation validator that ships inside aws-cdk-lib (offline) from warnings
  into errors, so a malformed property fails `CI test` first. What the validator
  cannot know (that the account accepts each property) is still first seen here.
- The `QueueArn` output is W5's input. Read it from the deployed stack; it is
  never committed.

### 4. W2b, verify (no side effect)

Preconditions: W1 in BOTH clouds; the `apps/amazon` App Hosting rollout (W9)
live with `AMAZON_APPLICATION_ID`, `AMAZON_RELAY_SECRET` and
`AMAZON_TASKS_REGION`; the custom domain behind `ReceiverUrl` (L6). A verify run
before them only dead-letters the test message (alarm A), recoverable by a
redrive.

Every drill sends a body whose `NotificationMetadata.ApplicationId` is NOT ours,
so the receiver drops it (200, one `aplicacao-estrangeira` line) and nothing is
enqueued.

- **Path:** `aws sqs send-message` with the foreign body. Expect one drop line
  with `chave: atual`, and the queue drains. The full path (our application id →
  a task) is W10's.
- **Metrics:**
  - `aws cloudwatch list-metrics --namespace AWS/EventBridge/Pipes --dimensions Name=PipeName,Value=amazon-relay-pipe`
    lists the two metric names alarm (D) reads (`ExecutionFailed`,
    `TargetStageFailed`). A wrong name sits in OK forever.
  - `aws cloudwatch get-metric-statistics` with `--period 60` on the queue's
    `ApproximateNumberOfMessagesVisible` and `ApproximateNumberOfMessagesNotVisible`
    returns one datapoint per minute. Alarm (C) sums them per one-minute sample;
    if SQS publishes them less often, (C) only catches several stuck messages,
    and (A) and (B) carry the single-message case.
- **Stopped pipe:** redeploy with `PipeDesiredState=STOPPED`, send one foreign
  message, and see alarm (B) fire (about 20 minutes) and its e-mail arrive. Then
  redeploy with `RUNNING` and see the queue drain.
- **Rotation:** one full rotation (below) with `RelaySecretGeneration=2`, with
  200s throughout.
- When closing W2b, record which wrapper form the receiver logged for the
  first forwarded bytes (`forma`: an object or a string).

### 5. Hand-off

The `QueueArn` output goes to W5's `createDestination`.

## Operations

- **Rotation**, in this order:
  1. Roll out the receiver with `AMAZON_RELAY_SECRET` = the NEW value and
     `AMAZON_RELAY_PREVIOUS_SECRET` = the old one. Both are accepted, and each
     instance logs one WARNING while a previous one is set.
  2. Put the new value in AWS Secrets Manager and redeploy with
     `RelaySecretGeneration=<N+1>`. The generation is part of the Connection's
     description, so CloudFormation updates the Connection, which is expected to
     re-read the secret. **[unverified until W2b]**
  3. Send the foreign-ApplicationId test message and confirm its drop line says
     `chave: atual`.
  4. Wait until live traffic shows no `chave: anterior` for at least 1 hour.
  5. Only then unset `AMAZON_RELAY_PREVIOUS_SECRET`.

  If step 3 still shows `anterior`, the Connection did not re-read the secret:
  stop, redeploy and check again. Never unset the previous secret blind: that
  turns every delivery into a 401.

- **Kill switch:** redeploy with `PipeDesiredState=STOPPED`. Messages wait in
  the queue for up to 14 days.
- **Re-enabling an auto-disabled pipe:** flip it STOPPED → RUNNING. A no-op
  redeploy is expected not to restart it. **[unverified until W2b]**
- **DLQ redrive:** `aws sqs start-message-move-task --source-arn <DlqArn>`. A
  dead-lettered message keeps only the rest of its original 14 days, so act on
  alarm (A) within days.
- **Teardown:** both queues and the log group are RETAINED, and termination
  protection is on.

## Working on this package

```sh
pnpm --filter @delfrance/infra-amazon-relay test        # in-process synth + assertions
pnpm --filter @delfrance/infra-amazon-relay typecheck
pnpm --filter @delfrance/infra-amazon-relay lint
```

- `lib/app.ts` is the one factory `bin/relay.ts` and the tests share, so the
  tested template is the deployed template.
- `lib/constantes.ts` holds every number and fixed name, each with its source.
- The package has no `build`, `synth` or `deploy` script, on purpose:
  `packages/config-eslint/rules/infra-amazon-relay-contained.test.js` pins its
  scripts and keeps the CDK out of every other manifest.
