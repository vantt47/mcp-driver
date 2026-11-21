import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Provider } from "../../core/provider.js";
import { assertWritable, readEnv } from "../../core/env.js";
import { fetchJson, HttpOptions } from "../../core/http.js";
import { UserError, safeHandler, textResult } from "../../core/result.js";

const API = "https://api.cloudflare.com/client/v4";

function token(): string {
  const t = readEnv("CLOUDFLARE_API_TOKEN", "CF_API_TOKEN");
  if (!t) throw new UserError("Thiếu CLOUDFLARE_API_TOKEN trong env.");
  return t;
}

async function cf<T>(pathname: string, opts: HttpOptions = {}): Promise<T> {
  const { data } = await fetchJson<{ success: boolean; result: T; errors?: unknown[] }>(
    "Cloudflare",
    `${API}${pathname}`,
    { ...opts, headers: { Authorization: `Bearer ${token()}`, ...opts.headers } },
  );
  if (!data.success) throw new UserError(`Cloudflare lỗi: ${JSON.stringify(data.errors)}`);
  return data.result;
}

interface Zone {
  id: string;
  name: string;
  status: string;
  plan?: { name?: string };
  account?: { id: string; name: string };
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl: number;
  comment?: string | null;
}

async function resolveZone(zone: string): Promise<Zone> {
  if (/^[0-9a-f]{32}$/i.test(zone)) return cf<Zone>(`/zones/${zone}`);
  const list = await cf<Zone[]>("/zones", { query: { name: zone.toLowerCase() } });
  if (!list.length) throw new UserError(`Token không thấy zone ${zone}.`);
  return list[0];
}

/** "api" + dmst.vn → api.dmst.vn; "@" → dmst.vn; tên đầy đủ giữ nguyên. */
function fqdn(name: string, zoneName: string): string {
  const n = name.trim().toLowerCase().replace(/\.$/, "");
  if (n === "@" || n === zoneName) return zoneName;
  return n.endsWith(`.${zoneName}`) ? n : `${n}.${zoneName}`;
}

function fmt(r: DnsRecord): string {
  return `• ${r.type.padEnd(5)} ${r.name} → ${r.content}${r.proxied ? " (proxied)" : ""}  ttl=${r.ttl === 1 ? "auto" : r.ttl}  id=${r.id}${r.comment ? `  # ${r.comment}` : ""}`;
}

const zoneArg = z.string().describe("Tên zone (VD dmst.vn) hoặc zone ID.");

