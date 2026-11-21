import crypto from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Provider } from "../../core/provider.js";
import { assertWritable, readEnv } from "../../core/env.js";
import { fetchJson, HttpOptions } from "../../core/http.js";
import { UserError, safeHandler, textResult } from "../../core/result.js";

const API = "https://api.appstoreconnect.apple.com/v1";

function privateKey(): string | undefined {
  const inline = readEnv("ASC_PRIVATE_KEY");
  if (inline) return inline.replace(/\\n/g, "\n");
  const p = readEnv("ASC_PRIVATE_KEY_PATH");
  if (p && fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  return undefined;
}

let cachedJwt: { token: string; exp: number } | null = null;

/** JWT ES256 cho App Store Connect API (hạn tối đa 20 phút). */
function jwt(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && cachedJwt.exp - 60 > now) return cachedJwt.token;
  const keyId = readEnv("ASC_KEY_ID");
  const issuer = readEnv("ASC_ISSUER_ID");
  const key = privateKey();
  if (!keyId || !issuer || !key) {
    throw new UserError(
      "Thiếu ASC_KEY_ID / ASC_ISSUER_ID / ASC_PRIVATE_KEY_PATH. Tạo API key tại App Store Connect → Users and Access → Integrations → App Store Connect API (role Admin hoặc App Manager).",
    );
  }
  const exp = now + 15 * 60;
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput = `${b64({ alg: "ES256", kid: keyId, typ: "JWT" })}.${b64({ iss: issuer, iat: now, exp, aud: "appstoreconnect-v1" })}`;
  const sig = crypto.sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  cachedJwt = { token: `${signingInput}.${sig.toString("base64url")}`, exp };
  return cachedJwt.token;
}

async function asc<T>(pathname: string, opts: HttpOptions = {}): Promise<T> {
  const { data } = await fetchJson<T>("App Store Connect", `${API}${pathname}`, {
    ...opts,
    headers: { Authorization: `Bearer ${jwt()}`, ...opts.headers },
  });
  return data;
}

interface BundleId {
  id: string;
  attributes: { identifier: string; name: string; platform: string; seedId?: string };
}

async function findBundle(identifier: string): Promise<BundleId | undefined> {
  const res = await asc<{ data: BundleId[] }>("/bundleIds", {
    query: { "filter[identifier]": identifier, limit: 200 },
  });
  return res.data.find((b) => b.attributes.identifier === identifier);
}

async function listCapabilities(bundleResourceId: string) {
  const res = await asc<{ data: Array<{ id: string; attributes: { capabilityType: string } }> }>(
    `/bundleIds/${bundleResourceId}/bundleIdCapabilities`,
  );
  return res.data;
}

/** Một số capability bắt buộc kèm settings. */
function capabilitySettings(type: string) {
  if (type === "SIGN_IN_WITH_APPLE") {
    return [{ key: "APPLE_ID_AUTH", options: [{ key: "PRIMARY_APP_CONSENT" }] }];
  }
  if (type === "ICLOUD") {
    return [{ key: "ICLOUD_VERSION", options: [{ key: "XCODE_6" }] }];
  }
  if (type === "DATA_PROTECTION") {
    return [{ key: "DATA_PROTECTION_PERMISSION_LEVEL", options: [{ key: "COMPLETE_PROTECTION" }] }];
  }
  return undefined;
}

