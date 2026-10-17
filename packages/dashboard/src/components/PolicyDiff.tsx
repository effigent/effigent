'use client';

import { useEffect, useRef } from 'react';
import { MergeView } from '@codemirror/merge';
import { Annotation, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { yaml } from '@codemirror/lang-yaml';

/** Marks the text we set from outside (publish, revert, Ask AI): not an edit to report back. */
const external = Annotation.define<boolean>();

const theme = EditorView.theme({
  '&': { fontSize: '12.5px', backgroundColor: 'var(--panel, #fff)', color: 'var(--txt, #111827)' },
  '.cm-content': { fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)', padding: '8px 0' },
  '.cm-gutters': { backgroundColor: 'var(--bg-2, #f6f7fb)', color: 'var(--txt-3, #9ca3af)', border: 'none', borderRight: '1px solid var(--border, #e5e7ef)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-changedLine': { backgroundColor: 'rgba(34, 197, 94, 0.13)' },
  '.cm-deletedChunk': { backgroundColor: 'rgba(239, 68, 68, 0.12)' },
  '.cm-changedText': { background: 'rgba(34, 197, 94, 0.32)' },
  '.cm-deletedText, .cm-deletedChunk .cm-changedText': { background: 'rgba(239, 68, 68, 0.3)' },
});

/** Count of lines added and removed between two texts (LCS over lines). */
export function lineStats(a: string, b: string): { added: number; removed: number } {
  const x = a.split('\n'), y = b.split('\n');
  if (x.length * y.length > 4_000_000) return { added: Math.max(0, y.length - x.length), removed: Math.max(0, x.length - y.length) };
  const dp = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const same = dp[0][0];
  return { added: y.length - same, removed: x.length - same };
}

/**
 * Side by side like a git diff: `left` (what is live, or an older version)
 * read-only, `right` (the proposal) editable unless `readOnlyRight`. Removed
 * lines are red on the left, added lines green on the right, aligned. Arrows
 * in the middle copy a chunk from the left back into the right.
 */
export function PolicyDiff({ left, right, onChange, readOnlyRight = false, onlyChanges = false, split = true, height = 560 }: {
  left: string; right: string; onChange?: (v: string) => void; readOnlyRight?: boolean; onlyChanges?: boolean;
  /** false: only the right (editable) side, as a plain editor — the same editor, so typing keeps focus when it splits */
  split?: boolean; height?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<MergeView | null>(null);
  const change = useRef(onChange);
  change.current = onChange;

  // (re)build when what is compared changes; typing only updates the right side
  useEffect(() => {
    if (!host.current) return;
    const base: Extension[] = [lineNumbers(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), yaml(), theme, EditorView.lineWrapping];
    const ro: Extension[] = [EditorState.readOnly.of(true), EditorView.editable.of(false)];
    const mv = new MergeView({
      a: { doc: left, extensions: [...base, ...ro] },
      b: {
        doc: right,
        extensions: [...base, ...(readOnlyRight ? ro : [history(), keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab])]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((tr) => tr.annotation(external))) change.current?.(u.state.doc.toString());
          })],
      },
      parent: host.current,
      gutter: true,
      highlightChanges: true,
      revertControls: readOnlyRight ? undefined : 'a-to-b',
      collapseUnchanged: onlyChanges ? { margin: 3, minSize: 6 } : undefined,
    });
    view.current = mv;
    return () => { mv.destroy(); view.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, readOnlyRight, onlyChanges]);

  // the right side changed from outside (Ask AI, Revert, a newer version): replace it
  useEffect(() => {
    const b = view.current?.b;
    if (b && b.state.doc.toString() !== right) b.dispatch({ changes: { from: 0, to: b.state.doc.length, insert: right }, annotations: external.of(true) });
  }, [right]);

  return (
    <div className={`policy-diff ${split ? '' : 'single'}`} style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'auto', maxHeight: height }}>
      <div ref={host} style={{ minWidth: split ? 760 : undefined }} />
    </div>
  );
}
