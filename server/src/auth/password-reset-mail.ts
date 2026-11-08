import { sendMail } from "../mail/mailer.js";

/**
 * Срок ссылки восстановления короче, чем у подтверждения почты: ссылка меняет пароль, а не
 * только открывает аккаунт, поэтому час — разумный компромисс между «успел открыть письмо» и
 * «письмо не лежит в ящике неделю».
 */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/** Ссылка ведёт прямо в приложение: параметр читает экран входа и показывает форму пароля. */
export function passwordResetLink(baseUrl: string, token: string) {
  const url = new URL("/", baseUrl);
  url.searchParams.set("reset_password", token);
  return url.toString();
}

export async function sendPasswordResetEmail(input: { to: string; link: string }) {
  const ttlMinutes = Math.round(PASSWORD_RESET_TTL_MS / 60_000);
  return sendMail({
    to: input.to,
    subject: "Восстановление пароля — NestDev",
    text: [
      "Здравствуйте!",
      "",
      "Кто-то (возможно, вы) запросил восстановление пароля в NestDev для этого адреса.",
      "Чтобы задать новый пароль, откройте ссылку:",
      "",
      input.link,
      "",
      `Ссылка действует ${ttlMinutes} минут и работает один раз.`,
      "После смены пароля все старые входы в аккаунт завершатся.",
      "Если вы не запрашивали восстановление, просто проигнорируйте письмо — пароль не изменится.",
      "",
      "— NestDev",
    ].join("\n"),
  });
}
