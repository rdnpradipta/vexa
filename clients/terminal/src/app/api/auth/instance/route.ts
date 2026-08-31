/** Instance status for the login surface — UNAUTHENTICATED by design. The sign-in screen needs
 * to know whether the one-time admin-claim variant applies and whether the protected local-login
 * configuration is complete. Exposes booleans only; no email, digest, or internal secret leaves the server.
 */
import { NextResponse } from "next/server";
import { directLoginConfigured } from "../directLogin";
import { instanceHasAdmin } from "../adminApi";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { admin_exists: await instanceHasAdmin(), direct_login: directLoginConfigured() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
