import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import rule from './prefer-schema-enum.js';

// Wire RuleTester to vitest's runner (it calls describe/it at module load).
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

// The rule is type-aware, so every case is linted as a real file inside a real
// TS project — `__fixtures__/enum-project`, which carries a stand-in
// `packages/schemas/src/enums.ts` with one opted-in enum (ESTADO_PEDIDO), one
// enum with no companion constant, and a hand-written union.
const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__/enum-project');
const IN = resolve(FIXTURE_DIR, 'app/target.ts');

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      project: './tsconfig.json',
      tsconfigRootDir: FIXTURE_DIR,
      // REQUIRED, and only observably so in CI. typescript-eslint infers
      // "single run" mode when `process.env.CI` is set, which builds the program
      // once from the files ON DISK and never applies the content RuleTester
      // swaps in per case. Every case would then be checked against the empty
      // `app/target.ts`, so nothing is enum-typed and every `invalid` case
      // reports zero errors — green locally, 12 failures in Actions.
      // `@typescript-eslint/rule-tester` sets this for you; ESLint's built-in
      // RuleTester does not.
      disallowAutomaticSingleRunInference: true,
    },
  },
});

const IMPORT = `import { ESTADO_PEDIDO, ESTADO_NFE, type EstadoPedido, type EstadoNfe, type TipoContato, type EstadoBucket } from '../packages/schemas/src/enums';\n`;

/**
 * One `rawLiteral` error for `member`. Every case below imports ESTADO_PEDIDO,
 * so each error carries exactly one suggestion; the two cases that assert the
 * suggested output spread this and override `suggestions` with the full array.
 */
function err(member) {
  return {
    messageId: 'rawLiteral',
    data: {
      constName: 'ESTADO_PEDIDO',
      typeName: 'EstadoPedido',
      member,
      value: member,
      replacement: `ESTADO_PEDIDO.${member}`,
    },
    suggestions: 1,
  };
}

