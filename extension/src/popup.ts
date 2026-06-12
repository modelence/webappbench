import { BUILDERS, builderForUrl } from './shared/builders.js';
import type {
  BuilderDef,
  CollectedRun,
  ContentRequest,
  ContentResponse,
  PendingRun,
  PromptEntry,
} from './shared/types.js';

const builderLabel = document.querySelector<HTMLSpanElement>('#builder-label')!;
const promptSelect = document.querySelector<HTMLSelectElement>('#prompt-select')!;
const promptPreview = document.querySelector<HTMLPreElement>('#prompt-preview')!;
const applyButton = document.querySelector<HTMLButtonElement>('#apply-btn')!;
const collectButton = document.querySelector<HTMLButtonElement>('#collect-btn')!;
const statusEl = document.querySelector<HTMLParagraphElement>('#status')!;
const runsList = document.querySelector<HTMLDivElement>('#runs-list')!;
const ratesList = document.querySelector<HTMLDivElement>('#rates-list')!;

let prompts: PromptEntry[] = [];

function setStatus(message: string, kind: 'ok' | 'error' | 'info' = 'info'): void {
  statusEl.hidden = false;
  statusEl.textContent = message;
  statusEl.className = `status${kind === 'info' ? '' : ` ${kind}`}`;
}

async function loadPrompts(): Promise<PromptEntry[]> {
  const response = await fetch(chrome.runtime.getURL('prompts.json'));
  if (!response.ok) throw new Error(`Failed to load prompts.json: HTTP ${response.status}`);
  return (await response.json()) as PromptEntry[];
}

async function getStored<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.local.get(key);
  return result[key] as T | undefined;
}

async function setStored(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

async function removeStored(key: string): Promise<void> {
  await chrome.storage.local.remove(key);
}

async function getRuns(): Promise<CollectedRun[]> {
  return (await getStored<CollectedRun[]>('runs')) ?? [];
}

async function getRateOverrides(): Promise<Record<string, number>> {
  return (await getStored<Record<string, number>>('creditRates')) ?? {};
}

async function effectiveRate(builder: BuilderDef): Promise<number | null> {
  const overrides = await getRateOverrides();
  const override = overrides[builder.id];
  if (typeof override === 'number' && override >= 0) return override;
  return builder.creditToUsd;
}

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) throw new Error('No active tab');
  return tab;
}

async function injectContentScripts(tabId: number, builder: BuilderDef): Promise<void> {
  for (const script of builder.contentScripts) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [script.file],
      world: script.world,
    });
  }
}

async function sendToTab(
  tabId: number,
  builder: BuilderDef,
  request: ContentRequest,
): Promise<ContentResponse> {
  try {
    return (await chrome.tabs.sendMessage(tabId, request)) as ContentResponse;
  } catch {
    // No listener in the tab — typically a tab opened before the extension
    // was (re)loaded. Inject the content scripts and retry once.
    try {
      await injectContentScripts(tabId, builder);
      return (await chrome.tabs.sendMessage(tabId, request)) as ContentResponse;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot reach the page (reload the tab and retry): ${message}`);
    }
  }
}

function selectedPrompt(): PromptEntry {
  const prompt = prompts.find((p) => p.id === promptSelect.value);
  if (!prompt) throw new Error('No prompt selected');
  return prompt;
}

// Identify the builder from the active tab's URL. Throws a user-facing message
// when the tab isn't one of the supported builders.
async function currentBuilder(): Promise<{ builder: BuilderDef; tab: chrome.tabs.Tab }> {
  const tab = await activeTab();
  const builder = builderForUrl(tab.url ?? '');
  if (!builder) {
    const names = BUILDERS.map((b) => b.label).join(', ');
    throw new Error(`This tab isn't a supported builder. Open one of: ${names}.`);
  }
  return { builder, tab };
}

async function handleApply(): Promise<void> {
  try {
    const { builder, tab } = await currentBuilder();
    const prompt = selectedPrompt();
    const response = await sendToTab(tab.id!, builder, { type: 'FILL_PROMPT', text: prompt.prompt });
    if (!response.ok) {
      setStatus(response.error, 'error');
      return;
    }
    const pending: PendingRun = {
      builder: builder.id,
      promptId: prompt.id,
      promptText: prompt.prompt,
      appliedAt: new Date().toISOString(),
    };
    await setStored('pendingRun', pending);
    setStatus(`Prompt "${prompt.id}" filled — review it and press Send in ${builder.label}.`, 'ok');
  } catch (error: unknown) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  }
}

