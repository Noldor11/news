const fs = require('node:fs');
const path = require('node:path');
const { APP_BASE, COPY_NAME, buildAsyncWorkflow, validateAsyncWorkflow } = require('./gdn_async_workflow.cjs');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_ID = 'WaebNhCrxEVxhCfY';
const RECORD = path.join(ROOT, 'backups', 'gdn-async-rollout.json');
const secretDir = 'C:/Users/artur/Desktop/Proj/.env-local';
const base = fs.readFileSync(path.join(secretDir, 'N8N URL.txt'), 'utf8').trim().replace(/\/+$/, '');
const key = fs.readFileSync(path.join(secretDir, 'N8N API.txt'), 'utf8').trim();

async function api(method, route, body) {
  const response = await fetch(base + '/api/v1' + route, {
    method, headers: { 'X-N8N-API-KEY': key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`n8n ${method} ${route}: HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const mode = process.argv[2];
  if (mode === '--prepare') {
    if (fs.existsSync(RECORD)) throw new Error('A rollout record already exists; inspect it before creating another copy');
    const original = await api('GET', `/workflows/${SOURCE_ID}`);
    const created = await api('POST', '/workflows', buildAsyncWorkflow(original));
    const verified = await api('GET', `/workflows/${created.id}`);
    validateAsyncWorkflow(verified);
    if (verified.active) throw new Error('Copy must remain inactive during preparation');
    fs.mkdirSync(path.dirname(RECORD), { recursive: true });
    fs.writeFileSync(RECORD, JSON.stringify({ sourceId: SOURCE_ID, sourceVersionId: original.versionId, copyId: verified.id }, null, 2));
    console.log(JSON.stringify({ copyId: verified.id, name: verified.name, active: verified.active, nodes: verified.nodes.length }));
    return;
  }
  if (mode !== '--cutover' && mode !== '--verify') throw new Error('Use --prepare, --cutover or --verify');
  const record = JSON.parse(fs.readFileSync(RECORD, 'utf8'));
  if (record.sourceId !== SOURCE_ID) throw new Error('Unexpected source workflow');
  const original = await api('GET', `/workflows/${SOURCE_ID}`);
  const copy = await api('GET', `/workflows/${record.copyId}`);
  if (copy.name !== COPY_NAME) throw new Error('Unexpected copy name');
  validateAsyncWorkflow(copy);
  if (mode === '--cutover') {
    if (original.versionId !== record.sourceVersionId) throw new Error('Original changed since preparation');
    // n8n headers may be environment expressions; they cannot be evaluated by
    // this CLI. Use the application's local credential only for preflight.
    const dotenv = require(require.resolve('dotenv', { paths: [path.join(ROOT, 'news-digest-pipeline')] }));
    const env = dotenv.parse(fs.readFileSync(path.join(ROOT, 'news-digest-pipeline', '.env')));
    if (!env.API_SECRET_KEY) throw new Error('Local application credential is missing');
    const header = 'Bearer ' + env.API_SECRET_KEY;
    const healthResponse = await fetch(APP_BASE + '/api/health', { headers: { Authorization: header } });
    if (!healthResponse.ok) throw new Error('Production health check failed');
    const health = await healthResponse.json();
    if (['running', 'publishing'].includes(health.latestRun?.status)) throw new Error('Cannot cut over while a digest is running');
    if (!health.latestRun?.runId) throw new Error('Async application is not deployed');
    const status = await fetch(APP_BASE + '/api/automation/runs/' + health.latestRun.runId, { headers: { Authorization: header } });
    if (!status.ok || !(await status.json()).ok) throw new Error('Production status endpoint is not ready');
    await api('POST', `/workflows/${SOURCE_ID}/deactivate`);
    try {
      await api('POST', `/workflows/${copy.id}/activate`);
    } catch (error) {
      await api('POST', `/workflows/${SOURCE_ID}/activate`);
      throw error;
    }
  }
  const sourceState = await api('GET', `/workflows/${SOURCE_ID}`);
  const copyState = await api('GET', `/workflows/${copy.id}`);
  console.log(JSON.stringify({ originalId: SOURCE_ID, originalActive: sourceState.active,
    copyId: copyState.id, copyActive: copyState.active, name: copyState.name,
    versionId: copyState.versionId, activeVersionId: copyState.activeVersionId,
    schedules: copyState.nodes.filter((n) => n.type === 'n8n-nodes-base.scheduleTrigger').map((n) => ({ name: n.name, rule: n.parameters.rule })),
  }, null, 2));
  if (sourceState.active || !copyState.active) throw new Error('Cutover state is not confirmed');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
