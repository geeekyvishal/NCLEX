import { config } from "../../config.js";

interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
}

/**
 * Send an email. Uses Resend API in production, logs to console in development.
 */
export async function sendEmail({ to, subject, html }: SendEmailParams): Promise<void> {
  if (config.NODE_ENV === "production") {
    if (!config.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is required in production environment");
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: config.EMAIL_FROM,
        to,
        subject,
        html,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(
        `Resend API error: ${response.status} ${response.statusText} - ${errBody}`,
      );
    }
  } else {
    // Development fallback: Log the email to the console.
    console.log("--------------------------------------------------");
    console.log(`[DEV-EMAIL] To:      ${to}`);
    console.log(`[DEV-EMAIL] From:    ${config.EMAIL_FROM}`);
    console.log(`[DEV-EMAIL] Subject: ${subject}`);
    console.log(`[DEV-EMAIL] HTML Content:\n${html}`);
    console.log("--------------------------------------------------");
  }
}
