/**
 * Voice-note transcription. TRANSCRIBE_PROVIDER picks "local" (in-process
 * Whisper), "api" (OpenAI-compatible endpoint), or "off". The local model is
 * imported lazily so api/off never load it. See docs/configuration.md.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { config } from "../config.js";

const ffmpegPath = ffmpegStatic as unknown as string | null;

/** Whether voice notes can be transcribed in this configuration. */
export function transcriptionAvailable(): boolean {
  if (config.transcribeProvider === "off") return false;
  if (config.transcribeProvider === "api") return Boolean(config.transcribeApiKey);
  return true; // local
}

/**
 * Transcribe voice-note bytes to text. Returns the trimmed transcript, or "" if
 * nothing intelligible was found. Throws on a genuine failure so the caller can
 * tell the user it could not be processed.
 */
export async function transcribeAudio(input: Buffer): Promise<string> {
  if (config.transcribeProvider === "off") {
    throw new Error("transcription disabled (TRANSCRIBE_PROVIDER=off)");
  }
  if (config.transcribeProvider === "api") {
    return transcribeViaApi(input);
  }
  const { transcribeLocal } = await import("./transcribe-local.js");
  return transcribeLocal(input);
}

/** Transcode OGG/Opus to mono 16kHz WAV (OpenAI's endpoint rejects raw OGG). */
function transcodeToWav(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("ffmpeg binary not found (ffmpeg-static)"));
    const out = path.join(
      os.tmpdir(),
      `oak-voice-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`,
    );
    const proc = spawn(
      ffmpegPath,
      ["-i", "pipe:0", "-ac", "1", "-ar", "16000", "-f", "wav", "-y", out],
      {
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
    let stderr = "";
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        fs.rm(out, () => {});
        return reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
      }
      fs.readFile(out, (err, data) => {
        fs.rm(out, () => {});
        if (err) return reject(err);
        resolve(data);
      });
    });
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

/** Send the audio to an OpenAI-compatible /audio/transcriptions endpoint. */
async function transcribeViaApi(input: Buffer): Promise<string> {
  if (!config.transcribeApiKey) {
    throw new Error("TRANSCRIBE_API_KEY is not set");
  }
  const wav = await transcodeToWav(input);
  const form = new FormData();
  form.append("file", new Blob([wav as unknown as BlobPart], { type: "audio/wav" }), "voice.wav");
  form.append("model", config.transcribeModel);
  form.append("response_format", "json");

  const res = await fetch(config.transcribeApiUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.transcribeApiKey}` },
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`transcription API ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json: any = await res.json().catch(() => ({}));
  return String(json.text ?? "").trim();
}

/** Warm the local model at startup so the first voice note isn't slow. No-op for api/off. */
export function warmupTranscriber(): void {
  if (config.transcribeProvider !== "local") return;
  import("./transcribe-local.js")
    .then((m) => m.warmupLocal())
    .catch((err) => console.error("[transcribe] warmup import failed:", err?.message ?? err));
}
