export const DATABASE_SCHEMA_SETUP_MESSAGE =
  "AutoApp database schema is not installed yet. Run `npx prisma migrate deploy` against the configured DATABASE_URL, then retry this command.";

export function isMissingDatabaseSchemaError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; meta?: { table?: unknown } };
  return candidate.code === "P2021";
}
