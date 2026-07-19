"use client";

import { Collapsible, CollapsibleGroup } from "@astryxdesign/core/Collapsible";
import { setupSteps } from "../../content/setup";

export function SetupGuide() {
  return (
    <section className="setup section-shell" id="setup" aria-labelledby="setup-title">
      <header className="section-heading setup-heading">
        <p className="eyebrow">Setup notebook · draft 01</p>
        <h2 id="setup-title">Ready when your stack is.</h2>
        <p>
          The structure is in place. Verified basics are included now; the final installation and provider walkthrough can drop into one typed content file later.
        </p>
      </header>
      <article className="setup-panel">
        <header className="setup-panel-header">
          <span>codesensei/setup</span>
          <span>6 checkpoints</span>
        </header>
        <CollapsibleGroup type="single" defaultValue="prerequisites" hasDividers>
          {setupSteps.map((step) => (
            <Collapsible
              key={step.id}
              value={step.id}
              trigger={
                <span className="setup-trigger">
                  <span className="step-number">{step.number}</span>
                  <span className="setup-trigger-copy">
                    <strong>{step.title}</strong>
                    <small>{step.summary}</small>
                  </span>
                  <span className={`status-token status-${step.status}`}>
                    {step.status === "verified" ? "verified" : "to add"}
                  </span>
                </span>
              }
            >
              <p className="setup-detail">{step.detail}</p>
            </Collapsible>
          ))}
        </CollapsibleGroup>
      </article>
    </section>
  );
}
