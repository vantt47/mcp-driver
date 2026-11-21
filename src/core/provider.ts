import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ProviderStatus {
  configured: boolean;
  /** Mô tả ngắn: đang dùng credential nào, hoặc thiếu gì. KHÔNG chứa giá trị bí mật. */
  detail: string;
}

export interface Provider {
  id: string;
  title: string;
  /** Hướng dẫn ngắn gộp vào `instructions` của server. */
  instructions: string;
  status(): ProviderStatus | Promise<ProviderStatus>;
  register(server: McpServer): void;
}
