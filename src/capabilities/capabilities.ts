import fs from 'fs';
import path from 'path';
import jsYaml from 'js-yaml';

// ── Capability schema ─────────────────────────────────────────────────────────

export interface AgentCapability {
  description: string;
  secrets: string[];
  tools: string[];
  repositories: string[];
  events: {
    emit: string[];
    subscribe: string[];
  };
}

export interface CapabilitiesManifest {
  agents: Record<string, AgentCapability>;
  humanOnlyTools: string[];
}

// ── Loader ────────────────────────────────────────────────────────────────────
// capabilities.yaml is copied into dist/capabilities/ by the build (see package.json);
// __dirname resolves to the compiled module dir at runtime.

let _manifest: CapabilitiesManifest | null = null;

export function loadCapabilities(): CapabilitiesManifest {
  if (_manifest) return _manifest;

  const yamlPath = path.join(__dirname, 'capabilities.yaml');
  const raw = fs.readFileSync(yamlPath, 'utf-8');
  _manifest = jsYaml.load(raw) as CapabilitiesManifest;
  return _manifest;
}

export function getAgentCapability(agentId: string): AgentCapability | undefined {
  return loadCapabilities().agents[agentId];
}

export function getHumanOnlyTools(): string[] {
  return loadCapabilities().humanOnlyTools;
}

// Reset cache — used in tests only
export function _resetCapabilitiesCache(): void {
  _manifest = null;
}
