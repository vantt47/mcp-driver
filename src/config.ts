import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Nạp file .env một cách "thủ công" để không cần thêm dependency.
 * Thứ tự ưu tiên: biến môi trường thật > .env ở thư mục hiện tại > .env cạnh package.
 * Biến đã tồn tại trong process.env sẽ KHÔNG bị ghi đè (để cấu hình trong
 * claude_desktop_config.json luôn thắng file .env).
 */
function loadDotEnv(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(here, "..", ".env"), // dist/../.env
    path.resolve(here, "..", "..", ".env"),
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
    break; // chỉ nạp file .env đầu tiên tìm thấy
  }
}

loadDotEnv();

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

export const DEFAULT_SCOPES = ["https://www.googleapis.com/auth/drive"];

export interface Config {
  clientId: string;
  clientSecret: string;
  tokenPath: string;
  oauthPort: number;
  scopes: string[];
  rootFolderId?: string;
  readOnly: boolean;
  maxReadBytes: number;
}

export function loadConfig(): Config {
  const tokenPath =
    process.env.GDRIVE_TOKEN_PATH ??
    path.join(os.homedir(), ".mcp-gdrive", "token.json");

  const scopes = (process.env.GDRIVE_SCOPES ?? DEFAULT_SCOPES.join(" "))
    .split(/[\s,]+/)
    .filter(Boolean);

  return {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    tokenPath,
    oauthPort: int(process.env.GDRIVE_OAUTH_PORT, 0),
    scopes,
    rootFolderId: process.env.GDRIVE_ROOT_FOLDER_ID || undefined,
    readOnly: bool(process.env.GDRIVE_READ_ONLY, false),
    maxReadBytes: int(process.env.GDRIVE_MAX_READ_BYTES, 1_000_000),
  };
}

export function assertOAuthCredentials(config: Config): void {
  if (!config.clientId || !config.clientSecret) {
    throw new Error(
      "Thiếu GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. " +
        "Hãy tạo OAuth client loại 'Desktop app' trong Google Cloud Console, " +
        "rồi điền vào file .env (xem .env.example) hoặc vào phần \"env\" trong config MCP.",
    );
  }
}
