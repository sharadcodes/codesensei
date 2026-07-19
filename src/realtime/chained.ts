import { EventEmitter } from 'events';
import { FullConfig, SttConfig, TtsConfig, ChatConfig } from '../config';
import { CodebaseContext } from '../types';
import { logger } from '../logger';
import { AcpClient } from '../acp/client';

/**
 * Chained voice provider: mic → STT → chat → TTS → speaker.
 *
 * Chat can use either:
 *   - ACP agent (Devin/Codex) via session/prompt — no external API cost
 *   - OpenAI-compatible /chat/completions (OpenRouter) — fallback if no ACP agent
 *
 * STT: OpenAI-compatible /audio/transcriptions (OpenRouter Voxtral by default)
 * TTS: OpenAI-compatible /audio/speech (Kokoro FastAPI by default)
 */
export interface ChainedTurn {
  role: 'interviewer' | 'candidate';
  text: string;
}

export class ChainedVoiceProvider extends EventEmitter {
  private conversation: ChainedTurn[] = [];
  private contextSummary = '';
  private filesBrief = '';
  private topicsBrief = '';
  private questionCount = 0;
  private maxQuestions = 0;
  private acpClient: AcpClient | null = null;
  private acpSessionId: string | null = null;

  constructor(private cfg: FullConfig) {
    super();
  }

  /** Set the ACP client + session to use for chat (instead of HTTP API). */
  setAcpSession(client: AcpClient, sessionId: string): void {
    this.acpClient = client;
    this.acpSessionId = sessionId;
    // Wire up agent message streaming
    client.on('update', (u: any) => {
      if (u.update?.sessionUpdate === 'agent_message_chunk' && u.update.content?.text) {
        // Stream chunks for real-time display
        this.emit('agent_chunk', u.update.content.text);
      }
    });
  }

  setContext(context: CodebaseContext): void {
    this.contextSummary = context.summary;
    this.filesBrief = context.files.slice(0, 30).map((f) => `- ${f.path} — ${f.role}`).join('\n');
    this.topicsBrief = context.topics
      .slice(0, 20)
      .map((t, i) => `${i + 1}. ${t.title} — ${t.filePath}:${t.lineStart}-${t.lineEnd}\n   why: ${t.rationale}`)
      .join('\n');
  }

  get transcript(): ChainedTurn[] {
    return [...this.conversation];
  }

  /** Seed the conversation history from a prior (resumed) interview session. */
  seedTranscript(turns: ChainedTurn[]): void {
    this.conversation.push(...turns);
  }

  get count(): number {
    return this.questionCount;
  }

  setMaxQuestions(n: number): void {
    this.maxQuestions = n;
  }

