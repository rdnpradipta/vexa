/** Protected local login for deployments without OAuth. POST {email,password} verifies an exact configured
 * email allowlist and constant-time scrypt result before calling admin-api to find/create the user and mint
 * an APIToken. The route returns 404 when local login is not fully configured.
 */
import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, USER_INFO_COOKIE, findOrCreateUserToken } from "../adminApi";
import { directLoginConfigured, verifyDirectLogin } from "../directLogin";
import { finishLoginAttempt, loginRetryAfterSeconds, reserveLoginAttempt } from "../loginRateLimit";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isSecureRequest(): boolean {
  return (
    (process.env.TERMINAL_URL || "").startsWith("https://") ||
    (process.env.NEXTAUTH_URL || "").startsWith("https://") ||
    false
  );
}

function clientFingerprint(request: NextRequest): string {
  const forwarded = request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim()
    || "unknown";
  return createHash("sha256").update(forwarded).digest("hex");
}

export async function POST(request: NextRequest) {
  if (!directLoginConfigured()) {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
  }

  let email: unknown;
  let password: unknown;
  try {
    ({ email, password } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }

  if (typeof email !== "string" || !email.trim()) {
    return NextResponse.json({ error: "Email is required" }, { status: 400, headers: NO_STORE });
  }
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) {
    return NextResponse.json({ error: "Invalid email format" }, { status: 400, headers: NO_STORE });
  }
  const reservation = reserveLoginAttempt(clientFingerprint(request));
  if (!reservation) {
    return NextResponse.json(
      { error: "Too many login attempts" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(loginRetryAfterSeconds()) } },
    );
  }

  let valid = false;
  try {
    valid = typeof password === "string"
      && password.length > 0
      && password.length <= 1024
      && await verifyDirectLogin(normalized, password);
  } catch {
    finishLoginAttempt(reservation, false);
    return NextResponse.json({ error: "Login unavailable" }, { status: 503, headers: NO_STORE });
  }
  finishLoginAttempt(reservation, valid);
  if (!valid) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 403, headers: NO_STORE });
  }

  const result = await findOrCreateUserToken(normalized);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status || 500, headers: NO_STORE });
  }

  const { user, token } = result;
  const secure = isSecureRequest();
  const cookieStore = await cookies();
  const opts = { httpOnly: true, secure, sameSite: "lax" as const, maxAge: 60 * 60 * 24 * 30, path: "/" };
  cookieStore.set(AUTH_COOKIE, token, opts);
  cookieStore.set(USER_INFO_COOKIE, JSON.stringify({ email: user.email, name: user.name || user.email.split("@")[0] }), opts);

  return NextResponse.json(
    { success: true, user: { id: user.id, email: user.email, name: user.name ?? user.email } },
    { headers: NO_STORE },
  );
}
