// llm-step · 敏感键判定(铁律 6/N5: Key/secret 永不进配置面/指纹面/文件面)。
// 归一化(去非字母数字 + camelCase 拆段 + 小写)后精确命中的禁止键, 或任一拆段命中
// 即拒绝。覆盖 clientSecret/privateKey/access_token/bearerToken/x-api-key 等常见形态。
// 与 imports/run-model.ts 的 SECRET_EXACT/SECRET_SEGMENTS 同口径(各自内联, 不跨包引用,
// 保持 llm-step 低层零依赖)。仅用于「拒绝」判定, 不记录任何键值(错误消息只报键名)。

const SECRET_EXACT = new Set<string>([
  'apikey', 'apisecret', 'password', 'passwd', 'secret', 'clientsecret', 'privatekey',
  'token', 'accesstoken', 'refreshtoken', 'bearer', 'authorization', 'auth', 'cookie',
  'cookies', 'jwt', 'credential', 'credentials', 'secretkey', 'appsecret', 'consumerkey',
  'consumersecret', 'signingkey', 'signingsecret', 'presharedkey', 'authkey', 'accesskey',
]);

const SECRET_SEGMENTS = new Set<string>([
  'key', 'token', 'bearer', 'authorization', 'password', 'passwd', 'secret',
  'credential', 'auth', 'cookie', 'jwt', 'signing', 'preshared',
]);

function normalizeSecretKey(key: string): { exact: string; segments: string[] } {
  const spaced = key
    .replace(/[^A-Za-z0-9]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  const segments = spaced.split(/\s+/).filter((s) => s.length > 0);
  return { exact: segments.join(''), segments };
}

/** 键名是否为禁止持久化/配置的敏感键(仅键名判定, 不触碰值)。 */
export function isDeniedSecretKey(key: string): boolean {
  const { exact, segments } = normalizeSecretKey(key);
  if (SECRET_EXACT.has(exact)) return true;
  for (const segment of segments) {
    if (SECRET_SEGMENTS.has(segment)) return true;
  }
  return false;
}
