/**
 * EmailService — Resend.com powered transactional emails
 *
 * Usage:
 *   await emailService.sendGBPAlert({ to, businessName, alertCount, criticalCount })
 *   await emailService.sendWeeklyReport({ to, businessName, score, trend })
 *   await emailService.sendLowCredits({ to, balance, plan })
 *   await emailService.sendPasswordReset({ to, resetUrl })
 *
 * Set RESEND_API_KEY in .env. Get key at resend.com (free: 3,000/mo)
 * Set FROM_EMAIL to your verified sender (e.g. alerts@bizzrank.ai)
 */

const RESEND_KEY  = process.env.RESEND_API_KEY ?? '';
const FROM_EMAIL  = process.env.FROM_EMAIL     ?? 'BizzRank AI <noreply@bizzrank.ai>';
const APP_URL     = process.env.FRONTEND_URL   ?? 'https://app.bizzrank.ai';

const isConfigured = () => !!RESEND_KEY && RESEND_KEY !== 'your_resend_api_key_here';

async function send(to: string, subject: string, html: string): Promise<void> {
  if (!isConfigured()) {
    console.log(`[Email] Not configured — skipped: "${subject}" → ${to}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    console.error('[Email] Send failed:', err.message ?? res.status);
  }
}

const base = (content: string) => `
<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;margin:0;padding:32px">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">
  <div style="background:#1D9E75;padding:24px 32px;color:#fff">
    <span style="font-size:18px;font-weight:700">BizzRank AI</span>
  </div>
  <div style="padding:32px">${content}</div>
  <div style="padding:16px 32px;background:#f9fafb;font-size:12px;color:#9ca3af">
    BizzRank AI · <a href="${APP_URL}" style="color:#1D9E75">Open dashboard</a>
  </div>
</div>
</body></html>`;

export const emailService = {

  async sendGBPAlert(p: { to: string; businessName: string; alertCount: number; criticalCount: number }) {
    await send(p.to,
      `🚨 ${p.criticalCount > 0 ? 'Critical' : 'New'} GBP alert${p.alertCount > 1 ? 's' : ''} for ${p.businessName}`,
      base(`
        <h2 style="margin:0 0 8px;font-size:20px;color:#111">${p.criticalCount > 0 ? '🚨' : '🛡️'} GBP Guard Alert</h2>
        <p style="color:#6b7280;margin:0 0 20px"><strong>${p.businessName}</strong> has <strong>${p.alertCount} new change${p.alertCount > 1 ? 's' : ''}</strong> detected on Google Business Profile${p.criticalCount > 0 ? `, including <strong style="color:#dc2626">${p.criticalCount} critical</strong> change${p.criticalCount > 1 ? 's' : ''}` : ''}.</p>
        ${p.criticalCount > 0 ? '<p style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;color:#991b1b;font-size:14px">⚠️ Critical changes may include unauthorized edits to your address, phone number, or business category — which can harm your search rankings.</p>' : ''}
        <a href="${APP_URL}/gbp-guard" style="display:inline-block;margin-top:20px;background:#1D9E75;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Review changes →</a>
      `)
    );
  },

  async sendWeeklyReport(p: { to: string; businessName: string; score: number; trend: string; topAction: string }) {
    const trendIcon = p.trend === 'improving' ? '📈' : p.trend === 'declining' ? '📉' : '📊';
    await send(p.to,
      `${trendIcon} Weekly visibility report for ${p.businessName}`,
      base(`
        <h2 style="margin:0 0 8px;font-size:20px;color:#111">Weekly Report: ${p.businessName}</h2>
        <div style="background:#f9fafb;border-radius:12px;padding:24px;text-align:center;margin:16px 0">
          <p style="font-size:48px;font-weight:900;color:${p.score >= 60 ? '#1D9E75' : p.score >= 30 ? '#f59e0b' : '#dc2626'};margin:0">${p.score}</p>
          <p style="color:#6b7280;font-size:14px;margin:4px 0">Visibility Score — ${p.trend}</p>
        </div>
        <p style="color:#374151;font-size:14px"><strong>Top action this week:</strong> ${p.topAction}</p>
        <a href="${APP_URL}/overview" style="display:inline-block;margin-top:16px;background:#1D9E75;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">View full report →</a>
      `)
    );
  },

  async sendLowCredits(p: { to: string; balance: number; plan: string }) {
    await send(p.to,
      `⚡ Low credits — ${p.balance} remaining`,
      base(`
        <h2 style="margin:0 0 8px;font-size:20px;color:#111">⚡ Credits running low</h2>
        <p style="color:#6b7280">You have <strong>${p.balance} credits</strong> remaining. Credits are used for manual scans (25 credits each).</p>
        <p style="color:#6b7280;margin-top:8px">Automated weekly scans are free and won't use your credits.</p>
        <p style="color:#6b7280;margin-top:8px">Credits reset on the 1st of next month — or you can upgrade your plan for more.</p>
        <a href="${APP_URL}/profile" style="display:inline-block;margin-top:16px;background:#1D9E75;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">View plan options →</a>
      `)
    );
  },

  async sendPasswordReset(p: { to: string; resetUrl: string }) {
    await send(p.to,
      'Reset your BizzRank password',
      base(`
        <h2 style="margin:0 0 8px;font-size:20px;color:#111">Reset your password</h2>
        <p style="color:#6b7280">Click the button below to reset your password. This link expires in 1 hour.</p>
        <a href="${p.resetUrl}" style="display:inline-block;margin-top:20px;background:#1D9E75;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Reset password →</a>
        <p style="color:#9ca3af;font-size:12px;margin-top:16px">If you didn't request this, you can safely ignore this email.</p>
      `)
    );
  },

  async sendScanComplete(p: { to: string; businessName: string; keyword: string; score: number; scanId: string }) {
    await send(p.to,
      `✅ Scan complete — ${p.businessName} for "${p.keyword}"`,
      base(`
        <h2 style="margin:0 0 8px;font-size:20px;color:#111">Scan Complete</h2>
        <p style="color:#6b7280"><strong>${p.businessName}</strong> scan for "<strong>${p.keyword}</strong>" is ready.</p>
        <div style="background:#f9fafb;border-radius:12px;padding:20px;text-align:center;margin:16px 0">
          <p style="font-size:40px;font-weight:900;color:${p.score >= 60 ? '#1D9E75' : p.score >= 30 ? '#f59e0b' : '#dc2626'};margin:0">${p.score}</p>
          <p style="color:#6b7280;font-size:14px;margin:4px 0">Visibility Score</p>
        </div>
        <a href="${APP_URL}/organic/${p.scanId}" style="display:inline-block;background:#1D9E75;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">View heatmap →</a>
      `)
    );
  },
};
