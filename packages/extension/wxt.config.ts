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
  // The React plugin is wired directly rather than through @wxt-dev/module-react, whose
  // current release pulls in a plugin version that requires a newer Vite than WXT uses.
  vite: () => ({
    plugins: [react()],
  }),
  manifest: {
    name: 'Personal Preference Recommender',
    description:
      'A recommendation profile you own: ratings, interest decay and ranking all stay on this machine.',
    version: '0.1.0',
    permissions: ['storage', 'unlimitedStorage', 'identity', 'alarms'],
    host_permissions: ['https://www.googleapis.com/*', 'https://oauth2.googleapis.com/*'],
    action: {
      default_title: 'Open my feed',
    },
    browser_specific_settings: {
      gecko: {
        id: 'personal-preference-recommender@local',
        strict_min_version: '115.0',
        // Nothing is transmitted anywhere except Google, and only on the user's own
        // behalf: no preference data leaves this machine (design section 1).
        data_collection_permissions: { required: ['none'] },
      },
    },
  },
})
