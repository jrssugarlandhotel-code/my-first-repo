/* mailer.js -- automatic client emails.
   Two kinds of email:
     1. "inquiry-received" -- sent once, right when a guest submits the
        public Event Inquiry Form (immediate thank-you / acknowledgment).
     2. "follow-up" -- sent automatically by a background sweep for any
        ledger row that is still sitting at status "Inquiry" with no
        follow-up sent yet, N days after it was logged (FOLLOWUP_DAYS,
        default 3). Also sendable on demand ("Send follow-up now" button
        in the ledger entry modal).

   All of this is best-effort: if SMTP isn't configured, or a send fails,
   the app logs it and carries on -- email is never allowed to block or
   break the ledger/calendar features. */

const nodemailer = require('nodemailer');

const HOTEL_NAME = process.env.HOTEL_NAME || 'our sales desk';
const MAIL_FROM = process.env.MAIL_FROM || process.env.SMTP_USER || '';
const FOLLOWUP_DAYS = Number(process.env.FOLLOWUP_DAYS || 3);
const FOLLOWUP_ENABLED = process.env.FOLLOWUP_ENABLED !== 'false';
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // check once an hour

let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true', // true for port 465, false for 587/25
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
} else {
  console.warn(
    'Email is not configured (missing SMTP_HOST/SMTP_USER/SMTP_PASS) -- ' +
    'automatic inquiry and follow-up emails will be skipped. See .env.example.'
  );
}

function isConfigured() {
  return !!transporter;
}

async function sendMail({ to, subject, html, text }) {
  if (!transporter) return { ok: false, error: 'Email is not configured on this server.' };
  if (!to) return { ok: false, error: 'Missing recipient email address.' };
  try {
    await transporter.sendMail({ from: MAIL_FROM || undefined, to, subject, html, text });
    return { ok: true };
  } catch (e) {
    console.error('Failed to send email to', to, '-', e.message);
    return { ok: false, error: e.message };
  }
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function wrap(bodyHtml) {
  return `<div style="font-family:Georgia,'Times New Roman',serif;max-width:520px;margin:0 auto;color:#2b2b26;line-height:1.6;">${bodyHtml}<p style="margin-top:28px;font-size:12.5px;color:#8a8a7d;">${esc(HOTEL_NAME)}</p></div>`;
}

function inquiryReceivedEmail(d) {
  const subject = `We've received your inquiry${d.title ? ' -- ' + d.title : ''}`;
  const html = wrap(`
    <p>Hi ${esc(d.name) || 'there'},</p>
    <p>Thank you for reaching out to ${esc(HOTEL_NAME)}. We've logged your inquiry${d.title ? ' for <b>' + esc(d.title) + '</b>' : ''}${d.eventDate ? ' on <b>' + esc(d.eventDate) + '</b>' : ''} and a member of our sales team${d.execName ? ' (' + esc(d.execName) + ')' : ''} will follow up with you shortly.</p>
    <p>If anything about your event changes in the meantime -- date, guest count, or venue preference -- just reply to this email and let us know.</p>
  `);
  const text = `Hi ${d.name || 'there'},\n\nThank you for reaching out to ${HOTEL_NAME}. We've logged your inquiry${d.title ? ' for ' + d.title : ''}${d.eventDate ? ' on ' + d.eventDate : ''} and a member of our sales team will follow up with you shortly.`;
  return { subject, html, text };
}

function followUpEmail(d) {
  const subject = `Following up on your inquiry${d.title ? ' -- ' + d.title : ''}`;
  const html = wrap(`
    <p>Hi ${esc(d.name) || 'there'},</p>
    <p>Just checking in on your inquiry${d.title ? ' for <b>' + esc(d.title) + '</b>' : ''}${d.eventDate ? ' on <b>' + esc(d.eventDate) + '</b>' : ''}. We'd love to help you finalize the details whenever you're ready -- feel free to reply to this email or give us a call.</p>
    <p>Looking forward to hearing from you.</p>
  `);
  const text = `Hi ${d.name || 'there'},\n\nJust checking in on your inquiry${d.title ? ' for ' + d.title : ''}${d.eventDate ? ' on ' + d.eventDate : ''}. We'd love to help you finalize the details whenever you're ready.`;
  return { subject, html, text };
}

function daysSince(dateStr) {
  if (!dateStr) return -1;
  const then = new Date(dateStr);
  if (Number.isNaN(then.getTime())) return -1;
  return (Date.now() - then.getTime()) / 86400000;
}

/* Scans the ledger for inquiries that are still open (status "Inquiry"),
   have a guest email on file, and haven't had a follow-up sent yet. Sends
   one and stamps followUpSentAt so it's never sent twice automatically. */
async function runFollowUpSweep(getPayload, savePayload) {
  if (!FOLLOWUP_ENABLED || !transporter) return;
  let rows;
  try {
    rows = await getPayload('ledger');
  } catch (e) {
    console.error('Follow-up sweep: could not read ledger -', e.message);
    return;
  }
  if (!Array.isArray(rows) || !rows.length) return;

  let changed = false;
  for (const row of rows) {
    if (!row || row.status !== 'Inquiry') continue;
    if (!row.guestEmail) continue;
    if (row.followUpSentAt) continue;
    if (daysSince(row.timestamp) < FOLLOWUP_DAYS) continue;

    const { subject, html, text } = followUpEmail({
      name: row.client,
      title: row.company,
      eventDate: row.eventDate,
    });
    const result = await sendMail({ to: row.guestEmail, subject, html, text });
    if (result.ok) {
      row.followUpSentAt = new Date().toISOString();
      changed = true;
      console.log('Follow-up email sent to', row.guestEmail, 'for ledger row', row.id);
    }
  }

  if (changed) {
    try {
      await savePayload('ledger', rows);
    } catch (e) {
      console.error('Follow-up sweep: could not save ledger -', e.message);
    }
  }
}

function startFollowUpSweep(getPayload, savePayload) {
  if (!FOLLOWUP_ENABLED) {
    console.log('Automatic follow-up emails are disabled (FOLLOWUP_ENABLED=false).');
    return;
  }
  // Run once shortly after startup, then on a recurring interval.
  setTimeout(() => runFollowUpSweep(getPayload, savePayload), 15 * 1000);
  setInterval(() => runFollowUpSweep(getPayload, savePayload), SWEEP_INTERVAL_MS);
}

module.exports = {
  isConfigured,
  sendMail,
  inquiryReceivedEmail,
  followUpEmail,
  runFollowUpSweep,
  startFollowUpSweep,
  FOLLOWUP_DAYS,
};