async function handleCollect(): Promise<void> {
  try {
    collectButton.disabled = true;
    const { builder, tab } = await currentBuilder();
    setStatus('Collecting…');
    const response = await sendToTab(tab.id!, builder, { type: 'COLLECT' });
    if (!response.ok) {
      setStatus(response.error, 'error');
      return;
    }
    const pending = await getStored<PendingRun>('pendingRun');
    const samePending = pending && pending.builder === builder.id ? pending : undefined;
    const metrics = builder.parser(response.conversation, {
      promptText: samePending?.promptText,
    });
    const rate = await effectiveRate(builder);
    const cost =
      metrics.credits === null || rate === null ? null : roundCents(metrics.credits * rate);
    const run: CollectedRun = {
      id: `${builder.id}-${Date.now()}`,
      builder: builder.id,
      promptId: samePending?.promptId ?? promptSelect.value,
      appId: response.appId ?? '',
      appliedAt: samePending?.appliedAt ?? null,
      collectedAt: new Date().toISOString(),
      promptSubmittedAt: metrics.promptSubmittedAt,
      duration: metrics.duration ?? metrics.wallClockSeconds,
      wallClockSeconds: metrics.wallClockSeconds,
      credits: metrics.credits,
      creditToUsd: rate,
      cost,
      model: metrics.model,
      tokens: metrics.tokens,
    };
    const runs = await getRuns();
    await setStored('runs', [run, ...runs]);
    await removeStored('pendingRun');
    await renderRuns();
    const durationLabel = run.duration === null ? 'n/a' : `${run.duration.toFixed(1)}s`;
    const costLabel = run.cost === null ? 'n/a' : `$${run.cost.toFixed(2)}`;
    setStatus(`Collected: ${durationLabel}, ${costLabel}`, 'ok');
  } catch (error: unknown) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    collectButton.disabled = false;
  }
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function submissionsSnippet(run: CollectedRun): string {
  const lines = [
    `  - tool: ${run.builder}`,
    `    prompt: ${run.promptId}`,
    '    url: # fill in the deployed preview URL',
  ];
  if (run.promptSubmittedAt) lines.push(`    promptSubmittedAt: ${run.promptSubmittedAt}`);
  if (run.duration !== null) lines.push(`    duration: ${Math.round(run.duration)}`);
  if (run.cost !== null) lines.push(`    cost: ${run.cost}`);
  return `${lines.join('\n')}\n`;
}

