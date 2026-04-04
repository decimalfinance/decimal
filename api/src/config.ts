export const config = {
  host: process.env.HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? 3100),
  clickhouseUrl: process.env.CLICKHOUSE_URL ?? 'http://127.0.0.1:8123',
  clickhouseDatabase: process.env.CLICKHOUSE_DATABASE ?? 'usdc_ops',
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  controlPlaneServiceToken: process.env.CONTROL_PLANE_SERVICE_TOKEN ?? '',
};
