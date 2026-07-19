const NAMED_SECRET_PATTERN = /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)=([^\s&]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/gi;
const TELEGRAM_BOT_PATTERN = /\b\d{8,12}:[A-Za-z0-9_-]{20,}/g;
const PROVIDER_KEY_PATTERN = /\b(?:sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{16,}/g;

function replaceAllLiteral(text, value) {
  if (!value || String(value).length < 8) return text;
  return text.split(String(value)).join('[REDACTED]');
}

export function redactSecrets(value, explicitSecrets = []) {
  let text = String(value ?? '');
  for (const secret of explicitSecrets) text = replaceAllLiteral(text, secret);
  return text
    .replace(NAMED_SECRET_PATTERN, '$1=[REDACTED]')
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(TELEGRAM_BOT_PATTERN, '[TELEGRAM_TOKEN_REDACTED]')
    .replace(PROVIDER_KEY_PATTERN, '[API_KEY_REDACTED]');
}

export function safeErrorMessage(error, fallback = 'Internal operation failed', explicitSecrets = []) {
  const message = error?.message || fallback;
  return redactSecrets(message, explicitSecrets).slice(0, 500);
}