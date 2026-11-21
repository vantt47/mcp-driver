import { z } from "zod";
import { google, firebase_v1beta1 } from "googleapis";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Provider } from "../../core/provider.js";
import { assertWritable } from "../../core/env.js";
import { UserError, mask, safeHandler, textResult, waitOperation } from "../../core/result.js";
import { gitIgnoreWarning, upsertDotenv, writeFileSafe } from "../../core/sinks.js";
import { apiOptions, defaultProject, gcpCredentialSource, projectFromAppId } from "../gcp/client.js";
import { accessGcpSecret } from "../gcp/secrets.js";

type Platform = "web" | "android" | "ios";

function fb(project?: string) {
  return google.firebase({ version: "v1beta1", ...apiOptions(project) });
}
function idt(project: string) {
  return google.identitytoolkit({ version: "v2", ...apiOptions(project) });
}

const projectArg = z.string().optional().describe("Firebase project ID. Mặc định GCP_PROJECT_ID.");

function platformOf(appId: string): Platform {
  const m = appId.match(/^\d+:\d+:(android|ios|web):/);
  if (!m) throw new UserError(`app_id không đúng định dạng Firebase (1:<number>:<platform>:<hash>): ${appId}`);
  return m[1] as Platform;
}

async function waitFb(op: firebase_v1beta1.Schema$Operation, project?: string) {
  const client = fb(project);
  return waitOperation(op, async (name) => (await client.operations.get({ name })).data, 120_000);
}

/** Chuẩn hoá SHA (bỏ dấu :, chữ thường) và đoán loại theo độ dài. */
function normalizeSha(sha: string): { hash: string; type: "SHA_1" | "SHA_256" } {
  const hash = sha.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (hash.length === 40) return { hash, type: "SHA_1" };
  if (hash.length === 64) return { hash, type: "SHA_256" };
  throw new UserError(`SHA không hợp lệ (cần 40 hoặc 64 ký tự hex): ${sha}`);
}

const WEB_ENV_KEYS: Array<[keyof firebase_v1beta1.Schema$WebAppConfig, string]> = [
  ["apiKey", "API_KEY"],
  ["authDomain", "AUTH_DOMAIN"],
  ["projectId", "PROJECT_ID"],
  ["storageBucket", "STORAGE_BUCKET"],
  ["messagingSenderId", "MESSAGING_SENDER_ID"],
  ["appId", "APP_ID"],
  ["measurementId", "MEASUREMENT_ID"],
  ["databaseURL", "DATABASE_URL"],
];

