import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { sheets_v4 } from "googleapis";
import { UserError } from "../../../core/result.js";
import { Sheets, normalizeFileId } from "../drive.js";
import { ToolContext, ToolResult, assertWritable, safeHandler, textResult } from "./common.js";

/**
 * Google Sheets theo từng ô (Sheets API v4). Khác gdrive_update (ghi đè cả file),
 * các tool này giữ nguyên tab khác, công thức, định dạng, dropdown.
 */

type Tab = { sheetId: number; title: string; rows: number; cols: number; index: number };

/** Lấy spreadsheetId và gid (nếu có) từ ID hoặc URL docs.google.com/spreadsheets/d/<ID>/edit#gid=<gid>. */
export function parseSpreadsheetRef(input: string): { id: string; gid?: number } {
  const value = input.trim();
  const id = normalizeFileId(value);
  const gidMatch = value.match(/[#?&]gid=(\d+)/);
  return { id, gid: gidMatch ? Number(gidMatch[1]) : undefined };
}

async function listTabs(sheets: Sheets, spreadsheetId: string): Promise<{ title: string; tabs: Tab[] }> {
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "properties.title,sheets.properties(sheetId,title,index,gridProperties(rowCount,columnCount))",
  });
  const tabs = (res.data.sheets ?? []).map((s) => ({
    sheetId: s.properties?.sheetId ?? 0,
    title: s.properties?.title ?? "",
    index: s.properties?.index ?? 0,
    rows: s.properties?.gridProperties?.rowCount ?? 0,
    cols: s.properties?.gridProperties?.columnCount ?? 0,
  }));
  return { title: res.data.properties?.title ?? "", tabs };
}

