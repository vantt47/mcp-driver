import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { google } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { readEnv } from "../../core/env.js";
import { UserError } from "../../core/result.js";

/**
 * Xác thực Google Cloud bằng Application Default Credentials (ADC):
 *   - GOOGLE_APPLICATION_CREDENTIALS = file JSON service account, hoặc
 *   - `gcloud auth application-default login` (user credentials).
 * Với user credentials, nhiều API (Firebase, Identity Toolkit, Service Usage…) cần quota project:
 * đặt GCP_QUOTA_PROJECT hoặc chạy `gcloud auth application-default set-quota-project <id>`.
 */
export const GCP_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/firebase",
];

let cachedAuth: GoogleAuth | null = null;

export function gcpAuth(): GoogleAuth {
  if (!cachedAuth) {
    const keyFile = readEnv("GOOGLE_APPLICATION_CREDENTIALS");
    const auth = new google.auth.GoogleAuth({
      scopes: GCP_SCOPES,
      ...(keyFile ? { keyFile } : {}),
    });
    // google-auth-library luôn ép header x-goog-user-project = quota_project_id của file ADC,
    // ghi đè header ta đặt. Bỏ giá trị đó để mỗi lệnh gọi tính hạn mức vào chính project
    // đang thao tác (xem apiOptions) — không phải bật API/billing trên một quota project chung.
    const getClient = auth.getClient.bind(auth);
    auth.getClient = (async () => {
      const client = await getClient();
      client.quotaProjectId = undefined;
      return client;
    }) as typeof auth.getClient;
    cachedAuth = auth;
  }
  return cachedAuth;
}

/**
 * Tuỳ chọn chung truyền vào google.<api>({ ... }).
 * `project`: project ID/number đang thao tác → dùng làm quota/billing project (x-goog-user-project).
 * GCP_QUOTA_PROJECT (nếu đặt) luôn được ưu tiên.
 */
export function apiOptions(project?: string | null) {
  const quota = readEnv("GCP_QUOTA_PROJECT") ?? (project && project !== "-" ? project : undefined);
  return {
    auth: gcpAuth(),
    ...(quota ? { headers: { "x-goog-user-project": quota } } : {}),
  };
}

/** Lấy project number từ Firebase app ID (1:<number>:<platform>:<hash>). */
export function projectFromAppId(appId: string): string | undefined {
  return appId.match(/^\d+:(\d+):/)?.[1];
}

export function defaultProject(explicit?: string): string {
  const p = explicit || readEnv("GCP_PROJECT_ID", "GOOGLE_CLOUD_PROJECT");
  if (!p) {
    throw new UserError(
      "Thiếu project_id. Truyền tham số project_id hoặc đặt GCP_PROJECT_ID trong env.",
    );
  }
  return p;
}

function adcFilePath(): string {
  return process.platform === "win32"
    ? path.join(process.env.APPDATA ?? "", "gcloud", "application_default_credentials.json")
    : path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json");
}

/** Trạng thái xác thực, không đọc giá trị bí mật ra ngoài. */
export function gcpCredentialSource(): { configured: boolean; detail: string } {
  const keyFile = readEnv("GOOGLE_APPLICATION_CREDENTIALS");
  const quota = readEnv("GCP_QUOTA_PROJECT");
  const proj = readEnv("GCP_PROJECT_ID", "GOOGLE_CLOUD_PROJECT");
  const extra = [
    proj ? `project mặc định ${proj}` : null,
    quota ? `quota project ${quota}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  if (keyFile) {
    return {
      configured: fs.existsSync(keyFile),
      detail: `service account file ${keyFile}${fs.existsSync(keyFile) ? "" : " (KHÔNG tồn tại)"}${extra ? `; ${extra}` : ""}`,
    };
  }
  const adc = adcFilePath();
  if (fs.existsSync(adc)) {
    let qp: string | undefined;
    try {
      qp = (JSON.parse(fs.readFileSync(adc, "utf8")) as { quota_project_id?: string }).quota_project_id;
    } catch {
      /* bỏ qua */
    }
    return {
      configured: true,
      detail: `gcloud ADC (${adc})${qp ? ` (quota_project_id ${qp} bị bỏ qua — hạn mức tính vào project đang thao tác)` : ""}${extra ? `; ${extra}` : ""}`,
    };
  }
  return {
    configured: false,
    detail:
      "Chưa có credential. Chạy `gcloud auth application-default login` hoặc đặt GOOGLE_APPLICATION_CREDENTIALS.",
  };
}
