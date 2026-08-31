type Counter = { windowStartedAt: number; failures: number; reserved: number };
export type LoginReservation = { client: Counter; global: Counter };

let globalCounter: Counter = { windowStartedAt: 0, failures: 0, reserved: 0 };
const clientCounters = new Map<string, Counter>();

function positiveInt(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function windowMs(): number {
  return positiveInt("VEXA_LOGIN_RATE_WINDOW_SECONDS", 900, 86400) * 1000;
}

function current(counter: Counter, now: number): Counter {
  if (now - counter.windowStartedAt >= windowMs()) {
    counter.windowStartedAt = now;
    counter.failures = 0;
    counter.reserved = 0;
  }
  return counter;
}

export function reserveLoginAttempt(clientKey: string, now = Date.now()): LoginReservation | null {
  const global = current(globalCounter, now);
  let client = clientCounters.get(clientKey);
  if (!client) {
    client = { windowStartedAt: now, failures: 0, reserved: 0 };
    clientCounters.set(clientKey, client);
  }
  current(client, now);

  const globalLimit = positiveInt("VEXA_LOGIN_GLOBAL_FAILURE_LIMIT", 30, 10000);
  const clientLimit = positiveInt("VEXA_LOGIN_CLIENT_FAILURE_LIMIT", 5, 1000);
  if (global.failures + global.reserved >= globalLimit) return null;
  if (client.failures + client.reserved >= clientLimit) return null;

  // Reserve synchronously before the asynchronous memory-hard verifier starts.
  global.reserved += 1;
  client.reserved += 1;
  return { client, global };
}

export function finishLoginAttempt(reservation: LoginReservation, success: boolean): void {
  reservation.global.reserved = Math.max(0, reservation.global.reserved - 1);
  reservation.client.reserved = Math.max(0, reservation.client.reserved - 1);
  if (success) {
    reservation.client.failures = 0;
    return;
  }
  reservation.global.failures += 1;
  reservation.client.failures += 1;
}

export function loginRetryAfterSeconds(): number {
  return Math.ceil(windowMs() / 1000);
}

export function resetLoginRateLimitForTests(): void {
  globalCounter = { windowStartedAt: 0, failures: 0, reserved: 0 };
  clientCounters.clear();
}
