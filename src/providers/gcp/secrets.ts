import { google } from "googleapis";
import { apiOptions } from "./client.js";

function sm(project: string) {
  return google.secretmanager({ version: "v1", ...apiOptions(project) });
}

export function validSecretId(id: string): string {
  // Secret Manager: [A-Za-z0-9_-]{1,255}
  return id.trim().replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 255);
}

/** Tạo secret nếu chưa có rồi thêm version mới. Trả về tên version. */
export async function putGcpSecret(
  projectId: string,
  secretId: string,
  value: string,
  labels?: Record<string, string>,
): Promise<{ version: string; created: boolean }> {
  const client = sm(projectId);
  const id = validSecretId(secretId);
  const parent = `projects/${projectId}`;
  let created = false;
  try {
    await client.projects.secrets.get({ name: `${parent}/secrets/${id}` });
  } catch (err) {
    if (Number((err as { code?: unknown }).code) !== 404) throw err;
    await client.projects.secrets.create({
      parent,
      secretId: id,
      requestBody: {
        replication: { automatic: {} },
        labels: { "managed-by": "mcp-platform", ...labels },
      },
    });
    created = true;
  }
  const res = await client.projects.secrets.addVersion({
    parent: `${parent}/secrets/${id}`,
    requestBody: { payload: { data: Buffer.from(value, "utf8").toString("base64") } },
  });
  return { version: res.data.name ?? "", created };
}

export async function listGcpSecrets(projectId: string, filter?: string) {
  const res = await sm(projectId).projects.secrets.list({
    parent: `projects/${projectId}`,
    pageSize: 250,
    filter,
  });
  return res.data.secrets ?? [];
}

export async function accessGcpSecret(projectId: string, secretId: string, version = "latest") {
  const res = await sm(projectId).projects.secrets.versions.access({
    name: `projects/${projectId}/secrets/${validSecretId(secretId)}/versions/${version}`,
  });
  const b64 = res.data.payload?.data ?? "";
  return Buffer.from(b64, "base64").toString("utf8");
}
