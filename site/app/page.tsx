import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import Image from "next/image";
import { ProductPreview } from "./components/ProductPreview";
import { SetupGuide } from "./components/SetupGuide";

const workflow = [
  ["01", "Open a repository", "Give the extension a workspace to investigate."],
  ["02", "Pick an ACP agent", "Refresh discovery, inspect availability, and choose the agent."],
  ["03", "Generate your guide", "Choose Quick, Guided, or Deep and create CODESENSEI.md."],
  ["04", "Test your knowledge", "CodeSensei opens relevant source and asks focused voice questions."],
];

const features = [
  ["Three guide depths", "Choose a Quick Overview, Guided Walkthrough, or selective Deep Dive depending on how far you want to go."],
  ["A practical contribution map", "Guided and Deep guides identify safe first changes so understanding can turn into a useful contribution."],
  ["Code in the conversation", "Knowledge Check opens the file and highlights the exact range before asking you a code-specific question."],
  ["Two voice paths", "Use one realtime WebSocket, or a chained STT → chat → TTS workflow with OpenAI-compatible endpoints."],
  ["Curated source access", "Guide generation uses a temporary read-only analysis view, excludes secrets and generated output, and makes build/config access opt-in."],
  ["You stay in control", "Stop guide generation or Knowledge Check, set a question limit, and inspect diagnostics in the output panel."],
];

