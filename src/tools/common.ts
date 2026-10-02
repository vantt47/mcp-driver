import { Readable } from "node:stream";
import { Config } from "../config.js";
import { Drive, DriveFile, FILE_FIELDS, explainDriveError, normalizeFileId } from "../drive.js";

export interface ToolContext {
  config: Config;
  /** Lazy: chỉ khởi tạo Drive client khi tool thực sự được gọi. */
  drive: () => Drive;
}

/** Kết quả trả về cho MCP (content blocks). */
export type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

export function textResult(text: string, structured?: Record<string, unknown>): ToolResult {
  return structured
    ? { content: [{ type: "text", text }], structuredContent: structured }
    : { content: [{ type: "text", text }] };
}

export function errorResult(err: unknown): ToolResult {
  return {
    content: [{ type: "text", text: `❌ ${explainDriveError(err)}` }],
    isError: true,
  };
}

/** Bọc handler để mọi lỗi đều trả về dạng isError thay vì làm sập server. */
export function safeHandler<A>(fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      return errorResult(err);
    }
  };
}

export function assertWritable(config: Config): void {
  if (config.readOnly) {
    throw new Error(
      "Server đang chạy ở chế độ chỉ-đọc (GDRIVE_READ_ONLY=true). Không thể tạo/sửa file.",
    );
  }
}

export async function getMetadata(drive: Drive, fileId: string): Promise<DriveFile> {
  const res = await drive.files.get({
    fileId: normalizeFileId(fileId),
    fields: FILE_FIELDS,
    supportsAllDrives: true,
  });
  return res.data;
}

/** Tải nội dung nhị phân của file (không phải Google Docs). */
export async function downloadBuffer(drive: Drive, fileId: string): Promise<Buffer> {
  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" },
  );
  return Buffer.from(res.data as ArrayBuffer);
}

/** Export tài liệu Google Workspace sang một MIME type khác. */
export async function exportBuffer(
  drive: Drive,
  fileId: string,
  mimeType: string,
): Promise<Buffer> {
  const res = await drive.files.export(
    { fileId, mimeType },
    { responseType: "arraybuffer" },
  );
  return Buffer.from(res.data as ArrayBuffer);
}

export function bufferToStream(buffer: Buffer): Readable {
  return Readable.from(buffer);
}

export function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  return {
    text: buf.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}
