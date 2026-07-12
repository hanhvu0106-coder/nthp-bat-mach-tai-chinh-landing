const BRAND = {
  navy: "#071A2F",
  cyan: "#18C6D9",
  cyanDark: "#0EA0B0",
};

function escapeHtml(s: string | null | undefined): string {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function firstNameOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] || fullName;
}

function wrapEmail(opts: {
  title: string;
  bodyHtml: string;
  showUnsubscribe?: boolean;
  unsubscribeUrl?: string;
}): string {
  return `<!DOCTYPE html>
<html lang="vi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(opts.title)}</title></head>
<body style="margin:0;padding:0;background:#F1F5F8;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F8;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;" cellpadding="0" cellspacing="0">
<tr><td style="background:${BRAND.navy};padding:20px 28px;">
<span style="color:#ffffff;font-size:18px;font-weight:700;">Nấc Thang Hạnh Phúc</span>
</td></tr>
<tr><td style="padding:28px;color:#1a2733;font-size:15px;line-height:1.6;">
${opts.bodyHtml}
</td></tr>
<tr><td style="padding:18px 28px;background:#F8FBFC;color:#8a97a3;font-size:12px;">
Nấc Thang Hạnh Phúc — Workshop Bắt Mạch Tài Chính Gia Đình
${opts.showUnsubscribe && opts.unsubscribeUrl ? `<br><a href="${opts.unsubscribeUrl}" style="color:#8a97a3;">Hủy nhận email</a>` : ""}
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function dataRow(label: string, value: string): string {
  return `<tr><td style="color:#5b6b78;padding:4px 8px 4px 0;white-space:nowrap;">${escapeHtml(label)}</td><td style="padding:4px 0;">${value}</td></tr>`;
}

function dataTable(rows: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin:12px 0;">${rows}</table>`;
}

// ===== U1 — Gửi ngay sau khi đăng ký (quà + link thanh toán cá nhân hoá) =====
export function u1GiftEmail(p: {
  fullName: string;
  registrationCode: string;
  paymentUrl: string;
  giftTitle: string;
  giftUrl: string;
  unsubscribeUrl: string;
}) {
  const body = `
    <p>Chào ${escapeHtml(firstNameOf(p.fullName))},</p>
    <p>Cảm ơn bạn đã đăng ký nhận quà từ <b>Nấc Thang Hạnh Phúc</b>. Quà tặng <b>${escapeHtml(p.giftTitle)}</b> của bạn đã sẵn sàng:</p>
    <p style="text-align:center;margin:24px 0;">
      <a href="${p.giftUrl}" style="background:${BRAND.cyan};color:${BRAND.navy};text-decoration:none;font-weight:700;padding:14px 28px;border-radius:999px;display:inline-block;">Nhận quà ngay</a>
    </p>
    <p>Mã đăng ký của bạn: <b>${escapeHtml(p.registrationCode)}</b></p>
    <p>Bạn <b>chưa cần thanh toán</b> để nhận quà. Khi sẵn sàng giữ chỗ Workshop <i>Bắt Mạch Tài Chính Gia Đình</i>, bạn có thể quay lại bất cứ lúc nào qua đường link cá nhân của mình:</p>
    <p style="text-align:center;margin:24px 0;">
      <a href="${p.paymentUrl}" style="background:transparent;border:1px solid ${BRAND.cyan};color:#0A2B4A;text-decoration:none;font-weight:700;padding:12px 26px;border-radius:999px;display:inline-block;">Giữ vé Workshop với giá ưu đãi</a>
    </p>
    <p>Ekip Nấc Thang Hạnh Phúc luôn sẵn sàng hỗ trợ qua Zalo nếu bạn cần thêm thông tin.</p>
  `;
  return {
    subject: "Quà tặng Bắt Mạch Tài Chính của bạn đã sẵn sàng",
    html: wrapEmail({ title: "Quà tặng của bạn đã sẵn sàng", bodyHtml: body, showUnsubscribe: true, unsubscribeUrl: p.unsubscribeUrl }),
  };
}

