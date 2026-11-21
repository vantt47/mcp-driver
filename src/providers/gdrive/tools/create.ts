import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FILE_FIELDS, GOOGLE_MIME, describeFile, normalizeFileId } from "../drive.js";
import {
  ToolContext,
  assertWritable,
  bufferToStream,
  safeHandler,
  textResult,
} from "./common.js";

const DOC_TYPE_MIME: Record<string, string> = {
  file: "",
  document: GOOGLE_MIME.doc,
  spreadsheet: GOOGLE_MIME.sheet,
  presentation: GOOGLE_MIME.slide,
  folder: GOOGLE_MIME.folder,
};

/** MIME của nội dung upload để Drive biết cách convert sang Google Docs/Sheets. */
const SOURCE_MIME: Record<string, string> = {
  document: "text/markdown",
  spreadsheet: "text/csv",
  presentation: "text/plain",
};

export const createInputSchema = {
  name: z.string().min(1).describe("Tên file/folder sẽ tạo."),
  doc_type: z
    .enum(["file", "document", "spreadsheet", "presentation", "folder"])
    .optional()
    .default("file")
    .describe(
      "Loại đối tượng cần tạo. `file` = file thường (giữ nguyên nội dung text/binary). " +
        "`document`/`spreadsheet` = Google Docs/Sheets (nội dung được convert từ markdown/CSV). " +
        "`folder` = thư mục. `presentation` tạo Google Slides (không nhận nội dung text).",
    ),
  content: z
    .string()
    .optional()
    .describe(
      "Nội dung file. Với doc_type=document dùng Markdown; doc_type=spreadsheet dùng CSV. Bỏ trống để tạo file rỗng.",
    ),
  mime_type: z
    .string()
    .optional()
    .describe(
      "MIME type của file khi doc_type=file, ví dụ text/markdown, text/plain, text/csv, application/json. Mặc định text/plain.",
    ),
  parent_folder_id: z
    .string()
    .optional()
    .describe("ID hoặc URL folder cha. Mặc định: GDRIVE_ROOT_FOLDER_ID nếu có, ngược lại My Drive."),
  description: z.string().optional().describe("Mô tả hiển thị trong Drive."),
  content_base64: z
    .string()
    .optional()
    .describe("Nội dung nhị phân dạng base64 (dùng thay cho `content` khi upload ảnh/PDF...)."),
};

type CreateArgs = {
  name: string;
  doc_type?: "file" | "document" | "spreadsheet" | "presentation" | "folder";
  content?: string;
  mime_type?: string;
  parent_folder_id?: string;
  description?: string;
  content_base64?: string;
};

export function registerCreateTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "gdrive_create",
    {
      title: "Tạo file / folder trên Google Drive",
      description:
        "Tạo mới file, folder hoặc tài liệu Google (Docs/Sheets/Slides) trên Drive. " +
        "Nội dung Markdown sẽ được convert thành Google Doc, nội dung CSV thành Google Sheet. " +
        "Trả về fileId và link để mở.",
      inputSchema: createInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safeHandler(async (args: CreateArgs) => {
      assertWritable(ctx.config);
      const drive = ctx.drive();
      const docType = args.doc_type ?? "file";

      const parentId = args.parent_folder_id
        ? normalizeFileId(args.parent_folder_id)
        : ctx.config.rootFolderId;

      const requestBody: Record<string, unknown> = { name: args.name };
      if (args.description) requestBody.description = args.description;
      if (parentId) requestBody.parents = [parentId];

      // --- Folder ---------------------------------------------------------
      if (docType === "folder") {
        requestBody.mimeType = GOOGLE_MIME.folder;
        const res = await drive.files.create({
          requestBody,
          fields: FILE_FIELDS,
          supportsAllDrives: true,
        });
        return textResult(`✅ Đã tạo folder:\n\n${describeFile(res.data)}`, {
          id: res.data.id,
          webViewLink: res.data.webViewLink,
        });
      }

      // --- Nội dung -------------------------------------------------------
      let body: Buffer | null = null;
      let sourceMime = args.mime_type ?? "text/plain";

      if (args.content_base64) {
        body = Buffer.from(args.content_base64, "base64");
        sourceMime = args.mime_type ?? "application/octet-stream";
      } else if (args.content !== undefined) {
        body = Buffer.from(args.content, "utf8");
        if (docType !== "file") sourceMime = args.mime_type ?? SOURCE_MIME[docType];
      }

      const targetMime = DOC_TYPE_MIME[docType];
      if (targetMime) requestBody.mimeType = targetMime; // yêu cầu Drive convert
      else requestBody.mimeType = sourceMime;

      const doCreate = async (uploadMime: string) =>
        drive.files.create({
          requestBody,
          media: body ? { mimeType: uploadMime, body: bufferToStream(body) } : undefined,
          fields: FILE_FIELDS,
          supportsAllDrives: true,
        });

      let res;
      try {
        res = await doCreate(sourceMime);
      } catch (err) {
        // Markdown import chưa bật trên một số tài khoản → lùi về text/plain.
        if (docType === "document" && sourceMime === "text/markdown") {
          res = await doCreate("text/plain");
        } else {
          throw err;
        }
      }

      const note =
        docType === "presentation" && body
          ? "\n\nℹ️ Google Slides không nhận nội dung text khi tạo mới — file được tạo với nội dung thô, hãy chỉnh sửa trực tiếp trong Slides."
          : "";

      return textResult(`✅ Đã tạo file:\n\n${describeFile(res.data)}${note}`, {
        id: res.data.id,
        name: res.data.name,
        mimeType: res.data.mimeType,
        webViewLink: res.data.webViewLink,
      });
    }),
  );
}
