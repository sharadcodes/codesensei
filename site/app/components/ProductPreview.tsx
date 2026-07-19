const transcript = [
  { role: "CodeSensei", text: "Why does this provider switch to chained mode here?" },
  { role: "you", text: "Because auto mode falls back when a realtime key is missing." },
];

export function ProductPreview({ compact = false }: { compact?: boolean }) {
  return (
    <figure className={compact ? "product-preview preview-compact" : "product-preview"} aria-label="CodeSensei opening a source file while testing the user's knowledge">
      <aside className="vscode-rail" aria-hidden="true">
        <span className="rail-mark">IL</span>
        <span>⌕</span>
        <span>⑂</span>
        <span>◉</span>
      </aside>
      <section className="extension-panel">
        <header className="mock-bar">
          <span>CodeSensei</span>
          <span>•••</span>
        </header>
        <p className="mock-label">SESSION</p>
        <p className="session-state"><i /> Listening <span>02:18</span></p>
        <dl className="session-meta">
          <dt>Agent</dt><dd>Codex ACP</dd>
          <dt>Difficulty</dt><dd>Adaptive</dd>
          <dt>Questions</dt><dd>03 / ∞</dd>
        </dl>
        <button className="mock-stop" type="button" aria-label="Stop Knowledge Check preview">Stop session</button>
        <p className="mock-label">TRANSCRIPT</p>
        <ol className="transcript">
          {transcript.map((message) => (
            <li key={message.role}>
              <span>{message.role}</span>
              {message.text}
            </li>
          ))}
        </ol>
      </section>
      <section className="editor-panel">
        <header className="editor-tabs"><span>orchestrator.ts</span><span>×</span></header>
        <pre aria-label="TypeScript source excerpt"><code>
          <span className="line"><b>101</b><em className="syn-pink">private</em> resolveMode(config: <em className="syn-violet">FullConfig</em>) {'{'}</span>
          <span className="line active"><b>102</b><em className="syn-pink">if</em> (config.voiceMode === <em className="syn-yellow">&apos;chained&apos;</em>)</span>
          <span className="line active"><b>103</b>  <em className="syn-pink">return</em> <em className="syn-yellow">&apos;chained&apos;</em>;</span>
          <span className="line"><b>104</b><em className="syn-pink">if</em> (config.voiceMode === <em className="syn-yellow">&apos;realtime&apos;</em>)</span>
          <span className="line"><b>105</b>  <em className="syn-pink">return</em> <em className="syn-yellow">&apos;realtime&apos;</em>;</span>
          <span className="line"><b>106</b><em className="syn-pink">if</em> (!config.realtime.apiKey)</span>
          <span className="line"><b>107</b>  <em className="syn-pink">return</em> <em className="syn-yellow">&apos;chained&apos;</em>;</span>
          <span className="line"><b>108</b><em className="syn-pink">return</em> <em className="syn-yellow">&apos;realtime&apos;</em>;</span>
          <span className="line"><b>109</b>{'}'}</span>
        </code></pre>
        <footer className="editor-status"><span>Ln 102, Col 5</span><span>TypeScript · UTF-8</span></footer>
      </section>
      <figcaption>Live context · <code>src/interview/orchestrator.ts:102–103</code></figcaption>
    </figure>
  );
}
