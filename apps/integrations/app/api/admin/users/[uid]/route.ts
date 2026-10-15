import { ACCESS_ACTION } from '@delfrance/schemas';
import { mutateEditor, readEditor } from '@/lib/accessRoutes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ uid: string }> };
export async function GET(req: Request, ctx: Context) {
  return readEditor(req, (await ctx.params).uid, false);
}
export async function PATCH(req: Request, ctx: Context) {
  return mutateEditor(req, ACCESS_ACTION.updateUser, (await ctx.params).uid);
}
