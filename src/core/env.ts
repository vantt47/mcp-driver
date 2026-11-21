import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Nạp file .env "thủ công" để không cần thêm dependency.
 * Thứ tự ưu tiên: biến môi trường thật > .env cạnh package > .env ở thư mục hiện tại.
 * Biến đã tồn tại trong process.env KHÔNG bị ghi đè (cấu hình "env" trong config MCP luôn thắng).
 */
function loadDotEnv(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Ưu tiên .env của chính mcp-platform: server đăng ký cấp user sẽ chạy với cwd là
  // dự án đang mở, .env của dự án đó không phải cấu hình của server.
  const candidates = [
    path.resolve(here, "..", "..", ".env"), // dist/core/../../.env
    path.resolve(here, "..", "..", "..", ".env"),
    path.resolve(process.cwd(), ".env"),
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseDotEnv(fs.readFileSync(file, "utf8")))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
    break; // chỉ nạp file .env đầu tiên tìm thấy
  }
}

export function parseDotEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

loadDotEnv();

const registryCache = new Map<string, string | undefined>();

/**
 * Đọc biến môi trường. Trên Windows, nếu process không có (VD: VS Code mở trước khi
 * biến được `setx`), đọc thẳng từ HKCU\Environment để lấy giá trị mới nhất.
 */
export function readEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const v = process.env[name];
    if (v) return v;
  }
  if (process.platform !== "win32") return undefined;
  for (const name of names) {
    if (!registryCache.has(name)) {
      let value: string | undefined;
      try {
        const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", name], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        });
        const m = out.match(new RegExp(`${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)`));
        value = m?.[1]?.trim() || undefined;
      } catch {
        value = undefined;
      }
      registryCache.set(name, value);
    }
    const v = registryCache.get(name);
    if (v) return v;
  }
  return undefined;
}

export function envBool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

export function envInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Chế độ chỉ-đọc toàn cục: chặn mọi tool ghi/tạo/xoá ở tầng server. */
export function globalReadOnly(): boolean {
  return envBool(process.env.MCP_READ_ONLY, false);
}

export function assertWritable(extraFlag = false, flagName = "MCP_READ_ONLY"): void {
  if (globalReadOnly() || extraFlag) {
    throw new Error(
      `Server đang chạy ở chế độ chỉ-đọc (${globalReadOnly() ? "MCP_READ_ONLY" : flagName}=true). Không thể thực hiện thao tác ghi.`,
    );
  }
}