export default function Home() {
  return (
    <Theme theme={neutralTheme} mode="light">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="site-header">
        <nav className="nav-shell" aria-label="Primary navigation">
          <a className="brand" href="#top" aria-label="CodeSensei home">
            <Image src="/product-icon.svg" alt="" width={30} height={30} priority />
            <span>CodeSensei</span>
          </a>
          <ul className="nav-links">
            <li><a href="#modes">Product</a></li>
            <li><a href="#workflow">How it works</a></li>
            <li><a href="#contribute">Contribute</a></li>
            <li><a href="#setup">Setup</a></li>
          </ul>
          <a className="nav-cta" href="#setup">Set up the extension <span aria-hidden="true">↗</span></a>
        </nav>
      </header>

      <main id="main">
        <section className="hero section-shell" id="top">
          <article className="hero-copy">
            <p className="eyebrow"><span className="live-dot" /> Guided codebase learning for VS Code</p>
            <h1>Understand it. Then test what you know.</h1>
            <p className="hero-lede">
              CodeSensei turns an unfamiliar repository into a grounded learning guide, surfaces safe places to contribute, then tests your mental model by asking focused questions about the code.
            </p>
            <p className="hero-note">Read the code that matters. Build a mental model. Put it to work.</p>
            <nav className="hero-actions" aria-label="Hero actions">
              <a className="button button-dark" href="#workflow">See how it works <span aria-hidden="true">↓</span></a>
              <a className="button button-ghost" href="#setup">Read setup notes</a>
            </nav>
            <dl className="hero-facts">
              <div><dt>Guide</dt><dd>CODESENSEI.md</dd></div>
              <div><dt>Interface</dt><dd>Inside VS Code</dd></div>
              <div><dt>License</dt><dd>MIT</dd></div>
            </dl>
          </article>
          <ProductPreview />
        </section>

        <section className="modes section-shell" id="modes" aria-labelledby="modes-title">
          <header className="section-heading split-heading">
            <p className="eyebrow">One loop · two kinds of attention</p>
            <h2 id="modes-title">Build the map. Then defend it.</h2>
            <p>Start with a written map, then move into a live code-aware conversation. Both paths stay connected to the repository you opened.</p>
          </header>
          <section className="mode-grid">
            <article className="mode-card mode-analysis">
              <header><span>01 / LEARN</span><span>CODE TUTOR</span></header>
              <h3>Generate a codebase guide</h3>
              <p>A selected ACP agent creates CODESENSEI.md with entry points, architecture, control flow, setup, key files, unknowns, and practical first contributions.</p>
              <ol className="analysis-log" aria-label="Repository analysis progress">
                <li><span>✓</span> Starting ACP agent</li>
                <li><span>✓</span> Reading workspace structure</li>
                <li><span>✓</span> Tracing core control flow</li>
                <li className="log-active"><span>→</span> Writing safe first changes</li>
              </ol>
            </article>
            <article className="mode-card mode-voice">
              <header><span>02 / TEST</span><span>KNOWLEDGE CHECK</span></header>
              <h3>Knowledge Check</h3>
              <p>CodeSensei asks the questions. Answer naturally while it opens relevant files, highlights the code, and probes how well you understand it.</p>
              <blockquote>
                <span>CodeSensei · now</span>
                “What trade-off is this fallback making, and when would you choose realtime instead?”
              </blockquote>
              <p className="voice-status"><i /><span>Listening</span><b>00:08</b><em>||||||||</em></p>
            </article>
          </section>
        </section>

        <section className="workflow section-shell" id="workflow" aria-labelledby="workflow-title">
          <header className="section-heading compact-heading">
            <p className="eyebrow">A small, repeatable loop</p>
            <h2 id="workflow-title">From folder tree to follow-up question.</h2>
          </header>
          <ol className="workflow-list">
            {workflow.map(([number, title, body]) => (
              <li key={number}>
                <span>{number}</span>
                <h3>{title}</h3>
                <p>{body}</p>
                <code>{number === "01" ? "workspace/" : number === "02" ? "agent.json" : number === "03" ? "context.json" : "open_file()"}</code>
              </li>
            ))}
          </ol>
        </section>

        <section className="demo-band" aria-labelledby="demo-title">
          <article className="section-shell demo-shell">
            <header className="demo-copy">
              <p className="eyebrow">Product view · question 03</p>
              <h2 id="demo-title">The question stays attached to the source.</h2>
              <p>No tab hunting mid-answer. Knowledge Check opens the requested file and highlights the exact range before asking the next question.</p>
              <a className="button button-blue" href="#setup">Review setup <span aria-hidden="true">↘</span></a>
            </header>
            <ProductPreview compact />
          </article>
        </section>

        <section className="features section-shell" id="features" aria-labelledby="features-title">
          <header className="section-heading compact-heading">
            <p className="eyebrow">What is in the build today</p>
            <h2 id="features-title">Useful controls. No invented magic.</h2>
          </header>
          <ul className="feature-grid">
            {features.map(([title, body], index) => (
              <li key={title}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="contribution section-shell" id="contribute" aria-labelledby="contribution-title">
          <header className="contribution-copy section-heading">
            <p className="eyebrow">New in the generated guide</p>
            <h2 id="contribution-title">Find a safe first contribution—not just another file.</h2>
            <p>Guided Walkthrough and Deep Dive modes ask the agent to identify approachable changes grounded in the code it inspected. The result lives beside architecture, setup, conventions, and known limitations in CODESENSEI.md.</p>
            <ul>
              <li><span>01</span><strong>Start with context</strong><small>See the module’s role and the flow around it.</small></li>
              <li><span>02</span><strong>Choose a bounded change</strong><small>Focus on a safe, representative place to begin.</small></li>
              <li><span>03</span><strong>Keep unknowns visible</strong><small>The guide calls out what could not be verified.</small></li>
            </ul>
          </header>
          <article className="guide-page" aria-label="Generated CodeSensei contribution guide preview">
            <header><span>CODESENSEI.md</span><span>Guided Walkthrough</span></header>
            <p className="guide-kicker">CodeSensei GUIDE</p>
            <h3>Where to contribute first</h3>
            <p>Begin with a change that teaches one complete path through the system without crossing provider boundaries.</p>
            <section>
              <span>SAFE FIRST CHANGE</span>
              <h4>Improve the source-policy diagnostics</h4>
              <p>Small surface area · visible behavior · existing policy boundary</p>
              <code>src/tutor/sourcePolicy.ts</code>
            </section>
            <h4>Before you edit</h4>
            <ol><li>Trace the caller.</li><li>Read the exclusions.</li><li>Run the focused policy tests.</li></ol>
            <footer><span>Grounded in inspected files</span><span>Unknowns included</span></footer>
          </article>
        </section>

        <section className="source-first section-shell" aria-labelledby="source-title">
          <article className="file-tree" aria-label="Repository context file list">
            <header><span>EXPLORER</span><span>8 files selected</span></header>
            <ul>
              <li className="folder">⌄ src</li>
              <li className="folder nested">⌄ interview</li>
              <li className="file selected"><span>TS</span> orchestrator.ts <em>102–108</em></li>
              <li className="file"><span>TS</span> extension.ts <em>51–138</em></li>
              <li className="folder nested">⌄ acp</li>
              <li className="file"><span>TS</span> context.ts <em>18–63</em></li>
              <li className="file"><span>TS</span> registry.ts <em>188–246</em></li>
              <li className="folder dim">› node_modules <em>not selected</em></li>
              <li className="folder dim">› dist <em>not selected</em></li>
            </ul>
            <footer><span>structured context</span><span>repo-relative paths</span></footer>
          </article>
          <header className="source-copy section-heading">
            <p className="eyebrow">Repository-grounded, not repository-omniscient</p>
            <h2 id="source-title">A focused brief before the mic turns on.</h2>
            <p>Code Tutor creates a curated, read-only analysis view with eligible source files. Knowledge Check uses structured key files and source ranges to ground its questions and editor navigation.</p>
            <ul>
              <li><span>01</span> Workspace-relative paths</li>
              <li><span>02</span> Secrets, dependencies, and generated output excluded</li>
              <li><span>03</span> Build and infrastructure files require opt-in</li>
            </ul>
            <p className="honesty-note">The curated view limits guide-generation inputs. Provider processing still follows the selected agent and endpoint; this is not a blanket privacy claim.</p>
          </header>
        </section>

        <SetupGuide />

        <section className="final-cta section-shell" aria-labelledby="cta-title">
          <p className="eyebrow">Your next unfamiliar repository</p>
          <h2 id="cta-title">Don’t just read it. Explain it.</h2>
          <p>Build a mental model, keep the code in view, and find the gaps while you can still ask better questions.</p>
          <a className="button button-dark" href="#setup">Prepare your first session <span aria-hidden="true">↗</span></a>
        </section>
      </main>

      <footer className="site-footer">
        <section className="section-shell footer-shell">
          <a className="brand footer-brand" href="#top"><Image src="/product-icon.svg" alt="" width={30} height={30} /><span>CodeSensei</span></a>
          <p>A grounded repository guide and voice-based knowledge test inside VS Code.</p>
          <nav aria-label="Footer navigation"><a href="#modes">Product</a><a href="#workflow">How it works</a><a href="#contribute">Contribute</a><a href="#setup">Setup</a></nav>
          <small>MIT licensed · Public repository and installation URLs are not yet verified.</small>
          <p className="footer-authors">
            <span>Built with ❤️ by</span>{' '}
            <span><a href="https://github.com/sharadcodes/" target="_blank" rel="noreferrer">@sharadcodes</a>,</span>{' '}
            <span><a href="https://github.com/g-savitha/" target="_blank" rel="noreferrer">@g-savitha</a>, and</span>{' '}
            <span><a href="https://github.com/iamnabina" target="_blank" rel="noreferrer">@iamnabina</a></span>
          </p>
        </section>
      </footer>
    </Theme>
  );
}
