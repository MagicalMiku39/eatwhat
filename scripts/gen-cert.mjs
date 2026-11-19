// 生成局域网 HTTPS 证书：本地私有 CA + 包含本机所有局域网 IP 的服务器证书。
// 换了网络（IP 变了）就重新跑一次：CA 会复用，手机上已安装的 CA 依然有效。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'certs');
fs.mkdirSync(dir, { recursive: true });
const p = (f) => path.join(dir, f);

function findOpenssl() {
  const candidates = [
    'openssl',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  ];
  for (const c of candidates) {
    if (spawnSync(c, ['version']).status === 0) return c;
  }
  console.error('找不到 openssl。请安装 Git for Windows 或 OpenSSL 后重试。');
  process.exit(1);
}
const OPENSSL = findOpenssl();

function run(args) {
  const r = spawnSync(OPENSSL, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`openssl ${args[0]} 失败:\n${r.stderr}`);
    process.exit(1);
  }
}

const ips = [
  ...new Set(
    Object.values(os.networkInterfaces())
      .flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
      .map((a) => a.address)
  ),
];

// 1. CA（已存在则复用）
if (!fs.existsSync(p('ca.crt')) || !fs.existsSync(p('ca.key'))) {
  run([
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
    '-keyout', p('ca.key'), '-out', p('ca.crt'),
    '-subj', '/CN=EatWhat Local CA',
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  console.log('已生成本地 CA: certs/ca.crt');
}

// 2. 服务器证书（每次重新签，带上当前所有 IP）
const san = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)].join(',');
fs.writeFileSync(
  p('server.ext'),
  [
    `subjectAltName=${san}`,
    'basicConstraints=CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
  ].join('\n')
);
run(['req', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', p('server.key'), '-out', p('server.csr'), '-subj', '/CN=EatWhat']);
// iOS 要求服务器证书有效期不超过 825 天
run([
  'x509', '-req', '-sha256', '-days', '825', '-in', p('server.csr'),
  '-CA', p('ca.crt'), '-CAkey', p('ca.key'), '-CAcreateserial',
  '-out', p('server.crt'), '-extfile', p('server.ext'),
]);
fs.rmSync(p('server.csr'), { force: true });

console.log('已生成服务器证书: certs/server.crt');
console.log('包含地址:', san.replaceAll('DNS:', '').replaceAll('IP:', ''));
