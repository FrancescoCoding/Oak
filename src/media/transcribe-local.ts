/**
 * Local Whisper transcription (TRANSCRIBE_PROVIDER=local): OGG --ffmpeg--> PCM
 * --Whisper(ONNX via transformers.js)--> text. Free and offline, but loads a
 * model into memory, so it is loaded lazily and only on the local path.
 */
import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import { pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

const ffmpegPath = ffmpegStatic as unknown as string | null;

const MODEL = process.env.WHISPER_MODEL ?? "Xenova/whisper-base";
const SAMPLE_RATE = 16000;

let asrPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

function getAsr(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (!asrPromise) {
    asrPromise = pipeline("automatic-speech-recognition", MODEL) as Promise<
      AutomaticSpeechRecognitionPipeline
    >;
  }
  return asrPromise;
}

function decodeToPcm(input: Buffer): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("ffmpeg binary not found (ffmpeg-static)"));
    const args = ["-i", "pipe:0", "-f", "f32le", "-ac", "1", "-ar", String(SAMPLE_RATE), "pipe:1"];
    const proc = spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";

    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
      const buf = Buffer.concat(chunks);
      const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
      resolve(samples);
    });

    proc.stdin.write(input);
    proc.stdin.end();
  });
}

/** Transcribe voice-note bytes with the local Whisper model. */
export async function transcribeLocal(input: Buffer): Promise<string> {
  const pcm = await decodeToPcm(input);
  if (pcm.length === 0) return "";
  const asr = await getAsr();
  const out: any = await asr(pcm);
  const text = (Array.isArray(out) ? out[0]?.text : out?.text) ?? "";
  return String(text).trim();
}

/** Warm the model so the first voice note isn't slow. Best-effort. */
export function warmupLocal(): void {
  getAsr().catch((err) => {
    console.error("[transcribe] local model warmup failed:", err?.message ?? err);
  });
}
