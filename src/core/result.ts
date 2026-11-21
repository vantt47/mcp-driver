/** Ghi log ra stderr — stdout được dành riêng cho giao thức MCP (JSON-RPC). */
export function log(...args: unknown[]): void {
  console.error("[mcp-platform]", ...args);
}

/** Kết quả trả về cho MCP (content blocks). */
export type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

export function textResult(text: string, structured?: Record<string, unknown>): ToolResult {
  return structured
    ? { content: [{ type: "text", text }], structuredContent: structured }
    : { content: [{ type: "text", text }] };
}

/** Lỗi đã có thông điệp thân thiện — không cần diễn giải thêm. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

/** Diễn giải lỗi chung của Google API (gaxios) / HTTP. */
export function explainError(err: unknown): string {
  if (err instanceof UserError) return err.message;
  const e = err as {
    code?: number | string;
    status?: number;
    message?: string;
    errors?: Array<{ message?: string }>;
    response?: { status?: number; data?: { error?: { message?: string } | string } };
  };
  const status = Number(e?.response?.status ?? e?.status ?? e?.code);
  const dataErr = e?.response?.data?.error;
  const detail =
    (typeof dataErr === "string" ? dataErr : dataErr?.message) ??
    e?.errors?.[0]?.message ??
    e?.message ??
    String(err);

  switch (status) {
    case 401:
      return `Chưa xác thực hoặc token hết hạn (401). ${detail}`;
    case 403:
      return `Bị từ chối quyền (403): tài khoản/token không đủ quyền, API chưa bật, hoặc thiếu quota project. ${detail}`;
    case 404:
      return `Không tìm thấy (404). ${detail}`;
    case 409:
      return `Đã tồn tại / xung đột (409). ${detail}`;
    case 429:
      return `Vượt hạn mức API (429), thử lại sau. ${detail}`;
    default:
      return detail;
  }
}

/** Bọc handler để mọi lỗi đều trả về dạng isError thay vì làm sập server. */
export function safeHandler<A>(
  fn: (args: A) => Promise<ToolResult>,
  explain: (err: unknown) => string = explainError,
) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      return { content: [{ type: "text", text: `❌ ${explain(err)}` }], isError: true };
    }
  };
}

/** Che bớt giá trị nhạy cảm khi cần hiển thị. */
export function mask(value: string): string {
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} ký tự)`;
}

/** Chờ một long-running operation (Google) hoàn tất. */
export async function waitOperation<T extends { done?: boolean | null; error?: unknown; name?: string | null }>(
  first: T,
  poll: (name: string) => Promise<T>,
  timeoutMs = 120_000,
): Promise<T> {
  let op = first;
  const started = Date.now();
  let delay = 1000;
  while (!op.done) {
    if (!op.name) break;
    if (Date.now() - started > timeoutMs) {
      throw new UserError(`Operation ${op.name} chưa xong sau ${timeoutMs / 1000}s — kiểm tra lại sau.`);
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 5000);
    op = await poll(op.name);
  }
  if (op.error) {
    const e = op.error as { message?: string; code?: number };
    throw new UserError(`Operation lỗi${e.code ? ` (${e.code})` : ""}: ${e.message ?? JSON.stringify(e)}`);
  }
  return op;
}
