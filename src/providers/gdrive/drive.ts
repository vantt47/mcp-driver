import { google, drive_v3 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { Config } from "./config.js";
import { getAuthenticatedClient } from "./auth.js";

export type Drive = drive_v3.Drive;
export type DriveFile = drive_v3.Schema$File;

let cachedAuth: OAuth2Client | null = null;
let cachedDrive: Drive | null = null;

export function getDrive(config: Config): Drive {
  if (!cachedDrive) {
    cachedAuth = getAuthenticatedClient(config);
    cachedDrive = google.drive({ version: "v3", auth: cachedAuth });
  }
  return cachedDrive;
}

export const FILE_FIELDS =
  "id, name, mimeType, size, modifiedTime, createdTime, owners(displayName,emailAddress), parents, webViewLink, iconLink, trashed, shortcutDetails";

/** MIME type của các loại tài liệu Google Workspace. */
export const GOOGLE_MIME = {
  doc: "application/vnd.google-apps.document",
  sheet: "application/vnd.google-apps.spreadsheet",
  slide: "application/vnd.google-apps.presentation",
  folder: "application/vnd.google-apps.folder",
  shortcut: "application/vnd.google-apps.shortcut",
} as const;

/** Định dạng export mặc định khi đọc file Google Workspace. */
const EXPORT_MAP: Record<string, { mimeType: string; note: string }> = {
  [GOOGLE_MIME.doc]: { mimeType: "text/markdown", note: "Google Docs → Markdown" },
  [GOOGLE_MIME.sheet]: { mimeType: "text/csv", note: "Google Sheets (sheet đầu tiên) → CSV" },
  [GOOGLE_MIME.slide]: { mimeType: "text/plain", note: "Google Slides → text" },
  "application/vnd.google-apps.drawing": { mimeType: "image/svg+xml", note: "Drawing → SVG" },
  "application/vnd.google-apps.script": {
    mimeType: "application/vnd.google-apps.script+json",
    note: "Apps Script → JSON",
  },
};

/** MIME type mà ta coi là "đọc được dưới dạng text". */
export function isTextLike(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  if (mimeType.startsWith("text/")) return true;
  return [
    "application/json",
    "application/xml",
    "application/javascript",
    "application/typescript",
    "application/x-yaml",
    "application/x-sh",
    "application/sql",
    "application/rtf",
    "image/svg+xml",
  ].includes(mimeType);
}

export function isGoogleDoc(mimeType: string | null | undefined): boolean {
  return !!mimeType && mimeType.startsWith("application/vnd.google-apps");
}

export function exportTargetFor(mimeType: string): { mimeType: string; note: string } | null {
  return EXPORT_MAP[mimeType] ?? null;
}

/**
 * Chấp nhận cả file ID lẫn URL Google Drive và trả về file ID.
 * Ví dụ: https://docs.google.com/document/d/<ID>/edit → <ID>
 *        https://drive.google.com/file/d/<ID>/view   → <ID>
 *        https://drive.google.com/open?id=<ID>       → <ID>
 */
export function normalizeFileId(input: string): string {
  const value = input.trim();
  if (!value.startsWith("http")) return value;

  try {
    const url = new URL(value);
    const fromQuery = url.searchParams.get("id");
    if (fromQuery) return fromQuery;
    const match = url.pathname.match(/\/d\/([^/]+)/) ?? url.pathname.match(/\/folders\/([^/]+)/);
    if (match) return match[1];
  } catch {
    /* không phải URL hợp lệ — trả nguyên giá trị */
  }
  return value;
}

/** Escape dấu nháy đơn và backslash trong query của Drive API. */
export function escapeQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function formatBytes(size?: string | number | null): string {
  const n = typeof size === "string" ? Number.parseInt(size, 10) : size;
  if (!n || !Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function shortMime(mimeType?: string | null): string {
  if (!mimeType) return "unknown";
  const map: Record<string, string> = {
    [GOOGLE_MIME.doc]: "Google Doc",
    [GOOGLE_MIME.sheet]: "Google Sheet",
    [GOOGLE_MIME.slide]: "Google Slides",
    [GOOGLE_MIME.folder]: "Folder",
    [GOOGLE_MIME.shortcut]: "Shortcut",
  };
  return map[mimeType] ?? mimeType;
}

export function describeFile(file: DriveFile): string {
  const parts = [
    `• ${file.name ?? "(không tên)"}`,
    `  id: ${file.id}`,
    `  type: ${shortMime(file.mimeType)}`,
  ];
  if (file.size) parts.push(`  size: ${formatBytes(file.size)}`);
  if (file.modifiedTime) parts.push(`  modified: ${file.modifiedTime}`);
  const owner = file.owners?.[0];
  if (owner) parts.push(`  owner: ${owner.displayName ?? owner.emailAddress}`);
  if (file.webViewLink) parts.push(`  link: ${file.webViewLink}`);
  if (file.trashed) parts.push(`  ⚠️ đang ở trong Thùng rác`);
  return parts.join("\n");
}

/** Lấy toàn bộ ID folder con (đệ quy) để giới hạn tìm kiếm trong GDRIVE_ROOT_FOLDER_ID. */
export async function collectFolderTree(
  drive: Drive,
  rootId: string,
  maxFolders = 200,
): Promise<string[]> {
  const seen = new Set<string>([rootId]);
  const queue = [rootId];

  while (queue.length && seen.size < maxFolders) {
    const current = queue.shift()!;
    const res = await drive.files.list({
      q: `'${escapeQuery(current)}' in parents and mimeType = '${GOOGLE_MIME.folder}' and trashed = false`,
      fields: "files(id)",
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const folder of res.data.files ?? []) {
      if (folder.id && !seen.has(folder.id)) {
        seen.add(folder.id);
        queue.push(folder.id);
      }
    }
  }
  return [...seen];
}

/** Chuyển lỗi của Google API thành thông báo dễ hiểu. */
export function explainDriveError(err: unknown): string {
  const e = err as {
    code?: number | string;
    message?: string;
    errors?: Array<{ message?: string; reason?: string }>;
    response?: { data?: { error?: { message?: string } } };
  };
  const status = Number(e?.code);
  const detail =
    e?.response?.data?.error?.message ?? e?.errors?.[0]?.message ?? e?.message ?? String(err);

  switch (status) {
    case 401:
      return `Token hết hiệu lực hoặc bị thu hồi (401). Chạy lại \`npm run auth\`. Chi tiết: ${detail}`;
    case 403:
      return `Bị từ chối quyền (403). Kiểm tra scope trong .env và quyền chia sẻ của file. Chi tiết: ${detail}`;
    case 404:
      return `Không tìm thấy file/folder (404). Kiểm tra lại fileId, hoặc file chưa được chia sẻ với tài khoản đang đăng nhập. Chi tiết: ${detail}`;
    case 429:
      return `Vượt hạn mức Drive API (429). Hãy thử lại sau ít phút. Chi tiết: ${detail}`;
    default:
      return detail;
  }
}
