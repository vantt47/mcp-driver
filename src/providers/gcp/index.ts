import fs from "node:fs";
import { z } from "zod";
import { google } from "googleapis";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Provider } from "../../core/provider.js";
import { assertWritable } from "../../core/env.js";
import { UserError, safeHandler, textResult, waitOperation } from "../../core/result.js";
import { deliver, destinationSchema } from "../../core/sinks.js";
import { apiOptions, defaultProject, gcpCredentialSource } from "./client.js";
import { accessGcpSecret, listGcpSecrets } from "./secrets.js";

const SERVICE_ALIASES: Record<string, string> = {
  firebase: "firebase.googleapis.com",
  fcm: "fcm.googleapis.com",
  messaging: "fcm.googleapis.com",
  identitytoolkit: "identitytoolkit.googleapis.com",
  auth: "identitytoolkit.googleapis.com",
  secretmanager: "secretmanager.googleapis.com",
  iam: "iam.googleapis.com",
  iamcredentials: "iamcredentials.googleapis.com",
  drive: "drive.googleapis.com",
  sheets: "sheets.googleapis.com",
  people: "people.googleapis.com",
  firestore: "firestore.googleapis.com",
  storage: "storage.googleapis.com",
  run: "run.googleapis.com",
  cloudresourcemanager: "cloudresourcemanager.googleapis.com",
  serviceusage: "serviceusage.googleapis.com",
  firebaseinstallations: "firebaseinstallations.googleapis.com",
  firebaseremoteconfig: "firebaseremoteconfig.googleapis.com",
};

function resolveService(s: string): string {
  const v = s.trim();
  return SERVICE_ALIASES[v.toLowerCase()] ?? (v.includes(".") ? v : `${v}.googleapis.com`);
}

const projectArg = z
  .string()
  .optional()
  .describe("Project ID của Google Cloud/Firebase. Mặc định lấy từ GCP_PROJECT_ID.");

function serviceAccountEmail(project: string, input: string): string {
  return input.includes("@") ? input : `${input}@${project}.iam.gserviceaccount.com`;
}

/** Thêm member vào các role ở cấp project (đọc-sửa-ghi policy, thử lại khi etag xung đột). */
async function grantProjectRoles(project: string, member: string, roles: string[]): Promise<string[]> {
  const crm = google.cloudresourcemanager({ version: "v1", ...apiOptions(project) });
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: policy } = await crm.projects.getIamPolicy({
      resource: project,
      requestBody: { options: { requestedPolicyVersion: 3 } },
    });
    const bindings = policy.bindings ?? [];
    const added: string[] = [];
    for (const role of roles) {
      const r = role.startsWith("roles/") || role.startsWith("projects/") ? role : `roles/${role}`;
      let b = bindings.find((x) => x.role === r && !x.condition);
      if (!b) {
        b = { role: r, members: [] };
        bindings.push(b);
      }
      if (!b.members?.includes(member)) {
        b.members = [...(b.members ?? []), member];
        added.push(r);
      }
    }
    if (!added.length) return [];
    try {
      await crm.projects.setIamPolicy({
        resource: project,
        requestBody: { policy: { ...policy, bindings, version: 3 } },
      });
      return added;
    } catch (err) {
      if (Number((err as { code?: unknown }).code) === 409 && attempt < 2) continue;
      throw err;
    }
  }
  return [];
}

