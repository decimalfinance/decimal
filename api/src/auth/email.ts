import { isEmailDeliveryConfigured, sendEmail } from '../infra/email.js';

export { isEmailDeliveryConfigured };

export async function sendVerificationEmail({
  toEmail,
  displayName,
  code,
}: {
  toEmail: string;
  displayName: string | null;
  code: string;
}): Promise<{ delivered: boolean }> {
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

  return sendEmail({ to: toEmail, subject, text, html });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
