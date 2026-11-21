# mcp-platform — MCP server setup key/config đa nền tảng

MCP server (TypeScript / Node.js) để Claude tự setup key và config khi làm các tính năng như **Google Sign-In, push FCM, Sign in with Apple, DNS, CI secrets**. Không còn phải mở từng console để copy key bằng tay.

| Provider | Tool | Làm được gì |
|---|---|---|
| `platform` (luôn bật) | `platform_status`, `platform_setup_guide`, `secret_store` | Xem credential, đọc quy trình chuẩn, ghi 1 secret vào nhiều nơi |
| `gcp` | `gcp_list_projects`, `gcp_enable_apis`, `gcp_list_enabled_apis`, `gcp_create_service_account`, `gcp_create_service_account_key`, `gcp_secret_list`, `gcp_secret_copy` | Bật API, service account + role, key JSON, Secret Manager |
| `firebase` | `firebase_list_projects`, `firebase_add_to_project`, `firebase_list_apps`, `firebase_create_app`, `firebase_get_sdk_config`, `firebase_android_sha`, `firebase_auth_get_config`, `firebase_auth_enable_google`, `firebase_auth_authorized_domains`, `fcm_send` | Đăng ký app, tải `google-services.json` / `GoogleService-Info.plist` / config web, SHA Android, bật Google Sign-In, gửi push thử |
| `cloudflare` | `cf_list_zones`, `cf_list_dns`, `cf_upsert_dns`, `cf_delete_dns`, `cf_list_tunnels` | DNS và Tunnel (mặc định không ghi đè record đã có) |
| `github` | `github_list_secrets`, `github_set_secret`, `github_set_variable` | Secret và variable của GitHub Actions (repo hoặc environment) |
| `apple` | `apple_list_bundle_ids`, `apple_create_bundle_id`, `apple_bundle_capabilities` | App ID, bật Push Notifications, Sign in with Apple… |
| `gdrive` | `gdrive_search`, `gdrive_read`, `gdrive_create`, `gdrive_update` | Google Drive (giữ nguyên như bản cũ) |

### Nguyên tắc an toàn

- **Secret không đi qua chat.** Key service account, client secret, file `.p8`… được ghi thẳng vào *destinations*: `dotenv` (upsert biến), `file`, `gcp_secret` (Secret Manager), `github_secret`. Output chỉ báo đã ghi vào đâu.
- Ghi file trong git repo mà file đó chưa được `.gitignore` thì tool sẽ cảnh báo.
- `cf_upsert_dns` không ghi đè record có sẵn nếu không có `overwrite=true`. Ghi file cũng cần `overwrite=true`.
- `MCP_READ_ONLY=true` chặn mọi thao tác ghi. `MCP_PROVIDERS` chỉ bật những provider cần.

### Phần vẫn phải làm tay (không có API công khai)

Mỗi project hoặc môi trường chỉ cần làm một lần. `platform_setup_guide` đánh dấu các bước này bằng 🖐:

- OAuth consent screen và OAuth client loại **Web** cho Google Sign-In. Mẹo: bật Google trong Firebase Console → Authentication để Firebase tự tạo Web client. Client Android và iOS được Firebase tự tạo sau khi đăng ký app và thêm SHA.
- APNs Auth Key (`.p8`) và việc upload nó lên Firebase Cloud Messaging.
- Web Push certificate (VAPID key) của FCM web.
- Services ID và key cho Sign in with Apple trên web/Android.

---

## 1. Cài đặt

```bash
npm install          # tự build (script "prepare")
cp .env.example .env # điền những provider cần dùng
npm run check        # xem provider nào đã có credential
```

Yêu cầu Node.js 18 trở lên.

## 2. Credential cho từng provider

