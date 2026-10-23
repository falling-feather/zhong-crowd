import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

// Package the production build; the simulator and UI have no alternate implementation.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, process.argv[2] ?? 'dist');
if (!dist.startsWith(`${root}\\`) && !dist.startsWith(`${root}/`)) throw new Error('构建目录必须属于当前工作区');
let html = await readFile(resolve(dist, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)];
const styles = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)];
if (scripts.length !== 1 || styles.length !== 1) throw new Error('生产入口结构改变，请先检查离线封装规则');
const localAsset = path => {
  const absolute = resolve(dist, path.replace(/^\/?(?:\.\/)?/, ''));
  if (!absolute.startsWith(`${dist}\\`) && !absolute.startsWith(`${dist}/`)) throw new Error('构建引用超出目录');
  return absolute;
};
const javascript = await readFile(localAsset(scripts[0][1]), 'utf8');
const stylesheet = await readFile(localAsset(styles[0][0].match(/href="([^"]+)"/)[1]), 'utf8');
// URL.createObjectURL contains the inlined worker. A separate worker would fail on file://.
const jsFiles = (await readdir(resolve(dist, 'assets'))).filter(name => name.endsWith('.js'));
if (jsFiles.length !== 1) throw new Error('离线包必须只有已内联工作线程的主入口');
html = html.replace(scripts[0][0], `<script type="module">${javascript.replace(/<\/script/gi, '<\\/script')}</script>`)
  .replace(styles[0][0], `<style>${stylesheet.replace(/<\/style/gi, '<\\/style')}</style>`)
  .replace(/<link\b[^>]*rel="modulepreload"[^>]*>/g, '');
const license = await readFile(resolve(root, 'licenses/RVO2-Apache-2.0.txt'), 'utf8');
const attribution = 'RVO2 Library. Copyright 2008 University of North Carolina at Chapel Hill.\nAdapted from version 2.0.2, commit c96a6ec8328492bae0721e59774026a119a60b4a.\nChanges: TypeScript implementation, stable small-crowd neighbors, wall-union contours and scene bounds.\nThe project adds contact-velocity projection, perception, gate rules, levels and interface.\n\n';
html = html.replace('</body>', `<script type="text/plain" id="third-party-license">${attribution}${license.replace(/<\/script/gi, '<\\/script')}</script>\n</body>`);
const output = resolve(root, 'output');
await mkdir(output, { recursive: true });
const target = resolve(output, '众-离线试玩.html');
await writeFile(target, html, 'utf8');
console.log(`离线试玩已生成：${target}（${(Buffer.byteLength(html) / 1024).toFixed(1)} KiB）`);
