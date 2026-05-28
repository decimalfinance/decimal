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
        // stays small. Three.js / drei only ships when the Landing page (which
        // uses the 3D hero) loads; Solana web3 + wallet-standard only when
        // a signing-capable page mounts.
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router'],
          'vendor-query': ['@tanstack/react-query'],
          'vendor-solana': [
            '@solana/web3.js',
            '@solana/wallet-standard-features',
            '@wallet-standard/core',
            'bs58',
          ],
          'vendor-three': ['three', '@react-three/fiber', '@react-three/drei'],
        },
      },
    },
  },
});
