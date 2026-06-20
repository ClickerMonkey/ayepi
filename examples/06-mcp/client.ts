/**
 * Single-file Vue client — an MCP **tool explorer**. On mount it calls `tools` to list
 * the spec's MCP tools, renders a small form per tool from its `inputSchema.properties`,
 * and invokes the selected tool via `callTool`, showing the returned text result.
 */
import { createApp, ref, onMounted } from 'vue';
import { client } from '@ayepi/core/client';
import manifest from './manifest.gen'; // plain zod-free manifest — tree-shaken; no zod
import type { api } from './shared'; // type-only — erased at build time

const sdk = client<typeof api>({ baseUrl: location.origin, manifest });

/** Minimal JSON-Schema shape we read for building the form. */
interface ToolSchema {
  readonly properties?: Record<string, { type?: string; description?: string }>;
}
interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

createApp({
  setup() {
    const tools = ref<Tool[]>([]);
    const selected = ref<Tool | null>(null);
    const args = ref<Record<string, string>>({});
    const result = ref('');
    const isError = ref(false);
    const error = ref('');

    const props = (t: Tool): Record<string, { type?: string; description?: string }> =>
      (t.inputSchema as ToolSchema).properties ?? {};

    const select = (t: Tool): void => {
      selected.value = t;
      result.value = '';
      isError.value = false;
      // seed an empty value per property
      args.value = Object.fromEntries(Object.keys(props(t)).map((k) => [k, '']));
    };

    const invoke = async (): Promise<void> => {
      const t = selected.value;
      if (!t) return;
      error.value = '';
      result.value = '';
      // coerce numbers/booleans per the schema; everything else stays a string
      const schema = props(t);
      const parsed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args.value)) {
        const type = schema[k]?.type;
        if (type === 'number' || type === 'integer') parsed[k] = v === '' ? undefined : Number(v);
        else if (type === 'boolean') parsed[k] = v === 'true';
        else parsed[k] = v;
      }
      try {
        const res = await sdk.call('callTool', { name: t.name, args: parsed });
        result.value = res.result;
        isError.value = res.isError;
      } catch (err) {
        error.value = err instanceof Error ? err.message : String(err);
      }
    };

    onMounted(async () => {
      tools.value = await sdk.call('tools');
    });

    return { tools, selected, args, result, isError, error, props, select, invoke };
  },
  template: `
    <main>
      <h1>06 · mcp</h1>
      <p class="muted">Any ayepi spec becomes <strong>MCP tools</strong> — one per endpoint, executed in-process against this app. Pick a tool, fill its form, invoke it.</p>

      <div class="row" style="align-items:flex-start">
        <div style="flex:1;min-width:14rem">
          <div v-for="t in tools" :key="t.name" class="card"
               :style="{ cursor:'pointer', outline: selected && selected.name===t.name ? '2px solid currentColor' : 'none' }"
               @click="select(t)">
            <strong>{{ t.name }}</strong>
            <div class="muted">{{ t.description }}</div>
          </div>
          <p v-if="!tools.length" class="muted">loading tools…</p>
        </div>

        <div style="flex:1;min-width:14rem">
          <div v-if="selected" class="card">
            <strong>{{ selected.name }}</strong>
            <div v-for="(p, k) in props(selected)" :key="k" class="row">
              <label style="min-width:5rem">{{ k }}</label>
              <input v-model="args[k]" :placeholder="p.type || 'string'"
                     @keyup.enter="invoke" style="flex:1" />
            </div>
            <p v-if="!Object.keys(props(selected)).length" class="muted">no arguments</p>
            <div class="row"><button @click="invoke">Invoke</button></div>
            <pre v-if="result" :class="{ err: isError }">{{ result }}</pre>
            <p v-if="error" class="err">{{ error }}</p>
          </div>
          <p v-else class="muted">← pick a tool</p>
        </div>
      </div>

      <nav class="muted" style="margin-top:1.5rem">
        <a href="/docs/swagger">Swagger</a><a href="/docs/openapi.json">OpenAPI</a>
      </nav>
    </main>`,
}).mount('#app');
