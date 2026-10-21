"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Search } from "lucide-react";

export interface PaletteCommand { id: string; title: string; detail?: string; group: string; run: () => void }
export function CommandPalette({ open, onClose, commands, onSearch }: { open: boolean; onClose: () => void; commands: PaletteCommand[]; onSearch: (query: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const visible = commands.filter(command => `${command.title} ${command.detail ?? ""} ${command.group}`.toLowerCase().includes(query.toLowerCase())).slice(0, 40);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open) { node.showModal(); input.current?.focus(); }
    else if (node.open) node.close();
  }, [open]);
  useEffect(() => { if (open) dialog.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active, open]);
  const execute = (command: PaletteCommand) => { onClose(); command.run(); };
  return <dialog ref={dialog} className="command-palette" aria-label="Command palette" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="palette-surface"><div className="palette-input"><Search size={20} aria-hidden="true" /><label className="sr-only" htmlFor="command-search">Find a command, project, conversation or file</label><input ref={input} id="command-search" value={query} autoComplete="off" placeholder="Where do you want to go?" role="combobox" aria-expanded="true" aria-controls="command-results" aria-autocomplete="list" aria-activedescendant={visible[active] ? `command-${active}` : undefined} onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActive(current => Math.max(0, Math.min(visible.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)))); }
      if (event.key === "Enter" && visible[active]) { event.preventDefault(); execute(visible[active]); }
    }} /><button className="palette-escape" onClick={onClose}>Esc</button></div><ul id="command-results" role="listbox" aria-label="Commands">{visible.map((command, index) => <li role="option" aria-selected={index === active} id={`command-${index}`} data-index={index} key={command.id}><button tabIndex={-1} onClick={() => execute(command)} onPointerMove={() => setActive(index)}><span><small>{command.group}</small><strong>{command.title}</strong>{command.detail ? <span>{command.detail}</span> : null}</span><ArrowUpRight size={16} aria-hidden="true" /></button></li>)}{!visible.length ? <li className="palette-empty" role="presentation">No matching commands. Search the journal for recorded learning and Debug.</li> : null}</ul><button className="palette-journal" onClick={() => { onClose(); onSearch(query); }}>Search all recorded work{query ? ` for “${query}”` : ""} <ArrowUpRight size={15} aria-hidden="true" /></button><footer><span>↑ ↓ navigate</span><span>↵ open</span><span>Esc close</span></footer></div>
  </dialog>;
}
