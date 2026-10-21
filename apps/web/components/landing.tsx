"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowRight, Check, ChevronRight, Code2, GitBranch, Minus, Plus, Terminal } from "lucide-react";

const story = [
  { name: "Build", title: "Start with something worth making.", copy: "Bring your repository and the coding agent you already use. Give it a real task. Keep the conversation, tools and changes in one place.", prompt: "Make the session refresh before it expires.", reply: "I’ll add a refresh check and cover the expiry boundary.", activity: "$ npm test -- session", file: "src/session.ts", code: ["export function shouldRefresh(session) {", "  const remaining = session.expiresAt - Date.now();", "  return remaining <= REFRESH_WINDOW;", "}"], note: "Agent working · tools and output appear as they arrive" },
  { name: "Understand", title: "A change is more than a green diff.", copy: "Prentice separates what Git and recorded tools confirm from what the agent says. You can trace an explanation back to the work.", prompt: "Make the session refresh before it expires.", reply: "The refresh check is in place. Here is what the record confirms.", activity: "Git · src/session.ts modified", file: "src/session.ts", code: ["  const remaining = session.expiresAt - Date.now();", "- return remaining < 0;", "+ return remaining <= REFRESH_WINDOW;"], note: "Observed · a file change is confirmed by Git" },
  { name: "Explain-back", title: "Put the idea into your own words.", copy: "A short question follows the change. Explain the reasoning, ask for a hint, or keep exploring. Learning belongs inside the work.", prompt: "Why refresh before the expiry time?", reply: "So a request doesn’t begin with a session that expires while it is in flight.", activity: "Prentice · explain-back", file: "The idea behind the change", code: ["expiry time", "    − refresh window", "    = the point to renew", "", "Leave time for the next request."], note: "Your explanation · connected to this recorded change" },
  { name: "Debug", title: "When it breaks, keep the evidence.", copy: "A real failed command becomes a Debug record. Bounded output gives you something concrete to investigate. A login problem is never presented as a code defect.", prompt: "Check the boundary condition.", reply: "The test failed at the exact boundary. Let’s inspect the recorded output.", activity: "$ npm test -- session · exit 1", file: "Recorded command output", code: ["FAIL session.test.ts", "Expected: true", "Received: false", "", "at refresh boundary (session.test.ts:18)"], note: "Debug · the failure is recorded; a fix is not assumed" },
  { name: "Continue", title: "Keep the speed. Keep the understanding.", copy: "Return to the conversation, review what you learned, and decide what comes next. Your projects become a record you can find your way back into.", prompt: "Handle the boundary, then rerun the test.", reply: "I’ll check the comparison against the failing case.", activity: "Continue in the same conversation", file: "Your engineering journal", code: ["Session refresh", "  → file change observed", "  → expiry window explained", "  → boundary failure recorded", "  → next step: verify the fix"], note: "Build → Understand → Explain-back → Continue" },
];
const faq = [
  ["Does Prentice replace my coding agent?", "No. Codex, Claude Code and Cursor do the coding through their official local tools. Prentice brings the workspace, conversation, evidence and learning around that work."],
  ["Do I need to paste an agent API key?", "No. Install and sign in to your own coding agent. Claude Code sign-in happens outside Prentice, in your own installation. Prentice uses the supported local provider path."],
  ["Where does my code live?", "Your repository stays on your computer. The connector accesses it locally, and the authenticated relay carries the workspace data you request to your browser. Your coding agent follows its own vendor’s data policies."],
  ["What does Learning AI receive?", "A bounded, credential-scrubbed learning request: selected evidence, recorded facts and relevant learner answers. It does not get unrestricted repository access or your full coding prompt. The browser can still display files and diffs you explicitly open."],
  ["What happens when an agent fails or I stop it?", "Real recorded command failures appear in Debug. Setup and authentication failures stay setup errors. An interrupted task remains marked Interrupted, with only confirmed partial evidence. Sending it again starts a new run after you review the prompt."],
  ["How does learning happen?", "Understand explains the recorded change. Explain-back invites you to describe it, with hints and follow-up teaching when available. Home connects those moments to the project and conversation where they happened."],
];

