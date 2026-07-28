import type { SnapConfig } from '@metamask/snaps-cli';

const config: SnapConfig = {
  bundler: 'webpack',
  input: './src/index.ts',
  server: { port: 8080 },
  // ethers + @iexec-nox/handle are WebCrypto-based, but the bundler may still
  // pull node shims; enable polyfills so the build resolves them.
  polyfills: true,
};

export default config;
