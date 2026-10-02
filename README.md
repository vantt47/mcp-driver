# mcp-gdrive — MCP server cho Google Drive

MCP server viết bằng **TypeScript / Node.js**, cho phép Claude (hoặc bất kỳ MCP client nào) làm việc trực tiếp với Google Drive của bạn qua 4 tool:

| Tool | Chức năng |
|---|---|
| `gdrive_search` | Tìm file/folder theo từ khoá full-text, tên, loại, folder cha, thời gian sửa |
| `gdrive_read` | Đọc nội dung file — tự động export Google Docs→Markdown, Sheets→CSV, Slides→text |
| `gdrive_create` | Tạo file thường, folder, hoặc Google Docs/Sheets/Slides (convert từ Markdown/CSV) |
| `gdrive_update` | Ghi đè / nối thêm nội dung, đổi tên, di chuyển folder, gắn sao, vào/ra Thùng rác |

Xác thực bằng **OAuth 2.0 Desktop flow + PKCE**, refresh token lưu trên máy, tự động làm mới access token.

---

## 1. Yêu cầu

- Node.js >= 18 (khuyến nghị 20+)
- Một Google account có Drive
- Google Cloud project (miễn phí)

---

## 2. Tạo OAuth Client trên Google Cloud

1. Vào <https://console.cloud.google.com/> → tạo project mới (hoặc chọn project có sẵn).
2. **APIs & Services → Library** → tìm **Google Drive API** → **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External** (nếu không dùng Google Workspace nội bộ).
   - Điền App name, User support email, Developer email → Save.
   - Mục **Audience / Test users**: bấm **Add users** và thêm chính email Google của bạn.
     > Nếu app còn ở trạng thái *Testing*, chỉ những email trong danh sách test user mới đăng nhập được, và refresh token hết hạn sau 7 ngày. Muốn dùng lâu dài thì bấm **Publish app** (chế độ Production) — với scope Drive nhạy cảm, Google vẫn cho bạn dùng cho chính tài khoản của mình, chỉ hiện màn hình cảnh báo "Google hasn't verified this app" → bấm **Advanced → Go to … (unsafe)**.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Desktop app**
   - Đặt tên bất kỳ → **Create**
   - Copy **Client ID** và **Client secret**.

> Vì dùng loại **Desktop app**, Google chấp nhận mọi redirect URI `http://localhost:<port>` nên **không cần** khai báo redirect URI thủ công. Nếu bạn cố ý cố định `GDRIVE_OAUTH_PORT`, hãy đảm bảo dùng đúng loại client này.

---

## 3. Cài đặt

```bash
# giải nén / clone rồi:
cd mcp-gdrive
npm install          # tự động build luôn (script "prepare")
cp .env.example .env
```

Mở `.env` và điền:

```dotenv
GOOGLE_CLIENT_ID=xxxxxxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxx
```

---

## 4. Đăng nhập Google (một lần duy nhất)

```bash
npm run auth
```

Lệnh này sẽ:

1. Mở trình duyệt tới màn hình cấp quyền của Google.
2. Nhận authorization code qua một HTTP server loopback tạm thời (`http://localhost:<port>/oauth2callback`).
3. Đổi code lấy **refresh token** và lưu vào `~/.mcp-gdrive/token.json` (quyền `0600`).
4. Gọi thử Drive API và in ra tên tài khoản + 3 file sửa gần nhất để xác nhận.

Đăng nhập lại bằng tài khoản khác:

```bash
npm run auth -- --force
```

Kiểm tra trạng thái bất cứ lúc nào:

```bash
node dist/index.js --check
```

---

## 5. Cấu hình để chạy local với Claude

### 5a. Claude Desktop

Mở file config:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

Thêm:

