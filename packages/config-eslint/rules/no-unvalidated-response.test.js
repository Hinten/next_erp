import { afterAll, describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';

import rule from './no-unvalidated-response.js';

// Wire RuleTester to vitest's runner (it calls describe/it at module load).
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

// Not type-aware: the rule is purely syntactic, so no `project`/`projectService`
// and none of `prefer-schema-enum.test.js`'s program-building cost or its
// `disallowAutomaticSingleRunInference` trap.
const ruleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
});

const IN = '/repo/apps/web/lib/canal/client.ts';

ruleTester.run('no-unvalidated-response', rule, {
  valid: [
    {
      name: 'the fix: the schema decides the type, so there is no cast',
      code: `
        async function call(path, schema) {
          const res = await fetch(path);
          const text = await res.text();
          const leitura = lerRespostaJson(text, schema);
          if (leitura.ok) return leitura.data;
          throw new Error('nope');
        }`,
      filename: IN,
    },
    {
      name: '⭐ `as unknown` is the sanctioned escape — it widens instead of asserting',
      // The repo's own good pattern, at packages/ai/src/admin/provider.ts.
      code: `const parsed = JSON.parse(text) as unknown;`,
      filename: IN,
    },
    {
      name: '⚠️ a Firestore snapshot is not a response body',
      // Three real sites look exactly like the banned shape and are fine:
      // pedido-print/assemble.ts, etiqueta-generica/model.ts, etiquetaActions.ts.
      // Requiring HTTP evidence in the same function is what keeps them out.
      code: `
        function readDoc<T>(snap) {
          return snap.exists() ? (snap.data() as T) : null;
        }`,
      filename: '/repo/apps/web/lib/pedido-print/assemble.ts',
    },
    {
      name: '⚠️ an identity cast in a recursive redactor is not a response body either',
      // apps/nfe/lib/nfe/log.ts — same shape, no network anywhere near it.
      code: `
        function redactSensitive<T>(value: T): T {
          const out = {};
          for (const k of Object.keys(value)) out[k] = value[k];
          return out as T;
        }`,
      filename: '/repo/apps/nfe/lib/nfe/log.ts',
    },
    {
      name: 'casting a request payload we built ourselves is fine',
      code: `
        function toPayload<T>(input) {
          const built = { ...input };
          return built as T;
        }`,
      filename: IN,
    },
    {
      name: 'a cast to a concrete type on a value that never touched the network',
      code: `const cfg = raw as ClientConfig;`,
      filename: IN,
    },
    {
      name: 'JSON.parse of sessionStorage, narrowed to unknown',
      code: `const pending = JSON.parse(sessionStorage.getItem('k') ?? 'null') as unknown;`,
      filename: IN,
    },
    {
      name: '⚠️ JSON parsing is not networking — a file read is not a response',
      // The first version of this rule had no fetch requirement and flagged
      // ~120 sites across 18 workspaces on exactly this shape: service-account
      // files, fixtures, cached strings, stored config.
      code: `
        function loadServiceAccount(path: string) {
          const raw = readFileSync(path, 'utf8');
          return JSON.parse(raw) as ServiceAccount;
        }`,
      filename: '/repo/apps/web/lib/firebase/admin.ts',
    },
    {
      name: '⚠️ a route handler reading its OWN request body is out of scope',
      // Same defect, opposite direction. Deliberately not flagged: these have no
      // fetch, and the ~40 in this repo already narrow each field by hand.
      code: `
        export async function POST(req: Request) {
          const body = (await req.json()) as { pedidoId: string };
          return Response.json({ ok: typeof body.pedidoId === 'string' });
        }`,
      filename: '/repo/apps/mercado-livre/app/api/marketplace/publicar/route.ts',
    },
    {
      name: 'a cast on a body read in a function that never fetches',
      code: `
        function decode(cached: string) {
          return JSON.parse(cached) as CachedEntry;
        }`,
      filename: IN,
    },
  ],

  invalid: [
    {
      name: '⭐ the shape all six helpers had: `return parsed as T` in a fetch helper',
      code: `
        async function call<T>(path: string): Promise<T> {
          const res = await fetch(path);
          let parsed: unknown = null;
          const text = await res.text();
          if (text.length > 0) parsed = JSON.parse(text);
          return parsed as T;
        }`,
      filename: IN,
      errors: [{ messageId: 'castToTypeParam', data: { typeName: 'T' } }],
    },
    {
      name: '⭐ a cast directly on `await res.json()` after a fetch',
      // apps/web/lib/clientes/consultaCnpj.ts and packages/core/src/cep/viaCep.ts
      // both looked exactly like this.
      code: `
        async function consultar(cnpj) {
          const res = await fetch(\`https://brasilapi/\${cnpj}\`);
          const data = (await res.json()) as BrasilApiCnpj;
          return data.razao_social.trim();
        }`,
      filename: IN,
      errors: [{ messageId: 'castOnBody', data: { typeName: 'BrasilApiCnpj' } }],
    },
    {
      name: '⭐ a cast on `JSON.parse(...)` of a fetched body',
      code: `
        async function ler(url) {
          const res = await fetch(url);
          const body = JSON.parse(await res.text()) as MeWebhookBody;
          return body;
        }`,
      filename: IN,
      errors: [{ messageId: 'castOnBody', data: { typeName: 'MeWebhookBody' } }],
    },
    {
      name: 'an inline object type is flagged too, not just a named one',
      code: `
        async function send(payload) {
          const res = await fetch('https://graph.facebook.com/messages', payload);
          const json = (await res.json()) as { messages?: Array<{ id: string }> };
          return json.messages?.[0]?.id;
        }`,
      filename: '/repo/packages/integrations/whatsapp-cloud-api/src/client.ts',
      errors: [{ messageId: 'castOnBody' }],
    },
    {
      name: 'an injected `fetchImpl` counts as fetching, like the real clients',
      code: `
        async function call(path) {
          const res = await fetchImpl(path);
          return (await res.json()) as Conta;
        }`,
      filename: IN,
      errors: [{ messageId: 'castOnBody', data: { typeName: 'Conta' } }],
    },
    {
      name: 'an arrow-function helper is caught the same way',
      code: `
        const call = async <T,>(path: string): Promise<T> => {
          const res = await doFetch(path);
          const body = await res.text();
          return body as T;
        };`,
      filename: IN,
      errors: [{ messageId: 'castToTypeParam', data: { typeName: 'T' } }],
    },
    {
      name: '⭐ `as unknown as <concrete type>` is a BYPASS, not the escape hatch',
      // The hole this closes. `unwrap()` stripped `await` and `!` but not a
      // nested cast, so shape 1 saw the inner `TSAsExpression` instead of the
      // `JSON.parse`, and shape 2 only fires on a type PARAMETER — `Array` is
      // not one. The double cast produces `Array<…>`, exactly what a single cast
      // produces, so it asserted just as hard while reading like restraint.
      code: `
        async function quote(url) {
          const res = await fetch(url);
          const text = await res.text();
          return JSON.parse(text) as unknown as Array<{ id: number; name: string }>;
        }`,
      filename: '/repo/tools/test-fixtures/src/debug-me-cart.ts',
      errors: [{ messageId: 'castOnBody' }],
    },
    {
      name: 'the same bypass on `.json()`',
      code: `
        async function conta(path) {
          const res = await fetch(path);
          return (await res.json()) as unknown as Conta;
        }`,
      filename: IN,
      errors: [{ messageId: 'castOnBody', data: { typeName: 'Conta' } }],
    },
    {
      name: '⚠️ `as unknown as T` is NOT an escape inside a fetch helper',
      // The double cast is honest about widening, but the OUTER assertion still
      // claims a caller-chosen shape for a body nothing checked. The fix is a
      // schema, not a louder cast.
      code: `
        async function call<T>(path: string): Promise<T> {
          const res = await fetch(path);
          const parsed = JSON.parse(await res.text()) as unknown;
          return parsed as unknown as T;
        }`,
      filename: IN,
      errors: [{ messageId: 'castToTypeParam', data: { typeName: 'T' } }],
    },
    {
      name: 'the type parameter of the NEAREST declaring function is what counts',
      // An outer generic must not mask an inner fetch helper reusing the name.
      code: `
        function outer<T>(x: T) {
          return async function call<T>(path: string): Promise<T> {
            const res = await fetch(path);
            const parsed = JSON.parse(await res.text());
            return parsed as T;
          };
        }`,
      filename: IN,
      errors: [{ messageId: 'castToTypeParam', data: { typeName: 'T' } }],
    },
  ],
});