// ===== Owner — Lead mới (mục 25) =====
export function ownerNewLeadEmail(p: {
  fullName: string;
  phone: string;
  zalo: string;
  email: string | null;
  city: string;
  occupation: string | null;
  referralSource: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  refCode: string | null;
  registrationCode: string;
  giftTitle: string;
  statusLabel: string;
  createdAtVN: string;
  adminUrl: string;
}) {
  const rows =
    dataRow("Họ tên", `<b>${escapeHtml(p.fullName)}</b>`) +
    dataRow("Số điện thoại", escapeHtml(p.phone)) +
    dataRow("Zalo", escapeHtml(p.zalo)) +
    dataRow("Email", escapeHtml(p.email || "(không có)")) +
    dataRow("Tỉnh/thành", escapeHtml(p.city)) +
    dataRow("Nghề nghiệp", escapeHtml(p.occupation || "(không có)")) +
    dataRow("Mã đăng ký", `<b>${escapeHtml(p.registrationCode)}</b>`) +
    dataRow("Nguồn khách tự khai", escapeHtml(p.referralSource)) +
    dataRow("UTM Source", escapeHtml(p.utmSource || "(không có)")) +
    dataRow("UTM Medium", escapeHtml(p.utmMedium || "(không có)")) +
    dataRow("UTM Campaign", escapeHtml(p.utmCampaign || "(không có)")) +
    dataRow("Người giới thiệu", escapeHtml(p.refCode || "(không có)")) +
    dataRow("Quà đã gửi", escapeHtml(p.giftTitle)) +
    dataRow("Trạng thái", escapeHtml(p.statusLabel)) +
    dataRow("Thời gian đăng ký", escapeHtml(p.createdAtVN));

  const body = `
    <p style="font-size:16px;font-weight:700;">LEAD MỚI</p>
    ${dataTable(rows)}
    <p style="margin-top:16px;"><a href="${p.adminUrl}" style="color:${BRAND.cyanDark};">Mở hồ sơ Lead trong Supabase</a></p>
  `;
  return {
    subject: `[Lead mới] ${p.fullName} vừa đăng ký Workshop Bắt Mạch Tài Chính`,
    html: wrapEmail({ title: "Lead mới", bodyHtml: body }),
  };
}

// ===== Owner — Chờ đối soát (mục 26) =====
export function ownerPaymentSubmittedEmail(p: {
  fullName: string;
  registrationCode: string;
  phone: string;
  email: string | null;
  paymentAmount: string;
  payerName: string;
  payerBank: string;
  transferTimeVN: string;
  note: string | null;
  adminUrl: string;
}) {
  const rows =
    dataRow("Họ tên", `<b>${escapeHtml(p.fullName)}</b>`) +
    dataRow("Mã đăng ký", `<b>${escapeHtml(p.registrationCode)}</b>`) +
    dataRow("Số điện thoại", escapeHtml(p.phone)) +
    dataRow("Email", escapeHtml(p.email || "(không có)")) +
    dataRow("Số tiền cần thanh toán", escapeHtml(p.paymentAmount)) +
    dataRow("Tên người chuyển", escapeHtml(p.payerName)) +
    dataRow("Ngân hàng chuyển", escapeHtml(p.payerBank)) +
    dataRow("Thời gian khai báo chuyển", escapeHtml(p.transferTimeVN)) +
    dataRow("Ghi chú", escapeHtml(p.note || "(không có)")) +
    dataRow("Trạng thái", "<b>Chờ đối soát</b>");

  const body = `
    <p style="font-size:16px;font-weight:700;">CHỜ ĐỐI SOÁT</p>
    ${dataTable(rows)}
    <p style="margin-top:16px;"><a href="${p.adminUrl}" style="color:${BRAND.cyanDark};">Xem biên lai và xác nhận thanh toán trong Supabase</a></p>
  `;
  return {
    subject: `[Chờ đối soát] ${p.fullName} đã gửi thông tin chuyển khoản`,
    html: wrapEmail({ title: "Chờ đối soát", bodyHtml: body }),
  };
}

// ===== P1 — Xác nhận thanh toán thành công (mục 10) =====
export function p1PaymentConfirmedEmail(p: {
  fullName: string;
  registrationCode: string;
  paymentAmount: string;
  workshopDateLabel: string;
  giftTitle: string;
  giftUrl: string;
  unsubscribeUrl: string;
}) {
  const rows =
    dataRow("Họ tên", `<b>${escapeHtml(p.fullName)}</b>`) +
    dataRow("Mã đăng ký", `<b>${escapeHtml(p.registrationCode)}</b>`) +
    dataRow("Số tiền đã thanh toán", escapeHtml(p.paymentAmount)) +
    dataRow("Tình trạng", "<b>Đã xác nhận</b>") +
    dataRow("Thời gian Workshop", escapeHtml(p.workshopDateLabel)) +
    dataRow("Hình thức", "Online qua Zoom");

  const body = `
    <p>Chào ${escapeHtml(firstNameOf(p.fullName))},</p>
    <p>Vé tham dự Workshop <b>Bắt Mạch Tài Chính Gia Đình</b> của bạn đã được xác nhận.</p>
    ${dataTable(rows)}
    <p><a href="${p.giftUrl}" style="color:${BRAND.cyanDark};">Xem lại quà tặng: ${escapeHtml(p.giftTitle)}</a></p>
    <p>Ekip sẽ gửi link Zoom và các thông tin chuẩn bị qua Zalo/email trước buổi học. Vui lòng để ý điện thoại và hộp thư trong những ngày tới.</p>
  `;
  return {
    subject: "Thanh toán thành công — Vé Workshop của bạn đã được xác nhận",
    html: wrapEmail({ title: "Vé Workshop đã được xác nhận", bodyHtml: body, showUnsubscribe: true, unsubscribeUrl: p.unsubscribeUrl }),
  };
}