function downloadRun(run: CollectedRun): void {
  const blob = new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${run.builder}-${run.promptId}-${run.collectedAt.slice(0, 19)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function deleteRun(id: string): Promise<void> {
  const runs = await getRuns();
  await setStored(
    'runs',
    runs.filter((r) => r.id !== id),
  );
  await renderRuns();
}

function runElement(run: CollectedRun): HTMLElement {
  const container = document.createElement('div');
  container.className = 'run';

  const head = document.createElement('div');
  head.className = 'run-head';
  const title = document.createElement('span');
  title.className = 'run-title';
  title.textContent = `${run.builder} · ${run.promptId}`;
  const date = document.createElement('span');
  date.className = 'run-detail';
  date.textContent = new Date(run.collectedAt).toLocaleString();
  head.append(title, date);

  const metrics = document.createElement('div');
  metrics.className = 'run-metrics';
  metrics.append(
    metricElement(run.duration === null ? '—' : `${run.duration.toFixed(1)}s`, 'duration'),
    metricElement(run.cost === null ? '—' : `$${run.cost.toFixed(2)}`, 'cost'),
  );

  const detail = document.createElement('div');
  detail.className = 'run-detail';
  const parts: string[] = [];
  // Show the credits→USD breakdown only for true credit-based builders; a rate
  // of 1 means the builder reported dollars directly (e.g. Replit), so the cost
  // metric already says it all.
  if (run.credits !== null && run.creditToUsd !== null && run.creditToUsd !== 1) {
    parts.push(`${run.credits} credits × $${run.creditToUsd}`);
  }
  if (run.model) parts.push(run.model);
  if (run.tokens) parts.push(`${run.tokens.totalTokens.toLocaleString()} tokens`);
  detail.textContent = parts.join(' · ');

  const actions = document.createElement('div');
  actions.className = 'run-actions';
  actions.append(
    actionButton('Copy YAML', async () => {
      await navigator.clipboard.writeText(submissionsSnippet(run));
      setStatus('submissions.yaml snippet copied.', 'ok');
    }),
    actionButton('Download JSON', () => downloadRun(run)),
    actionButton('Delete', () => void deleteRun(run.id)),
  );

  container.append(head, metrics, detail, actions);
  return container;
}

function metricElement(value: string, unit: string): HTMLElement {
  const wrap = document.createElement('span');
  const val = document.createElement('span');
  val.className = 'value';
  val.textContent = value;
  const label = document.createElement('span');
  label.className = 'unit';
  label.textContent = ` ${unit}`;
  wrap.append(val, label);
  return wrap;
}

function actionButton(label: string, onClick: () => void | Promise<void>): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', () => void onClick());
  return button;
}

async function renderRuns(): Promise<void> {
  const runs = await getRuns();
  runsList.replaceChildren();
  if (runs.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No runs collected yet.';
    runsList.append(empty);
    return;
  }
  runsList.append(...runs.map(runElement));
}

async function renderRates(): Promise<void> {
  const overrides = await getRateOverrides();
  ratesList.replaceChildren();
  for (const builder of BUILDERS) {
    // Only builders that expose an editable per-credit rate. null = no cost
    // signal; 1 = the builder already reports USD (e.g. Replit), nothing to set.
    if (builder.creditToUsd === null || builder.creditToUsd === 1) continue;
    const defaultRate = builder.creditToUsd;
    const row = document.createElement('div');
    row.className = 'rate-row';
    const label = document.createElement('span');
    label.textContent = `${builder.label} $/credit`;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '0.01';
    input.value = String(overrides[builder.id] ?? defaultRate);
    input.addEventListener('change', () => {
      void (async () => {
        const current = await getRateOverrides();
        const value = Number(input.value);
        const updated = { ...current, [builder.id]: Number.isFinite(value) ? value : defaultRate };
        await setStored('creditRates', updated);
        setStatus(`${builder.label} rate updated.`, 'ok');
      })();
    });
    row.append(label, input);
    const note = document.createElement('span');
    note.className = 'rate-note';
    note.textContent = builder.creditRateNote;
    ratesList.append(row, note);
  }
}

function renderPromptOptions(): void {
  promptSelect.replaceChildren(
    ...prompts.map((p) => new Option(`${p.id} (tier ${p.tier})`, p.id)),
  );
  updatePreview();
}

function updatePreview(): void {
  const prompt = prompts.find((p) => p.id === promptSelect.value);
  promptPreview.textContent = prompt?.prompt ?? '';
}

// Show the detected builder for the active tab, and disable the action buttons
// when the tab isn't a supported builder.
async function detectBuilder(): Promise<void> {
  let builder: BuilderDef | undefined;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    builder = builderForUrl(tab?.url ?? '');
  } catch {
    builder = undefined;
  }
  if (builder) {
    builderLabel.textContent = builder.label;
    builderLabel.classList.remove('unknown');
    applyButton.disabled = false;
    collectButton.disabled = false;
  } else {
    builderLabel.textContent = `Not a supported builder (${BUILDERS.map((b) => b.label).join(', ')})`;
    builderLabel.classList.add('unknown');
    applyButton.disabled = true;
    collectButton.disabled = true;
  }
}

async function init(): Promise<void> {
  try {
    prompts = await loadPrompts();
  } catch (error: unknown) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
    return;
  }
  renderPromptOptions();
  promptSelect.addEventListener('change', updatePreview);
  applyButton.addEventListener('click', () => void handleApply());
  collectButton.addEventListener('click', () => void handleCollect());
  await detectBuilder();
  await renderRuns();
  await renderRates();
}

void init();
