import { connect, type Socket } from "node:net";

// The local broker owns the microphone and retains speech during cold connection.
export class BrokerCapture {
  private socket: Socket;
  private pending = Buffer.alloc(0);
  private stopped = false;
  constructor(onAudio: (error: Error | null, samples: Float32Array) => void) {
    this.socket = connect("/data/runtime/voice-audio.sock");
    this.socket.on("data", (chunk: Buffer) => {
      if (this.stopped) return;
      this.pending = Buffer.concat([this.pending, chunk]);
      while (this.pending.length >= 2048) {
        const samples = new Float32Array(512);
        for (let i = 0; i < 512; i++) samples[i] = this.pending.readFloatLE(i * 4);
        this.pending = this.pending.subarray(2048);
        onAudio(null, samples);
      }
    });
    this.socket.on("error", (error) => { if (!this.stopped) onAudio(error, new Float32Array()); });
    this.socket.on("close", () => { if (!this.stopped) onAudio(new Error("Local VAD audio broker disconnected"), new Float32Array()); });
  }
  stop() { this.stopped = true; this.socket.destroy(); }
}
