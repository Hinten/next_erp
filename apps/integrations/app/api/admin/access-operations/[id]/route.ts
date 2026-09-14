import { readOperation } from '@/lib/accessRoutes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return readOperation(req, (await ctx.params).id);
}
