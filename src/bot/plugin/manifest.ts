import * as fs from 'fs';
import * as path from 'path';
import type { PluginManifest } from './api';

export function readPluginManifest(directory: string): PluginManifest {
  const file = path.join(directory, 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!manifest || typeof manifest !== 'object' ||
      typeof manifest.name !== 'string' || !manifest.name.trim() ||
      typeof manifest.version !== 'string' || !manifest.version.trim() ||
      (manifest.entry !== undefined && (typeof manifest.entry !== 'string' || !manifest.entry.trim())) ||
      (manifest.defaultEnabled !== undefined && typeof manifest.defaultEnabled !== 'boolean')) {
    throw new Error(`invalid plugin manifest: ${file}`);
  }
  return manifest;
}
