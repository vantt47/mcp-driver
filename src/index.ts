#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { log, runInteractiveAuth, readToken } from "./auth.js";
import { getDrive } from "./drive.js";
import type { ToolContext } from "./tools/common.js";
import { registerSearchTool } from "./tools/search.js";
import { registerReadTool } from "./tools/read.js";
import { registerCreateTool } from "./tools/create.js";
import { registerUpdateTool } from "./tools/update.js";

const VERSION = "1.0.0";

export function createServer(): McpServer {
  const config = loadConfig();

  const server = new McpServer(
    { name: "mcp-gdrive", version: VERSION },
    {
      instructions:
        "Server này thao tác với Google Drive của người dùng.\n" +
        "Quy trình thường dùng: gdrive_search để tìm fileId → gdrive_read để xem nội dung → " +
        "gdrive_create để tạo mới hoặc gdrive_update để sửa.\n" +
        "Luôn dùng fileId trả về từ gdrive_search thay vì đoán. " +
        "Trước khi ghi đè (gdrive_update mode=replace) hoặc chuyển file vào Thùng rác, hãy xác nhận lại với người dùng.",
    },
  );

  const ctx: ToolContext = {
    config,
    drive: () => getDrive(config),
  };

  registerSearchTool(server, ctx);
  registerReadTool(server, ctx);
  registerCreateTool(server, ctx);
  registerUpdateTool(server, ctx);

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
        "mcp-gdrive — MCP server cho Google Drive",
        "",
        "Cách dùng:",
        "  mcp-gdrive            Chạy MCP server qua stdio (dùng bởi Claude Desktop/Code)",
        "  mcp-gdrive --auth     Mở trình duyệt để đăng nhập Google và lưu refresh token",
        "  mcp-gdrive --check    Kiểm tra cấu hình & trạng thái đăng nhập",
        "",
        "Tools: gdrive_search, gdrive_read, gdrive_create, gdrive_update",
      ].join("\n"),
    );
    return;
  }

  if (argv.includes("--auth")) {
    const config = loadConfig();
    await runInteractiveAuth(config);
    log(`Xong. Token đã lưu tại ${config.tokenPath}`);
    return;
  }

  if (argv.includes("--check")) {
    const config = loadConfig();
    const token = readToken(config.tokenPath);
    console.log(
      [
        `Client ID    : ${config.clientId ? config.clientId.slice(0, 18) + "…" : "❌ CHƯA ĐẶT"}`,
        `Client Secret: ${config.clientSecret ? "✓ đã đặt" : "❌ CHƯA ĐẶT"}`,
        `Token path   : ${config.tokenPath} ${token ? "✓ đã đăng nhập" : "❌ chưa đăng nhập (chạy: npm run auth)"}`,
        `Scopes       : ${config.scopes.join(" ")}`,
        `Root folder  : ${config.rootFolderId ?? "(toàn bộ Drive)"}`,
        `Read-only    : ${config.readOnly}`,
      ].join("\n"),
    );
    return;
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`mcp-gdrive v${VERSION} đã sẵn sàng (stdio).`);
}

main().catch((err) => {
  log("Lỗi nghiêm trọng:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
