import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  FILE_FIELDS,
  GOOGLE_MIME,
  describeFile,
  exportTargetFor,
  isGoogleDoc,
  normalizeFileId,
} from "../drive.js";
import {
  ToolContext,
  assertWritable,
  bufferToStream,
  downloadBuffer,
  exportBuffer,
  getMetadata,
  safeHandler,
  textResult,
} from "./common.js";

export const updateInputSchema = {
  file_id: z.string().describe("File ID hoặc URL của file cần cập nhật."),
  content: z
    .string()
    .optional()
    .describe("Nội dung mới (text/Markdown/CSV). Bỏ trống nếu chỉ đổi metadata."),
  content_base64: z
    .string()
    .optional()
    .describe("Nội dung nhị phân mới dạng base64 (thay cho `content`). Chỉ dùng với mode=replace."),
  mode: z
    .enum(["replace", "append", "prepend"])
    .optional()
    .default("replace")
    .describe(
      "replace = ghi đè toàn bộ; append = thêm vào cuối; prepend = thêm vào đầu. " +
        "append/prepend sẽ đọc nội dung hiện tại trước rồi ghi lại.",
    ),
  content_mime_type: z
    .string()
    .optional()
    .describe(
      "MIME của nội dung gửi lên, ví dụ text/markdown, text/plain, text/csv. Mặc định suy ra từ loại file đích.",
    ),
  new_name: z.string().optional().describe("Đổi tên file."),
  description: z.string().optional().describe("Cập nhật mô tả."),
  move_to_folder_id: z
    .string()
    .optional()
    .describe("Di chuyển file sang folder này (gỡ khỏi tất cả folder cha hiện tại)."),
  add_parent_id: z.string().optional().describe("Thêm một folder cha (không gỡ folder cũ)."),
  remove_parent_id: z.string().optional().describe("Gỡ file khỏi một folder cha."),
  trashed: z
    .boolean()
    .optional()
    .describe("true = chuyển vào Thùng rác; false = khôi phục khỏi Thùng rác."),
  starred: z.boolean().optional().describe("Gắn/bỏ gắn sao."),
};

type UpdateArgs = {
  file_id: string;
  content?: string;
  content_base64?: string;
  mode?: "replace" | "append" | "prepend";
  content_mime_type?: string;
  new_name?: string;
  description?: string;
  move_to_folder_id?: string;
  add_parent_id?: string;
  remove_parent_id?: string;
  trashed?: boolean;
  starred?: boolean;
};

export function registerUpdateTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "gdrive_update",
    {
      title: "Cập nhật file trên Google Drive",
      description:
        "Cập nhật một file đã có: ghi đè / nối thêm nội dung, đổi tên, đổi mô tả, di chuyển sang folder khác, " +
        "gắn sao, hoặc chuyển vào/khôi phục khỏi Thùng rác. Với Google Docs/Sheets, nội dung Markdown/CSV sẽ được convert lại.",
      inputSchema: updateInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    safeHandler(async (args: UpdateArgs) => {
      assertWritable(ctx.config);
      const drive = ctx.drive();
      const fileId = normalizeFileId(args.file_id);
      const mode = args.mode ?? "replace";

      const meta = await getMetadata(drive, fileId);
      const isGoogle = isGoogleDoc(meta.mimeType);
      const changes: string[] = [];

      // ---- Metadata --------------------------------------------------------
      const requestBody: Record<string, unknown> = {};
      if (args.new_name) {
        requestBody.name = args.new_name;
        changes.push(`đổi tên → "${args.new_name}"`);
      }
      if (args.description !== undefined) {
        requestBody.description = args.description;
        changes.push("cập nhật mô tả");
      }
      if (args.trashed !== undefined) {
        requestBody.trashed = args.trashed;
        changes.push(args.trashed ? "chuyển vào Thùng rác" : "khôi phục khỏi Thùng rác");
      }
      if (args.starred !== undefined) {
        requestBody.starred = args.starred;
        changes.push(args.starred ? "gắn sao" : "bỏ gắn sao");
      }

      let addParents: string | undefined;
      let removeParents: string | undefined;
      if (args.move_to_folder_id) {
        addParents = normalizeFileId(args.move_to_folder_id);
        removeParents = (meta.parents ?? []).join(",") || undefined;
        changes.push(`di chuyển sang folder ${addParents}`);
      } else {
        if (args.add_parent_id) {
          addParents = normalizeFileId(args.add_parent_id);
          changes.push(`thêm folder cha ${addParents}`);
        }
        if (args.remove_parent_id) {
          removeParents = normalizeFileId(args.remove_parent_id);
          changes.push(`gỡ khỏi folder ${removeParents}`);
        }
      }

      // ---- Nội dung --------------------------------------------------------
      let media: { mimeType: string; body: NodeJS.ReadableStream } | undefined;

      if (args.content_base64 !== undefined) {
        if (mode !== "replace") {
          throw new Error("content_base64 chỉ hỗ trợ mode=replace.");
        }
        media = {
          mimeType: args.content_mime_type ?? meta.mimeType ?? "application/octet-stream",
          body: bufferToStream(Buffer.from(args.content_base64, "base64")),
        };
        changes.push("ghi đè nội dung nhị phân");
      } else if (args.content !== undefined) {
        const uploadMime =
          args.content_mime_type ??
          (isGoogle
            ? (exportTargetFor(meta.mimeType!)?.mimeType ?? "text/plain")
            : (meta.mimeType ?? "text/plain"));

        let finalText = args.content;

        if (mode !== "replace") {
          const current = isGoogle
            ? (await exportBuffer(drive, fileId, uploadMime)).toString("utf8")
            : (await downloadBuffer(drive, fileId)).toString("utf8");
          finalText =
            mode === "append" ? `${current}\n${args.content}` : `${args.content}\n${current}`;
        }

        // Giữ nguyên loại Google Docs/Sheets khi ghi đè để Drive convert lại.
        if (isGoogle) requestBody.mimeType = meta.mimeType;

        media = { mimeType: uploadMime, body: bufferToStream(Buffer.from(finalText, "utf8")) };
        changes.push(
          mode === "replace"
            ? "ghi đè nội dung"
            : mode === "append"
              ? "nối thêm nội dung vào cuối"
              : "chèn nội dung vào đầu",
        );
      }

      if (!media && Object.keys(requestBody).length === 0 && !addParents && !removeParents) {
        throw new Error(
          "Không có gì để cập nhật. Hãy cung cấp ít nhất một trong: content, new_name, description, move_to_folder_id, trashed, starred.",
        );
      }

      const doUpdate = async (m?: typeof media) =>
        drive.files.update({
          fileId,
          requestBody,
          media: m,
          addParents,
          removeParents,
          fields: FILE_FIELDS,
          supportsAllDrives: true,
        });

      let res;
      try {
        res = await doUpdate(media);
      } catch (err) {
        if (media?.mimeType === "text/markdown" && meta.mimeType === GOOGLE_MIME.doc) {
          // Fallback khi tài khoản chưa hỗ trợ markdown import.
          res = await doUpdate({ mimeType: "text/plain", body: media.body });
        } else {
          throw err;
        }
      }

      return textResult(
        `✅ Đã cập nhật (${changes.join(", ")}):\n\n${describeFile(res.data)}`,
        {
          id: res.data.id,
          name: res.data.name,
          mimeType: res.data.mimeType,
          webViewLink: res.data.webViewLink,
          changes,
        },
      );
    }),
  );
}
