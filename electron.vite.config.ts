import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import pkg from './package.json'

const sharedDefine = {
  __APP_VERSION__: JSON.stringify(pkg.version)
}

export default defineConfig({
  main: {
    define: sharedDefine,
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // zlib-sync is a native (.node) addon that @discordjs/ws loads lazily via
        // `import('zlib-sync').catch(() => null)` for optional WebSocket compression.
        // It is NOT installed: the 0.1.x line targets an old V8 and fails to build
        // against Electron 42. @discordjs/ws falls back to identify compress when it
        // is absent, so we keep the import external (preserved at runtime, resolves
        // to null) rather than bundling — and skip the native rebuild entirely.
        external: ['zlib-sync'],
        input: {
          index: resolve(__dirname, 'electron/main.ts')
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  },
  preload: {
    define: sharedDefine,
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload.ts')
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          trayPopover: resolve(__dirname, 'src/renderer/tray-popover.html'),
        }
      }
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer'),
        '@shared': resolve(__dirname, 'src/shared'),
        '@resources': resolve(__dirname, 'resources')
      }
    },
    define: sharedDefine,
    plugins: [tailwindcss(), react()],
    server: {
      fs: {
        allow: [resolve(__dirname, '.'), resolve(__dirname, 'resources')]
      }
    }
  }
})
