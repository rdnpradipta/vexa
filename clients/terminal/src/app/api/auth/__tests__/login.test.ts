import { scryptSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Cookie jar the mocked next/headers writes into, so the test can assert what login set. */
let setCookies: Array<{ name: string; value: string; opts?: unknown }> = [];

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: (name: string, value: string, opts?: unknown) => setCookies.push({ name, value, opts }),
    delete: () => {},
  }),
}));

import { POST as login } from "../login/route";
import { resetLoginRateLimitForTests } from "../loginRateLimit";

function testScrypt(password: string): string {
  const salt = Buffer.alloc(16, 7);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt:16384:8:1:${salt.toString("base64url")}:${hash.toString("base64url")}`;
}

function makeReq(body: unknown, ip = "203.0.113.10"): import("next/server").NextRequest {
  return {
    json: async () => body,
    headers: new Headers({ "cf-connecting-ip": ip }),
  } as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  setCookies = [];
  process.env.VEXA_ADMIN_API_URL = "http://admin.test";
  process.env.VEXA_ADMIN_API_KEY = "admin-secret";
  process.env.VEXA_DIRECT_LOGIN_EMAILS = "test-a@b.com,test-new@b.com";
  process.env.VEXA_DIRECT_LOGIN_PASSWORD_SCRYPT = testScrypt("test-password");
  process.env.VEXA_LOGIN_CLIENT_FAILURE_LIMIT = "5";
  process.env.VEXA_LOGIN_GLOBAL_FAILURE_LIMIT = "30";
  resetLoginRateLimitForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("/api/auth/login — direct email login against a mocked admin-api", () => {
  it("fails closed when direct login is not explicitly enabled", async () => {
    delete process.env.VEXA_DIRECT_LOGIN_EMAILS;
    delete process.env.VEXA_DIRECT_LOGIN_PASSWORD_SCRYPT;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await login(makeReq({ email: "test-a@b.com", password: "test-password" }));
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(setCookies).toEqual([]);
  });

  it("rejects an incorrect password without calling admin-api", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await login(makeReq({ email: "test-a@b.com", password: "wrong" }));
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(setCookies).toEqual([]);
  });

  it("reserves concurrent per-client attempts before scrypt verification", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const responses = await Promise.all(Array.from({ length: 6 }, () =>
      login(makeReq({ email: "test-a@b.com", password: "wrong" })),
    ));
    expect(responses.filter((res) => res.status === 403)).toHaveLength(5);
    expect(responses.filter((res) => res.status === 429)).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reserves concurrent global attempts across distinct clients", async () => {
    process.env.VEXA_LOGIN_CLIENT_FAILURE_LIMIT = "10";
    process.env.VEXA_LOGIN_GLOBAL_FAILURE_LIMIT = "3";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const responses = await Promise.all(Array.from({ length: 4 }, (_, index) =>
      login(makeReq({ email: "test-a@b.com", password: "wrong" }, `203.0.113.${index + 1}`)),
    ));
    expect(responses.filter((res) => res.status === 403)).toHaveLength(3);
    expect(responses.filter((res) => res.status === 429)).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("releases reservations after successful logins", async () => {
    process.env.VEXA_LOGIN_GLOBAL_FAILURE_LIMIT = "1";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/admin/users/email/")) {
        return new Response(JSON.stringify({ id: 42, email: "test-a@b.com", name: "A" }), { status: 200 });
      }
      if (url.includes("/tokens")) {
        return new Response(JSON.stringify({ token: "minted-tok" }), { status: 200 });
      }
      return new Response("nope", { status: 500 });
    }));

    const first = await login(makeReq({ email: "test-a@b.com", password: "test-password" }));
    const second = await login(makeReq({ email: "test-a@b.com", password: "test-password" }));
    expect([first.status, second.status]).toEqual([200, 200]);
  });

  it("finds an existing user, mints a token, and sets both cookies", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method || "GET"} ${url}`);
        if (url.includes("/admin/users/email/")) {
          return new Response(JSON.stringify({ id: 42, email: "test-a@b.com", name: "A" }), { status: 200 });
        }
        if (url.includes("/tokens")) {
          return new Response(JSON.stringify({ token: "minted-tok" }), { status: 200 });
        }
        return new Response("nope", { status: 500 });
      }),
    );

    const res = await login(makeReq({ email: "test-a@b.com", password: "test-password" }));
    expect(res.status).toBe(200);

    // No create call — user already existed.
    expect(calls.some((c) => c.includes("/admin/users/email/"))).toBe(true);
    expect(calls.some((c) => c.startsWith("POST") && c.endsWith("/admin/users"))).toBe(false);
    expect(calls.some((c) => c.includes("/tokens"))).toBe(true);
    // an EXISTING user is not re-provisioned (eager provisioning fires only on account creation)
    expect(calls.some((c) => c.includes("/agent/workspace/init"))).toBe(false);

    const tok = setCookies.find((c) => c.name === "vexa-token");
    const info = setCookies.find((c) => c.name === "vexa-user-info");
    expect(tok?.value).toBe("minted-tok");
    expect(JSON.parse(info!.value)).toEqual({ email: "test-a@b.com", name: "A" });
    expect((tok?.opts as { httpOnly?: boolean })?.httpOnly).toBe(true);
  });

  it("rejects a non-test email (debug-only path) without calling admin-api", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await login(makeReq({ email: "real@company.com" }));
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("creates the user when admin-api returns 404, then mints a token", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method || "GET"} ${url}`);
        if (url.includes("/admin/users/email/")) return new Response("not found", { status: 404 });
        if (init?.method === "POST" && url.endsWith("/admin/users")) {
          return new Response(JSON.stringify({ id: 7, email: "test-new@b.com" }), { status: 201 });
        }
        if (url.includes("/tokens")) return new Response(JSON.stringify({ token: "tok-7" }), { status: 200 });
        return new Response("nope", { status: 500 });
      }),
    );

    const res = await login(makeReq({ email: "test-new@b.com", password: "test-password" }));
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.startsWith("POST") && c.endsWith("/admin/users"))).toBe(true);
    expect(setCookies.find((c) => c.name === "vexa-token")?.value).toBe("tok-7");
    // a NEW account eagerly provisions the agent workspace over the gateway (best-effort — a 500 here
    // is swallowed, so sign-in still succeeds above); it authenticates with the freshly minted token
    const provision = calls.find((c) => c.includes("/agent/workspace/init"));
    expect(provision).toBeTruthy();
    expect(provision!.startsWith("POST")).toBe(true);
  });

  it("rejects a malformed email without calling admin-api", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await login(makeReq({ email: "not-an-email" }));
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
