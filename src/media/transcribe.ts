/**
 * Local speech-to-text for Telegram voice notes.
 *
 * Telegram sends voice as OGG/Opus. Claude has no audio input, so we transcribe
 * locally and feed the text to the agent as if the user had typed it. The whole
 * pipeline is free, offline after the first run, and needs no Python:
 *
 *   OGG/Opus bytes --ffmpeg--> 16kHz mono f32 PCM --Whisper(ONNX)--> text
 *
 * ffmpeg comes from ffmpeg-static (a bundled binary). Whisper runs in-process
 * via @huggingface/transformers (Transformers.js); the model downloads once
 * (~150MB for whisper-base) and is cached under the HF cache dir.
 */
import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import { pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

// ffmpeg-static's default export is the absolute path to the bundled binary at
// runtime, though its types describe the module. Narrow it to a string.
const ffmpegPath = ffmpegStatic as unknown as string | null;

const MODEL = process.env.WHISPER_MODEL ?? "Xenova/whisper-base";
const SAMPLE_RATE = 16000;

let asrPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

/** Lazily build (and cache) the ASR pipeline; the model downloads on first call. */
function getAsr(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (!asrPromise) {
    asrPromise = pipeline("automatic-speech-recognition", MODEL) as Promise<
      AutomaticSpeechRecognitionPipeline
    >;
  }
  return asrPromise;
}

/**
 * Decode arbitrary audio bytes to mono 16kHz Float32 PCM using ffmpeg.
 * Reads from stdin, writes raw 32-bit float little-endian samples to stdout.
 */
function decodeToPcm(input: Buffer): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("ffmpeg binary not found (ffmpeg-static)"));
    const args = [
      "-i", "pipe:0",
      "-f", "f32le",
      "-ac", "1",
      "-ar", String(SAMPLE_RATE),
      "pipe:1",
    ];
    const proc = spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";

    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
      }
      const buf = Buffer.concat(chunks);
      // Reinterpret the byte buffer as Float32 samples.
      const samples = new Float32Array(
        buf.buffer,
        buf.byteOffset,
        Math.floor(buf.byteLength / 4),
      );
      resolve(samples);
    });

    proc.stdin.write(input);
    proc.stdin.end();
  });
}

/**
 * Transcribe voice-note bytes to text. Returns the trimmed transcript, or "" if
 * nothing intelligible was found. Throws on a genuine pipeline failure so the
 * caller can tell the user it could not be processed.
 */
export async function transcribeAudio(input: Buffer): Promise<string> {
  const pcm = await decodeToPcm(input);
  if (pcm.length === 0) return "";
  const asr = await getAsr();
  const out: any = await asr(pcm);
  const text = (Array.isArray(out) ? out[0]?.text : out?.text) ?? "";
  return String(text).trim();
}

/** Warm the model at startup so the first voice note isn't slow. Best-effort. */
export function warmupTranscriber(): void {
  getAsr().catch((err) => {
    console.error("[transcribe] model warmup failed:", err?.message ?? err);
  });
}
