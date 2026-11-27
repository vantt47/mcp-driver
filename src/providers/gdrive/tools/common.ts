import { Readable } from "node:stream";
import { Config } from "../config.js";
import { assertWritable as assertGlobalWritable } from "../../../core/env.js";
import { ToolResult, safeHandler as coreSafeHandler, textResult } from "../../../core/result.js";
import { Drive, DriveFile, Sheets, FILE_FIELDS, explainDriveError, normalizeFileId } from "../drive.js";

export interface ToolContext {
  config: Config;
  /** Lazy: chỉ khởi tạo Drive client khi tool thực sự được gọi. */
  drive: () => Drive;
  /** Lazy: Sheets API client (dùng chung token Drive). */
  sheets: () => Sheets;
}

export type { ToolResult };
export { textResult };

/** Bọc handler để mọi lỗi đều trả về dạng isError (diễn giải theo ngữ cảnh Drive). */
export function safeHandler<A>(fn: (args: A) => Promise<ToolResult>) {
  return coreSafeHandler(fn, explainDriveError);
}

export function assertWritable(config: Config): void {
  assertGlobalWritable(config.readOnly, "GDRIVE_READ_ONLY");
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
