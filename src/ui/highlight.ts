import * as vscode from 'vscode';

let highlightType: vscode.TextEditorDecorationType | null = null;

function getHighlightType(): vscode.TextEditorDecorationType {
  if (highlightType) return highlightType;
  highlightType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 213, 79, 0.35)',
    borderColor: 'rgba(255, 152, 0, 0.9)',
    borderWidth: '1px',
    borderStyle: 'solid',
    overviewRulerColor: 'rgba(255, 152, 0, 0.9)',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    isWholeLine: false,
  });
  return highlightType;
}

export interface HighlightTarget {
  filePath: string;
  lineStart: number; // 1-based inclusive
  lineEnd: number; // 1-based inclusive
}

/**
 * Opens a file in a visible editor, reveals the requested range, and applies
 * a persistent highlight decoration. Returns the editor for further control.
 */
export async function openAndHighlight(
  target: HighlightTarget,
  workspaceRoot: string
): Promise<vscode.TextEditor | null> {
  const uri = await resolveFileUri(target.filePath, workspaceRoot);
  if (!uri) return null;

  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.One,
    preserveFocus: false,
    preview: false,
  });

  const lineCount = doc.lineCount;
  const startLine = Math.max(0, Math.min(target.lineStart - 1, lineCount - 1));
  const endLine = Math.max(0, Math.min(target.lineEnd - 1, lineCount - 1));
  const startLineObj = doc.lineAt(startLine);
  const endLineObj = doc.lineAt(endLine);
  const range = new vscode.Range(
    startLineObj.range.start,
    endLineObj.range.end
  );

  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

  const dec = getHighlightType();
  editor.setDecorations(dec, [range]);
  return editor;
}

export function clearHighlights(): void {
  if (!highlightType) return;
  for (const ed of vscode.window.visibleTextEditors) {
    ed.setDecorations(highlightType, []);
  }
}

async function resolveFileUri(relPath: string, workspaceRoot: string): Promise<vscode.Uri | null> {
  if (!relPath) return null;
  // Absolute path
  if (relPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relPath)) {
    return vscode.Uri.file(relPath);
  }
  // Try relative to workspace root
  const root = workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  if (root) {
    const full = vscode.Uri.joinPath(vscode.Uri.file(root), relPath);
    try {
      await vscode.workspace.fs.stat(full);
      return full;
    } catch {
      /* fall through */
    }
  }
  // Try a workspace search by basename
  const basename = relPath.split(/[\\/]/).pop() ?? relPath;
  const matches = await vscode.workspace.findFiles(`**/${basename}`, null, 5);
  if (matches.length) {
    // Prefer the one whose path ends with the requested relPath
    const exact = matches.find((m) => m.fsPath.replace(/\\/g, '/').endsWith(relPath));
    return exact ?? matches[0];
  }
  return null;
}
