import { afterAll, describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import rule from './no-error-as-sole-instanceof.js';

// Wire RuleTester to vitest's runner (it calls describe/it at module load).
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

ruleTester.run('no-error-as-sole-instanceof', rule, {
  valid: [
    {
      name: 'narrows on a specific class',
      code: `try { f(); } catch (e) { if (e instanceof FirebaseError) { log(e.code); } else { throw e; } }`,
    },
    {
      name: 'specific class AND Error for message extraction',
      code: `try { f(); } catch (e) {
        if (!(e instanceof ZodError)) throw e;
        log(e instanceof Error ? e.message : String(e));
      }`,
    },
    {
      name: 'inverted guard on a specific class',
      code: `function h() { try { f(); } catch (e) { if (!(e instanceof SyntaxError)) throw e; return null; } }`,
    },
    {
      name: 'unconditional rethrow alongside instanceof Error',
      code: `try { f(); } catch (e) { log(e instanceof Error ? e.message : ''); throw e; }`,
    },
    {
      name: 'no instanceof at all — the base selectors own this shape',
      code: `try { f(); } catch (e) { throw e; }`,
    },
    {
      name: 'namespaced specific class',
      code: `try { f(); } catch (e) { if (e instanceof firebase.FirebaseError) { log(e); } else { throw e; } }`,
    },
    {
      name: 'a nested catch narrowing properly does not rescue the outer one — but here both are fine',
      code: `try { f(); } catch (e) {
        if (!(e instanceof FirebaseError)) throw e;
        try { g(); } catch (inner) { if (!(inner instanceof ZodError)) throw inner; }
      }`,
    },
  ],

  invalid: [
    {
      name: 'Error is the only narrowing',
      code: `try { f(); } catch (e) { if (e instanceof Error) { log(e.message); } }`,
      errors: [{ messageId: 'soleError' }],
    },
    {
      name: 'the ternary message-extraction shape with no real narrowing',
      code: `function h() { try { f(); } catch (e) { return e instanceof Error ? e.message : 'erro'; } }`,
      errors: [{ messageId: 'soleError' }],
    },
    {
      name: 'Error narrowing with a silent null fallback',
      code: `function h() { try { f(); } catch (e) { if (e instanceof Error) return null; return null; } }`,
      errors: [{ messageId: 'soleError' }],
    },
    {
      name: 'nested catch is judged on its own',
      code: `try { f(); } catch (outer) {
        if (!(outer instanceof FirebaseError)) throw outer;
        try { g(); } catch (inner) { if (inner instanceof Error) { log(inner.message); } }
      }`,
      errors: [{ messageId: 'soleError' }],
    },
  ],
});
