// The CDK app entry `cdk.json` runs (`node --import tsx bin/relay.ts`). Only the
// owner runs it, through the CLI at W2a (README); CI never does: the tests
// synthesise the same app in-process through `criarAppRelay`.
import { criarAppRelay } from '../lib/app';

criarAppRelay().synth();
