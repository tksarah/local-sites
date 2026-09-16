import path from 'node:path';
import { isIP } from 'node:net';
export function configuration(env = process.env) {
  const ip = env.SITE_IP || '127.0.0.1';
  if (isIP(ip) !== 4) throw new Error('SITE_IP must be an IPv4 address');
  const appDomain = (env.APP_DOMAIN || '').trim().toLowerCase();
  if (appDomain && (appDomain.length > 212 || !appDomain.includes('.') || isIP(appDomain) ||
    !appDomain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) {
    throw new Error('APP_DOMAIN must be a DNS domain without a scheme, port, path or trailing dot');
  }
  if (appDomain && !env.GATEWAY_CONTAINER) throw new Error('APP_DOMAIN requires GATEWAY_CONTAINER');
  const portStart = Number(env.PORT_START || 18000), portEnd = Number(env.PORT_END || 18999);
  if (!Number.isInteger(portStart) || !Number.isInteger(portEnd) || portStart < 1024 || portEnd > 65535 || portStart > portEnd) throw new Error('Invalid app port range');
  const lanCidr = env.LAN_CIDR || `${ip}/32`;
  const [network, prefix, extra] = lanCidr.split('/');
  if (extra !== undefined || isIP(network) !== 4 || !/^(?:[0-9]|[12][0-9]|3[0-2])$/.test(prefix || '')) throw new Error('Invalid LAN_CIDR');
  const asNumber = (value: string) => value.split('.').reduce((n, octet) => (n * 256 + Number(octet)) >>> 0, 0);
  const mask = Number(prefix) === 0 ? 0 : (0xffffffff << (32 - Number(prefix))) >>> 0;
  if (((asNumber(network) & mask) >>> 0) !== asNumber(network) || ((asNumber(ip) & mask) >>> 0) !== asNumber(network)) throw new Error('SITE_IP must belong to canonical LAN_CIDR');
  const root = path.resolve(env.DATA_DIR || '.local-sites');
  return { ip, lanCidr, appDomain, portStart, portEnd, root, tokenFile: env.TOKEN_FILE || path.join(root, 'tokens.json'),
    gatewayContainer: env.GATEWAY_CONTAINER || '',
    origin: `https://${ip}`, portalOrigin: appDomain ? `https://portal.${appDomain}` : `https://${ip}`,
    bind: env.BIND || '127.0.0.1', port: Number(env.PORT || 3100) };
}
export type Config = ReturnType<typeof configuration>;
