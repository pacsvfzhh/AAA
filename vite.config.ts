import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'],
  },
  esbuild: {
    drop: ['debugger'],
    pure: ['console.log', 'console.debug', 'console.info', 'console.warn'],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react-dom') || id.includes('/react/')) return 'vendor-react';
            if (id.includes('@supabase')) return 'vendor-supabase';
            if (id.includes('@tiptap') || id.includes('prosemirror') || id.includes('@tiptap/pm')) return 'vendor-tiptap';
            if (id.includes('mammoth')) return 'vendor-mammoth';
            if (id.includes('bcryptjs')) return 'vendor-crypto';
            if (id.includes('dompurify')) return 'vendor-sanitize';
            if (id.includes('marked')) return 'vendor-marked';
          }
        },
      },
    },
  },
});
