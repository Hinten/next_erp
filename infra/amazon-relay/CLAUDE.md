# infra/amazon-relay: agent rules

The AWS relay for Amazon order notifications (SQS → EventBridge Pipe → API
destination → the `apps/amazon` receiver), as an AWS CDK v2 app. `README.md` is
the owner's deploy runbook (W2); these are the rules for editing the code.

- **Never run the `cdk` CLI**, synth included: synth, diff, doctor and notices
  all phone home (D11). Synthesis happens only in-process, in the tests, through
  `criarAppRelay` (`lib/app.ts`), the factory `bin/relay.ts` also uses.
- **The deploy is W2a, by the owner** (root `CLAUDE.md` rule 8). No agent
  deploys, bootstraps or calls AWS.
- **Every environment value is a `CfnParameter`**, never CDK context and never a
  literal: no account, region, domain, secret name or e-mail in code,
  `cdk.json` or a test. Amazon's documented SP-API principal is the one public
  account id allowed.
- **Tests go through `Template.fromStack` and the in-process cloud assembly**;
  keep the one synth in `beforeAll` with its explicit timeout, and assert no
  wall-clock time.
- **`LegacyStackSynthesizer` only** (no bootstrap). `BootstraplessSynthesizer`
  still names the default bootstrap roles; the default and CLI-credentials
  synthesizers need the bootstrap bucket.
- `cdk.context.json` and `cdk.out/` are never committed (both gitignored).
- **No `build`, `synth`, `deploy` or `cdk` script**, and no CDK package in any
  other manifest: `packages/config-eslint/rules/infra-amazon-relay-contained.test.js`.
- **The relay contract** (key header, `{"body": …}` wrapper, receiver path)
  lives in `packages/schemas/src/relayAmazon.ts`; change it there, for both
  sides at once.
