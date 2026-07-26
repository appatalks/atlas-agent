import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STANDARD_GREETING } from "../src/domain.js";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("AppaTalks Standard Greeting cache", () => {
  it("uses one shared greeting text for the session template and voice prewarm", () => {
    const supervisor = readFileSync(`${root}/tools/voice-bridge.sh`, "utf8");
    expect(STANDARD_GREETING).toContain("I am AppaTalks");
    expect(supervisor).toContain(`local standard_greeting="${STANDARD_GREETING}"`);
    expect(supervisor).toContain("--warm-text \"$standard_greeting\"");
    expect(supervisor).toContain("--warm-exaggeration 0.65 --warm-cfg-weight 0.35");
    expect(supervisor).toContain("--eva-reference \"$eva_reference\"");
    expect(supervisor).toContain("--seed-audio \"$greeting_seed\"");
    expect(existsSync(`${root}/assets/prewarmed/appatalks-standard-greeting.wav`)).toBe(true);
    expect(existsSync(`${root}/assets/voices/appatalks-voice.wav`)).toBe(true);
    expect(existsSync(`${root}/assets/voices/eva-voice.wav`)).toBe(true);
    expect(supervisor).toContain('assets/voices/appatalks-voice.wav');
    expect(supervisor).toContain('PYTHONPATH="$voice_module_source${PYTHONPATH:+:$PYTHONPATH}"');
  });

  it("persists only warmed greeting audio and keys it to the reference and expression settings", () => {
    const bridge = readFileSync(`${root}/tools/local_voice_bridge.py`, "utf8");
    expect(bridge).toContain("if cache_path and cache_path.is_file()");
    expect(bridge).toContain('"reference_mtime_ns"');
    expect(bridge).toContain("self.warm_texts.add(text)");
    expect(bridge).toContain('"voice_profiles"');
    expect(bridge).toContain('profile_id == "appatalks"');
    expect(bridge).toContain("seed_reference_sha256");
    expect(bridge).toContain('HTTPStatus.OK if health["ok"] else HTTPStatus.SERVICE_UNAVAILABLE');
  });
});