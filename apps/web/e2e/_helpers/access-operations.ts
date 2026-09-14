import { expect, type Page } from '@playwright/test';
import { z } from 'zod';
import { accessAcceptedSchema } from '@delfrance/schemas';
import {
  completeAccessTestOperation,
  waitForAccessTestTurn,
  type AccessTestActor,
} from '@delfrance/test-fixtures';

/** Observe the real API receipt before waiting for completion. This reports
 * authorization errors immediately instead of hiding them behind a 120s timeout. */
export async function submitAccessOperation(
  page: Page,
  actor: AccessTestActor,
  path: string,
  method: string,
  button: string | RegExp,
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const responsePromise = page.waitForResponse(
      (r) => r.url().endsWith(path) && r.request().method() === method,
    );
    await page.getByRole('button', { name: button }).click();
    const response = await responsePromise;
    const body: unknown = await response.json();
    const error = z.object({ code: z.string() }).safeParse(body);
    if (response.status() === 409 && error.success && error.data.code === 'ACCESS_BUSY') {
      await waitForAccessTestTurn();
      continue;
    }
    expect(response.ok(), `Access API ${response.status()}: ${JSON.stringify(body)}`).toBe(true);
    const receipt = accessAcceptedSchema.parse(body);
    await completeAccessTestOperation(actor, receipt.operationId);
    return receipt;
  }
  throw new Error('Access administration remained busy after five submissions.');
}
