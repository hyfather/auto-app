import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { DATABASE_SCHEMA_SETUP_MESSAGE, isMissingDatabaseSchemaError } from "@/lib/prisma-errors";

const payloadSchema = z.object({
  email: z.string().trim().toLowerCase().email("Please enter a valid email address."),
  source: z.string().trim().max(120).optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    const error = parsed.error.issues[0]?.message ?? "Please enter a valid email address.";
    return NextResponse.json({ ok: false, error }, { status: 400 });
  }

  const { email, source } = parsed.data;

  try {
    await prisma.launchSubscriber.upsert({
      where: { email },
      update: {},
      create: { email, source: source || "landing_page" },
    });
    return NextResponse.json({ ok: true, message: "You're on the list. We'll email you when AutoApp launches." });
  } catch (error) {
    if (isMissingDatabaseSchemaError(error)) {
      return NextResponse.json({ ok: false, error: DATABASE_SCHEMA_SETUP_MESSAGE }, { status: 503 });
    }
    throw error;
  }
}
