import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'mercado-pago',
    timestamp: new Date().toISOString(),
  });
}
