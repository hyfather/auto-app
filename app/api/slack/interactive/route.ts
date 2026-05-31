import { NextResponse } from "next/server";
export async function POST() { return NextResponse.json({ ok: true, message: "Interactive Slack actions are reserved for future v1 extensions." }); }