```json
{
  "mcpServers": {
    "gdrive": {
      "command": "node",
      "args": ["/duong/dan/tuyet/doi/toi/mcp-gdrive/dist/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "xxxxxxxxxxxx.apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET": "GOCSPX-xxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

> `args` phải là **đường dẫn tuyệt đối**. Trên Windows dùng dấu `\\`, ví dụ `"C:\\Users\\ban\\mcp-gdrive\\dist\\index.js"`.
> Nếu đã có `.env` cạnh project thì có thể bỏ hẳn khối `env`.

Khởi động lại Claude Desktop → biểu tượng công cụ sẽ hiện 4 tool `gdrive_*`.

### 5b. Claude Code (CLI)

```bash
claude mcp add gdrive -- node /duong/dan/tuyet/doi/toi/mcp-gdrive/dist/index.js
```

hoặc thêm vào `.mcp.json` trong repo của bạn:

```json
{
  "mcpServers": {
    "gdrive": {
      "command": "node",
      "args": ["/duong/dan/tuyet/doi/toi/mcp-gdrive/dist/index.js"]
    }
  }
}
```

### 5c. Test bằng MCP Inspector (không cần Claude)

```bash
npm run inspector
```

Mở URL in ra terminal → tab **Tools** → thử từng tool.

---

## 6. Biến môi trường

| Biến | Bắt buộc | Mặc định | Ý nghĩa |
|---|---|---|---|
| `GOOGLE_CLIENT_ID` | ✅ | — | OAuth client ID (Desktop app) |
| `GOOGLE_CLIENT_SECRET` | ✅ | — | OAuth client secret |
| `GDRIVE_TOKEN_PATH` | | `~/.mcp-gdrive/token.json` | Nơi lưu refresh token |
| `GDRIVE_OAUTH_PORT` | | `0` (tự chọn) | Cổng loopback cho OAuth callback |
| `GDRIVE_SCOPES` | | `.../auth/drive` | Đổi thành `.../auth/drive.readonly` nếu chỉ cần đọc |
| `GDRIVE_ROOT_FOLDER_ID` | | — | Giới hạn search/create trong một cây folder |
| `GDRIVE_READ_ONLY` | | `false` | `true` = chặn `create`/`update` ở tầng server |
| `GDRIVE_MAX_READ_BYTES` | | `1000000` | Giới hạn byte trả về mỗi lần `gdrive_read` |

Biến đặt trong config MCP (`env`) **ưu tiên cao hơn** file `.env`.

---

## 7. Tham chiếu tool

### `gdrive_search`

| Tham số | Kiểu | Mô tả |
|---|---|---|
| `query` | string | Từ khoá full-text (tìm cả trong nội dung file) |
| `name_contains` | string | Chỉ khớp theo tên |
| `mime_type` | string | Alias: `document`, `spreadsheet`, `presentation`, `folder`, `pdf`, `image`, `video`, `csv`, `txt`, `markdown` — hoặc MIME đầy đủ |
| `folder_id` | string | Chỉ tìm trong folder này (nhận cả URL) |
| `modified_after` | string | RFC3339, vd `2026-01-01T00:00:00Z` |
| `include_trashed` | boolean | Mặc định `false` |
| `order_by` | enum | Mặc định `modifiedTime desc` |
| `page_size` / `page_token` | number / string | Phân trang |
| `raw_query` | string | Query thô theo cú pháp Drive API v3, ghi đè mọi bộ lọc trên |

Ví dụ: *"tìm các Google Doc có chữ 'báo cáo quý 3' sửa sau 01/07/2026"*

### `gdrive_read`

| Tham số | Kiểu | Mô tả |
|---|---|---|
| `file_id` | string ✅ | File ID **hoặc** URL (`https://docs.google.com/document/d/<id>/edit`) |
| `export_mime_type` | string | Với Google Docs: `text/markdown`, `text/plain`, `text/html`, `text/csv`, `application/pdf`… |
| `max_bytes` | number | Giới hạn nội dung trả về |
| `as_base64` | boolean | Trả nội dung nhị phân dạng base64 |

Hành vi:

- **Folder** → liệt kê tối đa 100 mục con.
- **Shortcut** → tự đi tới file đích.
- **Google Docs/Sheets/Slides** → export sang text (Docs→Markdown, có fallback `text/plain`).
- **Ảnh** ≤ 5 MB → trả về dạng image block để model xem được.

### `gdrive_create`

| Tham số | Kiểu | Mô tả |
|---|---|---|
| `name` | string ✅ | Tên file/folder |
| `doc_type` | enum | `file` (mặc định), `document`, `spreadsheet`, `presentation`, `folder` |
| `content` | string | Markdown (→ Docs), CSV (→ Sheets), hoặc text thường |
| `mime_type` | string | Khi `doc_type=file`, vd `text/markdown` |
| `parent_folder_id` | string | Mặc định `GDRIVE_ROOT_FOLDER_ID` hoặc My Drive |
| `content_base64` | string | Upload nhị phân (ảnh, PDF…) |
| `description` | string | Mô tả |

