import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Provider } from "../../core/provider.js";
import { loadConfig } from "./config.js";
import { readToken } from "./auth.js";
import { getDrive } from "./drive.js";
import type { ToolContext } from "./tools/common.js";
import { registerSearchTool } from "./tools/search.js";
import { registerReadTool } from "./tools/read.js";
import { registerCreateTool } from "./tools/create.js";
import { registerUpdateTool } from "./tools/update.js";

export const gdriveProvider: Provider = {
  id: "gdrive",
  title: "Google Drive",
  instructions:
    "gdrive_*: Google Drive của người dùng. gdrive_search lấy fileId → gdrive_read → gdrive_create / gdrive_update. " +
    "Xác nhận với người dùng trước khi ghi đè (mode=replace) hoặc chuyển file vào Thùng rác.",
  status() {
    const config = loadConfig();
    if (!config.clientId || !config.clientSecret) {
      return { configured: false, detail: "Thiếu GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (OAuth Desktop app)" };
    }
    return readToken(config.tokenPath)
      ? { configured: true, detail: `đã đăng nhập (token ${config.tokenPath})${config.readOnly ? ", chỉ-đọc" : ""}` }
      : { configured: false, detail: "chưa đăng nhập — chạy `npm run auth`" };
  },
  register(server: McpServer) {
    const config = loadConfig();
    const ctx: ToolContext = { config, drive: () => getDrive(config) };
    registerSearchTool(server, ctx);
    registerReadTool(server, ctx);
    registerCreateTool(server, ctx);
    registerUpdateTool(server, ctx);
  },
};
