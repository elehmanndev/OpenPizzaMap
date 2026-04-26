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

async function sendMagicLinkEmail({ to, token, isNewUser }) {
    const resend = getClient();
    const link = buildVerifyLink(token);
    const subject = isNewUser ? "Welcome to OpenPizzaMap" : "Your OpenPizzaMap sign-in link";
    const heading = isNewUser ? "Welcome to OpenPizzaMap" : "Sign in to OpenPizzaMap";
    const message = isNewUser
        ? "You're one click away from discovering the best pizza spots near you. Open this link to finish creating your account."
        : "Click the link below to sign in. It expires in 30 minutes.";
    const cta = isNewUser ? "Activate my account" : "Sign me in";

    const text = [heading, "", message, link, "", "If this wasn't you, you can ignore this email."].join("\n");
    const html = `
        <div style="padding: 24px 12px;">
          <div style="max-width: 520px; margin: 0 auto; padding: 24px; font-family: 'Outfit', Arial, sans-serif; color: #1e1e1e;">
            <h2 style="margin: 0 0 12px;">${heading}</h2>
            <p style="margin: 0 0 16px;">${message}</p>
            <div style="margin: 0 0 20px;">
              <a href="${link}" style="display: block; width: 100%; box-sizing: border-box; text-align: center; padding: 12px 16px; border-radius: 10px; background: #2bb673; color: #fff; text-decoration: none; font-weight: 600;">${cta}</a>
            </div>
            <p style="margin: 0; font-size: 12px; color: #6b6b6b;">If this wasn't you, you can ignore this email.</p>
          </div>
        </div>
    `;

    return resend.emails.send({ from, to, subject, text, html });
}

module.exports = { sendMagicLinkEmail };