// ===== Owner — Thanh toán đã được xác nhận (mục 27) =====
export function ownerPaymentConfirmedEmail(p: {
  fullName: string;
  registrationCode: string;
  paymentAmount: string;
  vatIncluded: boolean;
  confirmedAtVN: string;
  utmSource: string | null;
  utmCampaign: string | null;
  refCode: string | null;
  totalLeads: number;
  awaitingReconciliation: number;
  confirmedCount: number;
  confirmedRevenue: string;
  promoTicketsRemaining: number;
  adminUrl: string;
}) {
  const rows1 =
    dataRow("Khách hàng", `<b>${escapeHtml(p.fullName)}</b>`) +
    dataRow("Mã đăng ký", escapeHtml(p.registrationCode)) +
    dataRow("Số tiền", escapeHtml(p.paymentAmount)) +
    dataRow("VAT", p.vatIncluded ? "Đã bao gồm 8%" : "") +
    dataRow("Thời gian xác nhận", escapeHtml(p.confirmedAtVN)) +
    dataRow("Nguồn khách", escapeHtml(p.utmSource || "(không có)")) +
    dataRow("Chiến dịch", escapeHtml(p.utmCampaign || "(không có)")) +
    dataRow("Người giới thiệu", escapeHtml(p.refCode || "(không có)"));

  const rows2 =
    dataRow("Tổng Lead", String(p.totalLeads)) +
    dataRow("Đã gửi biên lai (chờ đối soát)", String(p.awaitingReconciliation)) +
    dataRow("Đã thanh toán", String(p.confirmedCount)) +
    dataRow("Tổng tiền đã xác nhận", `<b>${escapeHtml(p.confirmedRevenue)}</b>`) +
    dataRow("Vé ưu đãi còn lại", `${p.promoTicketsRemaining}/50`);

  const body = `
    <p style="font-size:16px;font-weight:700;">THANH TOÁN ĐÃ ĐƯỢC XÁC NHẬN</p>
    ${dataTable(rows1)}
    <p style="font-size:15px;font-weight:700;margin-top:20px;">TỔNG QUAN HIỆN TẠI</p>
    ${dataTable(rows2)}
    <p style="margin-top:16px;"><a href="${p.adminUrl}" style="color:${BRAND.cyanDark};">Xem chi tiết trong Supabase</a></p>
  `;
  return {
    subject: `[Đã thanh toán] ${p.fullName} – ${p.paymentAmount} – ${p.registrationCode}`,
    html: wrapEmail({ title: "Thanh toán đã được xác nhận", bodyHtml: body }),
  };
}

// ===== Owner — Cảnh báo giao dịch bị từ chối =====
export function ownerPaymentRejectedEmail(p: { fullName: string; registrationCode: string; adminUrl: string }) {
  const body = `
    <p>Giao dịch <b>${escapeHtml(p.registrationCode)}</b> của <b>${escapeHtml(p.fullName)}</b> vừa được đánh dấu <b>payment_rejected</b> (thông tin chuyển khoản không hợp lệ hoặc chưa khớp).</p>
    <p><a href="${p.adminUrl}" style="color:${BRAND.cyanDark};">Xem chi tiết trong Supabase</a></p>
  `;
  return {
    subject: `[Cần xử lý] Giao dịch ${p.registrationCode} bị từ chối đối soát`,
    html: wrapEmail({ title: "Giao dịch bị từ chối", bodyHtml: body }),
  };
}

// ===== Khách — Cần bổ sung thông tin chuyển khoản =====
export function customerPaymentRejectedEmail(p: {
  fullName: string;
  registrationCode: string;
  paymentUrl: string;
  unsubscribeUrl: string;
}) {
  const body = `
    <p>Chào ${escapeHtml(firstNameOf(p.fullName))},</p>
    <p>BTC chưa thể xác nhận được giao dịch cho mã đăng ký <b>${escapeHtml(p.registrationCode)}</b> — thông tin chuyển khoản cần được bổ sung hoặc kiểm tra lại.</p>
    <p>Vui lòng quay lại link dưới đây để gửi lại thông tin chuyển khoản, hoặc nhắn Zalo để được hỗ trợ trực tiếp:</p>
    <p style="text-align:center;margin:24px 0;">
      <a href="${p.paymentUrl}" style="background:${BRAND.cyan};color:${BRAND.navy};text-decoration:none;font-weight:700;padding:14px 28px;border-radius:999px;display:inline-block;">Gửi lại thông tin chuyển khoản</a>
    </p>
  `;
  return {
    subject: "Cần bổ sung thông tin chuyển khoản của bạn",
    html: wrapEmail({ title: "Cần bổ sung thông tin", bodyHtml: body, showUnsubscribe: true, unsubscribeUrl: p.unsubscribeUrl }),
  };
}
