import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export function getServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("missing_supabase_service_config");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Đăng ký "quyền gửi" một email cụ thể cho một registration_id.
 * Nhờ unique(registration_id, email_code) trên email_logs, nếu email này
 * đã được claim trước đó (thành công hay đang chạy dở), insert sẽ bị
 * conflict và trả về null — nơi gọi phải bỏ qua, không gửi trùng.
 */
export async function claimEmailLog(
  sb: SupabaseClient,
  registrationId: string,
  emailCode: string,
  recipientEmail: string | null,
): Promise<string | null> {
  const { data, error } = await sb
    .from("email_logs")
    .insert({
      registration_id: registrationId,
      email_code: emailCode,
      recipient_email: recipientEmail,
      status: "pending",
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") return null; // đã claim trước đó
    throw error;
  }
  return data.id as string;
}

export async function markEmailLogResult(
  sb: SupabaseClient,
  logId: string,
  ok: boolean,
  providerMessageId?: string,
  errorMessage?: string,
): Promise<void> {
  await sb
    .from("email_logs")
    .update({
      status: ok ? "sent" : "failed",
      sent_at: ok ? new Date().toISOString() : null,
      provider_message_id: providerMessageId ?? null,
      error_message: errorMessage ?? null,
    })
    .eq("id", logId);
}

export function formatVN(iso: string | null | undefined): string {
  if (!iso) return "(không có)";
  return new Date(iso).toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatVND(amount: number | null | undefined): string {
  return `${Math.round(amount ?? 0).toLocaleString("vi-VN")}đ`;
}
