import { MakerZIP } from '@electron-forge/maker-zip'
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives'
import { VitePlugin } from '@electron-forge/plugin-vite'
import type { ForgeConfig } from '@electron-forge/shared-types'

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // App name shown in the packaged shell on macOS and Windows.
    name: 'Daylens',
    executableName: 'daylens',
    icon: './build/icon',
    appCopyright: `Copyright © ${new Date().getFullYear()} Daylens`,
  },
  rebuildConfig: {},
  makers: [
    // macOS zip for dev testing
    new MakerZIP({}, ['darwin']),
  ],
  plugins: [
    // Automatically unpacks native .node files from the asar archive at runtime
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/index.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
  ],
}

export default config