/** 'Tab name' → A1 sheet prefix có escape. */
function quoteTab(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

/**
 * Ghép range cuối cùng: nếu range đã có "Tab!..." thì giữ nguyên; nếu không thì
 * thêm tên tab lấy từ `tab` (tên) / `gid` (tham số hoặc trong URL).
 */
async function resolveRange(
  sheets: Sheets,
  ref: { id: string; gid?: number },
  args: { range?: string; tab?: string; gid?: number },
): Promise<{ range: string; tab?: Tab }> {
  const raw = args.range?.trim() ?? "";
  if (raw.includes("!")) return { range: raw };

  const { tabs } = await listTabs(sheets, ref.id);
  let tab: Tab | undefined;
  const gid = args.gid ?? ref.gid;
  if (args.tab) {
    tab = tabs.find((t) => t.title === args.tab) ?? tabs.find((t) => t.title.toLowerCase() === args.tab!.toLowerCase());
    if (!tab) throw new UserError(`Không có tab "${args.tab}". Các tab: ${tabs.map((t) => t.title).join(", ")}`);
  } else if (gid !== undefined) {
    tab = tabs.find((t) => t.sheetId === gid);
    if (!tab) throw new UserError(`Không có tab gid=${gid}. Các tab: ${tabs.map((t) => `${t.title} (gid ${t.sheetId})`).join(", ")}`);
  } else {
    tab = [...tabs].sort((a, b) => a.index - b.index)[0];
  }
  if (!tab) throw new UserError("Spreadsheet không có tab nào.");
  return { range: raw ? `${quoteTab(tab.title)}!${raw}` : quoteTab(tab.title), tab };
}

/** Số cột (0-based) → chữ cột A1. */
function colLetter(n: number): string {
  let s = "";
  for (let x = n + 1; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** Dòng bắt đầu của một range A1 dạng 'Tab'!B5:D9 → {row: 5, col: 1}. */
function rangeStart(a1: string): { row: number; col: number } {
  const part = a1.includes("!") ? a1.slice(a1.lastIndexOf("!") + 1) : "";
  const m = part.match(/^([A-Za-z]*)(\d*)/);
  const letters = (m?.[1] ?? "").toUpperCase();
  let col = 0;
  for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: m?.[2] ? Number(m[2]) : 1, col: letters ? col - 1 : 0 };
}

function formatGrid(values: unknown[][], start: { row: number; col: number }): string {
  if (!values.length) return "(vùng trống)";
  const width = Math.max(...values.map((r) => r.length));
  const header = "     | " + Array.from({ length: width }, (_, i) => colLetter(start.col + i)).join(" | ");
  const lines = values.map(
    (r, i) =>
      `${String(start.row + i).padStart(4)} | ` +
      Array.from({ length: width }, (_, j) => String(r[j] ?? "").replace(/\r?\n/g, "⏎")).join(" | "),
  );
  return [header, ...lines].join("\n");
}

const spreadsheetArg = z
  .string()
  .describe("Spreadsheet ID hoặc URL docs.google.com/spreadsheets/d/<ID>/edit#gid=<gid> (gid trong URL dùng để chọn tab).");
const tabArgs = {
  tab: z.string().optional().describe("Tên tab. Bỏ qua nếu range đã có 'Tab'!... hoặc URL có gid."),
  gid: z.number().int().optional().describe("sheetId (gid) của tab."),
};
const valuesArg = z
  .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
  .min(1)
  .describe("Mảng 2 chiều: mỗi phần tử là một dòng. null = giữ nguyên ô, \"\" = xoá ô.");
const inputOptionArg = z
  .enum(["USER_ENTERED", "RAW"])
  .optional()
  .default("USER_ENTERED")
  .describe("USER_ENTERED (mặc định): hiểu như gõ tay — '=…' là công thức, ngày/số được parse. RAW: ghi nguyên chuỗi.");

export function registerSheetTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "gsheet_info",
    {
      title: "Liệt kê tab của Google Sheet",
      description: "Trả về tên spreadsheet và các tab (tên, gid, số dòng/cột). Dùng trước khi đọc/ghi để chọn đúng tab.",
      inputSchema: { spreadsheet: spreadsheetArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safeHandler(async (args: { spreadsheet: string }): Promise<ToolResult> => {
      const ref = parseSpreadsheetRef(args.spreadsheet);
      const { title, tabs } = await listTabs(ctx.sheets(), ref.id);
      const lines = tabs
        .sort((a, b) => a.index - b.index)
        .map((t) => `• ${t.title} — gid ${t.sheetId} — ${t.rows} dòng × ${t.cols} cột${t.sheetId === ref.gid ? "  ← tab trong URL" : ""}`);
      return textResult(`Spreadsheet: ${title}\nID: ${ref.id}\n\n${lines.join("\n")}`, { title, id: ref.id, tabs });
    }),
  );

  server.registerTool(
    "gsheet_read",
    {
      title: "Đọc vùng ô trong Google Sheet",
      description:
        "Đọc một vùng ô (A1) của một tab, trả về bảng có số dòng và chữ cột để biết chính xác vị trí ô. " +
        "Không có range → đọc cả tab.",
      inputSchema: {
        spreadsheet: spreadsheetArg,
        range: z.string().optional().describe("Vùng A1, ví dụ A1:H50 hoặc 'Tab'!A:F. Bỏ trống = cả tab."),
        ...tabArgs,
        render: z
          .enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"])
          .optional()
          .default("FORMATTED_VALUE")
          .describe("FORMULA để xem công thức thay vì kết quả."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safeHandler(
      async (args: { spreadsheet: string; range?: string; tab?: string; gid?: number; render?: string }): Promise<ToolResult> => {
        const sheets = ctx.sheets();
        const ref = parseSpreadsheetRef(args.spreadsheet);
        const { range } = await resolveRange(sheets, ref, args);
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: ref.id,
          range,
          valueRenderOption: args.render ?? "FORMATTED_VALUE",
        });
        const actual = res.data.range ?? range;
        const values = (res.data.values ?? []) as unknown[][];
        return textResult(`Range: ${actual}\n\n${formatGrid(values, rangeStart(actual))}`, { range: actual, values });
      },
    ),
  );

  server.registerTool(
    "gsheet_update",
    {
      title: "Ghi giá trị vào vùng ô Google Sheet",
      description:
        "Ghi giá trị vào đúng vùng ô (ví dụ A12:F12). Chỉ đổi giá trị các ô được ghi; định dạng, tab khác, ô khác giữ nguyên. " +
        "Đọc gsheet_read trước để chắc chắn không ghi đè dữ liệu đang có.",
      inputSchema: {
        spreadsheet: spreadsheetArg,
        range: z.string().describe("Ô/vùng bắt đầu ghi, ví dụ A12 hoặc 'Tab'!A12:F12."),
        ...tabArgs,
        values: valuesArg,
        input_option: inputOptionArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safeHandler(
      async (args: {
        spreadsheet: string;
        range: string;
        tab?: string;
        gid?: number;
        values: unknown[][];
        input_option?: string;
      }): Promise<ToolResult> => {
        assertWritable(ctx.config);
        const sheets = ctx.sheets();
        const ref = parseSpreadsheetRef(args.spreadsheet);
        const { range } = await resolveRange(sheets, ref, args);
        const res = await sheets.spreadsheets.values.update({
          spreadsheetId: ref.id,
          range,
          valueInputOption: args.input_option ?? "USER_ENTERED",
          includeValuesInResponse: true,
          requestBody: { values: args.values },
        });
        const d = res.data;
        const written = (d.updatedData?.values ?? []) as unknown[][];
        return textResult(
          `✅ Đã ghi ${d.updatedCells ?? 0} ô vào ${d.updatedRange}\n\n${formatGrid(written, rangeStart(d.updatedRange ?? range))}`,
          { updatedRange: d.updatedRange, updatedCells: d.updatedCells },
        );
      },
    ),
  );

  server.registerTool(
    "gsheet_append",
    {
      title: "Thêm dòng vào cuối bảng Google Sheet",
      description:
        "Thêm dòng sau dòng dữ liệu cuối cùng của bảng (Sheets tự tìm bảng trong range). Dòng mới được chèn, không ghi đè. " +
        "Nếu bảng có dòng tổng/ghi chú ở dưới, dùng gsheet_insert_rows + gsheet_update thay vì append.",
      inputSchema: {
        spreadsheet: spreadsheetArg,
        range: z.string().optional().describe("Vùng chứa bảng, ví dụ A1:H hoặc A:H. Bỏ trống = cả tab."),
        ...tabArgs,
        values: valuesArg,
        input_option: inputOptionArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safeHandler(
      async (args: {
        spreadsheet: string;
        range?: string;
        tab?: string;
        gid?: number;
        values: unknown[][];
        input_option?: string;
      }): Promise<ToolResult> => {
        assertWritable(ctx.config);
        const sheets = ctx.sheets();
        const ref = parseSpreadsheetRef(args.spreadsheet);
        const { range } = await resolveRange(sheets, ref, args);
        const res = await sheets.spreadsheets.values.append({
          spreadsheetId: ref.id,
          range,
          valueInputOption: args.input_option ?? "USER_ENTERED",
          insertDataOption: "INSERT_ROWS",
          includeValuesInResponse: true,
          requestBody: { values: args.values },
        });
        const u = res.data.updates;
        const written = (u?.updatedData?.values ?? []) as unknown[][];
        return textResult(
          `✅ Đã thêm ${u?.updatedRows ?? 0} dòng vào ${u?.updatedRange}\n\n${formatGrid(written, rangeStart(u?.updatedRange ?? range))}`,
          { updatedRange: u?.updatedRange, updatedRows: u?.updatedRows },
        );
      },
    ),
  );

  server.registerTool(
    "gsheet_duplicate_tab",
    {
      title: "Nhân bản tab Google Sheet",
      description:
        "Nhân bản một tab (giữ nguyên giá trị, công thức, định dạng) thành tab mới với tên mới. " +
        "Mặc định đặt tab mới ngay trước tab gốc.",
      inputSchema: {
        spreadsheet: spreadsheetArg,
        ...tabArgs,
        new_title: z.string().min(1).describe("Tên tab mới, ví dụ 27.11."),
        index: z.number().int().min(0).optional().describe("Vị trí tab mới (0 = đầu tiên). Mặc định: ngay trước tab gốc."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safeHandler(
      async (args: { spreadsheet: string; tab?: string; gid?: number; new_title: string; index?: number }): Promise<ToolResult> => {
        assertWritable(ctx.config);
        const sheets = ctx.sheets();
        const ref = parseSpreadsheetRef(args.spreadsheet);
        const { tabs } = await listTabs(sheets, ref.id);
        if (tabs.some((t) => t.title === args.new_title)) throw new UserError(`Đã có tab "${args.new_title}".`);
        const { tab } = await resolveRange(sheets, ref, { tab: args.tab, gid: args.gid });
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId: ref.id,
          requestBody: {
            requests: [
              {
                duplicateSheet: {
                  sourceSheetId: tab!.sheetId,
                  newSheetName: args.new_title,
                  insertSheetIndex: args.index ?? tab!.index,
                },
              },
            ],
          },
        });
        const props = res.data.replies?.[0]?.duplicateSheet?.properties;
        return textResult(
          `✅ Đã nhân bản tab "${tab!.title}" → "${props?.title}" (gid ${props?.sheetId}, vị trí ${props?.index}).`,
          { sheetId: props?.sheetId, title: props?.title, index: props?.index },
        );
      },
    ),
  );

  server.registerTool(
    "gsheet_insert_rows",
    {
      title: "Chèn dòng trống vào Google Sheet",
      description:
        "Chèn dòng trống trước một dòng (số dòng 1-based như trên giao diện), kế thừa định dạng của dòng phía trên. " +
        "Sau đó dùng gsheet_update để điền giá trị.",
      inputSchema: {
        spreadsheet: spreadsheetArg,
        ...tabArgs,
        before_row: z.number().int().min(1).describe("Chèn trước dòng này (1-based). Ví dụ 12 → dòng mới thành dòng 12."),
        count: z.number().int().min(1).max(1000).optional().default(1).describe("Số dòng chèn."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safeHandler(
      async (args: { spreadsheet: string; tab?: string; gid?: number; before_row: number; count?: number }): Promise<ToolResult> => {
        assertWritable(ctx.config);
        const sheets = ctx.sheets();
        const ref = parseSpreadsheetRef(args.spreadsheet);
        const { tab } = await resolveRange(sheets, ref, { tab: args.tab, gid: args.gid });
        const count = args.count ?? 1;
        const start = args.before_row - 1;
        const request: sheets_v4.Schema$Request = {
          insertDimension: {
            range: { sheetId: tab!.sheetId, dimension: "ROWS", startIndex: start, endIndex: start + count },
            inheritFromBefore: start > 0,
          },
        };
        await sheets.spreadsheets.batchUpdate({ spreadsheetId: ref.id, requestBody: { requests: [request] } });
        return textResult(
          `✅ Đã chèn ${count} dòng trống vào tab "${tab!.title}" tại dòng ${args.before_row}${count > 1 ? `–${args.before_row + count - 1}` : ""}.`,
        );
      },
    ),
  );
}