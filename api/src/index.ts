import { config } from './config.js';
import { prisma } from './prisma.js';
import { createApp } from './app.js';
import { USDC_MINT } from './solana.js';

async function main() {
  await prisma.$connect();
  const app = createApp();

  const server = app.listen(config.port, config.host, () => {
    console.log(`api listening on http://${config.host}:${config.port}`);
    console.log(`solana network = ${config.solanaNetwork}`);
    console.log(`solana rpc     = ${config.solanaRpcUrl}`);
    console.log(`usdc mint      = ${USDC_MINT.toBase58()}`);
  });

  const shutdown = async () => {
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
