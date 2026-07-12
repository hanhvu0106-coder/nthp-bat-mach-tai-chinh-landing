import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

export async function sendEmail(opts: {
  to: string | string[];
  subject: string;
  html: string;
  replyTo?: string;
}): Promise<{ id: string }> {
  const gmailUser = Deno.env.get("GMAIL_SENDER_ADDRESS");
  const gmailAppPassword = Deno.env.get("GMAIL_APP_PASSWORD");
  const fromName = Deno.env.get("EMAIL_FROM_NAME") ?? "Nấc Thang Hạnh Phúc";

  if (!gmailUser || !gmailAppPassword) {
    throw new Error("missing_email_config: GMAIL_SENDER_ADDRESS / GMAIL_APP_PASSWORD not set");
  }

  const client = new SMTPClient({
    connection: {
      hostname: "smtp.gmail.com",
      port: 465,
      tls: true,
      auth: {
        username: gmailUser,
        password: gmailAppPassword,
      },
    },
  });

  try {
    await client.send({
      from: `${fromName} <${gmailUser}>`,
      to: Array.isArray(opts.to) ? opts.to : [opts.to],
      subject: opts.subject,
      html: opts.html,
      replyTo: opts.replyTo || undefined,
    });
  } finally {
    await client.close();
  }

  return { id: `gmail-smtp-${Date.now()}` };
}

/** Parse "a@x.com, b@y.com" (từ biến môi trường) thành mảng địa chỉ hợp lệ. */
export function parseEmailList(envValue: string | undefined): string[] {
  if (!envValue) return [];
  return envValue
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}
