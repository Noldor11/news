const { randomUUID } = require('node:crypto');

const APP_BASE = 'https://news-digest-app-production-9938.up.railway.app';
const COPY_NAME = 'News Digest Daily Auto - Async';
const START_NODES = ['Collect AI News -> Generate -> Publish', 'Manual Test: Generate -> Publish', 'Recover Missing Digest'];
const link = (node) => ({ node, type: 'main', index: 0 });

function buildAsyncWorkflow(original) {
  const body = structuredClone({
    name: COPY_NAME,
    nodes: original.nodes,
    connections: original.connections,
    settings: {
      timezone: 'Europe/Kiev', executionOrder: 'v1',
      ...(original.settings?.errorWorkflow ? { errorWorkflow: original.settings.errorWorkflow } : {}),
    },
  });
  const first = body.nodes.find((node) => node.name === START_NODES[0]);
  const authorization = first?.parameters?.headerParameters?.parameters?.find((h) => h.name.toLowerCase() === 'authorization');
  if (!authorization) throw new Error('GDN authorization header is missing');
  for (const name of START_NODES) {
    const node = body.nodes.find((item) => item.name === name);
    if (!node || body.connections[name]?.main?.some((branch) => branch.length)) {
      throw new Error(`Unexpected source structure at ${name}`);
    }
    node.parameters.options = { ...node.parameters.options, timeout: 30000 };
    const headers = node.parameters.headerParameters.parameters;
    const prefer = headers.find((h) => h.name.toLowerCase() === 'prefer');
    if (prefer) prefer.value = 'respond-async';
    else headers.push({ name: 'Prefer', value: 'respond-async' });
    node.retryOnFail = false;
    delete node.maxTries;
    delete node.waitBetweenTries;
    body.connections[name] = { main: [[link('Read Digest Status')]] };
  }
  const node = (name, type, typeVersion, position, parameters, extra = {}) => ({
    id: randomUUID(), name, type: `n8n-nodes-base.${type}`, typeVersion, position, parameters, ...extra,
  });
  const condition = (expression) => ({ conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{ id: randomUUID(), leftValue: expression, rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
    combinator: 'and',
  }, options: {} });
  body.nodes.push(
    node('Read Digest Status', 'httpRequest', 4.4, [520, 100], {
      method: 'GET',
      url: `=${APP_BASE}/api/automation/runs/{{ encodeURIComponent($json.runId) }}`,
      sendHeaders: true, headerParameters: { parameters: [authorization] },
      options: { timeout: 30000 },
    }, { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000 }),
    node('Digest Still Running', 'if', 2.2, [760, 100], condition('={{ $json.pending }}')),
    node('Wait For Digest', 'wait', 1.1, [760, -120], { resume: 'timeInterval', amount: 30, unit: 'seconds' }),
    node('Digest Published', 'if', 2.2, [1000, 180], condition("={{ $json.ok === true && $json.state === 'published' }}")),
    node('Digest Confirmed', 'noOp', 1, [1240, 100], {}),
    node('Digest Failed Or Overdue', 'stopAndError', 1, [1240, 320], {
      errorType: 'errorMessage',
      errorMessage: "={{ 'GDN run not confirmed: ' + $json.state + '; runId: ' + $json.runId + '; stage: ' + ($json.stage || 'unknown') }}",
    }),
  );
  body.connections['Read Digest Status'] = { main: [[link('Digest Still Running')]] };
  body.connections['Digest Still Running'] = { main: [[link('Wait For Digest')], [link('Digest Published')]] };
  body.connections['Wait For Digest'] = { main: [[link('Read Digest Status')]] };
  body.connections['Digest Published'] = { main: [[link('Digest Confirmed')], [link('Digest Failed Or Overdue')]] };
  validateAsyncWorkflow(body);
  return body;
}

function validateAsyncWorkflow(workflow) {
  const names = new Set(workflow.nodes.map((n) => n.name));
  if (names.size !== workflow.nodes.length) throw new Error('Duplicate node names');
  for (const [name, connection] of Object.entries(workflow.connections)) {
    if (!names.has(name)) throw new Error('Unknown connection origin');
    for (const branch of connection.main || []) {
      for (const edge of branch) if (!names.has(edge.node)) throw new Error('Unknown connection target');
    }
  }
  for (const name of START_NODES) {
    const node = workflow.nodes.find((n) => n.name === name);
    if (node?.retryOnFail || !node?.parameters.headerParameters.parameters.some((h) => h.name === 'Prefer' && h.value === 'respond-async')) {
      throw new Error('Unsafe start request');
    }
  }
  if (workflow.settings.timezone !== 'Europe/Kiev') throw new Error('Wrong timezone');
  return true;
}

module.exports = { APP_BASE, COPY_NAME, START_NODES, buildAsyncWorkflow, validateAsyncWorkflow };
