import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { customDomainIp } from "./domain-config.js";

/**
 * Проверка HTTPS для custom domain.
 *
 * Подключаемся не к локальному Caddy, а к публичному NLB IP с SNI пользовательского домена:
 * именно этот путь пройдёт клиент. Сертификат проверяется штатной проверкой Node
 * (`rejectUnauthorized` + `checkServerIdentity`), поэтому самоподписанный или сертификат
 * чужого имени не считается успехом. HTTP не запрашиваем: для активации достаточно
 * TLS-рукопожатия, а тело и редиректы проверяются отдельно на этапе SEO.
 */

export type TlsProbeResult = {
  ok: boolean;
  protocol?: string;
  error?: string;
};

export type TlsProbe = (hostname: string) => Promise<TlsProbeResult>;

export type TlsProbeOptions = {
  ip?: string;
  timeoutMs?: number;
  /** Для unit-тестов без реального сетевого соединения. */
  connect?: typeof tlsConnect;
};

export function probeCustomDomainTls(hostname: string, options: TlsProbeOptions = {}): Promise<TlsProbeResult> {
  const ip = options.ip ?? customDomainIp();
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 20_000, 60_000));
  const connect = options.connect ?? tlsConnect;

  return new Promise(resolve => {
    let settled = false;
    let socket: TLSSocket | null = null;
    const finish = (result: TlsProbeResult) => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      resolve(result);
    };

    try {
      socket = connect({
        host: ip,
        port: 443,
        servername: hostname,
        rejectUnauthorized: true,
        timeout: timeoutMs,
      }, () => {
        try {
          if (!socket?.authorized) {
            finish({ ok: false, error: socket?.authorizationError ? String(socket.authorizationError) : "сертификат не прошёл проверку" });
            return;
          }
          const certificate = socket.getPeerCertificate();
          if (!certificate || !certificate.subject) {
            finish({ ok: false, error: "Caddy не предъявил сертификат" });
            return;
          }
          finish({ ok: true, protocol: socket.getProtocol() ?? undefined });
        } catch (error) {
          finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
      socket.once("timeout", () => finish({ ok: false, error: "истекло время TLS-проверки" }));
      socket.once("error", error => finish({ ok: false, error: error.message }));
    } catch (error) {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
