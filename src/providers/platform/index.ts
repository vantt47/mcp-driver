import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Provider } from "../../core/provider.js";
import { assertWritable, globalReadOnly } from "../../core/env.js";
import { safeHandler, textResult } from "../../core/result.js";
import { deliver, destinationSchema } from "../../core/sinks.js";
import { valueFrom } from "../gcp/index.js";

const MANUAL = "🖐 THỦ CÔNG";

/** Quy trình chuẩn. Bước có MANUAL không làm được qua API — chỉ cần làm 1 lần/project. */
const FLOWS: Record<string, { title: string; steps: string[] }> = {
  google_signin_web: {
    title: "Google Sign-In cho Web (Firebase Auth)",
    steps: [
      "gcp_enable_apis services=[firebase, identitytoolkit]",
      "firebase_add_to_project (nếu project chưa có Firebase)",
      "firebase_create_app platform=web → firebase_get_sdk_config app_id=… env_file=<repo>/.env env_prefix=VITE_FIREBASE_ (hoặc NEXT_PUBLIC_FIREBASE_)",
      `${MANUAL}: OAuth consent screen (Google Cloud Console → Google Auth Platform → Branding/Audience): tên app, email hỗ trợ, test users hoặc Publish.`,
      `${MANUAL}: OAuth client loại "Web application" (Console → Credentials) hoặc bật Google trong Firebase Console → Authentication để Firebase tự tạo. Thêm Authorized JavaScript origins + redirect https://<project>.firebaseapp.com/__/auth/handler.`,
      "secret_store name=GOOGLE_OAUTH_CLIENT_SECRET → destinations [gcp_secret] (giữ secret ở Secret Manager)",
      "firebase_auth_enable_google client_id=… client_secret_gcp_secret=GOOGLE_OAUTH_CLIENT_SECRET",
      "firebase_auth_authorized_domains add=[<domain staging/prod>] (VD app-myproj.dmst.vn)",
    ],
  },
  google_signin_android: {
    title: "Google Sign-In cho Android",
    steps: [
      "firebase_create_app platform=android package_name=<applicationId>",
      "Lấy SHA-1 + SHA-256: debug `cd android && ./gradlew signingReport`; release keystore `keytool -list -v -keystore …`; Play App Signing ở Play Console → App integrity.",
      "firebase_android_sha app_id=… add=[sha1, sha256] (Firebase tự tạo OAuth client Android tương ứng)",
      "Đảm bảo provider google.com đã bật (xem google_signin_web, bước OAuth Web client — Android cần web client ID làm serverClientId).",
      "firebase_get_sdk_config app_id=… write_to=<repo>/android/app/google-services.json",
      "Web client ID (client_type 3 trong google-services.json) dùng làm serverClientId/requestIdToken.",
    ],
  },
  google_signin_ios: {
    title: "Google Sign-In cho iOS",
    steps: [
      "firebase_create_app platform=ios bundle_id=<bundle> (team_id nếu có)",
      "Đảm bảo provider google.com đã bật (firebase_auth_enable_google) — sau đó Firebase sinh iOS OAuth client.",
      "firebase_get_sdk_config app_id=… write_to=<repo>/ios/Runner/GoogleService-Info.plist",
      "Thêm REVERSED_CLIENT_ID (trong plist) vào URL Types của Info.plist; GIDClientID = CLIENT_ID.",
      "Nếu plist thiếu CLIENT_ID: provider Google chưa bật lúc tải — bật rồi tải lại.",
    ],
  },
  apple_signin: {
    title: "Sign in with Apple",
    steps: [
      "apple_create_bundle_id identifier=<bundle> name=…",
      "apple_bundle_capabilities identifier=<bundle> enable=[SIGN_IN_WITH_APPLE]",
      `${MANUAL}: Với web/Android cần Services ID + Key (Sign in with Apple) ở developer.apple.com → Identifiers/Keys; khai báo return URL https://<project>.firebaseapp.com/__/auth/handler.`,
      `${MANUAL}: Bật provider apple.com trong Firebase Console → Authentication (nhập Services ID, Team ID, Key ID, private key).`,
    ],
  },
  fcm_android: {
    title: "Push FCM cho Android",
    steps: [
      "gcp_enable_apis services=[fcm]",
      "firebase_create_app platform=android package_name=… → firebase_get_sdk_config write_to=<repo>/android/app/google-services.json",
      "Trên app: lấy FCM token (FirebaseMessaging.getToken) rồi fcm_send token=… title=Test để thử.",
      "Backend gửi push: xem flow fcm_server.",
    ],
  },
  fcm_ios: {
    title: "Push FCM cho iOS",
    steps: [
      "apple_create_bundle_id → apple_bundle_capabilities enable=[PUSH_NOTIFICATIONS]",
      "firebase_create_app platform=ios bundle_id=… → firebase_get_sdk_config write_to=<repo>/ios/Runner/GoogleService-Info.plist",
      `${MANUAL}: Tạo APNs Auth Key (.p8) ở developer.apple.com → Keys (bật Apple Push Notifications service). Mỗi team tạo tối đa 2 key, dùng chung cho mọi app — tạo 1 lần rồi lưu: secret_store from_file=<AuthKey_XXX.p8> destinations=[gcp_secret].`,
      `${MANUAL}: Upload .p8 vào Firebase Console → Project settings → Cloud Messaging → Apple app configuration (Key ID + Team ID). Không có API công khai cho bước này.`,
      "Xcode: bật Push Notifications + Background Modes (Remote notifications).",
      "fcm_send token=… để thử trên máy thật.",
    ],
  },
  fcm_web: {
    title: "Push FCM cho Web",
    steps: [
      "gcp_enable_apis services=[fcm]",
      "firebase_create_app platform=web → firebase_get_sdk_config env_file=… env_prefix=…",
      `${MANUAL}: Firebase Console → Project settings → Cloud Messaging → Web Push certificates → Generate key pair; lưu public key: secret_store name=VITE_FIREBASE_VAPID_KEY destinations=[dotenv].`,
      "Thêm public/firebase-messaging-sw.js; lấy token bằng getToken(messaging, { vapidKey }) rồi fcm_send để thử.",
    ],
  },
  fcm_server: {
    title: "Backend gửi push (FCM HTTP v1)",
    steps: [
      "gcp_enable_apis services=[fcm]",
      "Chạy trên GCP/GKE: ưu tiên Workload Identity, không cần key. Chạy nơi khác (VPS, k3s):",
      "gcp_create_service_account account_id=fcm-sender roles=[firebasecloudmessaging.admin]",
      "gcp_create_service_account_key service_account=fcm-sender name=FIREBASE_SERVICE_ACCOUNT destinations=[gcp_secret, github_secret repo=…, (tuỳ chọn) file <repo>/secrets/fcm.json]",
      "Backend đọc qua GOOGLE_APPLICATION_CREDENTIALS hoặc parse JSON từ env; fcm_send để so sánh khi debug.",
    ],
  },
  google_api_backend: {
    title: "Backend gọi Google API (Drive, Sheets…) bằng service account",
    steps: [
      "gcp_enable_apis services=[drive, sheets]",
      "gcp_create_service_account account_id=<app>-backend",
      "gcp_create_service_account_key … destinations=[gcp_secret, github_secret]",
      "Chia sẻ file/folder Drive cho email service account (hoặc domain-wide delegation nếu Workspace).",
    ],
  },
};