### `gdrive_update`

| Tham số | Kiểu | Mô tả |
|---|---|---|
| `file_id` | string ✅ | ID hoặc URL |
| `content` | string | Nội dung mới |
| `mode` | enum | `replace` (mặc định), `append`, `prepend` |
| `content_mime_type` | string | MIME của nội dung gửi lên |
| `content_base64` | string | Ghi đè nhị phân (chỉ với `replace`) |
| `new_name` | string | Đổi tên |
| `description` | string | Đổi mô tả |
| `move_to_folder_id` | string | Chuyển sang folder khác |
| `add_parent_id` / `remove_parent_id` | string | Thêm/gỡ folder cha |
| `trashed` | boolean | `true` = vào Thùng rác, `false` = khôi phục |
| `starred` | boolean | Gắn/bỏ sao |

> `append`/`prepend` sẽ tải nội dung hiện tại về, ghép chuỗi, rồi upload lại toàn bộ.

---

## 8. Cấu trúc mã nguồn

```
mcp-gdrive/
├── package.json
├── tsconfig.json
├── .env.example
├── README.md
└── src/
    ├── index.ts            # Điểm vào: khởi tạo McpServer + StdioServerTransport
    ├── config.ts           # Nạp .env thủ công, gom toàn bộ cấu hình
    ├── auth.ts             # OAuth Desktop + PKCE, loopback server, đọc/ghi token, auto-refresh
    ├── drive.ts            # Drive client, MIME map, normalize URL→ID, format lỗi
    ├── scripts/
    │   └── authorize.ts    # `npm run auth`
    └── tools/
        ├── common.ts       # Kiểu ToolResult, safeHandler, download/export helper
        ├── search.ts       # gdrive_search
        ├── read.ts         # gdrive_read
        ├── create.ts       # gdrive_create
        └── update.ts       # gdrive_update
```

**Nguyên tắc quan trọng:** MCP dùng **stdout** cho JSON-RPC, nên mọi log của server đều ghi ra **stderr** (hàm `log()` trong `auth.ts`). Đừng bao giờ `console.log()` trong luồng server.

---

## 9. Xử lý sự cố

| Triệu chứng | Nguyên nhân & cách xử lý |
|---|---|
| `Chưa đăng nhập Google Drive` | Chạy `npm run auth` |
| `401 Token hết hiệu lực` | Refresh token bị thu hồi hoặc app còn ở chế độ Testing (hết hạn sau 7 ngày) → `npm run auth -- --force`, hoặc Publish app |
| `403 insufficientPermissions` | Scope trong `.env` quá hẹp → đặt lại `GDRIVE_SCOPES` rồi `npm run auth -- --force` |
| `404 File not found` | File không thuộc/chưa được share với tài khoản đang đăng nhập; hoặc scope là `drive.file` (chỉ thấy file do app tạo) |
| Google không trả `refresh_token` | Vào <https://myaccount.google.com/permissions>, gỡ quyền của app rồi chạy lại `npm run auth` |
| Claude Desktop không thấy server | Kiểm tra đường dẫn tuyệt đối trong config, đã `npm run build` chưa, và xem log: macOS `~/Library/Logs/Claude/mcp*.log` |
| `Error: Cannot find module` | Chạy `npm install && npm run build` |
| Tạo Google Doc từ Markdown bị lỗi | Server tự lùi về `text/plain` — nội dung vẫn vào Doc nhưng mất định dạng |

---

## 10. Bảo mật

- `token.json` chứa refresh token = quyền truy cập Drive của bạn. File được ghi với quyền `0600` và **đã nằm trong `.gitignore`** — đừng commit.
- `.env` chứa client secret — cũng đã được gitignore.
- Muốn an toàn hơn: đặt `GDRIVE_SCOPES=https://www.googleapis.com/auth/drive.readonly`, hoặc `GDRIVE_READ_ONLY=true`, hoặc giới hạn `GDRIVE_ROOT_FOLDER_ID` vào đúng một folder.
- Thu hồi quyền bất cứ lúc nào tại <https://myaccount.google.com/permissions>.

---

MIT License.
