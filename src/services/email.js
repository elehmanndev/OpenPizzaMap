const { Resend } = require("resend");

const apiKey = process.env.RESEND_API_KEY;
const from = process.env.RESEND_FROM || "no-reply@openpizzamap.com";
const baseUrl = process.env.BASE_URL || "http://localhost:3000";

function getClient() {
    if (!apiKey) {
        throw new Error("RESEND_API_KEY is not set");
    }
    return new Resend(apiKey);
}

function buildVerifyLink(token) {
    const trimmed = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    return `${trimmed}/verify?token=${encodeURIComponent(token)}`;
}

function buildResetLink(token) {
    const trimmed = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    return `${trimmed}/reset?token=${encodeURIComponent(token)}`;
}

async function sendVerificationEmail({ to, token }) {
    const resend = getClient();
    const verifyUrl = buildVerifyLink(token);
    const subject = "Welcome to OpenPizzaMap";
    const text = [
        "Welcome to OpenPizzaMap",
        "",
        "You are just one click away from discovering the best pizza spots near you. Please verify your email to activate your OpenPizzaMap account.",
        verifyUrl,
        "",
        "If this wasn't you, you can ignore this email.",
    ].join("\n");
    const html = `
        <div style="background: #faf7f2; padding: 24px 12px;">
          <div style="max-width: 520px; margin: 0 auto; background: #ffffff; border: 1px solid #e5e2dc; border-radius: 16px; padding: 24px; font-family: 'Outfit', Arial, sans-serif; color: #1e1e1e;">
            <h2 style="margin: 0 0 12px;">Welcome to OpenPizzaMap</h2>
            <p style="margin: 0 0 16px;">You are just one click away from discovering the best pizza spots near you. Please verify your email to activate your OpenPizzaMap account.</p>
            <div style="margin: 0 0 20px;">
              <a href="${verifyUrl}" style="display: block; width: 100%; box-sizing: border-box; text-align: center; padding: 12px 16px; border-radius: 10px; background: #c0392b; color: #fff; text-decoration: none; font-weight: 600;">Verify my Email</a>
            </div>
            <p style="margin: 0 0 16px; font-size: 12px; color: #6b6b6b;">If this wasn't you, you can ignore this email.</p>
            <div style="height: 6px; background: #c0392b; border-radius: 999px;"></div>
          </div>
        </div>
    `;

    return resend.emails.send({ from, to, subject, text, html });
}

async function sendPasswordResetEmail({ to, token }) {
    const resend = getClient();
    const resetUrl = buildResetLink(token);
    const subject = "Forgot your password?";
    const text = [
        "Forgot your password?",
        "",
        "Don't worry, we've got you. Reset it using this link:",
        resetUrl,
        "",
        "If you didn't request this, you can ignore this email.",
    ].join("\n");
    const html = `
        <div style="background: #faf7f2; padding: 24px 12px;">
          <div style="max-width: 520px; margin: 0 auto; background: #ffffff; border: 1px solid #e5e2dc; border-radius: 16px; padding: 24px; font-family: 'Outfit', Arial, sans-serif; color: #1e1e1e;">
            <h2 style="margin: 0 0 12px;">Forgot your password?</h2>
            <p style="margin: 0 0 16px;">Don't worry, we've got you.</p>
            <div style="margin: 0 0 20px;">
              <a href="${resetUrl}" style="display: block; width: 100%; box-sizing: border-box; text-align: center; padding: 12px 16px; border-radius: 10px; background: #c0392b; color: #fff; text-decoration: none; font-weight: 600;">Reset my password</a>
            </div>
            <p style="margin: 0 0 16px; font-size: 12px; color: #6b6b6b;">If you didn't request this, you can ignore this email.</p>
            <div style="height: 6px; background: #c0392b; border-radius: 999px;"></div>
          </div>
        </div>
    `;

    return resend.emails.send({ from, to, subject, text, html });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail };
