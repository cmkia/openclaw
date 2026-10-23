import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { localWhisperProvider } from "./provider.mjs";

export default definePluginEntry({
  id: "local-whisper",
  name: "Local Whisper Dictation",
  description: "Private local Whisper transcription",
  register(api) {
    api.registerRealtimeTranscriptionProvider(localWhisperProvider);
  },
});
