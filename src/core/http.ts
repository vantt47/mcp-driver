import { UserError } from "./result.js";

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

/** fetch JSON đơn giản; ném UserError có thông điệp rõ ràng khi HTTP lỗi. */
export async function fetchJson<T = unknown>(
  service: string,
  url: string,
  opts: HttpOptions = {},
): Promise<{ status: number; data: T }> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
  }
  const res = await fetch(u, {
    method: opts.method ?? "GET",
    headers: {
      Accept: "application/json",
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    throw new UserError(`${service} HTTP ${res.status}: ${summarizeError(data) ?? res.statusText}`);
  }
  return { status: res.status, data: data as T };
}

function summarizeError(data: unknown): string | undefined {
  if (!data) return undefined;
  if (typeof data === "string") return data.slice(0, 500);
  const d = data as {
    message?: string;
    errors?: Array<{ message?: string; detail?: string; title?: string; code?: unknown }>;
  };
  const parts: string[] = [];
  if (d.message) parts.push(d.message);
  for (const e of d.errors ?? []) {
    const m = e.detail ?? e.message ?? e.title;
    if (m) parts.push(e.code !== undefined ? `[${String(e.code)}] ${m}` : m);
  }
  return parts.length ? parts.join("; ") : JSON.stringify(data).slice(0, 500);
}
