import { refreshAccessUser } from '@/lib/accessRoutes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(req: Request, ctx: { params: Promise<{ uid: string }> }) {
  return refreshAccessUser(req, (await ctx.params).uid);
}
