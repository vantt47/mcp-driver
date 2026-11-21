import { createRequire } from "node:module";
import { readEnv } from "../../core/env.js";
import { fetchJson, HttpOptions } from "../../core/http.js";
import { UserError } from "../../core/result.js";

const require = createRequire(import.meta.url);
// Bản ESM của libsodium-wrappers 0.7.x lỗi import — dùng bản CommonJS.
const sodium = require("libsodium-wrappers") as typeof import("libsodium-wrappers");

const API = "https://api.github.com";

export function githubToken(): string | undefined {
  return readEnv("GITHUB_TOKEN", "GH_TOKEN", "GITHUB_CLASSIC_TOKEN");
}

export async function gh<T = unknown>(pathname: string, opts: HttpOptions = {}) {
  const token = githubToken();
  if (!token) {
    throw new UserError("Thiếu GitHub token. Đặt GITHUB_TOKEN (hoặc GITHUB_CLASSIC_TOKEN) trong env.");
  }
  return fetchJson<T>("GitHub", `${API}${pathname}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mcp-platform",
      ...opts.headers,
    },
  });
}

export function parseRepo(repo: string): { owner: string; name: string } {
  const cleaned = repo
    .trim()
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  const [owner, name] = cleaned.split("/");
  if (!owner || !name) throw new UserError(`repo phải có dạng owner/name (nhận được: ${repo}).`);
  return { owner, name };
}

function scopePath(repo: string, environment?: string): string {
  const { owner, name } = parseRepo(repo);
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  return environment ? `${base}/environments/${encodeURIComponent(environment)}` : base;
}

export function validSecretName(name: string): string {
  const n = name.trim().toUpperCase();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(n) || n.startsWith("GITHUB_")) {
    throw new UserError(
      `Tên secret/variable GitHub không hợp lệ: "${name}" (chỉ A-Z, 0-9, _; không bắt đầu bằng số hoặc GITHUB_).`,
    );
  }
  return n;
}

/** Tạo/cập nhật Actions secret (repo hoặc environment). Giá trị được mã hoá sealed box. */
export async function setGithubSecret(
  repo: string,
  name: string,
  value: string,
  environment?: string,
): Promise<"created" | "updated"> {
  const base = scopePath(repo, environment);
  const secretName = validSecretName(name);
  const { data: key } = await gh<{ key: string; key_id: string }>(`${base}/actions/secrets/public-key`);

  await sodium.ready;
  const encrypted = sodium.to_base64(
    sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL)),
    sodium.base64_variants.ORIGINAL,
  );

  const { status } = await gh(`${base}/actions/secrets/${secretName}`, {
    method: "PUT",
    body: { encrypted_value: encrypted, key_id: key.key_id },
  });
  return status === 201 ? "created" : "updated";
}

export async function setGithubVariable(
  repo: string,
  name: string,
  value: string,
  environment?: string,
): Promise<"created" | "updated"> {
  const base = scopePath(repo, environment);
  const varName = validSecretName(name);
  try {
    await gh(`${base}/actions/variables/${varName}`, { method: "PATCH", body: { name: varName, value } });
    return "updated";
  } catch (err) {
    if (!(err instanceof UserError) || !err.message.includes("HTTP 404")) throw err;
    await gh(`${base}/actions/variables`, { method: "POST", body: { name: varName, value } });
    return "created";
  }
}

export async function listGithubSecrets(repo: string, environment?: string) {
  const base = scopePath(repo, environment);
  const { data } = await gh<{ secrets: Array<{ name: string; updated_at: string }> }>(
    `${base}/actions/secrets`,
    { query: { per_page: 100 } },
  );
  return data.secrets;
}

export async function listGithubVariables(repo: string, environment?: string) {
  const base = scopePath(repo, environment);
  const { data } = await gh<{ variables: Array<{ name: string; value: string; updated_at: string }> }>(
    `${base}/actions/variables`,
    { query: { per_page: 30 } },
  );
  return data.variables;
}
