import * as ollama from "./ollama.js";
import * as openrouter from "./openrouter.js";

const PROVIDERS = {
  ollama,
  openrouter,
};

export function getProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`Unknown provider "${name}". Available: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return provider;
}

export function listProviders() {
  return Object.keys(PROVIDERS);
}