export function platformProvider(all: () => Provider[]): Provider {
  return {
    id: "platform",
    title: "Platform (dùng chung)",
    instructions:
      "platform_status: xem credential của từng provider. platform_setup_guide: quy trình chuẩn (Google Sign-In, FCM, Apple…) — " +
      "đọc trước khi setup tính năng mới. secret_store: ghi 1 giá trị bí mật vào nhiều đích cùng lúc (.env, file, Secret Manager, GitHub). " +
      "Bước đánh dấu 🖐 THỦ CÔNG phải nhờ người dùng làm trên web console.",
    status: () => ({ configured: true, detail: "luôn bật" }),

    register(server: McpServer) {
      server.registerTool(
        "platform_status",
        {
          title: "Trạng thái các provider",
          description: "Liệt kê provider đang bật và credential của từng cái (không hiển thị giá trị bí mật).",
          inputSchema: {},
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        safeHandler(async () => {
          const rows = await Promise.all(
            all().map(async (p) => ({ id: p.id, title: p.title, ...(await p.status()) })),
          );
          const text = [
            ...rows.map((r) => `${r.configured ? "✅" : "⚠️"} ${r.id.padEnd(10)} ${r.detail}`),
            globalReadOnly() ? "\n🔒 MCP_READ_ONLY=true — mọi thao tác ghi bị chặn." : "",
          ].join("\n");
          return textResult(text.trim(), { providers: rows, readOnly: globalReadOnly() });
        }),
      );

      server.registerTool(
        "platform_setup_guide",
        {
          title: "Quy trình setup chuẩn",
          description:
            "Trả về các bước (tool nào gọi, bước nào phải làm tay) cho một tính năng. Flows: " +
            Object.keys(FLOWS).join(", "),
          inputSchema: { flow: z.enum(Object.keys(FLOWS) as [string, ...string[]]) },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        safeHandler(async ({ flow }: { flow: string }) => {
          const f = FLOWS[flow];
          return textResult(
            [`# ${f.title}`, ...f.steps.map((s, i) => `${i + 1}. ${s}`), "", `${MANUAL} = không có API, nhờ người dùng làm một lần cho mỗi project/môi trường.`].join("\n"),
            { flow, steps: f.steps },
          );
        }),
      );

      server.registerTool(
        "secret_store",
        {
          title: "Lưu một secret vào nhiều nơi",
          description:
            "Ghi một giá trị bí mật (client secret, API key, file .p8, JSON…) vào các đích: dotenv (upsert biến), file, " +
            "gcp_secret (Secret Manager), github_secret (Actions). Ưu tiên from_file để giá trị không đi qua chat. " +
            "Output chỉ báo đã ghi vào đâu, không lặp lại giá trị.",
          inputSchema: {
            name: z.string().describe("Tên logic, VD GOOGLE_OAUTH_CLIENT_SECRET — dùng làm tên mặc định ở mọi đích."),
            value: z.string().optional(),
            from_file: z.string().optional().describe("Đọc giá trị từ file (đường dẫn tuyệt đối)."),
            destinations: z.array(destinationSchema).min(1),
          },
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        },
        safeHandler(
          async (args: {
            name: string;
            value?: string;
            from_file?: string;
            destinations: z.infer<typeof destinationSchema>[];
          }) => {
            assertWritable();
            const value = valueFrom(args);
            const lines = await deliver(args.name, value, args.destinations);
            return textResult(lines.join("\n"), { results: lines });
          },
        ),
      );
    },
  };
}