export const appleProvider: Provider = {
  id: "apple",
  title: "Apple (App Store Connect)",
  instructions:
    "apple_*: App Store Connect API — bundle ID và capability (Push Notifications, Sign in with Apple…). " +
    "APNs Auth Key (.p8) KHÔNG tạo/upload được qua API: xem platform_setup_guide flow=fcm_ios.",
  status() {
    const ok = !!(readEnv("ASC_KEY_ID") && readEnv("ASC_ISSUER_ID") && privateKey());
    return {
      configured: ok,
      detail: ok ? `ASC key ${readEnv("ASC_KEY_ID")}` : "Thiếu ASC_KEY_ID / ASC_ISSUER_ID / ASC_PRIVATE_KEY_PATH",
    };
  },

  register(server: McpServer) {
    server.registerTool(
      "apple_list_bundle_ids",
      {
        title: "Liệt kê bundle ID",
        description: "Liệt kê bundle ID (App IDs) trong tài khoản Apple Developer.",
        inputSchema: { identifier: z.string().optional().describe("Lọc theo identifier (khớp tiền tố).") },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      safeHandler(async ({ identifier }: { identifier?: string }) => {
        const res = await asc<{ data: BundleId[] }>("/bundleIds", {
          query: { "filter[identifier]": identifier, limit: 200, sort: "identifier" },
        });
        return textResult(
          res.data.map((b) => `• ${b.attributes.identifier}  (${b.attributes.name}, ${b.attributes.platform})  id=${b.id}`).join("\n") ||
            "Không có bundle ID nào.",
          { bundleIds: res.data.map((b) => ({ id: b.id, ...b.attributes })) },
        );
      }),
    );

    server.registerTool(
      "apple_create_bundle_id",
      {
        title: "Đăng ký bundle ID",
        description: "Đăng ký App ID mới (bỏ qua nếu đã có).",
        inputSchema: {
          identifier: z.string().describe("VD vn.dmst.myapp"),
          name: z.string().describe("Tên hiển thị (chỉ chữ, số, khoảng trắng)."),
          platform: z.enum(["IOS", "MAC_OS", "UNIVERSAL"]).optional().default("IOS"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      safeHandler(async (args: { identifier: string; name: string; platform?: string }) => {
        assertWritable();
        const existing = await findBundle(args.identifier);
        if (existing) return textResult(`ℹ️ Đã có ${args.identifier} (id=${existing.id}).`, { id: existing.id, created: false });
        const res = await asc<{ data: BundleId }>("/bundleIds", {
          method: "POST",
          body: {
            data: {
              type: "bundleIds",
              attributes: { identifier: args.identifier, name: args.name, platform: args.platform ?? "IOS" },
            },
          },
        });
        return textResult(`✓ Đã tạo bundle ID ${args.identifier} (id=${res.data.id}).`, { id: res.data.id, created: true });
      }),
    );

    server.registerTool(
      "apple_bundle_capabilities",
      {
        title: "Xem/bật capability cho bundle ID",
        description:
          "Liệt kê và bật capability cho App ID. Hay dùng: PUSH_NOTIFICATIONS (FCM/APNs), SIGN_IN_WITH_APPLE, " +
          "ASSOCIATED_DOMAINS (Universal Links), APP_GROUPS, ICLOUD, IN_APP_PURCHASE. " +
          "Sau khi bật cần tải lại provisioning profile (Xcode tự làm nếu dùng Automatic signing).",
        inputSchema: {
          identifier: z.string().describe("Bundle identifier."),
          enable: z.array(z.string()).optional().describe("Danh sách capabilityType cần bật."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      safeHandler(async (args: { identifier: string; enable?: string[] }) => {
        const bundle = await findBundle(args.identifier);
        if (!bundle) throw new UserError(`Không tìm thấy bundle ID ${args.identifier}. Tạo bằng apple_create_bundle_id.`);
        const current = await listCapabilities(bundle.id);
        const have = new Set(current.map((c) => c.attributes.capabilityType));
        const lines: string[] = [];
        for (const raw of args.enable ?? []) {
          const type = raw.trim().toUpperCase();
          if (have.has(type)) {
            lines.push(`ℹ️ ${type} đã bật`);
            continue;
          }
          assertWritable();
          await asc("/bundleIdCapabilities", {
            method: "POST",
            body: {
              data: {
                type: "bundleIdCapabilities",
                attributes: { capabilityType: type, settings: capabilitySettings(type) },
                relationships: { bundleId: { data: { type: "bundleIds", id: bundle.id } } },
              },
            },
          });
          have.add(type);
          lines.push(`✓ Đã bật ${type}`);
        }
        lines.push(`Capability của ${args.identifier}: ${[...have].sort().join(", ") || "(không có)"}`);
        return textResult(lines.join("\n"), { identifier: args.identifier, capabilities: [...have] });
      }),
    );
  },
};
