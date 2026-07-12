export async function sendEmail(opts: {
  to: string | string[];
  subject: string;
  html: string;
  replyTo?: string;
}): Promise<{ id: string }> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const fromName = Deno.env.get("EMAIL_FROM_NAME") ?? "Nấc Thang Hạnh Phúc";
  const fromAddress = Deno.env.get("EMAIL_FROM_ADDRESS");

  if (!apiKey || !fromAddress) {
    throw new Error("missing_email_config: RESEND_API_KEY / EMAIL_FROM_ADDRESS not set");
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${fromName} <${fromAddress}>`,
      to: Array.isArray(opts.to) ? opts.to : [opts.to],
      subject: opts.subject,
      html: opts.html,
      reply_to: opts.replyTo,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || `resend_error_${res.status}`);
  }
  return data;
}

/** Parse "a@x.com, b@y.com" (từ biến môi trường) thành mảng địa chỉ hợp lệ. */
export function parseEmailList(envValue: string | undefined): string[] {
  if (!envValue) return [];
  return envValue
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}
