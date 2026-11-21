import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  FILE_FIELDS,
  GOOGLE_MIME,
  collectFolderTree,
  describeFile,
  escapeQuery,
  normalizeFileId,
} from "../drive.js";
import { ToolContext, safeHandler, textResult } from "./common.js";

const MIME_ALIASES: Record<string, string> = {
  document: GOOGLE_MIME.doc,
  doc: GOOGLE_MIME.doc,
  docs: GOOGLE_MIME.doc,
  spreadsheet: GOOGLE_MIME.sheet,
  sheet: GOOGLE_MIME.sheet,
  presentation: GOOGLE_MIME.slide,
  slides: GOOGLE_MIME.slide,
  folder: GOOGLE_MIME.folder,
  pdf: "application/pdf",
  image: "image/",
  video: "video/",
  csv: "text/csv",
  txt: "text/plain",
  markdown: "text/markdown",
};

export const searchInputSchema = {
  query: z
    .string()
    .optional()
    .describe(
      "Từ khoá tìm trong tên VÀ nội dung file (full-text). Bỏ trống nếu chỉ muốn liệt kê theo bộ lọc khác.",
    ),
  name_contains: z
    .string()
    .optional()
    .describe("Chỉ tìm theo tên file chứa chuỗi này (chính xác hơn `query`)."),
  mime_type: z
    .string()
    .optional()
    .describe(
      "Lọc theo loại file. Chấp nhận alias: document, spreadsheet, presentation, folder, pdf, image, video, csv, txt, markdown — hoặc MIME type đầy đủ.",
    ),
  folder_id: z
    .string()
    .optional()
    .describe("Chỉ tìm các mục nằm trực tiếp trong folder này (ID hoặc URL folder)."),
  modified_after: z
    .string()
    .optional()
    .describe("Chỉ lấy file sửa sau thời điểm này, dạng RFC3339, ví dụ 2026-01-01T00:00:00Z."),
  include_trashed: z.boolean().optional().default(false).describe("Bao gồm file trong Thùng rác."),
  order_by: z
    .enum(["relevance", "modifiedTime desc", "modifiedTime", "name", "createdTime desc", "quotaBytesUsed desc"])
    .optional()
    .default("modifiedTime desc")
    .describe("Thứ tự sắp xếp. `relevance` chỉ có ý nghĩa khi có `query`."),
  page_size: z.number().int().min(1).max(100).optional().default(20).describe("Số kết quả tối đa."),
  page_token: z.string().optional().describe("Token trang tiếp theo, lấy từ kết quả trước."),
  raw_query: z
    .string()
    .optional()
    .describe(
      "Chuỗi truy vấn thô theo cú pháp Drive API v3 (ghi đè toàn bộ bộ lọc trên). Ví dụ: \"name contains 'báo cáo' and mimeType != 'application/vnd.google-apps.folder'\".",
    ),
};

type SearchArgs = {
  query?: string;
  name_contains?: string;
  mime_type?: string;
  folder_id?: string;
  modified_after?: string;
  include_trashed?: boolean;
  order_by?: string;
  page_size?: number;
  page_token?: string;
  raw_query?: string;
};

export function registerSearchTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "gdrive_search",
    {
      title: "Tìm file trên Google Drive",
      description:
        "Tìm kiếm file/folder trên Google Drive theo từ khoá (full-text), tên, loại file, folder cha hoặc thời gian sửa đổi. " +
        "Trả về tên, fileId, loại, kích thước, thời gian sửa và link. Dùng fileId thu được cho gdrive_read / gdrive_update.",
      inputSchema: searchInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safeHandler(async (args: SearchArgs) => {
      const drive = ctx.drive();
      const clauses: string[] = [];

      if (args.raw_query) {
        clauses.push(`(${args.raw_query})`);
      } else {
        if (args.query) clauses.push(`fullText contains '${escapeQuery(args.query)}'`);
        if (args.name_contains) clauses.push(`name contains '${escapeQuery(args.name_contains)}'`);

        if (args.mime_type) {
          const resolved = MIME_ALIASES[args.mime_type.toLowerCase()] ?? args.mime_type;
          clauses.push(
            resolved.endsWith("/")
              ? `mimeType contains '${escapeQuery(resolved)}'`
              : `mimeType = '${escapeQuery(resolved)}'`,
          );
        }

        if (args.folder_id) {
          clauses.push(`'${escapeQuery(normalizeFileId(args.folder_id))}' in parents`);
        } else if (ctx.config.rootFolderId) {
          // Giới hạn phạm vi trong cây folder gốc đã cấu hình.
          const folders = await collectFolderTree(drive, ctx.config.rootFolderId);
          clauses.push(
            `(${folders.map((id) => `'${escapeQuery(id)}' in parents`).join(" or ")})`,
          );
        }

        if (args.modified_after) clauses.push(`modifiedTime > '${escapeQuery(args.modified_after)}'`);
      }

      if (!args.include_trashed) clauses.push("trashed = false");

      const q = clauses.join(" and ") || undefined;
      const orderBy = args.order_by === "relevance" ? undefined : args.order_by;

      const res = await drive.files.list({
        q,
        orderBy,
        pageSize: args.page_size ?? 20,
        pageToken: args.page_token,
        fields: `nextPageToken, files(${FILE_FIELDS})`,
        spaces: "drive",
        corpora: "allDrives",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      const files = res.data.files ?? [];
      if (files.length === 0) {
        return textResult(
          `Không tìm thấy file nào.\nTruy vấn Drive đã dùng: ${q ?? "(không có bộ lọc)"}`,
          { count: 0, files: [], query: q ?? null },
        );
      }

      const lines = [
        `Tìm thấy ${files.length} kết quả${res.data.nextPageToken ? " (còn trang tiếp theo)" : ""}:`,
        "",
        ...files.map(describeFile),
      ];
      if (res.data.nextPageToken) {
        lines.push("", `page_token trang sau: ${res.data.nextPageToken}`);
      }

      return textResult(lines.join("\n"), {
        count: files.length,
        query: q ?? null,
        nextPageToken: res.data.nextPageToken ?? null,
        files: files.map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: f.size ?? null,
          modifiedTime: f.modifiedTime ?? null,
          webViewLink: f.webViewLink ?? null,
        })),
      });
    }),
  );
}
