const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = 'C:/Users/artur/Desktop/Proj';
const WORKFLOW_ID = 'WaebNhCrxEVxhCfY';
const ERROR_WORKFLOW_NAME = 'GDN Daily Error Alerts';
const APP_BASE_URL = 'https://news-digest-app-production-9938.up.railway.app';

function readText(file) {
  return fs.readFileSync(file, 'utf8').trim();
}

function rid() {
  return crypto.randomUUID();
}

async function n8nRequest(baseUrl, apiKey, method, apiPath, body) {
  const response = await fetch(baseUrl + apiPath, {
    method,
    headers: {
      'X-N8N-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(method + ' ' + apiPath + ' failed: HTTP ' + response.status + ' ' + text.slice(0, 500));
  }
  return text ? JSON.parse(text) : null;
}

function workflowBody(workflow) {
  return {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: workflow.settings || {},
    staticData: workflow.staticData || {},
    pinData: workflow.pinData || {},
  };
}

function headerValue(node, name) {
  const headers = node?.parameters?.headerParameters?.parameters || [];
  return headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value || '';
}

function httpNode(name, url, secret, authorization, position) {
  return {
    id: rid(),
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.4,
    position,
    parameters: {
      method: 'POST',
      url,
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Authorization', value: authorization },
          { name: 'X-N8N-Daily-Secret', value: secret },
        ],
      },
      options: { timeout: 900000 },
    },
    retryOnFail: false,
  };
}

async function ensureErrorWorkflow(baseUrl, apiKey, secret, authorization) {
  const list = await n8nRequest(baseUrl, apiKey, 'GET', '/api/v1/workflows?limit=100');
  let workflow = (list.data || []).find((item) => item.name === ERROR_WORKFLOW_NAME);

  const errorTrigger = {
    id: rid(),
    name: 'Workflow Error Trigger',
    type: 'n8n-nodes-base.errorTrigger',
    typeVersion: 1,
    position: [0, 0],
    parameters: {},
  };
  const alertNode = httpNode(
    'Send GDN Error Alert',
    APP_BASE_URL + '/api/automation/alert',
    secret,
    authorization,
    [280, 0],
  );
  const body = {
    name: ERROR_WORKFLOW_NAME,
    nodes: [errorTrigger, alertNode],
    connections: {
      'Workflow Error Trigger': {
        main: [[{ node: 'Send GDN Error Alert', type: 'main', index: 0 }]],
      },
    },
    settings: { executionOrder: 'v1', timezone: 'Europe/Kiev' },
  };

  if (workflow) {
    workflow = await n8nRequest(baseUrl, apiKey, 'PUT', '/api/v1/workflows/' + workflow.id, body);
  } else {
    workflow = await n8nRequest(baseUrl, apiKey, 'POST', '/api/v1/workflows', body);
  }
  await n8nRequest(baseUrl, apiKey, 'POST', '/api/v1/workflows/' + workflow.id + '/activate');
  return workflow.id;
}

async function main() {
  const baseUrl = readText(path.join(ROOT, '.env-local', 'N8N URL.txt')).replace(new RegExp('/+$'), '');
  const apiKey = readText(path.join(ROOT, '.env-local', 'N8N API.txt'));
  const workflow = await n8nRequest(baseUrl, apiKey, 'GET', '/api/v1/workflows/' + WORKFLOW_ID);
  const mainNode = workflow.nodes.find((node) => node.name === 'Collect AI News -> Generate -> Publish');
  if (!mainNode) throw new Error('Main HTTP node not found');

  const secret = headerValue(mainNode, 'X-N8N-Daily-Secret');
  const authorization = headerValue(mainNode, 'Authorization');
  if (!secret) throw new Error('Daily secret header not found');
  if (!authorization) throw new Error('Authorization header not found');

  const errorWorkflowId = await ensureErrorWorkflow(baseUrl, apiKey, secret, authorization);

  mainNode.retryOnFail = false;
  delete mainNode.maxTries;
  delete mainNode.waitBetweenTries;

  const manualNode = workflow.nodes.find((node) => node.name === 'Manual Test: Generate -> Publish');
  if (manualNode) {
    manualNode.retryOnFail = false;
    delete manualNode.maxTries;
    delete manualNode.waitBetweenTries;
  }

  const watchdogTrigger = workflow.nodes.find((node) => node.name === 'Daily Watchdog 6:20PM'
    || node.name === 'Daily Watchdog 6:50PM');
  if (!watchdogTrigger) throw new Error('Watchdog trigger not found');
  watchdogTrigger.name = 'Daily Watchdog 6:50PM';
  watchdogTrigger.parameters = {
    rule: { interval: [{ triggerAtHour: 18, triggerAtMinute: 50 }] },
  };

  if (workflow.connections['Daily Watchdog 6:20PM']) {
    workflow.connections['Daily Watchdog 6:50PM'] = workflow.connections['Daily Watchdog 6:20PM'];
    delete workflow.connections['Daily Watchdog 6:20PM'];
  }

  const recoveryTriggerName = 'Daily Recovery 6:35PM';
  const recoveryNodeName = 'Recover Missing Digest';
  let recoveryTrigger = workflow.nodes.find((node) => node.name === recoveryTriggerName);
  if (!recoveryTrigger) {
    recoveryTrigger = {
      id: rid(),
      name: recoveryTriggerName,
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 360],
      parameters: {
        rule: { interval: [{ triggerAtHour: 18, triggerAtMinute: 35 }] },
      },
    };
    workflow.nodes.push(recoveryTrigger);
  }

  let recoveryNode = workflow.nodes.find((node) => node.name === recoveryNodeName);
  if (!recoveryNode) {
    recoveryNode = httpNode(
      recoveryNodeName,
      APP_BASE_URL + '/api/automation/daily-recovery',
      secret,
      authorization,
      [300, 360],
    );
    workflow.nodes.push(recoveryNode);
  } else {
    recoveryNode.parameters.url = APP_BASE_URL + '/api/automation/daily-recovery';
    recoveryNode.retryOnFail = false;
    delete recoveryNode.maxTries;
    delete recoveryNode.waitBetweenTries;
  }

  workflow.connections[recoveryTriggerName] = {
    main: [[{ node: recoveryNodeName, type: 'main', index: 0 }]],
  };
  workflow.settings = {
    ...(workflow.settings || {}),
    timezone: 'Europe/Kiev',
    executionOrder: 'v1',
    errorWorkflow: errorWorkflowId,
  };

  await n8nRequest(baseUrl, apiKey, 'PUT', '/api/v1/workflows/' + WORKFLOW_ID, workflowBody(workflow));
  await n8nRequest(baseUrl, apiKey, 'POST', '/api/v1/workflows/' + WORKFLOW_ID + '/activate');

  const verified = await n8nRequest(baseUrl, apiKey, 'GET', '/api/v1/workflows/' + WORKFLOW_ID);
  console.log(JSON.stringify({
    id: verified.id,
    active: verified.active,
    errorWorkflow: verified.settings?.errorWorkflow || null,
    triggers: verified.nodes.filter((node) => node.type === 'n8n-nodes-base.scheduleTrigger').map((node) => node.name),
    mainRetryOnFail: Boolean(verified.nodes.find((node) => node.name === mainNode.name)?.retryOnFail),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
