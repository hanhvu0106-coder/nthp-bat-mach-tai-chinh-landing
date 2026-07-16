// Kích hoạt bởi Supabase Database Webhook: UPDATE trên bảng public.registrations.
// Chỉ xử lý khi payment_status THỰC SỰ đổi (so old_record với record), tránh gửi
// email trùng khi các trường khác được cập nhật. Idempotent qua email_logs.

import { getServiceClient, claimEmailLog, markEmailLogResult, formatVN, formatVND } from "../_shared/db.ts";
import { sendEmail, parseEmailList } from "../_shared/smtp.ts";
import {
  ownerPaymentSubmittedEmail,
  p1PaymentConfirmedEmail,
  ownerPaymentConfirmedEmail,
  ownerPaymentRejectedEmail,
  customerPaymentRejectedEmail,
} from "../_shared/templates.ts";

function adminUrl() {
  return `https://supabase.com/dashboard/project/${Deno.env.get("NTHP_PROJECT_REF") ?? ""}/editor`;
}

Deno.serve(async (req) => {
  try {
    const secret = Deno.env.get("DB_WEBHOOK_SECRET");
    if (secret && req.headers.get("x-webhook-secret") !== secret) {
      return new Response("unauthorized", { status: 401 });
    }

    const payload = await req.json();
    const record = payload?.record;
    const oldRecord = payload?.old_record;
    if (!record || !oldRecord || payload?.type !== "UPDATE") {
      return new Response("ignored: not an update payload", { status: 200 });
    }
    if (record.payment_status === oldRecord.payment_status) {
      return new Response("ignored: payment_status unchanged", { status: 200 });
    }

    const sb = getServiceClient();
    const appUrl = Deno.env.get("APP_URL") ?? "";
    const paymentUrl = `${appUrl}/?registration=${encodeURIComponent(record.registration_code)}&token=${encodeURIComponent(record.payment_token)}`;
    const unsubscribeUrl = `${appUrl}/unsubscribe.html?code=${encodeURIComponent(record.registration_code)}&token=${encodeURIComponent(record.payment_token)}`;
    const giftTitle = record.lead_magnet_title || Deno.env.get("LEAD_MAGNET_TITLE") || "Ebook Bắt Mạch Tài Chính Gia Đình";
    const giftUrl = Deno.env.get("LEAD_MAGNET_URL") || "https://example.com/PLACEHOLDER-thay-link-qua-tang-that";

    const paymentSubmittedRecipients = parseEmailList(
      Deno.env.get("PAYMENT_NOTIFICATION_EMAILS") ?? Deno.env.get("ADMIN_NOTIFICATION_EMAILS") ?? Deno.env.get("OWNER_EMAIL"),
    );
    const instantPaymentSubmittedEnabled = (Deno.env.get("ENABLE_INSTANT_PAYMENT_SUBMITTED_EMAIL") ?? "true") === "true";
    const instantPaymentConfirmedEnabled = (Deno.env.get("ENABLE_INSTANT_PAYMENT_CONFIRMED_EMAIL") ?? "true") === "true";

    const results: Record<string, string> = {};
    const newStatus = record.payment_status;

    // ===== payment_submitted: báo chủ hệ thống "chờ đối soát" =====
    if (newStatus === "payment_submitted") {
      if (instantPaymentSubmittedEnabled && paymentSubmittedRecipients.length > 0) {
        const logId = await claimEmailLog(sb, record.registration_id, "owner_payment_submitted", paymentSubmittedRecipients.join(","));
        if (logId) {
          try {
            const tpl = ownerPaymentSubmittedEmail({
              fullName: record.full_name,
              registrationCode: record.registration_code,
              phone: record.phone,
              email: record.email,
              paymentAmount: formatVND(record.payment_amount),
              payerName: record.payer_name ?? "",
              payerBank: record.payer_bank ?? "",
              transferTimeVN: formatVN(record.transfer_time),
              note: record.note,
              adminUrl: adminUrl(),
            });
            const sent = await sendEmail({ to: paymentSubmittedRecipients, subject: tpl.subject, html: tpl.html });
            await markEmailLogResult(sb, logId, true, sent.id);
            results.owner_payment_submitted = "sent";
          } catch (e) {
            await markEmailLogResult(sb, logId, false, undefined, String(e));
            results.owner_payment_submitted = "failed";
          }
        } else {
          results.owner_payment_submitted = "already_claimed";
        }
      }
    }

    // ===== payment_confirmed: gửi P1 cho khách + báo doanh thu cho chủ hệ thống =====
    if (newStatus === "payment_confirmed") {
      // P1 cho khách — CHỈ gửi khi admin/webhook thật sự xác nhận, không bao giờ tự động từ upload biên lai
      if (record.email && record.email_opt_in !== false) {
        const logId = await claimEmailLog(sb, record.registration_id, "P1_payment_confirmed", record.email);
        if (logId) {
          try {
            const tpl = p1PaymentConfirmedEmail({
              fullName: record.full_name,
              registrationCode: record.registration_code,
              paymentAmount: formatVND(record.payment_amount),
              workshopDateLabel: Deno.env.get("WORKSHOP_DATE_LABEL") ?? "14h00 – 17h00, Chủ Nhật ngày 26/7/2026",
              giftTitle,
              giftUrl,
              unsubscribeUrl,
            });
            const sent = await sendEmail({ to: record.email, subject: tpl.subject, html: tpl.html, replyTo: Deno.env.get("EMAIL_REPLY_TO") });
            await markEmailLogResult(sb, logId, true, sent.id);
            results.p1_payment_confirmed = "sent";
          } catch (e) {
            await markEmailLogResult(sb, logId, false, undefined, String(e));
            results.p1_payment_confirmed = "failed";
          }
        } else {
          results.p1_payment_confirmed = "already_claimed";
        }
      }

      // Báo chủ hệ thống, kèm số liệu tổng quan (chỉ tính từ payment_confirmed thật sự)
      const confirmedRecipients = parseEmailList(
        Deno.env.get("FINANCE_REPORT_EMAILS") ?? Deno.env.get("ADMIN_NOTIFICATION_EMAILS") ?? Deno.env.get("OWNER_EMAIL"),
      );
      if (instantPaymentConfirmedEnabled && confirmedRecipients.length > 0) {
        const logId = await claimEmailLog(sb, record.registration_id, "owner_payment_confirmed", confirmedRecipients.join(","));
        if (logId) {
          try {
            const { data: stats } = await sb.from("admin_summary_stats").select("*").single();
            const tpl = ownerPaymentConfirmedEmail({
              fullName: record.full_name,
              registrationCode: record.registration_code,
              paymentAmount: formatVND(record.payment_amount),
              vatIncluded: true,
              confirmedAtVN: formatVN(new Date().toISOString()),
              utmSource: record.utm_source,
              utmCampaign: record.utm_campaign,
              refCode: record.ref_code,
              totalLeads: stats?.total_leads ?? 0,
              awaitingReconciliation: stats?.awaiting_reconciliation ?? 0,
              confirmedCount: stats?.confirmed_count ?? 0,
              confirmedRevenue: formatVND(stats?.confirmed_revenue ?? 0),
              promoTicketsRemaining: stats?.promo_tickets_remaining ?? 0,
              adminUrl: adminUrl(),
            });
            const sent = await sendEmail({ to: confirmedRecipients, subject: tpl.subject, html: tpl.html });
            await markEmailLogResult(sb, logId, true, sent.id);
            results.owner_payment_confirmed = "sent";
          } catch (e) {
            await markEmailLogResult(sb, logId, false, undefined, String(e));
            results.owner_payment_confirmed = "failed";
          }
        } else {
          results.owner_payment_confirmed = "already_claimed";
        }
      }
    }

    // ===== payment_rejected: báo khách bổ sung thông tin + cảnh báo chủ hệ thống =====
    if (newStatus === "payment_rejected") {
      if (record.email && record.email_opt_in !== false) {
        const logId = await claimEmailLog(sb, record.registration_id, "customer_payment_rejected", record.email);
        if (logId) {
          try {
            const tpl = customerPaymentRejectedEmail({
              fullName: record.full_name,
              registrationCode: record.registration_code,
              paymentUrl,
              unsubscribeUrl,
            });
            const sent = await sendEmail({ to: record.email, subject: tpl.subject, html: tpl.html, replyTo: Deno.env.get("EMAIL_REPLY_TO") });
            await markEmailLogResult(sb, logId, true, sent.id);
            results.customer_payment_rejected = "sent";
          } catch (e) {
            await markEmailLogResult(sb, logId, false, undefined, String(e));
            results.customer_payment_rejected = "failed";
          }
        }
      }
      const alertRecipients = parseEmailList(Deno.env.get("ADMIN_NOTIFICATION_EMAILS") ?? Deno.env.get("OWNER_EMAIL"));
      if (alertRecipients.length > 0) {
        const logId = await claimEmailLog(sb, record.registration_id, "owner_payment_rejected", alertRecipients.join(","));
        if (logId) {
          try {
            const tpl = ownerPaymentRejectedEmail({ fullName: record.full_name, registrationCode: record.registration_code, adminUrl: adminUrl() });
            const sent = await sendEmail({ to: alertRecipients, subject: tpl.subject, html: tpl.html });
            await markEmailLogResult(sb, logId, true, sent.id);
            results.owner_payment_rejected = "sent";
          } catch (e) {
            await markEmailLogResult(sb, logId, false, undefined, String(e));
            results.owner_payment_rejected = "failed";
          }
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, results }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("on-payment-status-changed error:", e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