  /** Transcribe audio bytes via the STT endpoint. */
  async transcribe(audio: Buffer, format: 'wav' | 'mp3' | 'webm' = 'wav'): Promise<string> {
    const stt = this.cfg.stt;
    const url = joinUrl(stt.baseUrl, stt.path);
    const formData = buildMultipart(audio, format, stt.model, stt.language);
    const headers: Record<string, string> = { 'Content-Type': `multipart/form-data; boundary=${formData.boundary}` };
    if (stt.apiKey && stt.apiKey !== 'not-needed') headers['Authorization'] = `Bearer ${stt.apiKey}`;
    const res = await fetch(url, { method: 'POST', headers, body: formData.body });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`STT failed (${res.status}): ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as { text?: string };
    const text = json.text?.trim();
    if (!text) throw new Error('STT returned no text.');
    return text;
  }

  /** Synthesize text to audio bytes via the TTS endpoint (Kokoro). */
  async synthesize(text: string): Promise<Buffer> {
    const tts = this.cfg.tts;
    const url = joinUrl(tts.baseUrl, tts.path);
    const payload: Record<string, unknown> = {
      model: tts.model,
      input: text,
      voice: tts.voice,
      response_format: 'mp3',
    };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (tts.apiKey && tts.apiKey !== 'not-needed') headers['Authorization'] = `Bearer ${tts.apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      // Kokoro may not support `instructions`; retry without
      const errText = await res.text().catch(() => '');
      throw new Error(`TTS failed (${res.status}): ${errText.slice(0, 500)}`);
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  }

  /** Ask the chat model for the next interviewer turn. Returns the text + optional file open action. */
  async nextTurn(candidateText: string): Promise<{ text: string; openFile?: { filePath: string; lineStart: number; lineEnd: number }; endInterview?: boolean }> {
    this.conversation.push({ role: 'candidate', text: candidateText });
    return this.generateTurn(candidateText);
  }

  /** Internal: generate the interviewer response without pushing candidate text to history. */
  private async generateTurn(candidateText: string): Promise<{ text: string; openFile?: { filePath: string; lineStart: number; lineEnd: number }; endInterview?: boolean }> {
    const systemPrompt = `You are a friendly, rigorous codebase knowledge evaluator running a live, voice-based Ask Me Anything session about THIS codebase:

PROJECT SUMMARY:
${this.contextSummary}

KEY FILES:
${this.filesBrief}

SUGGESTED KNOWLEDGE-CHECK TOPICS:
${this.topicsBrief}

KNOWLEDGE EVALUATOR — behave like a curious, supportive technical peer:
- Speak naturally and concisely, as if on a phone/video call. No bullet points, no lectures, no markdown.
- Begin with a brief warm greeting, then dive in. One question at a time.
- Listen actively. React to the candidate's answer like a human: "Good point", "Hmm, not quite", "Interesting — can you elaborate?"
- Adapt your follow-up based on answer quality. If they nail it, move on. If they're stuck, give a small hint — do NOT explain the concept for them.
- NEVER teach or explain the correct answer. Your job is to assess, not tutor. If they get it wrong, note it and move to the next topic.
- Probe deeper when answers are vague: "Why did you choose that approach?", "What are the trade-offs?", "What would break at scale?"
- Use silence — after asking a question, stop and wait. Don't fill dead air.

SCORING — after every candidate answer, internally rate it:
- Strong: correct, clear, shows depth
- Adequate: mostly right, some gaps
- Weak: incorrect, vague, or "I don't know"
Keep a running mental tally. At the end, give a final summary with per-topic understanding scores (1-5), strengths, and areas to revisit.

RULES:
- Ask ONE question at a time. Wait for the answer. Do not stack questions.
- When you want to focus on specific code, include: <open_file>{"filePath":"...","lineStart":N,"lineEnd":N}</open_file>
- When you have covered enough ground (or candidate is clearly struggling), include <end_interview/> in your response.
- Keep spoken turns SHORT — 2-3 sentences max. This is a live voice conversation, not a textbook.
- Do NOT explain concepts. Do NOT give the answer. Do NOT tutor. Assess only.
- If the candidate says "I don't know" or gives a weak answer, acknowledge briefly ("No worries, let's try another area") and move on. Never explain what they missed.
- Difficulty: ${this.cfg.interview.difficulty}`;

    let content: string;

    if (this.acpClient && this.acpSessionId) {
      // Use ACP agent (Devin/Codex) — no external API cost
      content = await this.nextTurnViaAcp(candidateText, systemPrompt);
    } else {
      // Fallback: HTTP chat API (OpenRouter)
      content = await this.nextTurnViaHttp(systemPrompt);
    }

    // Parse out <open_file>...</open_file> and <end_interview/>
    let text = content;
    let openFile: { filePath: string; lineStart: number; lineEnd: number } | undefined;
    const fileMatch = text.match(/<open_file>([\s\S]*?)<\/open_file>/);
    if (fileMatch) {
      try {
        const parsed = JSON.parse(fileMatch[1].trim());
        openFile = {
          filePath: String(parsed.filePath ?? parsed.file ?? ''),
          lineStart: Number(parsed.lineStart ?? 1),
          lineEnd: Number(parsed.lineEnd ?? parsed.lineStart ?? 1),
        };
      } catch {
        // leave openFile undefined
      }
      // ALWAYS strip the tag from spoken text, even if JSON parsing failed
      text = text.replace(fileMatch[0], '').trim();
    }
    const endInterview = /<end_interview\s*\/?>/.test(text);
    if (endInterview) text = text.replace(/<end_interview\s*\/?>/g, '').trim();

    // Strip ALL remaining XML/HTML-like tags from spoken text so TTS never reads them aloud
    // (covers <ref_file>, <ref_snippet>, <open_file>, stray tags, etc.)
    text = text.replace(/<[^>]+>/g, '').trim();

    this.conversation.push({ role: 'interviewer', text });
    if (openFile) this.questionCount += 1;

    return { text, openFile, endInterview };
  }

  /** Use ACP agent for next turn — collects streamed agent message chunks. */
  private async nextTurnViaAcp(candidateText: string, systemPrompt: string): Promise<string> {
    if (!this.acpClient || !this.acpSessionId) throw new Error('ACP session not set');

    // Build the prompt with system instructions + candidate's answer
    const prompt = [
      { type: 'text', text: systemPrompt },
      { type: 'text', text: `The user just said: "${candidateText}"\n\nRespond as the knowledge evaluator. Remember: short, natural, one question at a time. Use <open_file>...</open_file> to focus on code, <end_interview/> to end.` },
    ];

    let collected = '';
    const chunkHandler = (u: any) => {
      if (u.update?.sessionUpdate === 'agent_message_chunk' && u.update.content?.text) {
        collected += u.update.content.text;
      }
    };
    this.acpClient.on('update', chunkHandler);

    try {
      await this.acpClient.prompt(this.acpSessionId, prompt);
    } finally {
      this.acpClient.removeListener('update', chunkHandler);
    }

    if (!collected.trim()) throw new Error('ACP agent returned no message');
    logger.log(`[acp-chat] Response: ${collected.slice(0, 200)}...`);
    return collected;
  }

  /** Fallback: HTTP chat API (OpenRouter). */
  private async nextTurnViaHttp(systemPrompt: string): Promise<string> {
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...this.conversation.map((t) => ({
        role: (t.role === 'interviewer' ? 'assistant' : 'user') as 'assistant' | 'user',
        content: t.text,
      })),
    ];

    const chat = this.cfg.chat;
    const url = joinUrl(chat.baseUrl, chat.path);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (chat.apiKey && chat.apiKey !== 'not-needed') headers['Authorization'] = `Bearer ${chat.apiKey}`;

    const body: Record<string, unknown> = {
      model: chat.model,
      messages,
      temperature: 0.7,
    };

    logger.log(`[chat] POST ${url} model=${chat.model} apiKey=${chat.apiKey ? 'yes' : 'NO'}`);
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Chat failed (${res.status}): ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string; refusal?: string } }>; error?: { message?: string; code?: string } };
    if (json.error) {
      throw new Error(`Chat API error: ${json.error.message ?? 'unknown'} (code: ${json.error.code ?? 'n/a'})`);
    }
    const choice = json.choices?.[0];
    const content = choice?.message?.content;
    if (!content) {
      const raw = JSON.stringify(json).slice(0, 500);
      logger.log(`[chat] Empty content. Full response: ${raw}`);
      throw new Error(`Chat returned no content. Response: ${raw}`);
    }
    return content;
  }

  /** Generate the opening greeting + first question. Does NOT push a fake candidate message to history. */
  async opening(): Promise<{ text: string; openFile?: { filePath: string; lineStart: number; lineEnd: number } }> {
    return this.generateTurn('Begin Ask Me Anything now. Greet the user briefly, then open the first file and ask your first knowledge-check question.');
  }

  /** Clean up ACP session if active. */
  async disposeAcp(): Promise<void> {
    if (this.acpClient && this.acpSessionId) {
      try { await this.acpClient.closeSession(this.acpSessionId); } catch { /* ignore */ }
      try { await this.acpClient.dispose(); } catch { /* ignore */ }
      this.acpClient = null;
      this.acpSessionId = null;
    }
  }
}

function joinUrl(base: string, route: string): string {
  return `${base.replace(/\/+$/, '')}/${route.replace(/^\/+/, '')}`;
}

function buildMultipart(audio: Buffer, format: string, model: string, language: string): { body: Buffer; boundary: string } {
  const boundary = `----FormBoundary${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];
  const mime = format === 'wav' ? 'audio/wav' : format === 'mp3' ? 'audio/mpeg' : 'audio/webm';
  // file part
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${format}"\r\nContent-Type: ${mime}\r\n\r\n`));
  parts.push(audio);
  parts.push(Buffer.from('\r\n'));
  // model part
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`));
  // response_format
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`));
  // language
  if (language) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}
