import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
process.loadEnvFile('.env');
const pub = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) });
const DL = 1785172836;
for (;;) {
  const now = Number((await pub.getBlock()).timestamp);
  if (now > DL) { console.log('SUBMIT WINDOW CLOSED — ready to clear()'); break; }
  await new Promise(r => setTimeout(r, 120000));
}