export function Landing({ onStart }: { onStart: () => void }) {
  const [step, setStep] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sections = root.current?.querySelectorAll<HTMLElement>("[data-chapter]") ?? [];
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) setStep(Number((entry.target as HTMLElement).dataset.chapter));
    }, { rootMargin: "-20% 0px -45% 0px", threshold: 0 });
    sections.forEach(section => observer.observe(section));
    const reveal = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add("is-visible"); reveal.unobserve(entry.target); }
    }, { threshold: .08 });
    root.current?.querySelectorAll("[data-reveal]").forEach(section => reveal.observe(section));
    return () => { observer.disconnect(); reveal.disconnect(); };
  }, []);
  const current = story[step];
  return <div ref={root} className="landing">
    <nav className="landing-nav" aria-label="Main navigation">
      <a href="#top" className="wordmark" aria-label="Prentice home">Prentice<span aria-hidden="true">/</span></a>
      <div className="landing-nav-links"><a href="#workflow">The workflow</a><a href="#local">Your code, your computer</a><a href="#questions">Questions</a></div>
      <button className="text-action" onClick={onStart}>Open Prentice <ArrowRight size={16} aria-hidden="true" /></button>
    </nav>
    <main id="prentice-main">
      <section id="top" className="landing-hero">
        <div className="hero-copy"><p className="eyebrow"><span className="clay-line" /> A little more understanding. A lot more possibility.</p>
          <h1>Build with AI.<br />Understand<br /><em>what you built.</em></h1>
          <div className="hero-bottom"><p>Your agents move fast.<br />Stay close to the work.</p><button className="primary-action" onClick={onStart}>Find your next starting point <ArrowRight size={19} aria-hidden="true" /></button></div>
          <p className="hero-footnote">For developers building with Codex, Claude Code & Cursor.</p>
        </div>
        <div className="hero-art" aria-label="Illustrative change connected to its explanation">
          <div className="orbit-label"><GitBranch size={14} aria-hidden="true" /> A change worth understanding</div>
          <div className="hero-code"><div className="demo-toolbar"><span>session.ts</span><span>Git diff</span></div><pre><span className="code-dim">{"// give the next request room to finish"}</span>{"\n"}<span className="code-minus">− return remaining &lt; 0;</span>{"\n"}<span className="code-plus">+ return remaining &lt;= REFRESH_WINDOW;</span></pre><div className="hero-code-foot"><span className="code-plus">+1</span> <span className="code-minus">−1</span><span>One line. A different outcome.</span></div></div>
          <div className="connection-stroke" aria-hidden="true" />
          <div className="hero-note"><span className="eyebrow">Prentice / Explain-back</span><p>Why refresh <em>before</em><br />the session expires?</p><div className="note-rule" /><span>Understand the reason.<br />Not just the result.</span></div>
          <span className="art-caption">An illustrative moment from the loop ↓</span>
        </div>
        <a className="scroll-invitation" href="#the-gap"><ArrowDown size={15} aria-hidden="true" /> Stay with the story</a>
      </section>
      <section id="the-gap" className="landing-gap" data-reveal>
        <p className="eyebrow">The gap is getting wider</p><div className="gap-statements"><p>“The agent wrote it.”</p><span aria-hidden="true">↘</span><p>“I can explain it.”</p></div>
        <div className="gap-footer"><span className="eyebrow">That’s where Prentice lives.</span><p>A passing run is a result. Understanding why it works is something you take into the next project. You shouldn’t have to choose between the two.</p></div>
      </section>
      <section id="workflow" className="workflow-section">
        <header className="section-intro" data-reveal><p className="eyebrow">01 / One project. A better loop.</p><h2>The work moves forward.<br /><em>So do you.</em></h2><p>A small session-refresh change, from first prompt to the next step. This is an illustrative walkthrough, not a live agent run.</p></header>
        <div className="workflow-layout"><div className="workflow-chapters">{story.map((chapter, index) => <article key={chapter.name} data-chapter={index} id={`chapter-${index}`} className="workflow-chapter"><p className="eyebrow">0{index + 1} / {chapter.name}</p><h3>{chapter.title}</h3><p>{chapter.copy}</p><a href={index < story.length - 1 ? `#chapter-${index + 1}` : "#top"} className="chapter-next">{index < story.length - 1 ? `Next: ${story[index + 1].name}` : "Back to building"} <ArrowDown size={14} aria-hidden="true" /></a></article>)}</div>
          <div className="workflow-preview"><div className="story-tabs" aria-label="Workflow stages">{story.map((chapter, index) => <a key={chapter.name} href={`#chapter-${index}`} aria-current={index === step ? "step" : undefined}>{chapter.name}</a>)}</div>
            <div className="product-demo"><div className="demo-top"><span className="font-serif text-xl">Prentice</span><span>session-refresh <ChevronRight size={12} aria-hidden="true" /> A safer session</span></div><div className="demo-body"><aside><p>PROJECT</p><span><Code2 size={13} aria-hidden="true" /> src</span><strong>session.ts</strong><span>session.test.ts</span><p>CONVERSATION</p><span>A safer session</span></aside><div className="demo-thread" key={step}><p className="demo-prompt">{current.prompt}</p><span className="eyebrow">{step === 2 ? "Your explanation" : "The conversation"}</span><p>{current.reply}</p><div className={`demo-activity ${step === 3 ? "is-failure" : ""}`}><Terminal size={14} aria-hidden="true" />{current.activity}</div><div className="demo-evidence"><span className="eyebrow">{step === 3 ? "Debug / recorded failure" : "Prentice"}</span><p>{current.note}</p></div><div className="demo-input">{step === 2 ? "Explain it in your own words…" : "What comes next?"}<ArrowRight size={16} aria-hidden="true" /></div></div></div><div className="demo-code"><div className="demo-toolbar"><span>{current.file}</span><span>Read only</span></div><pre>{current.code.map((line, i) => <span key={i} className={line.startsWith("+") ? "code-plus" : line.startsWith("-") || line.startsWith("FAIL") ? "code-minus" : ""}>{line}{"\n"}</span>)}</pre></div></div><p className="demo-caption">Illustrative product walkthrough · scroll to move through the story</p>
          </div></div>
      </section>
      <section className="evidence-section" data-reveal><div><p className="eyebrow">02 / Show your working</p><h2>Not every sentence<br />is <em>evidence.</em></h2><p>Prentice keeps the source visible. An agent’s confidence never turns its claim into an observed fact.</p></div><div className="evidence-ledger">{[
        ["01", "Observed", "Git confirms a change to session.ts.", "Canonical, typed evidence", "observed"],
        ["02", "Agent stated", "“This should prevent expired requests.”", "A claim from the coding agent", "stated"],
        ["03", "Prentice inference", "The refresh window may reduce expiry races.", "An interpretation, clearly labelled", "inference"],
      ].map(([n, title, copy, caption, tone]) => <div key={title} className={`ledger-row ${tone}`}><span>{n}</span><div><h3>{title}</h3><p>{copy}</p><small>{caption}</small></div></div>)}</div></section>
      <section className="agents-section" data-reveal><p className="eyebrow">03 / Bring your agent</p><h2>The tools you love.<br /><em>A closer relationship with the work.</em></h2><div className="agent-names"><span>Codex</span><span>Claude Code</span><span>Cursor</span></div><p>Your installations. Your accounts. Their official local tools.<br />Prentice is the layer around them.</p></section>
      <section id="local" className="local-section" data-reveal><div><p className="eyebrow">04 / Local first, clearly explained</p><h2>Your project has a home.<br /><em>Your computer.</em></h2><p>The local connector and your coding agents work with the repository on your computer. Open Prentice in your browser to follow the work.</p><p>The authenticated relay connects the two. Learning AI receives selected, bounded evidence—not unrestricted access to your repository.</p><a className="text-action" href="#questions">Read the privacy details <ArrowDown size={15} aria-hidden="true" /></a></div><div className="local-map"><div className="local-computer"><span className="eyebrow">Your computer</span><div><Code2 aria-hidden="true" /><strong>Repository</strong></div><div><GitBranch aria-hidden="true" /><span>Prentice connector</span></div><div><Terminal aria-hidden="true" /><span>Your coding agent</span></div></div><div className="local-link"><span>Authenticated relay</span><span aria-hidden="true">↕</span></div><div className="local-browser"><span className="wordmark">Prentice</span><span>Your browser workspace</span></div><p>Agent vendors have their own data policies.<br />Local first does not mean every request stays offline.</p></div></section>
      <section id="questions" className="faq-section" data-reveal><div><p className="eyebrow">A few good questions</p><h2>Before you<br /><em>begin.</em></h2></div><div>{faq.map(([question, answer]) => <details key={question}><summary>{question}<Plus size={18} className="faq-plus" aria-hidden="true" /><Minus size={18} className="faq-minus" aria-hidden="true" /></summary><p>{answer}</p></details>)}</div></section>
      <section className="closing-section" data-reveal><p className="eyebrow">For the part of you that still wants to know why.</p><h2>Make something.<br /><em>Make sense of it.</em></h2><button className="primary-action" onClick={onStart}>Open Prentice <ArrowRight size={19} aria-hidden="true" /></button><p><Check size={14} aria-hidden="true" /> Your repository. Your agent. Your understanding.</p></section>
    </main><footer className="landing-footer"><a className="wordmark" href="#top">Prentice<span aria-hidden="true">/</span></a><span>Built around the work.</span><a href="#questions">Privacy & questions <ArrowRight size={14} aria-hidden="true" /></a></footer>
  </div>;
}
