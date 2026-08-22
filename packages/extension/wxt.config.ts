import react from '@vitejs/plugin-react'
import { defineConfig } from 'wxt'

/**
 * Extension build configuration.
 *
 * Chrome is the primary verification target; the Firefox build is produced from the same
 * sources. Authentication uses `identity.launchWebAuthFlow`, which both browsers support,
 * rather than the Chrome-only `getAuthToken`.
 */
export default defineConfig({
  srcDir: 'src',
  // Holds the ONNX runtime copied in by tools/copy-onnx-runtime.mjs, which has to be
  // served from inside the extension rather than from a CDN (see inference/transformers).
  publicDir: 'src/public',
  // The React plugin is wired directly rather than through @wxt-dev/module-react, whose
  // current release pulls in a plugin version that requires a newer Vite than WXT uses.
  vite: () => ({
    plugins: [react()],
  }),
  manifest: ({ manifestVersion }) => ({
    name: 'Personal Preference Recommender',
    description:
      'A recommendation profile you own: ratings, interest decay and ranking all stay on this machine.',
    version: '0.1.0',
    permissions: ['storage', 'unlimitedStorage', 'identity', 'alarms'],
    host_permissions: [
      'https://www.googleapis.com/*',
      'https://oauth2.googleapis.com/*',
      // The optional shared catalog, which is deployed to workers.dev by default. A
      // catalog on a custom domain needs its origin added here.
      'https://*.workers.dev/*',
    ],
    action: {
      default_title: 'Open my feed',
    },

    /**
     * The embedding model runs as WebAssembly, which the default extension policy refuses
     * to compile. Without `wasm-unsafe-eval` the sentence encoder cannot start at all and
     * the system silently drops to the lexical fallback.
     *
     * This does not loosen where code may come from: `script-src 'self'` still stands, and
     * the runtime is served from inside the extension rather than from a CDN.
     */
    ...(manifestVersion === 3
      ? {
          content_security_policy: {
            extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
          },
        }
      : {
          content_security_policy: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
        }),
    browser_specific_settings: {
      gecko: {
        id: 'personal-preference-recommender@local',
        strict_min_version: '115.0',
        // Nothing is transmitted anywhere except Google, and only on the user's own
        // behalf: no preference data leaves this machine (design section 1).
        data_collection_permissions: { required: ['none'] },
      },
    },
  }),
})
