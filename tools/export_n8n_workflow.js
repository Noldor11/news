const fs = require('node:fs');
const path = require('node:path');

const ROOT = 'C:/Users/artur/Desktop/Proj';
const WORKFLOW_ID = process.argv[2] || 'WaebNhCrxEVxhCfY';
const OUTPUT = process.argv[3];

if (!OUTPUT) {
  throw new Error('Usage: node export_n8n_workflow.js <workflow-id> <output-file>');
}

function readText(file) {
  return fs.readFileSync(file, 'utf8').trim();
}

async function main() {
  const baseUrl = readText(path.join(ROOT, '.env-local', 'N8N URL.txt')).replace(/\/+$/, '');
  const apiKey = readText(path.join(ROOT, '.env-local', 'N8N API.txt'));
  const response = await fetch(`${baseUrl}/api/v1/workflows/${WORKFLOW_ID}`, {
    headers: { 'X-N8N-API-KEY': apiKey },
  });
  if (!response.ok) {
    throw new Error(`Workflow export failed: HTTP ${response.status} ${await response.text()}`);
  }

  const workflow = await response.json();
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ id: workflow.id, name: workflow.name, active: workflow.active, output: OUTPUT }));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
