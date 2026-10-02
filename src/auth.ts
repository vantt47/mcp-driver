import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { AddressInfo } from "node:net";
import { OAuth2Client, Credentials } from "google-auth-library";
import { Config, assertOAuthCredentials } from "./config.js";

const CALLBACK_PATH = "/oauth2callback";

/** Ghi log ra stderr — stdout được dành riêng cho giao thức MCP (JSON-RPC). */
export function log(...args: unknown[]): void {
  console.error("[mcp-gdrive]", ...args);
}

function redirectUri(port: number): string {
  return `http://localhost:${port}${CALLBACK_PATH}`;
}

export function createOAuthClient(config: Config, port = 0): OAuth2Client {
  assertOAuthCredentials(config);
  return new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: redirectUri(port),
  });
}

export function readToken(tokenPath: string): Credentials | null {
  try {
    if (!fs.existsSync(tokenPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(tokenPath, "utf8")) as Credentials;
    if (!parsed || (!parsed.refresh_token && !parsed.access_token)) return null;
    return parsed;
  } catch (err) {
    log("Không đọc được token file:", (err as Error).message);
    return null;
  }
}

export function writeToken(tokenPath: string, credentials: Credentials): void {
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, JSON.stringify(credentials, null, 2), {
    mode: 0o600,
  });
  try {
    fs.chmodSync(tokenPath, 0o600);
  } catch {
    /* Windows có thể không hỗ trợ chmod — bỏ qua */
  }
}

export class NotAuthenticatedError extends Error {
  constructor(tokenPath: string) {
    super(
      `Chưa đăng nhập Google Drive (không tìm thấy token tại ${tokenPath}).\n` +
        `Hãy chạy:  npm run auth\n` +
        `Lệnh này sẽ mở trình duyệt để bạn đăng nhập và lưu refresh token vào máy.`,
    );
    this.name = "NotAuthenticatedError";
  }
}

/**
 * Trả về OAuth2Client đã nạp sẵn refresh token.
 * Thư viện google-auth-library tự động refresh access token khi hết hạn;
 * ta lắng nghe sự kiện `tokens` để ghi lại token mới xuống đĩa.
 */
export function getAuthenticatedClient(config: Config): OAuth2Client {
  const saved = readToken(config.tokenPath);
  if (!saved) throw new NotAuthenticatedError(config.tokenPath);

  const client = createOAuthClient(config, config.oauthPort || 0);
  client.setCredentials(saved);

  client.on("tokens", (tokens) => {
    const merged: Credentials = {
      ...saved,
      ...tokens,
      // Google chỉ trả refresh_token ở lần cấp quyền đầu tiên — giữ lại cái cũ.
      refresh_token: tokens.refresh_token ?? saved.refresh_token,
    };
    try {
      writeToken(config.tokenPath, merged);
      log("Đã làm mới access token.");
    } catch (err) {
      log("Không ghi được token đã làm mới:", (err as Error).message);
    }
  });

  return client;
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<title>${title}</title><style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e7e9ee;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{max-width:460px;padding:32px 36px;background:#171a21;border:1px solid #262b36;border-radius:14px;text-align:center}
h1{font-size:19px;margin:0 0 10px}p{margin:0;color:#9aa3b2;line-height:1.6;font-size:14px}
</style></head><body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`;
}

/**
 * Chạy luồng OAuth "Desktop app": mở trình duyệt, nhận code qua loopback server,
 * đổi lấy refresh token và lưu xuống đĩa. Dùng PKCE (S256) + state chống CSRF.
 */
export async function runInteractiveAuth(config: Config): Promise<Credentials> {
  assertOAuthCredentials(config);

  const state = crypto.randomBytes(24).toString("hex");
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  return await new Promise<Credentials>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      setTimeout(() => server.close(), 300);
    };

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://localhost`);
        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404).end("Not found");
          return;
        }

        const error = url.searchParams.get("error");
        if (error) {
          res
            .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
            .end(htmlPage("Cấp quyền thất bại", `Google trả về lỗi: ${error}`));
          finish(() => reject(new Error(`OAuth error: ${error}`)));
          return;
        }

        if (url.searchParams.get("state") !== state) {
          res
            .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
            .end(htmlPage("Sai state", "Yêu cầu không hợp lệ, hãy thử lại."));
          finish(() => reject(new Error("State không khớp (nghi ngờ CSRF).")));
          return;
        }

        const code = url.searchParams.get("code");
        if (!code) {
          res.writeHead(400).end("Thiếu authorization code");
          return;
        }

        const port = (server.address() as AddressInfo).port;
        const client = createOAuthClient(config, port);
        const { tokens } = await client.getToken({
          code,
          codeVerifier,
          redirect_uri: redirectUri(port),
        });

        if (!tokens.refresh_token) {
          log(
            "CẢNH BÁO: Google không trả refresh_token. Vào https://myaccount.google.com/permissions, " +
              "gỡ quyền của app rồi chạy lại `npm run auth`.",
          );
        }

        writeToken(config.tokenPath, tokens);

        res
          .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          .end(
            htmlPage(
              "Đã kết nối Google Drive ✓",
              `Token đã được lưu tại <code>${config.tokenPath}</code>.<br>Bạn có thể đóng tab này và quay lại terminal.`,
            ),
          );

        finish(() => resolve(tokens));
      } catch (err) {
        res
          .writeHead(500, { "Content-Type": "text/html; charset=utf-8" })
          .end(htmlPage("Lỗi", String((err as Error).message)));
        finish(() => reject(err as Error));
      }
    });

    server.on("error", (err) => finish(() => reject(err)));

    server.listen(config.oauthPort, "127.0.0.1", async () => {
      const port = (server.address() as AddressInfo).port;
      const client = createOAuthClient(config, port);
      const authUrl = client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent", // buộc Google trả refresh_token
        scope: config.scopes,
        state,
        code_challenge_method: "S256" as never,
        code_challenge: codeChallenge,
      });

      log(`Đang lắng nghe callback tại ${redirectUri(port)}`);
      log("Mở trình duyệt để cấp quyền...");
      log(authUrl);

      try {
        const { default: open } = await import("open");
        await open(authUrl);
      } catch {
        log("Không mở được trình duyệt tự động — hãy copy URL ở trên vào trình duyệt.");
      }
    });

    // Hết hạn sau 5 phút
    setTimeout(
      () => finish(() => reject(new Error("Hết thời gian chờ cấp quyền (5 phút)."))),
      5 * 60_000,
    ).unref?.();
  });
}
