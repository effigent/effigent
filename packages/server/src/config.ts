export interface Config {
  port: number;
  databaseUrl: string;
  dataDir: string;
  adminToken: string;
  publicBaseUrl: string;
}

export function loadConfig(): Config {
  const adminToken = process.env.CCOPT_ADMIN_TOKEN;
  if (!adminToken) {
    throw new Error('CCOPT_ADMIN_TOKEN must be set (used to create tenants/API keys).');
  }
  return {
    port: Number(process.env.PORT ?? 8787),
    databaseUrl:
      process.env.DATABASE_URL ?? 'postgres://ccopt:ccopt@localhost:5433/ccopt',
    dataDir: process.env.CCOPT_DATA_DIR ?? './data',
    adminToken,
    publicBaseUrl: process.env.CCOPT_PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  };
}