| Provider | Cần gì |
|---|---|
| gcp, firebase | ADC: `gcloud auth application-default login` (tick đủ mọi quyền ở trang consent). Hoặc `GOOGLE_APPLICATION_CREDENTIALS=<service-account.json>`. Mỗi lệnh gọi tự tính hạn mức (`x-goog-user-project`) vào chính project đang thao tác, nên **không cần** quota project chung. Tuỳ chọn: `GCP_PROJECT_ID` (project mặc định), `GCP_QUOTA_PROJECT` (ép một quota project cố định). Tài khoản cần quyền Owner/Editor, hoặc tối thiểu Firebase Admin + Service Account Admin + Secret Manager Admin + Service Usage Admin. |
| cloudflare | `CLOUDFLARE_API_TOKEN` (DNS edit; thêm quyền Tunnel read nếu dùng `cf_list_tunnels`), tuỳ chọn `CLOUDFLARE_ACCOUNT_ID` |
| github | `GITHUB_TOKEN` (fine-grained: *Secrets* + *Variables* read/write) hoặc `GITHUB_CLASSIC_TOKEN` |
| apple | `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY_PATH` (file `.p8` của App Store Connect API key, role Admin hoặc App Manager) |
| gdrive | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (OAuth Desktop app), sau đó chạy `npm run auth` (xem mục 6) |

Trên Windows, nếu process MCP không thấy một biến (ví dụ VS Code mở trước khi bạn `setx`), server tự đọc biến đó từ biến môi trường **User** (`HKCU\Environment`).

## 3. Thêm vào Claude

**Claude Code** (cấp user, dùng cho mọi dự án):

```bash
claude mcp add platform -s user -- node D:/DMST/mcp-driver/dist/index.js
```

