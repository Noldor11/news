const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { APP_BASE } = require('./gdn_async_workflow.cjs');

const ROOT = path.resolve(__dirname, '..');
const secretDir = 'C:/Users/artur/Desktop/Proj/.env-local';
const base = fs.readFileSync(path.join(secretDir, 'N8N URL.txt'), 'utf8').trim().replace(/\/+$/, '');
const key = fs.readFileSync(path.join(secretDir, 'N8N API.txt'), 'utf8').trim();
const record = JSON.parse(fs.readFileSync(path.join(ROOT, 'backups/gdn-async-rollout.json'), 'utf8'));

async function api(method, route, body) {
  const response = await fetch(base + '/api/v1' + route, {
    method, headers: { 'X-N8N-API-KEY': key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`n8n ${method} ${route}: HTTP ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function main() {
  const dotenv = require(require.resolve('dotenv', { paths: [path.join(ROOT, 'news-digest-pipeline')] }));
  const env = dotenv.parse(fs.readFileSync(path.join(ROOT, 'news-digest-pipeline/.env')));
  const healthResponse = await fetch(APP_BASE + '/api/health', { headers: { Authorization: 'Bearer ' + env.API_SECRET_KEY } });
  if (!healthResponse.ok) throw new Error('Health preflight failed');
  const health = await healthResponse.json();
  if (health.latestRun?.status !== 'published' || !health.latestRun.runId) throw new Error('A confirmed run is required');
  const live = await api('GET', `/workflows/${record.copyId}`);
  const names = new Set(['Read Digest Status', 'Digest Still Running', 'Wait For Digest', 'Digest Published', 'Digest Confirmed', 'Digest Failed Or Overdue']);
  const nodes = structuredClone(live.nodes.filter((node) => names.has(node.name)));
  if (nodes.length !== 6 || nodes.find((node) => node.name === 'Read Digest Status').parameters.method !== 'GET') {
    throw new Error('Unexpected polling graph');
  }
  const connections = Object.fromEntries(Object.entries(live.connections).filter(([name]) => names.has(name)));
  const webhookPath = 'gdn-poll-check-' + randomUUID();
  const guard = randomUUID();
  nodes.push({ id: randomUUID(), name: 'Verification Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2,
    position: [0, 0], webhookId: randomUUID(), parameters: { httpMethod: 'POST', path: webhookPath, responseMode: 'lastNode', options: {} } });
  nodes.push({ id: randomUUID(), name: 'Seed Pending Check', type: 'n8n-nodes-base.code', typeVersion: 2,
    position: [240, 0], parameters: { jsCode:
      `if ($input.first().json.headers['x-gdn-check-secret'] !== ${JSON.stringify(guard)}) throw new Error('Unauthorized verification');\n`
      + `return [{json: {runId: ${JSON.stringify(health.latestRun.runId)}, pending: true}}];` } });
  const edge = (node) => ({ main: [[{ node, type: 'main', index: 0 }]] });
  connections['Verification Webhook'] = edge('Seed Pending Check');
  connections['Seed Pending Check'] = edge('Digest Still Running');
  let testId;
  let report;
  try {
    const created = await api('POST', '/workflows', { name: 'GDN polling verification - temporary', nodes, connections,
      settings: { timezone: 'Europe/Kiev', executionOrder: 'v1', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all' } });
    testId = created.id;
    await api('POST', `/workflows/${testId}/activate`);
    const response = await fetch(base + '/webhook/' + webhookPath, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GDN-Check-Secret': guard }, body: '{}',
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error('Polling verification HTTP ' + response.status);
    const data = await response.json();
    const result = Array.isArray(data) ? data[0] : data;
    if (result.state !== 'published' || result.runId !== health.latestRun.runId) throw new Error('Polling result not confirmed');
    const list = await api('GET', `/executions?workflowId=${testId}&limit=1`);
    const execution = await api('GET', `/executions/${list.data[0].id}?includeData=true`);
    const runs = execution.data?.resultData?.runData || {};
    if (execution.status !== 'success' || !runs['Wait For Digest'] || !runs['Digest Confirmed']) {
      throw new Error('Pending/wait/confirmed branches were not executed');
    }
    report = { executionId: execution.id, status: execution.status, confirmedRunId: result.runId,
      executedNodes: Object.keys(runs), durationMs: Date.parse(execution.stoppedAt) - Date.parse(execution.startedAt),
      generatedArticles: 0, telegramSends: 0 };
  } finally {
    if (testId) {
      await api('POST', `/workflows/${testId}/deactivate`);
      await api('DELETE', `/workflows/${testId}`);
    }
  }
  console.log(JSON.stringify({ ...report, temporaryWorkflowDeleted: true }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
