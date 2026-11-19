const env = process.env;

export const config = {
  port: Number(env.PORT) || 3000,
  // certs/ 下有证书时同时启动 HTTPS（手机定位必须 HTTPS）；设为 0 关闭
  httpsPort: env.HTTPS_PORT === '0' ? 0 : Number(env.HTTPS_PORT) || 3443,
  amapKey: (env.AMAP_KEY || '').trim(),
  limitMode: ['ip', 'device', 'either'].includes(env.LIMIT_MODE) ? env.LIMIT_MODE : 'ip',
  freePerDay: Number(env.FREE_PER_DAY) || 1,
  // manual: 用户扫管理员收款码转账，管理员后台确认后加次数；mock: 开发用的模拟支付
  payMode: ['manual', 'mock'].includes(env.PAY_MODE) ? env.PAY_MODE : 'manual',
  // 管理员收款码图片路径（data/ 已在 .gitignore 中，不会被提交）
  payQrFile: env.PAY_QR_FILE || 'data/pay-qr.png',
  // 管理后台口令；留空则后台关闭
  adminToken: (env.ADMIN_TOKEN || '').trim(),
  orderAmount: env.ORDER_AMOUNT || '1.00',
  trustProxy: env.TRUST_PROXY === '1',
};
