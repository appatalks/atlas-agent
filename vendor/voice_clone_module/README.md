# Voice Clone Module

Reusable Chatterbox voice cloning for local Python applications and interactive AI agents. This module is vendored by ATLAS and is not published as `voice-clone-module` on PyPI.

## What is included

- `VoiceCloner`: a reusable Python service that caches Chatterbox after its first request.
- `voice-clone`: a command-line voice synthesis tool.
- `voice-demo`: a local browser chat app using a lightweight local Qwen3 model.
- `launcher.sh`: starts the demo and opens it in the default browser.
- `install.sh`: a pinned Python 3.11 setup for the tested Chatterbox, CUDA, and transcription stack.

The demo keeps both models on the local machine. Chat text is sent to the local FastAPI process, and each response is generated as a watermarked WAV file using the configured reference voice.

## Install From ATLAS

```bash
cd vendor/voice_clone_module
bash install.sh
```

The script requires [`uv`](https://docs.astral.sh/uv/getting-started/installation/) and Python 3.11 support. It creates `.venv`, installs exact versions from [requirements-demo.txt](requirements-demo.txt), and runs `uv pip check` at the end.

The installer detects an NVIDIA GPU. On NVIDIA hardware it installs PyTorch 2.10.0 from the CUDA 12.8 wheel index, which supports the RTX 5070 Ti used during validation. On other machines it installs the PyPI PyTorch build and the app automatically selects CPU or Apple MPS when available.

Chatterbox 0.1.7 is installed without its published dependency list because that list still pins older Torch, Transformers, Diffusers, Safetensors, and Gradio releases. The direct pins in [requirements-demo.txt](requirements-demo.txt) are the tested compatible and security-patched set. The installer allows only those six known upstream metadata mismatches and fails on any other dependency conflict.

## Run The Demo

The launcher uses the bundled reference by default. To use a different recording, configure its absolute path:

```bash
export VOICE_CLONE_REFERENCE=/absolute/path/to/appatalks.wav
./launcher.sh
```

ATLAS stores its default AppaTalks reference at `assets/voices/appatalks-voice.wav`. With that bundled voice, the shortest startup is:

```bash
./launcher.sh
```

You can still override it with a command-line path or `VOICE_CLONE_REFERENCE`. Only use voice references in ways authorized by the speaker.

`launcher.sh` starts the server and opens [http://127.0.0.1:8000](http://127.0.0.1:8000) in the default browser. You can also pass the reference path directly:

```bash
./launcher.sh /absolute/path/to/appatalks.wav
```

Type a message, press Enter, and the local agent will return text plus a playable voice response. Use Shift+Enter for a line break. Keep the terminal open while using the app; press Ctrl+C to stop the server.

Long replies are split at sentence and word boundaries before synthesis because Chatterbox has a roughly 40-second generation ceiling per call. The resulting WAV segments are joined into one response, so the spoken audio does not stop while the text continues. A browser log showing `206 Partial Content` for an `/audio/*.wav` request is normal: browsers use byte-range requests for media playback and it does not mean the WAV was truncated. The occasional `/favicon.ico` `404` is unrelated to audio playback.

The first chat message downloads these model weights from Hugging Face if they are not already cached:

- `Qwen/Qwen2.5-1.5B-Instruct` for local text responses by default
- `ResembleAI/chatterbox` for voice generation
- `Systran/faster-whisper-small.en` for local speech transcription

Set `HF_TOKEN` before launching if authenticated Hugging Face access is needed. Select the startup model with `VOICE_DEMO_MODEL_KEY` using one of `qwen3-0.6b`, `smollm2-1.7b`, `qwen2.5-1.5b`, `qwen2.5-7b`, or `qwen2.5-72b`.

Useful configuration:

```bash
export VOICE_CLONE_REFERENCE=/path/to/reference.wav
export VOICE_CLONE_DEVICE=auto       # auto, cuda, mps, or cpu
export VOICE_CLONE_EXAGGERATION=0.5
export VOICE_CLONE_CFG_WEIGHT=0.5
export VOICE_DEMO_MODEL=Qwen/Qwen2.5-1.5B-Instruct
export VOICE_DEMO_HOST=127.0.0.1
export VOICE_DEMO_PORT=8000
export VOICE_TRANSCRIBE_MODEL=Systran/faster-whisper-small.en
```

The generated files are written to `output/demo/`, which is ignored by Git.

## Local Model Choices

Use the **Local model** menu in the app to choose a model. Each selected model downloads from Hugging Face on its first use and then stays cached locally:

| Choice | Model | Tradeoff |
| --- | --- | --- |
| Qwen3 0.6B | `Qwen/Qwen3-0.6B` | Fastest and lightest; good for simple agent turns |
| SmolLM2 1.7B | `HuggingFaceTB/SmolLM2-1.7B-Instruct` | Balanced quality and memory use |
| Qwen2.5 1.5B | `Qwen/Qwen2.5-1.5B-Instruct` | More capable reasoning with a modest footprint |
| Qwen2.5 7B | `Qwen/Qwen2.5-7B-Instruct` | Stronger general reasoning; loaded in 4-bit NF4 to fit alongside Chatterbox on a 16 GB GPU |
| Qwen3 8B | `Qwen/Qwen3-8B` | Highest-quality local option; loaded in 4-bit NF4, with thinking disabled for responsive chat |
| Qwen2.5 72B | `Qwen/Qwen2.5-72B-Instruct` | Near-frontier quality; plan for roughly 150 GB or more of memory with the current unquantized loader |

Only the selected chat model loads into the active request cache. Changing models during a running session can use additional memory because previously loaded models remain cached in that process. Restart the launcher to release all model memory.

## Voice Input

Click **Speak**, allow microphone access, and speak normally. Click **Stop** when finished. The browser uploads the short recording to the local `/api/transcribe` endpoint, where `faster-whisper-small.en` transcribes it on the configured CPU or GPU. The transcript is placed into the message box for review before you send it to the agent.

Voice input is currently English-only because the default model is `Systran/faster-whisper-small.en`. To use another faster-whisper checkpoint, set `VOICE_TRANSCRIBE_MODEL` before launching. Browser microphone access works on `localhost` and `127.0.0.1`; no audio is sent to a cloud service by this app.

## Python API

Create one service when your application starts and reuse it for each agent response:

```python
from voice_clone_module import VoiceCloner

voice = VoiceCloner("/path/to/reference.wav")

# Returns a [channels, samples] torch.Tensor.
audio = voice.synthesize("Welcome back. How can I help?")

# Or write a WAV file for a browser, media server, or job queue.
voice.save("Your report is ready.", "output/report.wav")
```

The reference voice does not need a transcript. Use roughly 5-10 seconds of clean speech from one speaker. Only clone voices with the speaker's permission. Chatterbox adds its built-in Perth watermark to generated audio.

## Agent Integration

Keep the agent's response loop independent from Chatterbox:

```python
from voice_clone_module import VoiceCloner


class AgentSpeaker:
    def __init__(self, reference_audio: str):
        self.voice = VoiceCloner(reference_audio)

    def reply_audio(self, response_text: str, output_path: str):
        return self.voice.save(response_text, output_path)


speaker = AgentSpeaker("/path/to/reference.wav")
speaker.reply_audio("Your report is ready.", "output/reply.wav")
```

For another web app, reuse `VoiceCloner` in its own process or call the demo's `POST /api/chat` endpoint. The endpoint accepts:

```json
{
  "message": "Summarize my day.",
  "history": [
    {"role": "user", "content": "I finished the deployment."},
    {"role": "assistant", "content": "Nice work. What remains?"}
  ]
}
```

It returns the assistant text and an `audio_url` for the generated WAV.

## Development

Install the test dependency inside the environment, then run:

```bash
uv pip install --python .venv/bin/python pytest==9.1.1
PYTHONPATH=src .venv/bin/python -m pytest -q
```

The tests use a fake model and do not download weights. The full demo can be smoke-tested with your configured reference voice by running `voice-demo` and posting a message from the browser.
