#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { globalReadOnly } from "./core/env.js";
import { log } from "./core/result.js";
import type { Provider } from "./core/provider.js";
import { gdriveProvider } from "./providers/gdrive/index.js";
import { gcpProvider } from "./providers/gcp/index.js";
import { firebaseProvider } from "./providers/firebase/index.js";
import { cloudflareProvider } from "./providers/cloudflare/index.js";
import { githubProvider } from "./providers/github/index.js";
import { appleProvider } from "./providers/apple/index.js";
import { platformProvider } from "./providers/platform/index.js";
import { loadConfig as loadDriveConfig } from "./providers/gdrive/config.js";
import { runInteractiveAuth } from "./providers/gdrive/auth.js";

const VERSION = "2.0.0";

const ALL: Provider[] = [
  gcpProvider,
  firebaseProvider,
  cloudflareProvider,
  githubProvider,
  appleProvider,
  gdriveProvider,
];

/** MCP_PROVIDERS=gcp,firebase,github (mặc định: tất cả). "platform" luôn bật. */
export function enabledProviders(): Provider[] {
  const raw = (process.env.MCP_PROVIDERS ?? "all").trim().toLowerCase();
  if (!raw || raw === "all" || raw === "*") return ALL;
  const wanted = new Set(raw.split(/[\s,]+/).filter(Boolean));
  const unknown = [...wanted].filter((id) => !ALL.some((p) => p.id === id) && id !== "platform");
  if (unknown.length) log(`Bỏ qua provider không tồn tại: ${unknown.join(", ")}`);
  return ALL.filter((p) => wanted.has(p.id));
}

export function createServer(): McpServer {
  const providers = enabledProviders();
  const platform = platformProvider(() => providers);
  const all = [platform, ...providers];

  const server = new McpServer(
    { name: "mcp-platform", version: VERSION },
    {
      instructions: [
        "Server MCP gom nhiều nền tảng để setup key/config cho dự án: Google Cloud, Firebase, Cloudflare, GitHub, Apple, Google Drive.",
        "Khi người dùng làm tính năng Google Sign-In, push FCM, Sign in with Apple…: gọi platform_setup_guide trước, rồi làm theo các bước.",
        "Bí mật (key, client secret, service-account JSON) chỉ được ghi vào destinations — không in ra chat.",
        "Trước thao tác ghi đè/xoá (DNS, file, secret đã tồn tại) phải xác nhận với người dùng.",
        ...all.map((p) => `- ${p.instructions}`),
      ].join("\n"),
    },
  );

  for (const p of all) p.register(server);
  return server;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(VERSION);
    return;
  }

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      [
        "mcp-platform — MCP server setup key/config đa nền tảng",
        "",
        "Cách dùng:",
        "  mcp-platform            Chạy MCP server qua stdio",
        "  mcp-platform --check    Kiểm tra credential của từng provider",
        "  mcp-platform --auth     Đăng nhập Google Drive (OAuth) và lưu refresh token",
        "",
        `Providers: ${ALL.map((p) => p.id).join(", ")} (chọn bằng MCP_PROVIDERS)`,
      ].join("\n"),
    );
    return;
  }

  if (argv.includes("--auth")) {
    const config = loadDriveConfig();
    await runInteractiveAuth(config);
    log(`Xong. Token đã lưu tại ${config.tokenPath}`);
    return;
  }

  if (argv.includes("--check")) {
    for (const p of enabledProviders()) {
      const s = await p.status();
      console.log(`${s.configured ? "✅" : "⚠️ "} ${p.id.padEnd(10)} ${s.detail}`);
    }
    if (globalReadOnly()) console.log("🔒 MCP_READ_ONLY=true");
    return;
  }

  const server = createServer();
  await server.connect(new StdioServerTransport());
  log(`mcp-platform v${VERSION} sẵn sàng (stdio) — providers: ${enabledProviders().map((p) => p.id).join(", ")}`);
}

main().catch((err) => {
  log("Lỗi nghiêm trọng:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
