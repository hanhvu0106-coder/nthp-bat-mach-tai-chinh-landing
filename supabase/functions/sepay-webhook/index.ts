// ============================================================
// NTHP · sepay-webhook
// Nhận webhook giao dịch ngân hàng từ SePay, tự động xác nhận vé
// (qua process_bank_transaction trong Postgres) rồi gửi email cho
// khách + báo cho admin qua Gmail SMTP.
//
// Deploy: supabase functions deploy sepay-webhook
// Secrets cần set trước khi deploy (supabase secrets set ...):
//   SEPAY_WEBHOOK_TOKEN   - chuỗi bí mật tự đặt, dán y hệt vào cấu hình
//                           webhook trên dashboard SePay (header Authorization)
//   GMAIL_USER            - địa chỉ Gmail dùng để gửi (đang dùng sẵn cho email khác)
//   GMAIL_APP_PASSWORD    - mật khẩu ứng dụng Gmail (KHÔNG phải mật khẩu đăng nhập)
//   ADMIN_NOTIFY_EMAIL    - email nhận thông báo mỗi khi có giao dịch (mặc định
//                           dùng luôn GMAIL_USER nếu không set)
// SUPABASE_URL và SUPABASE_SERVICE_ROLE_KEY được Supabase tự inject sẵn cho
// Edge Function, không cần set thủ công.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SEPAY_WEBHOOK_TOKEN = Deno.env.get("SEPAY_WEBHOOK_TOKEN")!;
const GMAIL_USER = Deno.env.get("GMAIL_USER")!;
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD")!;
const ADMIN_NOTIFY_EMAIL = Deno.env.get("ADMIN_NOTIFY_EMAIL") || GMAIL_USER;

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function vnd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat("vi-VN").format(n) + "đ";
}

async function sendMail(to: string, subject: string, html: string) {
  const client = new SMTPClient({
    connection: {
      hostname: "smtp.gmail.com",
      port: 465,
      tls: true,
      auth: { username: GMAIL_USER, password: GMAIL_APP_PASSWORD },
    },
  });
  try {
    await client.send({
      from: `Nấc Thang Hạnh Phúc <${GMAIL_USER}>`,
      to,
      subject,
      html,
    });
  } finally {
    await client.close();
  }
}

async function notifyConfirmed(row: {
  registration_code: string;
  full_name: string;
  email: string | null;
  phone: string;
  matched_amount: number;
}) {
  const jobs: Promise<unknown>[] = [];

  if (row.email) {
    jobs.push(
      sendMail(
        row.email,
        `Vé Workshop của bạn đã được xác nhận — ${row.registration_code}`,
        `<p>Xin chào ${row.full_name},</p>
         <p>Nấc Thang Hạnh Phúc xác nhận đã nhận được <b>${vnd(row.matched_amount)}</b> cho mã đăng ký <b>${row.registration_code}</b>.</p>
         <p>Vé của bạn đã được giữ chính thức cho Workshop "Bắt Mạch Tài Chính Gia Đình". Thông tin lớp học sẽ được gửi qua Zalo trong ít phút tới.</p>
         <p>Hẹn gặp bạn tại Workshop!</p>
         <p>— Nấc Thang Hạnh Phúc</p>`
      )
    );
  }

  jobs.push(
    sendMail(
      ADMIN_NOTIFY_EMAIL,
      `💰 Có chuyển khoản mới — ${row.registration_code} (${vnd(row.matched_amount)})`,
      `<p>Đã <b>tự động xác nhận</b> qua SePay webhook:</p>
       <ul>
         <li>Mã đăng ký: <b>${row.registration_code}</b></li>
         <li>Khách hàng: ${row.full_name} — ${row.phone}</li>
         <li>Số tiền: ${vnd(row.matched_amount)}</li>
       </ul>
       <p>Không cần thao tác gì thêm — hệ thống đã cập nhật trạng thái vé.</p>`
    )
  );

  await Promise.allSettled(jobs);
}

async function notifyNeedsReview(reason: string, payload: Record<string, unknown>) {
  const label = reason === "unmatched_no_code"
    ? "Không tìm thấy mã đăng ký khớp trong nội dung chuyển khoản"
    : "Số tiền chuyển không khớp giá vé (hoặc vé đã được xác nhận trước đó)";

  await sendMail(
    ADMIN_NOTIFY_EMAIL,
    `⚠️ Cần kiểm tra thủ công — giao dịch chuyển khoản`,
    `<p><b>${label}</b> — hệ thống chưa tự xác nhận được vé, vui lòng kiểm tra tay trong Supabase (bảng bank_transactions) hoặc sao kê Techcombank.</p>
     <pre style="background:#f4f4f4;padding:12px;border-radius:8px;font-size:12.5px;white-space:pre-wrap;">${JSON.stringify(payload, null, 2)}</pre>`
  );
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // --- Xác thực webhook ---
  // MVP: so sánh trực tiếp header Authorization với token bí mật đã cấu hình
  // trên dashboard SePay (Authorization: Apikey <SEPAY_WEBHOOK_TOKEN>).
  // Nâng cấp sau: chuyển sang xác thực HMAC-SHA256 (X-SePay-Signature +
  // X-SePay-Timestamp) để chống giả mạo IP/replay — xem docs SePay.
  const authHeader = req.headers.get("Authorization") || "";
  if (authHeader !== `Apikey ${SEPAY_WEBHOOK_TOKEN}`) {
    return new Response(JSON.stringify({ success: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ success: false, error: "invalid_json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // SePay gửi transactionDate dạng "2024-07-02 11:08:33" KHÔNG kèm múi giờ,
  // nhưng đó là giờ Việt Nam (UTC+7). Nếu để Postgres tự parse chuỗi này nó
  // sẽ mặc định hiểu là UTC -> lệch 7 tiếng. Gắn rõ +07:00 trước khi gửi.
  const rawDate = body.transactionDate as string | undefined;
  const transactionDateVN = rawDate ? rawDate.replace(" ", "T") + "+07:00" : null;

  const { data, error } = await sb.rpc("process_bank_transaction", {
    p_id: body.id,
    p_gateway: body.gateway ?? null,
    p_transaction_date: transactionDateVN,
    p_account_number: body.accountNumber ?? null,
    p_content: body.content ?? null,
    p_transfer_type: body.transferType ?? null,
    p_transfer_amount: body.transferAmount ?? null,
    p_reference_code: body.referenceCode ?? null,
    p_raw_payload: body,
  });

  if (error) {
    console.error("process_bank_transaction failed:", error);
    // Trả 500 để SePay tự động thử lại (lỗi hệ thống, không phải lỗi dữ liệu)
    return new Response(JSON.stringify({ success: false, error: "processing_failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const row = data?.[0];

  try {
    if (row?.outcome === "confirmed") {
      await notifyConfirmed(row);
    } else if (row?.outcome === "unmatched_no_code" || row?.outcome === "unmatched_amount") {
      await notifyNeedsReview(row.outcome, body);
    }
    // 'duplicate' và 'ignored_outflow': không cần gửi email gì.
  } catch (mailErr) {
    // Không để lỗi gửi mail làm webhook fail -> SePay sẽ không cần retry vì
    // giao dịch đã được xử lý/log đúng trong DB, chỉ có email là lỗi phụ.
    console.error("email send failed:", mailErr);
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
