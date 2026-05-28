import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { createRequire } from 'module';
import yaml from 'js-yaml';

const ROOT = resolve(dirname(new URL('../package.json', import.meta.url).pathname));
const DEFAULT_AUDIT_REL = 'data/logs/notifications.ndjson';
const DEFAULT_PROFILE = join(ROOT, 'config', 'profile.yml');
const SEVERITY = { info: 0, warn: 1, error: 2 };

// Test hooks: CAREER_OPS_NOTIFY_AUDIT can override the audit file path, and
// loadNotificationConfig(profilePath) accepts a fixture path for config parsing.
// CAREER_OPS_NOTIFY_PROFILE is intentionally internal so integration tests can
// run notify() against a fixture without touching user-layer config/profile.yml.

export const AUDIT_LOG_PATH = resolveAuditPath({ channels: [] });

function defaultConfig() {
  return {
    enabled: true,
    channels: [{ type: 'file', path: DEFAULT_AUDIT_REL, min_severity: 'info' }],
  };
}

function resolveRootPath(value) {
  if (!value) return join(ROOT, DEFAULT_AUDIT_REL);
  return resolve(ROOT, value);
}

function resolveAuditPath(config = {}) {
  if (process.env.CAREER_OPS_NOTIFY_AUDIT) {
    return resolve(ROOT, process.env.CAREER_OPS_NOTIFY_AUDIT);
  }
  const fileChannel = (config.channels || []).find((channel) => channel?.type === 'file' && channel.path);
  return resolveRootPath(fileChannel?.path || DEFAULT_AUDIT_REL);
}

function normalizeSeverity(value) {
  return Object.hasOwn(SEVERITY, value) ? value : 'info';
}

function shouldDeliver(channel, severity) {
  const min = normalizeSeverity(channel?.min_severity || 'info');
  return SEVERITY[severity] >= SEVERITY[min];
}

function truncate(value, max) {
  const s = String(value ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 12))}…(truncated)`;
}

function safeReason(err) {
  return String(err?.message || err || 'notification failed').split('\n')[0].slice(0, 160);
}

function redact(s) {
  return String(s ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, 'sk-[REDACTED]')
    .replace(/\bghp_[A-Za-z0-9_]{10,}\b/g, 'ghp_[REDACTED]')
    .replace(/\b(\w*(?:api[_-]?key|token|password)\w*\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s/]+\.ngrok-free\.app\/\S+/gi, (match) => {
      try {
        const url = new URL(match);
        return `${url.origin}/[REDACTED]`;
      } catch {
        return '[REDACTED_NGROK_URL]';
      }
    })
    .replace(/\b([A-Z0-9._%+-])([A-Z0-9._%+-]*)(@[A-Z0-9.-]+\.[A-Z]{2,})\b/gi, (_m, first, _rest, domain) => `${first}***${domain}`);
}

export function loadNotificationConfig(profilePath = process.env.CAREER_OPS_NOTIFY_PROFILE || DEFAULT_PROFILE) {
  if (!existsSync(profilePath)) return defaultConfig();
  try {
    const doc = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
    if (!Object.hasOwn(doc, 'notifications')) return defaultConfig();
    const notifications = doc.notifications || {};
    const channels = Array.isArray(notifications.channels) ? notifications.channels.filter(Boolean) : [];
    return {
      enabled: notifications.enabled !== false,
      channels: channels.length > 0 ? channels : defaultConfig().channels,
    };
  } catch (err) {
    console.warn(`career-ops notify: could not read notification config: ${safeReason(err)}`);
    return defaultConfig();
  }
}

async function postWebhook(channel, severity, title, body) {
  const envName = channel.webhook_env;
  const url = envName ? process.env[envName] : '';
  if (!envName || !url) {
    return { type: channel.type, ok: false, reason: `missing ${envName || 'webhook env'}` };
  }
  const prefix = channel.type === 'discord'
    ? `**${severity.toUpperCase()}** — ${title}\n${body}`
    : `*${severity.toUpperCase()}* — ${title}\n${body}`;
  const payload = channel.type === 'discord' ? { content: prefix } : { text: prefix };
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    return { type: channel.type, ok: false, reason: `HTTP ${response.status}` };
  }
  return { type: channel.type, ok: true };
}

async function sendDesktop(channel, title, body) {
  try {
    const require = createRequire(import.meta.url);
    const notifier = require('node-notifier');
    await new Promise((resolveP) => notifier.notify({ title, message: body }, resolveP));
    return { type: channel.type, ok: true };
  } catch {
    return { type: channel.type, ok: false, reason: 'desktop channel not available' };
  }
}

async function deliver(channel, event) {
  const type = channel?.type || 'unknown';
  if (!shouldDeliver(channel, event.severity)) {
    return { type, skipped_by_severity: true };
  }
  if (type === 'file') return { type: 'file', ok: true };
  if (type === 'slack' || type === 'discord') return postWebhook(channel, event.severity, event.title, redact(event.body));
  if (type === 'desktop') return sendDesktop(channel, event.title, redact(event.body));
  if (type === 'email') return { type: 'email', ok: false, reason: 'email channel not implemented' };
  return { type, ok: false, reason: 'unknown channel type' };
}

function configuredOutboundChannels(config) {
  return (config.channels || []).filter((channel) => channel?.type && channel.type !== 'file');
}

export async function notify({ kind, title, body, severity = 'info', meta = {} }) {
  if (!kind || !title || body == null) {
    throw new Error('notify requires kind, title, and body');
  }

  const config = loadNotificationConfig();
  const event = {
    kind: String(kind),
    title: truncate(title, 120),
    body: truncate(body, 2048),
    severity: normalizeSeverity(severity),
    meta: meta && typeof meta === 'object' ? meta : {},
  };
  const channels = [];
  let ok = true;

  if (config.enabled === false) {
    for (const channel of configuredOutboundChannels(config)) {
      channels.push({ type: channel.type, skipped: true });
    }
  } else {
    for (const channel of configuredOutboundChannels(config)) {
      try {
        const result = await deliver(channel, event);
        channels.push(result);
        if (result.ok === false) {
          console.warn(`career-ops notify: ${channel.type} failed: ${result.reason || 'unknown error'}`);
          if (channel.required) ok = false;
        }
      } catch (err) {
        const result = { type: channel.type || 'unknown', ok: false, reason: safeReason(err) };
        channels.push(result);
        console.warn(`career-ops notify: ${result.type} failed: ${result.reason}`);
        if (channel.required) ok = false;
      }
    }
  }

  const auditPath = resolveAuditPath(config);
  const fileResult = { type: 'file', ok: true };
  const line = {
    ts: new Date().toISOString(),
    runId: process.env.CAREER_OPS_RUN_ID || null,
    kind: event.kind,
    severity: event.severity,
    title: event.title,
    body: event.body,
    meta: event.meta,
    channels: [fileResult, ...channels],
  };
  if (config.enabled === false) line.skipped = true;

  try {
    mkdirSync(dirname(auditPath), { recursive: true });
    appendFileSync(auditPath, `${JSON.stringify(line)}\n`, 'utf-8');
  } catch (err) {
    fileResult.ok = false;
    fileResult.reason = safeReason(err);
    ok = false;
    console.warn(`career-ops notify: file audit failed: ${fileResult.reason}`);
  }

  return { ok, channels: line.channels };
}
