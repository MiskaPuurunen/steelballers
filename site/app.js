// Loads catalog.json and shows games or themes as cards.
// Clicking a card opens a dialog with the code (games) or the command (themes).

let catalog;
let current; // { name, text } for the copy and download buttons

const $ = (id) => document.getElementById(id);

function show(tab) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('list').innerHTML = '';
  for (const item of catalog[tab]) {
    const card = document.createElement('button');
    card.className = 'card';
    card.innerHTML = `<pre></pre><h3></h3><p></p>`;
    card.querySelector('pre').textContent = (item.cover || []).join('\n');
    card.querySelector('h3').textContent = item.title || item.name;
    card.querySelector('p').textContent = item.price;
    card.onclick = () => (tab === 'games' ? openGame(item) : openTheme(item));
    $('list').append(card);
  }
}

async function openGame(game) {
  const code = await (await fetch(game.file)).text();
  current = { name: game.id + '.lua', text: code };
  const how = 'To play it: in C-Cade open Custom games, press P, paste the code and press Ctrl+S.';
  fill(game.title, `${game.description} By ${game.author}. ${how}`, game.price, code, true);
}

function openTheme(theme) {
  const command = `c-cade theme ${theme.id}`;
  current = { name: '', text: command };
  fill(theme.name, theme.description, theme.price, command, false);
}

function fill(title, text, price, code, canDownload) {
  $('d-title').textContent = title;
  $('d-text').textContent = text;
  $('d-price').textContent = price;
  $('d-code').textContent = code;
  $('download').hidden = !canDownload;
  $('detail').showModal();
}

$('copy').onclick = () => navigator.clipboard.writeText(current.text);

$('download').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([current.text]));
  a.download = current.name;
  a.click();
};

$('close').onclick = () => $('detail').close();

document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => show(b.dataset.tab)));

fetch('catalog.json')
  .then((r) => r.json())
  .then((data) => {
    catalog = data;
    show('games');
  });
