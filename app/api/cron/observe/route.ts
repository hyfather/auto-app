import { NextResponse } from "next/server";
import { runObservationCycle } from "@/lib/autoapp/observe";
export async function POST() { return NextResponse.json(await runObservationCycle({ post: true })); }
export async function GET() { return NextResponse.json(await runObservationCycle({ post: true })); }
