import os from "node:os";
import path from "node:path";
import { envBool as bool, envInt as int, readEnv } from "../../core/env.js";

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
    clientId: readEnv("GDRIVE_CLIENT_ID", "GOOGLE_CLIENT_ID") ?? "",
    clientSecret: readEnv("GDRIVE_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET") ?? "",
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
      "Thiếu GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (hoặc GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET). " +
        "Hãy tạo OAuth client loại 'Desktop app' trong Google Cloud Console, " +
        "rồi điền vào file .env (xem .env.example) hoặc vào phần \"env\" trong config MCP.",
    );
  }
}
