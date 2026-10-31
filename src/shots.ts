const stack = document.getElementById('stack')!;

const report = () => requestAnimationFrame(() => pin.shotsHeight(stack.getBoundingClientRect().height + 8));

function card(file: string) {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `
    <img draggable="true" title="Drag into any app, or click to crop and draw">
    <span class="done">Copied</span>
    <button class="x" title="Dismiss">✕</button>
    <div class="actions">
      <button data-a="copy">Copy</button><button data-a="save">Save…</button><button data-a="edit">Edit</button>
    </div>`;
  const img = el.querySelector('img')!;
  img.src = `file://${file}?t=${Date.now()}`;
  img.onload = report;
  img.onclick = () => pin.shot('edit', file);
  img.ondragstart = e => { e.preventDefault(); pin.shot('drag', file); };
  el.querySelector('.x')!.addEventListener('click', () => pin.shot('dismiss', file));
  el.querySelector('.actions')!.addEventListener('click', e => {
    const a = (e.target as HTMLElement).dataset.a;
    if (!a) return;
    pin.shot(a as 'copy' | 'save' | 'edit', file);
    if (a === 'copy') {
      const d = el.querySelector('.done')!;
      d.classList.add('show');
      setTimeout(() => d.classList.remove('show'), 1200);
    }
  });
  return el;
}

pin.onShots(files => {
  stack.replaceChildren(...files.map(card));
  const folder = document.createElement('button');
  folder.className = 'folder';
  folder.textContent = 'Open folder';
  folder.onclick = () => pin.shot('folder');
  stack.append(folder);
  report();
});
