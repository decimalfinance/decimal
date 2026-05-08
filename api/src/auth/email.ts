import { config } from '../config.js';

const RESEND_API_URL = 'https://api.resend.com/emails';

export function isEmailDeliveryConfigured() {
  return Boolean(config.resendApiKey && config.resendFromEmail);
}

export async function sendVerificationEmail({
  toEmail,
  displayName,
  code,
}: {
  toEmail: string;
  displayName: string | null;
  code: string;
}): Promise<{ delivered: boolean }> {
  if (!isEmailDeliveryConfigured()) {
    return { delivered: false };
  }

  const fromHeader = config.resendFromName
    ? `${config.resendFromName} <${config.resendFromEmail}>`
    : config.resendFromEmail;

  const greeting = displayName ? `Hi ${displayName},` : 'Hi,';
  const subject = 'Your Decimal verification code';
  const text = [
    greeting,
    '',
    `Your Decimal verification code is: ${code}`,
    '',
    'This code expires in 30 minutes. If you did not request this, you can safely ignore this email.',
    '',
    '— Decimal',
  ].join('\n');
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #111; line-height: 1.5;">
      <p>${escapeHtml(greeting)}</p>
      <p>Your Decimal verification code is:</p>
      <p style="font-size: 28px; font-weight: 600; letter-spacing: 0.12em; margin: 16px 0;">${escapeHtml(code)}</p>
      <p>This code expires in 30 minutes. If you did not request this, you can safely ignore this email.</p>
      <p style="color: #666; margin-top: 32px;">— Decimal</p>
    </div>
  `.trim();

  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.resendApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: fromHeader,
      to: [toEmail],
      subject,
      text,
      html,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Resend send failed (${response.status}): ${body || response.statusText}`);
  }

  return { delivered: true };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
