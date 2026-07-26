import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("installation entry points", () => {
  it("publishes an accessible no-build GitHub Pages experience", () => {
    const page = readFileSync(`${root}/index.html`, "utf8");
    const packageMetadata = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as { homepage?: string };

    expect(page).toContain("ATLAS | Live Agentic Support");
    expect(page).toContain('src="docs/atlas-agent-splash.png"');
    expect(page).toContain('href="#main"');
    expect(page).toContain("prefers-reduced-motion: reduce");
    expect(page).toContain("https://raw.githubusercontent.com/appatalks/atlas-agent/main/get-atlas.sh");
    expect(page).toContain("https://appatalks.github.io/eva-agent/");
    expect(packageMetadata.homepage).toBe("https://appatalks.github.io/atlas-agent/");
  });

  it("provides a curl bootstrap and a durable atlas launcher", () => {
    const bootstrap = readFileSync(`${root}/get-atlas.sh`, "utf8");
    const installer = readFileSync(`${root}/tools/install.sh`, "utf8");
    const readme = readFileSync(`${root}/README.md`, "utf8");

    expect(bootstrap).toContain("https://github.com/appatalks/atlas-agent.git");
    expect(bootstrap).toContain('/atlas-agent}');
    expect(bootstrap).toContain("atlas-live-agentic-support");
    expect(bootstrap).toContain('exec bash "$INSTALL_DIR/tools/install.sh"');
    expect(installer).toContain('local launcher="$bin_dir/atlas"');
    expect(installer).toContain('local legacy_launcher="$bin_dir/atsla"');
    expect(installer).toContain('Usage: atlas [start|stop|status|update|path]');
    expect(installer).toContain('[[ "$INSTALL_VOICE" == "true" ]] || return 0');
    expect(installer).toContain('node "$electron_dir/install.js"');
    expect(installer).toContain('npm install --include=dev');
    expect(installer).toContain("repair_voice_module_link");
    expect(installer).toContain('uv pip install --python "$python" --no-deps --editable "$VOICE_MODULE_DIR"');
    expect(installer).toContain("ATLAS requires Node.js 24 or newer");
    expect(bootstrap).toContain("Migrating ATLAS installation");
    expect(installer).toContain('atlas-agent.desktop');
    expect(installer).toContain('atlas-live-agentic-support.desktop');
    expect(readme).toContain("docs/atlas-agent-splash.png");
    expect(readme).not.toContain("docs/atlas-agent.png");
    expect(existsSync(`${root}/docs/atlas-agent-splash.png`)).toBe(true);
    expect(existsSync(`${root}/docs/atlas-flow.dot`)).toBe(true);
    expect(existsSync(`${root}/docs/atlas-flow.png`)).toBe(true);
    expect(existsSync(`${root}/docs/atsla-agent.png`)).toBe(false);
    expect(existsSync(`${root}/docs/atsla-flow.dot`)).toBe(false);
    expect(installer).toContain('require("node:sqlite")');
    expect(installer).toContain('sqlite_compileoption_used(?)');
    expect(installer).toContain('.get("ENABLE_FTS5")');
    expect(installer).not.toContain('sqlite_compileoption_used(\\"ENABLE_FTS5\\")');
    expect(installer).not.toContain("gh repo clone appatalks/voice_clone_module");
    expect(existsSync(`${root}/vendor/voice_clone_module/pyproject.toml`)).toBe(true);
    expect(existsSync(`${root}/assets/voices/appatalks-voice.wav`)).toBe(true);
  });

  it("starts ATLAS's independent stateless Copilot ACP bridge", () => {
    const supervisor = readFileSync(`${root}/tools/voice-bridge.sh`, "utf8");
    const bridge = readFileSync(`${root}/tools/stateless_acp_bridge.py`, "utf8");
    expect(supervisor).toContain('python3 "$ROOT_DIR/tools/stateless_acp_bridge.py"');
    expect(supervisor).not.toContain("EVA_ACP_BRIDGE_SCRIPT");
    expect(bridge).toContain('"session/new"');
    expect(bridge).toContain('"session/prompt"');
    expect(bridge).not.toContain("eva-agent");
  });

  it("provides an opt-in direct remote TTS mode and GPU host launcher", () => {
    const supervisor = readFileSync(`${root}/tools/voice-bridge.sh`, "utf8");
    const server = readFileSync(`${root}/tools/tts-server.sh`, "utf8");
    const loader = readFileSync(`${root}/tools/load-env.sh`, "utf8");
    const envExample = readFileSync(`${root}/.env.example`, "utf8");
    expect(supervisor).toContain('VOICE_BRIDGE_TTS_MODE');
    expect(supervisor).toContain('VOICE_BRIDGE_REMOTE_TTS_URL');
    expect(supervisor).toContain('load_env_file "$ROOT_DIR"');
    expect(supervisor).toContain('"$tts_mode" == "auto"');
    expect(supervisor).toContain('VOICE_BRIDGE_TTS_AUTH_TOKEN');
    expect(loader).toContain('VOICE_BRIDGE_ENV_FILE');
    expect(server).toContain('VOICE_BRIDGE_TTS_HOST');
    expect(server).toContain('load_env_file "$ROOT_DIR"');
    expect(server).toContain('local_voice_bridge.py');
    expect(server).toContain('Set VOICE_BRIDGE_TTS_AUTH_TOKEN');
    expect(envExample).toContain('VOICE_BRIDGE_REMOTE_TTS_URL=http://gpu-tts-host:8090/');
  });
});