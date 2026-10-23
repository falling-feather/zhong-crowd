import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? 5217);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口应为 1024 至 65535 的整数');
const html = await readFile(resolve(root, 'output/众-离线试玩.html'));
const server = createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
  if (request.url === '/favicon.ico') { response.writeHead(204).end(); return; }
  if (request.url !== '/' && request.url !== '/index.html') { response.writeHead(404).end('Not found'); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length, 'Cache-Control': 'no-store' });
  response.end(request.method === 'HEAD' ? undefined : html);
});
server.on('error', error => { console.error(`试玩服务未能启动：${error.message}`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`众：本机发行版 http://127.0.0.1:${port}/`);
  console.log('服务固定提供启动时读取的单文件，重新构建后需重启。按 Ctrl+C 结束。');
});
