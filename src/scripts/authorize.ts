#!/usr/bin/env node
/**
 * Chạy: npm run auth
 * Mở trình duyệt để đăng nhập Google, xin quyền Drive, và lưu refresh token
 * vào GDRIVE_TOKEN_PATH (mặc định ~/.mcp-gdrive/token.json).
 */
import { google } from "googleapis";
import { loadConfig, assertOAuthCredentials } from "../config.js";
import { runInteractiveAuth, readToken, getAuthenticatedClient } from "../auth.js";

async function main() {
  const config = loadConfig();

  try {
    assertOAuthCredentials(config);
  } catch (err) {
    console.error(`\n❌ ${(err as Error).message}\n`);
    process.exit(1);
  }

  if (readToken(config.tokenPath) && !process.argv.includes("--force")) {
    console.log(
      `ℹ️  Đã có token tại ${config.tokenPath}. Dùng "npm run auth -- --force" để đăng nhập lại.`,
    );
  } else {
    console.log("→ Đang mở trình duyệt để cấp quyền Google Drive...\n");
    await runInteractiveAuth(config);
    console.log(`\n✅ Đã lưu token tại ${config.tokenPath}`);
  }

  // Kiểm tra nhanh: gọi thử Drive API.
  try {
    const drive = google.drive({ version: "v3", auth: getAuthenticatedClient(config) });
    const about = await drive.about.get({ fields: "user(displayName,emailAddress), storageQuota(usage,limit)" });
    const user = about.data.user;
    console.log(`✅ Kết nối thành công với tài khoản: ${user?.displayName} <${user?.emailAddress}>`);

    const files = await drive.files.list({
      pageSize: 3,
      orderBy: "modifiedTime desc",
      fields: "files(name, mimeType)",
      q: "trashed = false",
    });
    console.log("\n3 file mới sửa gần nhất:");
    for (const f of files.data.files ?? []) console.log(`  • ${f.name}`);
    console.log("\nGiờ bạn có thể thêm server vào Claude Desktop / Claude Code (xem README).");
  } catch (err) {
    console.error("\n⚠️  Token đã lưu nhưng gọi thử Drive API thất bại:");
    console.error((err as Error).message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌", err instanceof Error ? err.message : err);
  process.exit(1);
});
