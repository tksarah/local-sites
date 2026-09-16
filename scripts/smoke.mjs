import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const base = process.env.LOCAL_SITES_URL;
if (!base || !base.startsWith('https://')) throw new Error('Set LOCAL_SITES_URL to your HTTPS server URL');
const token = process.env.LOCAL_SITES_TOKEN || (await readFile(process.env.LOCAL_SITES_TOKEN_FILE, 'utf8')).trim();
const client = new Client({ name: 'local-sites-smoke', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
try {
  console.log('tools:', (await client.listTools()).tools.map(t => t.name).join(', '));
  const [uploadId, appId = 'notes'] = process.argv.slice(2);
  if (uploadId) {
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) throw new Error(result.content[0].text);
      return JSON.parse(result.content[0].text);
    };
    const job = await call('deploy_app', { uploadId, appId });
    console.log(job);
    for (;;) {
      const status = await call('get_deployment_status', { deploymentId: job.deploymentId });
      if (status.status === 'failed') throw new Error(status.error);
      if (status.status === 'succeeded') { console.log('Ready:', status.url); break; }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  } else console.log((await client.callTool({ name: 'list_apps', arguments: {} })).content);
} finally { await client.close(); }
