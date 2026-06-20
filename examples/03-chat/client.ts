/** Single-file Vue client: live chat over a WebSocket event subscription. Open two tabs. */
import { createApp, ref, watch, onMounted } from 'vue';
import { client, wsTransport } from '@ayepi/core/client';
import manifest from './manifest.gen'; // plain zod-free manifest — a normal import the bundler tree-shakes; no fetch, no zod
import type { api, Message } from './shared'; // type-only

const sdk = client<typeof api>({
  baseUrl: location.origin,
  manifest,
  ws: wsTransport(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`),
});

createApp({
  setup() {
    const room = ref('lobby');
    const from = ref('user-' + Math.floor(Math.random() * 1000));
    const text = ref('');
    const messages = ref<Message[]>([]);
    let unsub: (() => void) | null = null;

    const join = async (): Promise<void> => {
      unsub?.(); // leave the previous room
      messages.value = await sdk.call('history', { room: room.value });
      unsub = sdk.on('roomMessage', { room: room.value }, (m) => messages.value.push(m)); // live, room-scoped
    };

    const send = async (): Promise<void> => {
      if (!text.value.trim()) {
        return;
      }
      await sdk.call('send', { room: room.value, from: from.value, text: text.value.trim() });
      text.value = '';
    };

    onMounted(join);
    watch(room, join); // re-subscribe when the room changes

    return { room, from, text, messages, send };
  },
  template: `
    <main>
      <h1>03 · chat</h1>
      <p class="muted">Realtime events over WebSocket. Open this page in two tabs (same room) to see fanout.</p>

      <div class="row">
        <label>room <input v-model="room" /></label>
        <label>you <input v-model="from" /></label>
      </div>

      <div class="card" style="height:14rem; overflow:auto">
        <div v-for="(m, i) in messages" :key="i"><strong>{{ m.from }}</strong>: {{ m.text }}</div>
        <p v-if="!messages.length" class="muted">no messages yet — say hi</p>
      </div>

      <div class="row">
        <input v-model="text" placeholder="message…" @keyup.enter="send" style="flex:1" />
        <button @click="send">Send</button>
      </div>

      <nav class="muted" style="margin-top:1rem"><a href="/docs/asyncapi">AsyncAPI</a><a href="/docs/swagger">Swagger</a></nav>
    </main>`,
}).mount('#app');
