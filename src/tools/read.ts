import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  GOOGLE_MIME,
  exportTargetFor,
  formatBytes,
  isGoogleDoc,
  isTextLike,
  normalizeFileId,
  shortMime,
} from "../drive.js";
import {
  ToolContext,
  ToolResult,
  downloadBuffer,
  exportBuffer,
  getMetadata,
  safeHandler,
  textResult,
  truncate,
} from "./common.js";

export const readInputSchema = {
  file_id: z
    .string()
    .describe("File ID hoặc URL Google Drive/Docs của file cần đọc (lấy từ gdrive_search)."),
  export_mime_type: z
    .string()
    .optional()
    .describe(
      "Chỉ dùng cho tài liệu Google Workspace. Định dạng export mong muốn, ví dụ text/markdown, text/plain, text/html, text/csv, application/pdf. " +
        "Mặc định: Docs→markdown, Sheets→csv, Slides→text.",
    ),
  max_bytes: z
    .number()
    .int()
    .min(1000)
    .optional()
    .describe("Số byte tối đa trả về (mặc định lấy từ GDRIVE_MAX_READ_BYTES, ~1MB)."),
  as_base64: z
    .boolean()
    .optional()
    .default(false)
    .describe("Trả về nội dung nhị phân dưới dạng base64 thay vì báo lỗi 'không phải text'."),
};

type ReadArgs = {
  file_id: string;
  export_mime_type?: string;
  max_bytes?: number;
  as_base64?: boolean;
};

export function registerReadTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "gdrive_read",
    {
      title: "Đọc nội dung file trên Google Drive",
      description:
        "Đọc nội dung một file trên Drive. Tài liệu Google Workspace được tự động export sang text " +
        "(Docs→Markdown, Sheets→CSV, Slides→text). File text/JSON/CSV được tải trực tiếp. " +
        "Ảnh trả về dưới dạng hình để xem được; file nhị phân khác cần bật as_base64.",
      inputSchema: readInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safeHandler(async (args: ReadArgs): Promise<ToolResult> => {
      const drive = ctx.drive();
      const fileId = normalizeFileId(args.file_id);
      const maxBytes = args.max_bytes ?? ctx.config.maxReadBytes;

      let meta = await getMetadata(drive, fileId);

      // Shortcut → đi tới file đích.
      if (meta.mimeType === GOOGLE_MIME.shortcut && meta.shortcutDetails?.targetId) {
        meta = await getMetadata(drive, meta.shortcutDetails.targetId);
      }

      const realId = meta.id ?? fileId;
      const header =
        `Tên: ${meta.name}\n` +
        `ID: ${realId}\n` +
        `Loại: ${shortMime(meta.mimeType)}\n` +
        (meta.size ? `Kích thước: ${formatBytes(meta.size)}\n` : "") +
        (meta.modifiedTime ? `Sửa lần cuối: ${meta.modifiedTime}\n` : "") +
        (meta.webViewLink ? `Link: ${meta.webViewLink}\n` : "");

      if (meta.mimeType === GOOGLE_MIME.folder) {
        const children = await drive.files.list({
          q: `'${realId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType, size, modifiedTime)",
          pageSize: 100,
          orderBy: "folder,name",
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        const items = children.data.files ?? [];
        const body = items.length
          ? items
              .map((f) => `• ${f.name} — ${shortMime(f.mimeType)} — id: ${f.id}`)
              .join("\n")
          : "(folder rỗng)";
        return textResult(`${header}\nĐây là một folder, gồm ${items.length} mục:\n\n${body}`);
      }

      // 1) Tài liệu Google Workspace → export
      if (isGoogleDoc(meta.mimeType)) {
        const fallback = exportTargetFor(meta.mimeType!);
        const target = args.export_mime_type ?? fallback?.mimeType;
        if (!target) {
          throw new Error(
            `Không biết export ${meta.mimeType} sang định dạng nào. Hãy chỉ định export_mime_type.`,
          );
        }

        let buffer: Buffer;
        try {
          buffer = await exportBuffer(drive, realId, target);
        } catch (err) {
          if (target === "text/markdown") {
            // Một số tài khoản/loại file chưa hỗ trợ markdown → lùi về text/plain.
            buffer = await exportBuffer(drive, realId, "text/plain");
            const { text, truncated } = truncate(buffer.toString("utf8"), maxBytes);
            return textResult(
              `${header}Export: text/plain (markdown không khả dụng)\n\n---\n${text}${
                truncated ? "\n\n[... đã cắt bớt do vượt giới hạn ...]" : ""
              }`,
            );
          }
          throw err;
        }

        if (target.startsWith("text/") || target.endsWith("+json") || target === "application/json") {
          const { text, truncated } = truncate(buffer.toString("utf8"), maxBytes);
          return textResult(
            `${header}Export: ${target}${fallback && !args.export_mime_type ? ` (${fallback.note})` : ""}\n\n---\n${text}` +
              (truncated ? "\n\n[... đã cắt bớt do vượt giới hạn ...]" : ""),
          );
        }

        return textResult(
          `${header}Export: ${target} — ${formatBytes(buffer.byteLength)} (nhị phân, base64):\n\n` +
            buffer.subarray(0, maxBytes).toString("base64"),
        );
      }

      // 2) File thường
      const buffer = await downloadBuffer(drive, realId);

      if (isTextLike(meta.mimeType)) {
        const { text, truncated } = truncate(buffer.toString("utf8"), maxBytes);
        return textResult(
          `${header}\n---\n${text}` +
            (truncated ? "\n\n[... đã cắt bớt do vượt giới hạn ...]" : ""),
        );
      }

      if (meta.mimeType?.startsWith("image/") && buffer.byteLength <= 5_000_000) {
        return {
          content: [
            { type: "text", text: header },
            { type: "image", data: buffer.toString("base64"), mimeType: meta.mimeType },
          ],
        };
      }

      if (args.as_base64) {
        return textResult(
          `${header}Nội dung nhị phân (base64, ${formatBytes(buffer.byteLength)}):\n\n` +
            buffer.subarray(0, maxBytes).toString("base64"),
        );
      }

      return textResult(
        `${header}\n⚠️ File này là nhị phân (${meta.mimeType}) nên không đọc trực tiếp thành text.\n` +
          `• Nếu là PDF/Office: dùng gdrive_read với export_mime_type sau khi chuyển sang Google Docs, hoặc\n` +
          `• Gọi lại tool này với as_base64 = true để lấy dữ liệu thô.`,
      );
    }),
  );
}
