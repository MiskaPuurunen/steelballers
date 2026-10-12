/* VibeBreak disk shop. Plain JS, no build step. Data lives in catalog.json and games/*.lua. */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);

const state = { catalog: null, sources: new Map() };

/* ---------------------------------------------------------------- helpers */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const isFree = (price) => /^free$/i.test(price);

let toastTimer = 0;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Older browsers, or a page not served over https.
    const ta = el('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`Copied ${what}`);
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/x-lua' }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Downloaded ${filename}`);
}

/* ---------------------------------------------------------- lua highlight */

const LUA_KEYWORDS = new Set('and break do else elseif end false for function goto if in local nil not or repeat return then true until while'.split(' '));
const TOKEN = /(--[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|([\s\S])/g;

function highlightLine(line) {
  let out = '';
  for (const m of line.matchAll(TOKEN)) {
    const [text, com, str, num, word] = m;
    const safe = escapeHtml(text);
    if (com) out += `<span class="tok-com">${safe}</span>`;
    else if (str) out += `<span class="tok-str">${safe}</span>`;
    else if (num) out += `<span class="tok-num">${safe}</span>`;
    else if (word && LUA_KEYWORDS.has(word)) out += `<span class="tok-key">${safe}</span>`;
    else if (word === 'vb' || word === 'game') out += `<span class="tok-vb">${safe}</span>`;
    else out += safe;
  }
  return out;
}

function codeBlock(source) {
  const pre = el('pre', { class: 'code', tabindex: '0', 'aria-label': 'Game source code' });
  pre.innerHTML = source
    .replace(/\n$/, '')
    .split('\n')
    .map((l) => `<span class="ln">${highlightLine(l) || ' '}</span>`)
    .join('');
  return pre;
}

/* -------------------------------------------------------------- game disk */

function disk(game, { big = false } = {}) {
  const free = isFree(game.price);
  return el('div', { class: 'disk', 'data-color': game.disk || 'blue', 'aria-hidden': 'true', style: big ? 'width:100%' : null },
    el('div', { class: 'shutter' }),
    el('span', { class: free ? 'sticker free' : 'sticker', text: game.price }),
    el('div', { class: 'label' },
      el('pre', { class: 'cover', text: game.cover.join('\n') }),
      el('p', { class: 'label-title', text: game.title }),
      el('p', { class: 'label-meta', text: `${game.genre}, ${game.duration}s` }),
    ),
  );
}

function gameCard(game) {
  return el('button', {
    class: 'disk-button',
    type: 'button',
    'aria-label': `${game.title}, ${game.genre}, ${game.price}. Open details`,
    onclick: () => { location.hash = `#/games/${game.id}`; },
  }, disk(game));
}

async function loadSource(game) {
  if (!state.sources.has(game.id)) {
    const res = await fetch(game.file);
    if (!res.ok) throw new Error(`Could not load ${game.file} (HTTP ${res.status})`);
    state.sources.set(game.id, await res.text());
  }
  return state.sources.get(game.id);
}

async function openGame(game) {
  const body = $('#detail-body');
  const filename = `${game.id}.lua`;
  const free = isFree(game.price);

  const codeSlot = el('div', { class: 'code-wrap' }, el('p', { class: 'install', text: 'Loading the code…' }));
  body.replaceChildren(
    closeButton(),
    el('div', { class: 'detail-head' },
      disk(game, { big: true }),
      el('div', {},
        el('h2', { id: 'detail-title', text: game.title }),
        el('p', { class: 'byline', text: `${game.genre} game by ${game.author}, ${game.duration} second rounds` }),
        el('p', { class: 'desc', text: game.description }),
        controlsTable(game.controls),
        el('div', { class: 'buy-row' },
          el('span', { class: free ? 'big-price free' : 'big-price', text: game.price }),
          el('button', { class: 'btn primary', type: 'button', id: 'dl-btn', disabled: true, text: `Download ${filename}` }),
          el('button', { class: 'btn', type: 'button', id: 'copy-btn', disabled: true, text: 'Copy code' }),
        ),
      ),
    ),
    codeSlot,
  );
  showDialog();

  try {
    const source = await loadSource(game);
    const dl = $('#dl-btn');
    const cp = $('#copy-btn');
    dl.disabled = false;
    cp.disabled = false;
    dl.onclick = () => download(filename, source);
    cp.onclick = () => copyText(source, 'the code');
    codeSlot.replaceChildren(
      el('div', { class: 'code-bar' },
        el('span', { text: `${filename}, ${source.split('\n').length} lines` }),
        el('button', { class: 'btn', type: 'button', text: 'Copy', onclick: () => copyText(source, 'the code') }),
      ),
      codeBlock(source),
      installHelp(filename),
    );
  } catch (err) {
    codeSlot.replaceChildren(el('p', { class: 'load-error', text: err.message }));
  }
}

function controlsTable(controls = []) {
  if (!controls.length) return null;
  return el('table', { class: 'controls' },
    el('tbody', {}, controls.map(([keys, action]) => el('tr', {}, el('th', { scope: 'row', text: keys }), el('td', { text: action })))),
  );
}

function installHelp(filename) {
  const p = el('p', { class: 'install' });
  p.innerHTML =
    `To play it, open <strong>Custom games</strong> in the VibeBreak menu. Press <code>P</code>, paste the code and press <code>Ctrl+S</code>. ` +
    `Or save <code>${escapeHtml(filename)}</code> to your games folder (<code>~/.config/vibebreak/games</code> on Linux, ` +
    `<code>%APPDATA%\\vibebreak\\games</code> on Windows) and press <code>R</code> to reload.`;
  return p;
}

/* ------------------------------------------------------------ theme screen */

// The VibeBreak logo, same letters as src/ui/layout.ts.
const LETTERS = {
  V: ['██╗   ██╗', '██║   ██║', '██║   ██║', '╚██╗ ██╔╝', ' ╚████╔╝ ', '  ╚═══╝  '],
  I: ['██╗', '██║', '██║', '██║', '██║', '╚═╝'],
  B: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██████╔╝', '╚═════╝ '],
  E: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗', '╚══════╝'],
  R: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██║  ██║', '╚═╝  ╚═╝'],
  A: [' █████╗ ', '██╔══██╗', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
  K: ['██╗  ██╗', '██║ ██╔╝', '█████╔╝ ', '██╔═██╗ ', '██║  ██╗', '╚═╝  ╚═╝'],
};

function logoFor(theme, fontSize) {
  const pre = el('pre', { class: 'mini-logo', style: `font-size:${fontSize}px`, 'aria-hidden': 'true' });
  for (let r = 0; r < 6; r++) {
    const vibe = ['V', 'I', 'B', 'E'].map((l) => LETTERS[l][r]).join('');
    const brk = ['B', 'R', 'E', 'A', 'K'].map((l) => LETTERS[l][r]).join('');
    pre.append(
      el('span', { style: `color:${theme.vibe[r % theme.vibe.length]}`, text: vibe }),
      el('span', { style: `color:${theme.brk[r % theme.brk.length]}`, text: brk }),
      '\n',
    );
  }
  return pre;
}

function ruleFor(theme, width) {
  const pre = el('pre', { class: 'rule', 'aria-hidden': 'true' });
  const cells = theme.rule.length;
  for (let i = 0; i < width; i++) {
    const ch = theme.rule[i % cells];
    pre.append(el('span', { style: `color:${theme.ruleColors[Math.floor(i / cells) % theme.ruleColors.length]}`, text: ch }));
  }
  return pre;
}

function particlesFor(theme) {
  const pre = el('pre', { class: 'particles', 'aria-hidden': 'true' });
  if (!theme.particles) return pre;
  const chars = theme.particles.split(' ');
  // Fixed positions so every visit looks the same.
  let seed = [...theme.id].reduce((a, c) => a + c.charCodeAt(0), 0);
  const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  let line = '';
  for (let i = 0; i < 40; i++) line += rand() < 0.28 ? chars[Math.floor(rand() * chars.length)] : ' ';
  const colors = theme.particleColors || [theme.muted];
  [...line].forEach((ch, i) => pre.append(ch === ' ' ? ' ' : el('span', { style: `color:${colors[i % colors.length]}`, text: ch })));
  return pre;
}

function screen(theme) {
  return el('div', { class: 'screen', 'aria-hidden': 'true' },
    particlesFor(theme),
    logoFor(theme, 4.4),
    el('p', { class: 'tagline', style: `color:${theme.muted}`, text: theme.tagline }),
    ruleFor(theme, 40),
  );
}

function themeCard(theme) {
  const free = isFree(theme.price);
  return el('button', {
    class: 'screen-button',
    type: 'button',
    'aria-label': `${theme.name} theme, ${theme.price}. Open details`,
    onclick: () => { location.hash = `#/themes/${theme.id}`; },
  },
    screen(theme),
    el('div', { class: 'screen-caption' },
      el('h3', { text: theme.name }),
      el('span', { class: free ? 'price free' : 'price', text: theme.price }),
    ),
  );
}

function openTheme(theme) {
  const free = isFree(theme.price);
  const command = `vibebreak theme ${theme.id}`;
  $('#detail-body').replaceChildren(
    closeButton(),
    el('div', { class: 'detail-head' },
      screen(theme),
      el('div', {},
        el('h2', { id: 'detail-title', text: theme.name }),
        el('p', { class: 'byline', text: 'Theme for the whole arcade' }),
        el('p', { class: 'desc', text: theme.description }),
        el('div', { class: 'cmd' },
          el('code', { text: command }),
          el('button', { class: 'btn', type: 'button', text: 'Copy', onclick: () => copyText(command, 'the command') }),
        ),
        el('div', { class: 'buy-row' },
          el('span', { class: free ? 'big-price free' : 'big-price', text: theme.price }),
        ),
        el('p', { class: 'install', text: 'Run the command once and VibeBreak remembers it. You can also pick it from Themes in the menu, or use --theme for a single run.' }),
      ),
    ),
  );
  showDialog();
}

/* ---------------------------------------------------------------- dialog */

function closeButton() {
  return el('button', { class: 'close', type: 'button', 'aria-label': 'Close', text: '×', onclick: () => closeDialog() });
}

function showDialog() {
  const d = $('#detail');
  if (!d.open) d.showModal();
  d.scrollTop = 0;
}

function closeDialog() {
  const tab = location.hash.startsWith('#/themes') ? 'themes' : 'games';
  history.replaceState(null, '', `#/${tab}`);
  route();
}

/* ---------------------------------------------------------------- routing */

function route() {
  const [, tab = 'games', id] = location.hash.split('/');
  const current = tab === 'themes' ? 'themes' : 'games';
  for (const name of ['games', 'themes']) {
    $(`#${name}`).hidden = name !== current;
    const link = $(`.tabs a[data-tab="${name}"]`);
    if (name === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = current === 'themes' ? 'Themes, VibeBreak disk shop' : 'Games, VibeBreak disk shop';

  const dialog = $('#detail');
  const list = state.catalog?.[current] ?? [];
  const item = id && list.find((x) => x.id === decodeURIComponent(id));
  if (item) {
    if (current === 'games') openGame(item);
    else openTheme(item);
  } else if (dialog.open) {
    dialog.close();
  }
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  const dialog = $('#detail');
  // Esc and clicks on the backdrop both close the dialog and fix the URL.
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); closeDialog(); });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeDialog(); });
  window.addEventListener('hashchange', route);

  try {
    const res = await fetch('catalog.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.catalog = await res.json();
  } catch {
    const box = $('#load-error');
    box.hidden = false;
    box.innerHTML =
      'The catalog could not be loaded. If you opened this file straight from disk, serve the folder instead: ' +
      '<code>python3 -m http.server -d site</code>, then open <code>http://localhost:8000</code>.';
    route();
    return;
  }

  $('#game-grid').replaceChildren(...state.catalog.games.map(gameCard));
  $('#theme-grid').replaceChildren(...state.catalog.themes.map(themeCard));
  if (!location.hash) history.replaceState(null, '', '#/games');
  route();
}

boot();
