/** The Worker's bindings, vars and secrets (wrangler.jsonc, docs/relay.md). */
export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  BLOBS: R2Bucket;
  EMAIL: SendEmail;
  RL_LOGIN_IP: RateLimit;
  RL_LOGIN_EMAIL: RateLimit;
  RL_VERIFY: RateLimit;
  RL_UPLOAD: RateLimit;
  RL_READ: RateLimit;
  /**
   * "on" serves the relay API; anything else (the production default, "off")
   * makes every /relay path a 404, so the web app shows no email option and
   * the server never sends mail (docs/relay.md, "Turn the relay on").
   */
  RELAY_MODE: string;
  /** "on" checks a Turnstile token on login; "off" skips it (the default, docs/relay.md). */
  TURNSTILE_MODE: string;
  /** The widget's site key; must be set when TURNSTILE_MODE is "on". */
  TURNSTILE_SITE_KEY: string;
  /** "cloudflare" (Email Service) or "dev-outbox" (writes mail to R2). */
  MAIL_TRANSPORT: string;
  /** Origin of the web app, used in emailed links. */
  PUBLIC_ORIGIN: string;
  /** Sender address; it must belong to a domain onboarded to Email Service. */
  MAIL_FROM: string;
  /** Secret: HMAC key for session tokens and code hashes. */
  RELAY_SESSION_SECRET?: string;
  /** Secret: Turnstile siteverify key; needed only when TURNSTILE_MODE is "on". */
  TURNSTILE_SECRET?: string;
}
