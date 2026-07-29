import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import rule from './prefer-schema-enum.js';

// Wire RuleTester to vitest's runner (it calls describe/it at module load).
// Unlike the other rule suites, this one is type-aware: the FIRST case pays for
// building a real TS program over the fixture project, which is far more than a
// pure-function test does. The fixture tsconfig sets `types: []` to keep that
// off the monorepo's `@types/*` tree (~4.9s → ~0.3s), and the explicit timeout
// below covers the rest of the variance on a loaded CI runner.
const PROGRAM_BUILD_TIMEOUT_MS = 30_000;
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = (name, fn) => it(name, fn, PROGRAM_BUILD_TIMEOUT_MS);
RuleTester.itOnly = (name, fn) => it.only(name, fn, PROGRAM_BUILD_TIMEOUT_MS);

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

/** The two fixture enums that share the member set '0' | '1' | '2'. */
const IMPORT_COLLIDE = `import { ORIGEM, ORIGEM_PRODUTO, type Origem, type OrigemProduto } from '../packages/schemas/src/enums';\n`;

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
    {
      // THE regression this rule's identification strategy exists for: a
      // hand-written union whose members happen to match an opted-in enum is not
      // that enum. Real case: `TpAmb = '1' | '2'` (produção / homologação)
      // resolving to `IND_INCENTIVO` (sim / não).
      name: 'a hand-written union sharing an enum member set is not that enum',
      code: `${IMPORT_COLLIDE}import type { TpAmbLike } from '../packages/schemas/src/enums';\ndeclare const t: TpAmbLike;\nexport const x = t === '0';`,
      filename: IN,
    },
    {
      // Same, through a property of a generated interface — how the NF-e codegen
      // types reach the rule. `tpImp` is the DANFE layout, not a modalidade BC.
      name: 'a generated interface property is not a Zod enum',
      code: `${IMPORT_COLLIDE}import type { GeneratedIde } from '../packages/schemas/src/enums';\nexport const x: GeneratedIde = { tpImp: '1' };`,
      filename: IN,
    },
    {
      // The regression that motivated dropping the subset match: a union that
      // fits INSIDE an unrelated enum must never resolve to it.
      name: 'a literal union nested inside an unrelated enum is not that enum',
      code: `${IMPORT}declare const cst: '02' | '03';\nexport const x = cst === '02';`,
      filename: IN,
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
    {
      // The commonest real shape. `getSymbolAtLocation` answers undefined for a
      // property access whose object is a union — which every `pedido.estado` is
      // once narrowed from `… | null` — so the lookup falls back to the object's
      // type. Without that fallback the rule silently caught nothing here.
      name: 'a property access resolves through the object type',
      code: `${IMPORT}import type { PedidoLike } from '../packages/schemas/src/enums';\ndeclare const p: PedidoLike | null;\nexport const x = p !== null && p.estado === 'pago';`,
      filename: IN,
      errors: [err('pago')],
      output: null,
    },
    {
      // Destructuring is how most pure-logic helpers open, and a binding element
      // declares no type of its own — it has to be followed back to the property.
      name: 'a destructured binding is followed back to the property it came from',
      code: `${IMPORT}import type { PedidoLike } from '../packages/schemas/src/enums';\nexport function f(p: PedidoLike) {\n  const { estado } = p;\n  return estado === 'pago';\n}`,
      filename: IN,
      errors: [err('pago')],
      output: null,
    },
    {
      // Was a documented limitation while enums were matched by member set:
      // narrowing shrank the union and nothing matched. The operand's
      // DECLARATION is unaffected by narrowing, so this is now caught.
      name: 'an operand narrowed by control flow is still resolved',
      code: `${IMPORT}declare const e: EstadoPedido;\nexport const x = e !== ESTADO_PEDIDO.pago && e !== 'cancelado';`,
      filename: IN,
      errors: [err('cancelado')],
      output: null,
    },
    {
      // Two enums sharing a member set are told apart by NAME. Under the old
      // matching both were parked (#718's guard); each now resolves to its own
      // constant — never the other module's, which would have compiled.
      name: 'one of two enums sharing a member set resolves to its own constant',
      code: `${IMPORT_COLLIDE}declare const o: Origem;\nexport const x = o === '0';`,
      filename: IN,
      errors: [
        {
          messageId: 'rawLiteral',
          data: {
            constName: 'ORIGEM',
            typeName: 'Origem',
            member: 'nacional',
            value: '0',
            replacement: 'ORIGEM.nacional',
          },
          suggestions: 1,
        },
      ],
      output: null,
    },
    {
      name: 'its colliding partner resolves to the other constant, nullable included',
      code: `${IMPORT_COLLIDE}declare const o: OrigemProduto | null;\nexport const x = o === '1';`,
      filename: IN,
      errors: [
        {
          messageId: 'rawLiteral',
          data: {
            constName: 'ORIGEM_PRODUTO',
            typeName: 'OrigemProduto',
            member: 'importadoDireto',
            value: '1',
            replacement: 'ORIGEM_PRODUTO.importadoDireto',
          },
          suggestions: 1,
        },
      ],
      output: null,
    },
  ],
});