**Claude Desktop** (`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "platform": {
      "command": "node",
      "args": ["D:\\DMST\\mcp-driver\\dist\\index.js"],
      "env": { "MCP_PROVIDERS": "gcp,firebase,cloudflare,github,apple,gdrive" }
    }
  }
}
```

Test không cần Claude: `npm run inspector`.

## 4. Ví dụ sử dụng

> "Setup push FCM cho app Flutter `vn.dmst.shop` trên project `shop-stg`: Android + iOS, backend NestJS ở repo `vantt47/shop-api`."

Claude sẽ: gọi `platform_setup_guide flow=fcm_android` và `fcm_ios`, rồi `gcp_enable_apis [fcm]`, `firebase_create_app` (android, ios), `firebase_get_sdk_config write_to=…/google-services.json` và `…/GoogleService-Info.plist`, `apple_bundle_capabilities enable=[PUSH_NOTIFICATIONS]`, `gcp_create_service_account fcm-sender roles=[firebasecloudmessaging.admin]`, `gcp_create_service_account_key destinations=[gcp_secret, github_secret repo=vantt47/shop-api]`. Cuối cùng Claude nhắc bạn bước 🖐 upload APNs key.

Ví dụ `destinations`:

```json
[
  { "type": "dotenv", "path": "D:/proj/api/.env", "key": "FIREBASE_SERVICE_ACCOUNT" },
  { "type": "file", "path": "D:/proj/api/secrets/fcm.json", "overwrite": true },
  { "type": "gcp_secret", "project_id": "shop-stg" },
  { "type": "github_secret", "repo": "vantt47/shop-api", "environment": "staging" }
]
```

Các flow có trong `platform_setup_guide`: `google_signin_web`, `google_signin_android`, `google_signin_ios`, `apple_signin`, `fcm_android`, `fcm_ios`, `fcm_web`, `fcm_server`, `google_api_backend`.

## 5. Cấu trúc mã nguồn

```
src/
├── index.ts                 # Khởi tạo McpServer, chọn provider theo MCP_PROVIDERS, --check/--auth
├── core/
│   ├── env.ts               # Nạp .env, readEnv (fallback registry Windows), MCP_READ_ONLY
│   ├── result.ts            # ToolResult, safeHandler, explainError, waitOperation, log (stderr)
│   ├── http.ts              # fetchJson cho REST API (Cloudflare, GitHub, Apple)
│   ├── sinks.ts             # destinations: dotenv / file / gcp_secret / github_secret
│   └── provider.ts          # Interface Provider
└── providers/
    ├── platform/            # platform_status, platform_setup_guide, secret_store
    ├── gcp/                 # ADC client, Secret Manager, tool gcp_*
    ├── firebase/            # firebase_*, fcm_send
    ├── cloudflare/          # cf_*
    ├── github/              # client (mã hoá sealed box bằng libsodium), github_*
    ├── apple/               # JWT ES256 + App Store Connect, apple_*
    └── gdrive/              # Code Drive cũ: auth OAuth PKCE, tools/, authorize.ts
```

Thêm provider mới: tạo `src/providers/<id>/index.ts` export một `Provider` (`id`, `title`, `instructions`, `status()`, `register(server)`), rồi thêm vào mảng `ALL` trong `src/index.ts`.

MCP dùng **stdout** cho JSON-RPC, nên mọi log phải ghi ra **stderr** (dùng `log()` trong `core/result.ts`). Không dùng `console.log()` trong luồng server.

## 6. Provider Google Drive

### Tạo OAuth Client (Desktop app)

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


### Đăng nhập (một lần)

```bash
npm run auth             # mở trình duyệt, lưu refresh token vào ~/.mcp-gdrive/token.json
npm run auth -- --force  # đăng nhập lại bằng tài khoản khác
```

### Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | OAuth client (Desktop app). Có thể dùng tên `GDRIVE_CLIENT_ID` / `GDRIVE_CLIENT_SECRET` |
| `GDRIVE_TOKEN_PATH` | `~/.mcp-gdrive/token.json` | Nơi lưu refresh token |
| `GDRIVE_OAUTH_PORT` | `0` (tự chọn) | Cổng loopback cho OAuth callback |
| `GDRIVE_SCOPES` | `.../auth/drive` | `.../auth/drive.readonly` nếu chỉ cần đọc |
| `GDRIVE_ROOT_FOLDER_ID` | — | Giới hạn search/create trong một cây folder |
| `GDRIVE_READ_ONLY` | `false` | Chặn `create`/`update` của Drive |
| `GDRIVE_MAX_READ_BYTES` | `1000000` | Giới hạn byte mỗi lần `gdrive_read` |

### Tham chiếu tool

#### `gdrive_search`

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

#### `gdrive_read`

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

#### `gdrive_create`

| Tham số | Kiểu | Mô tả |
|---|---|---|
| `name` | string ✅ | Tên file/folder |
| `doc_type` | enum | `file` (mặc định), `document`, `spreadsheet`, `presentation`, `folder` |
| `content` | string | Markdown (→ Docs), CSV (→ Sheets), hoặc text thường |
| `mime_type` | string | Khi `doc_type=file`, vd `text/markdown` |
| `parent_folder_id` | string | Mặc định `GDRIVE_ROOT_FOLDER_ID` hoặc My Drive |
| `content_base64` | string | Upload nhị phân (ảnh, PDF…) |
| `description` | string | Mô tả |

#### `gdrive_update`

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

---

## 7. Xử lý sự cố

| Triệu chứng | Nguyên nhân và cách xử lý |
|---|---|
| `API has not been used in project X` với gcp/firebase | API chưa bật trên project X: `gcp_enable_apis project_id=X`. Secret Manager cần project có billing |
| `gcloud … scope is required but not consented` | Ở trang đăng nhập Google chưa tick ô *Google Cloud data*: chạy lại và bấm *Select all* |
| `iam.disableServiceAccountKeyCreation` | Tổ chức cấm tạo key. Dùng Workload Identity / ADC, hoặc nhờ admin tắt policy cho project |
| `firebase_auth_*` báo 404 / `CONFIGURATION_NOT_FOUND` | Project chưa khởi tạo Authentication. Mở Firebase Console → Authentication → Get started một lần |
| `plist` iOS thiếu `CLIENT_ID` | Bật Google Sign-In trước, rồi tải lại config |
| Cloudflare `Authentication error` | Token thiếu quyền cho zone/tính năng đó (VD Tunnel trên zone của account khác) |
| GitHub 404 khi đặt secret | Token không có quyền repo, hoặc environment chưa tồn tại |
| Apple 401 `NOT_AUTHORIZED` | Sai `ASC_KEY_ID`/`ASC_ISSUER_ID`/file `.p8`, hoặc đồng hồ máy lệch |
| Drive `Chưa đăng nhập` / `401` | `npm run auth` (hoặc `-- --force`). App ở chế độ Testing thì refresh token hết hạn sau 7 ngày |
| Claude không thấy tool | Đường dẫn trong config phải tuyệt đối, đã `npm run build` chưa, `MCP_PROVIDERS` có loại provider đó không |

## 8. Bảo mật

- `.env`, `token.json`, `credentials.json` đã nằm trong `.gitignore`. File do tool ghi ra được tạo với quyền `0600`.
- Ưu tiên `from_file` trong `secret_store` / `github_set_secret` để giá trị bí mật không đi qua hội thoại.
- Token GitHub/Cloudflare nên có phạm vi hẹp nhất có thể. Có thể đặt `MCP_READ_ONLY=true` khi chỉ cần tra cứu.

---

MIT License.
