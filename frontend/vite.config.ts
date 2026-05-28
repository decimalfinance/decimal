import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      buffer: 'buffer/',
    },
  },
  define: {
    global: 'globalThis',
  },
  server: {
    port: 5174,
    host: '0.0.0.0',
    fs: {
      allow: ['..'],
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split heavy vendor libs into their own chunks so the main bundle
        // stays small. Solana web3 + wallet-standard + the long tail of
        // crypto polyfills it drags in (buffer / bn.js / noble / etc) only
        // load when a signing-capable page mounts.
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (/[\\/]node_modules[\\/](react|react-dom|react-router|@remix-run|scheduler|cookie|set-cookie-parser)[\\/]/.test(id)) {
              return 'vendor-react';
            }
            if (id.includes('@tanstack')) return 'vendor-query';
            if (
              /[\\/]node_modules[\\/](@solana|@wallet-standard|@noble|bs58|buffer|bn\.js|buffer-layout|safe-buffer|base64-js|ieee754|sha\.js|hash-base|md5\.js|create-hash|create-hmac|ripemd160|cipher-base|brorand|hmac-drbg|elliptic|asn1\.js|miller-rabin|browserify-aes|browserify-cipher|browserify-des|browserify-rsa|browserify-sign|crypto-browserify|diffie-hellman|evp_bytestokey|public-encrypt|randombytes|randomfill|secp256k1|tweetnacl|jayson|rpc-websockets|superstruct|borsh|text-encoding-utf-8|@bundlr-network)[\\/]/.test(id)
            ) {
              return 'vendor-solana';
            }
          }
          return undefined;
        },
      },
    },
  },
});
