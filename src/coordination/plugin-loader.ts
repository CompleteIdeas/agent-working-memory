// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Plugin loader for AWM coordination.
 *
 * Reads AWM_PLUGINS env var (comma-separated module paths or package names),
 * dynamically imports each, and calls register() with the plugin context.
 *
 * Usage:
 *   AWM_PLUGINS=./plugins/slack-notify.js,my-awm-plugin npm start
 */

import type { AWMPlugin, AWMPluginContext } from './plugin.js';

/** Loaded plugin instances (for teardown). */
const loadedPlugins: AWMPlugin[] = [];

/**
 * Load and register all plugins specified in AWM_PLUGINS env var.
 * Errors in individual plugins are logged but don't prevent other plugins from loading.
 */
export async function loadPlugins(ctx: AWMPluginContext): Promise<void> {
  const pluginList = process.env.AWM_PLUGINS;
  if (!pluginList) return;

  const paths = pluginList
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  for (const modulePath of paths) {
    try {
      const mod = await import(modulePath);
      const plugin: AWMPlugin = mod.default ?? mod;

      if (!plugin.name || typeof plugin.register !== 'function') {
        console.warn(`  [plugin] Skipping ${modulePath}: missing name or register()`);
        continue;
      }

      await plugin.register(ctx);
      loadedPlugins.push(plugin);
      console.log(`  [plugin] Loaded: ${plugin.name}`);
    } catch (err) {
      console.error(`  [plugin] Failed to load ${modulePath}:`, (err as Error).message);
    }
  }
}

/** Teardown all loaded plugins (call on shutdown). */
export async function teardownPlugins(): Promise<void> {
  for (const plugin of loadedPlugins) {
    try {
      await plugin.teardown?.();
    } catch (err) {
      console.error(`  [plugin] Teardown error (${plugin.name}):`, (err as Error).message);
    }
  }
  loadedPlugins.length = 0;
}