ruleTester.run('prefer-schema-enum', rule, {
  valid: [
    {
      name: 'the constant itself is a member access, not a literal',
      code: `${IMPORT}declare const e: EstadoPedido;\nexport const x = e === ESTADO_PEDIDO.pago;`,
      filename: IN,
    },
    {
      name: 'an enum with no companion constant has not opted in',
      code: `${IMPORT}declare const t: TipoContato;\nexport const x = t === 'email';`,
      filename: IN,
    },
    {
      name: 'a hand-written string union is not a Zod enum',
      code: `${IMPORT}declare const b: EstadoBucket;\nexport const x = b === 'aberto';`,
      filename: IN,
    },
    {
      name: 'a plain string position is untouched',
      code: `${IMPORT}declare const s: string;\nexport const x = s === 'pago';`,
      filename: IN,
    },
    {
      name: 'a Record<string, string> position carries no enum type',
      code: `${IMPORT}export const x: Record<string, string> = { estado: 'pago' };`,
      filename: IN,
    },
    {
      name: "the constant's own declaration has to spell the members out",
      code: `${IMPORT}export const OTHER = {\n  pago: 'pago',\n  cancelado: 'cancelado',\n} as const satisfies Record<string, EstadoPedido>;`,
      filename: IN,
    },
    {
      name: 'the exemption is that declaration only, not the whole schemas package',
      code: `import { ESTADO_PEDIDO } from './enums';\nexport const OK = new Set([ESTADO_PEDIDO.pago]);`,
      filename: resolve(FIXTURE_DIR, 'packages/schemas/src/self.ts'),
    },
  ],
  invalid: [
    {
      name: 'comparison against an enum-typed value, suggesting the constant already in scope',
      code: `${IMPORT}declare const e: EstadoPedido;\nexport const x = e === 'pago';`,
      filename: IN,
      errors: [
        {
          ...err('pago'),
          suggestions: [
            {
              messageId: 'useConstant',
              data: { replacement: 'ESTADO_PEDIDO.pago' },
              output: `${IMPORT}declare const e: EstadoPedido;\nexport const x = e === ESTADO_PEDIDO.pago;`,
            },
          ],
        },
      ],
      output: null,
    },
    {
      name: 'comparison where the enum is nullable (the alias is flattened away)',
      code: `${IMPORT}declare const e: EstadoPedido | null;\nexport const x = e !== 'cancelado';`,
      filename: IN,
      errors: [err('cancelado')],
      output: null,
    },
    {
      name: 'object property whose contextual type is the enum',
      code: `${IMPORT}export const x: { estado: EstadoPedido } = { estado: 'cancelado' };`,
      filename: IN,
      errors: [err('cancelado')],
      output: null,
    },
    {
      // The exemption covers the constant's own member list, not any literal
      // that happens to sit under an `as const satisfies Record<…>`.
      name: 'a nested enum-typed literal under a satisfies-Record is still checked',
      code: `${IMPORT}export const M = {\n  a: { estado: 'pago' },\n} as const satisfies Record<string, { estado: EstadoPedido }>;`,
      filename: IN,
      errors: [err('pago')],
      output: null,
    },
    {
      // The regression that broke the first migration run: using the VALUE as
      // the member name produced `ESTADO_NFE.0`, a syntax error.
      name: 'a wire value that is not the member name resolves to the member',
      code: `${IMPORT}declare const n: EstadoNfe;\nexport const x = n === 'a';`,
      filename: IN,
      errors: [
        {
          messageId: 'rawLiteral',
          data: {
            constName: 'ESTADO_NFE',
            typeName: 'EstadoNfe',
            member: 'aprovada',
            value: 'a',
            replacement: 'ESTADO_NFE.aprovada',
          },
          suggestions: [
            {
              messageId: 'useConstant',
              data: { replacement: 'ESTADO_NFE.aprovada' },
              output: `${IMPORT}declare const n: EstadoNfe;\nexport const x = n === ESTADO_NFE.aprovada;`,
            },
          ],
        },
      ],
      output: null,
    },
    {
      // Control-flow narrowing strips the alias AND shrinks the union, so the
      // second comparison only resolves via the subset match.
      name: 'a narrowed enum operand still resolves',
      code: `${IMPORT}declare const e: EstadoPedido;\nexport const x = e !== ESTADO_PEDIDO.pago && e !== 'cancelado';`,
      filename: IN,
      errors: [err('cancelado')],
      output: null,
    },
    {
      name: 'array element inside a Set<Enum>',
      code: `${IMPORT}export const s = new Set<EstadoPedido>(['iniciado', 'pago']);`,
      filename: IN,
      errors: [err('iniciado'), err('pago')],
      output: null,
    },
    {
      name: 'return position',
      code: `${IMPORT}export function f(): EstadoPedido {\n  return 'finalizado';\n}`,
      filename: IN,
      errors: [err('finalizado')],
      output: null,
    },
    {
      name: 'switch case against an enum discriminant',
      code: `${IMPORT}declare const e: EstadoPedido;\nexport function f() {\n  switch (e) {\n    case 'pago':\n      return 1;\n    default:\n      return 0;\n  }\n}`,
      filename: IN,
      errors: [err('pago')],
      output: null,
    },
    {
      name: 'call argument',
      code: `${IMPORT}declare function g(e: EstadoPedido): void;\nexport const x = g('carrinho');`,
      filename: IN,
      errors: [err('carrinho')],
      output: null,
    },
    {
      // A type-only declaration can't take a value specifier — inserting into it
      // would compile to TS1361, which is exactly what broke the first run.
      name: 'a type-only import gets a sibling value import, not a new member',
      code: `import type { EstadoPedido } from '../packages/schemas/src/enums';\ndeclare const e: EstadoPedido;\nexport const x = e === 'pago';`,
      filename: IN,
      errors: [
        {
          ...err('pago'),
          suggestions: [
            {
              messageId: 'useConstant',
              data: { replacement: 'ESTADO_PEDIDO.pago' },
              output: `import type { EstadoPedido } from '../packages/schemas/src/enums';\nimport { ESTADO_PEDIDO } from '../packages/schemas/src/enums';\ndeclare const e: EstadoPedido;\nexport const x = e === ESTADO_PEDIDO.pago;`,
            },
          ],
        },
      ],
      output: null,
    },
    {
      name: 'suggestion also lands the import when the constant is not in scope',
      code: `import { type EstadoPedido } from '../packages/schemas/src/enums';\ndeclare const e: EstadoPedido;\nexport const x = e === 'pago';`,
      filename: IN,
      errors: [
        {
          ...err('pago'),
          suggestions: [
            {
              messageId: 'useConstant',
              data: { replacement: 'ESTADO_PEDIDO.pago' },
              output: `import { ESTADO_PEDIDO, type EstadoPedido } from '../packages/schemas/src/enums';\ndeclare const e: EstadoPedido;\nexport const x = e === ESTADO_PEDIDO.pago;`,
            },
          ],
        },
      ],
      output: null,
    },
  ],
});
