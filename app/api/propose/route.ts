import { NextResponse } from "next/server";
import { runObservationCycle } from "@/lib/autoapp/observe";
export async function POST() { return NextResponse.json(await runObservationCycle({ post: true })); }
