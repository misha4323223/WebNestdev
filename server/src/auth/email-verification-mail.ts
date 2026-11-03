import { sendMail } from "../mail/mailer.js";

export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Абсолютная ссылка сразу на приложение. Так ей не нужен редирект с API: адрес приложения уже
 * известен при отправке, и ссылка одинаково работает в preview и в продакшене.
 */
export function emailVerificationLink(baseUrl: string, token: string) {
  const url = new URL("/", baseUrl);
  url.searchParams.set("verify_email", token);
  return url.toString();
}

/**
 * Письмо подтверждения — служебное, поэтому идёт тем же SMTP/Postbox, что оплата и поддержка.
 * Ссылка ведёт на этот же сервер: он подтверждает токен, ставит cookie сессии и возвращает
 * человека в приложение.
 */
export async function sendVerificationEmail(input: { to: string; link: string }) {
  const ttlHours = Math.round(EMAIL_VERIFICATION_TTL_MS / 3_600_000);
  return sendMail({
    to: input.to,
    subject: "Подтвердите почту — NestDev",
    text: [
      "Здравствуйте!",
      "",
      "Вы создали аккаунт NestDev с этим адресом почты.",
      "Чтобы завершить регистрацию, откройте ссылку и подтвердите пароль:",
      "",
      input.link,
      "",
      `Ссылка действует ${ttlHours} часа и работает один раз.`,
      "Если вы не регистрировались в NestDev, просто проигнорируйте это письмо.",
      "",
      "— NestDev",
    ].join("\n"),
  });
}
