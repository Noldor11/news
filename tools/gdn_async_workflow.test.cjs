const { test } = require('node:test');
const assert = require('node:assert/strict');
const { START_NODES, buildAsyncWorkflow, validateAsyncWorkflow } = require('./gdn_async_workflow.cjs');

test('creates a separate polling workflow without altering the original or retrying publication', () => {
  const original = {
    name: 'News Digest Daily Auto', settings: { timezone: 'Europe/Kiev', errorWorkflow: 'errors' },
    nodes: START_NODES.map((name) => ({ name, parameters: { headerParameters: { parameters: [{ name: 'Authorization', value: 'test-only' }] } } })),
    connections: {},
  };
  const before = JSON.stringify(original);
  const copy = buildAsyncWorkflow(original);
  assert.equal(JSON.stringify(original), before);
  assert.notEqual(copy.name, original.name);
  assert.equal(copy.settings.errorWorkflow, 'errors');
  assert.equal(validateAsyncWorkflow(copy), true);
  assert.equal(copy.nodes.find((n) => n.name === 'Read Digest Status').parameters.method, 'GET');
  assert.equal(copy.nodes.find((n) => n.name === 'Wait For Digest').parameters.amount, 30);
  assert.equal(copy.connections['Digest Still Running'].main[0][0].node, 'Wait For Digest');
  assert.equal(copy.connections['Digest Published'].main[1][0].node, 'Digest Failed Or Overdue');
  for (const name of START_NODES) assert.equal(copy.connections[name].main[0][0].node, 'Read Digest Status');
});