export const cloudflareProvider: Provider = {
  id: "cloudflare",
  title: "Cloudflare",
  instructions:
    "cf_*: DNS & Tunnel Cloudflare. Luôn cf_list_dns trước khi thêm; cf_upsert_dns mặc định KHÔNG ghi đè record đã tồn tại " +
    "(cần overwrite=true và xác nhận của người dùng). Không sửa record của dự án khác.",
  status() {
    const t = readEnv("CLOUDFLARE_API_TOKEN", "CF_API_TOKEN");
    return { configured: !!t, detail: t ? "CLOUDFLARE_API_TOKEN đã đặt" : "Thiếu CLOUDFLARE_API_TOKEN" };
  },

  register(server: McpServer) {
    server.registerTool(
      "cf_list_zones",
      {
        title: "Liệt kê zone Cloudflare",
        description: "Liệt kê các zone mà token truy cập được (kèm account ID).",
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      safeHandler(async () => {
        const zones = await cf<Zone[]>("/zones", { query: { per_page: 50 } });
        return textResult(
          zones.map((z) => `• ${z.name}  id=${z.id}  account=${z.account?.id} (${z.account?.name})  ${z.status}`).join("\n") || "Không có zone nào.",
          { zones: zones.map((z) => ({ id: z.id, name: z.name, accountId: z.account?.id })) },
        );
      }),
    );

    server.registerTool(
      "cf_list_dns",
      {
        title: "Liệt kê DNS record",
        description: "Liệt kê DNS record của zone, lọc theo tên hoặc loại.",
        inputSchema: {
          zone: zoneArg,
          name: z.string().optional().describe("Tên (đầy đủ hoặc phần trước zone)."),
          type: z.string().optional().describe("A, AAAA, CNAME, TXT, MX…"),
          search: z.string().optional().describe("Lọc chứa chuỗi trong tên (lọc phía client)."),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      safeHandler(async (args: { zone: string; name?: string; type?: string; search?: string }) => {
        const zone = await resolveZone(args.zone);
        const all: DnsRecord[] = [];
        for (let page = 1; page <= 20; page++) {
          const batch = await cf<DnsRecord[]>(`/zones/${zone.id}/dns_records`, {
            query: {
              per_page: 100,
              page,
              name: args.name ? fqdn(args.name, zone.name) : undefined,
              type: args.type?.toUpperCase(),
            },
          });
          all.push(...batch);
          if (batch.length < 100) break;
        }
        const filtered = args.search ? all.filter((r) => r.name.includes(args.search!.toLowerCase())) : all;
        return textResult(
          `${filtered.length} record trong ${zone.name}:\n${filtered.map(fmt).join("\n")}`,
          { zone: zone.name, records: filtered },
        );
      }),
    );

    server.registerTool(
      "cf_upsert_dns",
      {
        title: "Tạo/cập nhật DNS record",
        description:
          "Tạo DNS record. Nếu đã có record cùng tên + loại: mặc định BÁO LỖI và in record hiện có; " +
          "chỉ cập nhật khi overwrite=true (hãy hỏi người dùng trước).",
        inputSchema: {
          zone: zoneArg,
          type: z.enum(["A", "AAAA", "CNAME", "TXT", "MX", "SRV", "CAA", "NS"]),
          name: z.string().describe("VD api-myapp (→ api-myapp.<zone>) hoặc tên đầy đủ; @ = apex."),
          content: z.string(),
          proxied: z.boolean().optional().describe("Mặc định true cho A/AAAA/CNAME."),
          ttl: z.number().int().optional().default(1).describe("1 = auto"),
          priority: z.number().int().optional().describe("Cho MX"),
          comment: z.string().optional(),
          overwrite: z.boolean().optional().default(false),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      safeHandler(
        async (args: {
          zone: string;
          type: string;
          name: string;
          content: string;
          proxied?: boolean;
          ttl?: number;
          priority?: number;
          comment?: string;
          overwrite?: boolean;
        }) => {
          assertWritable();
          const zone = await resolveZone(args.zone);
          const name = fqdn(args.name, zone.name);
          const proxiable = ["A", "AAAA", "CNAME"].includes(args.type);
          const body = {
            type: args.type,
            name,
            content: args.content,
            ttl: args.ttl ?? 1,
            ...(proxiable ? { proxied: args.proxied ?? true } : {}),
            ...(args.priority !== undefined ? { priority: args.priority } : {}),
            ...(args.comment ? { comment: args.comment } : {}),
          };
          const existing = await cf<DnsRecord[]>(`/zones/${zone.id}/dns_records`, {
            query: { name, type: args.type },
          });
          // CNAME xung đột với mọi loại khác cùng tên.
          const conflicts =
            args.type === "CNAME"
              ? await cf<DnsRecord[]>(`/zones/${zone.id}/dns_records`, { query: { name } })
              : existing;

          if (conflicts.length && !(args.overwrite && existing.length === 1 && conflicts.length === 1)) {
            const same = existing.find((r) => r.content === args.content && (!proxiable || r.proxied === body.proxied));
            if (same && existing.length === 1) return textResult(`ℹ️ Record đã đúng, không đổi:\n${fmt(same)}`, { record: same });
            throw new UserError(
              `${name} đã có record:\n${conflicts.map(fmt).join("\n")}\n` +
                (args.overwrite
                  ? "Có nhiều record/loại khác nhau — tự xử lý bằng cf_delete_dns rồi tạo lại."
                  : "Không ghi đè. Nếu chắc chắn đây là record của dự án này, gọi lại với overwrite=true."),
            );
          }

          if (existing.length === 1) {
            const r = await cf<DnsRecord>(`/zones/${zone.id}/dns_records/${existing[0].id}`, { method: "PATCH", body });
            return textResult(`✓ Đã cập nhật:\n${fmt(r)}`, { record: r, action: "updated" });
          }
          const r = await cf<DnsRecord>(`/zones/${zone.id}/dns_records`, { method: "POST", body });
          return textResult(`✓ Đã tạo:\n${fmt(r)}`, { record: r, action: "created" });
        },
      ),
    );

    server.registerTool(
      "cf_delete_dns",
      {
        title: "Xoá DNS record",
        description: "Xoá một DNS record theo ID (lấy từ cf_list_dns). Luôn xác nhận với người dùng trước.",
        inputSchema: { zone: zoneArg, record_id: z.string() },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      safeHandler(async (args: { zone: string; record_id: string }) => {
        assertWritable();
        const zone = await resolveZone(args.zone);
        const rec = await cf<DnsRecord>(`/zones/${zone.id}/dns_records/${args.record_id}`);
        await cf(`/zones/${zone.id}/dns_records/${args.record_id}`, { method: "DELETE" });
        return textResult(`✓ Đã xoá:\n${fmt(rec)}`);
      }),
    );

    server.registerTool(
      "cf_list_tunnels",
      {
        title: "Liệt kê Cloudflare Tunnel",
        description: "Liệt kê tunnel trong account (cần quyền Tunnel trên token).",
        inputSchema: {
          account_id: z.string().optional().describe("Account ID. Mặc định CLOUDFLARE_ACCOUNT_ID."),
          name: z.string().optional(),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      safeHandler(async (args: { account_id?: string; name?: string }) => {
        const account = args.account_id ?? readEnv("CLOUDFLARE_ACCOUNT_ID");
        if (!account) throw new UserError("Cần account_id (hoặc CLOUDFLARE_ACCOUNT_ID). Xem cf_list_zones.");
        const list = await cf<Array<{ id: string; name: string; status: string; created_at: string }>>(
          `/accounts/${account}/cfd_tunnel`,
          { query: { is_deleted: false, name: args.name, per_page: 100 } },
        );
        return textResult(
          list.map((t) => `• ${t.name}  id=${t.id}  ${t.status}`).join("\n") || "Không có tunnel nào.",
          { tunnels: list },
        );
      }),
    );
  },
};
