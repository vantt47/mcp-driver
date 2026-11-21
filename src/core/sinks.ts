import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { putGcpSecret } from "../providers/gcp/secrets.js";
import { defaultProject } from "../providers/gcp/client.js";
import { setGithubSecret } from "../providers/github/client.js";
import { UserError } from "./result.js";

/**
 * "Đích" để ghi một giá trị bí mật (key, client secret, service-account JSON…).
 * Giá trị KHÔNG bao giờ được trả lại trong output của tool — chỉ báo đã ghi vào đâu.
 */
export const destinationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("dotenv"),
    path: z.string().describe("Đường dẫn TUYỆT ĐỐI tới file .env (tạo mới nếu chưa có)."),
    key: z.string().optional().describe("Tên biến. Mặc định = `name` của secret."),
  }),
  z.object({
    type: z.literal("file"),
    path: z.string().describe("Đường dẫn TUYỆT ĐỐI của file sẽ ghi (VD: .../android/app/google-services.json)."),
    overwrite: z.boolean().optional().default(false).describe("Cho phép ghi đè file đã tồn tại."),
  }),
  z.object({
    type: z.literal("gcp_secret"),
    project_id: z.string().optional().describe("Project GCP. Mặc định GCP_PROJECT_ID."),
    secret_id: z.string().optional().describe("Tên secret. Mặc định = `name` (ký tự lạ đổi thành _)."),
  }),
  z.object({
    type: z.literal("github_secret"),
    repo: z.string().describe("owner/name"),
    environment: z.string().optional().describe("Environment của GitHub Actions (bỏ trống = secret cấp repo)."),
    secret_name: z.string().optional().describe("Tên secret. Mặc định = `name` viết hoa."),
  }),
]);

export type Destination = z.infer<typeof destinationSchema>;

function requireAbsolute(p: string): string {
  if (!path.isAbsolute(p)) throw new UserError(`Đường dẫn phải là tuyệt đối: ${p}`);
  return path.normalize(p);
}

/** Cảnh báo nếu file nằm trong git repo mà chưa được .gitignore. */
export function gitIgnoreWarning(file: string): string | null {
  try {
    execFileSync("git", ["check-ignore", "-q", path.basename(file)], {
      cwd: path.dirname(file),
      stdio: "ignore",
      windowsHide: true,
    });
    return null; // exit 0 = đã ignore
  } catch (err) {
    const code = (err as { status?: number }).status;
    if (code === 1) {
      return `⚠️ ${file} nằm trong git repo nhưng CHƯA được .gitignore — đừng commit file này.`;
    }
    return null; // 128 = không phải git repo, hoặc không có git
  }
}

function formatDotenvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]*$/.test(value)) return value;
  // Giá trị nhiều dòng (VD private key) → giữ \n dạng escape trong ngoặc kép.
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`;
}

/** Thêm hoặc thay một biến trong file .env, giữ nguyên các dòng khác. */
export function upsertDotenv(file: string, key: string, value: string): "added" | "updated" {
  const abs = requireAbsolute(file);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new UserError(`Tên biến .env không hợp lệ: ${key}`);
  const line = `${key}=${formatDotenvValue(value)}`;
  const existing = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const lines = existing ? existing.split(/\r?\n/) : [];
  const re = new RegExp(`^\\s*(export\\s+)?${key}\\s*=`);
  const idx = lines.findIndex((l) => re.test(l));
  let result: "added" | "updated";
  if (idx >= 0) {
    lines[idx] = line;
    result = "updated";
  } else {
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(line, "");
    result = "added";
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, lines.join(eol), { mode: 0o600 });
  return result;
}

export function writeFileSafe(file: string, content: string | Buffer, overwrite: boolean): "created" | "overwritten" {
  const abs = requireAbsolute(file);
  const exists = fs.existsSync(abs);
  if (exists && !overwrite) {
    throw new UserError(`File đã tồn tại: ${abs}. Đặt overwrite=true nếu muốn ghi đè.`);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, { mode: 0o600 });
  return exists ? "overwritten" : "created";
}

/** Ghi `value` vào từng đích. Trả về danh sách dòng mô tả kết quả (không chứa giá trị). */
export async function deliver(name: string, value: string, destinations: Destination[]): Promise<string[]> {
  if (!destinations.length) throw new UserError("Cần ít nhất một đích (destinations).");
  const lines: string[] = [];
  for (const d of destinations) {
    try {
      switch (d.type) {
        case "dotenv": {
          const key = d.key ?? name;
          const r = upsertDotenv(d.path, key, value);
          lines.push(`✓ .env ${r === "added" ? "thêm" : "cập nhật"} ${key} → ${d.path}`);
          const w = gitIgnoreWarning(d.path);
          if (w) lines.push(`  ${w}`);
          break;
        }
        case "file": {
          const r = writeFileSafe(d.path, value, d.overwrite ?? false);
          lines.push(`✓ file ${r === "created" ? "tạo" : "ghi đè"} → ${d.path}`);
          const w = gitIgnoreWarning(d.path);
          if (w) lines.push(`  ${w}`);
          break;
        }
        case "gcp_secret": {
          const project = defaultProject(d.project_id);
          const r = await putGcpSecret(project, d.secret_id ?? name, value);
          lines.push(`✓ Secret Manager ${r.created ? "tạo mới" : "thêm version"} → ${r.version}`);
          break;
        }
        case "github_secret": {
          const secretName = d.secret_name ?? name;
          const r = await setGithubSecret(d.repo, secretName, value, d.environment);
          lines.push(
            `✓ GitHub secret ${r === "created" ? "tạo" : "cập nhật"} ${secretName.toUpperCase()} → ${d.repo}${d.environment ? ` (env ${d.environment})` : ""}`,
          );
          break;
        }
      }
    } catch (err) {
      lines.push(`✗ ${d.type}: ${(err as Error).message}`);
    }
  }
  return lines;
}
