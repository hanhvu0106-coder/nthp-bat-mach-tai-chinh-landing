// SMTP client tối giản, tự viết (không dùng denomailer) — gửi email HTML đơn giản
// (single-part text/html, base64 Content-Transfer-Encoding) qua Gmail SMTP với
// TLS ngầm định (port 465). Được viết thủ công sau khi denomailer tạo ra MIME lỗi
// (phần header/boundary thô bị lộ ra ngoài thành nội dung email hiển thị).

function b64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function wrapBase64(b64Str: string, lineLength = 76): string {
  const lines: string[] = [];
  for (let i = 0; i < b64Str.length; i += lineLength) {
    lines.push(b64Str.slice(i, i + lineLength));
  }
  return lines.join("\r\n");
}

function encodeHeaderWord(text: string): string {
  // RFC 2047 "B" encoding — an toàn hơn "Q" encoding cho tiếng Việt có dấu.
  return `=?UTF-8?B?${b64(text)}?=`;
}

async function readResponse(conn: Deno.TlsConn): Promise<string> {
  const decoder = new TextDecoder();
  let result = "";
  const buf = new Uint8Array(4096);
  while (true) {
    const n = await conn.read(buf);
    if (n === null) break;
    result += decoder.decode(buf.subarray(0, n), { stream: true });
    const lines = result.split("\r\n").filter((l) => l.length > 0);
    const last = lines[lines.length - 1];
    if (last && /^\d{3} /.test(last)) break;
  }
  return result;
}

async function sendCommand(conn: Deno.TlsConn, cmd: string): Promise<string> {
  await conn.write(new TextEncoder().encode(cmd + "\r\n"));
  return await readResponse(conn);
}

function assertOk(response: string, step: string) {
  const code = parseInt(response.slice(0, 3), 10);
  if (isNaN(code) || code >= 400) {
    throw new Error(`smtp_error_at_${step}: ${response.trim()}`);
  }
}

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

  const recipients = Array.isArray(opts.to) ? opts.to : [opts.to];
  const messageId = `<${crypto.randomUUID()}@${gmailUser.split("@")[1]}>`;

  const headers = [
    `From: ${encodeHeaderWord(fromName)} <${gmailUser}>`,
    `To: ${recipients.join(", ")}`,
    `Subject: ${encodeHeaderWord(opts.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
  ];
  if (opts.replyTo) headers.push(`Reply-To: ${opts.replyTo}`);

  const body = wrapBase64(b64(opts.html));
  const message = headers.join("\r\n") + "\r\n\r\n" + body + "\r\n";

  const conn = await Deno.connectTls({ hostname: "smtp.gmail.com", port: 465 });
  try {
    assertOk(await readResponse(conn), "greeting");
    assertOk(await sendCommand(conn, `EHLO ${gmailUser.split("@")[1]}`), "ehlo");
    assertOk(await sendCommand(conn, "AUTH LOGIN"), "auth_login");
    assertOk(await sendCommand(conn, b64(gmailUser)), "auth_username");
    assertOk(await sendCommand(conn, b64(gmailAppPassword)), "auth_password");
    assertOk(await sendCommand(conn, `MAIL FROM:<${gmailUser}>`), "mail_from");
    for (const rcpt of recipients) {
      assertOk(await sendCommand(conn, `RCPT TO:<${rcpt}>`), "rcpt_to");
    }
    assertOk(await sendCommand(conn, "DATA"), "data");
    assertOk(await sendCommand(conn, message + "."), "data_content");
    await sendCommand(conn, "QUIT");
  } finally {
    try {
      conn.close();
    } catch {
      // đã đóng bởi QUIT hoặc lỗi trước đó — bỏ qua
    }
  }

  return { id: messageId };
}

/** Parse "a@x.com, b@y.com" (từ biến môi trường) thành mảng địa chỉ hợp lệ. */
export function parseEmailList(envValue: string | undefined): string[] {
  if (!envValue) return [];
  return envValue
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}
