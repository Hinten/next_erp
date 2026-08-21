import { MantineProvider } from '@mantine/core';
import type { ReactElement, ReactNode } from 'react';

/**
 * The Mantine provider every component test in this app renders through.
 *
 * Component tests must not construct `<MantineProvider>` themselves — enforced
 * by `packages/config-eslint/rules/mantine-test-provider.test.js` (#1150). The
 * prop had drifted: 23 of 56 test files omitted `env="test"` and nothing said
 * which was right, because the convention lived only in four ad-hoc comments.
 *
 * Use it wherever the bare provider used to sit — as the outer element of a
 * `render()`, as a `wrapper:` option, inside a local `Host`/`Harness`, or in a
 * `rerender()` (which needs the same wrapper element it was first rendered
 * with). Nesting with `QueryClientProvider` is left exactly as each test had it.
 *
 * ⚠️ `env="test"` is about consistency, NOT about the leaked transition timer.
 * `Transition` calls `useTransition` *before* its `env === 'test'` early return,
 * so the prop never stopped that timer; `vitest.setup.ts` does, by forcing every
 * transition duration to 0. What `env="test"` buys is rendering overlays inline
 * instead of through a portal, and skipping the transition markup.
 */
export function MantineTestProvider({ children }: { children: ReactNode }): ReactElement {
  return <MantineProvider env="test">{children}</MantineProvider>;
}
