// API nội bộ cho trang admin.html tĩnh: liệt kê Lead + gửi lại email quà tặng.
// Bảo vệ bằng ADMIN_PANEL_SECRET (Bearer token) — KHÔNG dùng anon key, chỉ service_role.

import { getServiceClient, claimEmailLog, markEmailLogResult, formatVN } from "../_shared/db.ts";
import { sendEmail } from "../_shared/smtp.ts";
import { u1GiftEmail } from "../_shared/templates.ts";

const STATUS_LABELS: Record<string, string> = {
  new_lead: "Vừa đăng ký",
  lead_gift_sent: "Đã nhận quà — Chưa thanh toán",
  lead_unpaid: "Đã nhận quà — Chưa thanh toán",
  gift_email_failed: "Lỗi gửi email quà tặng",
  payment_started: "Đang xem thông tin thanh toán",
  payment_submitted: "Đã gửi biên lai — Chờ đối soát",
  payment_confirmed: "Đã xác nhận thanh toán",
  payment_rejected: "Giao dịch bị từ chối",
  cancelled: "Đã huỷ",
  refunded: "Đã hoàn tiền",
  attended: "Đã tham dự",
  no_show: "Vắng mặt",
};

function cors(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return cors({});

  const adminSecret = Deno.env.get("ADMIN_PANEL_SECRET");
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!adminSecret || token !== adminSecret) {
    return cors({ ok: false, error: "unauthorized" }, 401);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return cors({ ok: false, error: "invalid_json" }, 400);
  }

  const sb = getServiceClient();
  const action = body.action;

  if (action === "list_leads") {
    const { data, error } = await sb
      .from("registrations")
      .select(
        "registration_id, registration_code, full_name, phone, email, referral_source, utm_source, payment_status, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(150);

    if (error) return cors({ ok: false, error: error.message }, 500);

    const leads = (data ?? []).map((r) => ({
      registration_id: r.registration_id,
      registration_code: r.registration_code,
      full_name: r.full_name,
      phone: r.phone,
      email: r.email,
      source: r.referral_source || r.utm_source || "(không có)",
      status: r.payment_status,
      status_label: STATUS_LABELS[r.payment_status] ?? r.payment_status,
      created_at_vn: formatVN(r.created_at),
      can_resend: r.payment_status === "gift_email_failed",
    }));

    return cors({ ok: true, leads });
  }

  if (action === "resend_gift_email") {
    const registrationId = body.registration_id as string;
    if (!registrationId) return cors({ ok: false, error: "registration_id_required" }, 400);

    const { data: rpcData, error: rpcError } = await sb.rpc("admin_resend_gift_email", {
      p_registration_id: registrationId,
    });
    if (rpcError || !rpcData || !rpcData.length) {
      return cors({ ok: false, error: rpcError?.message || "registration_not_found" }, 404);
    }
    const row = rpcData[0];
    if (!row.email) {
      return cors({ ok: false, error: "lead_has_no_email" }, 400);
    }

    const appUrl = Deno.env.get("APP_URL") ?? "";
    const { data: fullRow } = await sb
      .from("registrations")
      .select("full_name, payment_token, lead_magnet_title, email_opt_in")
      .eq("registration_id", registrationId)
      .single();
    const paymentToken = fullRow?.payment_token;
    const fullName = fullRow?.full_name || "bạn";
    const giftTitle = fullRow?.lead_magnet_title || Deno.env.get("LEAD_MAGNET_TITLE") || "Bài Test Bắt Mạch Tài Chính Gia Đình";
    const giftUrl = Deno.env.get("LEAD_MAGNET_URL") || "https://example.com/PLACEHOLDER-thay-link-qua-tang-that";
    const paymentUrl = `${appUrl}/?registration=${encodeURIComponent(row.registration_code)}&token=${encodeURIComponent(paymentToken)}`;
    const unsubscribeUrl = `${appUrl}/unsubscribe.html?code=${encodeURIComponent(row.registration_code)}&token=${encodeURIComponent(paymentToken)}`;

    const logId = await claimEmailLog(sb, registrationId, "U1_gift", row.email);
    if (!logId) {
      return cors({ ok: false, error: "already_sending_or_sent" }, 409);
    }

    try {
      const tpl = u1GiftEmail({
        fullName: fullName,
        registrationCode: row.registration_code,
        paymentUrl,
        giftTitle,
        giftUrl,
        unsubscribeUrl,
      });
      const sent = await sendEmail({ to: row.email, subject: tpl.subject, html: tpl.html, replyTo: Deno.env.get("EMAIL_REPLY_TO") });
      await markEmailLogResult(sb, logId, true, sent.id);
      await sb
        .from("registrations")
        .update({ payment_status: "lead_gift_sent", lead_magnet_sent_at: new Date().toISOString() })
        .eq("registration_id", registrationId)
        .eq("payment_status", "gift_email_failed");
      return cors({ ok: true, status: "sent" });
    } catch (e) {
      await markEmailLogResult(sb, logId, false, undefined, String(e));
      return cors({ ok: false, error: String(e) }, 500);
    }
  }

  return cors({ ok: false, error: "unknown_action" }, 400);
});
