import { ACCESS_ACTION } from '@delfrance/schemas';
import { mutateEditor, readEditor } from '@/lib/accessRoutes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
export async function GET(req: Request, ctx: Context) {
  return readEditor(req, (await ctx.params).id, true);
}
export async function PATCH(req: Request, ctx: Context) {
  return mutateEditor(req, ACCESS_ACTION.updateCargo, (await ctx.params).id);
}
export async function DELETE(req: Request, ctx: Context) {
  return mutateEditor(req, ACCESS_ACTION.deleteCargo, (await ctx.params).id);
}