export const gcpProvider: Provider = {
  id: "gcp",
  title: "Google Cloud",
  instructions:
    "gcp_*: thao tác Google Cloud qua ADC (project, bật API, service account, Secret Manager). " +
    "Key service account KHÔNG bao giờ trả về trong chat — luôn ghi vào destinations (.env/file/Secret Manager/GitHub secret).",
  status: gcpCredentialSource,

  register(server: McpServer) {
    server.registerTool(
      "gcp_list_projects",
      {
        title: "Liệt kê project Google Cloud",
        description: "Liệt kê các project GCP mà credential hiện tại truy cập được.",
        inputSchema: {
          filter: z.string().optional().describe("Bộ lọc của Resource Manager, VD: name:my-app* hoặc labels.env:prod"),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      safeHandler(async ({ filter }: { filter?: string }) => {
        const crm = google.cloudresourcemanager({ version: "v1", ...apiOptions() });
        const res = await crm.projects.list({ filter, pageSize: 200 });
        const projects = (res.data.projects ?? []).filter((p) => p.lifecycleState === "ACTIVE");
        const text = projects.length
          ? projects.map((p) => `• ${p.projectId}  (${p.name}, #${p.projectNumber})`).join("\n")
          : "Không có project nào.";
        return textResult(text, {
          projects: projects.map((p) => ({ projectId: p.projectId, name: p.name, projectNumber: p.projectNumber })),
        });
      }),
    );

    server.registerTool(
      "gcp_create_project",
      {
        title: "Tạo project Google Cloud",
        description:
          "Tạo project GCP mới (bỏ qua nếu project ID đã thuộc về bạn). Project ID là duy nhất toàn cầu, 6-30 ký tự. " +
          "Muốn dùng Firebase thì gọi tiếp firebase_add_to_project.",
        inputSchema: {
          project_id: z
            .string()
            .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/)
            .describe("VD dnso-vn. Chữ thường, số, gạch ngang; không đổi được sau khi tạo."),
          name: z.string().optional().describe("Tên hiển thị (mặc định = project_id)."),
          parent: z
            .string()
            .optional()
            .describe("organizations/<id> hoặc folders/<id>. Bỏ trống nếu tài khoản không thuộc tổ chức."),
          labels: z.record(z.string()).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      safeHandler(
        async (args: { project_id: string; name?: string; parent?: string; labels?: Record<string, string> }) => {
          assertWritable();
          const crm = google.cloudresourcemanager({ version: "v3", ...apiOptions() });
          try {
            const { data } = await crm.projects.get({ name: `projects/${args.project_id}` });
            return textResult(`ℹ️ Project ${data.projectId} đã tồn tại và bạn có quyền (${data.state}).`, {
              projectId: data.projectId,
              created: false,
            });
          } catch (err) {
            const code = Number((err as { code?: unknown }).code);
            if (code !== 403 && code !== 404) throw err;
          }
          let op;
          try {
            op = await crm.projects.create({
              requestBody: {
                projectId: args.project_id,
                displayName: (args.name ?? args.project_id).slice(0, 30),
                parent: args.parent,
                labels: args.labels,
              },
            });
          } catch (err) {
            if (Number((err as { code?: unknown }).code) === 409) {
              throw new UserError(`Project ID "${args.project_id}" đã có người dùng (ID là duy nhất toàn cầu). Chọn ID khác.`);
            }
            throw err;
          }
          const done = await waitOperation(op.data, async (name) => (await crm.operations.get({ name })).data, 180_000);
          const project = done.response as { projectId?: string; name?: string } | undefined;
          return textResult(`✓ Đã tạo project ${project?.projectId ?? args.project_id} (${project?.name ?? ""}).`, {
            projectId: project?.projectId ?? args.project_id,
            created: true,
          });
        },
      ),
    );

    server.registerTool(
      "gcp_enable_apis",
      {
        title: "Bật Google API cho project",
        description:
          "Bật một hoặc nhiều API (serviceusage). Nhận tên đầy đủ (fcm.googleapis.com) hoặc alias: " +
          Object.keys(SERVICE_ALIASES).join(", ") +
          ".",
        inputSchema: {
          project_id: projectArg,
          services: z.array(z.string()).min(1).max(20).describe("Danh sách API cần bật."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      safeHandler(async ({ project_id, services }: { project_id?: string; services: string[] }) => {
        assertWritable();
        const project = defaultProject(project_id);
        // Không gắn quota project: Service Usage là API dùng để khởi tạo project mới (chưa bật API nào).
        const su = google.serviceusage({ version: "v1", ...apiOptions() });
        const ids = [...new Set(services.map(resolveService))];
        const res = await su.services.batchEnable({
          parent: `projects/${project}`,
          requestBody: { serviceIds: ids },
        });
        await waitOperation(res.data, async (name) => (await su.operations.get({ name })).data, 180_000);
        return textResult(`✓ Đã bật trên ${project}:\n${ids.map((s) => `• ${s}`).join("\n")}`, {
          project,
          enabled: ids,
        });
      }),
    );

    server.registerTool(
      "gcp_list_enabled_apis",
      {
        title: "Liệt kê API đã bật",
        description: "Liệt kê các API đang bật trên project.",
        inputSchema: { project_id: projectArg },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      safeHandler(async ({ project_id }: { project_id?: string }) => {
        const project = defaultProject(project_id);
        // Không gắn quota project: Service Usage là API dùng để khởi tạo project mới (chưa bật API nào).
        const su = google.serviceusage({ version: "v1", ...apiOptions() });
        const names: string[] = [];
        let pageToken: string | undefined;
        do {
          const res = await su.services.list({
            parent: `projects/${project}`,
            filter: "state:ENABLED",
            pageSize: 200,
            pageToken,
          });
          for (const s of res.data.services ?? []) if (s.config?.name) names.push(s.config.name);
          pageToken = res.data.nextPageToken ?? undefined;
        } while (pageToken);
        names.sort();
        return textResult(`${names.length} API đang bật trên ${project}:\n${names.join("\n")}`, {
          project,
          services: names,
        });
      }),
    );

    server.registerTool(
      "gcp_create_service_account",
      {
        title: "Tạo service account",
        description:
          "Tạo service account (bỏ qua nếu đã có) và cấp role cấp project. " +
          "VD cho backend gửi FCM: roles = [\"firebasecloudmessaging.admin\"]; đọc secret: [\"secretmanager.secretAccessor\"].",
        inputSchema: {
          project_id: projectArg,
          account_id: z
            .string()
            .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/)
            .describe("ID 6-30 ký tự, chữ thường/số/gạch ngang. VD: fcm-sender"),
          display_name: z.string().optional(),
          roles: z.array(z.string()).optional().describe("Role cần cấp, có hoặc không tiền tố roles/."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      safeHandler(
        async (args: { project_id?: string; account_id: string; display_name?: string; roles?: string[] }) => {
          assertWritable();
          const project = defaultProject(args.project_id);
          const iam = google.iam({ version: "v1", ...apiOptions(project) });
          const email = serviceAccountEmail(project, args.account_id);
          let created = false;
          try {
            await iam.projects.serviceAccounts.get({ name: `projects/${project}/serviceAccounts/${email}` });
          } catch (err) {
            if (Number((err as { code?: unknown }).code) !== 404) throw err;
            await iam.projects.serviceAccounts.create({
              name: `projects/${project}`,
              requestBody: {
                accountId: args.account_id,
                serviceAccount: { displayName: args.display_name ?? args.account_id },
              },
            });
            created = true;
          }
          const granted = args.roles?.length
            ? await grantProjectRoles(project, `serviceAccount:${email}`, args.roles)
            : [];
          return textResult(
            [
              `${created ? "✓ Đã tạo" : "ℹ️ Đã có sẵn"} service account ${email}`,
              granted.length ? `✓ Cấp thêm role: ${granted.join(", ")}` : args.roles?.length ? "ℹ️ Các role đã có sẵn." : "",
            ]
              .filter(Boolean)
              .join("\n"),
            { email, created, grantedRoles: granted },
          );
        },
      ),
    );

    server.registerTool(
      "gcp_create_service_account_key",
      {
        title: "Tạo key JSON cho service account",
        description:
          "Tạo key JSON mới cho service account và ghi THẲNG vào các đích (file, .env, Secret Manager, GitHub secret). " +
          "Nội dung key không được trả về chat. Lưu ý: tổ chức có thể chặn tạo key (iam.disableServiceAccountKeyCreation) — " +
          "khi đó hãy dùng Workload Identity / ADC.",
        inputSchema: {
          project_id: projectArg,
          service_account: z.string().describe("Email hoặc account_id của service account."),
          name: z
            .string()
            .default("GOOGLE_SERVICE_ACCOUNT_JSON")
            .describe("Tên mặc định cho biến .env / secret."),
          destinations: z.array(destinationSchema).min(1),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      safeHandler(
        async (args: {
          project_id?: string;
          service_account: string;
          name: string;
          destinations: z.infer<typeof destinationSchema>[];
        }) => {
          assertWritable();
          const project = defaultProject(args.project_id);
          const email = serviceAccountEmail(project, args.service_account);
          const iam = google.iam({ version: "v1", ...apiOptions(project) });
          const res = await iam.projects.serviceAccounts.keys.create({
            name: `projects/-/serviceAccounts/${email}`,
            requestBody: { privateKeyType: "TYPE_GOOGLE_CREDENTIALS_FILE", keyAlgorithm: "KEY_ALG_RSA_2048" },
          });
          const json = Buffer.from(res.data.privateKeyData ?? "", "base64").toString("utf8");
          if (!json) throw new UserError("API không trả về privateKeyData.");
          const keyId = res.data.name?.split("/").pop();
          const lines = await deliver(args.name, json, args.destinations);
          return textResult(
            [`✓ Đã tạo key ${keyId} cho ${email}`, ...lines].join("\n"),
            { email, keyId, results: lines },
          );
        },
      ),
    );

    server.registerTool(
      "gcp_secret_list",
      {
        title: "Liệt kê secret trong Secret Manager",
        description: "Liệt kê tên secret (không đọc giá trị).",
        inputSchema: {
          project_id: projectArg,
          filter: z.string().optional().describe("VD: name:firebase hoặc labels.managed-by=mcp-platform"),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      safeHandler(async ({ project_id, filter }: { project_id?: string; filter?: string }) => {
        const project = defaultProject(project_id);
        const secrets = await listGcpSecrets(project, filter);
        const names = secrets.map((s) => s.name?.split("/").pop() ?? "");
        return textResult(names.length ? names.map((n) => `• ${n}`).join("\n") : "Không có secret nào.", {
          project,
          secrets: names,
        });
      }),
    );

    server.registerTool(
      "gcp_secret_copy",
      {
        title: "Sao chép secret từ Secret Manager",
        description:
          "Đọc một secret từ Secret Manager rồi ghi vào các đích khác (VD: kéo về .env local, hoặc đẩy sang GitHub Actions). " +
          "Giá trị không hiển thị trong chat.",
        inputSchema: {
          project_id: projectArg,
          secret_id: z.string(),
          version: z.string().optional().default("latest"),
          destinations: z.array(destinationSchema).min(1),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      safeHandler(
        async (args: {
          project_id?: string;
          secret_id: string;
          version?: string;
          destinations: z.infer<typeof destinationSchema>[];
        }) => {
          assertWritable();
          const project = defaultProject(args.project_id);
          const value = await accessGcpSecret(project, args.secret_id, args.version);
          const lines = await deliver(args.secret_id, value, args.destinations);
          return textResult(lines.join("\n"), { results: lines });
        },
      ),
    );
  },
};

/** Đọc nội dung từ `value` hoặc `from_file` (dùng chung cho các tool ghi secret). */
export function valueFrom(args: { value?: string; from_file?: string }): string {
  if (args.value !== undefined && args.from_file) throw new UserError("Chỉ truyền một trong value hoặc from_file.");
  if (args.value !== undefined) return args.value;
  if (args.from_file) {
    if (!fs.existsSync(args.from_file)) throw new UserError(`Không tìm thấy file: ${args.from_file}`);
    return fs.readFileSync(args.from_file, "utf8");
  }
  throw new UserError("Cần value hoặc from_file.");
}
