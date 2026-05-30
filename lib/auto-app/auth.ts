export interface AdminPrincipal {
  actor: string;
}

export function requireAdmin(request: Request): AdminPrincipal | Response {
  const expected = process.env.AUTO_APP_ADMIN_TOKEN;
  if (!expected) {
    return Response.json({ error: "AUTO_APP_ADMIN_TOKEN is required for admin APIs." }, { status: 503 });
  }

  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";

  if (token !== expected) {
    return Response.json({ error: "Unauthorized admin request." }, { status: 401 });
  }

  return { actor: request.headers.get("x-auto-app-actor") ?? "admin" };
}
