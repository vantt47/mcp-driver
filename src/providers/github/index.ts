import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Provider } from "../../core/provider.js";
import { assertWritable } from "../../core/env.js";
import { safeHandler, textResult } from "../../core/result.js";
import { valueFrom } from "../gcp/index.js";
import {
  githubToken,
  listGithubSecrets,
  listGithubVariables,
  setGithubSecret,
  setGithubVariable,
} from "./client.js";

const repoArg = z.string().describe("owner/name (hoặc URL repo GitHub).");
const envArg = z.string().optional().describe("GitHub Actions environment (bỏ trống = cấp repo).");

export const githubProvider: Provider = {
  id: "github",
  title: "GitHub",
  instructions:
    "github_*: Actions secrets & variables. Secret được mã hoá sealed box trước khi gửi; giá trị không bao giờ đọc ngược lại được.",
  status() {
    return githubToken()
      ? { configured: true, detail: "GitHub token đã đặt (GITHUB_TOKEN / GITHUB_CLASSIC_TOKEN)" }
      : { configured: false, detail: "Thiếu GITHUB_TOKEN" };
  },

  register(server: McpServer) {
    server.registerTool(
      "github_list_secrets",
      {
        title: "Liệt kê Actions secrets & variables",
        description: "Liệt kê tên secret (không có giá trị) và variable của repo hoặc environment.",
        inputSchema: { repo: repoArg, environment: envArg },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      safeHandler(async ({ repo, environment }: { repo: string; environment?: string }) => {
        const [secrets, variables] = await Promise.all([
          listGithubSecrets(repo, environment),
          listGithubVariables(repo, environment).catch(() => []),
        ]);
        const lines = [
          `Repo ${repo}${environment ? ` / env ${environment}` : ""}`,
          `Secrets (${secrets.length}):`,
          ...secrets.map((s) => `• ${s.name}  (cập nhật ${s.updated_at})`),
          `Variables (${variables.length}):`,
          ...variables.map((v) => `• ${v.name} = ${v.value}`),
        ];
        return textResult(lines.join("\n"), {
          secrets: secrets.map((s) => s.name),
          variables: variables.map((v) => ({ name: v.name, value: v.value })),
        });
      }),
    );

    server.registerTool(
      "github_set_secret",
      {
        title: "Đặt Actions secret",
        description:
          "Tạo/cập nhật GitHub Actions secret. Ưu tiên from_file (VD service-account.json) để giá trị không đi qua chat. " +
          "Muốn ghi cùng lúc vào nhiều nơi (.env, Secret Manager, GitHub) hãy dùng secret_store.",
        inputSchema: {
          repo: repoArg,
          name: z.string().describe("Tên secret (sẽ viết hoa)."),
          value: z.string().optional(),
          from_file: z.string().optional().describe("Đường dẫn file chứa giá trị."),
          environment: envArg,
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      safeHandler(
        async (args: { repo: string; name: string; value?: string; from_file?: string; environment?: string }) => {
          assertWritable();
          const value = valueFrom(args);
          const r = await setGithubSecret(args.repo, args.name, value, args.environment);
          return textResult(
            `✓ ${r === "created" ? "Đã tạo" : "Đã cập nhật"} secret ${args.name.toUpperCase()} trên ${args.repo}${args.environment ? ` (env ${args.environment})` : ""}.`,
          );
        },
      ),
    );

    server.registerTool(
      "github_set_variable",
      {
        title: "Đặt Actions variable",
        description: "Tạo/cập nhật GitHub Actions variable (giá trị KHÔNG bí mật, VD project ID, URL).",
        inputSchema: {
          repo: repoArg,
          name: z.string(),
          value: z.string(),
          environment: envArg,
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      safeHandler(async (args: { repo: string; name: string; value: string; environment?: string }) => {
        assertWritable();
        const r = await setGithubVariable(args.repo, args.name, args.value, args.environment);
        return textResult(`✓ ${r === "created" ? "Đã tạo" : "Đã cập nhật"} variable ${args.name.toUpperCase()} = ${args.value}`);
      }),
    );
  },
};
