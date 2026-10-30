/** Saves text as a file through a Blob URL. No library. */
export function saveText(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type: type || 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