export const firebaseProvider: Provider = {
  id: "firebase",
  title: "Firebase",
  instructions:
    "firebase_* / fcm_send: quản lý Firebase qua cùng credential ADC với gcp_*. " +
    "Quy trình: firebase_create_app → firebase_get_sdk_config (ghi google-services.json / GoogleService-Info.plist / .env) → " +
    "Android thêm SHA bằng firebase_android_sha → firebase_auth_enable_google → fcm_send để thử push.",
  status: gcpCredentialSource,

  register(server: McpServer) {
    server.registerTool(
      "firebase_list_projects",
      {
        title: "Liệt kê project Firebase",
        description: "Liệt kê các project đã bật Firebase mà credential truy cập được.",
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      safeHandler(async () => {
        const res = await fb().projects.list({ pageSize: 100 });
        const list = res.data.results ?? [];
        return textResult(
          list.length ? list.map((p) => `• ${p.projectId}  (${p.displayName}, #${p.projectNumber})`).join("\n") : "Không có project Firebase nào.",
          { projects: list.map((p) => ({ projectId: p.projectId, displayName: p.displayName })) },
        );
      }),
    );

    server.registerTool(
      "firebase_add_to_project",
      {
        title: "Bật Firebase cho project GCP",
        description: "Biến một project Google Cloud có sẵn thành project Firebase (projects.addFirebase).",
        inputSchema: { project_id: projectArg },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      safeHandler(async ({ project_id }: { project_id?: string }) => {
        assertWritable();
        const project = defaultProject(project_id);
        try {
          const res = await fb(project).projects.addFirebase({ project: `projects/${project}`, requestBody: {} });
          await waitFb(res.data, project);
          return textResult(`✓ Đã bật Firebase cho ${project}.`);
        } catch (err) {
          if (Number((err as { code?: unknown }).code) === 409) return textResult(`ℹ️ ${project} đã là project Firebase.`);
          throw err;
        }
      }),
    );

    server.registerTool(
      "firebase_list_apps",
      {
        title: "Liệt kê app Firebase",
        description: "Liệt kê app Web/Android/iOS trong project.",
        inputSchema: {
          project_id: projectArg,
          platform: z.enum(["web", "android", "ios"]).optional(),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      safeHandler(async ({ project_id, platform }: { project_id?: string; platform?: Platform }) => {
        const project = defaultProject(project_id);
        const res = await fb(project).projects.searchApps({
          parent: `projects/${project}`,
          pageSize: 100,
          filter: platform ? `platform="${platform.toUpperCase()}"` : undefined,
        });
        const apps = res.data.apps ?? [];
        return textResult(
          apps.length
            ? apps.map((a) => `• [${a.platform}] ${a.displayName ?? "(không tên)"}  ${a.namespace ?? ""}\n  app_id: ${a.appId}`).join("\n")
            : "Chưa có app nào.",
          { apps: apps.map((a) => ({ appId: a.appId, platform: a.platform, displayName: a.displayName, namespace: a.namespace })) },
        );
      }),
    );

    server.registerTool(
      "firebase_create_app",
      {
        title: "Đăng ký app Firebase",
        description:
          "Đăng ký app mới. Android cần package_name, iOS cần bundle_id. Nếu đã có app cùng package/bundle thì trả về app đó.",
        inputSchema: {
          project_id: projectArg,
          platform: z.enum(["web", "android", "ios"]),
          display_name: z.string().optional(),
          package_name: z.string().optional().describe("Android applicationId, VD vn.dmst.app"),
          bundle_id: z.string().optional().describe("iOS bundle ID"),
          app_store_id: z.string().optional().describe("iOS App Store ID (tuỳ chọn)"),
          team_id: z.string().optional().describe("Apple Team ID (tuỳ chọn, cần cho Dynamic Links/Universal Links)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      safeHandler(
        async (args: {
          project_id?: string;
          platform: Platform;
          display_name?: string;
          package_name?: string;
          bundle_id?: string;
          app_store_id?: string;
          team_id?: string;
        }) => {
          assertWritable();
          const project = defaultProject(args.project_id);
          const parent = `projects/${project}`;
          const client = fb(project);

          const namespace = args.platform === "android" ? args.package_name : args.platform === "ios" ? args.bundle_id : undefined;
          if (args.platform === "android" && !namespace) throw new UserError("Android cần package_name.");
          if (args.platform === "ios" && !namespace) throw new UserError("iOS cần bundle_id.");

          if (namespace) {
            const existing = await client.projects.searchApps({ parent, pageSize: 100 });
            const found = existing.data.apps?.find(
              (a) => a.platform === args.platform.toUpperCase() && a.namespace === namespace,
            );
            if (found) {
              return textResult(`ℹ️ Đã có app ${namespace}: ${found.appId}`, { appId: found.appId, created: false });
            }
          }

          let op: firebase_v1beta1.Schema$Operation;
          if (args.platform === "web") {
            op = (await client.projects.webApps.create({ parent, requestBody: { displayName: args.display_name ?? "Web app" } })).data;
          } else if (args.platform === "android") {
            op = (
              await client.projects.androidApps.create({
                parent,
                requestBody: { packageName: namespace, displayName: args.display_name },
              })
            ).data;
          } else {
            op = (
              await client.projects.iosApps.create({
                parent,
                requestBody: {
                  bundleId: namespace,
                  displayName: args.display_name,
                  appStoreId: args.app_store_id,
                  teamId: args.team_id,
                },
              })
            ).data;
          }
          const done = await waitFb(op, project);
          const appId = (done.response as { appId?: string } | undefined)?.appId;
          return textResult(`✓ Đã tạo app ${args.platform}${namespace ? ` ${namespace}` : ""}: ${appId}`, {
            appId,
            created: true,
          });
        },
      ),
    );

    server.registerTool(
      "firebase_get_sdk_config",
      {
        title: "Lấy SDK config của app Firebase",
        description:
          "Lấy config SDK. Android → google-services.json, iOS → GoogleService-Info.plist, Web → firebaseConfig. " +
          "Có thể ghi thẳng vào file (write_to) và/hoặc (web) ghi từng khoá vào .env với tiền tố (VD VITE_FIREBASE_, NEXT_PUBLIC_FIREBASE_).",
        inputSchema: {
          project_id: projectArg,
          app_id: z.string().describe("App ID dạng 1:123:android:abc (lấy từ firebase_list_apps)."),
          write_to: z
            .string()
            .optional()
            .describe("Đường dẫn TUYỆT ĐỐI để ghi file config (VD .../android/app/google-services.json, .../ios/Runner/GoogleService-Info.plist, .../src/firebase-config.json)."),
          overwrite: z.boolean().optional().default(true),
          env_file: z.string().optional().describe("(Web) đường dẫn TUYỆT ĐỐI tới .env để ghi từng khoá."),
          env_prefix: z.string().optional().default("FIREBASE_").describe("(Web) tiền tố tên biến .env."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      safeHandler(
        async (args: {
          project_id?: string;
          app_id: string;
          write_to?: string;
          overwrite?: boolean;
          env_file?: string;
          env_prefix?: string;
        }) => {
          const platform = platformOf(args.app_id);
          const client = fb(args.project_id ?? projectFromAppId(args.app_id));
          const lines: string[] = [];
          let content: string;
          let structured: Record<string, unknown>;

          if (platform === "web") {
            const { data } = await client.projects.webApps.getConfig({ name: `projects/-/webApps/${args.app_id}/config` });
            const cfg = Object.fromEntries(Object.entries(data).filter(([, v]) => v != null));
            content = JSON.stringify(cfg, null, 2);
            structured = { platform, config: cfg };
            lines.push("firebaseConfig:", content);
          } else {
            const res =
              platform === "android"
                ? await client.projects.androidApps.getConfig({ name: `projects/-/androidApps/${args.app_id}/config` })
                : await client.projects.iosApps.getConfig({ name: `projects/-/iosApps/${args.app_id}/config` });
            content = Buffer.from(res.data.configFileContents ?? "", "base64").toString("utf8");
            structured = { platform, filename: res.data.configFilename };
            lines.push(`File: ${res.data.configFilename} (${content.length} bytes)`);
            if (!args.write_to) lines.push("", content);
          }

          if (args.write_to || args.env_file) assertWritable();
          if (args.write_to) {
            const r = writeFileSafe(args.write_to, content, args.overwrite ?? true);
            lines.push(`✓ ${r === "created" ? "Đã tạo" : "Đã ghi đè"} ${args.write_to}`);
          }
          if (args.env_file) {
            if (platform !== "web") throw new UserError("env_file chỉ dùng cho app web.");
            const cfg = structured.config as firebase_v1beta1.Schema$WebAppConfig;
            const prefix = args.env_prefix ?? "FIREBASE_";
            const written: string[] = [];
            for (const [field, suffix] of WEB_ENV_KEYS) {
              const v = cfg[field];
              if (typeof v === "string" && v) {
                upsertDotenv(args.env_file, `${prefix}${suffix}`, v);
                written.push(`${prefix}${suffix}`);
              }
            }
            lines.push(`✓ Ghi ${written.length} biến vào ${args.env_file}: ${written.join(", ")}`);
            const w = gitIgnoreWarning(args.env_file);
            if (w) lines.push(w);
          }
          return textResult(lines.join("\n"), structured);
        },
      ),
    );

    server.registerTool(
      "firebase_android_sha",
      {
        title: "Quản lý SHA của app Android",
        description:
          "Liệt kê và thêm SHA-1/SHA-256 cho app Android (bắt buộc cho Google Sign-In, Phone Auth, App Check). " +
          "Lấy SHA debug: `cd android && ./gradlew signingReport`, hoặc `keytool -list -v -keystore <file>`. " +
          "SHA của Play App Signing nằm trong Play Console → App integrity.",
        inputSchema: {
          project_id: projectArg,
          app_id: z.string().describe("App ID Android"),
          add: z.array(z.string()).optional().describe("Danh sách SHA cần thêm (có hoặc không dấu :)."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      safeHandler(async (args: { project_id?: string; app_id: string; add?: string[] }) => {
        if (platformOf(args.app_id) !== "android") throw new UserError("app_id không phải app Android.");
        const parent = `projects/-/androidApps/${args.app_id}`;
        const client = fb(args.project_id ?? projectFromAppId(args.app_id));
        const current = (await client.projects.androidApps.sha.list({ parent })).data.certificates ?? [];
        const have = new Set(current.map((c) => c.shaHash?.toLowerCase()));
        const lines: string[] = [];
        if (args.add?.length) {
          assertWritable();
          for (const raw of args.add) {
            const { hash, type } = normalizeSha(raw);
            if (have.has(hash)) {
              lines.push(`ℹ️ Đã có ${type} ${hash}`);
              continue;
            }
            await client.projects.androidApps.sha.create({ parent, requestBody: { shaHash: hash, certType: type } });
            have.add(hash);
            lines.push(`✓ Thêm ${type} ${hash}`);
          }
        }
        const all = (await client.projects.androidApps.sha.list({ parent })).data.certificates ?? [];
        lines.push("", "SHA hiện có:", ...all.map((c) => `• ${c.certType} ${c.shaHash}`));
        lines.push("", "Sau khi thêm SHA, tải lại google-services.json bằng firebase_get_sdk_config.");
        return textResult(lines.join("\n").trim(), {
          certificates: all.map((c) => ({ type: c.certType, sha: c.shaHash })),
        });
      }),
    );

    server.registerTool(
      "firebase_auth_get_config",
      {
        title: "Xem cấu hình Firebase Auth",
        description: "Xem các provider đăng nhập đang bật và authorized domains.",
        inputSchema: { project_id: projectArg },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      safeHandler(async ({ project_id }: { project_id?: string }) => {
        const project = defaultProject(project_id);
        const client = idt(project);
        const { data: cfg } = await client.projects.getConfig({ name: `projects/${project}/config` });
        const { data: idps } = await client.projects.defaultSupportedIdpConfigs.list({ parent: `projects/${project}` });
        const providers = (idps.defaultSupportedIdpConfigs ?? []).map((p) => ({
          idp: p.name?.split("/").pop(),
          enabled: !!p.enabled,
          clientId: p.clientId ?? null,
        }));
        const lines = [
          `Project ${project}`,
          `Email/password: ${cfg.signIn?.email?.enabled ? "bật" : "tắt"}`,
          `Phone: ${cfg.signIn?.phoneNumber?.enabled ? "bật" : "tắt"}`,
          `Anonymous: ${cfg.signIn?.anonymous?.enabled ? "bật" : "tắt"}`,
          "Provider:",
          ...(providers.length ? providers.map((p) => `• ${p.idp}: ${p.enabled ? "bật" : "tắt"}${p.clientId ? ` (client ${p.clientId})` : ""}`) : ["• (chưa có)"]),
          `Authorized domains: ${(cfg.authorizedDomains ?? []).join(", ")}`,
        ];
        return textResult(lines.join("\n"), {
          project,
          providers,
          authorizedDomains: cfg.authorizedDomains ?? [],
        });
      }),
    );

    server.registerTool(
      "firebase_auth_enable_google",
      {
        title: "Bật đăng nhập Google trong Firebase Auth",
        description:
          "Bật/cập nhật provider google.com bằng OAuth Web client (client_id + secret). " +
          "OAuth client loại Web KHÔNG tạo được qua API: tạo một lần ở Google Cloud Console → Credentials " +
          "(hoặc bật Google trong Firebase Console để Firebase tự tạo). Có thể đọc secret từ Secret Manager thay vì truyền trực tiếp.",
        inputSchema: {
          project_id: projectArg,
          client_id: z.string().describe("OAuth Web client ID (*.apps.googleusercontent.com)"),
          client_secret: z.string().optional().describe("Client secret. Khuyến nghị dùng client_secret_gcp_secret."),
          client_secret_gcp_secret: z.string().optional().describe("Tên secret trong Secret Manager chứa client secret."),
          enabled: z.boolean().optional().default(true),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      safeHandler(
        async (args: {
          project_id?: string;
          client_id: string;
          client_secret?: string;
          client_secret_gcp_secret?: string;
          enabled?: boolean;
        }) => {
          assertWritable();
          const project = defaultProject(args.project_id);
          const secret =
            args.client_secret ??
            (args.client_secret_gcp_secret ? await accessGcpSecret(project, args.client_secret_gcp_secret) : undefined);
          if (!secret) throw new UserError("Cần client_secret hoặc client_secret_gcp_secret.");
          const client = idt(project);
          const name = `projects/${project}/defaultSupportedIdpConfigs/google.com`;
          const body = { enabled: args.enabled ?? true, clientId: args.client_id, clientSecret: secret.trim() };
          let action = "cập nhật";
          try {
            await client.projects.defaultSupportedIdpConfigs.patch({
              name,
              updateMask: "enabled,clientId,clientSecret",
              requestBody: body,
            });
          } catch (err) {
            if (Number((err as { code?: unknown }).code) !== 404) throw err;
            await client.projects.defaultSupportedIdpConfigs.create({
              parent: `projects/${project}`,
              idpId: "google.com",
              requestBody: body,
            });
            action = "bật";
          }
          return textResult(
            `✓ Đã ${action} Google Sign-In cho ${project} (client ${args.client_id}, secret ${mask(body.clientSecret)}).\n` +
              "Nhắc lại: Android cần SHA (firebase_android_sha), web cần domain trong authorized domains (firebase_auth_authorized_domains).",
          );
        },
      ),
    );

    server.registerTool(
      "firebase_auth_authorized_domains",
      {
        title: "Quản lý authorized domains của Firebase Auth",
        description: "Thêm/bớt domain được phép dùng đăng nhập (popup/redirect) trên web.",
        inputSchema: {
          project_id: projectArg,
          add: z.array(z.string()).optional(),
          remove: z.array(z.string()).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      safeHandler(async (args: { project_id?: string; add?: string[]; remove?: string[] }) => {
        const project = defaultProject(args.project_id);
        const client = idt(project);
        const name = `projects/${project}/config`;
        const { data } = await client.projects.getConfig({ name });
        const domains = new Set(data.authorizedDomains ?? []);
        const before = domains.size;
        const clean = (d: string) => d.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
        for (const d of args.add ?? []) domains.add(clean(d));
        for (const d of args.remove ?? []) domains.delete(clean(d));
        const changed = (args.add?.length || args.remove?.length) &&
          (domains.size !== before || JSON.stringify([...domains]) !== JSON.stringify(data.authorizedDomains ?? []));
        if (changed) {
          assertWritable();
          await client.projects.updateConfig({
            name,
            updateMask: "authorizedDomains",
            requestBody: { authorizedDomains: [...domains] },
          });
        }
        return textResult(`${changed ? "✓ Đã cập nhật. " : ""}Authorized domains: ${[...domains].join(", ")}`, {
          authorizedDomains: [...domains],
        });
      }),
    );

    server.registerTool(
      "fcm_send",
      {
        title: "Gửi push FCM",
        description:
          "Gửi thông báo qua FCM HTTP v1 tới một device token hoặc topic — dùng để kiểm tra tích hợp push. " +
          "dry_run=true để chỉ kiểm tra token/payload mà không gửi thật.",
        inputSchema: {
          project_id: projectArg,
          token: z.string().optional().describe("FCM registration token của thiết bị."),
          topic: z.string().optional().describe("Tên topic (không có /topics/)."),
          title: z.string().optional(),
          body: z.string().optional(),
          data: z.record(z.string()).optional().describe("Payload data (chỉ giá trị chuỗi)."),
          image: z.string().optional().describe("URL ảnh hiển thị trong thông báo."),
          dry_run: z.boolean().optional().default(false),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      safeHandler(
        async (args: {
          project_id?: string;
          token?: string;
          topic?: string;
          title?: string;
          body?: string;
          data?: Record<string, string>;
          image?: string;
          dry_run?: boolean;
        }) => {
          if (!!args.token === !!args.topic) throw new UserError("Truyền đúng một trong token hoặc topic.");
          if (!args.dry_run) assertWritable();
          const project = defaultProject(args.project_id);
          const fcm = google.fcm({ version: "v1", ...apiOptions(project) });
          const res = await fcm.projects.messages.send({
            parent: `projects/${project}`,
            requestBody: {
              validateOnly: args.dry_run ?? false,
              message: {
                token: args.token,
                topic: args.topic,
                notification:
                  args.title || args.body || args.image ? { title: args.title, body: args.body, image: args.image } : undefined,
                data: args.data,
              },
            },
          });
          return textResult(`✓ ${args.dry_run ? "Hợp lệ (dry run)" : "Đã gửi"}: ${res.data.name}`, { name: res.data.name });
        },
      ),
    );
  },
};
