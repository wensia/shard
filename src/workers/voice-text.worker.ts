import { speechChunks, type VoiceContent } from '@/lib/voice-text'
self.onmessage = (event: MessageEvent<VoiceContent>) => {
  try { self.postMessage({ chunks: speechChunks(event.data) }) }
  catch { self.postMessage({ error: '无法读取朗读正文' }) }
}
