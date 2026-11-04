import { App, LegacyStackSynthesizer } from 'aws-cdk-lib';
import { NOME_STACK } from './constantes';
import { RelayAmazonStack } from './relayStack';

/**
 * Context the app sets itself, AFTER anything the CLI or `cdk.json` passes.
 *
 * `validateAgainstDefaultRules` turns the CloudFormation validator that ships
 * inside aws-cdk-lib (offline: no network) from warnings into errors, so a
 * schema error in a `CfnPipe` or Connection property fails `CI test` at synth
 * instead of failing the owner's deploy (W2a).
 */
export const CONTEXTO_DO_APP = {
  '@aws-cdk/core:validateAgainstDefaultRules': true,
} as const;

/**
 * The ONE factory `bin/relay.ts` and the tests share, so the template the tests
 * assert is the template the owner deploys.
 *
 * `LegacyStackSynthesizer` (step-3 plan §3 decision 7, re-planned): it emits no
 * bootstrap role, no bootstrap-version rule or parameter and no template asset,
 * so the CLI deploys with the owner's own credentials and sends the template
 * inline. That needs no `cdk bootstrap` in the relay's region. It turns a file
 * asset into template parameters instead of refusing it, so the tests pin the
 * exact parameter set. (`BootstraplessSynthesizer` still names the default
 * bootstrap deploy and execution roles; `DefaultStackSynthesizer` and
 * `CliCredentialsStackSynthesizer` need the bootstrap bucket.)
 */
export function criarAppRelay(opcoes: { outdir?: string } = {}): App {
  const app = new App({
    analyticsReporting: false,
    postCliContext: { ...CONTEXTO_DO_APP },
    ...(opcoes.outdir === undefined ? {} : { outdir: opcoes.outdir }),
  });
  new RelayAmazonStack(app, NOME_STACK, {
    synthesizer: new LegacyStackSynthesizer(),
    terminationProtection: true,
  });
  return app;
}
