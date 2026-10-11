/** Hand the browser a text to save as a file. */
export function downloadText(name: string, type: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // After the click has been taken up: revoking at once loses the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
