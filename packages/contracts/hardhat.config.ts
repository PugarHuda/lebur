import { defineConfig } from 'hardhat/config';
import hardhatToolboxViemPlugin from '@nomicfoundation/hardhat-toolbox-viem';
import noxPlugin from '@iexec-nox/nox-hardhat-plugin';

// Node built-in, no dotenv dependency. A missing .env is fine — only the sepolia
// network reads these, the ephemeral-stack `default` network needs no key.
try { process.loadEnvFile(new URL('.env', import.meta.url)); } catch {}

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin, noxPlugin],
  // Optimizer ON with runs=1: every contract here is deployed once and called a
  // handful of times, and the dominant runtime cost is Nox precompile ops, which the
  // optimizer cannot touch. Deploy size is therefore the only lever, and runs=1 is
  // what minimises it. Unoptimized, the four deployments alone were ~19M gas — more
  // than the whole Sepolia budget. No viaIR: same pipeline as the validated build.
  solidity: {
    version: '0.8.35',
    settings: { optimizer: { enabled: true, runs: 1 } },
  },
  networks: {
    // `hardhat test` boots the whole Nox offchain stack (KMS, gateway, ingestor,
    // NATS, MinIO, Runner) in Docker and etches NoxCompute via hardhat_setCode.
    // Docker daemon must be up or the plugin fails at connect().
    default: {
      type: 'edr-simulated',
      chainType: 'op', // required by the Nox plugin
      allowUnlimitedContractSize: true,
    },
    sepolia: {
      type: 'http',
      chainType: 'op',
      url: process.env.SEPOLIA_RPC_URL ?? 'https://sepolia.drpc.org',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      // Sepolia base fee sits well under 1 gwei and Hardhat's defaults overpay ~4x.
      // A clear() at T=4/N=3 is ~200 encrypted ops, so the multiplier matters.
      // Raise these if transactions stop landing.
      // @ts-expect-error Hardhat 3 does not declare the EIP-1559 overrides on
      // HttpNetworkUserConfig yet, but the runtime honours them. If this line ever
      // reports "unused @ts-expect-error", the typing was fixed and it can go.
      maxPriorityFeePerGas: 1_000_000_000n, // 1 gwei
      maxFeePerGas: 3_000_000_000n,         // 3 gwei ceiling
      // live Nox on Ethereum Sepolia — verified 2026-07-22
      nox: {
        noxComputeAddress: '0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF',
        handleGatewayUrl: 'https://gateway-testnets.noxprotocol.dev',
      },
    },
  },
});
