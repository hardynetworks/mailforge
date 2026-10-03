const env = (k: string, d?: string) => {
  const v = process.env[k];
  if (v === undefined || v === '') {
    if (d === undefined) throw new Error(`Missing required env var ${k}`);
    return d;
  }
  return v;
};
const bool = (k: string, d: boolean) => ['1', 'true', 'yes'].includes(env(k, d ? 'true' : 'false').toLowerCase());

export const config = {
  databaseUrl: env('DATABASE_URL'),
  redisUrl: env('REDIS_URL', 'redis://localhost:6379'),
  jwtSecret: env('SECRET_KEY'), // also signs tracking links
  publicUrl: env('PUBLIC_URL', 'http://localhost:3000').replace(/\/$/, ''),
  port: Number(env('PORT', '3000')),
  allowSignup: bool('ALLOW_SIGNUP', false), // first account is always allowed
  requireDomainVerification: bool('REQUIRE_DOMAIN_VERIFICATION', true),

  // Our MTA identity
  mailHostname: env('MAIL_HOSTNAME', 'localhost'), // EHLO name; must match PTR record
  bounceDomain: env('BOUNCE_DOMAIN', env('MAIL_HOSTNAME', 'localhost')), // MX must point at this server
  serverIp: env('SERVER_IP', ''), // shown in SPF instructions

  // Delivery mode: direct MX delivery by default, or smart-host relay (useful when port 25 is blocked)
  relayUrl: env('SMTP_RELAY_URL', ''), // e.g. smtps://user:pass@email-smtp.us-east-1.amazonaws.com:465
  devRelay: env('MTA_DEV_RELAY', ''), // host:port - route everything to a test SMTP server
  workerConcurrency: Number(env('WORKER_CONCURRENCY', '10')),
  sendRatePerSecond: Number(env('SEND_RATE_PER_SECOND', '20')),
  maxAttempts: Number(env('MAX_ATTEMPTS', '8')),
  retryBaseDelayMs: Number(env('RETRY_BASE_DELAY_MS', String(5 * 60 * 1000))),

  // SMTP servers
  smtpSubmissionPort: Number(env('SMTP_SUBMISSION_PORT', '587')),
  smtpTlsPort: Number(env('SMTP_TLS_PORT', '465')),
  smtpInboundPort: Number(env('SMTP_INBOUND_PORT', '25')),
  smtpTlsCert: env('SMTP_TLS_CERT', ''),
  smtpTlsKey: env('SMTP_TLS_KEY', ''),
  allowInsecureSmtpAuth: bool('ALLOW_INSECURE_SMTP_AUTH', false),
  maxMessageBytes: Number(env('MAX_MESSAGE_BYTES', String(25 * 1024 * 1024))),
};
