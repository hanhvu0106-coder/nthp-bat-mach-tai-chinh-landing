// Kích hoạt bởi Supabase Database Webhook: INSERT trên bảng public.registrations.
// Gửi email U1 (quà tặng + link giữ vé) cho khách, và email "Lead mới" cho chủ hệ thống.
// Idempotent qua email_logs (unique registration_id+email_code) — gọi lại nhiều lần vẫn an toàn.

import { getServiceClient, claimEmailLog, markEmailLogResult, formatVN } from "../_shared/db.ts";
import { sendEmail, parseEmailList } from "../_shared/smtp.ts";
import { u1GiftEmail, ownerNewLeadEmail } from "../_shared/templates.ts";

const STATUS_LABELS: Record<string, string> = {
  new_lead: "Vừa đăng ký",
  lead_gift_sent: "Đã nhận quà — Chưa thanh toán",
  lead_unpaid: "Đã nhận quà — Chưa thanh toán",
  payment_started: "Đang xem thông tin thanh toán",
  payment_submitted: "Đã gửi biên lai — Chờ đối soát",
  payment_confirmed: "Đã xác nhận thanh toán",
};

Deno.serve(async (req) => {
  try {
    const secret = Deno.env.get("DB_WEBHOOK_SECRET");
    if (secret && req.headers.get("x-webhook-secret") !== secret) {
      return new Response("unauthorized", { status: 401 });
    }

    const payload = await req.json();
    const record = payload?.record;
    if (!record || payload?.type !== "INSERT") {
      return new Response("ignored: not an insert payload", { status: 200 });
    }

    const sb = getServiceClient();
    const appUrl = Deno.env.get("APP_URL") ?? "";
    const giftTitle = record.lead_magnet_title || Deno.env.get("LEAD_MAGNET_TITLE") || "Ebook Bắt Mạch Tài Chính Gia Đình";
    const giftUrl = Deno.env.get("LEAD_MAGNET_URL") || "https://example.com/PLACEHOLDER-thay-link-qua-tang-that";
    const paymentUrl = `${appUrl}/?registration=${encodeURIComponent(record.registration_code)}&token=${encodeURIComponent(record.payment_token)}`;
    const unsubscribeUrl = `${appUrl}/unsubscribe.html?code=${encodeURIComponent(record.registration_code)}&token=${encodeURIComponent(record.payment_token)}`;

    const results: Record<string, string> = {};

    // 1) Email quà tặng cho khách (chỉ nếu có email và bật cờ + khách còn opt-in)
    const instantLeadEmailEnabled = (Deno.env.get("ENABLE_INSTANT_LEAD_EMAIL") ?? "true") === "true";
    if (instantLeadEmailEnabled && record.email && record.email_opt_in !== false) {
      const logId = await claimEmailLog(sb, record.registration_id, "U1_gift", record.email);
      if (logId) {
        try {
          const tpl = u1GiftEmail({
            fullName: record.full_name,
            registrationCode: record.registration_code,
            paymentUrl,
            giftTitle,
            giftUrl,
            unsubscribeUrl,
          });
          const sent = await sendEmail({ to: record.email, subject: tpl.subject, html: tpl.html, replyTo: Deno.env.get("EMAIL_REPLY_TO") });
          await markEmailLogResult(sb, logId, true, sent.id);
          results.u1_gift = "sent";
        } catch (e) {
          await markEmailLogResult(sb, logId, false, undefined, String(e));
          results.u1_gift = "failed";
        }
      } else {
        results.u1_gift = "already_claimed";
      }
    } else {
      results.u1_gift = "skipped_no_email_or_disabled";
    }

    // 2) Email thông báo Lead mới cho chủ hệ thống
    const ownerEmailsEnabled = (Deno.env.get("ENABLE_INSTANT_LEAD_EMAIL") ?? "true") === "true";
    const ownerRecipients = parseEmailList(Deno.env.get("LEAD_NOTIFICATION_EMAILS") ?? Deno.env.get("ADMIN_NOTIFICATION_EMAILS") ?? Deno.env.get("OWNER_EMAIL"));
    if (ownerEmailsEnabled && ownerRecipients.length > 0) {
      const logId = await claimEmailLog(sb, record.registration_id, "owner_new_lead", ownerRecipients.join(","));
      if (logId) {
        try {
          const tpl = ownerNewLeadEmail({
            fullName: record.full_name,
            phone: record.phone,
            zalo: record.zalo,
            email: record.email,
            city: record.city,
            occupation: record.occupation,
            referralSource: record.referral_source,
            utmSource: record.utm_source,
            utmMedium: record.utm_medium,
            utmCampaign: record.utm_campaign,
            refCode: record.ref_code,
            registrationCode: record.registration_code,
            giftTitle,
            statusLabel: STATUS_LABELS[record.payment_status] ?? record.payment_status,
            createdAtVN: formatVN(record.created_at),
            adminUrl: `https://supabase.com/dashboard/project/${Deno.env.get("NTHP_PROJECT_REF") ?? ""}/editor`,
          });
          const sent = await sendEmail({ to: ownerRecipients, subject: tpl.subject, html: tpl.html });
          await markEmailLogResult(sb, logId, true, sent.id);
          results.owner_new_lead = "sent";
        } catch (e) {
          await markEmailLogResult(sb, logId, false, undefined, String(e));
          results.owner_new_lead = "failed";
        }
      } else {
        results.owner_new_lead = "already_claimed";
      }
    } else {
      results.owner_new_lead = "skipped_no_recipients_or_disabled";
    }

    // 3) Nếu email quà đã gửi thành công, đẩy trạng thái new_lead -> lead_gift_sent
    if (results.u1_gift === "sent" || results.u1_gift === "skipped_no_email_or_disabled") {
      await sb
        .from("registrations")
        .update({ payment_status: "lead_gift_sent", lead_magnet_sent_at: new Date().toISOString() })
        .eq("registration_id", record.registration_id)
        .eq("payment_status", "new_lead");
    }

    return new Response(JSON.stringify({ ok: true, results }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("on-registration-created error:", e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
