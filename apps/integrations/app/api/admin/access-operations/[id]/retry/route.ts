import { retryOperation } from '@/lib/accessRoutes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return retryOperation(req, (await ctx.params).id);
}
